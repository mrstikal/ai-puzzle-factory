import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, migrate } from "../../src/storage/database.js";
import {
  createDesignerRun,
  getDesignerRun,
} from "../../src/storage/repository.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import {
  DESIGNER_HUMAN_EVALUATION_PLAN,
  DesignerConfigurationSnapshotSchema,
  buildDesignerConfigurationSnapshot,
  canFreezeDesignerProtocol,
  computeDesignerConfigurationHash,
  computePilotPerFamilyAiAccepted,
  exportDesignerProtocolFreeze,
  getDesignerProtocolFreeze,
  insertDesignerProtocolFreeze,
  verifyDesignerProtocolFreezeFromDb,
  type DesignerConfigurationSnapshot,
  type DesignerFreezeInput,
} from "../../src/design/freeze.js";
import {
  DesignerCandidateMetricsRowSchema,
  computeDesignerCohortMetrics,
  type DesignerCandidateMetricsRow,
  type DesignerCohortMetrics,
} from "../../src/reporting/design-metrics.js";
import { DESIGNER_DECISION_THRESHOLDS } from "../../src/reporting/design-decision.js";
import {
  parseRoutingConfirmation,
  type RoutingConfirmation,
} from "../../src/design/routing.js";
import { FAMILIES } from "../../src/domain/experiment.js";
import type { DesignerRunRecord } from "../../src/domain/design.js";


const PILOT_PLAN = buildDesignerPlanManifest({ runKind: "design_pilot" });
const PRIMARY_PLAN = buildDesignerPlanManifest({ runKind: "design_primary" });
const HASH = "a".repeat(64);
const ROUTING: RoutingConfirmation = parseRoutingConfirmation({
  operator: "alex",
  checkedAt: "2026-01-01T00:00:00.000Z",
  routingPolicy: "balanced",
  providerSort: "default",
  byokProviderKeysConfigured: false,
});

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

function database(): Database.Database {
  const db = openDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

function configuration(
  overrides: Partial<DesignerConfigurationSnapshot> = {},
): DesignerConfigurationSnapshot {
  return DesignerConfigurationSnapshotSchema.parse({
    model: "designer-model",
    routingPolicy: "balanced",
    providerSort: "default",
    byokProviderKeysConfigured: false,
    outputCapField: "max_tokens",
    maxOutputTokens: 8192,
    concurrency: 2,
    settingsMode: "default",
    settings: null,
    promptsHash: HASH,
    schemaHash: HASH,
    sourceHash: HASH,
    fontHash: HASH,
    referenceHash: HASH,
    cohortHash: HASH,
    dependencyLockHash: HASH,
    templateHash: HASH,
    comparatorHash: HASH,
    metricsHash: HASH,
    decisionEvaluatorHash: HASH,
    humanRubricHash: HASH,
    ...overrides,
  });
}

function metricRow(input: {
  readonly assignmentOrdinal: number;
  readonly arm: "baseline" | "ai_one_shot" | "ai_feedback";
}): DesignerCandidateMetricsRow {
  const assignment = PILOT_PLAN.assignments.find(
    (entry) => entry.assignmentOrdinal === input.assignmentOrdinal,
  );
  if (assignment === undefined) {
    throw new Error("missing pilot assignment");
  }
  return DesignerCandidateMetricsRowSchema.parse({
    slotId: `${assignment.assignmentId}-${input.arm}`,
    assignmentId: assignment.assignmentId,
    arm: input.arm,
    family: assignment.family,
    modality: assignment.modality,
    difficulty: assignment.difficulty,
    stage: "terminal",
    verdict: "accepted",
    firstAttemptVerdict: "accepted",
    finalVerdict: "accepted",
    attemptCount: 1,
    attemptVerdicts: ["accepted"],
    firstDiagnosticCode: null,
    finalDiagnosticCode: null,
    firstStructuralFingerprint: `${assignment.assignmentId}-${input.arm}-f`,
    finalStructuralFingerprint: `${assignment.assignmentId}-${input.arm}-f`,
    firstNovelty: input.arm === "baseline" ? "baseline_duplicate" : "novel",
    finalNovelty: input.arm === "baseline" ? "baseline_duplicate" : "novel",
    firstCostStatus: input.arm === "baseline" ? "none" : "known",
    firstCostUsd: input.arm === "baseline" ? "0" : "0.01",
    totalCostStatus: input.arm === "baseline" ? "none" : "known",
    totalCostUsd: input.arm === "baseline" ? "0" : "0.01",
    unknownAttempts: 0,
    knownAttempts: input.arm === "baseline" ? 0 : 1,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    httpLatencyMs: [5],
    logicalLatencyMs: [5],
    activeStageMs: 1,
    firstStartedAt: "2026-01-01T00:00:00.000Z",
    terminalFinishedAt: "2026-01-01T00:00:01.000Z",
    observedProviders: ["provider-a"],
    observedModels: ["designer-model"],
    missingProviderIdentity: 0,
    missingModelIdentity: 0,
    errorCodes: [],
  });
}

function pilotMetrics(
  overrides: Partial<{ readonly complete: boolean; readonly planHash: string }> = {},
): DesignerCohortMetrics {
  const rows = PILOT_PLAN.assignments.flatMap((assignment) =>
    (["baseline", "ai_one_shot", "ai_feedback"] as const).map((arm) =>
      metricRow({ assignmentOrdinal: assignment.assignmentOrdinal, arm }),
    ),
  );
  return computeDesignerCohortMetrics({
    runId: "pilot-run",
    planHash: overrides.planHash ?? PILOT_PLAN.planHash,
    runKind: "design_pilot",
    evidenceKind: "live",
    status: overrides.complete === false ? "paused_budget" : "completed",
    plannedAssignments: 20,
    plannedCandidates: 60,
    plannedTextAssignments: 10,
    plannedSvgAssignments: 10,
    plannedPerFamilyAssignments: 2,
    plannedDifficultyAssignments: { 1: 8, 2: 6, 3: 6 },
    rows,
    novelty: {
      frozenComplete: true,
      frozenCoverageSatisfied: true,
      cohortComplete: true,
      coverageByFamily: Object.fromEntries(FAMILIES.map((family) => [family, true])),
    },
    human: null,
  });
}

function pilotRun(db: Database.Database, evidenceKind: "mock" | "live" = "live"): DesignerRunRecord {
  const runId = randomUUID();
  createDesignerRun(db, {
    runId,
    plan: PILOT_PLAN,
    evidenceKind,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return getDesignerRun(db, runId);
}

function validInput(
  db: Database.Database,
  overrides: Partial<DesignerFreezeInput> = {},
): DesignerFreezeInput {
  const pilot = pilotRun(db);
  const currentConfiguration = configuration();
  return {
    pilotRun: pilot,
    pilotMetrics: pilotMetrics({ planHash: pilot.manifest.planHash }),
    primaryPlan: PRIMARY_PLAN,
    currentConfiguration,
    pilotConfiguration: currentConfiguration,
    routingConfirmation: ROUTING,
    budgetForecast: {
      totalLogicalCalls: 400,
      maxTransportAttempts: 1200,
      conservativeReserveUsd: "0.50",
      perRoleReserveUsd: {
        design: "0.50",
        design_repair_1: "0.50",
        design_repair_2: "0.50",
      },
      observedPilotCostUsd: "0.20",
      method: "Conservative per-role reserve.",
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
      observedProviderMix: { "provider-a": 60 },
    },
    frozenAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("P50.2 designer freeze", () => {
  it("freezes a valid live pilot and replays it from SQLite after export removal", () => {
    const db = database();
    const input = validInput(db);
    const result = canFreezeDesignerProtocol(input);
    expect(result.ok).toBe(true);
    expect(result.freeze).not.toBeNull();
    const freeze = result.freeze!;
    insertDesignerProtocolFreeze(db, freeze);
    const stored = getDesignerProtocolFreeze(db, freeze.protocolHash);
    expect(stored).toEqual(freeze);
    expect(stored.configurationHash).toBe(
      computeDesignerConfigurationHash(stored.configuration),
    );

    const directory = mkdtempSync(join(tmpdir(), "designer-freeze-export-"));
    directories.push(directory);
    const exported = exportDesignerProtocolFreeze({
      freeze,
      outputDirectory: directory,
    });
    expect(exported.protocolHash).toBe(freeze.protocolHash);
    rmSync(exported.protocolPath);
    const replayed = verifyDesignerProtocolFreezeFromDb(db, freeze.protocolHash);
    expect(replayed).toEqual(freeze);
    expect(replayed.humanEvaluationPlan).toEqual(DESIGNER_HUMAN_EVALUATION_PLAN);
    expect(replayed.thresholds).toEqual(DESIGNER_DECISION_THRESHOLDS);
  });

  it("rejects mock, partial, mismatched, and stale pilot evidence", () => {
    const db = database();
    const mockRun = pilotRun(db, "mock");
    const mockResult = canFreezeDesignerProtocol(
      validInput(db, {
        pilotRun: mockRun,
        pilotMetrics: pilotMetrics({ planHash: mockRun.manifest.planHash }),
      }),
    );
    expect(mockResult.ok).toBe(false);
    expect(mockResult.failures.map((failure) => failure.code)).toContain(
      "mock_pilot_evidence",
    );

    const partial = canFreezeDesignerProtocol(
      validInput(db, { pilotMetrics: pilotMetrics({ complete: false }) }),
    );
    expect(partial.ok).toBe(false);
    expect(partial.failures.map((failure) => failure.code)).toContain(
      "pilot_incomplete",
    );

    const mismatched = canFreezeDesignerProtocol(
      validInput(db, {
        pilotMetrics: pilotMetrics({ planHash: "b".repeat(64) }),
      }),
    );
    expect(mismatched.ok).toBe(false);
    expect(mismatched.failures.map((failure) => failure.code)).toContain(
      "pilot_manifest_mismatch",
    );
  });

  it("rejects source, model, routing, and output-limit drift but not provider churn", () => {
    const db = database();
    for (const [field, value] of [
      ["model", "other-model"],
      ["sourceHash", "b".repeat(64)],
      ["providerSort", "balanced"],
      ["maxOutputTokens", 4096],
    ] as const) {
      const result = canFreezeDesignerProtocol(
        validInput(db, {
          currentConfiguration: configuration({ [field]: value }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.failures.map((failure) => failure.code)).toContain(
        "configuration_drift",
      );
    }

    const churn = canFreezeDesignerProtocol(
      validInput(db, {
        pilotEvidence: {
          ...validInput(db).pilotEvidence,
          observedProviderMix: { "provider-b": 60 },
        },
      }),
    );
    expect(churn.ok).toBe(true);
  });

  it("rejects a forecast above authorization, changed thresholds, and unsupported routing", () => {
    const db = database();
    const overAuthorization = canFreezeDesignerProtocol(
      validInput(db, {
        budgetForecast: {
          ...validInput(db).budgetForecast,
          conservativeReserveUsd: "11",
        },
      }),
    );
    expect(overAuthorization.ok).toBe(false);
    expect(overAuthorization.failures.map((failure) => failure.code)).toContain(
      "forecast_exceeds_authorization",
    );

    const invalidCapInput = validInput(db);
    const invalidCap = canFreezeDesignerProtocol({
      ...invalidCapInput,
      authorization: {
        ...invalidCapInput.authorization,
        maxRunCostUsd: "10 USD",
      },
    });
    expect(invalidCap.ok).toBe(false);
    expect(invalidCap.failures.map((failure) => failure.code)).toContain(
      "authorization_cap_invalid",
    );

    const invalidForecastInput = validInput(db);
    const invalidForecast = canFreezeDesignerProtocol({
      ...invalidForecastInput,
      budgetForecast: {
        ...invalidForecastInput.budgetForecast,
        conservativeReserveUsd: "abc",
      },
    });
    expect(invalidForecast.ok).toBe(false);
    expect(invalidForecast.failures.map((failure) => failure.code)).toContain(
      "forecast_invalid",
    );

    const perRoleOverCapInput = validInput(db);
    const perRoleOverCap = canFreezeDesignerProtocol({
      ...perRoleOverCapInput,
      authorization: {
        ...perRoleOverCapInput.authorization,
        maxRunCostUsd: "1",
      },
      budgetForecast: {
        ...perRoleOverCapInput.budgetForecast,
        conservativeReserveUsd: "0.50",
        perRoleReserveUsd: {
          design: "0.50",
          design_repair_1: "0.50",
          design_repair_2: "0.50",
        },
      },
    });
    expect(perRoleOverCap.ok).toBe(false);
    expect(perRoleOverCap.failures.map((failure) => failure.code)).toContain(
      "forecast_exceeds_authorization",
    );

    const changedThresholds = canFreezeDesignerProtocol(
      validInput(db, {
        thresholds: {
          ...DESIGNER_DECISION_THRESHOLDS,
          novelAcceptance: 0.31,
        } as unknown as typeof DESIGNER_DECISION_THRESHOLDS,
      }),
    );
    expect(changedThresholds.ok).toBe(false);
    expect(changedThresholds.failures.map((failure) => failure.code)).toContain(
      "thresholds_changed",
    );

    const conflictingRouting = canFreezeDesignerProtocol(
      validInput(db, {
        routingConfirmation: parseRoutingConfirmation({
          operator: "alex",
          checkedAt: "2026-01-01T00:00:00.000Z",
          routingPolicy: "balanced",
          providerSort: "default",
          byokProviderKeysConfigured: false,
        }),
        currentConfiguration: configuration({ byokProviderKeysConfigured: false }),
      }),
    );
    expect(conflictingRouting.ok).toBe(true);
  });

  it("normalizes equivalent routing provider-sort encodings in the configuration hash", () => {
    const hashes = {
      promptsHash: HASH,
      schemaHash: HASH,
      sourceHash: HASH,
      fontHash: HASH,
      referenceHash: HASH,
      cohortHash: HASH,
      dependencyLockHash: HASH,
      templateHash: HASH,
      comparatorHash: HASH,
      metricsHash: HASH,
      decisionEvaluatorHash: HASH,
      humanRubricHash: HASH,
    };
    const nullSort = parseRoutingConfirmation({
      operator: "alex",
      checkedAt: "2026-01-01T00:00:00.000Z",
      routingPolicy: "balanced",
      providerSort: null,
      byokProviderKeysConfigured: false,
    });
    const defaultSort = parseRoutingConfirmation({
      operator: "alex",
      checkedAt: "2026-01-01T00:00:00.000Z",
      routingPolicy: "balanced",
      providerSort: "default",
      byokProviderKeysConfigured: false,
    });
    const build = (routingConfirmation: RoutingConfirmation) =>
      buildDesignerConfigurationSnapshot({
        model: "designer-model",
        outputCapField: "max_tokens",
        maxOutputTokens: 8192,
        concurrency: 2,
        routingConfirmation,
        hashes,
      });
    expect(computeDesignerConfigurationHash(build(nullSort))).toBe(
      computeDesignerConfigurationHash(build(defaultSort)),
    );
  });

  it("counts only AI-arm acceptance for per-family pilot coverage", () => {
    const metrics = pilotMetrics();
    const adjusted = {
      ...metrics,
      strata: {
        ...metrics.strata,
        byFamilyArm: metrics.strata.byFamilyArm.map((row) =>
          row.key.startsWith("ranking:ai_")
            ? { ...row, finalAccepted: 0 }
            : row.key === "ranking:baseline"
              ? { ...row, finalAccepted: 2 }
              : row,
        ),
      },
    };
    const coverage = computePilotPerFamilyAiAccepted(adjusted);
    expect(coverage.ranking).toBe(0);
    expect(coverage.matching).toBeGreaterThan(0);
  });

  it("keeps freeze rows append-only", () => {
    const db = database();
    const freeze = canFreezeDesignerProtocol(validInput(db)).freeze!;
    insertDesignerProtocolFreeze(db, freeze);
    expect(() =>
      db
        .prepare("UPDATE designer_protocol_freezes SET frozen_at = ?")
        .run("2026-01-03T00:00:00.000Z"),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM designer_protocol_freezes").run(),
    ).toThrow(/append-only/);
  });
});
