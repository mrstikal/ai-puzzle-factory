import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { createMockTransport } from "../../src/ai/mock.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import {
  runDesignerCohort,
  type DesignerRunConfig,
} from "../../src/design/run.js";
import {
  createDesignerRun,
  getDesignerRun,
  listDesignAttempts,
  listDesignerSlots,
} from "../../src/storage/repository.js";
import { getBudgetAccount } from "../../src/ai/budget.js";
import { RunCancellation } from "../../src/runner/cancel.js";
import { loadDesignerCohortMetrics } from "../../src/reporting/design-metrics.js";
import {
  buildCohortReference,
  buildFrozenReference,
} from "../../src/design/baseline.js";
import { exportDesignerRun } from "../../src/reporting/design-report.js";
import { buildDesignSampleCandidates } from "../../src/cli/design-audit.js";
import {
  buildDesignEvaluationSample,
  type DesignEvaluationSample,
} from "../../src/audit/design-sample.js";
import {
  buildDesignEvaluationLabelsCsv,
  storeDesignEvaluationSample,
} from "../../src/audit/design-labels.js";
import {
  buildDesignerDecisionEvidence,
  evaluateDesignerDecision,
} from "../../src/reporting/design-decision.js";
import {
  DesignerConfigurationSnapshotSchema,
  canFreezeDesignerProtocol,
} from "../../src/design/freeze.js";
import { parseRoutingConfirmation } from "../../src/design/routing.js";
import { FAMILIES } from "../../src/domain/experiment.js";

const PLAN = buildDesignerPlanManifest({ runKind: "design_mock" });
const PILOT_PLAN = buildDesignerPlanManifest({ runKind: "design_pilot" });
const CONFIG: DesignerRunConfig = {
  model: "mock/model",
  outputCapField: "max_tokens",
  maxOutputTokens: 8192,
  skinEnabled: true,
  reservationUsd: "0.01",
  nonBilling: true,
};

const databases: Database.Database[] = [];
const directories: string[] = [];
let sharedDb: Database.Database | null = null;
let sharedRun: Awaited<ReturnType<typeof runFullMock>> | null = null;

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

afterAll(() => {
  sharedDb?.close();
});

function database(): Database.Database {
  const db = openDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function runFullMock(db: Database.Database) {
  const runId = randomUUID();
  const accountId = randomUUID();
  const transport = createMockTransport({ db });
  const result = await runDesignerCohort({
    db,
    runId,
    plan: PLAN,
    evidenceKind: "mock",
    apiKey: "mock",
    transport,
    accountId,
    maxCostUsd: "0",
    config: CONFIG,
    concurrency: 2,
  });
  return { runId, accountId, transport, result };
}

async function sharedFullMock() {
  if (sharedRun !== null) {
    return sharedRun;
  }
  sharedDb = openDatabase(":memory:");
  migrate(sharedDb);
  sharedRun = await runFullMock(sharedDb);
  return sharedRun;
}

function sampleFor(db: Database.Database, runId: string): DesignEvaluationSample {
  const run = getDesignerRun(db, runId);
  return buildDesignEvaluationSample({
    runId,
    planHash: run.manifest.planHash,
    protocolVersion: run.protocolVersion,
    rootSeed: run.rootSeed,
    createdAt: new Date().toISOString(),
    candidates: buildDesignSampleCandidates(db, runId),
  });
}

describe("P50.4 full offline designer release", () => {
  it("runs 100 assignments and 300 candidates with zero paid calls and complete exports", async () => {
    const { runId, accountId, transport, result } = await sharedFullMock();
    const db = sharedDb as Database.Database;
    expect(result.status).toBe("completed");
    expect(result.slots).toHaveLength(300);
    expect(result.plan.assignments).toHaveLength(100);
    expect(result.plan.candidates).toHaveLength(300);
    for (const arm of ["baseline", "ai_one_shot", "ai_feedback"] as const) {
      expect(result.slots.filter((slot) => slot.arm === arm)).toHaveLength(100);
    }
    const attempts = result.slots.flatMap((slot) =>
      listDesignAttempts(db, runId, slot.slotId),
    );
    expect(attempts.length).toBeLessThanOrEqual(400);
    expect(transport.requests.length).toBeLessThanOrEqual(400);
    expect(
      attempts.filter((attempt) => attempt.arm === "baseline").every(
        (attempt) => attempt.logicalCallId === null,
      ),
    ).toBe(true);
    const aiAttempts = attempts.filter((attempt) => attempt.arm !== "baseline");
    expect(aiAttempts.every((attempt) => attempt.costStatus === "known")).toBe(true);
    expect(aiAttempts.every((attempt) => attempt.costUsd === "0")).toBe(true);
    const roles = db
      .prepare("SELECT DISTINCT role FROM logical_calls WHERE run_id = ?")
      .all(runId) as Array<{ role: string }>;
    expect(new Set(roles.map((row) => row.role))).toEqual(
      new Set(["design", "design_repair_1", "design_repair_2"]),
    );
    const account = getBudgetAccount(db, accountId);
    expect(account.knownActualUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");

    const families = new Set(result.slots.map((slot) => slot.family));
    expect([...families].sort()).toEqual([...FAMILIES].sort());
    expect(result.slots.filter((slot) => slot.modality === "text")).toHaveLength(150);
    expect(result.slots.filter((slot) => slot.modality === "svg")).toHaveLength(150);

    const outputRoot = tempDirectory("designer-export-");
    const exported = exportDesignerRun(db, runId, { outputRoot });
    expect(existsSync(join(exported.directory, "candidates.jsonl"))).toBe(true);
    expect(
      readFileSync(join(exported.directory, "candidates.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(300);
    expect(
      readFileSync(join(exported.directory, "design-attempts.jsonl"), "utf8")
        .trim()
        .split("\n").length,
    ).toBe(attempts.length);
    expect(existsSync(join(exported.directory, "summary.json"))).toBe(true);
    expect(existsSync(join(exported.directory, "results.csv"))).toBe(true);
    expect(existsSync(join(exported.directory, "report.html"))).toBe(true);
    expect(existsSync(join(exported.directory, "puzzles"))).toBe(true);
    expect(existsSync(join(exported.directory, "requests.jsonl"))).toBe(true);
    expect(
      readFileSync(join(exported.directory, "requests.jsonl"), "utf8")
        .trim()
        .split("\n").length,
    ).toBeGreaterThan(0);
    const pngFiles = readdirSync(join(exported.directory, "images")).filter(
      (file) => file.endsWith(".png"),
    );
    expect(pngFiles.length).toBeGreaterThan(0);
    const html = readFileSync(join(exported.directory, "report.html"), "utf8");
    const slotIds = new Set(
      [...html.matchAll(/data-slot-id="([^"]+)"/g)].map((match) => match[1]),
    );
    expect(slotIds.size).toBe(300);
    expect(html).toContain("MOCK DATA");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("<script src=");
    expect(html).toContain("<script>");
    expect(exported.metrics.complete).toBe(true);
  }, 300_000);

  it("prepares a blinded sample and refuses mock evidence as live decision evidence", async () => {
    const { runId } = await sharedFullMock();
    const db = sharedDb as Database.Database;
    const sample = sampleFor(db, runId);
    expect(sample.publicBundle.triplets.length).toBeLessThanOrEqual(10);
    expect(sample.selection.totalCandidates).toBeLessThanOrEqual(40);
    expect(sample.selection.missingFamilies).toEqual([]);
    const publicJson = JSON.stringify(sample.publicBundle);
    for (const forbidden of [
      "ai_feedback",
      "ai_one_shot",
      "baseline",
      "repair",
      "novel",
      "design-text-",
      "assignmentId",
      "slotId",
    ]) {
      expect(publicJson).not.toContain(forbidden);
    }
    storeDesignEvaluationSample(db, sample);
    const csv = buildDesignEvaluationLabelsCsv(sample, {
      syntheticTestOnly: true,
    });
    expect(csv.startsWith("# synthetic_test_only=true")).toBe(true);

    const frozen = buildFrozenReference();
    const cohort = buildCohortReference(
      buildDesignerPlanManifest({ runKind: "design_primary" }),
    );
    const metrics = loadDesignerCohortMetrics(db, runId, { frozen, cohort });
    const decision = evaluateDesignerDecision({
      evidence: buildDesignerDecisionEvidence(metrics),
      human: null,
      protocolHash: null,
      protocolMatches: false,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decision.recommendation).toBe("revise");
    expect(decision.evidenceStatus.mockEvidence).toBe(true);

    const pilotRunId = randomUUID();
    createDesignerRun(db, {
      runId: pilotRunId,
      plan: PILOT_PLAN,
      evidenceKind: "mock",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const pilotRun = getDesignerRun(db, pilotRunId);
    const configuration = DesignerConfigurationSnapshotSchema.parse({
      model: "mock/model",
      routingPolicy: "balanced",
      providerSort: "default",
      byokProviderKeysConfigured: false,
      outputCapField: "max_tokens",
      maxOutputTokens: 8192,
      concurrency: 2,
      settingsMode: "default",
      settings: null,
      promptsHash: "a".repeat(64),
      schemaHash: "a".repeat(64),
      sourceHash: "a".repeat(64),
      fontHash: "a".repeat(64),
      referenceHash: "a".repeat(64),
      cohortHash: "a".repeat(64),
      dependencyLockHash: "a".repeat(64),
      templateHash: "a".repeat(64),
      comparatorHash: "a".repeat(64),
      metricsHash: "a".repeat(64),
      decisionEvaluatorHash: "a".repeat(64),
      humanRubricHash: "a".repeat(64),
    });
    const freeze = canFreezeDesignerProtocol({
      pilotRun,
      pilotMetrics: metrics,
      primaryPlan: buildDesignerPlanManifest({ runKind: "design_primary" }),
      currentConfiguration: configuration,
      pilotConfiguration: configuration,
      routingConfirmation: parseRoutingConfirmation({
        operator: "alex",
        checkedAt: "2026-01-01T00:00:00.000Z",
        routingPolicy: "balanced",
        providerSort: "default",
        byokProviderKeysConfigured: false,
      }),
      budgetForecast: {
        totalLogicalCalls: 400,
        maxTransportAttempts: 1200,
        conservativeReserveUsd: "0.50",
        perRoleReserveUsd: {
          design: "0.50",
          design_repair_1: "0.50",
          design_repair_2: "0.50",
        },
        observedPilotCostUsd: "0",
        method: "Conservative reserve.",
      },
      authorization: {
        operator: "alex",
        authorizedAt: "2026-01-01T00:00:00.000Z",
        maxRunCostUsd: "10",
        acknowledged: true,
      },
      pilotEvidence: {
        evidenceKind: "live",
        runKind: "design_pilot",
        completed: true,
        assignments: 20,
        candidates: 60,
        perFamilyAccepted: Object.fromEntries(
          FAMILIES.map((family) => [family, 1]),
        ) as Record<(typeof FAMILIES)[number], number>,
        knownCostsComplete: true,
        ledgerComplete: true,
        unresolvedInfrastructureDefect: false,
        observedProviderMix: {},
      },
      frozenAt: "2026-01-02T00:00:00.000Z",
    });
    expect(freeze.ok).toBe(false);
    expect(freeze.failures.map((failure) => failure.code)).toContain(
      "mock_pilot_evidence",
    );
  }, 300_000);

  it("cancels safely and resumes the same offline run", async () => {
    const db = database();
    const runId = randomUUID();
    const accountId = randomUUID();
    const transport = createMockTransport({ db });
    const slotIds = PLAN.candidates
      .filter((candidate) => candidate.assignmentOrdinal <= 2)
      .map((candidate) => candidate.candidateSlotId);
    const cancellation = new RunCancellation();
    const first = await runDesignerCohort({
      db,
      runId,
      plan: PLAN,
      evidenceKind: "mock",
      apiKey: "mock",
      transport,
      accountId,
      maxCostUsd: "0",
      config: CONFIG,
      concurrency: 1,
      slotIds,
      cancellation,
      hooks: {
        onSlotCompleted: () => {
          if (cancellation.stopReason === null) {
            cancellation.stop("operator");
          }
        },
      },
    });
    expect(first.status).toBe("cancelled");
    expect(first.cancellation).not.toBeNull();
    const second = await runDesignerCohort({
      db,
      runId,
      plan: PLAN,
      evidenceKind: "mock",
      apiKey: "mock",
      transport,
      accountId,
      maxCostUsd: "0",
      config: CONFIG,
      concurrency: 1,
      slotIds,
      resume: true,
    });
    expect(second.status).toBe("completed");
    const slots = listDesignerSlots(db, runId);
    expect(
      slots.filter((slot) => slotIds.includes(slot.slotId)).every(
        (slot) => slot.stage === "terminal",
      ),
    ).toBe(true);
  }, 120_000);
});
