import { z } from "zod";
import { ChoiceLabelSchema } from "../domain/answers.js";
import {
  FailureRecordSchema,
  RunControlStateSchema,
  type FailureCode,
  type FailureRecord,
} from "../domain/candidate.js";
import {
  FamilySchema,
  ModalitySchema,
  MODALITY_BY_FAMILY,
  SLOT_ID_PATTERN,
} from "../domain/experiment.js";

export const PRIMARY_VERDICT_INPUT_VERSION = 1 as const;

export const PREPARATION_STATES = [
  "not_started",
  "in_progress",
  "paused",
  "ready",
  "failed",
] as const;
export type PreparationState = (typeof PREPARATION_STATES)[number];
export const PreparationStateSchema = z.enum(PREPARATION_STATES);

export const GENERATION_STATES = [
  "usable",
  "refused",
  "malformed",
  "out_of_family",
  "construction_failed",
  "uncertain",
  "api_error",
] as const;
export type GenerationState = (typeof GENERATION_STATES)[number];
export const GenerationStateSchema = z.enum(GENERATION_STATES);

export const DUPLICATE_VERDICT_STATES = [
  "owner",
  "unique",
  "exact_duplicate",
  "spec_duplicate",
  "structural_duplicate",
  "near_suspected",
] as const;
export type DuplicateVerdictState = (typeof DUPLICATE_VERDICT_STATES)[number];
export const DuplicateVerdictStateSchema = z.enum(DUPLICATE_VERDICT_STATES);

const BlindEvidenceSchema = z
  .strictObject({
    required: z.boolean(),
    completed: z.boolean(),
    answerStatus: z
      .enum(["selected", "no_unique_answer", "cannot_determine"])
      .nullable(),
    chosenOption: ChoiceLabelSchema.nullable(),
    expectedOption: ChoiceLabelSchema.nullable(),
    clarity: z.enum(["clear", "unclear"]).nullable(),
    ambiguity: z.enum(["none", "present", "uncertain"]).nullable(),
    issues: z.number().int().nonnegative(),
    visualLegibility: z
      .enum(["legible", "unclear", "not_applicable"])
      .nullable(),
  })
  .superRefine((blind, ctx) => {
    if (!blind.completed) {
      if (
        blind.answerStatus !== null ||
        blind.chosenOption !== null ||
        blind.expectedOption !== null ||
        blind.clarity !== null ||
        blind.ambiguity !== null ||
        blind.visualLegibility !== null ||
        blind.issues !== 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["completed"],
          message: "an incomplete review carries no result fields",
        });
      }
      return;
    }
    if (blind.answerStatus === null) {
      ctx.addIssue({
        code: "custom",
        path: ["answerStatus"],
        message: "a completed review requires an answer status",
      });
    }
    if (blind.expectedOption === null) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedOption"],
        message: "a completed review requires the code key label",
      });
    }
    if (blind.clarity === null || blind.ambiguity === null) {
      ctx.addIssue({
        code: "custom",
        path: ["clarity"],
        message: "a completed review requires clarity and ambiguity",
      });
    }
    if (blind.answerStatus === "selected" && blind.chosenOption === null) {
      ctx.addIssue({
        code: "custom",
        path: ["chosenOption"],
        message: "selected requires a chosen option",
      });
    }
    if (blind.answerStatus !== "selected" && blind.chosenOption !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["chosenOption"],
        message: "a non-selected status requires null chosenOption",
      });
    }
  });

export type BlindEvidence = z.infer<typeof BlindEvidenceSchema>;

const AlignmentEvidenceSchema = z
  .strictObject({
    required: z.boolean(),
    completed: z.boolean(),
    derivedOverall: z.enum(["pass", "fail", "uncertain"]).nullable(),
  })
  .superRefine((alignment, ctx) => {
    if (alignment.completed && alignment.derivedOverall === null) {
      ctx.addIssue({
        code: "custom",
        path: ["derivedOverall"],
        message: "a completed alignment review requires a derived overall",
      });
    }
    if (!alignment.completed && alignment.derivedOverall !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["derivedOverall"],
        message: "an incomplete alignment review carries no derived overall",
      });
    }
  });

export type AlignmentEvidence = z.infer<typeof AlignmentEvidenceSchema>;

export const PrimaryVerdictInputSchema = z
  .strictObject({
    version: z.literal(PRIMARY_VERDICT_INPUT_VERSION),
    slotId: z.string().regex(SLOT_ID_PATTERN),
    family: FamilySchema,
    modality: ModalitySchema,
    runControl: RunControlStateSchema,
    preparation: PreparationStateSchema,
    generation: z.strictObject({
      state: GenerationStateSchema,
    }),
    formalPassed: z.boolean(),
    presentationPassed: z.boolean(),
    duplicate: z
      .strictObject({
        outcome: DuplicateVerdictStateSchema,
        ownerSlotId: z.string().regex(SLOT_ID_PATTERN).nullable(),
        nearPairSlotIds: z.array(z.string().regex(SLOT_ID_PATTERN)),
      })
      .superRefine((duplicate, ctx) => {
        if (
          duplicate.outcome === "exact_duplicate" ||
          duplicate.outcome === "spec_duplicate" ||
          duplicate.outcome === "structural_duplicate"
        ) {
          if (duplicate.ownerSlotId === null) {
            ctx.addIssue({
              code: "custom",
              path: ["ownerSlotId"],
              message: "a duplicate must name its owner",
            });
          }
          if (duplicate.nearPairSlotIds.length > 0) {
            ctx.addIssue({
              code: "custom",
              path: ["nearPairSlotIds"],
              message: "a duplicate cannot carry near-pair flags",
            });
          }
          return;
        }
        if (duplicate.outcome === "near_suspected") {
          if (duplicate.ownerSlotId !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["ownerSlotId"],
              message: "a near-suspected candidate has no duplicate owner",
            });
          }
          if (duplicate.nearPairSlotIds.length === 0) {
            ctx.addIssue({
              code: "custom",
              path: ["nearPairSlotIds"],
              message: "a near-suspected candidate must name a pair",
            });
          }
          return;
        }
        if (
          duplicate.ownerSlotId !== null ||
          duplicate.nearPairSlotIds.length > 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["outcome"],
            message: "owner and unique outcomes carry no duplicate flags",
          });
        }
      }),
    blind: BlindEvidenceSchema,
    alignment: AlignmentEvidenceSchema,
    costStatus: z.enum(["known", "unknown", "not_applicable"]),
    failures: z.array(FailureRecordSchema).max(64),
  })
  .superRefine((input, ctx) => {
    if (input.modality !== MODALITY_BY_FAMILY[input.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["modality"],
        message: "modality must match the family",
      });
    }
    const hasCostUnknown = input.failures.some(
      (failure) => failure.code === "COST_UNKNOWN",
    );
    if ((input.costStatus === "unknown") !== hasCostUnknown) {
      ctx.addIssue({
        code: "custom",
        path: ["failures"],
        message:
          "COST_UNKNOWN must be present exactly when costStatus is unknown",
      });
    }
    if (input.blind.completed && input.modality === "text" && input.blind.visualLegibility !== "not_applicable") {
      ctx.addIssue({
        code: "custom",
        path: ["blind", "visualLegibility"],
        message: "text blind review requires not_applicable legibility",
      });
    }
    if (
      input.blind.completed &&
      input.modality === "svg" &&
      (input.blind.visualLegibility !== "legible" &&
        input.blind.visualLegibility !== "unclear")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["blind", "visualLegibility"],
        message: "svg blind review requires legible or unclear legibility",
      });
    }
  });

export type PrimaryVerdictInput = z.infer<typeof PrimaryVerdictInputSchema>;

export type FailureClass =
  | "generation_error"
  | "rejected"
  | "inconclusive"
  | "business";

const BASE_FAILURE_CLASS_BY_CODE: Readonly<Record<FailureCode, FailureClass>> = {
  SCHEMA_INVALID: "generation_error",
  UNSAT: "rejected",
  MULTIPLE_SOLUTIONS: "rejected",
  MULTIPLE_ANSWERS: "rejected",
  SOLVER_LIMIT: "inconclusive",
  DUPLICATE_OPTION: "rejected",
  EXACT_DUPLICATE: "rejected",
  STRUCTURAL_DUPLICATE: "rejected",
  NEAR_DUPLICATE_SUSPECTED: "inconclusive",
  TEXT_SPEC_MISMATCH: "inconclusive",
  EXPLANATION_MISMATCH: "inconclusive",
  REVIEWER_DISAGREES: "inconclusive",
  REVIEWER_CANNOT_SOLVE: "inconclusive",
  VISION_REVIEW_UNCERTAIN: "inconclusive",
  MISSING_REVIEW: "inconclusive",
  SVG_RENDER_INVALID: "rejected",
  VISUAL_AMBIGUITY: "inconclusive",
  COST_UNKNOWN: "business",
  API_ERROR: "generation_error",
};

const REVIEW_FAILURE_STAGES: ReadonlySet<FailureRecord["stage"]> = new Set([
  "blind_reviewed",
  "alignment_reviewed",
]);

export function failureClass(failure: FailureRecord): FailureClass {
  if (
    (failure.code === "TEXT_SPEC_MISMATCH" ||
      failure.code === "EXPLANATION_MISMATCH") &&
    failure.source === "deterministic"
  ) {
    return "rejected";
  }
  if (
    (failure.code === "API_ERROR" || failure.code === "SCHEMA_INVALID") &&
    REVIEW_FAILURE_STAGES.has(failure.stage)
  ) {
    return "inconclusive";
  }
  return BASE_FAILURE_CLASS_BY_CODE[failure.code];
}

const GENERATION_PRECEDENCE: readonly FailureCode[] = [
  "API_ERROR",
  "SCHEMA_INVALID",
];
const REJECTED_PRECEDENCE: readonly FailureCode[] = [
  "UNSAT",
  "MULTIPLE_SOLUTIONS",
  "MULTIPLE_ANSWERS",
  "DUPLICATE_OPTION",
  "SVG_RENDER_INVALID",
  "EXACT_DUPLICATE",
  "STRUCTURAL_DUPLICATE",
  "TEXT_SPEC_MISMATCH",
  "EXPLANATION_MISMATCH",
];
const INCONCLUSIVE_PRECEDENCE: readonly FailureCode[] = [
  "REVIEWER_DISAGREES",
  "REVIEWER_CANNOT_SOLVE",
  "VISION_REVIEW_UNCERTAIN",
  "MISSING_REVIEW",
  "NEAR_DUPLICATE_SUSPECTED",
  "SOLVER_LIMIT",
  "TEXT_SPEC_MISMATCH",
  "EXPLANATION_MISMATCH",
  "VISUAL_AMBIGUITY",
  "API_ERROR",
  "SCHEMA_INVALID",
];

function derivedFailure(
  code: FailureCode,
  stage: FailureRecord["stage"],
  severity: FailureRecord["severity"],
  source: FailureRecord["source"],
  evidence: string,
): FailureRecord {
  return { code, stage, severity, source, evidence };
}

function addFailure(
  failures: FailureRecord[],
  failure: FailureRecord,
): void {
  if (!failures.some((candidate) => candidate.code === failure.code)) {
    failures.push(failure);
  }
}

function pickPrimary(
  failures: readonly FailureRecord[],
  precedence: readonly FailureCode[],
  category: FailureClass,
): FailureCode | null {
  for (const code of precedence) {
    if (
      failures.some(
        (failure) => failure.code === code && failureClass(failure) === category,
      )
    ) {
      return code;
    }
  }
  return null;
}

function isDuplicateOutcome(
  outcome: DuplicateVerdictState,
): outcome is "exact_duplicate" | "spec_duplicate" | "structural_duplicate" {
  return (
    outcome === "exact_duplicate" ||
    outcome === "spec_duplicate" ||
    outcome === "structural_duplicate"
  );
}

function duplicateFailureCode(outcome: DuplicateVerdictState): FailureCode {
  return outcome === "structural_duplicate"
    ? "STRUCTURAL_DUPLICATE"
    : "EXACT_DUPLICATE";
}

function derivedBlindFailures(
  input: PrimaryVerdictInput,
  failures: FailureRecord[],
): void {
  if (!input.blind.completed) {
    if (input.blind.required) {
      addFailure(
        failures,
        derivedFailure(
          "MISSING_REVIEW",
          "blind_reviewed",
          "high",
          "model",
          "blind review is required but missing",
        ),
      );
    }
    return;
  }
  if (input.blind.answerStatus !== "selected") {
    addFailure(
      failures,
      derivedFailure(
        "REVIEWER_CANNOT_SOLVE",
        "blind_reviewed",
        "high",
        "model",
        "blind reviewer could not select a unique answer",
      ),
    );
  } else if (input.blind.chosenOption !== input.blind.expectedOption) {
    addFailure(
      failures,
      derivedFailure(
        "REVIEWER_DISAGREES",
        "blind_reviewed",
        "high",
        "model",
        "blind reviewer selected a different option than the code key",
      ),
    );
  }
  if (
    input.blind.clarity !== "clear" ||
    input.blind.ambiguity !== "none" ||
    input.blind.issues > 0
  ) {
    addFailure(
      failures,
      derivedFailure(
        input.modality === "svg" ? "VISUAL_AMBIGUITY" : "TEXT_SPEC_MISMATCH",
        "blind_reviewed",
        "medium",
        "model",
        "blind reviewer reported clarity, ambiguity, or issue evidence",
      ),
    );
  }
  if (input.modality === "svg" && input.blind.visualLegibility === "unclear") {
    addFailure(
      failures,
      derivedFailure(
        "VISION_REVIEW_UNCERTAIN",
        "blind_reviewed",
        "medium",
        "model",
        "blind vision reviewer reported unclear legibility",
      ),
    );
  }
}

function derivedAlignmentFailures(
  input: PrimaryVerdictInput,
  failures: FailureRecord[],
): void {
  if (!input.alignment.completed) {
    if (input.alignment.required) {
      addFailure(
        failures,
        derivedFailure(
          "MISSING_REVIEW",
          "alignment_reviewed",
          "high",
          "model",
          "alignment review is required but missing",
        ),
      );
    }
    return;
  }
  if (input.alignment.derivedOverall !== "pass") {
    addFailure(
      failures,
      derivedFailure(
        input.modality === "svg" ? "VISUAL_AMBIGUITY" : "TEXT_SPEC_MISMATCH",
        "alignment_reviewed",
        "medium",
        "model",
        "alignment reviewer did not pass every applicable field",
      ),
    );
  }
}

function approvedByEvidence(input: PrimaryVerdictInput): boolean {
  if (input.preparation !== "ready") {
    return false;
  }
  if (input.generation.state !== "usable") {
    return false;
  }
  if (!input.formalPassed || !input.presentationPassed) {
    return false;
  }
  if (input.duplicate.outcome !== "owner" && input.duplicate.outcome !== "unique") {
    return false;
  }
  if (input.blind.completed) {
    if (
      input.blind.answerStatus !== "selected" ||
      input.blind.chosenOption !== input.blind.expectedOption ||
      input.blind.clarity !== "clear" ||
      input.blind.ambiguity !== "none" ||
      input.blind.issues !== 0
    ) {
      return false;
    }
    if (
      input.modality === "text"
        ? input.blind.visualLegibility !== "not_applicable"
        : input.blind.visualLegibility !== "legible"
    ) {
      return false;
    }
  } else if (input.blind.required) {
    return false;
  }
  if (input.alignment.completed) {
    if (input.alignment.derivedOverall !== "pass") {
      return false;
    }
  } else if (input.alignment.required) {
    return false;
  }
  return true;
}

export const PrimaryVerdictResultSchema = z.strictObject({
  verdict: z.enum(["approved", "rejected", "inconclusive", "generation_error"]).nullable(),
  completion: z.enum(["complete", "incomplete"]),
  proceed: z.boolean(),
  primaryFailure: z.enum([
    "SCHEMA_INVALID",
    "UNSAT",
    "MULTIPLE_SOLUTIONS",
    "MULTIPLE_ANSWERS",
    "SOLVER_LIMIT",
    "DUPLICATE_OPTION",
    "EXACT_DUPLICATE",
    "STRUCTURAL_DUPLICATE",
    "NEAR_DUPLICATE_SUSPECTED",
    "TEXT_SPEC_MISMATCH",
    "EXPLANATION_MISMATCH",
    "REVIEWER_DISAGREES",
    "REVIEWER_CANNOT_SOLVE",
    "VISION_REVIEW_UNCERTAIN",
    "MISSING_REVIEW",
    "SVG_RENDER_INVALID",
    "VISUAL_AMBIGUITY",
    "COST_UNKNOWN",
    "API_ERROR",
  ]).nullable(),
  businessBlockers: z.array(
    z.enum([
      "SCHEMA_INVALID",
      "UNSAT",
      "MULTIPLE_SOLUTIONS",
      "MULTIPLE_ANSWERS",
      "SOLVER_LIMIT",
      "DUPLICATE_OPTION",
      "EXACT_DUPLICATE",
      "STRUCTURAL_DUPLICATE",
      "NEAR_DUPLICATE_SUSPECTED",
      "TEXT_SPEC_MISMATCH",
      "EXPLANATION_MISMATCH",
      "REVIEWER_DISAGREES",
      "REVIEWER_CANNOT_SOLVE",
      "VISION_REVIEW_UNCERTAIN",
      "MISSING_REVIEW",
      "SVG_RENDER_INVALID",
      "VISUAL_AMBIGUITY",
      "COST_UNKNOWN",
      "API_ERROR",
    ]),
  ),
  failures: z.array(FailureRecordSchema),
  rationale: z.string().min(1).max(500),
});

export type PrimaryVerdictResult = z.infer<typeof PrimaryVerdictResultSchema>;

export function reducePrimaryVerdict(input: unknown): PrimaryVerdictResult {
  const evidence = PrimaryVerdictInputSchema.parse(input);
  const failures: FailureRecord[] = evidence.failures.map((failure) => ({ ...failure }));
  const businessBlockers: FailureCode[] = [];

  if (evidence.costStatus === "unknown") {
    addFailure(
      failures,
      derivedFailure(
        "COST_UNKNOWN",
        "terminal",
        "medium",
        "infrastructure",
        "cost is unknown; business proceed is blocked",
      ),
    );
    businessBlockers.push("COST_UNKNOWN");
  }

  const reviewPending =
    (evidence.blind.required && !evidence.blind.completed) ||
    (evidence.alignment.required && !evidence.alignment.completed);
  const controlPaused =
    evidence.runControl === "paused_budget" ||
    evidence.runControl === "paused_operator" ||
    evidence.runControl === "interrupted" ||
    evidence.runControl === "failed";
  if (
    evidence.preparation === "not_started" ||
    evidence.preparation === "in_progress" ||
    evidence.preparation === "paused"
  ) {
    return {
      verdict: null,
      completion: "incomplete",
      proceed: false,
      primaryFailure: null,
      businessBlockers,
      failures,
      rationale: `incomplete; preparation is ${evidence.preparation}`,
    };
  }

  const hasGenerationFailure = failures.some(
    (failure) => failureClass(failure) === "generation_error",
  );
  if (evidence.generation.state !== "usable" || hasGenerationFailure) {
    return {
      verdict: "generation_error",
      completion: "complete",
      proceed: false,
      primaryFailure: pickPrimary(failures, GENERATION_PRECEDENCE, "generation_error"),
      businessBlockers,
      failures,
      rationale: `generation_error; generation state is ${evidence.generation.state}`,
    };
  }

  if (!evidence.formalPassed || !evidence.presentationPassed) {
    if (failures.some((failure) => failureClass(failure) === "rejected")) {
      return {
        verdict: "rejected",
        completion: "complete",
        proceed: false,
        primaryFailure: pickPrimary(failures, REJECTED_PRECEDENCE, "rejected"),
        businessBlockers,
        failures,
        rationale: "rejected; a deterministic formal or presentation check failed",
      };
    }
    if (failures.some((failure) => failureClass(failure) === "inconclusive")) {
      return {
        verdict: "inconclusive",
        completion: "complete",
        proceed: false,
        primaryFailure: pickPrimary(failures, INCONCLUSIVE_PRECEDENCE, "inconclusive"),
        businessBlockers,
        failures,
        rationale: "inconclusive; a formal or presentation check is uncertain",
      };
    }
    return {
      verdict: "rejected",
      completion: "complete",
      proceed: false,
      primaryFailure: pickPrimary(failures, REJECTED_PRECEDENCE, "rejected"),
      businessBlockers,
      failures,
      rationale: "rejected; formal or presentation checks did not pass",
    };
  }

  if (isDuplicateOutcome(evidence.duplicate.outcome)) {
    addFailure(
      failures,
      derivedFailure(
        duplicateFailureCode(evidence.duplicate.outcome),
        "duplicate_checked",
        "high",
        "deterministic",
        `duplicate owner is ${evidence.duplicate.ownerSlotId ?? "unknown"}`,
      ),
    );
    return {
      verdict: "rejected",
      completion: "complete",
      proceed: false,
      primaryFailure: pickPrimary(failures, REJECTED_PRECEDENCE, "rejected"),
      businessBlockers,
      failures,
      rationale: `rejected; duplicate outcome is ${evidence.duplicate.outcome}`,
    };
  }

  if (failures.some((failure) => failureClass(failure) === "rejected")) {
    return {
      verdict: "rejected",
      completion: "complete",
      proceed: false,
      primaryFailure: pickPrimary(failures, REJECTED_PRECEDENCE, "rejected"),
      businessBlockers,
      failures,
      rationale: "rejected; a deterministic invariant is disproved",
    };
  }

  if (controlPaused && reviewPending) {
    return {
      verdict: null,
      completion: "incomplete",
      proceed: false,
      primaryFailure: null,
      businessBlockers,
      failures,
      rationale: `incomplete; run is ${evidence.runControl} with a pending review`,
    };
  }

  if (evidence.duplicate.outcome === "near_suspected") {
    addFailure(
      failures,
      derivedFailure(
        "NEAR_DUPLICATE_SUSPECTED",
        "duplicate_checked",
        "medium",
        "deterministic",
        `near pair candidates: ${evidence.duplicate.nearPairSlotIds.join(", ")}`,
      ),
    );
  }
  derivedBlindFailures(evidence, failures);
  derivedAlignmentFailures(evidence, failures);

  if (failures.some((failure) => failureClass(failure) === "inconclusive")) {
    return {
      verdict: "inconclusive",
      completion: "complete",
      proceed: false,
      primaryFailure: pickPrimary(failures, INCONCLUSIVE_PRECEDENCE, "inconclusive"),
      businessBlockers,
      failures,
      rationale: "inconclusive; a model, review, or near-duplicate concern remains",
    };
  }

  if (approvedByEvidence(evidence)) {
    return {
      verdict: "approved",
      completion: "complete",
      proceed: businessBlockers.length === 0,
      primaryFailure: null,
      businessBlockers,
      failures,
      rationale:
        businessBlockers.length === 0
          ? "approved; all required checks passed"
          : "approved quality label; business proceed is blocked by cost uncertainty",
    };
  }

  return {
    verdict: "inconclusive",
    completion: "complete",
    proceed: false,
    primaryFailure: pickPrimary(failures, INCONCLUSIVE_PRECEDENCE, "inconclusive"),
    businessBlockers,
    failures,
    rationale: "inconclusive; required checks are incomplete or not all passed",
  };
}
