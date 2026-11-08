import { z } from "zod";
import {
  FactIdSchema,
  assertFactReferences,
  mergeFactInventory,
  ruleFacts,
  type FamilyEngine,
  type Fact,
  type SolveResult,
} from "../families/contracts.js";
import {
  FamilySchema,
  ModalitySchema,
  Sha256Schema,
  type Family,
} from "../domain/experiment.js";
import type { WordingExplanationStep } from "../domain/presentation.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { STRATEGY_HINTS } from "./templates.js";

export const PROOF_TRACE_VERSION = 1 as const;

export const FORCED_OUTPUT_OPERATIONS: Readonly<
  Partial<Record<Family, string>>
> = {
  matrix: "xor_completion",
  transforms: "apply_D4_sequence",
  paths: "unique_tree_route",
  symmetry: "axis_reflection",
  counting: "shape_membership_count",
};

export type ProofTraceErrorCode =
  | "INVALID_TRACE"
  | "UNKNOWN_FACT"
  | "MISSING_PREMISE"
  | "DUPLICATE_STEP"
  | "CIRCULAR_REFERENCE"
  | "FORWARD_REFERENCE"
  | "WRONG_DEDUCTION"
  | "NON_UNIQUE"
  | "WRONG_ANSWER"
  | "UNSUPPORTED_OPERATION"
  | "SPOILING_HINT";

export class ProofTraceError extends Error {
  readonly code: ProofTraceErrorCode;

  constructor(code: ProofTraceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProofTraceError";
    this.code = code;
  }
}

const StepIdSchema = z.string().regex(/^s\d{3}$/);

export const ProofStepDeductionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("domain_survivors"),
    domainSize: z.number().int().positive(),
    survivorCount: z.literal(1),
    answerHash: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("forced_output"),
    operation: z.string().min(1).max(100),
    answerHash: Sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("complete_answer"),
    answerHash: Sha256Schema,
  }),
]);
export type ProofStepDeduction = z.infer<typeof ProofStepDeductionSchema>;

export const ProofStepSchema = z.strictObject({
  stepId: StepIdSchema,
  premiseFactIds: z.array(FactIdSchema).min(1).max(64),
  priorStepIds: z.array(StepIdSchema).max(8),
  deduction: ProofStepDeductionSchema,
  justification: z.enum(["exhaustive_elimination", "forced_output", "entailed"]),
  text: z.string().min(1).max(240),
});
export type ProofStep = z.infer<typeof ProofStepSchema>;

export const ProofTraceSchema = z
  .strictObject({
    version: z.literal(PROOF_TRACE_VERSION),
    family: FamilySchema,
    modality: ModalitySchema,
    hint: z.string().min(1).max(300),
    hintKind: z.literal("strategy"),
    domainSize: z.number().int().positive(),
    survivorCount: z.literal(1),
    finalAnswerHash: Sha256Schema,
    steps: z.array(ProofStepSchema).min(1).max(8),
    checks: z.strictObject({
      premiseCoverage: z.literal("pass"),
      entailment: z.literal("pass"),
      finalAnswer: z.literal("pass"),
      hintNonSpoiling: z.literal("pass"),
    }),
  })
  .superRefine((trace, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (new Set(trace.steps.map((step) => step.stepId)).size !== trace.steps.length) {
      issue(["steps"], "proof step IDs must be distinct");
    }
    const last = trace.steps[trace.steps.length - 1];
    if (last === undefined) {
      issue(["steps"], "proof trace requires at least one step");
      return;
    }
    if (
      last.deduction.kind !== "complete_answer" &&
      last.deduction.kind !== "forced_output"
    ) {
      issue(["steps"], "the final proof step must establish the complete answer");
    }
    for (const [index, step] of trace.steps.entries()) {
      const expectedJustification =
        step.deduction.kind === "domain_survivors"
          ? "exhaustive_elimination"
          : step.deduction.kind === "forced_output"
            ? "forced_output"
            : "entailed";
      if (step.justification !== expectedJustification) {
        issue(
          ["steps", index, "justification"],
          `deduction ${step.deduction.kind} requires justification ${expectedJustification}`,
        );
      }
    }
  });
export type ProofTrace = z.infer<typeof ProofTraceSchema>;

export interface BuildProofTraceInput<S, A> {
  readonly engine: FamilyEngine<S, A>;
  readonly spec: S;
  readonly solveResult: SolveResult<A>;
}

function inventoryFor<S, A>(
  engine: FamilyEngine<S, A>,
  spec: S,
): readonly Fact[] {
  return mergeFactInventory(
    ruleFacts(engine.visibleRules(spec)),
    engine.facts(spec),
  );
}

function answerHashFor(answer: unknown): string {
  return sha256Hex(canonicalJson(answer));
}

export function buildProofTrace<S, A>(
  input: BuildProofTraceInput<S, A>,
): ProofTrace {
  const result = input.solveResult;
  if (
    result.solutionCount !== 1 ||
    result.answerCount !== 1 ||
    result.correctAnswer === null ||
    result.correctAnswer === undefined
  ) {
    throw new ProofTraceError(
      "NON_UNIQUE",
      "a proof trace requires one independently verified complete answer",
    );
  }
  const inventory = inventoryFor(input.engine, input.spec);
  const premiseFactIds = inventory.map((fact) => fact.factId);
  const answerHash = answerHashFor(result.correctAnswer);
  const domainSize = Math.max(1, result.enumeratedStates);
  const forcedOperation = FORCED_OUTPUT_OPERATIONS[input.engine.family];
  const firstStep: ProofStep =
    input.engine.modality === "svg"
      ? {
          stepId: "s001",
          premiseFactIds,
          priorStepIds: [],
          deduction: {
            kind: "forced_output",
            operation:
              forcedOperation ??
              (() => {
                throw new ProofTraceError(
                  "UNSUPPORTED_OPERATION",
                  `visual family ${input.engine.family} has no forced-output operation`,
                );
              })(),
            answerHash,
          },
          justification: "forced_output",
          text: `The code-owned ${forcedOperation ?? "visual"} rule forces one complete output from the diagram.`,
        }
      : {
          stepId: "s001",
          premiseFactIds,
          priorStepIds: [],
          deduction: {
            kind: "domain_survivors",
            domainSize,
            survivorCount: 1,
            answerHash,
          },
          justification: "exhaustive_elimination",
          text: `The stated rules and clues leave exactly one complete solution after ${domainSize} checked states.`,
        };
  const finalStep: ProofStep = {
    stepId: "s002",
    premiseFactIds,
    priorStepIds: ["s001"],
    deduction: { kind: "complete_answer", answerHash },
    justification: "entailed",
    text: "The surviving complete solution is the unique final answer.",
  };
  return ProofTraceSchema.parse({
    version: PROOF_TRACE_VERSION,
    family: input.engine.family,
    modality: input.engine.modality,
    hint: STRATEGY_HINTS[input.engine.family],
    hintKind: "strategy",
    domainSize,
    survivorCount: 1,
    finalAnswerHash: answerHash,
    steps: [firstStep, finalStep],
    checks: {
      premiseCoverage: "pass",
      entailment: "pass",
      finalAnswer: "pass",
      hintNonSpoiling: "pass",
    },
  });
}

export interface AssertProofTraceInput<S, A> {
  readonly trace: unknown;
  readonly engine: FamilyEngine<S, A>;
  readonly spec: S;
  readonly solveResult: SolveResult<A>;
}

export function assertProofTrace<S, A>(
  input: AssertProofTraceInput<S, A>,
): ProofTrace {
  const parsed = ProofTraceSchema.safeParse(input.trace);
  if (!parsed.success) {
    throw new ProofTraceError(
      "INVALID_TRACE",
      "proof trace does not satisfy the strict schema",
      { cause: parsed.error },
    );
  }
  const trace = parsed.data;
  if (
    trace.family !== input.engine.family ||
    trace.modality !== input.engine.modality
  ) {
    throw new ProofTraceError(
      "INVALID_TRACE",
      "proof trace family/modality must match the engine",
    );
  }
  const result = input.solveResult;
  if (
    result.solutionCount !== 1 ||
    result.answerCount !== 1 ||
    result.correctAnswer === null ||
    result.correctAnswer === undefined
  ) {
    throw new ProofTraceError(
      "NON_UNIQUE",
      "proof trace verification requires one complete answer",
    );
  }
  const inventory = inventoryFor(input.engine, input.spec);
  const requiredFacts = inventory.map((fact) => fact.factId);
  const answerHash = answerHashFor(result.correctAnswer);
  if (trace.finalAnswerHash !== answerHash) {
    throw new ProofTraceError(
      "WRONG_ANSWER",
      "proof trace final answer hash does not match the independent answer",
    );
  }
  if (
    trace.domainSize !== Math.max(1, result.enumeratedStates) ||
    trace.survivorCount !== result.solutionCount
  ) {
    throw new ProofTraceError(
      "WRONG_DEDUCTION",
      "proof trace domain/survivor summary does not match the independent solve",
    );
  }
  const seen = new Set<string>();
  for (const [index, step] of trace.steps.entries()) {
    const expectedId = `s${String(index + 1).padStart(3, "0")}`;
    if (step.stepId !== expectedId) {
      throw new ProofTraceError(
        "INVALID_TRACE",
        `proof step ${index} must use ${expectedId}`,
      );
    }
    if (seen.has(step.stepId)) {
      throw new ProofTraceError(
        "DUPLICATE_STEP",
        `proof step ${step.stepId} appears more than once`,
      );
    }
    for (const prior of step.priorStepIds) {
      if (prior === step.stepId) {
        throw new ProofTraceError(
          "CIRCULAR_REFERENCE",
          `proof step ${step.stepId} references itself`,
        );
      }
      if (!seen.has(prior)) {
        throw new ProofTraceError(
          "FORWARD_REFERENCE",
          `proof step ${step.stepId} references non-prior step ${prior}`,
        );
      }
    }
    if (new Set(step.priorStepIds).size !== step.priorStepIds.length) {
      throw new ProofTraceError(
        "DUPLICATE_STEP",
        `proof step ${step.stepId} repeats a prior step`,
      );
    }
    if (new Set(step.premiseFactIds).size !== step.premiseFactIds.length) {
      throw new ProofTraceError(
        "INVALID_TRACE",
        `proof step ${step.stepId} repeats a premise fact`,
      );
    }
    try {
      assertFactReferences(step.premiseFactIds, inventory);
    } catch (error) {
      throw new ProofTraceError(
        "UNKNOWN_FACT",
        `proof step ${step.stepId} cites an unknown fact`,
        { cause: error },
      );
    }
    for (const required of requiredFacts) {
      if (!step.premiseFactIds.includes(required)) {
        throw new ProofTraceError(
          "MISSING_PREMISE",
          `proof step ${step.stepId} omits required premise ${required}`,
        );
      }
    }
    switch (step.deduction.kind) {
      case "domain_survivors": {
        if (step.deduction.domainSize !== Math.max(1, result.enumeratedStates)) {
          throw new ProofTraceError(
            "WRONG_DEDUCTION",
            "domain survivor step has the wrong checked domain size",
          );
        }
        if (step.deduction.survivorCount !== result.solutionCount) {
          throw new ProofTraceError(
            "WRONG_DEDUCTION",
            "domain survivor step has the wrong survivor count",
          );
        }
        if (step.deduction.answerHash !== answerHash) {
          throw new ProofTraceError(
            "WRONG_ANSWER",
            "domain survivor step has the wrong answer hash",
          );
        }
        break;
      }
      case "forced_output": {
        if (input.engine.modality !== "svg") {
          throw new ProofTraceError(
            "WRONG_DEDUCTION",
            "forced-output steps require a visual family",
          );
        }
        const expectedOperation = FORCED_OUTPUT_OPERATIONS[input.engine.family];
        if (
          expectedOperation === undefined ||
          step.deduction.operation !== expectedOperation
        ) {
          throw new ProofTraceError(
            "UNSUPPORTED_OPERATION",
            `unexpected forced-output operation ${step.deduction.operation}`,
          );
        }
        if (step.deduction.answerHash !== answerHash) {
          throw new ProofTraceError(
            "WRONG_ANSWER",
            "forced-output step has the wrong answer hash",
          );
        }
        break;
      }
      case "complete_answer": {
        if (step.priorStepIds.length === 0) {
          throw new ProofTraceError(
            "MISSING_PREMISE",
            "complete-answer step requires a prior verified deduction",
          );
        }
        if (step.deduction.answerHash !== answerHash) {
          throw new ProofTraceError(
            "WRONG_ANSWER",
            "complete-answer step has the wrong answer hash",
          );
        }
        break;
      }
    }
    seen.add(step.stepId);
  }
  const last = trace.steps[trace.steps.length - 1];
  if (
    last === undefined ||
    (last.deduction.kind !== "complete_answer" &&
      last.deduction.kind !== "forced_output")
  ) {
    throw new ProofTraceError(
      "INVALID_TRACE",
      "the final proof step must establish the complete answer",
    );
  }
  return trace;
}

export function explanationStepsForTrace(
  trace: ProofTrace,
): readonly WordingExplanationStep[] {
  return trace.steps.map((step) => ({
    factIds: step.premiseFactIds,
    text: step.text,
  }));
}

export function assertHintNonSpoiling(
  trace: ProofTrace,
  optionTexts: readonly string[],
  correctLabel: string,
): void {
  if (trace.hintKind !== "strategy") {
    throw new ProofTraceError(
      "SPOILING_HINT",
      "P49 only emits strategy hints, not answer deductions",
    );
  }
  const normalized = trace.hint.toLowerCase();
  for (const option of optionTexts) {
    if (option.length > 1 && normalized.includes(option.toLowerCase())) {
      throw new ProofTraceError(
        "SPOILING_HINT",
        "strategy hint exposes an option text",
      );
    }
  }
  if (new RegExp(`\\b${correctLabel}\\b`).test(trace.hint)) {
    throw new ProofTraceError(
      "SPOILING_HINT",
      "strategy hint exposes the correct option label",
    );
  }
}
