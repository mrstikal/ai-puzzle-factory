import { describe, expect, it } from "vitest";
import {
  DesignerCandidateMetricsRowSchema,
  computeDesignerCohortMetrics,
  type DesignerCandidateMetricsRow,
} from "../../src/reporting/design-metrics.js";

function row(
  overrides: Partial<DesignerCandidateMetricsRow> &
    Pick<
      DesignerCandidateMetricsRow,
      "slotId" | "assignmentId" | "arm" | "family" | "difficulty"
    >,
): DesignerCandidateMetricsRow {
  const modality =
    overrides.family === "matrix" ||
    overrides.family === "transforms" ||
    overrides.family === "paths" ||
    overrides.family === "symmetry" ||
    overrides.family === "counting"
      ? "svg"
      : "text";
  return DesignerCandidateMetricsRowSchema.parse({
    stage: "terminal",
    verdict: "accepted",
    firstAttemptVerdict: "accepted",
    finalVerdict: "accepted",
    attemptCount: 1,
    attemptVerdicts: ["accepted"],
    firstDiagnosticCode: null,
    finalDiagnosticCode: null,
    firstStructuralFingerprint: null,
    finalStructuralFingerprint: null,
    firstNovelty: "novel",
    finalNovelty: "novel",
    firstCostStatus: "known",
    firstCostUsd: "0.10",
    totalCostStatus: "known",
    totalCostUsd: "0.10",
    unknownAttempts: 0,
    knownAttempts: 1,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    httpLatencyMs: [100],
    logicalLatencyMs: [100],
    activeStageMs: 10,
    firstStartedAt: "2026-01-01T00:00:00.000Z",
    terminalFinishedAt: "2026-01-01T00:00:01.000Z",
    observedProviders: ["provider-a"],
    observedModels: ["model-a"],
    missingProviderIdentity: 0,
    missingModelIdentity: 0,
    errorCodes: [],
    modality,
    ...overrides,
  });
}

const BASE = {
  runId: "run-1",
  planHash: "plan-1",
  runKind: "design_pilot" as const,
  evidenceKind: "mock" as const,
  status: "completed",
  plannedAssignments: 2,
  plannedCandidates: 6,
  plannedTextAssignments: 2,
  plannedSvgAssignments: 0,
  plannedPerFamilyAssignments: 2,
  plannedDifficultyAssignments: { 1: 2, 2: 0, 3: 0 },
  novelty: {
    frozenComplete: true,
    frozenCoverageSatisfied: true,
    cohortComplete: true,
    coverageByFamily: {},
  },
  human: null,
};

describe("P50.1 section 9.1 metrics", () => {
  it("uses the planned denominator, not only attempted candidates", () => {
    const rows = [
      row({
        slotId: "design-text-ranking-01-ai_feedback",
        assignmentId: "design-text-ranking-01",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        firstAttemptVerdict: "rejected",
        finalVerdict: "accepted",
        attemptCount: 2,
        attemptVerdicts: ["rejected", "accepted"],
        firstDiagnosticCode: "MULTIPLE_SOLUTIONS",
        errorCodes: ["MULTIPLE_SOLUTIONS"],
        firstStructuralFingerprint: "f1",
        finalStructuralFingerprint: "f1",
      }),
      row({
        slotId: "design-text-ranking-02-ai_feedback",
        assignmentId: "design-text-ranking-02",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        stage: "planned",
        verdict: null,
        firstAttemptVerdict: null,
        finalVerdict: null,
        attemptCount: 0,
        attemptVerdicts: [],
        firstCostStatus: "none",
        firstCostUsd: "0",
        totalCostStatus: "none",
        totalCostUsd: "0",
        knownAttempts: 0,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
        reasoningTokens: null,
        httpLatencyMs: [],
        logicalLatencyMs: [],
        activeStageMs: null,
        firstStartedAt: null,
        terminalFinishedAt: null,
        observedProviders: [],
        observedModels: [],
        firstNovelty: null,
        finalNovelty: null,
        firstStructuralFingerprint: null,
        finalStructuralFingerprint: null,
      }),
      row({
        slotId: "design-text-ranking-01-ai_one_shot",
        assignmentId: "design-text-ranking-01",
        arm: "ai_one_shot",
        family: "ranking",
        difficulty: 1,
        firstCostUsd: "0.30",
        totalCostUsd: "0.30",
      }),
      row({
        slotId: "design-text-ranking-02-ai_one_shot",
        assignmentId: "design-text-ranking-02",
        arm: "ai_one_shot",
        family: "ranking",
        difficulty: 1,
        finalVerdict: "generation_error",
        firstAttemptVerdict: "generation_error",
        attemptVerdicts: ["generation_error"],
        firstDiagnosticCode: "GENERATION_ERROR",
        finalDiagnosticCode: "GENERATION_ERROR",
        firstCostStatus: "unknown",
        firstCostUsd: null,
        totalCostStatus: "unknown",
        totalCostUsd: null,
        unknownAttempts: 1,
        knownAttempts: 0,
        finalNovelty: null,
        errorCodes: ["GENERATION_ERROR"],
      }),
      row({
        slotId: "design-text-ranking-01-baseline",
        assignmentId: "design-text-ranking-01",
        arm: "baseline",
        family: "ranking",
        difficulty: 1,
        firstCostStatus: "none",
        firstCostUsd: "0",
        totalCostStatus: "none",
        totalCostUsd: "0",
        knownAttempts: 0,
        firstStructuralFingerprint: "baseline",
        finalStructuralFingerprint: "baseline",
        firstNovelty: "baseline_duplicate",
        finalNovelty: "baseline_duplicate",
      }),
      row({
        slotId: "design-text-ranking-02-baseline",
        assignmentId: "design-text-ranking-02",
        arm: "baseline",
        family: "ranking",
        difficulty: 1,
        firstCostStatus: "none",
        firstCostUsd: "0",
        totalCostStatus: "none",
        totalCostUsd: "0",
        knownAttempts: 0,
        firstStructuralFingerprint: "baseline-2",
        finalStructuralFingerprint: "baseline-2",
        firstNovelty: "baseline_duplicate",
        finalNovelty: "baseline_duplicate",
      }),
    ];
    const metrics = computeDesignerCohortMetrics({ ...BASE, rows });
    expect(metrics.arms.ai_feedback.firstAttemptFormalAcceptance).toMatchObject({
      numerator: 0,
      denominator: 2,
      value: 0,
      status: "ok",
    });
    expect(metrics.arms.ai_feedback.finalFormalAcceptance).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(metrics.arms.ai_feedback.repairSuccessRate).toMatchObject({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(metrics.arms.ai_feedback.repairLift).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(metrics.arms.ai_feedback.unstarted).toBe(1);
    expect(metrics.arms.ai_feedback.novelAcceptance).toMatchObject({
      numerator: 1,
      denominator: 2,
    });
    expect(metrics.arms.ai_feedback.novelShare).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
    expect(metrics.arms.ai_one_shot.cost.finalKnownUsd).toBeNull();
    expect(metrics.arms.ai_one_shot.cost.unknownAttempts).toBe(1);
    expect(metrics.arms.baseline.cost.finalKnownUsd).toBe("0.000000");
    expect(metrics.arms.baseline.firstAttemptFormalAcceptance).toMatchObject({
      numerator: 2,
      denominator: 2,
      value: 1,
    });
    expect(metrics.arms.baseline.noveltyUnknown).toBe(0);
    expect(metrics.arms.baseline.baselineDuplicate).toBe(2);
    expect(metrics.arms.ai_feedback.errorCodeDistribution).toEqual({
      MULTIPLE_SOLUTIONS: 1,
    });
    expect(metrics.arms.ai_one_shot.errorCodeDistribution).toEqual({
      GENERATION_ERROR: 1,
    });
    expect(metrics.complete).toBe(false);
  });

  it("returns null for zero denominators and separates repairable failures", () => {
    const rows = [
      row({
        slotId: "design-text-ranking-01-ai_feedback",
        assignmentId: "design-text-ranking-01",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        firstAttemptVerdict: "generation_error",
        finalVerdict: "generation_error",
        attemptVerdicts: ["generation_error"],
        firstDiagnosticCode: "GENERATION_ERROR",
        finalDiagnosticCode: "GENERATION_ERROR",
        finalNovelty: null,
      }),
      row({
        slotId: "design-text-ranking-02-ai_feedback",
        assignmentId: "design-text-ranking-02",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        firstAttemptVerdict: "inconclusive",
        finalVerdict: "inconclusive",
        attemptVerdicts: ["inconclusive"],
        firstDiagnosticCode: "INFRASTRUCTURE_ERROR",
        finalDiagnosticCode: "INFRASTRUCTURE_ERROR",
        finalNovelty: null,
      }),
    ];
    const metrics = computeDesignerCohortMetrics({ ...BASE, rows });
    expect(metrics.arms.ai_feedback.repairSuccessRate).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
      interval: null,
      status: "not_applicable",
    });
    expect(metrics.arms.ai_feedback.novelShare).toMatchObject({
      numerator: 0,
      denominator: 0,
      value: null,
      status: "not_applicable",
    });
    expect(metrics.arms.ai_feedback.structuralDiversity).toMatchObject({
      numerator: 0,
      denominator: 0,
      value: null,
    });
    expect(metrics.arms.ai_feedback.cost.averageFinalAcceptedUsd).toBeNull();
    expect(metrics.arms.ai_feedback.cost.callsPerFinalAccepted).toBeNull();
    expect(metrics.arms.ai_feedback.repairableFirstFailures).toBe(0);
  });

  it("keeps Wilson intervals and nearest-rank p95 deterministic", () => {
    const rows = [
      row({
        slotId: "design-text-ranking-01-ai_feedback",
        assignmentId: "design-text-ranking-01",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        httpLatencyMs: [10, 20, 30, 40],
        logicalLatencyMs: [10, 20, 30, 40],
      }),
      row({
        slotId: "design-text-ranking-02-ai_feedback",
        assignmentId: "design-text-ranking-02",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        httpLatencyMs: [50, 60, 70, 80],
        logicalLatencyMs: [50, 60, 70, 80],
      }),
    ];
    const metrics = computeDesignerCohortMetrics({ ...BASE, rows });
    expect(metrics.arms.ai_feedback.latency.httpP95Ms).toBe(80);
    expect(metrics.arms.ai_feedback.latency.httpMedianMs).toBe(45);
    expect(metrics.arms.ai_feedback.latency.httpMeanMs).toBe(45);
    expect(metrics.arms.ai_feedback.finalFormalAcceptance.interval).toMatchObject({
      method: "wilson95",
    });
    expect(
      metrics.arms.ai_feedback.finalFormalAcceptance.interval?.lower,
    ).toBeLessThan(1);
  });

  it("marks an incomplete run and keeps failure strata visible", () => {
    const rows = [
      row({
        slotId: "design-text-ranking-01-ai_feedback",
        assignmentId: "design-text-ranking-01",
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        stage: "planned",
        verdict: null,
        firstAttemptVerdict: null,
        finalVerdict: null,
        attemptCount: 0,
        attemptVerdicts: [],
        firstCostStatus: "none",
        firstCostUsd: "0",
        totalCostStatus: "none",
        totalCostUsd: "0",
        knownAttempts: 0,
        firstNovelty: null,
        finalNovelty: null,
      }),
    ];
    const metrics = computeDesignerCohortMetrics({
      ...BASE,
      status: "paused_budget",
      rows,
    });
    expect(metrics.complete).toBe(false);
    const stratumRow = metrics.strata.byFamily.find(
      (entry) => entry.key === "ranking",
    );
    expect(stratumRow).toMatchObject({
      planned: 1,
      attempted: 0,
      finalAccepted: 0,
    });
    expect(metrics.failureCodeNote).toContain("may sum above");
  });
});
