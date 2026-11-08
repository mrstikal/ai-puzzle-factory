import { z } from "zod";
import {
  DESIGNER_ASSIGNMENT_ID_PATTERN,
  DESIGNER_CANDIDATE_SLOT_ID_PATTERN,
  DesignerArmSchema,
  DesignerCandidateVerdictSchema,
  type DesignerArm,
  type DesignerCandidateVerdict,
} from "../domain/design.js";
import {
  DifficultySchema,
  FamilySchema,
  Sha256Schema,
  UsdSchema,
} from "../domain/experiment.js";
import {
  DesignAttemptRecordSchema,
  DesignerAttemptCostStatusSchema,
  DesignerAttemptRoleSchema,
  attemptHasSavedResponse,
  attemptRoleFor,
  diagnosticForRepair,
  type DesignAttemptRecord,
} from "./attempts.js";
import {
  DesignDiagnosticSchema,
  DesignDownstreamEvidenceSchema,
  DesignPendingCheckSchema,
  computeDesignDiagnosticHash,
  diagnoseGenerationError,
  diagnosePendingChecks,
  type DesignDiagnostic,
  type DesignDownstreamEvidence,
  type DesignPendingCheck,
} from "./diagnostics.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const DESIGN_STOP_REASONS = [
  "accepted",
  "deterministic_rejection",
  "solver_limit",
  "generation_error",
  "infrastructure_inconclusive",
  "pending_checks",
  "repair_cap",
  "repair_ready",
  "budget_paused",
  "operator_paused",
  "input_too_large",
] as const;
export type DesignStopReason = (typeof DESIGN_STOP_REASONS)[number];
export const DesignStopReasonSchema = z.enum(DESIGN_STOP_REASONS);

export type DesignProtocolErrorCode =
  | "INVALID_INPUT"
  | "INVALID_ATTEMPT_INDEX"
  | "INVALID_ATTEMPT_SEQUENCE"
  | "THIRD_REPAIR"
  | "REPAIR_NOT_AUTHORIZED"
  | "MISSING_DIAGNOSTIC";

export class DesignProtocolError extends Error {
  readonly code: DesignProtocolErrorCode;

  constructor(
    code: DesignProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignProtocolError";
    this.code = code;
  }
}

export const DesignAttemptSummarySchema = z.strictObject({
  attemptIndex: z.number().int().min(0).max(2),
  role: DesignerAttemptRoleSchema,
  verdict: DesignerCandidateVerdictSchema,
  diagnosticHash: Sha256Schema.nullable(),
  proposalHash: Sha256Schema.nullable(),
  logicalCallId: z.uuid().nullable(),
  costStatus: DesignerAttemptCostStatusSchema,
  costUsd: UsdSchema.nullable(),
});
export type DesignAttemptSummary = z.infer<
  typeof DesignAttemptSummarySchema
>;

export const DesignCandidateFinalSchema = z
  .strictObject({
    kind: z.literal("design_candidate_final"),
    slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
    assignmentId: z.string().regex(DESIGNER_ASSIGNMENT_ID_PATTERN),
    arm: DesignerArmSchema,
    family: FamilySchema,
    difficulty: DifficultySchema,
    firstAttempt: DesignAttemptSummarySchema,
    attempts: z.array(DesignAttemptSummarySchema).min(1).max(3),
    finalVerdict: DesignerCandidateVerdictSchema,
    finalAttemptIndex: z.number().int().min(0).max(2),
    stopReason: DesignStopReasonSchema,
    repairPending: z.boolean(),
    pendingChecks: z.array(DesignPendingCheckSchema).max(3),
    terminalDiagnostic: DesignDiagnosticSchema.nullable(),
    evidenceHash: Sha256Schema,
  })
  .superRefine((final, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    const first = final.attempts[0];
    if (
      first === undefined ||
      canonicalJson(first) !== canonicalJson(final.firstAttempt)
    ) {
      issue(
        ["firstAttempt"],
        "firstAttempt must be the immutable first attempt summary",
      );
    }
    for (const [index, attempt] of final.attempts.entries()) {
      if (attempt.attemptIndex !== index) {
        issue(
          ["attempts", index, "attemptIndex"],
          `expected attempt index ${index}`,
        );
      }
    }
    const last = final.attempts[final.attempts.length - 1];
    if (last === undefined) {
      issue(["attempts"], "a final candidate requires at least one attempt");
      return;
    }
    if (final.finalAttemptIndex !== last.attemptIndex) {
      issue(
        ["finalAttemptIndex"],
        "finalAttemptIndex must name the last attempt",
      );
    }
    if (final.finalVerdict !== last.verdict) {
      issue(["finalVerdict"], "finalVerdict must equal the last attempt verdict");
    }
    if (
      (final.arm === "baseline" || final.arm === "ai_one_shot") &&
      final.attempts.length !== 1
    ) {
      issue(
        ["attempts"],
        "baseline and one-shot arms have exactly one attempt",
      );
    }
    const repairStop =
      final.stopReason === "repair_ready" ||
      final.stopReason === "budget_paused" ||
      final.stopReason === "operator_paused";
    if (final.repairPending !== repairStop) {
      issue(
        ["repairPending"],
        "repairPending is true only for repair_ready or paused stop reasons",
      );
    }
    if (repairStop) {
      if (final.attempts.length >= 3) {
        issue(["repairPending"], "a third repair cannot be pending");
      }
      if (
        last.verdict === "accepted" ||
        last.verdict === "generation_error" ||
        last.diagnosticHash === null
      ) {
        issue(
          ["repairPending"],
          "only a diagnosed rejection or solver limit can authorize a repair",
        );
      }
    }
    if (final.stopReason === "pending_checks") {
      if (final.pendingChecks.length === 0) {
        issue(["pendingChecks"], "pending_checks requires pending check names");
      }
      if (final.finalVerdict !== "inconclusive") {
        issue(["finalVerdict"], "pending checks leave the candidate inconclusive");
      }
    } else if (final.pendingChecks.length > 0) {
      issue(
        ["pendingChecks"],
        "only pending_checks may carry pending check names",
      );
    }
    if (
      final.stopReason === "accepted" &&
      final.finalVerdict !== "accepted"
    ) {
      issue(["stopReason"], "accepted stop reason requires an accepted verdict");
    }
    if (
      final.stopReason === "generation_error" &&
      final.finalVerdict !== "generation_error"
    ) {
      issue(
        ["stopReason"],
        "generation_error stop reason requires a generation_error verdict",
      );
    }
    if (
      final.stopReason === "solver_limit" &&
      final.finalVerdict !== "inconclusive"
    ) {
      issue(
        ["stopReason"],
        "solver_limit stop reason requires an inconclusive verdict",
      );
    }
    if (
      final.stopReason === "infrastructure_inconclusive" &&
      final.finalVerdict !== "inconclusive"
    ) {
      issue(
        ["stopReason"],
        "infrastructure_inconclusive requires an inconclusive verdict",
      );
    }
    if (
      final.stopReason === "deterministic_rejection" &&
      final.finalVerdict !== "rejected"
    ) {
      issue(
        ["stopReason"],
        "deterministic_rejection requires a rejected verdict",
      );
    }
    if (
      final.stopReason === "repair_cap" &&
      final.attempts.length !== 3
    ) {
      issue(["stopReason"], "repair_cap requires three attempts");
    }
    if (final.stopReason === "input_too_large") {
      if (
        final.terminalDiagnostic === null ||
        final.terminalDiagnostic.errorCode !== "INPUT_TOO_LARGE"
      ) {
        issue(
          ["terminalDiagnostic"],
          "input_too_large requires a terminal INPUT_TOO_LARGE diagnostic",
        );
      }
      if (
        final.finalVerdict !== "rejected" &&
        final.finalVerdict !== "inconclusive"
      ) {
        issue(
          ["finalVerdict"],
          "input_too_large preserves the preceding rejected or inconclusive verdict",
        );
      }
      if (final.repairPending) {
        issue(["repairPending"], "input_too_large is terminal");
      }
    } else if (final.terminalDiagnostic !== null) {
      issue(
        ["terminalDiagnostic"],
        "only input_too_large may carry a terminal diagnostic",
      );
    }
    const { evidenceHash, ...base } = final;
    if (evidenceHash !== sha256Hex(canonicalJson(base))) {
      issue(["evidenceHash"], "evidenceHash does not match the final record");
    }
  });

export type DesignCandidateFinal = z.infer<
  typeof DesignCandidateFinalSchema
>;

export interface EvaluateDesignAttemptInput {
  readonly arm: DesignerArm;
  readonly attemptIndex: number;
  readonly responsePresent: boolean;
  readonly solverDiagnostic: DesignDiagnostic | null;
  readonly downstream: DesignDownstreamEvidence;
}

export interface EvaluatedDesignAttempt {
  readonly verdict: DesignerCandidateVerdict;
  readonly diagnostic: DesignDiagnostic | null;
  readonly pendingChecks: readonly DesignPendingCheck[];
}

function assertAttemptIndex(arm: DesignerArm, attemptIndex: number): void {
  const max = arm === "ai_feedback" ? 2 : 0;
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0 || attemptIndex > max) {
    throw new DesignProtocolError(
      "INVALID_ATTEMPT_INDEX",
      `${arm} does not allow attempt index ${attemptIndex}`,
    );
  }
}

export function evaluateDesignAttempt(
  input: EvaluateDesignAttemptInput,
): EvaluatedDesignAttempt {
  assertAttemptIndex(input.arm, input.attemptIndex);
  const downstream = DesignDownstreamEvidenceSchema.parse(input.downstream);
  const solverDiagnostic =
    input.solverDiagnostic === null
      ? null
      : DesignDiagnosticSchema.parse(input.solverDiagnostic);

  if (!input.responsePresent) {
    if (solverDiagnostic?.errorCode === "INFRASTRUCTURE_ERROR") {
      return {
        verdict: "inconclusive",
        diagnostic: solverDiagnostic,
        pendingChecks: [],
      };
    }
    return {
      verdict: "generation_error",
      diagnostic:
        solverDiagnostic?.errorCode === "GENERATION_ERROR"
          ? solverDiagnostic
          : diagnoseGenerationError(new Error("no usable design response")),
      pendingChecks: [],
    };
  }

  if (solverDiagnostic !== null) {
    if (solverDiagnostic.errorCode === "GENERATION_ERROR") {
      return {
        verdict: "generation_error",
        diagnostic: solverDiagnostic,
        pendingChecks: [],
      };
    }
    if (
      solverDiagnostic.evidenceSource === "infrastructure" ||
      solverDiagnostic.errorCode === "INFRASTRUCTURE_ERROR"
    ) {
      return {
        verdict: "inconclusive",
        diagnostic: solverDiagnostic,
        pendingChecks: [],
      };
    }
    if (solverDiagnostic.errorCode === "SOLVER_LIMIT") {
      return {
        verdict: "inconclusive",
        diagnostic: solverDiagnostic,
        pendingChecks: [],
      };
    }
    if (solverDiagnostic.errorCode === "PENDING_CHECKS") {
      return {
        verdict: "inconclusive",
        diagnostic: solverDiagnostic,
        pendingChecks: solverDiagnostic.pendingChecks,
      };
    }
    return {
      verdict: "rejected",
      diagnostic: solverDiagnostic,
      pendingChecks: [],
    };
  }

  const failed = [
    downstream.options,
    downstream.render,
    downstream.presentation,
  ].find((evidence) => evidence.status === "failed");
  if (failed !== undefined && failed.diagnostic !== null) {
    if (failed.diagnostic.errorCode === "GENERATION_ERROR") {
      return {
        verdict: "generation_error",
        diagnostic: failed.diagnostic,
        pendingChecks: [],
      };
    }
    if (
      failed.diagnostic.evidenceSource === "infrastructure" ||
      failed.diagnostic.errorCode === "INFRASTRUCTURE_ERROR"
    ) {
      return {
        verdict: "inconclusive",
        diagnostic: failed.diagnostic,
        pendingChecks: [],
      };
    }
    if (failed.diagnostic.errorCode === "PENDING_CHECKS") {
      return {
        verdict: "inconclusive",
        diagnostic: failed.diagnostic,
        pendingChecks: failed.diagnostic.pendingChecks,
      };
    }
    return {
      verdict: "rejected",
      diagnostic: failed.diagnostic,
      pendingChecks: [],
    };
  }

  const pendingChecks: DesignPendingCheck[] = [];
  if (downstream.options.status === "pending") {
    pendingChecks.push("options");
  }
  if (downstream.render.status === "pending") {
    pendingChecks.push("render");
  }
  if (downstream.presentation.status === "pending") {
    pendingChecks.push("presentation");
  }
  if (pendingChecks.length > 0) {
    return {
      verdict: "inconclusive",
      diagnostic: diagnosePendingChecks(pendingChecks),
      pendingChecks,
    };
  }

  return { verdict: "accepted", diagnostic: null, pendingChecks: [] };
}

function summarizeAttempt(
  attempt: DesignAttemptRecord,
): DesignAttemptSummary {
  const proposal = attempt.artifacts.find(
    (artifact) =>
      artifact.artifact.artifactId === attempt.proposalArtifactId &&
      artifact.role === "proposal",
  );
  return {
    attemptIndex: attempt.attemptIndex,
    role: attempt.role,
    verdict: attempt.verdict,
    diagnosticHash:
      attempt.diagnostic === null
        ? null
        : computeDesignDiagnosticHash(attempt.diagnostic),
    proposalHash: proposal?.artifact.contentHash ?? null,
    logicalCallId: attempt.logicalCallId,
    costStatus: attempt.costStatus,
    costUsd: attempt.costUsd,
  };
}

export interface ReduceDesignCandidateInput {
  readonly slotId: string;
  readonly assignmentId: string;
  readonly arm: DesignerArm;
  readonly family: z.infer<typeof FamilySchema>;
  readonly difficulty: z.infer<typeof DifficultySchema>;
  readonly attempts: readonly DesignAttemptRecord[];
  readonly paused?: "budget" | "operator" | null;
  readonly repairBlocked?: DesignDiagnostic | null;
}

export function reduceDesignCandidate(
  input: ReduceDesignCandidateInput,
): DesignCandidateFinal {
  if (
    !z
      .string()
      .regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN)
      .safeParse(input.slotId).success ||
    !z
      .string()
      .regex(DESIGNER_ASSIGNMENT_ID_PATTERN)
      .safeParse(input.assignmentId).success
  ) {
    throw new DesignProtocolError(
      "INVALID_INPUT",
      "designer slot and assignment IDs are invalid",
    );
  }
  if (input.attempts.length === 0) {
    throw new DesignProtocolError(
      "INVALID_ATTEMPT_SEQUENCE",
      "a design candidate requires at least one attempt",
    );
  }
  if (input.attempts.length > 3) {
    throw new DesignProtocolError(
      "THIRD_REPAIR",
      "a design candidate cannot have more than three attempts",
    );
  }
  const maxIndex = input.arm === "ai_feedback" ? 2 : 0;
  for (const [index, attempt] of input.attempts.entries()) {
    if (index > maxIndex) {
      throw new DesignProtocolError(
        "INVALID_ATTEMPT_SEQUENCE",
        `${input.arm} does not allow attempt index ${index}`,
      );
    }
    const parsed = DesignAttemptRecordSchema.safeParse(attempt);
    if (!parsed.success) {
      throw new DesignProtocolError(
        "INVALID_INPUT",
        `attempt ${index} is not a valid design attempt record`,
        { cause: parsed.error },
      );
    }
    if (
      attempt.slotId !== input.slotId ||
      attempt.arm !== input.arm ||
      attempt.attemptIndex !== index
    ) {
      throw new DesignProtocolError(
        "INVALID_ATTEMPT_SEQUENCE",
        `attempt ${index} does not match the candidate identity or order`,
      );
    }
    if (attempt.role !== attemptRoleFor(input.arm, index)) {
      throw new DesignProtocolError(
        "INVALID_ATTEMPT_SEQUENCE",
        `attempt ${index} uses role ${attempt.role}`,
      );
    }
    if (index > 0) {
      const previous = input.attempts[index - 1];
      if (previous === undefined) {
        throw new DesignProtocolError(
          "INVALID_ATTEMPT_SEQUENCE",
          `attempt ${index} has no predecessor`,
        );
      }
      if (diagnosticForRepair(previous) === null) {
        throw new DesignProtocolError(
          "REPAIR_NOT_AUTHORIZED",
          `attempt ${index} follows a non-repairable attempt`,
        );
      }
      if (!attemptHasSavedResponse(previous)) {
        throw new DesignProtocolError(
          "REPAIR_NOT_AUTHORIZED",
          `attempt ${index} follows an attempt without a saved response`,
        );
      }
    }
  }
  if (input.attempts.length - 1 > maxIndex) {
    throw new DesignProtocolError(
      "THIRD_REPAIR",
      `${input.arm} does not allow attempt index ${input.attempts.length - 1}`,
    );
  }

  const last = input.attempts[input.attempts.length - 1];
  if (last === undefined) {
    throw new DesignProtocolError(
      "INVALID_ATTEMPT_SEQUENCE",
      "a design candidate requires a last attempt",
    );
  }
  const lastRepairable =
    diagnosticForRepair(last) !== null && attemptHasSavedResponse(last);
  const canRepair = lastRepairable && last.attemptIndex < maxIndex;
  const paused = input.paused ?? null;

  let stopReason: DesignStopReason;
  let repairPending = false;
  let pendingChecks: readonly DesignPendingCheck[] = [];
  let terminalDiagnostic: DesignDiagnostic | null = null;

  if (
    canRepair &&
    input.repairBlocked !== undefined &&
    input.repairBlocked !== null
  ) {
    if (input.repairBlocked.errorCode === "INPUT_TOO_LARGE") {
      stopReason = "input_too_large";
      terminalDiagnostic = input.repairBlocked;
    } else {
      stopReason = "infrastructure_inconclusive";
      terminalDiagnostic = null;
    }
  } else if (last.verdict === "accepted") {
    stopReason = "accepted";
  } else if (last.verdict === "generation_error") {
    stopReason = "generation_error";
  } else if (last.verdict === "inconclusive") {
    const code = last.diagnostic?.errorCode;
    if (code === "PENDING_CHECKS") {
      stopReason = "pending_checks";
      pendingChecks = last.diagnostic?.pendingChecks ?? [];
    } else if (code === "SOLVER_LIMIT") {
      if (canRepair) {
        if (paused === "budget") {
          stopReason = "budget_paused";
          repairPending = true;
        } else if (paused === "operator") {
          stopReason = "operator_paused";
          repairPending = true;
        } else {
          stopReason = "repair_ready";
          repairPending = true;
        }
      } else {
        stopReason = "solver_limit";
      }
    } else {
      stopReason = "infrastructure_inconclusive";
    }
  } else if (canRepair) {
    if (paused === "budget") {
      stopReason = "budget_paused";
      repairPending = true;
    } else if (paused === "operator") {
      stopReason = "operator_paused";
      repairPending = true;
    } else {
      stopReason = "repair_ready";
      repairPending = true;
    }
  } else if (
    input.arm === "ai_feedback" &&
    lastRepairable &&
    last.attemptIndex >= maxIndex
  ) {
    stopReason = "repair_cap";
  } else {
    stopReason = "deterministic_rejection";
  }

  const summaries = input.attempts.map(summarizeAttempt);
  const firstAttempt = summaries[0];
  if (firstAttempt === undefined) {
    throw new DesignProtocolError(
      "INVALID_ATTEMPT_SEQUENCE",
      "a design candidate requires a first attempt",
    );
  }
  const base = {
    kind: "design_candidate_final" as const,
    slotId: input.slotId,
    assignmentId: input.assignmentId,
    arm: input.arm,
    family: input.family,
    difficulty: input.difficulty,
    firstAttempt,
    attempts: summaries,
    finalVerdict: last.verdict,
    finalAttemptIndex: last.attemptIndex,
    stopReason,
    repairPending,
    pendingChecks: [...pendingChecks],
    terminalDiagnostic,
  };
  return DesignCandidateFinalSchema.parse({
    ...base,
    evidenceHash: sha256Hex(canonicalJson(base)),
  });
}
