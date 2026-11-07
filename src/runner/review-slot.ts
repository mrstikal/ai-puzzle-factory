import type Database from "better-sqlite3";
import { z } from "zod";
import { addUsd } from "../ai/budget.js";
import { getLogicalCall, listAttempts } from "../ai/ledger.js";
import {
  mockScenarioForFamily,
  type MockScenarioKind,
  type MockTransport,
} from "../ai/mock.js";
import type { createOpenRouterTransport, OpenRouterCallResult } from "../ai/openrouter.js";
import type { ResolvedRoute } from "../ai/preflight.js";
import {
  ReviewAlignmentError,
  reviewAlignment,
} from "../ai/review-alignment.js";
import { ReviewTextError, reviewText } from "../ai/review-text.js";
import { ReviewVisionError, reviewVision } from "../ai/review-vision.js";
import {
  ALIGNMENT_REVIEW_STORED_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
} from "../ai/schemas.js";
import { ChoiceLabelSchema, type ChoiceLabel } from "../domain/answers.js";
import {
  CandidateDuplicateAssessmentSchema,
  FailureCodeSchema,
  FailureRecordSchema,
  WORKFLOW_STAGES,
  type CandidateDuplicateAssessment,
  type CandidateVerdict,
  type FailureRecord,
  type WorkflowStage,
} from "../domain/candidate.js";
import {
  Sha256Schema,
  SLOT_ID_PATTERN,
  UsdSchema,
  type Difficulty,
  type Family,
  type Modality,
} from "../domain/experiment.js";
import {
  PrimaryVerdictInputSchema,
  reducePrimaryVerdict,
  type PrimaryVerdictResult,
} from "../validation/verdict.js";
import {
  getRun,
  getSlot,
  getStageResult,
  insertStageResult,
  listStageResults,
} from "../storage/repository.js";
import { StorageError } from "../storage/database.js";
import { deriveStreamSeed } from "../util/random.js";

export type ReviewSlotErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STAGE"
  | "EVIDENCE_KIND_MISMATCH"
  | "MOCK_SCENARIO_IN_LIVE_MODE"
  | "UNEXPECTED_ROLE"
  | "INELIGIBLE_READY_CANDIDATE"
  | "INCOMPLETE_VERDICT";

export class ReviewSlotError extends Error {
  readonly code: ReviewSlotErrorCode;
  readonly result: PrimaryVerdictResult | null;

  constructor(
    code: ReviewSlotErrorCode,
    message: string,
    options: ErrorOptions & { readonly result?: PrimaryVerdictResult | null } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReviewSlotError";
    this.code = code;
    this.result = options.result ?? null;
  }
}

const ReviewProposalSchema = z.strictObject({
  promptVersion: z.string().min(1).max(64),
  promptHash: Sha256Schema,
  schemaName: z.string().min(1).max(128),
  schemaVersion: z.string().min(1).max(64),
  schemaHash: Sha256Schema,
});

const ReviewUsageSchema = z.strictObject({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedReadTokens: z.number().int().nonnegative().nullable(),
  cachedWriteTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});

export const DuplicateCheckedStagePayloadSchema = z.strictObject({
  version: z.literal(1),
  barrierResultHash: Sha256Schema,
  assessment: CandidateDuplicateAssessmentSchema,
});
export type DuplicateCheckedStagePayload = z.infer<
  typeof DuplicateCheckedStagePayloadSchema
>;

export const BlindReviewStagePayloadSchema = z
  .strictObject({
    version: z.literal(1),
    role: z.enum(["blind_text", "blind_vision"]),
    completed: z.boolean(),
    logicalCallId: z.uuid().nullable(),
    attemptIds: z.array(z.uuid()),
    review: BLIND_REVIEW_RESPONSE_SCHEMA.nullable(),
    choiceAgreement: z.enum(["agreed", "disagreed", "not_applicable"]).nullable(),
    expectedOption: ChoiceLabelSchema.nullable(),
    pngHash: Sha256Schema.nullable(),
    pngByteLength: z.number().int().positive().nullable(),
    proposal: ReviewProposalSchema.nullable(),
    usage: ReviewUsageSchema.nullable(),
    actualCostUsd: UsdSchema.nullable(),
    costStatus: z.enum(["known", "unknown", "not_applicable"]),
    failure: FailureRecordSchema.nullable(),
  })
  .superRefine((payload, ctx) => {
    if (payload.completed) {
      if (
        payload.review === null ||
        payload.logicalCallId === null ||
        payload.choiceAgreement === null ||
        payload.expectedOption === null ||
        payload.proposal === null ||
        payload.failure !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["completed"],
          message: "a completed blind review requires review, call, agreement, key, and proposal evidence",
        });
      }
      if (
        payload.role === "blind_text" &&
        (payload.pngHash !== null || payload.pngByteLength !== null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["pngHash"],
          message: "a text blind review cannot carry PNG evidence",
        });
      }
      if (
        payload.role === "blind_vision" &&
        (payload.pngHash === null || payload.pngByteLength === null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["pngHash"],
          message: "a vision blind review requires PNG evidence",
        });
      }
    } else if (
      payload.review !== null ||
      payload.choiceAgreement !== null ||
      payload.proposal !== null ||
      payload.failure === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["completed"],
        message: "an incomplete blind review carries only failure evidence",
      });
    }
    if ((payload.costStatus === "known") !== (payload.actualCostUsd !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["actualCostUsd"],
        message: "known cost requires an amount and other statuses omit it",
      });
    }
  });
export type BlindReviewStagePayload = z.infer<
  typeof BlindReviewStagePayloadSchema
>;

export const AlignmentReviewStagePayloadSchema = z
  .strictObject({
    version: z.literal(1),
    role: z.enum(["alignment_text", "alignment_vision"]),
    completed: z.boolean(),
    logicalCallId: z.uuid().nullable(),
    attemptIds: z.array(z.uuid()),
    review: ALIGNMENT_REVIEW_STORED_SCHEMA.nullable(),
    modelOverall: z.enum(["pass", "fail", "uncertain"]).nullable(),
    derivedOverall: z.enum(["pass", "fail", "uncertain"]).nullable(),
    overallMismatch: z.boolean().nullable(),
    concerns: z.array(z.unknown()),
    deterministicEvidence: z.unknown().nullable(),
    pngHash: Sha256Schema.nullable(),
    pngByteLength: z.number().int().positive().nullable(),
    proposal: ReviewProposalSchema.nullable(),
    usage: ReviewUsageSchema.nullable(),
    actualCostUsd: UsdSchema.nullable(),
    costStatus: z.enum(["known", "unknown", "not_applicable"]),
    failure: FailureRecordSchema.nullable(),
  })
  .superRefine((payload, ctx) => {
    if (payload.completed) {
      if (
        payload.review === null ||
        payload.logicalCallId === null ||
        payload.derivedOverall === null ||
        payload.overallMismatch === null ||
        payload.deterministicEvidence === null ||
        payload.proposal === null ||
        payload.failure !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["completed"],
          message: "a completed alignment review requires full model and deterministic evidence",
        });
      }
      if (
        payload.role === "alignment_text" &&
        (payload.pngHash !== null || payload.pngByteLength !== null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["pngHash"],
          message: "a text alignment review cannot carry PNG evidence",
        });
      }
      if (
        payload.role === "alignment_vision" &&
        (payload.pngHash === null || payload.pngByteLength === null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["pngHash"],
          message: "a vision alignment review requires PNG evidence",
        });
      }
    } else if (
      payload.review !== null ||
      payload.modelOverall !== null ||
      payload.derivedOverall !== null ||
      payload.overallMismatch !== null ||
      payload.concerns.length > 0 ||
      payload.deterministicEvidence !== null ||
      payload.proposal !== null ||
      payload.failure === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["completed"],
        message: "an incomplete alignment review carries only failure evidence",
      });
    }
    if ((payload.costStatus === "known") !== (payload.actualCostUsd !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["actualCostUsd"],
        message: "known cost requires an amount and other statuses omit it",
      });
    }
  });
export type AlignmentReviewStagePayload = z.infer<
  typeof AlignmentReviewStagePayloadSchema
>;

export const TerminalStagePayloadSchema = z.strictObject({
  version: z.literal(1),
  verdict: z.enum(["approved", "rejected", "inconclusive", "generation_error"]),
  completion: z.literal("complete"),
  proceed: z.boolean(),
  primaryFailure: FailureCodeSchema.nullable(),
  businessBlockers: z.array(FailureCodeSchema),
  failures: z.array(FailureRecordSchema),
  rationale: z.string().min(1).max(500),
  duplicateOutcome: CandidateDuplicateAssessmentSchema.shape.outcome,
  duplicateOwnerSlotId: z.string().regex(SLOT_ID_PATTERN).nullable(),
});
export type TerminalStagePayload = z.infer<typeof TerminalStagePayloadSchema>;

export interface ReviewSlotRoutes {
  readonly blindText: ResolvedRoute;
  readonly blindVision: ResolvedRoute;
  readonly alignmentText: ResolvedRoute;
  readonly alignmentVision: ResolvedRoute;
}

export interface ReviewSlotInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport> & {
    readonly isMock?: true;
  };
  readonly routes: ReviewSlotRoutes;
  readonly reservations: {
    readonly blind: string;
    readonly alignment: string;
  };
  readonly mockScenarioKinds?: {
    readonly blind?: MockScenarioKind;
    readonly alignment?: MockScenarioKind;
  };
  readonly clock?: { now(): Date };
  readonly yieldBetweenJobs?: () => Promise<void>;
  readonly resume?: boolean;
  readonly onStageCommitted?: (stage: WorkflowStage) => Promise<void> | void;
}

export interface ReviewedSlotResult {
  readonly status: "reviewed";
  readonly slotId: string;
  readonly verdict: CandidateVerdict;
  readonly stages: readonly WorkflowStage[];
  readonly blind: BlindReviewStagePayload | null;
  readonly alignment: AlignmentReviewStagePayload | null;
  readonly terminal: TerminalStagePayload;
}

export interface PreservedEarlyFailure {
  readonly status: "preserved";
  readonly slotId: string;
  readonly verdict: CandidateVerdict | null;
}

export type ReviewSlotOutcome = ReviewedSlotResult | PreservedEarlyFailure;

type ReviewAdapterError = ReviewTextError | ReviewVisionError | ReviewAlignmentError;

function nowIso(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

function boundEvidence(value: string, apiKey: string): string {
  const redacted = value.split(apiKey).join("[REDACTED]");
  return redacted.length <= 2000 ? redacted : `${redacted.slice(0, 1997)}...`;
}

function commitStage(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly stage: WorkflowStage;
  readonly startedAt: string;
  readonly clock: { now(): Date };
  readonly payload: unknown;
  readonly verdict?: CandidateVerdict;
}): void {
  const finishedAt = nowIso(input.clock);
  insertStageResult(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    stage: input.stage,
    startedAt: input.startedAt,
    finishedAt,
    elapsedMs: Math.max(0, Date.parse(finishedAt) - Date.parse(input.startedAt)),
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    createdAt: finishedAt,
    payload: input.payload,
  });
}

export function recordDuplicateAssessment(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly barrierResultHash: string;
  readonly assessment: CandidateDuplicateAssessment;
  readonly startedAt: string;
  readonly clock: { now(): Date };
}): void {
  const payload = DuplicateCheckedStagePayloadSchema.parse({
    version: 1,
    barrierResultHash: input.barrierResultHash,
    assessment: input.assessment,
  });
  commitStage({
    db: input.db,
    runId: input.runId,
    slotId: input.slotId,
    stage: "duplicate_checked",
    startedAt: input.startedAt,
    clock: input.clock,
    payload,
  });
}

function isReviewAdapterError(error: unknown): error is ReviewAdapterError {
  return (
    error instanceof ReviewTextError ||
    error instanceof ReviewVisionError ||
    error instanceof ReviewAlignmentError
  );
}

function reviewFailure(
  error: ReviewAdapterError,
  stage: "blind_reviewed" | "alignment_reviewed",
  apiKey: string,
): FailureRecord {
  const transport = error.code === "TRANSPORT_FAILED";
  const model =
    error.code === "MISSING_CONTENT" ||
    error.code === "INVALID_REVIEW" ||
    error.code === "INVALID_ALIGNMENT";
  return {
    code: transport ? "API_ERROR" : "SCHEMA_INVALID",
    stage,
    severity: "high",
    source: transport ? "infrastructure" : model ? "model" : "infrastructure",
    evidence: boundEvidence(
      `${error.code}: ${error.message}${
        error.issues.length === 0 ? "" : ` (${error.issues.join("; ")})`
      }`,
      apiKey,
    ),
  };
}

function reviewFailureFields(error: ReviewAdapterError): {
  readonly logicalCallId: string | null;
  readonly attemptIds: string[];
  readonly usage: ReviewUsageSchemaType | null;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
} {
  const result: OpenRouterCallResult | null = error.result;
  return {
    logicalCallId: error.logicalCallId,
    attemptIds: [...error.attemptIds],
    usage: result === null ? null : result.usage,
    actualCostUsd: result === null ? null : result.actualCostUsd,
    costStatus: result === null ? "not_applicable" : result.costStatus,
  };
}

type ReviewUsageSchemaType = z.infer<typeof ReviewUsageSchema>;

function instrumentReviewTransport(
  transport: MockTransport,
  db: Database.Database,
  run: { readonly protocolVersion: string; readonly rootSeed: string },
  slot: { readonly slotId: string; readonly family: Family; readonly difficulty: Difficulty },
  scenarioKinds: ReviewSlotInput["mockScenarioKinds"],
): ReturnType<typeof createOpenRouterTransport> {
  const seed = deriveStreamSeed({
    protocolVersion: run.protocolVersion,
    rootSeed: run.rootSeed,
    slotId: slot.slotId,
    purpose: "spec",
  });
  return {
    executeCall: async (input) => {
      const call = getLogicalCall(db, input.logicalCallId);
      if (
        call.role !== "blind_text" &&
        call.role !== "blind_vision" &&
        call.role !== "alignment_text" &&
        call.role !== "alignment_vision"
      ) {
        throw new ReviewSlotError(
          "UNEXPECTED_ROLE",
          `review preparation refused to register a scenario for ${call.role}`,
        );
      }
      const kind =
        (call.role.startsWith("blind")
          ? scenarioKinds?.blind
          : scenarioKinds?.alignment) ?? "valid";
      transport.registerScenario(
        input.logicalCallId,
        mockScenarioForFamily(call.role, slot.family, slot.difficulty, seed, kind),
      );
      return transport.executeCall({ ...input, nonBilling: true });
    },
    reconcileGeneration: transport.reconcileGeneration,
  };
}

function readExpectedOption(
  db: Database.Database,
  runId: string,
  slotId: string,
): ChoiceLabel {
  const stage = getStageResult(db, runId, slotId, "presentation_ready");
  const presentation = (stage.payload as { presentation?: unknown }).presentation;
  const reveal =
    presentation !== null && typeof presentation === "object"
      ? (presentation as { reveal?: unknown }).reveal
      : undefined;
  const label =
    reveal !== null && typeof reveal === "object"
      ? (reveal as { correctLabel?: unknown }).correctLabel
      : undefined;
  const parsed = ChoiceLabelSchema.safeParse(label);
  if (!parsed.success) {
    throw new ReviewSlotError(
      "INVALID_STAGE",
      "presentation_ready checkpoint is missing a valid correct label",
    );
  }
  return parsed.data;
}

function aggregateSlotCost(
  db: Database.Database,
  runId: string,
  slotId: string,
): { readonly actualCostUsd: string | null; readonly costStatus: "known" | "unknown" | "not_applicable" } {
  const rows = db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ? ORDER BY role, created_at, logical_call_id",
    )
    .all(runId, slotId) as Array<{ logical_call_id: string }>;
  let unknown = false;
  const known: string[] = [];
  for (const row of rows) {
    for (const attempt of listAttempts(db, row.logical_call_id)) {
      if (attempt.costStatus === "unknown") {
        unknown = true;
      } else if (
        attempt.costStatus === "known" &&
        attempt.actualCostUsd !== null
      ) {
        known.push(attempt.actualCostUsd);
      }
    }
  }
  if (unknown) {
    return { actualCostUsd: null, costStatus: "unknown" };
  }
  if (known.length === 0) {
    return { actualCostUsd: null, costStatus: "not_applicable" };
  }
  return { actualCostUsd: addUsd(...known), costStatus: "known" };
}

function blindEvidence(
  payload: BlindReviewStagePayload | null,
  expectedOption: ChoiceLabel | null,
  required: boolean,
): {
  required: boolean;
  completed: boolean;
  answerStatus: "selected" | "no_unique_answer" | "cannot_determine" | null;
  chosenOption: ChoiceLabel | null;
  expectedOption: ChoiceLabel | null;
  clarity: "clear" | "unclear" | null;
  ambiguity: "none" | "present" | "uncertain" | null;
  issues: number;
  visualLegibility: "legible" | "unclear" | "not_applicable" | null;
} {
  if (payload === null || !payload.completed || payload.review === null) {
    return {
      required,
      completed: false,
      answerStatus: null,
      chosenOption: null,
      expectedOption: null,
      clarity: null,
      ambiguity: null,
      issues: 0,
      visualLegibility: null,
    };
  }
  return {
    required,
    completed: true,
    answerStatus: payload.review.answerStatus,
    chosenOption: payload.review.chosenOption,
    expectedOption,
    clarity: payload.review.clarity,
    ambiguity: payload.review.ambiguity,
    issues: payload.review.issues.length,
    visualLegibility: payload.review.visualLegibility,
  };
}

function alignmentEvidence(
  payload: AlignmentReviewStagePayload | null,
  required: boolean,
): {
  required: boolean;
  completed: boolean;
  derivedOverall: "pass" | "fail" | "uncertain" | null;
} {
  if (payload === null || !payload.completed) {
    return { required, completed: false, derivedOverall: null };
  }
  return {
    required,
    completed: true,
    derivedOverall: payload.derivedOverall,
  };
}

async function runBlindReview(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly routes: ReviewSlotRoutes;
  readonly reservationUsd: string;
  readonly expectedOption: ChoiceLabel;
  readonly slot: { readonly family: Family; readonly modality: Modality; readonly difficulty: Difficulty };
  readonly clock: { now(): Date };
  readonly onStageCommitted?: (stage: WorkflowStage) => Promise<void> | void;
}): Promise<BlindReviewStagePayload> {
  const role = input.slot.modality === "text" ? "blind_text" : "blind_vision";
  const route =
    role === "blind_text" ? input.routes.blindText : input.routes.blindVision;
  const startedAt = nowIso(input.clock);
  try {
    let payload: BlindReviewStagePayload;
    if (role === "blind_text") {
      const result = await reviewText({
        db: input.db,
        accountId: input.accountId,
        apiKey: input.apiKey,
        transport: input.transport,
        runId: input.runId,
        slotId: input.slotId,
        route,
        reservationUsd: input.reservationUsd,
        clock: input.clock,
      });
      payload = BlindReviewStagePayloadSchema.parse({
        version: 1,
        role,
        completed: true,
        logicalCallId: result.logicalCallId,
        attemptIds: result.attempts.map((attempt) => attempt.attemptId),
        review: result.review,
        choiceAgreement: result.choiceAgreement,
        expectedOption: input.expectedOption,
        pngHash: null,
        pngByteLength: null,
        proposal: result.proposal,
        usage: result.usage,
        actualCostUsd: result.actualCostUsd,
        costStatus: result.costStatus,
        failure: null,
      });
    } else {
      const result = await reviewVision({
        db: input.db,
        accountId: input.accountId,
        apiKey: input.apiKey,
        transport: input.transport,
        runId: input.runId,
        slotId: input.slotId,
        route,
        reservationUsd: input.reservationUsd,
        clock: input.clock,
      });
      payload = BlindReviewStagePayloadSchema.parse({
        version: 1,
        role,
        completed: true,
        logicalCallId: result.logicalCallId,
        attemptIds: result.attempts.map((attempt) => attempt.attemptId),
        review: result.review,
        choiceAgreement: result.choiceAgreement,
        expectedOption: input.expectedOption,
        pngHash: result.pngHash,
        pngByteLength: result.pngByteLength,
        proposal: result.proposal,
        usage: result.usage,
        actualCostUsd: result.actualCostUsd,
        costStatus: result.costStatus,
        failure: null,
      });
    }
    commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      stage: "blind_reviewed",
      startedAt,
      clock: input.clock,
      payload,
    });
    await input.onStageCommitted?.("blind_reviewed");
    return payload;
  } catch (error) {
    if (!isReviewAdapterError(error)) {
      throw error;
    }
    const failure = reviewFailure(error, "blind_reviewed", input.apiKey);
    const fields = reviewFailureFields(error);
    const payload = BlindReviewStagePayloadSchema.parse({
      version: 1,
      role,
      completed: false,
      logicalCallId: fields.logicalCallId,
      attemptIds: fields.attemptIds,
      review: null,
      choiceAgreement: null,
      expectedOption: input.expectedOption,
      pngHash: null,
      pngByteLength: null,
      proposal: null,
      usage: fields.usage,
      actualCostUsd: fields.actualCostUsd,
      costStatus: fields.costStatus,
      failure,
    });
    commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      stage: "blind_reviewed",
      startedAt,
      clock: input.clock,
      payload,
    });
    await input.onStageCommitted?.("blind_reviewed");
    return payload;
  }
}

async function runAlignmentReview(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly routes: ReviewSlotRoutes;
  readonly reservationUsd: string;
  readonly slot: { readonly family: Family; readonly modality: Modality; readonly difficulty: Difficulty };
  readonly clock: { now(): Date };
  readonly onStageCommitted?: (stage: WorkflowStage) => Promise<void> | void;
}): Promise<AlignmentReviewStagePayload> {
  const role =
    input.slot.modality === "text" ? "alignment_text" : "alignment_vision";
  const route =
    role === "alignment_text"
      ? input.routes.alignmentText
      : input.routes.alignmentVision;
  const startedAt = nowIso(input.clock);
  try {
    const result = await reviewAlignment({
      db: input.db,
      accountId: input.accountId,
      apiKey: input.apiKey,
      transport: input.transport,
      runId: input.runId,
      slotId: input.slotId,
      route,
      reservationUsd: input.reservationUsd,
      clock: input.clock,
    });
    const payload = AlignmentReviewStagePayloadSchema.parse({
      version: 1,
      role,
      completed: true,
      logicalCallId: result.logicalCallId,
      attemptIds: result.attempts.map((attempt) => attempt.attemptId),
      review: result.review,
      modelOverall: result.modelOverall,
      derivedOverall: result.derivedOverall,
      overallMismatch: result.overallMismatch,
      concerns: result.concerns,
      deterministicEvidence: result.deterministicEvidence,
      pngHash: role === "alignment_vision" ? result.pngHash : null,
      pngByteLength: role === "alignment_vision" ? result.pngByteLength : null,
      proposal: result.proposal,
      usage: result.usage,
      actualCostUsd: result.actualCostUsd,
      costStatus: result.costStatus,
      failure: null,
    });
    commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      stage: "alignment_reviewed",
      startedAt,
      clock: input.clock,
      payload,
    });
    await input.onStageCommitted?.("alignment_reviewed");
    return payload;
  } catch (error) {
    if (!isReviewAdapterError(error)) {
      throw error;
    }
    const failure = reviewFailure(error, "alignment_reviewed", input.apiKey);
    const fields = reviewFailureFields(error);
    const payload = AlignmentReviewStagePayloadSchema.parse({
      version: 1,
      role,
      completed: false,
      logicalCallId: fields.logicalCallId,
      attemptIds: fields.attemptIds,
      review: null,
      modelOverall: null,
      derivedOverall: null,
      overallMismatch: null,
      concerns: [],
      deterministicEvidence: null,
      pngHash: null,
      pngByteLength: null,
      proposal: null,
      usage: fields.usage,
      actualCostUsd: fields.actualCostUsd,
      costStatus: fields.costStatus,
      failure,
    });
    commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      stage: "alignment_reviewed",
      startedAt,
      clock: input.clock,
      payload,
    });
    await input.onStageCommitted?.("alignment_reviewed");
    return payload;
  }
}

export async function reviewSlot(
  input: ReviewSlotInput,
): Promise<ReviewSlotOutcome> {
  const run = getRun(input.db, input.runId);
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (slot.stage === "terminal") {
    if (slot.verdict === null) {
      throw new ReviewSlotError(
        "INVALID_STAGE",
        "terminal slot is missing its verdict",
      );
    }
    return { status: "preserved", slotId: slot.slotId, verdict: slot.verdict };
  }
  const resumableStages: readonly WorkflowStage[] = [
    "duplicate_checked",
    "blind_reviewed",
    "alignment_reviewed",
  ];
  if (!input.resume && slot.stage !== "duplicate_checked") {
    throw new ReviewSlotError(
      "INVALID_STAGE",
      `review requires duplicate_checked, received ${slot.stage}`,
    );
  }
  if (input.resume && !resumableStages.includes(slot.stage)) {
    throw new ReviewSlotError(
      "INVALID_STAGE",
      `slot ${slot.slotId} is at ${slot.stage} and cannot resume review`,
    );
  }
  const isMock = input.transport.isMock === true;
  if (run.evidenceKind === "mock" && !isMock) {
    throw new ReviewSlotError(
      "EVIDENCE_KIND_MISMATCH",
      "mock runs require the deterministic mock transport",
    );
  }
  if (run.evidenceKind === "live" && isMock) {
    throw new ReviewSlotError(
      "EVIDENCE_KIND_MISMATCH",
      "live runs cannot use the deterministic mock transport",
    );
  }
  if (!isMock && input.mockScenarioKinds !== undefined) {
    throw new ReviewSlotError(
      "MOCK_SCENARIO_IN_LIVE_MODE",
      "mock review scenarios are only valid with the mock transport",
    );
  }
  const duplicateStage = getStageResult(
    input.db,
    input.runId,
    input.slotId,
    "duplicate_checked",
  );
  const duplicatePayload = DuplicateCheckedStagePayloadSchema.parse(
    duplicateStage.payload,
  );
  const assessment = duplicatePayload.assessment;
  if (assessment.slotId !== slot.slotId) {
    throw new ReviewSlotError(
      "INVALID_STAGE",
      "duplicate assessment does not belong to the reviewed slot",
    );
  }
  const shouldReview =
    assessment.eligible &&
    (assessment.outcome === "owner" ||
      assessment.outcome === "unique" ||
      assessment.outcome === "near_suspected");
  if (!assessment.eligible) {
    throw new ReviewSlotError(
      "INELIGIBLE_READY_CANDIDATE",
      "ready candidate has an ineligible duplicate assessment",
    );
  }

  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = nowIso(clock);
  const expectedOption = shouldReview
    ? readExpectedOption(input.db, input.runId, input.slotId)
    : null;
  const transport = isMock
    ? instrumentReviewTransport(
        input.transport as MockTransport,
        input.db,
        run,
        slot,
        input.mockScenarioKinds,
      )
    : input.transport;

  let blind: BlindReviewStagePayload | null = null;
  let alignment: AlignmentReviewStagePayload | null = null;
  if (input.resume && slot.stage === "blind_reviewed") {
    if (!shouldReview) {
      throw new ReviewSlotError(
        "INVALID_STAGE",
        "a confirmed duplicate cannot resume from blind_reviewed",
      );
    }
    blind = BlindReviewStagePayloadSchema.parse(
      getStageResult(input.db, input.runId, input.slotId, "blind_reviewed")
        .payload,
    );
    await input.yieldBetweenJobs?.();
    if (getRun(input.db, input.runId).controlState === "running") {
      alignment = await runAlignmentReview({
        db: input.db,
        runId: input.runId,
        slotId: input.slotId,
        accountId: input.accountId,
        apiKey: input.apiKey,
        transport,
        routes: input.routes,
        reservationUsd: input.reservations.alignment,
        slot,
        clock,
        ...(input.onStageCommitted === undefined
          ? {}
          : { onStageCommitted: input.onStageCommitted }),
      });
    }
  } else if (input.resume && slot.stage === "alignment_reviewed") {
    if (shouldReview) {
      try {
        blind = BlindReviewStagePayloadSchema.parse(
          getStageResult(input.db, input.runId, input.slotId, "blind_reviewed")
            .payload,
        );
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "NOT_FOUND") {
          throw error;
        }
      }
    }
    alignment = AlignmentReviewStagePayloadSchema.parse(
      getStageResult(
        input.db,
        input.runId,
        input.slotId,
        "alignment_reviewed",
      ).payload,
    );
  } else if (shouldReview) {
    blind = await runBlindReview({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      accountId: input.accountId,
      apiKey: input.apiKey,
      transport,
      routes: input.routes,
      reservationUsd: input.reservations.blind,
      expectedOption: expectedOption as ChoiceLabel,
      slot,
      clock,
      ...(input.onStageCommitted === undefined
        ? {}
        : { onStageCommitted: input.onStageCommitted }),
    });
    await input.yieldBetweenJobs?.();
    if (getRun(input.db, input.runId).controlState === "running") {
      alignment = await runAlignmentReview({
        db: input.db,
        runId: input.runId,
        slotId: input.slotId,
        accountId: input.accountId,
        apiKey: input.apiKey,
        transport,
        routes: input.routes,
        reservationUsd: input.reservations.alignment,
        slot,
        clock,
        ...(input.onStageCommitted === undefined
          ? {}
          : { onStageCommitted: input.onStageCommitted }),
      });
    }
  }

  await input.yieldBetweenJobs?.();
  const cost = aggregateSlotCost(input.db, input.runId, input.slotId);
  const failures: FailureRecord[] = [];
  if (blind?.failure !== null && blind?.failure !== undefined) {
    failures.push(blind.failure);
  }
  if (alignment?.failure !== null && alignment?.failure !== undefined) {
    failures.push(alignment.failure);
  }
  if (cost.costStatus === "unknown") {
    failures.push({
      code: "COST_UNKNOWN",
      stage: "terminal",
      severity: "medium",
      source: "infrastructure",
      evidence: "at least one review attempt has an unknown actual cost",
    });
  }
  const verdictInput = PrimaryVerdictInputSchema.parse({
    version: 1,
    slotId: slot.slotId,
    family: slot.family,
    modality: slot.modality,
    runControl: run.controlState,
    preparation: "ready",
    generation: { state: "usable" },
    formalPassed: true,
    presentationPassed: true,
    duplicate: {
      outcome: assessment.outcome,
      ownerSlotId: assessment.ownerSlotId,
      nearPairSlotIds: assessment.nearPairSlotIds,
    },
    blind: blindEvidence(blind, expectedOption, shouldReview),
    alignment: alignmentEvidence(alignment, shouldReview),
    costStatus: cost.costStatus,
    failures,
  });
  const verdict = reducePrimaryVerdict(verdictInput);
  if (verdict.verdict === null || verdict.completion !== "complete") {
    throw new ReviewSlotError(
      "INCOMPLETE_VERDICT",
      `verdict reduction returned ${verdict.completion} without a terminal verdict`,
      { result: verdict },
    );
  }
  const terminalPayload = TerminalStagePayloadSchema.parse({
    version: 1,
    verdict: verdict.verdict,
    completion: verdict.completion,
    proceed: verdict.proceed,
    primaryFailure: verdict.primaryFailure,
    businessBlockers: verdict.businessBlockers,
    failures: verdict.failures,
    rationale: verdict.rationale,
    duplicateOutcome: assessment.outcome,
    duplicateOwnerSlotId: assessment.ownerSlotId,
  });
  commitStage({
    db: input.db,
    runId: input.runId,
    slotId: input.slotId,
    stage: "terminal",
    startedAt,
    clock,
    verdict: verdict.verdict,
    payload: terminalPayload,
  });
  const stages = listStageResults(input.db, input.runId, input.slotId)
    .map((stage) => stage.stage)
    .sort(
      (left, right) =>
        WORKFLOW_STAGES.indexOf(left) - WORKFLOW_STAGES.indexOf(right),
    );
  return {
    status: "reviewed",
    slotId: slot.slotId,
    verdict: verdict.verdict,
    stages,
    blind,
    alignment,
    terminal: terminalPayload,
  };
}
