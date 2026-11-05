import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import {
  getLogicalCall,
  listAttempts,
  listRequestEvents,
} from "../../src/ai/ledger.js";
import { createOpenRouterTransport } from "../../src/ai/openrouter.js";
import type { ResolvedRoute } from "../../src/ai/preflight.js";
import {
  WORDING_JSON_SCHEMA,
  strictSchemaHash,
} from "../../src/ai/schemas.js";
import {
  WordingError,
  buildWordingMessages,
  wordingPromptMetadata,
  writeWording,
} from "../../src/ai/write-wording.js";
import type { WordingResponse } from "../../src/domain/presentation.js";
import { AssembledPresentationSchema } from "../../src/domain/presentation.js";
import type { Family } from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getSlot,
  getStageResult,
  insertStageResult,
} from "../../src/storage/repository.js";
import {
  createFakeOpenRouter,
  type FakeOpenRouter,
} from "../helpers/fake-openrouter.js";
import { allowLocalFake } from "../setup.js";
import { sha256Hex } from "../../src/util/hash.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174001";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p27-test-secret-do-not-persist";

let tempDirectory: string;
let db: Database.Database;
let fake: FakeOpenRouter;
let transport: ReturnType<typeof createOpenRouterTransport>;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function testSeed(label: string): string {
  return sha256Hex(`p27-test:${label}`);
}

function wordingRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    role: "wording",
    model: "test/model",
    providerTag: "test-provider",
    providerName: "Test Provider",
    endpointTag: "test-provider",
    outputCapField: "max_tokens",
    maxOutputTokens: 8192,
    minPromptTokens: 16_384,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: { prompt: "0.000001", completion: "0.000002" },
    requiresImage: false,
    imageInputDeclared: false,
    visionProbeRequired: false,
    responseFormat: WORDING_JSON_SCHEMA,
    schemaHash: strictSchemaHash(WORDING_JSON_SCHEMA),
    settings: {},
    ...overrides,
  };
}

function slotFor(family: Family, modality: "text" | "svg") {
  const slot = SMOKE_PLAN.slots.find(
    (candidate) => candidate.family === family && candidate.modality === modality,
  );
  if (slot === undefined) {
    throw new Error(`smoke plan has no ${modality}/${family} slot`);
  }
  return slot;
}

interface SlotFixture {
  readonly slot: (typeof SMOKE_PLAN.slots)[number];
  readonly spec: unknown;
  readonly solve: ReturnType<ReturnType<typeof productionRegistry.getEngine>["enumerateSolutions"]>;
  readonly choices: unknown;
  readonly wording: ReturnType<typeof makeFixtureWording>;
  readonly assets: unknown;
}

function fixtureForSlot(slot: (typeof SMOKE_PLAN.slots)[number]): SlotFixture {
  const engine = productionRegistry.getEngine(slot.family);
  const seed = testSeed(`slot:${slot.slotId}`);
  const spec = engine.generateSpec(seed, slot.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`expected a unique ${slot.family} answer`);
  }
  const choices = engine.makeOptions(spec, solve.correctAnswer, seed);
  const wording = makeFixtureWording(engine, spec);
  const assets =
    engine.modality === "svg"
      ? {
          svgHash: sha256Hex(`p27-svg:${slot.slotId}`),
          pngHash: sha256Hex(`p27-png:${slot.slotId}`),
        }
      : undefined;
  return { slot, spec, solve, choices, wording, assets };
}

function insertFormalChecked(fixture: SlotFixture): void {
  insertStageResult(db, {
    runId: RUN_ID,
    slotId: fixture.slot.slotId,
    stage: "formal_checked",
    startedAt: CREATED_AT,
    finishedAt: CREATED_AT,
    elapsedMs: 0,
    payload: {
      spec: fixture.spec,
      solveResult: fixture.solve,
      choices: fixture.choices,
    },
  });
}

function callWording(
  fixture: SlotFixture,
  overrides: Partial<Parameters<typeof writeWording>[0]> = {},
) {
  return writeWording({
    db,
    accountId: "test-account",
    apiKey: API_KEY,
    transport,
    runId: RUN_ID,
    slotId: fixture.slot.slotId,
    route: wordingRoute(),
    spec: fixture.spec,
    solveResult: fixture.solve,
    choices: fixture.choices,
    ...(fixture.assets === undefined ? {} : { assets: fixture.assets }),
    reservationUsd: "0.01",
    clock,
    ...overrides,
  });
}

function successBody(content: unknown): Record<string, unknown> {
  return {
    id: "gen-p27",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
    },
  };
}

function failureBody(
  finishReason: string,
  content: string | null,
  reasoning: string | null = null,
): Record<string, unknown> {
  return {
    id: "gen-p27-failure",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, reasoning },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      cost: 0.001,
    },
  };
}

function wordingWith(
  base: WordingResponse,
  patch: Partial<WordingResponse>,
): WordingResponse {
  return { ...base, ...patch };
}

async function expectWordingError(
  action: Promise<unknown>,
  code: string,
): Promise<WordingError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(WordingError);
    const wordingError = error as WordingError;
    expect(wordingError.code).toBe(code);
    return wordingError;
  }
  throw new Error(`expected WordingError ${code}`);
}

function rawArtifactBytes(artifactId: number): Buffer {
  const row = db
    .prepare("SELECT bytes FROM artifacts WHERE artifact_id = ?")
    .get(artifactId) as { bytes: Buffer } | undefined;
  if (row === undefined) {
    throw new Error(`missing raw artifact ${artifactId}`);
  }
  return row.bytes;
}

function expectNoPresentation(slotId: string): void {
  expect(getSlot(db, RUN_ID, slotId).stage).toBe("formal_checked");
  expect(() => getStageResult(db, RUN_ID, slotId, "presentation_ready")).toThrow();
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p27-"));
  db = openDatabase(join(tempDirectory, "experiment.sqlite"));
  migrate(db);
  createRun(db, {
    runId: RUN_ID,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId: "test-account",
    runId: RUN_ID,
    runKind: "smoke",
    maxCostUsd: "10",
    createdAt: CREATED_AT,
  });
  fake = await createFakeOpenRouter();
  allowLocalFake(fake.baseUrl);
  transport = createOpenRouterTransport({
    baseUrl: fake.baseUrl,
    clock,
    random: () => 0,
  });
});

afterEach(async () => {
  await fake.close();
  try {
    db.close();
  } catch {
    // The test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("AI wording adapter", () => {
  it("writes one presentation per family and lane with a common stored shape", async () => {
    const shapes = new Set<string>();
    for (const slot of SMOKE_PLAN.slots) {
      const fixture = fixtureForSlot(slot);
      insertFormalChecked(fixture);
      fake.enqueue({ status: 200, body: successBody(fixture.wording.response) });

      const result = await callWording(fixture);
      expect(result.family).toBe(slot.family);
      expect(result.modality).toBe(slot.modality);
      expect(result.wording.source).toBe("model");
      expect(result.wording.response).toEqual(fixture.wording.response);
      expect(result.presentation.checks.semanticAlignment).toBe(
        "semantic_alignment_pending",
      );
      expect(AssembledPresentationSchema.safeParse(result.presentation).success).toBe(
        true,
      );
      expect(getSlot(db, RUN_ID, slot.slotId).stage).toBe("presentation_ready");

      const stage = getStageResult(db, RUN_ID, slot.slotId, "presentation_ready");
      const payload = stage.payload as {
        presentation: unknown;
        wording: { source: string; response: WordingResponse };
        proposal: {
          promptVersion: string;
          promptHash: string;
          schemaName: string;
          schemaVersion: string;
          schemaHash: string;
          logicalCallId: string;
        };
      };
      expect(AssembledPresentationSchema.safeParse(payload.presentation).success).toBe(
        true,
      );
      expect(payload.wording.source).toBe("model");
      expect(payload.wording.response).toEqual(fixture.wording.response);
      expect(payload.proposal.promptVersion).toBe("v1");
      expect(payload.proposal.schemaName).toBe("puzzle_wording");
      expect(payload.proposal.schemaVersion).toBe("v1");
      expect(payload.proposal.schemaHash).toBe(result.proposal.schemaHash);
      expect(payload.proposal.logicalCallId).toBe(result.logicalCallId);
      shapes.add(Object.keys(payload.presentation as object).sort().join(","));

      const call = getLogicalCall(db, result.logicalCallId);
      expect(call.expectedSchemaHash).toBe(result.proposal.schemaHash);
      const requestBody = call.requestBody as {
        messages: Array<{ role: string; content: string }>;
        response_format: { json_schema: { name: string; strict: boolean } };
        provider: { only: string[]; allow_fallbacks: boolean; require_parameters: boolean };
        max_tokens: number;
      };
      expect(requestBody.response_format.json_schema.name).toBe("puzzle_wording");
      expect(requestBody.response_format.json_schema.strict).toBe(true);
      expect(requestBody.provider).toEqual({
        only: ["test-provider"],
        allow_fallbacks: false,
        require_parameters: true,
      });
      expect(requestBody.max_tokens).toBe(8192);
      const system = requestBody.messages[0]?.content ?? "";
      expect(system).toContain("prompt_version: v1");
      expect(system).toContain(`prompt_hash: ${result.proposal.promptHash}`);
      expect(system).toContain("schema_name: puzzle_wording");
      expect(system).toContain("schema_version: v1");
      expect(system).toContain(`schema_hash: ${result.proposal.schemaHash}`);
      expect(JSON.stringify(requestBody.messages)).not.toContain("image_url");
      const userContent = requestBody.messages[1]?.content ?? "";
      const payloadStart = userContent.indexOf("\n") + 1;
      const payloadEnd = userContent.indexOf("\n\nReturn exactly");
      expect(payloadStart).toBeGreaterThan(0);
      expect(payloadEnd).toBeGreaterThan(payloadStart);
      const capturedPayload = JSON.parse(
        userContent.slice(payloadStart, payloadEnd),
      ) as { spec: unknown };
      expect(capturedPayload.spec).toEqual(fixture.spec);

      const metadataEvent = listRequestEvents(db, result.logicalCallId).find(
        (event) => event.eventType === "wording_metadata",
      );
      expect(metadataEvent).toBeDefined();
      expect(metadataEvent?.payload).toMatchObject({
        family: slot.family,
        modality: slot.modality,
        promptVersion: "v1",
        schemaName: "puzzle_wording",
        schemaVersion: "v1",
        promptHash: result.proposal.promptHash,
        schemaHash: result.proposal.schemaHash,
      });

      const sent = JSON.parse(fake.requests.at(-1)?.body ?? "null") as {
        response_format: { json_schema: { name: string } };
      };
      expect(sent.response_format.json_schema.name).toBe("puzzle_wording");
    }
    expect(fake.requests).toHaveLength(SMOKE_PLAN.slots.length);
    expect(shapes.size).toBe(1);
  });

  it("rejects missing, duplicate, unsupported, and SVG-transcribed wording mechanically", async () => {
    const cases: Array<{
      readonly slot: ReturnType<typeof slotFor>;
      readonly patch: (base: WordingResponse) => Partial<WordingResponse>;
      readonly code: string;
      readonly presentationCode: string;
    }> = [
      {
        slot: slotFor("ranking", "text"),
        patch: (base) => ({ clueTexts: base.clueTexts.slice(1) }),
        code: "MECHANICAL_CHECK_FAILED",
        presentationCode: "FACT_COVERAGE_MISMATCH",
      },
      {
        slot: slotFor("matching", "text"),
        patch: (base) => ({
          clueTexts: base.clueTexts.length > 0
            ? [base.clueTexts[0]!, base.clueTexts[0]!]
            : [],
        }),
        code: "MECHANICAL_CHECK_FAILED",
        presentationCode: "FACT_COVERAGE_MISMATCH",
      },
      {
        slot: slotFor("scheduling", "text"),
        patch: () => ({
          explanationSteps: [
            { factIds: ["f999"], text: "Unsupported reference." },
          ],
        }),
        code: "MECHANICAL_CHECK_FAILED",
        presentationCode: "UNKNOWN_FACT_REFERENCE",
      },
      {
        slot: slotFor("matrix", "svg"),
        patch: () => ({
          clueTexts: [{ factId: "p001", text: "Diagram transcription." }],
        }),
        code: "MECHANICAL_CHECK_FAILED",
        presentationCode: "UNEXPECTED_CLUE_TEXTS",
      },
    ];

    for (const testCase of cases) {
      const fixture = fixtureForSlot(testCase.slot);
      insertFormalChecked(fixture);
      const base = fixture.wording.response;
      fake.enqueue({
        status: 200,
        body: successBody(wordingWith(base, testCase.patch(base))),
      });
      const error = await expectWordingError(
        callWording(fixture),
        testCase.code,
      );
      expect(error.presentationCode).toBe(testCase.presentationCode);
      expect(error.logicalCallId).not.toBeNull();
      if (error.logicalCallId === null) {
        throw new Error("mechanical failure did not expose a logical call");
      }
      const attempts = listAttempts(db, error.logicalCallId);
      expect(attempts).toHaveLength(1);
      const artifactId = attempts[0]?.rawResponseArtifactId;
      expect(artifactId).not.toBeNull();
      if (artifactId === null || artifactId === undefined) {
        throw new Error("mechanical failure did not save a raw response");
      }
      expect(rawArtifactBytes(artifactId).toString("utf8")).toContain("test-provider");
      expect(attempts[0]?.actualCostUsd).toBe("0.001");
      expectNoPresentation(testCase.slot.slotId);
    }
    expect(fake.requests).toHaveLength(cases.length);
  });

  it("keeps semantic drift, leakage, HTML, and swapped fact text pending instead of passing or repairing it", async () => {
    const cases: Array<{
      readonly slot: ReturnType<typeof slotFor>;
      readonly patch: (base: WordingResponse, fixture: SlotFixture) => Partial<WordingResponse>;
      readonly check: (response: WordingResponse) => void;
    }> = [
      {
        slot: slotFor("ranking", "text"),
        patch: (base) => ({
          clueTexts: base.clueTexts.map((clue, index) =>
            index === 0
              ? { ...clue, text: `It is not true that ${clue.text}` }
              : clue,
          ),
        }),
        check: (response) => {
          expect(response.clueTexts[0]?.text).toContain("not true");
        },
      },
      {
        slot: slotFor("matching", "text"),
        patch: () => ({ question: "The answer is A. Which table is valid?" }),
        check: (response) => {
          expect(response.question).toContain("The answer is A.");
        },
      },
      {
        slot: slotFor("scheduling", "text"),
        patch: (base) => ({
          question: '<script>alert("question")</script>',
          clueTexts: base.clueTexts.map((clue, index) =>
            index === 0
              ? { ...clue, text: '<img src=x onerror="alert(1)">' }
              : clue,
          ),
          hint: "<b>hint</b>",
          explanationSteps: [
            { factIds: ["r-domain"], text: "<script>alert('explanation')</script>" },
          ],
        }),
        check: (response) => {
          expect(response.question).toContain("<script>");
          expect(response.clueTexts[0]?.text).toContain("<img");
          expect(response.hint).toBe("<b>hint</b>");
        },
      },
      {
        slot: slotFor("truth", "text"),
        patch: (base) => {
          const first = base.clueTexts[0];
          const second = base.clueTexts[1];
          if (first === undefined || second === undefined) {
            return {};
          }
          return {
            clueTexts: base.clueTexts.map((clue, index) =>
              index === 0
                ? { ...clue, text: second.text }
                : index === 1
                  ? { ...clue, text: first.text }
                  : clue,
            ),
          };
        },
        check: () => {},
      },
    ];

    for (const testCase of cases) {
      const fixture = fixtureForSlot(testCase.slot);
      insertFormalChecked(fixture);
      const base = fixture.wording.response;
      const response = wordingWith(base, testCase.patch(base, fixture));
      fake.enqueue({ status: 200, body: successBody(response) });
      const result = await callWording(fixture);
      expect(result.presentation.checks.semanticAlignment).toBe(
        "semantic_alignment_pending",
      );
      expect(result.wording.response).toEqual(response);
      testCase.check(result.wording.response);
      const stage = getStageResult(db, RUN_ID, testCase.slot.slotId, "presentation_ready");
      const payload = stage.payload as {
        wording: { response: WordingResponse };
        presentation: { checks: { semanticAlignment: string } };
      };
      expect(payload.wording.response).toEqual(response);
      expect(payload.presentation.checks.semanticAlignment).toBe(
        "semantic_alignment_pending",
      );
    }
    expect(fake.requests).toHaveLength(cases.length);
  });

  it("rejects invalid wording schemas and empty reasoning-only responses without a stage", async () => {
    const invalidSlot = slotFor("ranking", "text");
    const invalidFixture = fixtureForSlot(invalidSlot);
    insertFormalChecked(invalidFixture);
    fake.enqueue({
      status: 200,
      body: successBody({ ...invalidFixture.wording.response, hint: "" }),
    });
    const invalid = await expectWordingError(
      callWording(invalidFixture),
      "INVALID_WORDING",
    );
    expect(invalid.logicalCallId).not.toBeNull();
    expectNoPresentation(invalidSlot.slotId);

    const emptySlot = slotFor("matching", "text");
    const emptyFixture = fixtureForSlot(emptySlot);
    insertFormalChecked(emptyFixture);
    fake.enqueue({
      status: 200,
      body: failureBody("stop", null, "I can solve this puzzle."),
    });
    let emptyError: WordingError | null = null;
    try {
      await callWording(emptyFixture);
    } catch (error) {
      expect(error).toBeInstanceOf(WordingError);
      emptyError = error as WordingError;
    }
    expect(emptyError).not.toBeNull();
    expect(["TRANSPORT_FAILED", "MISSING_CONTENT"]).toContain(
      emptyError?.code,
    );
    expectNoPresentation(emptySlot.slotId);
    expect(fake.requests).toHaveLength(2);
  });

  it("makes exactly one wording call per eligible slot and refuses a second call", async () => {
    const fixture = fixtureForSlot(slotFor("ranking", "text"));
    insertFormalChecked(fixture);
    fake.enqueue({ status: 200, body: successBody(fixture.wording.response) });
    const first = await callWording(fixture);
    expect(getSlot(db, RUN_ID, fixture.slot.slotId).stage).toBe(
      "presentation_ready",
    );
    expect(fake.requests).toHaveLength(1);

    fake.enqueue({ status: 200, body: successBody(fixture.wording.response) });
    const second = await expectWordingError(
      callWording(fixture),
      "INVALID_STAGE",
    );
    expect(second.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(1);
    expect(
      getStageResult(db, RUN_ID, fixture.slot.slotId, "presentation_ready").payload,
    ).toBeDefined();
    expect(first.logicalCallId).not.toBeNull();
  });

  it("rejects a non-wording route, image route, and non-formal slot before a request", async () => {
    const fixture = fixtureForSlot(slotFor("ranking", "text"));
    insertFormalChecked(fixture);
    const wrongRole = await expectWordingError(
      callWording(fixture, { route: wordingRoute({ role: "spec" }) }),
      "ROUTE_ROLE_MISMATCH",
    );
    expect(wrongRole.logicalCallId).toBeNull();

    const imageRoute = await expectWordingError(
      callWording(fixture, { route: wordingRoute({ requiresImage: true }) }),
      "INVALID_INPUT",
    );
    expect(imageRoute.logicalCallId).toBeNull();

    const planned = fixtureForSlot(slotFor("matching", "text"));
    const notFormal = await expectWordingError(
      callWording(planned),
      "INVALID_STAGE",
    );
    expect(notFormal.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects caller artifacts that differ from the stored formal-check evidence", async () => {
    const fixture = fixtureForSlot(slotFor("ranking", "text"));
    insertFormalChecked(fixture);
    const other = fixtureForSlot(slotFor("matching", "text"));
    const error = await expectWordingError(
      callWording(fixture, { spec: other.spec }),
      "INVALID_INPUT",
    );
    expect(error.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect(getSlot(db, RUN_ID, fixture.slot.slotId).stage).toBe("formal_checked");
  });

  it("keeps prompt metadata stable and versioned", () => {
    const first = wordingPromptMetadata();
    const second = wordingPromptMetadata();
    expect(first).toEqual(second);
    expect(first.promptVersion).toBe("v1");
    expect(first.schemaVersion).toBe("v1");
    expect(first.schemaName).toBe("puzzle_wording");
    expect(first.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.schemaHash).toBe(strictSchemaHash(WORDING_JSON_SCHEMA));

    const fixture = fixtureForSlot(slotFor("ranking", "text"));
    const messages = buildWordingMessages(
      {
        family: "ranking",
        spec: {},
        modality: "text",
        difficulty: 1,
        rules: {},
        localFacts: [],
        localFactIds: [],
        inventory: [],
        proof: {},
        correctOption: { label: "A", value: [], text: "option" },
        options: [],
      },
      first,
    );
    expect(messages[0]?.content).toContain("prompt_version: v1");
    expect(messages[1]?.content).toContain("Validated puzzle payload");
    expect(fixture.slot.family).toBe("ranking");
  });
});
