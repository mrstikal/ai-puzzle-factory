import { z } from "zod";
import { Sha256Schema } from "./experiment.js";

export const WORKFLOW_STAGES = [
  "planned",
  "spec_ready",
  "formal_checked",
  "presentation_ready",
  "duplicate_checked",
  "blind_reviewed",
  "alignment_reviewed",
  "terminal",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const RUN_CONTROL_STATES = [
  "running",
  "paused_budget",
  "paused_operator",
  "interrupted",
  "completed",
  "failed",
] as const;

export type RunControlState = (typeof RUN_CONTROL_STATES)[number];

export const CANDIDATE_VERDICTS = [
  "approved",
  "rejected",
  "inconclusive",
  "generation_error",
] as const;

export type CandidateVerdict = (typeof CANDIDATE_VERDICTS)[number];

export const FAILURE_CODES = [
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
  "SVG_RENDER_INVALID",
  "VISUAL_AMBIGUITY",
  "COST_UNKNOWN",
  "API_ERROR",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export const EVIDENCE_SOURCES = ["deterministic", "model", "human", "infrastructure"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const FAILURE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type FailureSeverity = (typeof FAILURE_SEVERITIES)[number];

export const WorkflowStageSchema = z.enum(WORKFLOW_STAGES);
export const RunControlStateSchema = z.enum(RUN_CONTROL_STATES);
export const CandidateVerdictSchema = z.enum(CANDIDATE_VERDICTS);
export const FailureCodeSchema = z.enum(FAILURE_CODES);
export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export const FailureSeveritySchema = z.enum(FAILURE_SEVERITIES);

export const FailureRecordSchema = z.strictObject({
  code: FailureCodeSchema,
  stage: WorkflowStageSchema,
  severity: FailureSeveritySchema,
  source: EvidenceSourceSchema,
  evidence: z.string().max(2000).nullable(),
});

export type FailureRecord = z.infer<typeof FailureRecordSchema>;

export const CandidateEnvelopeSchema = z
  .strictObject({
    runId: z.uuid(),
    slotId: z.string().min(1),
    stage: WorkflowStageSchema,
    verdict: CandidateVerdictSchema.nullable(),
    failures: z.array(FailureRecordSchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((candidate, ctx) => {
    const isTerminal = candidate.stage === "terminal";
    if (isTerminal && candidate.verdict === null) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "a terminal candidate envelope requires a primary verdict",
      });
    }
    if (!isTerminal && candidate.verdict !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "a non-terminal candidate envelope cannot carry a primary verdict",
      });
    }
  });

export type CandidateEnvelope = z.infer<typeof CandidateEnvelopeSchema>;

export const StageResultEnvelopeSchema = z
  .strictObject({
    runId: z.uuid(),
    slotId: z.string().min(1),
    stage: WorkflowStageSchema,
    version: z.literal(1),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
    payloadHash: Sha256Schema,
    artifactHashes: z.array(Sha256Schema),
  })
  .superRefine((stage, ctx) => {
    if (stage.finishedAt === null && stage.elapsedMs !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["elapsedMs"],
        message: "elapsedMs must be null while finishedAt is null",
      });
    }
    if (stage.finishedAt !== null && stage.elapsedMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["elapsedMs"],
        message: "a finished stage requires a measured elapsedMs",
      });
    }
  });

export type StageResultEnvelope = z.infer<typeof StageResultEnvelopeSchema>;
