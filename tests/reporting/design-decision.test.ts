import { describe, expect, it } from "vitest";
import {
  DESIGNER_DECISION_THRESHOLDS,
  evaluateDesignerDecision,
  type DesignerDecisionEvidence,
  type DesignerHumanEvaluationSummary,
} from "../../src/reporting/design-decision.js";
import { FAMILIES } from "../../src/domain/experiment.js";

function evidence(
  overrides: Partial<DesignerDecisionEvidence> = {},
): DesignerDecisionEvidence {
  const base: DesignerDecisionEvidence = {
    runId: "run-1",
    planHash: "plan-1",
    evidenceKind: "live",
    complete: true,
    assignmentsPlanned: 100,
    candidatesPlanned: 300,
    plannedPerFamily: 10,
    feedback: {
      planned: 100,
      finalAccepted: 60,
      firstAccepted: 50,
      byModality: [
        { modality: "text", planned: 50, finalAccepted: 25 },
        { modality: "svg", planned: 50, finalAccepted: 35 },
      ],
      repairableFirstFailures: 20,
      repairedAccepted: 10,
      novelAccepted: 30,
      distinctAcceptedStructures: 50,
      novelByFamily: Object.fromEntries(
        FAMILIES.map((family) => [family, 3]),
      ) as Record<(typeof FAMILIES)[number], number>,
      costKnownComplete: true,
      finalKnownCostUsd: "15.00",
      unknownAttempts: 0,
    },
    oneShot: { planned: 100, firstAccepted: 40 },
    aiGenerationErrorsFinal: 0,
    references: {
      frozenComplete: true,
      frozenCoverageSatisfied: true,
      cohortComplete: true,
    },
    unresolvedInfrastructureDefect: false,
    thresholds: DESIGNER_DECISION_THRESHOLDS,
  };
  return { ...base, ...overrides };
}

function human(
  overrides: Partial<DesignerHumanEvaluationSummary> = {},
): DesignerHumanEvaluationSummary {
  return {
    synthetic: false,
    sampleHash: "sample-hash",
    corePlanned: 30,
    coreInspected: 30,
    aiCorePlanned: 20,
    aiCoreClearSolved: 16,
    correctnessDefects: 0,
    repeatableFamilyCorrectnessDefect: false,
    pairedInterest: { wins: 4, ties: 3, losses: 3, denominator: 10 },
    pairedClarity: { wins: 5, ties: 3, losses: 2, denominator: 10 },
    ...overrides,
  };
}

function decide(
  overrides: Partial<DesignerDecisionEvidence> = {},
  humanOverrides: Partial<DesignerHumanEvaluationSummary> = {},
  options: {
    readonly protocolMatches?: boolean;
    readonly human?: DesignerHumanEvaluationSummary | null;
  } = {},
) {
  return evaluateDesignerDecision({
    evidence: evidence(overrides),
    human:
      options.human === undefined ? human(humanOverrides) : options.human,
    protocolHash: "a".repeat(64),
    protocolMatches: options.protocolMatches ?? true,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("P50.2 designer decision rules", () => {
  it("proceeds at every exact threshold boundary", () => {
    const decision = decide();
    expect(decision.recommendation).toBe("proceed");
    expect(decision.failedPredicates).toEqual([]);
    expect(decision.evidenceStatus).toEqual({
      complete: true,
      protocolMatch: true,
      knownPrimaryCosts: true,
      genuineHumanLabels: true,
      mockEvidence: false,
    });
  });

  it("revises at one step below proceed thresholds", () => {
    const cases: Array<Partial<DesignerDecisionEvidence>> = [
      {
        feedback: {
          ...evidence().feedback,
          finalAccepted: 59,
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          byModality: [
            { modality: "text", planned: 50, finalAccepted: 24 },
            { modality: "svg", planned: 50, finalAccepted: 35 },
          ],
        },
      },
      { oneShot: { planned: 100, firstAccepted: 39 } },
      {
        feedback: {
          ...evidence().feedback,
          repairedAccepted: 3,
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          repairableFirstFailures: 100,
          repairedAccepted: 4,
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          novelAccepted: 29,
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          novelByFamily: {
            ...evidence().feedback.novelByFamily,
            ranking: 2,
          },
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          distinctAcceptedStructures: 49,
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          finalKnownCostUsd: "15.01",
        },
      },
    ];
    for (const override of cases) {
      const decision = decide(override);
      expect(decision.recommendation).not.toBe("proceed");
      expect(decision.recommendation).toBe("revise");
    }
  });

  it("revises human-evaluation shortfalls and synthetic labels", () => {
    for (const humanOverride of [
      { aiCoreClearSolved: 15 },
      { coreInspected: 29 },
      { correctnessDefects: 1 },
      { pairedInterest: { wins: 3, ties: 3, losses: 4, denominator: 10 } },
      { pairedClarity: { wins: 4, ties: 3, losses: 3, denominator: 10 } },
      { synthetic: true },
    ]) {
      const decision = decide({}, humanOverride);
      expect(decision.recommendation).toBe("revise");
    }
  });

  it("uses revise precedence for incomplete, mock, mismatched, unknown-cost, or infrastructure evidence", () => {
    expect(
      decide({ complete: false, feedback: { ...evidence().feedback, finalAccepted: 10 } })
        .recommendation,
    ).toBe("revise");
    expect(decide({ evidenceKind: "mock" }).recommendation).toBe("revise");
    expect(
      decide({}, {}, { protocolMatches: false }).recommendation,
    ).toBe("revise");
    expect(
      decide({
        feedback: {
          ...evidence().feedback,
          costKnownComplete: false,
          finalKnownCostUsd: null,
          unknownAttempts: 1,
        },
      }).recommendation,
    ).toBe("revise");
    expect(
      decide({ unresolvedInfrastructureDefect: true }).recommendation,
    ).toBe("revise");
    expect(decide({}, {}, { human: null }).recommendation).toBe("revise");
    expect(
      decide(
        { feedback: { ...evidence().feedback, finalAccepted: 29 } },
        {},
        { human: null },
      ).recommendation,
    ).toBe("reject");
  });

  it("rejects complete runs with strong failures", () => {
    const cases: Array<Partial<DesignerDecisionEvidence>> = [
      {
        feedback: {
          ...evidence().feedback,
          finalAccepted: 29,
        },
      },
      {
        feedback: {
          ...evidence().feedback,
          byModality: [
            { modality: "text", planned: 50, finalAccepted: 12 },
            { modality: "svg", planned: 50, finalAccepted: 48 },
          ],
        },
      },
      {
        oneShot: { planned: 100, firstAccepted: 19 },
        feedback: {
          ...evidence().feedback,
          repairableFirstFailures: 100,
          repairedAccepted: 9,
        },
      },
      { aiGenerationErrorsFinal: 101 },
      {
        feedback: {
          ...evidence().feedback,
          finalKnownCostUsd: "30.01",
        },
      },
    ];
    for (const override of cases) {
      const decision = decide(override);
      expect(decision.recommendation).toBe("reject");
      expect(decision.strongFailures.length).toBeGreaterThan(0);
    }
    expect(
      decide({}, { repeatableFamilyCorrectnessDefect: true }).recommendation,
    ).toBe("reject");
  });

  it("does not reject at the exact strong-failure boundaries", () => {
    expect(
      decide({ feedback: { ...evidence().feedback, finalAccepted: 30 } })
        .recommendation,
    ).toBe("revise");
    expect(
      decide({
        oneShot: { planned: 100, firstAccepted: 20 },
        feedback: {
          ...evidence().feedback,
          repairableFirstFailures: 100,
          repairedAccepted: 10,
        },
      }).recommendation,
    ).not.toBe("reject");
    expect(decide({ aiGenerationErrorsFinal: 100 }).recommendation).not.toBe(
      "reject",
    );
    expect(
      decide({
        feedback: { ...evidence().feedback, finalKnownCostUsd: "30.00" },
      }).recommendation,
    ).not.toBe("reject");
  });
});
