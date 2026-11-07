import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AlignmentFields,
  AlignmentReviewResponse,
  BlindReviewResponse,
} from "../../src/ai/schemas.js";
import {
  createBudgetAccount,
  getBudgetSummary,
} from "../../src/ai/budget.js";
import { createOpenRouterTransport } from "../../src/ai/openrouter.js";
import {
  buildCalibrationPack,
  type BuiltCalibrationPack,
} from "../../src/calibration/fixtures.js";
import {
  parseCalibrationLabelsCsv,
  type CalibrationLabels,
} from "../../src/calibration/labels.js";
import {
  runCalibrationLive,
  type CalibrationLiveRouteSet,
  type CalibrationLiveRunResult,
} from "../../src/calibration/live.js";
import {
  labelReviewMethod,
  writeCalibrationLiveArtifacts,
} from "../../src/calibration/live-artifacts.js";
import { scoreCalibration } from "../../src/calibration/score.js";
import { main } from "../../src/cli/calibration.js";
import { reportMain } from "../../src/cli/report.js";
import { mockRoute } from "../../src/runner/run.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { hashCanonicalJson } from "../../src/util/hash.js";

const FIXED_NOW = new Date("2026-11-06T12:00:00.000Z");
const CLOCK = { now: () => FIXED_NOW, sleep: async () => {} };

let built: BuiltCalibrationPack;
let labels: CalibrationLabels;
let humanLabels: CalibrationLabels;

function liveRoutes(overrides: Partial<CalibrationLiveRouteSet> = {}): CalibrationLiveRouteSet {
  const route = (role: "blind_text" | "blind_vision" | "alignment_text" | "alignment_vision") => ({
    ...mockRoute(role),
    model: `fake/${role}`,
    pricing: { prompt: "0.000002", completion: "0.000006" },
  });
  return {
    blindText: route("blind_text"),
    blindVision: route("blind_vision"),
    alignmentText: route("alignment_text"),
    alignmentVision: route("alignment_vision"),
    ...overrides,
  };
}

function blindContent(): BlindReviewResponse {
  return {
    answerStatus: "selected",
    chosenOption: "A",
    reasoning: "Fake reviewer selects the first option.",
    clarity: "clear",
    ambiguity: "none",
    confidence: 1,
    visualLegibility: "not_applicable",
    issues: [],
  };
}

function alignmentContent(svg: boolean): AlignmentReviewResponse {
  const pass = { status: "pass" as const, factIds: [], reason: "Fake pass." };
  const fields: AlignmentFields = {
    question: pass,
    rulesAndClues: pass,
    options: pass,
    hint: pass,
    explanation: pass,
    image: svg
      ? { status: "pass", factIds: [], reason: "Fake image pass." }
      : { status: "not_applicable", factIds: [], reason: "Text presentation." },
  };
  return { fields };
}

function responseBody(
  model: string,
  content: unknown,
  sequence: number,
): Record<string, unknown> {
  return {
    id: `gen-fake-${sequence}`,
    model,
    provider: "FakeProvider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost: "0.0001",
    },
  };
}

function fakeFetch(options: {
  readonly calls: { count: number };
  readonly invalidFirstBlind?: boolean;
  readonly svgBlindLegibility?: boolean;
}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/chat/completions")) {
      throw new Error(`unexpected fake URL ${url}`);
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const responseFormat = body.response_format as {
      json_schema: { name: string };
    };
    const schemaName = responseFormat.json_schema.name;
    const model = String(body.model);
    const sequence = options.calls.count;
    options.calls.count += 1;
    const messages = body.messages as Array<{
      content: string | Array<{ type: string; text?: string }>;
    }>;
    const text = JSON.stringify(messages);
    const isSvg = text.includes('"image_url"');
    if (schemaName === "puzzle_blind_review") {
      if (options.invalidFirstBlind === true && sequence === 0) {
        return new Response(
          JSON.stringify(
            responseBody(model, { answerStatus: "bogus" }, sequence),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const content = blindContent();
      if (isSvg) {
        content.visualLegibility =
          options.svgBlindLegibility === false ? "not_applicable" : "legible";
      }
      return new Response(JSON.stringify(responseBody(model, content, sequence)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (schemaName === "puzzle_alignment_review") {
      return new Response(
        JSON.stringify(responseBody(model, alignmentContent(isSvg), sequence)),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected schema ${schemaName}`);
  };
}

function transportWith(fetchImpl: typeof fetch) {
  return createOpenRouterTransport({
    baseUrl: "http://127.0.0.1:1/api/v1",
    fetchImpl,
    random: () => 0,
    deadlineMs: 1000,
    clock: CLOCK,
  });
}

async function runLive(options: {
  readonly routes?: CalibrationLiveRouteSet;
  readonly fetchImpl: typeof fetch;
  readonly maxCostUsd?: string;
}): Promise<{
  readonly result: CalibrationLiveRunResult;
  readonly accountId: string;
  readonly databasePath: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "calibration-live-test-"));
  const databasePath = join(directory, "calibration.sqlite");
  const db = openDatabase(databasePath);
  migrate(db);
  const accountId = "calibration-test";
  createBudgetAccount(db, {
    accountId,
    runKind: "calibration",
    maxCostUsd: options.maxCostUsd ?? "10",
    createdAt: FIXED_NOW.toISOString(),
  });
  try {
    const result = await runCalibrationLive({
      built,
      labels,
      routes: options.routes ?? liveRoutes(),
      db,
      accountId,
      apiKey: "fake-key",
      transport: transportWith(options.fetchImpl),
      clock: CLOCK,
    });
    return { result, accountId, databasePath };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

beforeAll(() => {
  built = buildCalibrationPack();
  labels = parseCalibrationLabelsCsv(
    readFileSync(
      join(process.cwd(), "tests", "fixtures", "calibration", "mock-labels.csv"),
      "utf8",
    ),
  );
  humanLabels = {
    packHash: labels.packHash,
    rows: labels.rows.map((row) => ({
      ...row,
      provenance: "human" as const,
      auditor: "test-auditor",
      auditorTime: "2026-11-06T10:00:00.000Z",
    })),
  };
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("live calibration runner", { timeout: 180_000 }, () => {
  it("executes exactly 80 review calls with 40 observations and a provider mix", async () => {
    const calls = { count: 0 };
    const { result } = await runLive({
      fetchImpl: fakeFetch({ calls }),
    });
    expect(result.status).toBe("completed");
    expect(result.reviewCalls).toBe(80);
    expect(result.generationCalls).toBe(0);
    expect(result.transportAttempts).toBe(80);
    expect(result.observations).toHaveLength(40);
    expect(result.budgetPaused).toBe(false);
    expect(result.budgetBreached).toBe(false);
    expect(result.fatalError).toBeNull();
    expect(calls.count).toBe(80);
    expect(result.calls.every((call) => call.attempts.length === 1)).toBe(true);
    expect(
      result.calls.filter((call) => call.role === "blind_text"),
    ).toHaveLength(20);
    expect(
      result.calls.filter((call) => call.role === "blind_vision"),
    ).toHaveLength(20);
    expect(
      result.calls.filter((call) => call.role === "alignment_text"),
    ).toHaveLength(20);
    expect(
      result.calls.filter((call) => call.role === "alignment_vision"),
    ).toHaveLength(20);
    expect(result.providerMix.length).toBe(4);
    for (const entry of result.providerMix) {
      expect(entry.observedProvider).toBe("FakeProvider");
      expect(entry.calls).toBe(20);
      expect(entry.attempts).toBe(20);
    }
    expect(result.knownCostUsd).toBe("0.008");
    expect(result.unknownCalls).toBe(0);
    expect(result.unknownAttempts).toBe(0);
    expect(result.firstFailure).toBeNull();
  });

  it("pauses before dispatch when the first reservation exceeds the cap", async () => {
    const calls = { count: 0 };
    const { result } = await runLive({
      fetchImpl: fakeFetch({ calls }),
      maxCostUsd: "0.000001",
    });
    expect(result.status).toBe("paused_budget");
    expect(result.budgetPaused).toBe(true);
    expect(result.budgetBreached).toBe(false);
    expect(result.reviewCalls).toBe(1);
    expect(calls.count).toBe(0);
    expect(result.unknownAttempts).toBe(0);
    expect(result.firstFailure?.message).toContain("BUDGET_NOT_ADMITTED");
    expect(result.observations[0]?.blind.response).toBeNull();
    expect(result.observations[0]?.blind.error).toContain("BUDGET_NOT_ADMITTED");
    const score = scoreCalibration({
      labels,
      observations: result.observations,
      reviewCalls: result.reviewCalls,
      generationCalls: 0,
      evidenceKind: "live",
      liveEligible: false,
    });
    expect(score.coverage).toMatchObject({
      reviewed: 1,
      expected: 40,
      blindReviewed: 1,
      alignmentReviewed: 0,
    });
    expect(score.liveEligible).toBe(false);
  });

  it("marks an actual-cost overshoot as paused and budget-breached", async () => {
    const calls = { count: 0 };
    const routes = liveRoutes();
    const { result } = await runLive({
      routes: {
        ...routes,
        blindText: {
          ...routes.blindText,
          pricing: { prompt: "0.0000000001", completion: "0.0000000001" },
        },
      },
      fetchImpl: fakeFetch({ calls }),
    });
    expect(result.budgetBreached).toBe(true);
    expect(result.status).toBe("paused_budget");
    expect(result.budgetPaused).toBe(true);
    expect(result.reviewCalls).toBe(2);
    expect(result.calls[0]?.attempts[0]?.state).not.toBe("prepared");
    expect(calls.count).toBe(1);
  });

  it("records missing provider identity instead of dropping it", async () => {
    let sequence = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = String(body.model);
      const schemaName = (
        body.response_format as { json_schema: { name: string } }
      ).json_schema.name;
      const messages = JSON.stringify(body.messages);
      const isSvg = messages.includes('"image_url"');
      sequence += 1;
      const response = responseBody(
        model,
        schemaName === "puzzle_blind_review"
          ? isSvg
            ? { ...blindContent(), visualLegibility: "legible" }
            : blindContent()
          : alignmentContent(isSvg),
        sequence,
      );
      if (sequence === 1) {
        delete response.model;
        delete response.provider;
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { result } = await runLive({ fetchImpl });
    expect(result.status).toBe("completed");
    expect(result.providerMix).toContainEqual({
      role: "blind_text",
      observedModel: null,
      observedProvider: null,
      calls: 1,
      attempts: 1,
    });
    expect(
      result.providerMix.reduce((total, entry) => total + entry.calls, 0),
    ).toBe(80);
  });

  it("records invalid content as an error without a content retry", async () => {
    const calls = { count: 0 };
    const { result } = await runLive({
      fetchImpl: fakeFetch({ calls, invalidFirstBlind: true }),
    });
    expect(result.status).toBe("completed");
    expect(result.reviewCalls).toBe(80);
    expect(calls.count).toBe(80);
    expect(result.firstFailure).toMatchObject({
      fixtureId: "cal-ranking-01",
      role: "blind_text",
    });
    expect(result.firstFailure?.message).toContain(
      "blind response does not satisfy the strict schema",
    );
    expect(result.firstFailure?.message).toContain("answerStatus");
    expect(result.observations[0]?.blind.response).toBeNull();
    expect(result.observations[0]?.blind.error).toContain("strict schema");
    expect(result.observations[0]?.alignment.response).not.toBeNull();
    expect(result.calls[0]?.attempts).toHaveLength(1);
  });

  it("rejects a text blind response that claims image legibility", async () => {
    const calls = { count: 0 };
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = String(body.model);
      const schemaName = (
        body.response_format as { json_schema: { name: string } }
      ).json_schema.name;
      const content =
        schemaName === "puzzle_blind_review"
          ? { ...blindContent(), visualLegibility: "legible" }
          : alignmentContent(false);
      calls.count += 1;
      return new Response(JSON.stringify(responseBody(model, content, calls.count)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { result } = await runLive({ fetchImpl });
    expect(result.firstFailure?.message).toBe(
      "text blind response has an image legibility status",
    );
    expect(result.observations[0]?.blind.error).toBe(
      "text blind response has an image legibility status",
    );
  });

  it("rejects an SVG blind response without image legibility", async () => {
    const calls = { count: 0 };
    const { result } = await runLive({
      fetchImpl: fakeFetch({ calls, svgBlindLegibility: false }),
    });
    expect(result.firstFailure?.message).toBe(
      "SVG blind response has no image legibility status",
    );
    expect(result.status).toBe("completed");
    expect(result.reviewCalls).toBe(80);
  });

  it("writes a self-contained live artifact with a verified manifest", async () => {
    const calls = { count: 0 };
    const directory = mkdtempSync(join(tmpdir(), "calibration-live-artifact-"));
    const databasePath = join(directory, "calibration.sqlite");
    const db = openDatabase(databasePath);
    migrate(db);
    const accountId = "calibration-test";
    createBudgetAccount(db, {
      accountId,
      runKind: "calibration",
      maxCostUsd: "10",
      createdAt: FIXED_NOW.toISOString(),
    });
    const result = await runCalibrationLive({
      built,
      labels: humanLabels,
      routes: liveRoutes(),
      db,
      accountId,
      apiKey: "fake-key",
      transport: transportWith(fakeFetch({ calls })),
      clock: CLOCK,
    });
    const budgetSummary = getBudgetSummary(db);
    db.close();
    const score = scoreCalibration({
      labels: humanLabels,
      observations: result.observations,
      reviewCalls: result.reviewCalls,
      generationCalls: 0,
      evidenceKind: "live",
      liveEligible: true,
    });
    const labelsPath = join(directory, "source-labels.csv");
    writeFileSync(
      labelsPath,
      readFileSync(
        join(process.cwd(), "tests", "fixtures", "calibration", "mock-labels.csv"),
        "utf8",
      ),
    );
    const written = writeCalibrationLiveArtifacts({
      directory,
      calibrationId: "calibration-test-id",
      built,
      labels: humanLabels,
      labelsPath,
      routes: liveRoutes(),
      models: {
        generator: "fake/generator",
        reviewer: "fake/reviewer",
        alignmentText: "fake/alignment-text",
        visionReviewer: "fake/vision",
      },
      catalog: {
        source: "fake",
        recordedAt: FIXED_NOW.toISOString(),
        modelCount: 3,
        catalogHash: "a".repeat(64),
      },
      configuration: {
        sourceHash: "b".repeat(64),
        promptHashes: { "blind_text": "c".repeat(64) },
        schemaHashes: { "blind_text:puzzle_blind_review": "d".repeat(64) },
        configHash: "e".repeat(64),
      },
      provenanceSummary: {
        archiveHash: "f".repeat(64),
        sourceHash: "b".repeat(64),
        configHash: "e".repeat(64),
        promptBundleHash: "1".repeat(64),
        schemaBundleHash: "2".repeat(64),
        fontHash: "3".repeat(64),
        licenseHash: "4".repeat(64),
        lockfileHash: "5".repeat(64),
        createdAt: FIXED_NOW.toISOString(),
        fileCount: 10,
        filesByCategory: {
          source: 5,
          prompt: 1,
          config: 2,
          font: 1,
          license: 1,
        },
        promptFileCount: 1,
        promptHashCount: 1,
        schemaCount: 1,
        schemaHashCount: 1,
        runtime: {
          node: "v24.22.2",
          platform: "linux",
          arch: "x64",
          npm: "11.0.0",
          lockfileVersion: 3,
        },
        git: null,
      },
      authorizedCapUsd: "2",
      accountId,
      budgetSummary,
      result,
      score,
      databasePath,
    });
    const calibration = JSON.parse(
      readFileSync(written.calibrationPath, "utf8"),
    ) as Record<string, unknown>;
    expect(calibration).toMatchObject({
      evidenceKind: "live",
      status: "completed",
      packHash: humanLabels.packHash,
      calls: { review: 80, generation: 0, transportAttempts: 80 },
      gates: { allPass: false },
      budgetBreached: false,
    });
    expect(calibration.cost).toMatchObject({ knownUsd: "0.008" });
    expect(calibration.models).toMatchObject({
      generator: "fake/generator",
      reviewer: "fake/reviewer",
      alignmentText: "fake/alignment-text",
      visionReviewer: "fake/vision",
    });
    expect(calibration.labels).toMatchObject({
      reviewMethod: "independent_human",
      humanVerified: true,
    });
    expect(calibration.providerMix).toHaveLength(4);
    expect(calibration.limitations).toHaveLength(5);
    expect(calibration.observations).toHaveLength(40);
    expect(calibration.score).toMatchObject({
      evidenceKind: "live",
      liveEligible: true,
    });
    expect(readdirSync(join(directory, "images")).filter((name) => name.endsWith(".png"))).toHaveLength(20);
    expect(readdirSync(join(directory, "images")).filter((name) => name.endsWith(".svg"))).toHaveLength(20);
    expect(readFileSync(written.requestsPath, "utf8").trim().split("\n")).toHaveLength(80);
    expect(readFileSync(written.responsesPath, "utf8").trim().split("\n")).toHaveLength(80);
    expect(readFileSync(written.labelsPath, "utf8")).toContain("cal-ranking-01");
    const manifest = JSON.parse(readFileSync(written.manifestPath, "utf8")) as {
      files: Array<{ path: string; sha256: string; bytes: number }>;
      manifestHash: string;
    };
    expect(hashCanonicalJson(manifest.files)).toBe(manifest.manifestHash);
    expect(manifest.files.map((file) => file.path)).toContain("calibration.json");
    expect(manifest.files.map((file) => file.path)).toContain("score.json");
    expect(manifest.files.map((file) => file.path)).toContain("calibration.sqlite");
    expect(manifest.files.map((file) => file.path)).toContain("requests.jsonl");
    expect(manifest.files.map((file) => file.path)).toContain("responses.jsonl");
    rmSync(directory, { recursive: true, force: true });
  });

  it("classifies independent, delegated, and code-derived label review methods", () => {
    expect(labelReviewMethod(humanLabels)).toBe("independent_human");
    const delegated = {
      ...humanLabels,
      rows: humanLabels.rows.map((row) => ({
        ...row,
        auditor: "Lexa (delegated to Kilo)",
        notes: "Operator-delegated review by Kilo.",
      })),
    };
    expect(labelReviewMethod(delegated)).toBe("operator_delegated_ai");
    const codeDerived = {
      ...humanLabels,
      rows: humanLabels.rows.map((row) => ({
        ...row,
        provenance: "mock_test_only" as const,
        humanVerified: false,
        auditor: "pilot-code",
        notes: "Code-derived pilot truth.",
      })),
    };
    expect(labelReviewMethod(codeDerived)).toBe("code_derived");
  });

  it("marks live scoring eligible only for a complete human-labeled run", () => {
    const observations = built.fixtures.map((entry) => ({
      fixtureId: entry.fixture.fixtureId,
      blind: { response: null, error: "mock timeout" },
      alignment: { response: null, error: "mock timeout" },
    }));
    const liveScore = scoreCalibration({
      labels: humanLabels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
      evidenceKind: "live",
      liveEligible: true,
    });
    expect(liveScore.evidenceKind).toBe("live");
    expect(liveScore.liveEligible).toBe(true);
    expect(liveScore.provenance).toBe("human");
    expect(liveScore.coverage.reviewed).toBe(40);
    expect(liveScore.coverage.blindReviewed).toBe(40);
    expect(liveScore.coverage.alignmentReviewed).toBe(40);
    expect(liveScore.gates.allPass).toBe(false);

    const incomplete = scoreCalibration({
      labels: humanLabels,
      observations: built.fixtures.map((entry) => ({
        fixtureId: entry.fixture.fixtureId,
        blind: { response: null, error: "not executed" },
        alignment: { response: null, error: "not executed" },
      })),
      reviewCalls: 80,
      generationCalls: 0,
      evidenceKind: "live",
      liveEligible: true,
    });
    expect(incomplete.liveEligible).toBe(false);
    expect(incomplete.coverage.reviewed).toBe(0);

    const mockScore = scoreCalibration({
      labels: humanLabels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(mockScore.evidenceKind).toBe("mock");
    expect(mockScore.liveEligible).toBe(false);
  });
});

describe("live calibration CLI guards", { timeout: 60_000 }, () => {
  it("rejects live without paid authorization, budget, or labels", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    expect(await main(["node", "calibration", "--live"])).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("--allow-paid");
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--live",
        "--allow-paid",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("--max-cost");
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--live",
        "--allow-paid",
        "--max-cost",
        "2",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("--labels");
  });

  it("resolves a live calibration artifact through --calibration-root", async () => {
    const root = mkdtempSync(join(tmpdir(), "calibration-report-"));
    const directory = join(root, "pack", "live", "calibration-report-id");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "calibration.json"),
      JSON.stringify({
        version: 1,
        calibrationId: "calibration-report-id",
        status: "completed",
      }),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await reportMain([
        "node",
        "report",
        "--run",
        "calibration-report-id",
        "--calibration-root",
        root,
      ]),
    ).toBe(0);
    const output = stdout.mock.calls.flat().join("");
    expect(output).toContain('"mode": "calibration_live"');
    expect(output).toContain('"calibrationId": "calibration-report-id"');
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects pilot without paid authorization, budget, labels, or within the approved cap", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    expect(await main(["node", "calibration", "--pilot"])).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("--allow-paid");
    process.exitCode = undefined;
    expect(
      await main(["node", "calibration", "--pilot", "--allow-paid"]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("--max-cost");
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--pilot",
        "--allow-paid",
        "--max-cost",
        "0.26",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("approved USD 0.25");
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--pilot",
        "--allow-paid",
        "--max-cost",
        "0.10",
        "--labels",
        "tests/fixtures/calibration/mock-labels.csv",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "does not accept --labels",
    );
  });

  it("rejects an invalid vision reasoning effort before paid setup", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--pilot",
        "--allow-paid",
        "--max-cost",
        "0.10",
        "--vision-reasoning-effort",
        "bogus",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "low, medium, or high",
    );
  });

  it("rejects an unknown calibration pack version", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--mock",
        "--labels",
        "tests/fixtures/calibration/mock-labels.csv",
        "--pack-version",
        "3",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "--pack-version must be 1 or 2",
    );
  });

  it("rejects paid options outside live and conflicting modes", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--mock",
        "--allow-paid",
        "--labels",
        "tests/fixtures/calibration/mock-labels.csv",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("require --live");
    process.exitCode = undefined;
    expect(
      await main([
        "node",
        "calibration",
        "--live",
        "--mock",
        "--allow-paid",
        "--max-cost",
        "2",
        "--labels",
        "tests/fixtures/calibration/mock-labels.csv",
      ]),
    ).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain(
      "choose exactly one",
    );
  });
});
