import { z } from "zod";
import {
  DESIGNER_ASSIGNMENT_ID_PATTERN,
  type DesignProposal,
  type DesignerArm,
} from "../domain/design.js";
import {
  DifficultySchema,
  FamilySchema,
} from "../domain/experiment.js";
import {
  DESIGN_FIX_KINDS,
  DesignDiagnosticSchema,
  DesignFixKindSchema,
  diagnoseInputTooLarge,
  type DesignDiagnostic,
  type DesignDownstreamEvidence,
  type DesignFixKind,
} from "./diagnostics.js";
import {
  attemptRoleFor,
  diagnosticForRepair,
  type DesignAttemptRecord,
  type DesignerAttemptCostStatus,
} from "./attempts.js";
import {
  evaluateDesignAttempt,
  reduceDesignCandidate,
  type DesignCandidateFinal,
} from "./verdict.js";
import type { ArtifactInput } from "../storage/artifacts.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const MAX_REPAIR_INPUT_BYTES = 16_384;

export type DesignFeedbackErrorCode =
  | "INVALID_INPUT"
  | "REPAIR_NOT_AUTHORIZED"
  | "NO_PREVIOUS_RESPONSE"
  | "INPUT_TOO_LARGE"
  | "REPAIR_REPLAY";

export class DesignFeedbackError extends Error {
  readonly code: DesignFeedbackErrorCode;

  constructor(
    code: DesignFeedbackErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignFeedbackError";
    this.code = code;
  }
}

export const DesignRepairAssignmentSchema = z.strictObject({
  assignmentId: z.string().regex(DESIGNER_ASSIGNMENT_ID_PATTERN),
  family: FamilySchema,
  difficulty: DifficultySchema,
});
export type DesignRepairAssignment = z.infer<
  typeof DesignRepairAssignmentSchema
>;

export const DesignRepairInputSchema = z.strictObject({
  assignment: DesignRepairAssignmentSchema,
  previousProposal: z.unknown().nullable(),
  previousProposalValid: z.boolean(),
  diagnostic: DesignDiagnosticSchema,
  allowedFixKinds: z.array(DesignFixKindSchema).max(DESIGN_FIX_KINDS.length),
});
export type DesignRepairInput = z.infer<typeof DesignRepairInputSchema>;

const FORBIDDEN_KEYS = new Set([
  "answer",
  "answers",
  "correctAnswer",
  "answerKey",
  "key",
  "options",
  "choices",
  "question",
  "clueText",
  "hint",
  "explanation",
  "svg",
  "code",
  "provider",
  "humanFeedback",
  "feedback",
]);

const FORBIDDEN_TEXT = [
  /<[A-Za-z!/?]/,
  /\/>/,
  /```/,
  /\bjavascript:/i,
  /\bdata:/i,
  /https?:\/\//i,
  /<\?/,
  /<!DOCTYPE/i,
];

function sanitizeString(value: string): string {
  if (FORBIDDEN_TEXT.some((pattern) => pattern.test(value))) {
    return "[redacted]";
  }
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

export function sanitizeRepairValue(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 8) {
    return "[truncated]";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeRepairValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }
      output[key] = sanitizeRepairValue(item, depth + 1);
    }
    return output;
  }
  return null;
}

export interface BuildDesignRepairInput {
  readonly assignment: DesignRepairAssignment;
  readonly previousProposal: DesignProposal | null;
  readonly previousRawValue: unknown | null;
  readonly diagnostic: DesignDiagnostic;
  readonly allowedFixKinds?: readonly DesignFixKind[];
}

export function buildDesignRepairInput(
  input: BuildDesignRepairInput,
): DesignRepairInput {
  const assignment = DesignRepairAssignmentSchema.safeParse(input.assignment);
  if (!assignment.success) {
    throw new DesignFeedbackError(
      "INVALID_INPUT",
      "invalid repair assignment",
      { cause: assignment.error },
    );
  }
  const diagnostic = DesignDiagnosticSchema.safeParse(input.diagnostic);
  if (!diagnostic.success) {
    throw new DesignFeedbackError(
      "INVALID_INPUT",
      "invalid repair diagnostic",
      { cause: diagnostic.error },
    );
  }
  if (
    diagnostic.data.errorCode === "GENERATION_ERROR" ||
    diagnostic.data.errorCode === "INFRASTRUCTURE_ERROR" ||
    diagnostic.data.errorCode === "PENDING_CHECKS" ||
    diagnostic.data.errorCode === "INPUT_TOO_LARGE"
  ) {
    throw new DesignFeedbackError(
      "REPAIR_NOT_AUTHORIZED",
      `${diagnostic.data.errorCode} cannot authorize a design repair`,
    );
  }
  if (input.previousProposal === null && input.previousRawValue === null) {
    throw new DesignFeedbackError(
      "NO_PREVIOUS_RESPONSE",
      "a repair requires a saved previous response",
    );
  }
  const previousProposal =
    input.previousProposal === null
      ? sanitizeRepairValue(input.previousRawValue)
      : input.previousProposal;
  const allowedFixKinds = [
    ...(input.allowedFixKinds ?? diagnostic.data.allowedFixKinds),
  ];
  const parsedRepairInput = DesignRepairInputSchema.safeParse({
    assignment: assignment.data,
    previousProposal,
    previousProposalValid: input.previousProposal !== null,
    diagnostic: diagnostic.data,
    allowedFixKinds,
  });
  if (!parsedRepairInput.success) {
    throw new DesignFeedbackError(
      "INVALID_INPUT",
      "invalid repair input",
      { cause: parsedRepairInput.error },
    );
  }
  const repairInput = parsedRepairInput.data;
  const bytes = Buffer.byteLength(canonicalJson(repairInput), "utf8");
  if (bytes > MAX_REPAIR_INPUT_BYTES) {
    throw new DesignFeedbackError(
      "INPUT_TOO_LARGE",
      `repair input is ${bytes} bytes; limit is ${MAX_REPAIR_INPUT_BYTES}`,
    );
  }
  return repairInput;
}

export function computeDesignRepairInputHash(
  input: DesignRepairInput,
): string {
  return sha256Hex(canonicalJson(input));
}

export function assertRepairProposalIsNew(
  previousProposal: DesignProposal | null,
  nextProposal: DesignProposal,
): void {
  if (previousProposal === null) {
    return;
  }
  if (
    previousProposal.family === nextProposal.family &&
    previousProposal.difficulty === nextProposal.difficulty &&
    canonicalJson(previousProposal.spec) === canonicalJson(nextProposal.spec)
  ) {
    throw new DesignFeedbackError(
      "REPAIR_REPLAY",
      "repair response repeats the previous proposal instead of a new design",
    );
  }
}


export interface DesignAttemptCandidateResult {
  readonly proposal: DesignProposal | null;
  readonly rawValue: unknown | null;
  readonly diagnostic: DesignDiagnostic | null;
  readonly downstream: DesignDownstreamEvidence;
  readonly logicalCallId: string | null;
  readonly costStatus: DesignerAttemptCostStatus;
  readonly costUsd: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly artifacts: readonly ArtifactInput[];
}

export interface PersistDesignAttemptInput {
  readonly slotId: string;
  readonly attemptIndex: 0 | 1 | 2;
  readonly role: ReturnType<typeof attemptRoleFor>;
  readonly arm: DesignerArm;
  readonly logicalCallId: string | null;
  readonly proposal: DesignProposal | null;
  readonly rawValue: unknown | null;
  readonly diagnostic: DesignDiagnostic | null;
  readonly verdict: DesignCandidateFinal["finalVerdict"];
  readonly costStatus: DesignerAttemptCostStatus;
  readonly costUsd: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly artifacts: readonly ArtifactInput[];
}

export interface DesignRepairRequest {
  readonly repairIndex: 1 | 2;
  readonly repairInput: DesignRepairInput;
  readonly previousProposal: DesignProposal | null;
}

export interface RunDesignFeedbackLoopInput {
  readonly assignment: DesignRepairAssignment;
  readonly arm: DesignerArm;
  readonly first: DesignAttemptCandidateResult;
  readonly repair: (
    request: DesignRepairRequest,
  ) => Promise<DesignAttemptCandidateResult>;
  readonly persist: (
    input: PersistDesignAttemptInput,
  ) => Promise<DesignAttemptRecord> | DesignAttemptRecord;
  readonly paused?: "budget" | "operator" | null;
  readonly skinEnabled?: boolean;
}

export interface RunDesignFeedbackLoopResult {
  readonly final: DesignCandidateFinal;
  readonly attempts: readonly DesignAttemptRecord[];
}

export async function runDesignFeedbackLoop(
  input: RunDesignFeedbackLoopInput,
): Promise<RunDesignFeedbackLoopResult> {
  const assignment = DesignRepairAssignmentSchema.parse(input.assignment);
  const slotId = `${assignment.assignmentId}-${input.arm}`;
  const maxIndex = input.arm === "ai_feedback" ? 2 : 0;
  const attempts: DesignAttemptRecord[] = [];
  let current = input.first;
  let repairBlocked: DesignDiagnostic | null = null;

  for (let index = 0; index <= maxIndex; index += 1) {
    const attemptIndex = index as 0 | 1 | 2;
    const evaluated = evaluateDesignAttempt({
      arm: input.arm,
      attemptIndex,
      responsePresent: current.proposal !== null || current.rawValue !== null,
      solverDiagnostic: current.diagnostic,
      downstream: current.downstream,
    });
    const record = await input.persist({
      slotId,
      attemptIndex,
      role: attemptRoleFor(input.arm, attemptIndex),
      arm: input.arm,
      logicalCallId: current.logicalCallId,
      proposal: current.proposal,
      rawValue: current.rawValue,
      diagnostic: evaluated.diagnostic,
      verdict: evaluated.verdict,
      costStatus: current.costStatus,
      costUsd: current.costUsd,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      elapsedMs: current.elapsedMs,
      artifacts: current.artifacts,
    });
    attempts.push(record);

    if (
      index === maxIndex ||
      input.arm !== "ai_feedback" ||
      (input.paused !== undefined && input.paused !== null)
    ) {
      break;
    }
    const previousDiagnostic = diagnosticForRepair(record);
    if (previousDiagnostic === null) {
      break;
    }
    if (current.proposal === null && current.rawValue === null) {
      break;
    }
    let repairInput: DesignRepairInput;
    try {
      repairInput = buildDesignRepairInput({
        assignment,
        previousProposal: current.proposal,
        previousRawValue: current.rawValue,
        diagnostic: previousDiagnostic,
      });
    } catch (error) {
      if (error instanceof DesignFeedbackError && error.code === "INPUT_TOO_LARGE") {
        repairBlocked = diagnoseInputTooLarge(error.message);
        break;
      }
      throw error;
    }
    current = await input.repair({
      repairIndex: (index + 1) as 1 | 2,
      repairInput,
      previousProposal: current.proposal,
    });
  }

  const final = reduceDesignCandidate({
    slotId,
    assignmentId: assignment.assignmentId,
    arm: input.arm,
    family: assignment.family,
    difficulty: assignment.difficulty,
    attempts,
    paused: input.paused ?? null,
    repairBlocked,
  });
  return { final, attempts };
}
