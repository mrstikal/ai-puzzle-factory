import { z } from "zod";
import {
  DESIGNER_CANDIDATE_SLOT_ID_PATTERN,
  DesignerArmSchema,
  DesignerCandidateVerdictSchema,
  type DesignerArm,
} from "../domain/design.js";
import { UsdSchema } from "../domain/experiment.js";
import { ArtifactRecordSchema } from "../storage/artifacts.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { DesignDiagnosticSchema, type DesignDiagnostic } from "./diagnostics.js";

export const DESIGNER_ATTEMPT_ROLES = [
  "baseline",
  "design",
  "design_repair_1",
  "design_repair_2",
] as const;
export type DesignerAttemptRole =
  (typeof DESIGNER_ATTEMPT_ROLES)[number];
export const DesignerAttemptRoleSchema = z.enum(DESIGNER_ATTEMPT_ROLES);

export const DESIGNER_ATTEMPT_ARTIFACT_ROLES = [
  "proposal",
  "diagnostic",
  "raw_response",
  "request_body",
  "solver_result",
  "other",
] as const;
export type DesignerAttemptArtifactRole =
  (typeof DESIGNER_ATTEMPT_ARTIFACT_ROLES)[number];
export const DesignerAttemptArtifactRoleSchema = z.enum(
  DESIGNER_ATTEMPT_ARTIFACT_ROLES,
);

export const DESIGNER_ATTEMPT_COST_STATUSES = [
  "none",
  "known",
  "unknown",
] as const;
export type DesignerAttemptCostStatus =
  (typeof DESIGNER_ATTEMPT_COST_STATUSES)[number];
export const DesignerAttemptCostStatusSchema = z.enum(
  DESIGNER_ATTEMPT_COST_STATUSES,
);

export const DesignerAttemptArtifactRecordSchema = z.strictObject({
  artifact: ArtifactRecordSchema,
  role: DesignerAttemptArtifactRoleSchema,
});
export type DesignerAttemptArtifactRecord = z.infer<
  typeof DesignerAttemptArtifactRecordSchema
>;

export const DesignAttemptIdentitySchema = z
  .strictObject({
    attemptIndex: z.number().int().min(0).max(2),
    role: DesignerAttemptRoleSchema,
    arm: DesignerArmSchema,
    logicalCallId: z.uuid().nullable(),
    costStatus: DesignerAttemptCostStatusSchema,
    costUsd: UsdSchema.nullable(),
  })
  .superRefine((attempt, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    const aiCostValid =
      attempt.costStatus === "known"
        ? attempt.costUsd !== null
        : attempt.costStatus === "unknown"
          ? attempt.costUsd === null
          : false;
    if (attempt.arm === "baseline") {
      if (
        attempt.attemptIndex !== 0 ||
        attempt.role !== "baseline" ||
        attempt.logicalCallId !== null ||
        attempt.costStatus !== "none" ||
        attempt.costUsd !== "0"
      ) {
        issue(
          ["arm"],
          "baseline attempts are index 0, role baseline, without a logical call, and cost none/0",
        );
      }
      return;
    }
    if (attempt.logicalCallId === null || !aiCostValid) {
      issue(
        ["logicalCallId"],
        "AI design attempts require a logical call and a known/unknown cost snapshot",
      );
    }
    if (attempt.arm === "ai_one_shot") {
      if (attempt.attemptIndex !== 0 || attempt.role !== "design") {
        issue(
          ["attemptIndex"],
          "one-shot attempts are exactly index 0 with role design",
        );
      }
      return;
    }
    if (attempt.attemptIndex === 0) {
      if (attempt.role !== "design") {
        issue(["role"], "feedback attempt 0 uses role design");
      }
    } else if (attempt.attemptIndex === 1) {
      if (attempt.role !== "design_repair_1") {
        issue(["role"], "feedback attempt 1 uses role design_repair_1");
      }
    } else if (attempt.attemptIndex === 2) {
      if (attempt.role !== "design_repair_2") {
        issue(["role"], "feedback attempt 2 uses role design_repair_2");
      }
    }
  });
export type DesignAttemptIdentity = z.infer<typeof DesignAttemptIdentitySchema>;

export const DesignAttemptRecordSchema = z
  .strictObject({
    kind: z.literal("design_attempt"),
    runId: z.uuid(),
    slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
    attemptIndex: z.number().int().min(0).max(2),
    role: DesignerAttemptRoleSchema,
    arm: DesignerArmSchema,
    logicalCallId: z.uuid().nullable(),
    proposalArtifactId: z.number().int().positive().nullable(),
    diagnostic: DesignDiagnosticSchema.nullable(),
    verdict: DesignerCandidateVerdictSchema,
    costStatus: DesignerAttemptCostStatusSchema,
    costUsd: UsdSchema.nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    elapsedMs: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    artifacts: z.array(DesignerAttemptArtifactRecordSchema),
  })
  .superRefine((attempt, ctx) => {
    const identity = DesignAttemptIdentitySchema.safeParse({
      attemptIndex: attempt.attemptIndex,
      role: attempt.role,
      arm: attempt.arm,
      logicalCallId: attempt.logicalCallId,
      costStatus: attempt.costStatus,
      costUsd: attempt.costUsd,
    });
    if (!identity.success) {
      for (const issue of identity.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
    if (attempt.verdict === "accepted") {
      if (attempt.diagnostic !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostic"],
          message: "an accepted attempt carries no failure diagnostic",
        });
      }
      if (attempt.proposalArtifactId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["proposalArtifactId"],
          message: "an accepted attempt requires a saved proposal artifact",
        });
      }
    } else if (attempt.diagnostic === null) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostic"],
        message: `${attempt.verdict} attempts require a diagnostic`,
      });
    }
    if (attempt.verdict === "generation_error") {
      if (attempt.diagnostic?.errorCode !== "GENERATION_ERROR") {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostic", "errorCode"],
          message: "generation_error attempts require a GENERATION_ERROR diagnostic",
        });
      }
    }
    if (attempt.verdict === "inconclusive") {
      const code = attempt.diagnostic?.errorCode;
      if (
        code !== "SOLVER_LIMIT" &&
        code !== "INFRASTRUCTURE_ERROR" &&
        code !== "PENDING_CHECKS" &&
        (attempt.diagnostic?.evidenceSource !== "infrastructure" ||
          code === "GENERATION_ERROR")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostic", "errorCode"],
          message:
            "inconclusive attempts require SOLVER_LIMIT, INFRASTRUCTURE_ERROR, PENDING_CHECKS, or infrastructure evidence",
        });
      }
    }
    if (attempt.verdict === "rejected") {
      const code = attempt.diagnostic?.errorCode;
      if (
        code === undefined ||
        code === "SOLVER_LIMIT" ||
        code === "INFRASTRUCTURE_ERROR" ||
        code === "GENERATION_ERROR" ||
        code === "PENDING_CHECKS" ||
        attempt.diagnostic?.evidenceSource === "infrastructure"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostic", "errorCode"],
          message:
            "rejected attempts require a deterministic or input diagnostic",
        });
      }
    }
    if (attempt.proposalArtifactId !== null) {
      const proposal = attempt.artifacts.find(
        (artifact) =>
          artifact.artifact.artifactId === attempt.proposalArtifactId &&
          artifact.role === "proposal",
      );
      if (proposal === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["proposalArtifactId"],
          message: "proposal artifact ID must reference a proposal artifact",
        });
      }
    }
    if (attempt.proposalArtifactId !== null && attempt.diagnostic?.errorCode === "GENERATION_ERROR") {
      ctx.addIssue({
        code: "custom",
        path: ["proposalArtifactId"],
        message: "generation errors cannot carry a parsed proposal artifact",
      });
    }
  });
export type DesignAttemptRecord = z.infer<typeof DesignAttemptRecordSchema>;

export function attemptRoleFor(
  arm: DesignerArm,
  attemptIndex: number,
): DesignerAttemptRole {
  if (arm === "baseline") {
    if (attemptIndex !== 0) {
      throw new RangeError("baseline has only attempt 0");
    }
    return "baseline";
  }
  if (attemptIndex === 0) {
    return "design";
  }
  if (attemptIndex === 1) {
    return "design_repair_1";
  }
  if (attemptIndex === 2) {
    return "design_repair_2";
  }
  throw new RangeError(
    `designer attempt index must be 0..2, received ${attemptIndex}`,
  );
}

export function maxAttemptIndexForArm(arm: DesignerArm): 0 | 1 | 2 {
  return arm === "ai_feedback" ? 2 : 0;
}

export function canArmRepair(arm: DesignerArm): boolean {
  return arm === "ai_feedback";
}

export function computeDesignAttemptHash(attempt: DesignAttemptRecord): string {
  return sha256Hex(canonicalJson(attempt));
}

export function attemptHasSavedResponse(
  attempt: Pick<DesignAttemptRecord, "artifacts" | "proposalArtifactId">,
): boolean {
  return (
    attempt.proposalArtifactId !== null ||
    attempt.artifacts.some(
      (artifact) =>
        artifact.role === "raw_response" || artifact.role === "proposal",
    )
  );
}

export function diagnosticForRepair(
  attempt: Pick<DesignAttemptRecord, "verdict" | "diagnostic">,
): DesignDiagnostic | null {
  if (attempt.verdict === "accepted" || attempt.verdict === "generation_error") {
    return null;
  }
  const diagnostic = attempt.diagnostic;
  if (diagnostic === null) {
    return null;
  }
  if (
    diagnostic.evidenceSource === "infrastructure" ||
    diagnostic.errorCode === "INFRASTRUCTURE_ERROR" ||
    diagnostic.errorCode === "PENDING_CHECKS" ||
    diagnostic.errorCode === "INPUT_TOO_LARGE"
  ) {
    return null;
  }
  return diagnostic;
}
