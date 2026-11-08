import { z } from "zod";
import { FAMILIES, type Family } from "../domain/experiment.js";
import type { DesignerCohortMetrics } from "./design-metrics.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const DESIGNER_DECISION_VERSION = "p50.2-decision-v1" as const;

export const DESIGNER_DECISION_THRESHOLDS = Object.freeze({
  feedbackFinalAcceptanceOverall: 0.6,
  feedbackFinalAcceptancePerModality: 0.5,
  oneShotFirstAcceptanceOverall: 0.4,
  repairSuccessRate: 0.2,
  repairLift: 0.05,
  feedbackFirstAcceptanceForRepairEvidence: 0.8,
  novelAcceptance: 0.3,
  novelPerFamily: 3,
  distinctNovelStructures: 50,
  costPerNovelAcceptedUsd: 0.5,
  humanCoreInspected: 30,
  humanAiCorePlanned: 20,
  humanClearSolved: 16,
  humanSolveTimeMaxSeconds: 180,
  pairedInterestWinsOrTies: 7,
  pairedClarityWinsOrTies: 8,
  rejectFeedbackFinalOverall: 0.3,
  rejectFeedbackFinalPerModality: 0.25,
  rejectOneShotFirstAcceptance: 20,
  rejectRepairSuccessRate: 0.1,
  rejectCostMultiplier: 2,
  rejectAiGenerationErrors: 100,
  aiFinalCandidates: 200,
});
export type DesignerDecisionThresholds = typeof DESIGNER_DECISION_THRESHOLDS;
export const DesignerDecisionThresholdsSchema = z.strictObject({
  feedbackFinalAcceptanceOverall: z.literal(0.6),
  feedbackFinalAcceptancePerModality: z.literal(0.5),
  oneShotFirstAcceptanceOverall: z.literal(0.4),
  repairSuccessRate: z.literal(0.2),
  repairLift: z.literal(0.05),
  feedbackFirstAcceptanceForRepairEvidence: z.literal(0.8),
  novelAcceptance: z.literal(0.3),
  novelPerFamily: z.number().int().positive(),
  distinctNovelStructures: z.number().int().nonnegative(),
  costPerNovelAcceptedUsd: z.literal(0.5),
  humanCoreInspected: z.number().int().nonnegative(),
  humanAiCorePlanned: z.number().int().nonnegative(),
  humanClearSolved: z.number().int().nonnegative(),
  humanSolveTimeMaxSeconds: z.number().int().positive(),
  pairedInterestWinsOrTies: z.number().int().nonnegative(),
  pairedClarityWinsOrTies: z.number().int().nonnegative(),
  rejectFeedbackFinalOverall: z.literal(0.3),
  rejectFeedbackFinalPerModality: z.literal(0.25),
  rejectOneShotFirstAcceptance: z.number().int().nonnegative(),
  rejectRepairSuccessRate: z.literal(0.1),
  rejectCostMultiplier: z.literal(2),
  rejectAiGenerationErrors: z.number().int().nonnegative(),
  aiFinalCandidates: z.number().int().positive(),
});

export const DesignerHumanEvaluationSummarySchema = z.strictObject({
  synthetic: z.boolean(),
  sampleHash: z.string().nullable(),
  corePlanned: z.number().int().nonnegative(),
  coreInspected: z.number().int().nonnegative(),
  aiCorePlanned: z.number().int().nonnegative(),
  aiCoreClearSolved: z.number().int().nonnegative(),
  correctnessDefects: z.number().int().nonnegative(),
  repeatableFamilyCorrectnessDefect: z.boolean(),
  pairedInterest: z.strictObject({
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
  }),
  pairedClarity: z.strictObject({
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
  }),
});
export type DesignerHumanEvaluationSummary = z.infer<
  typeof DesignerHumanEvaluationSummarySchema
>;

export const DesignerDecisionEvidenceSchema = z.strictObject({
  runId: z.string().min(1),
  planHash: z.string().min(1),
  evidenceKind: z.enum(["mock", "live"]),
  complete: z.boolean(),
  assignmentsPlanned: z.number().int().nonnegative(),
  candidatesPlanned: z.number().int().nonnegative(),
  plannedPerFamily: z.number().int().nonnegative(),
  feedback: z.strictObject({
    planned: z.number().int().nonnegative(),
    finalAccepted: z.number().int().nonnegative(),
    firstAccepted: z.number().int().nonnegative(),
    byModality: z.array(
      z.strictObject({
        modality: z.enum(["text", "svg"]),
        planned: z.number().int().nonnegative(),
        finalAccepted: z.number().int().nonnegative(),
      }),
    ),
    repairableFirstFailures: z.number().int().nonnegative(),
    repairedAccepted: z.number().int().nonnegative(),
    novelAccepted: z.number().int().nonnegative(),
    distinctAcceptedStructures: z.number().int().nonnegative(),
    novelByFamily: z.record(z.enum(FAMILIES), z.number().int().nonnegative()),
    costKnownComplete: z.boolean(),
    finalKnownCostUsd: z.string().nullable(),
    unknownAttempts: z.number().int().nonnegative(),
  }),
  oneShot: z.strictObject({
    planned: z.number().int().nonnegative(),
    firstAccepted: z.number().int().nonnegative(),
  }),
  aiGenerationErrorsFinal: z.number().int().nonnegative(),
  references: z.strictObject({
    frozenComplete: z.boolean(),
    frozenCoverageSatisfied: z.boolean(),
    cohortComplete: z.boolean(),
  }),
  unresolvedInfrastructureDefect: z.boolean(),
  thresholds: DesignerDecisionThresholdsSchema,
});
export type DesignerDecisionEvidence = z.infer<
  typeof DesignerDecisionEvidenceSchema
>;

export const DesignerPredicateStatusSchema = z.enum([
  "pass",
  "fail",
  "not_applicable",
  "incomplete",
]);
export type DesignerPredicateStatus = z.infer<
  typeof DesignerPredicateStatusSchema
>;

export const DesignerDecisionPredicateSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  status: DesignerPredicateStatusSchema,
  observed: z.string().min(1),
  threshold: z.string().min(1),
  details: z.string().nullable(),
});
export type DesignerDecisionPredicate = z.infer<
  typeof DesignerDecisionPredicateSchema
>;

export const DesignerDecisionRecordSchema = z.strictObject({
  version: z.literal(DESIGNER_DECISION_VERSION),
  kind: z.literal("designer_decision"),
  runId: z.string().min(1),
  planHash: z.string().min(1),
  protocolHash: z.string().nullable(),
  evidenceKind: z.enum(["mock", "live"]),
  recommendation: z.enum(["proceed", "revise", "reject"]),
  evaluatedAt: z.iso.datetime(),
  predicates: z.array(DesignerDecisionPredicateSchema),
  failedPredicates: z.array(z.string()),
  caveats: z.array(z.string()),
  strongFailures: z.array(z.string()),
  evidenceStatus: z.strictObject({
    complete: z.boolean(),
    protocolMatch: z.boolean(),
    knownPrimaryCosts: z.boolean(),
    genuineHumanLabels: z.boolean(),
    mockEvidence: z.boolean(),
  }),
  decisionHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignerDecisionRecord = z.infer<
  typeof DesignerDecisionRecordSchema
>;

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentage(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(2)}%`;
}

function predicate(input: {
  readonly id: string;
  readonly description: string;
  readonly status: DesignerPredicateStatus;
  readonly observed: string;
  readonly threshold: string;
  readonly details?: string | null;
}): DesignerDecisionPredicate {
  return {
    id: input.id,
    description: input.description,
    status: input.status,
    observed: input.observed,
    threshold: input.threshold,
    details: input.details ?? null,
  };
}

function compareRatio(input: {
  readonly id: string;
  readonly description: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly threshold: number;
  readonly thresholdLabel: string;
  readonly incomplete?: boolean;
}): DesignerDecisionPredicate {
  if (input.denominator === 0) {
    return predicate({
      id: input.id,
      description: input.description,
      status: "not_applicable",
      observed: "0/0",
      threshold: input.thresholdLabel,
    });
  }
  const value = input.numerator / input.denominator;
  return predicate({
    id: input.id,
    description: input.description,
    status:
      input.incomplete === true
        ? "incomplete"
        : value >= input.threshold
          ? "pass"
          : "fail",
    observed: `${input.numerator}/${input.denominator} (${percentage(value)})`,
    threshold: input.thresholdLabel,
  });
}

export interface DesignerDecisionInput {
  readonly evidence: DesignerDecisionEvidence;
  readonly human: DesignerHumanEvaluationSummary | null;
  readonly protocolHash: string | null;
  readonly protocolMatches: boolean;
  readonly evaluatedAt: string;
  readonly thresholds?: DesignerDecisionThresholds;
}

export function buildDesignerDecisionEvidence(
  metrics: DesignerCohortMetrics,
  options: {
    readonly unresolvedInfrastructureDefect?: boolean;
  } = {},
): DesignerDecisionEvidence {
  const feedback = metrics.arms.ai_feedback;
  const oneShot = metrics.arms.ai_one_shot;
  const novelByFamily = Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      metrics.strata.byFamilyArm.find(
        (row) => row.key === `${family}:ai_feedback`,
      )?.novelAccepted ?? 0,
    ]),
  ) as Record<Family, number>;
  return DesignerDecisionEvidenceSchema.parse({
    runId: metrics.runId,
    planHash: metrics.planHash,
    evidenceKind: metrics.evidenceKind,
    complete: metrics.complete,
    assignmentsPlanned: metrics.planned.assignments,
    candidatesPlanned: metrics.planned.candidates,
    plannedPerFamily: metrics.planned.perFamilyAssignments,
    feedback: {
      planned: feedback.planned,
      finalAccepted: feedback.finalFormalAccepted,
      firstAccepted: feedback.firstAttemptFormalAccepted,
      byModality: (["text", "svg"] as const).map((modality) => {
        const row = metrics.strata.byModality.find(
          (entry) => entry.key === modality,
        );
        return {
          modality,
          planned: row?.planned ?? 0,
          finalAccepted: row?.finalAccepted ?? 0,
        };
      }),
      repairableFirstFailures: feedback.repairableFirstFailures,
      repairedAccepted: feedback.repairedAccepted,
      novelAccepted: feedback.novel,
      distinctAcceptedStructures: feedback.distinctFinalFingerprints,
      novelByFamily,
      costKnownComplete:
        feedback.cost.finalKnownUsd !== null &&
        feedback.cost.unknownAttempts === 0,
      finalKnownCostUsd: feedback.cost.finalKnownUsd,
      unknownAttempts: feedback.cost.unknownAttempts,
    },
    oneShot: {
      planned: oneShot.planned,
      firstAccepted: oneShot.firstAttemptFormalAccepted,
    },
    aiGenerationErrorsFinal:
      oneShot.generationErrors + feedback.generationErrors,
    references: {
      frozenComplete: metrics.novelty.frozenComplete,
      frozenCoverageSatisfied: metrics.novelty.frozenCoverageSatisfied,
      cohortComplete: metrics.novelty.cohortComplete,
    },
    unresolvedInfrastructureDefect:
      options.unresolvedInfrastructureDefect ?? false,
    thresholds: DESIGNER_DECISION_THRESHOLDS,
  });
}

function evaluatePredicates(input: {
  readonly evidence: DesignerDecisionEvidence;
  readonly human: DesignerHumanEvaluationSummary | null;
}): DesignerDecisionPredicate[] {
  const { evidence, human } = input;
  const thresholds = evidence.thresholds;
  const feedback = evidence.feedback;
  const predicates: DesignerDecisionPredicate[] = [];

  predicates.push(
    predicate({
      id: "cohort_completion",
      description:
        "All 100 assignments were attempted in all three arms with 300 candidates and no replacements.",
      status:
        evidence.complete &&
        evidence.assignmentsPlanned === 100 &&
        evidence.candidatesPlanned === 300
          ? "pass"
          : "incomplete",
      observed: `${evidence.complete ? "complete" : "incomplete"}; ${evidence.assignmentsPlanned} assignments, ${evidence.candidatesPlanned} candidates`,
      threshold: "100 assignments / 300 candidates / complete",
    }),
  );

  predicates.push(
    compareRatio({
      id: "feedback_final_acceptance_overall",
      description: "AI feedback final formal acceptance overall.",
      numerator: feedback.finalAccepted,
      denominator: feedback.planned,
      threshold: thresholds.feedbackFinalAcceptanceOverall,
      thresholdLabel: ">= 60%",
      incomplete: !evidence.complete,
    }),
  );

  for (const modality of feedback.byModality) {
    predicates.push(
      compareRatio({
        id: `feedback_final_acceptance_${modality.modality}`,
        description: `AI feedback final formal acceptance in ${modality.modality}.`,
        numerator: modality.finalAccepted,
        denominator: modality.planned,
        threshold: thresholds.feedbackFinalAcceptancePerModality,
        thresholdLabel: ">= 50%",
        incomplete: !evidence.complete,
      }),
    );
  }

  predicates.push(
    compareRatio({
      id: "one_shot_first_acceptance",
      description: "AI one-shot first-attempt formal acceptance overall.",
      numerator: evidence.oneShot.firstAccepted,
      denominator: evidence.oneShot.planned,
      threshold: thresholds.oneShotFirstAcceptanceOverall,
      thresholdLabel: ">= 40%",
      incomplete: !evidence.complete,
    }),
  );

  const repairRate = ratio(
    feedback.repairedAccepted,
    feedback.repairableFirstFailures,
  );
  const firstAcceptance = ratio(
    feedback.firstAccepted,
    feedback.planned,
  );
  if (feedback.repairableFirstFailures === 0) {
    predicates.push(
      predicate({
        id: "repair_capability",
        description:
          "Repair capability: repairs accepted among repairable first failures and final-minus-first lift.",
        status: "not_applicable",
        observed: "0 repairable first failures",
        threshold: ">= 20% repair success and >= 5 percentage-point lift when opportunities exist",
        details:
          firstAcceptance !== null && firstAcceptance >= thresholds.feedbackFirstAcceptanceForRepairEvidence
            ? "Zero repair opportunities; repair evidence is not demonstrated."
            : "Zero repair opportunities.",
      }),
    );
  } else {
    const lift =
      feedback.repairedAccepted / feedback.planned;
    const ratePasses =
      repairRate !== null && repairRate >= thresholds.repairSuccessRate;
    const liftPasses = lift >= thresholds.repairLift;
    const highFirstAcceptance =
      firstAcceptance !== null &&
      firstAcceptance >= thresholds.feedbackFirstAcceptanceForRepairEvidence;
    const finalAtLeastFirst =
      firstAcceptance === null ||
      feedback.finalAccepted / feedback.planned >= firstAcceptance;
    const highFirstPasses =
      !highFirstAcceptance ||
      (finalAtLeastFirst && feedback.repairedAccepted >= 1);
    predicates.push(
      predicate({
        id: "repair_capability",
        description:
          "Repair capability: repairs accepted among repairable first failures and final-minus-first lift.",
        status:
          ratePasses && liftPasses && highFirstPasses
            ? "pass"
            : evidence.complete
              ? "fail"
              : "incomplete",
        observed: `${feedback.repairedAccepted}/${feedback.repairableFirstFailures} repaired (${percentage(repairRate)}); lift ${percentage(lift)}`,
        threshold: ">= 20% repair success and >= 5 percentage-point lift",
        details: highFirstAcceptance
          ? "Feedback first acceptance is >= 80%; final must not regress and at least one repair must succeed when opportunities exist."
          : null,
      }),
    );
  }

  predicates.push(
    compareRatio({
      id: "novelty_overall",
      description: "AI feedback novel final accepted candidates.",
      numerator: feedback.novelAccepted,
      denominator: feedback.planned,
      threshold: thresholds.novelAcceptance,
      thresholdLabel: ">= 30%",
      incomplete: !evidence.complete,
    }),
  );

  const familyShortfalls = FAMILIES.filter(
    (family) =>
      (feedback.novelByFamily[family] ?? 0) < thresholds.novelPerFamily,
  );
  predicates.push(
    predicate({
      id: "novelty_per_family",
      description: "At least three novel final accepted candidates per family.",
      status:
        familyShortfalls.length === 0
          ? "pass"
          : evidence.complete
            ? "fail"
            : "incomplete",
      observed:
        familyShortfalls.length === 0
          ? "all families >= 3"
          : familyShortfalls
              .map(
                (family) =>
                  `${family}=${feedback.novelByFamily[family] ?? 0}`,
              )
              .join(", "),
      threshold: ">= 3 novel final accepted per family",
    }),
  );

  predicates.push(
    predicate({
      id: "novelty_distinct_structures",
      description: "Distinct accepted final structures in the feedback arm.",
      status:
        feedback.distinctAcceptedStructures >= thresholds.distinctNovelStructures
          ? "pass"
          : evidence.complete
            ? "fail"
            : "incomplete",
      observed: String(feedback.distinctAcceptedStructures),
      threshold: `>= ${thresholds.distinctNovelStructures}`,
    }),
  );

  predicates.push(
    predicate({
      id: "reference_coverage",
      description:
        "Complete frozen and cohort reference coverage for novelty annotation.",
      status:
        evidence.references.frozenComplete &&
        evidence.references.frozenCoverageSatisfied &&
        evidence.references.cohortComplete
          ? "pass"
          : "incomplete",
      observed: JSON.stringify(evidence.references),
      threshold: "complete frozen/cohort reference coverage",
    }),
  );

  const costPerNovel =
    feedback.costKnownComplete &&
    feedback.finalKnownCostUsd !== null &&
    feedback.novelAccepted > 0
      ? Number(feedback.finalKnownCostUsd) / feedback.novelAccepted
      : null;
  predicates.push(
    predicate({
      id: "cost_per_novel",
      description:
        "Known complete feedback total cost divided by feedback novel final accepted.",
      status:
        costPerNovel === null
          ? "incomplete"
          : costPerNovel <= thresholds.costPerNovelAcceptedUsd
            ? "pass"
            : "fail",
      observed:
        costPerNovel === null
          ? "cost or novel denominator unavailable"
          : `USD ${costPerNovel.toFixed(6)} per novel accepted`,
      threshold: `<= USD ${thresholds.costPerNovelAcceptedUsd.toFixed(2)}`,
    }),
  );

  predicates.push(
    predicate({
      id: "human_correctness",
      description:
        "Thirty core candidates inspected with no unresolved correctness, ambiguity, or legibility defect.",
      status:
        human === null
          ? "incomplete"
          : human.synthetic
            ? "incomplete"
            : human.coreInspected < thresholds.humanCoreInspected
              ? "incomplete"
              : human.correctnessDefects > 0
                ? "fail"
                : "pass",
      observed:
        human === null
          ? "no human evaluation"
          : `${human.coreInspected}/${human.corePlanned} inspected; ${human.correctnessDefects} defects`,
      threshold: "30/30 inspected; 0 unresolved defects",
      details: human?.synthetic === true ? "Synthetic labels are test-only." : null,
    }),
  );

  predicates.push(
    predicate({
      id: "human_clarity_time",
      description:
        "At least 16 of 20 planned core AI members are clear (4-5/5) and solved within 180 seconds.",
      status:
        human === null || human.synthetic || human.coreInspected === 0
          ? "incomplete"
          : human.aiCoreClearSolved >= thresholds.humanClearSolved
            ? "pass"
            : "fail",
      observed:
        human === null
          ? "no human evaluation"
          : `${human.aiCoreClearSolved}/${human.aiCorePlanned} clear and solved within ${thresholds.humanSolveTimeMaxSeconds}s`,
      threshold: `>= ${thresholds.humanClearSolved}/${thresholds.humanAiCorePlanned}`,
      details: human?.synthetic === true ? "Synthetic labels are test-only." : null,
    }),
  );

  predicates.push(
    predicate({
      id: "paired_interest",
      description:
        "AI feedback wins or ties at least seven of ten interest comparisons against baseline.",
      status:
        human === null || human.synthetic || human.coreInspected === 0
          ? "incomplete"
          : human.pairedInterest.wins + human.pairedInterest.ties >=
              thresholds.pairedInterestWinsOrTies
            ? "pass"
            : "fail",
      observed:
        human === null
          ? "no human evaluation"
          : `${human.pairedInterest.wins + human.pairedInterest.ties}/${human.pairedInterest.denominator} wins or ties`,
      threshold: `>= ${thresholds.pairedInterestWinsOrTies}/10`,
      details: human?.synthetic === true ? "Synthetic labels are test-only." : null,
    }),
  );

  predicates.push(
    predicate({
      id: "paired_clarity",
      description:
        "AI feedback wins or ties at least eight of ten clarity comparisons against baseline.",
      status:
        human === null || human.synthetic || human.coreInspected === 0
          ? "incomplete"
          : human.pairedClarity.wins + human.pairedClarity.ties >=
              thresholds.pairedClarityWinsOrTies
            ? "pass"
            : "fail",
      observed:
        human === null
          ? "no human evaluation"
          : `${human.pairedClarity.wins + human.pairedClarity.ties}/${human.pairedClarity.denominator} wins or ties`,
      threshold: `>= ${thresholds.pairedClarityWinsOrTies}/10`,
      details: human?.synthetic === true ? "Synthetic labels are test-only." : null,
    }),
  );

  return predicates;
}

function strongFailures(input: {
  readonly evidence: DesignerDecisionEvidence;
  readonly human: DesignerHumanEvaluationSummary | null;
}): string[] {
  const { evidence, human } = input;
  const thresholds = evidence.thresholds;
  const failures: string[] = [];
  const feedbackRate = ratio(
    evidence.feedback.finalAccepted,
    evidence.feedback.planned,
  );
  if (
    feedbackRate !== null &&
    feedbackRate < thresholds.rejectFeedbackFinalOverall
  ) {
    failures.push("feedback_final_acceptance_below_30_percent");
  }
  for (const modality of evidence.feedback.byModality) {
    const rate = ratio(modality.finalAccepted, modality.planned);
    if (
      rate !== null &&
      rate < thresholds.rejectFeedbackFinalPerModality
    ) {
      failures.push(`feedback_final_acceptance_${modality.modality}_below_25_percent`);
    }
  }
  const repairRate = ratio(
    evidence.feedback.repairedAccepted,
    evidence.feedback.repairableFirstFailures,
  );
  if (
    evidence.oneShot.firstAccepted < thresholds.rejectOneShotFirstAcceptance &&
    evidence.feedback.repairableFirstFailures > 0 &&
    repairRate !== null &&
    repairRate < thresholds.rejectRepairSuccessRate
  ) {
    failures.push("one_shot_first_and_repair_success_below_thresholds");
  }
  if (human?.repeatableFamilyCorrectnessDefect === true) {
    failures.push("repeatable_family_correctness_defect");
  }
  if (
    evidence.feedback.costKnownComplete &&
    evidence.feedback.finalKnownCostUsd !== null &&
    evidence.feedback.novelAccepted > 0
  ) {
    const costPerNovel =
      Number(evidence.feedback.finalKnownCostUsd) /
      evidence.feedback.novelAccepted;
    if (
      costPerNovel >
      thresholds.costPerNovelAcceptedUsd * thresholds.rejectCostMultiplier
    ) {
      failures.push("feedback_cost_per_novel_above_2x_threshold");
    }
  }
  if (
    evidence.aiGenerationErrorsFinal > thresholds.rejectAiGenerationErrors
  ) {
    failures.push("ai_generation_errors_above_100_of_200");
  }
  return failures;
}

export function evaluateDesignerDecision(
  input: DesignerDecisionInput,
): DesignerDecisionRecord {
  const evidence = DesignerDecisionEvidenceSchema.parse(input.evidence);
  const human =
    input.human === null
      ? null
      : DesignerHumanEvaluationSummarySchema.parse(input.human);
  const thresholds = input.thresholds ?? evidence.thresholds;
  if (canonicalJson(thresholds) !== canonicalJson(DESIGNER_DECISION_THRESHOLDS)) {
    throw new Error(
      "designer decision thresholds differ from the frozen constants; a new protocol revision is required",
    );
  }
  const predicates = evaluatePredicates({ evidence, human });
  const failedPredicates = predicates
    .filter((entry) => entry.status === "fail")
    .map((entry) => entry.id);
  const incompletePredicates = predicates
    .filter((entry) => entry.status === "incomplete")
    .map((entry) => entry.id);
  const caveats: string[] = [];
  if (incompletePredicates.length > 0) {
    caveats.push(
      `Incomplete predicates: ${incompletePredicates.join(", ")}.`,
    );
  }
  if (!input.protocolMatches) {
    caveats.push("Frozen protocol hash does not match the current implementation.");
  }
  if (!evidence.complete) {
    caveats.push("The cohort or evidence is incomplete.");
  }
  if (evidence.evidenceKind !== "live") {
    caveats.push("Mock evidence is synthetic and cannot satisfy live decision gates.");
  }
  if (evidence.unresolvedInfrastructureDefect) {
    caveats.push("An unresolved infrastructure or safety defect is recorded.");
  }
  if (!evidence.feedback.costKnownComplete) {
    caveats.push("Primary AI costs are unknown or incomplete.");
  }
  if (human === null) {
    caveats.push("No human evaluation evidence is available.");
  } else if (human.synthetic) {
    caveats.push("Human labels are synthetic test evidence only.");
  }
  const strong = strongFailures({ evidence, human });

  const hardEvidenceFailure =
    evidence.evidenceKind !== "live" ||
    !evidence.complete ||
    !input.protocolMatches ||
    evidence.unresolvedInfrastructureDefect ||
    !evidence.feedback.costKnownComplete;

  let recommendation: DesignerDecisionRecord["recommendation"];
  if (hardEvidenceFailure) {
    recommendation = "revise";
  } else if (strong.length > 0) {
    recommendation = "reject";
  } else if (
    predicates.every(
      (entry) =>
        entry.status === "pass" ||
        (entry.id === "repair_capability" &&
          entry.status === "not_applicable"),
    )
  ) {
    recommendation = "proceed";
  } else {
    recommendation = "revise";
  }

  if (recommendation === "proceed") {
    caveats.push(
      "Proceed means viable for this bounded ten-family PoC, not arbitrary puzzle invention or a causal diagnostics advantage.",
    );
  }
  const body = {
    version: DESIGNER_DECISION_VERSION,
    kind: "designer_decision" as const,
    runId: evidence.runId,
    planHash: evidence.planHash,
    protocolHash: input.protocolHash,
    evidenceKind: evidence.evidenceKind,
    recommendation,
    evaluatedAt: input.evaluatedAt,
    predicates,
    failedPredicates,
    caveats,
    strongFailures: strong,
    evidenceStatus: {
      complete: evidence.complete,
      protocolMatch: input.protocolMatches,
      knownPrimaryCosts: evidence.feedback.costKnownComplete,
      genuineHumanLabels:
        human !== null && !human.synthetic && human.coreInspected > 0,
      mockEvidence: evidence.evidenceKind !== "live",
    },
  };
  return DesignerDecisionRecordSchema.parse({
    ...body,
    decisionHash: sha256Hex(canonicalJson(body)),
  });
}
