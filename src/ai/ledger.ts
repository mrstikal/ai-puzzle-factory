import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  REQUEST_ROLES,
  SLOT_ID_PATTERN,
  Sha256Schema,
  UsdSchema,
} from "../domain/experiment.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { ARTIFACT_LIMITS } from "../storage/artifacts.js";
import { withTransaction } from "../storage/database.js";

export const LEDGER_ROLES = [...REQUEST_ROLES, "preflight"] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];
export const LedgerRoleSchema = z.enum(LEDGER_ROLES);

export const LEDGER_RUN_KINDS = ["full", "smoke", "calibration", "preflight"] as const;
export type LedgerRunKind = (typeof LEDGER_RUN_KINDS)[number];
export const LedgerRunKindSchema = z.enum(LEDGER_RUN_KINDS);

export const BUDGET_POOLS = ["primary", "smoke", "calibration", "preflight"] as const;
export type BudgetPool = (typeof BUDGET_POOLS)[number];
export const BudgetPoolSchema = z.enum(BUDGET_POOLS);

export const REQUEST_STATES = [
  "prepared",
  "dispatching",
  "response_saved",
  "validated",
  "refused_unprocessed",
  "failed_known",
  "uncertain",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export const RequestStateSchema = z.enum(REQUEST_STATES);

export const REQUEST_BODY_LIMIT = 65_536;
export const MAX_PNG_BYTES = 1_048_576;
export const MAX_STORED_REQUEST_BYTES = 2_097_152;
export const MAX_ATTEMPTS = 3;

export type LedgerErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STORED_DATA"
  | "NOT_FOUND"
  | "DUPLICATE_LOGICAL_CALL"
  | "DUPLICATE_ATTEMPT"
  | "TOO_MANY_ATTEMPTS"
  | "INVALID_STATE"
  | "RESERVATION_REQUIRED"
  | "REQUEST_TOO_LARGE"
  | "UNSUPPORTED_MEDIA"
  | "RUN_KIND_MISMATCH"
  | "CONSTRAINT_VIOLATION";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LedgerError";
    this.code = code;
  }
}

const requiredJsonSchema = z
  .unknown()
  .refine((value) => value !== undefined, "requestBody is required");

function poolForRunKind(runKind: LedgerRunKind): BudgetPool {
  switch (runKind) {
    case "full":
      return "primary";
    case "smoke":
      return "smoke";
    case "calibration":
      return "calibration";
    case "preflight":
      return "preflight";
  }
}

export const LogicalCallInputSchema = z
  .strictObject({
    logicalCallId: z.uuid().optional(),
    runId: z.uuid().nullable().optional(),
    slotId: z.string().regex(SLOT_ID_PATTERN).nullable().optional(),
    probeKey: z.string().min(1).max(200).nullable().optional(),
    role: LedgerRoleSchema,
    runKind: LedgerRunKindSchema,
    requestBody: requiredJsonSchema,
    requestHash: Sha256Schema.optional(),
    expectedSchemaHash: Sha256Schema,
    model: z.string().min(1).max(200),
    provider: z.string().min(1).max(200),
    outputCapField: z.enum(["max_tokens", "max_completion_tokens"]).nullable().optional(),
    createdAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    const runId = input.runId ?? null;
    const slotId = input.slotId ?? null;
    const probeKey = input.probeKey ?? null;
    if (input.runKind === "full" || input.runKind === "smoke") {
      if (runId === null || slotId === null || probeKey !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["runId"],
          message: "full/smoke calls require runId and slotId and no probeKey",
        });
      }
      if (input.role === "preflight") {
        ctx.addIssue({
          code: "custom",
          path: ["role"],
          message: "only preflight calls use the preflight role",
        });
      }
    } else if (input.runKind === "calibration") {
      if (runId !== null || slotId !== null || probeKey === null) {
        ctx.addIssue({
          code: "custom",
          path: ["probeKey"],
          message: "calibration calls require a probeKey and no run/slot",
        });
      }
      if (
        input.role !== "blind_text" &&
        input.role !== "blind_vision" &&
        input.role !== "alignment_text" &&
        input.role !== "alignment_vision"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["role"],
          message: "calibration uses review roles with fixture keys",
        });
      }
    } else if (runId !== null || slotId !== null || probeKey === null) {
      ctx.addIssue({
        code: "custom",
        path: ["probeKey"],
        message: "preflight calls require a probeKey and no run/slot",
      });
    }
    if (input.runKind === "preflight" && input.role !== "preflight") {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "preflight run kind requires the preflight role",
      });
    }
  });

export type LogicalCallInput = z.infer<typeof LogicalCallInputSchema>;

export const LogicalCallSchema = z
  .strictObject({
    logicalCallId: z.uuid(),
    runId: z.uuid().nullable(),
    slotId: z.string().regex(SLOT_ID_PATTERN).nullable(),
    probeKey: z.string().min(1).max(200).nullable(),
    role: LedgerRoleSchema,
    runKind: LedgerRunKindSchema,
    pool: BudgetPoolSchema,
    state: RequestStateSchema,
    requestHash: Sha256Schema,
    requestBody: requiredJsonSchema,
    expectedSchemaHash: Sha256Schema,
    model: z.string().min(1).max(200),
    provider: z.string().min(1).max(200),
    outputCapField: z.enum(["max_tokens", "max_completion_tokens"]).nullable(),
    retryNotBefore: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((call, ctx) => {
    if (call.requestHash !== sha256Hex(canonicalJson(call.requestBody))) {
      ctx.addIssue({
        code: "custom",
        path: ["requestHash"],
        message: "logical call request hash does not match its request body",
      });
    }
    if (call.pool !== poolForRunKind(call.runKind)) {
      ctx.addIssue({
        code: "custom",
        path: ["pool"],
        message: "logical call pool does not match its run kind",
      });
    }
  });

export type LogicalCall = z.infer<typeof LogicalCallSchema>;

export const AttemptInputSchema = z.strictObject({
  logicalCallId: z.uuid(),
  createdAt: z.iso.datetime().optional(),
});

export type AttemptInput = z.infer<typeof AttemptInputSchema>;

export const RequestAttemptSchema = z
  .strictObject({
    attemptId: z.uuid(),
    logicalCallId: z.uuid(),
    attemptNumber: z.number().int().min(1).max(MAX_ATTEMPTS),
    state: RequestStateSchema,
    requestHash: Sha256Schema,
    requestBody: requiredJsonSchema,
    expectedSchemaHash: Sha256Schema,
    role: LedgerRoleSchema,
    model: z.string().min(1).max(200),
    provider: z.string().min(1).max(200),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    responseId: z.string().min(1).max(200).nullable(),
    generationId: z.string().min(1).max(200).nullable(),
    rawResponseArtifactId: z.number().int().positive().nullable(),
    finishReason: z.string().min(1).max(200).nullable(),
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cachedReadTokens: z.number().int().nonnegative().nullable(),
    cachedWriteTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    priceEstimateUsd: UsdSchema.nullable(),
    actualCostUsd: UsdSchema.nullable(),
    costStatus: z.enum(["known", "unknown"]),
    errorClassification: z.string().min(1).max(200).nullable(),
    partialCompletion: z.boolean(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((attempt, ctx) => {
    if (attempt.requestHash !== sha256Hex(canonicalJson(attempt.requestBody))) {
      ctx.addIssue({
        code: "custom",
        path: ["requestHash"],
        message: "attempt request hash does not match its request body",
      });
    }
    if ((attempt.costStatus === "known") !== (attempt.actualCostUsd !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["actualCostUsd"],
        message: "known cost requires an actual cost and unknown cost must omit it",
      });
    }
    if ((attempt.finishedAt === null) !== (attempt.elapsedMs === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["elapsedMs"],
        message: "finishedAt and elapsedMs must both be present or both be null",
      });
    }
  });

export type RequestAttempt = z.infer<typeof RequestAttemptSchema>;

export const RequestEventSchema = z.strictObject({
  eventId: z.number().int().positive(),
  logicalCallId: z.uuid(),
  attemptId: z.uuid().nullable(),
  eventType: z.string().min(1).max(64),
  fromState: RequestStateSchema.nullable(),
  toState: RequestStateSchema.nullable(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
});

export type RequestEvent = z.infer<typeof RequestEventSchema>;

export const SaveAttemptResponseInputSchema = z
  .strictObject({
    attemptId: z.uuid(),
    finishedAt: z.iso.datetime(),
    elapsedMs: z.number().int().nonnegative(),
    httpStatus: z.number().int().min(100).max(599),
    responseId: z.string().min(1).max(200).nullable().optional(),
    generationId: z.string().min(1).max(200).nullable().optional(),
    rawResponseArtifactId: z.number().int().positive().nullable().optional(),
    finishReason: z.string().min(1).max(200).nullable().optional(),
    promptTokens: z.number().int().nonnegative().nullable().optional(),
    completionTokens: z.number().int().nonnegative().nullable().optional(),
    totalTokens: z.number().int().nonnegative().nullable().optional(),
    cachedReadTokens: z.number().int().nonnegative().nullable().optional(),
    cachedWriteTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningTokens: z.number().int().nonnegative().nullable().optional(),
    priceEstimateUsd: UsdSchema.nullable().optional(),
    actualCostUsd: UsdSchema.nullable().optional(),
    errorClassification: z.string().min(1).max(200).nullable().optional(),
    partialCompletion: z.boolean().optional(),
    updatedAt: z.iso.datetime().optional(),
  });

export type SaveAttemptResponseInput = z.infer<typeof SaveAttemptResponseInputSchema>;

interface LogicalCallRow {
  logical_call_id: string;
  run_id: string | null;
  slot_id: string | null;
  probe_key: string | null;
  role: string;
  run_kind: string;
  pool: string;
  state: string;
  request_hash: string;
  request_body_json: string;
  expected_schema_hash: string;
  model: string;
  provider: string;
  output_cap_field: string | null;
  retry_not_before: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestAttemptRow {
  attempt_id: string;
  logical_call_id: string;
  attempt_number: number;
  state: string;
  request_hash: string;
  request_body_json: string;
  expected_schema_hash: string;
  role: string;
  model: string;
  provider: string;
  http_status: number | null;
  response_id: string | null;
  generation_id: string | null;
  raw_response_artifact_id: number | null;
  finish_reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  reasoning_tokens: number | null;
  price_estimate_usd: string | null;
  actual_cost_usd: string | null;
  cost_status: string;
  error_classification: string | null;
  partial_completion: number;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  created_at: string;
  updated_at: string;
}

interface RequestEventRow {
  event_id: number;
  logical_call_id: string;
  attempt_id: string | null;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload_json: string;
  created_at: string;
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new LedgerError("INVALID_STORED_DATA", `${context} is invalid`, {
      cause: result.error,
    });
  }
  return result.data;
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new LedgerError("INVALID_STORED_DATA", `${context} is not valid JSON`, {
      cause: error,
    });
  }
}

function stripBase64Images(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/png;base64,")) {
      const bytes = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
      if (bytes.byteLength > MAX_PNG_BYTES) {
        throw new LedgerError(
          "REQUEST_TOO_LARGE",
          `embedded PNG exceeds ${MAX_PNG_BYTES} bytes`,
        );
      }
      return "<base64-png>";
    }
    if (value.startsWith("data:image/")) {
      throw new LedgerError(
        "UNSUPPORTED_MEDIA",
        "only PNG data URLs are supported in request bodies",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripBase64Images);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        stripBase64Images(item),
      ]),
    );
  }
  return value;
}

export function prepareRequestBody(value: unknown): { json: string; hash: string } {
  let json: string;
  let textJson: string;
  try {
    json = canonicalJson(value);
    textJson = canonicalJson(stripBase64Images(value));
  } catch (error) {
    if (error instanceof LedgerError) {
      throw error;
    }
    throw new LedgerError("INVALID_INPUT", "request body is not JSON-serializable", {
      cause: error,
    });
  }
  if (Buffer.byteLength(json, "utf8") > MAX_STORED_REQUEST_BYTES) {
    throw new LedgerError(
      "REQUEST_TOO_LARGE",
      `stored request body exceeds ${MAX_STORED_REQUEST_BYTES} bytes`,
    );
  }
  if (Buffer.byteLength(textJson, "utf8") > REQUEST_BODY_LIMIT) {
    throw new LedgerError(
      "REQUEST_TOO_LARGE",
      `request text excluding base64 exceeds ${REQUEST_BODY_LIMIT} bytes`,
    );
  }
  return { json, hash: sha256Hex(json) };
}

function constraintCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function rowToLogicalCall(row: LogicalCallRow): LogicalCall {
  return parseStored(
    LogicalCallSchema,
    {
      logicalCallId: row.logical_call_id,
      runId: row.run_id,
      slotId: row.slot_id,
      probeKey: row.probe_key,
      role: row.role,
      runKind: row.run_kind,
      pool: row.pool,
      state: row.state,
      requestHash: row.request_hash,
      requestBody: parseJson(row.request_body_json, "logical call request body"),
      expectedSchemaHash: row.expected_schema_hash,
      model: row.model,
      provider: row.provider,
      outputCapField: row.output_cap_field,
      retryNotBefore: row.retry_not_before,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `logical call ${row.logical_call_id}`,
  );
}

function rowToAttempt(row: RequestAttemptRow): RequestAttempt {
  return parseStored(
    RequestAttemptSchema,
    {
      attemptId: row.attempt_id,
      logicalCallId: row.logical_call_id,
      attemptNumber: row.attempt_number,
      state: row.state,
      requestHash: row.request_hash,
      requestBody: parseJson(row.request_body_json, "attempt request body"),
      expectedSchemaHash: row.expected_schema_hash,
      role: row.role,
      model: row.model,
      provider: row.provider,
      httpStatus: row.http_status,
      responseId: row.response_id,
      generationId: row.generation_id,
      rawResponseArtifactId: row.raw_response_artifact_id,
      finishReason: row.finish_reason,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      cachedReadTokens: row.cached_read_tokens,
      cachedWriteTokens: row.cached_write_tokens,
      reasoningTokens: row.reasoning_tokens,
      priceEstimateUsd: row.price_estimate_usd,
      actualCostUsd: row.actual_cost_usd,
      costStatus: row.cost_status,
      errorClassification: row.error_classification,
      partialCompletion: row.partial_completion === 1,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedMs: row.elapsed_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `request attempt ${row.attempt_id}`,
  );
}

function rowToEvent(row: RequestEventRow): RequestEvent {
  return parseStored(
    RequestEventSchema,
    {
      eventId: row.event_id,
      logicalCallId: row.logical_call_id,
      attemptId: row.attempt_id,
      eventType: row.event_type,
      fromState: row.from_state,
      toState: row.to_state,
      payload: parseJson(row.payload_json, "request event payload"),
      createdAt: row.created_at,
    },
    `request event ${row.event_id}`,
  );
}

function insertRequestEvent(
  db: Database.Database,
  input: {
    logicalCallId: string;
    attemptId: string | null;
    eventType: string;
    fromState: RequestState | null;
    toState: RequestState | null;
    payload: unknown;
    createdAt: string;
  },
): void {
  const payloadJson = canonicalJson(input.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > ARTIFACT_LIMITS.json) {
    throw new LedgerError("REQUEST_TOO_LARGE", "request event payload exceeds 2 MiB");
  }
  db.prepare(
    "INSERT INTO request_events (logical_call_id, attempt_id, event_type, from_state, to_state, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.logicalCallId,
    input.attemptId,
    input.eventType,
    input.fromState,
    input.toState,
    payloadJson,
    input.createdAt,
  );
}

const ALLOWED_CALL_TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  prepared: ["dispatching", "refused_unprocessed", "failed_known", "uncertain"],
  dispatching: ["response_saved", "refused_unprocessed", "failed_known", "uncertain"],
  response_saved: ["validated", "refused_unprocessed", "failed_known", "uncertain"],
  validated: [],
  refused_unprocessed: ["prepared"],
  failed_known: [],
  uncertain: [],
};

function assertCallTransition(current: RequestState, next: RequestState): void {
  if (!ALLOWED_CALL_TRANSITIONS[current].includes(next)) {
    throw new LedgerError(
      "INVALID_STATE",
      `logical call cannot move from ${current} to ${next}`,
    );
  }
}

function updateCallState(
  db: Database.Database,
  call: LogicalCall,
  next: RequestState,
  updatedAt: string,
): void {
  if (call.state === next) {
    return;
  }
  assertCallTransition(call.state, next);
  db.prepare("UPDATE logical_calls SET state = ?, updated_at = ? WHERE logical_call_id = ?").run(
    next,
    updatedAt,
    call.logicalCallId,
  );
  insertRequestEvent(db, {
    logicalCallId: call.logicalCallId,
    attemptId: null,
    eventType: "call_state",
    fromState: call.state,
    toState: next,
    payload: {},
    createdAt: updatedAt,
  });
}

function getLogicalCallRow(
  db: Database.Database,
  logicalCallId: string,
): LogicalCallRow | undefined {
  return db
    .prepare(
      "SELECT logical_call_id, run_id, slot_id, probe_key, role, run_kind, pool, state, request_hash, request_body_json, expected_schema_hash, model, provider, output_cap_field, retry_not_before, created_at, updated_at FROM logical_calls WHERE logical_call_id = ?",
    )
    .get(logicalCallId) as LogicalCallRow | undefined;
}

function getAttemptRow(
  db: Database.Database,
  attemptId: string,
): RequestAttemptRow | undefined {
  return db
    .prepare(
      "SELECT attempt_id, logical_call_id, attempt_number, state, request_hash, request_body_json, expected_schema_hash, role, model, provider, http_status, response_id, generation_id, raw_response_artifact_id, finish_reason, prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, cached_write_tokens, reasoning_tokens, price_estimate_usd, actual_cost_usd, cost_status, error_classification, partial_completion, started_at, finished_at, elapsed_ms, created_at, updated_at FROM request_attempts WHERE attempt_id = ?",
    )
    .get(attemptId) as RequestAttemptRow | undefined;
}

export function getLogicalCall(db: Database.Database, logicalCallId: string): LogicalCall {
  const row = getLogicalCallRow(db, logicalCallId);
  if (row === undefined) {
    throw new LedgerError("NOT_FOUND", `logical call not found: ${logicalCallId}`);
  }
  return rowToLogicalCall(row);
}

export function setLogicalCallRetryNotBefore(
  db: Database.Database,
  logicalCallId: string,
  retryNotBefore: string | null,
  updatedAt = new Date().toISOString(),
): LogicalCall {
  const call = getLogicalCall(db, logicalCallId);
  withTransaction(db, () => {
    db.prepare(
      "UPDATE logical_calls SET retry_not_before = ?, updated_at = ? WHERE logical_call_id = ?",
    ).run(retryNotBefore, updatedAt, logicalCallId);
    insertRequestEvent(db, {
      logicalCallId,
      attemptId: null,
      eventType: "retry_not_before",
      fromState: call.state,
      toState: call.state,
      payload: { retryNotBefore },
      createdAt: updatedAt,
    });
  });
  return getLogicalCall(db, logicalCallId);
}

export function getAttempt(db: Database.Database, attemptId: string): RequestAttempt {
  const row = getAttemptRow(db, attemptId);
  if (row === undefined) {
    throw new LedgerError("NOT_FOUND", `request attempt not found: ${attemptId}`);
  }
  return rowToAttempt(row);
}

export function listAttempts(
  db: Database.Database,
  logicalCallId: string,
): RequestAttempt[] {
  const rows = db
    .prepare(
      "SELECT attempt_id, logical_call_id, attempt_number, state, request_hash, request_body_json, expected_schema_hash, role, model, provider, http_status, response_id, generation_id, raw_response_artifact_id, finish_reason, prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, cached_write_tokens, reasoning_tokens, price_estimate_usd, actual_cost_usd, cost_status, error_classification, partial_completion, started_at, finished_at, elapsed_ms, created_at, updated_at FROM request_attempts WHERE logical_call_id = ? ORDER BY attempt_number",
    )
    .all(logicalCallId) as RequestAttemptRow[];
  return rows.map(rowToAttempt);
}

export function listRequestEvents(
  db: Database.Database,
  logicalCallId: string,
): RequestEvent[] {
  const rows = db
    .prepare(
      "SELECT event_id, logical_call_id, attempt_id, event_type, from_state, to_state, payload_json, created_at FROM request_events WHERE logical_call_id = ? ORDER BY event_id",
    )
    .all(logicalCallId) as RequestEventRow[];
  return rows.map(rowToEvent);
}

export function createLogicalCall(
  db: Database.Database,
  input: unknown,
): LogicalCall {
  const parsed = LogicalCallInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new LedgerError("INVALID_INPUT", "invalid logical call input", {
      cause: parsed.error,
    });
  }
  const call = parsed.data;
  const body = prepareRequestBody(call.requestBody);
  if (call.requestHash !== undefined && call.requestHash !== body.hash) {
    throw new LedgerError(
      "INVALID_INPUT",
      "supplied request hash does not match the canonical request body",
    );
  }
  const runId = call.runId ?? null;
  const slotId = call.slotId ?? null;
  const probeKey = call.probeKey ?? null;
  const createdAt = call.createdAt ?? new Date().toISOString();
  const logicalCallId = call.logicalCallId ?? randomUUID();
  const pool = poolForRunKind(call.runKind);

  if (runId !== null) {
    const run = db.prepare("SELECT run_kind FROM runs WHERE run_id = ?").get(runId) as
      | { run_kind: string }
      | undefined;
    if (run === undefined) {
      throw new LedgerError("NOT_FOUND", `run not found: ${runId}`);
    }
    if (run.run_kind !== call.runKind) {
      throw new LedgerError(
        "RUN_KIND_MISMATCH",
        `logical call run kind ${call.runKind} does not match stored run kind ${run.run_kind}`,
      );
    }
  }
  if (runId !== null && slotId !== null) {
    const slot = db
      .prepare("SELECT 1 FROM slots WHERE run_id = ? AND slot_id = ?")
      .get(runId, slotId);
    if (slot === undefined) {
      throw new LedgerError("NOT_FOUND", `slot not found: ${runId}/${slotId}`);
    }
  }

  try {
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO logical_calls (logical_call_id, run_id, slot_id, probe_key, role, run_kind, pool, state, request_hash, request_body_json, expected_schema_hash, model, provider, output_cap_field, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        logicalCallId,
        runId,
        slotId,
        probeKey,
        call.role,
        call.runKind,
        pool,
        "prepared",
        body.hash,
        body.json,
        call.expectedSchemaHash,
        call.model,
        call.provider,
        call.outputCapField ?? null,
        createdAt,
        createdAt,
      );
      insertRequestEvent(db, {
        logicalCallId,
        attemptId: null,
        eventType: "call_created",
        fromState: null,
        toState: "prepared",
        payload: { role: call.role, runKind: call.runKind, pool },
        createdAt,
      });
    });
  } catch (error) {
    const code = constraintCode(error);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new LedgerError(
        "DUPLICATE_LOGICAL_CALL",
        "a logical call already exists for this run/slot/probe and role",
        { cause: error },
      );
    }
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new LedgerError("CONSTRAINT_VIOLATION", "logical call constraint failed", {
        cause: error,
      });
    }
    throw error;
  }
  return getLogicalCall(db, logicalCallId);
}

export function createAttempt(
  db: Database.Database,
  input: unknown,
): RequestAttempt {
  const parsed = AttemptInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new LedgerError("INVALID_INPUT", "invalid attempt input", {
      cause: parsed.error,
    });
  }
  const call = getLogicalCall(db, parsed.data.logicalCallId);
  const createdAt = parsed.data.createdAt ?? new Date().toISOString();
  const existing = listAttempts(db, call.logicalCallId);
  if (existing.length >= MAX_ATTEMPTS) {
    throw new LedgerError(
      "TOO_MANY_ATTEMPTS",
      `logical call ${call.logicalCallId} already has ${existing.length} attempts`,
    );
  }
  if (existing.some((attempt) => attempt.state === "dispatching")) {
    throw new LedgerError(
      "INVALID_STATE",
      "cannot create a new attempt while another attempt is dispatching",
    );
  }
  if (call.state !== "prepared" && call.state !== "refused_unprocessed") {
    throw new LedgerError(
      "INVALID_STATE",
      `cannot create an attempt for a logical call in state ${call.state}`,
    );
  }
  const attemptId = randomUUID();
  const attemptNumber = existing.length + 1;
  try {
    withTransaction(db, () => {
      if (call.state === "refused_unprocessed") {
        updateCallState(db, call, "prepared", createdAt);
      }
      db.prepare(
        "INSERT INTO request_attempts (attempt_id, logical_call_id, attempt_number, state, request_hash, request_body_json, expected_schema_hash, role, model, provider, http_status, response_id, generation_id, raw_response_artifact_id, finish_reason, prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, cached_write_tokens, reasoning_tokens, price_estimate_usd, actual_cost_usd, cost_status, error_classification, partial_completion, started_at, finished_at, elapsed_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'unknown', NULL, 0, NULL, NULL, NULL, ?, ?)",
      ).run(
        attemptId,
        call.logicalCallId,
        attemptNumber,
        "prepared",
        call.requestHash,
        canonicalJson(call.requestBody),
        call.expectedSchemaHash,
        call.role,
        call.model,
        call.provider,
        createdAt,
        createdAt,
      );
      insertRequestEvent(db, {
        logicalCallId: call.logicalCallId,
        attemptId,
        eventType: "attempt_created",
        fromState: null,
        toState: "prepared",
        payload: { attemptNumber, requestHash: call.requestHash },
        createdAt,
      });
    });
  } catch (error) {
    const code = constraintCode(error);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new LedgerError("DUPLICATE_ATTEMPT", "attempt already exists", {
        cause: error,
      });
    }
    throw error;
  }
  return getAttempt(db, attemptId);
}

export function getOrCreatePreparedAttempt(
  db: Database.Database,
  logicalCallId: string,
  createdAt = new Date().toISOString(),
): RequestAttempt {
  return db.transaction(() => {
    const call = getLogicalCall(db, logicalCallId);
    if (call.state !== "prepared" && call.state !== "refused_unprocessed") {
      throw new LedgerError(
        "INVALID_STATE",
        `cannot prepare an attempt for a logical call in state ${call.state}`,
      );
    }
    const existing = listAttempts(db, logicalCallId);
    const prepared = existing.find((attempt) => attempt.state === "prepared");
    if (prepared !== undefined) {
      return prepared;
    }
    return createAttempt(db, { logicalCallId, createdAt });
  }).immediate();
}

export function markAttemptDispatching(
  db: Database.Database,
  attemptId: string,
  startedAt = new Date().toISOString(),
): RequestAttempt {
  db.transaction(() => {
    const attempt = getAttempt(db, attemptId);
    if (attempt.state !== "prepared") {
      throw new LedgerError(
        "INVALID_STATE",
        `attempt ${attemptId} must be prepared before dispatch`,
      );
    }
    const call = getLogicalCall(db, attempt.logicalCallId);
    if (call.state !== "prepared") {
      throw new LedgerError(
        "INVALID_STATE",
        `logical call ${call.logicalCallId} is not prepared`,
      );
    }
    const reservation = db
      .prepare(
        "SELECT 1 AS present FROM budget_reservations WHERE attempt_id = ? AND state IN ('reserved', 'unknown') LIMIT 1",
      )
      .get(attemptId);
    if (reservation === undefined) {
      throw new LedgerError(
        "RESERVATION_REQUIRED",
        "attempt requires an active budget reservation before dispatch",
      );
    }
    const attemptUpdate = db
      .prepare(
        "UPDATE request_attempts SET state = 'dispatching', started_at = ?, updated_at = ? WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(startedAt, startedAt, attemptId);
    if (attemptUpdate.changes !== 1) {
      throw new LedgerError("INVALID_STATE", "attempt was dispatched by another caller");
    }
    const callUpdate = db
      .prepare(
        "UPDATE logical_calls SET state = 'dispatching', updated_at = ? WHERE logical_call_id = ? AND state = 'prepared'",
      )
      .run(startedAt, call.logicalCallId);
    if (callUpdate.changes !== 1) {
      throw new LedgerError("INVALID_STATE", "logical call was dispatched by another caller");
    }
    insertRequestEvent(db, {
      logicalCallId: call.logicalCallId,
      attemptId,
      eventType: "call_state",
      fromState: "prepared",
      toState: "dispatching",
      payload: {},
      createdAt: startedAt,
    });
    insertRequestEvent(db, {
      logicalCallId: call.logicalCallId,
      attemptId,
      eventType: "attempt_state",
      fromState: "prepared",
      toState: "dispatching",
      payload: {},
      createdAt: startedAt,
    });
  }).immediate();
  return getAttempt(db, attemptId);
}

export function saveAttemptResponse(
  db: Database.Database,
  input: unknown,
): RequestAttempt {
  const parsed = SaveAttemptResponseInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new LedgerError("INVALID_INPUT", "invalid attempt response", {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const attempt = getAttempt(db, data.attemptId);
  if (attempt.state !== "dispatching") {
    throw new LedgerError(
      "INVALID_STATE",
      `attempt ${data.attemptId} must be dispatching before saving a response`,
    );
  }
  const call = getLogicalCall(db, attempt.logicalCallId);
  const actualCostUsd = data.actualCostUsd ?? null;
  const costStatus = actualCostUsd === null ? "unknown" : "known";
  const updatedAt = data.updatedAt ?? new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      "UPDATE request_attempts SET state = 'response_saved', http_status = ?, response_id = ?, generation_id = ?, raw_response_artifact_id = ?, finish_reason = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?, reasoning_tokens = ?, price_estimate_usd = ?, actual_cost_usd = ?, cost_status = ?, error_classification = ?, partial_completion = ?, finished_at = ?, elapsed_ms = ?, updated_at = ? WHERE attempt_id = ?",
    ).run(
      data.httpStatus,
      data.responseId ?? null,
      data.generationId ?? null,
      data.rawResponseArtifactId ?? null,
      data.finishReason ?? null,
      data.promptTokens ?? null,
      data.completionTokens ?? null,
      data.totalTokens ?? null,
      data.cachedReadTokens ?? null,
      data.cachedWriteTokens ?? null,
      data.reasoningTokens ?? null,
      data.priceEstimateUsd ?? null,
      actualCostUsd,
      costStatus,
      data.errorClassification ?? null,
      data.partialCompletion === true ? 1 : 0,
      data.finishedAt,
      data.elapsedMs,
      updatedAt,
      data.attemptId,
    );
    updateCallState(db, call, "response_saved", updatedAt);
    insertRequestEvent(db, {
      logicalCallId: call.logicalCallId,
      attemptId: data.attemptId,
      eventType: "attempt_state",
      fromState: "dispatching",
      toState: "response_saved",
      payload: {
        httpStatus: data.httpStatus,
        generationId: data.generationId ?? null,
        costStatus,
      },
      createdAt: updatedAt,
    });
  });
  return getAttempt(db, data.attemptId);
}

function transitionAttempt(
  db: Database.Database,
  attemptId: string,
  from: readonly RequestState[],
  next: RequestState,
  eventType: string,
  payload: unknown,
  at = new Date().toISOString(),
): RequestAttempt {
  const attempt = getAttempt(db, attemptId);
  if (!from.includes(attempt.state)) {
    throw new LedgerError(
      "INVALID_STATE",
      `attempt ${attemptId} cannot move from ${attempt.state} to ${next}`,
    );
  }
  const call = getLogicalCall(db, attempt.logicalCallId);
  withTransaction(db, () => {
    db.prepare("UPDATE request_attempts SET state = ?, updated_at = ? WHERE attempt_id = ?").run(
      next,
      at,
      attemptId,
    );
    updateCallState(db, call, next, at);
    insertRequestEvent(db, {
      logicalCallId: call.logicalCallId,
      attemptId,
      eventType,
      fromState: attempt.state,
      toState: next,
      payload,
      createdAt: at,
    });
  });
  return getAttempt(db, attemptId);
}

export function markAttemptValidated(
  db: Database.Database,
  attemptId: string,
  at = new Date().toISOString(),
): RequestAttempt {
  return transitionAttempt(
    db,
    attemptId,
    ["response_saved"],
    "validated",
    "attempt_validated",
    {},
    at,
  );
}

export function markAttemptFailedKnown(
  db: Database.Database,
  attemptId: string,
  reason: string,
  at = new Date().toISOString(),
): RequestAttempt {
  return transitionAttempt(
    db,
    attemptId,
    ["dispatching", "response_saved"],
    "failed_known",
    "attempt_failed_known",
    { reason },
    at,
  );
}

export function markAttemptUncertain(
  db: Database.Database,
  attemptId: string,
  reason: string,
  at = new Date().toISOString(),
): RequestAttempt {
  return transitionAttempt(
    db,
    attemptId,
    ["dispatching", "response_saved"],
    "uncertain",
    "attempt_uncertain",
    { reason },
    at,
  );
}

export interface UnprocessedRefusalInput {
  readonly httpStatus: number;
  readonly generationId: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly errorClassification: string | null;
  readonly partialCompletion: boolean;
  readonly actualCostUsd: string | null;
}

export function isCertifiedUnprocessedRefusal(
  input: UnprocessedRefusalInput,
): boolean {
  const noUsage =
    input.promptTokens === null &&
    input.completionTokens === null &&
    input.totalTokens === null;
  const noGeneration = input.generationId === null;
  const noCost = input.actualCostUsd === null;
  const noPartial = !input.partialCompletion;
  const rateLimited = input.httpStatus === 429;
  const noProvider =
    input.httpStatus === 503 && input.errorClassification === "no_eligible_provider";
  return (rateLimited || noProvider) && noUsage && noGeneration && noCost && noPartial;
}

export function markAttemptRefusedUnprocessed(
  db: Database.Database,
  attemptId: string,
  at = new Date().toISOString(),
): RequestAttempt {
  const attempt = getAttempt(db, attemptId);
  if (
    !isCertifiedUnprocessedRefusal({
      httpStatus: attempt.httpStatus ?? 0,
      generationId: attempt.generationId,
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      totalTokens: attempt.totalTokens,
      errorClassification: attempt.errorClassification,
      partialCompletion: attempt.partialCompletion,
      actualCostUsd: attempt.actualCostUsd,
    })
  ) {
    throw new LedgerError(
      "INVALID_STATE",
      "attempt does not satisfy the certified-unprocessed refusal allowlist",
    );
  }
  return transitionAttempt(
    db,
    attemptId,
    ["response_saved"],
    "refused_unprocessed",
    "attempt_refused_unprocessed",
    { httpStatus: attempt.httpStatus, errorClassification: attempt.errorClassification },
    at,
  );
}

export type ResumeDisposition =
  | "send_prepared"
  | "uncertain_no_resend"
  | "reuse_saved_response"
  | "reuse_validated"
  | "terminal_failure";

export function resumeDisposition(state: RequestState): ResumeDisposition {
  switch (state) {
    case "prepared":
      return "send_prepared";
    case "dispatching":
      return "uncertain_no_resend";
    case "response_saved":
      return "reuse_saved_response";
    case "validated":
      return "reuse_validated";
    case "refused_unprocessed":
    case "failed_known":
    case "uncertain":
      return "terminal_failure";
  }
}

export const ReconcileUsageInputSchema = z.strictObject({
  attemptId: z.uuid(),
  promptTokens: z.number().int().nonnegative().nullable().optional(),
  completionTokens: z.number().int().nonnegative().nullable().optional(),
  totalTokens: z.number().int().nonnegative().nullable().optional(),
  cachedReadTokens: z.number().int().nonnegative().nullable().optional(),
  cachedWriteTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  actualCostUsd: UsdSchema,
  at: z.iso.datetime().optional(),
});

export type ReconcileUsageInput = z.infer<typeof ReconcileUsageInputSchema>;

export function reconcileAttemptUsage(
  db: Database.Database,
  input: unknown,
): RequestAttempt {
  const parsed = ReconcileUsageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new LedgerError("INVALID_INPUT", "invalid usage reconciliation input", {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const attempt = getAttempt(db, data.attemptId);
  if (attempt.generationId === null) {
    throw new LedgerError(
      "INVALID_STATE",
      "usage reconciliation requires a generation ID",
    );
  }
  const at = data.at ?? new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      "UPDATE request_attempts SET prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?, reasoning_tokens = ?, actual_cost_usd = ?, cost_status = 'known', updated_at = ? WHERE attempt_id = ?",
    ).run(
      data.promptTokens ?? attempt.promptTokens,
      data.completionTokens ?? attempt.completionTokens,
      data.totalTokens ?? attempt.totalTokens,
      data.cachedReadTokens ?? attempt.cachedReadTokens,
      data.cachedWriteTokens ?? attempt.cachedWriteTokens,
      data.reasoningTokens ?? attempt.reasoningTokens,
      data.actualCostUsd,
      at,
      data.attemptId,
    );
    insertRequestEvent(db, {
      logicalCallId: attempt.logicalCallId,
      attemptId: attempt.attemptId,
      eventType: "usage_reconciled",
      fromState: attempt.state,
      toState: attempt.state,
      payload: { actualCostUsd: data.actualCostUsd },
      createdAt: at,
    });
  });
  return getAttempt(db, data.attemptId);
}
