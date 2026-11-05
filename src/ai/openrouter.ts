import type Database from "better-sqlite3";
import { z } from "zod";
import { ARTIFACT_LIMITS, storeArtifact } from "../storage/artifacts.js";
import {
  LedgerError,
  getAttempt,
  getOrCreatePreparedAttempt,
  getLogicalCall,
  listAttempts,
  markAttemptDispatching,
  markAttemptFailedKnown,
  markAttemptRefusedUnprocessed,
  markAttemptUncertain,
  markAttemptValidated,
  prepareRequestBody,
  reconcileAttemptUsage,
  saveAttemptResponse,
  setLogicalCallRetryNotBefore,
  type RequestAttempt,
} from "./ledger.js";
import {
  BudgetError,
  addUsd,
  admitRequest,
  assertCallBelongsToAccount,
  compareUsd,
  getBudgetAccount,
  normalizeUsd,
  releaseReservation,
  settleReservation,
} from "./budget.js";
import { decideRetry, parseRetryAfter } from "./retry.js";
import { redactText } from "./redact.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CHAT_PATH = "/chat/completions";
export const OPENROUTER_GENERATION_PATH = "/generation";
export const DEFAULT_REQUEST_DEADLINE_MS = 90_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_TEXT_BYTES = 65_536;
export const MAX_PNG_BYTES = 1_048_576;
export const MAX_STORED_REQUEST_BYTES = 2_097_152;

export type OpenRouterErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_BASE_URL"
  | "INVALID_STATE"
  | "NETWORK_TIMEOUT"
  | "NETWORK_DISCONNECT"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR"
  | "PROVIDER_ERROR"
  | "REFUSAL"
  | "TRUNCATED"
  | "REASONING_ONLY"
  | "MISSING_CONTENT"
  | "INVALID_FINISH_REASON"
  | "BUDGET_NOT_ADMITTED"
  | "RETRY_AFTER_TOO_LONG"
  | "MAX_ATTEMPTS"
  | "GENERATION_ID_MISSING"
  | "MISSING_COST"
  | "INVALID_COST"
  | "TEST_BASE_URL_FORBIDDEN"
  | "RECONCILIATION_FAILED";

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;

  constructor(code: OpenRouterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenRouterError";
    this.code = code;
  }
}

export interface OpenRouterClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface OpenRouterTransportOptions {
  readonly baseUrl?: string;
  readonly clock?: OpenRouterClock;
  readonly fetchImpl?: typeof fetch;
  readonly random?: () => number;
  readonly deadlineMs?: number;
  readonly maxResponseBytes?: number;
}

export interface ExecuteOpenRouterCallInput {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly logicalCallId: string;
  readonly apiKey: string;
  readonly reservationUsd: string;
  readonly nonBilling?: boolean;
  readonly deadlineMs?: number;
  readonly maxResponseBytes?: number;
}

export interface ReconcileGenerationInput {
  readonly db: Database.Database;
  readonly attemptId: string;
  readonly apiKey: string;
  readonly deadlineMs?: number;
  readonly maxResponseBytes?: number;
}

export interface OpenRouterUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly cachedReadTokens: number | null;
  readonly cachedWriteTokens: number | null;
  readonly reasoningTokens: number | null;
}

export type OpenRouterOutcome =
  | "success"
  | "refused_unprocessed"
  | "failed_known"
  | "uncertain"
  | "paused_budget"
  | "paused_retry_after"
  | "already_dispatching";

export interface OpenRouterAttemptResult {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly httpStatus: number | null;
  readonly outcome: OpenRouterOutcome;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryDelayMs: number | null;
  readonly responseArtifactId: number | null;
  readonly generationId: string | null;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
}

export interface OpenRouterCallResult {
  readonly logicalCallId: string;
  readonly outcome: OpenRouterOutcome;
  readonly content: string | null;
  readonly parsedContent: unknown | null;
  readonly usage: OpenRouterUsage;
  readonly generationId: string | null;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly OpenRouterAttemptResult[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface GenerationReconciliationResult {
  readonly attempt: RequestAttempt;
  readonly actualCostUsd: string;
  readonly reservationSettled: boolean;
}

const ChatRequestSchema = z
  .looseObject({
    model: z.string().min(1).max(200),
    messages: z.array(z.unknown()).min(1),
    stream: z.literal(false),
    response_format: z.looseObject({
      type: z.literal("json_schema"),
      json_schema: z.looseObject({
        name: z.string().min(1).max(128),
        strict: z.literal(true),
        schema: z
          .unknown()
          .refine((value) => value !== undefined, "json schema is required"),
      }),
    }),
    provider: z.looseObject({
      only: z.array(z.string().min(1).max(200)).length(1),
      allow_fallbacks: z.literal(false),
      require_parameters: z.literal(true),
    }),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
  })
  .superRefine((request, ctx) => {
    const caps = [request.max_tokens, request.max_completion_tokens].filter(
      (value) => value !== undefined,
    );
    if (caps.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["max_tokens"],
        message: "exactly one output cap field is required",
      });
    }
    for (const forbidden of ["models", "tools", "plugins", "route"]) {
      if (forbidden in request) {
        ctx.addIssue({
          code: "custom",
          path: [forbidden],
          message: `${forbidden} is forbidden in an OpenRouter request`,
        });
      }
    }
  });

const EMPTY_USAGE: OpenRouterUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  cachedReadTokens: null,
  cachedWriteTokens: null,
  reasoningTokens: null,
};

interface ReadResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Buffer;
  readonly truncated: boolean;
}

interface ParsedResponse {
  readonly jsonParsed: boolean;
  readonly body: unknown;
  readonly content: string | null;
  readonly refusal: string | null;
  readonly reasoning: string | null;
  readonly finishReason: string | null;
  readonly generationId: string | null;
  readonly usage: OpenRouterUsage;
  readonly actualCostUsd: string | null;
  readonly topLevelError: boolean;
  readonly choiceError: boolean;
  readonly errorMessage: string | null;
  readonly errorClassification: string;
  readonly partialCompletion: boolean;
  readonly hasOutput: boolean;
  readonly noEligibleProvider: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OpenRouterError("INVALID_BASE_URL", "OpenRouter base URL is invalid", {
      cause: error,
    });
  }
  if (baseUrl !== undefined) {
    const host = url.hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new OpenRouterError(
        "TEST_BASE_URL_FORBIDDEN",
        "a custom OpenRouter base URL is allowed only for loopback test servers",
      );
    }
  }
  return value.replace(/\/+$/, "");
}

function errorText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.message === "string") {
    return value.message;
  }
  return null;
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.code === "string") {
    return value.code;
  }
  if (typeof value.code === "number") {
    return String(value.code);
  }
  if (typeof value.type === "string") {
    return value.type;
  }
  return null;
}

function generationIdFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.generation_id === "string" && value.generation_id.length > 0) {
    return value.generation_id;
  }
  if (typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  if (isRecord(value.error)) {
    if (
      isRecord(value.error.metadata) &&
      typeof value.error.metadata.generation_id === "string"
    ) {
      return value.error.metadata.generation_id;
    }
  }
  return null;
}

function noEligibleProvider(status: number, body: unknown): boolean {
  if (status !== 503) {
    return false;
  }
  if (!isRecord(body) || !isRecord(body.error)) {
    return false;
  }
  const code = errorCode(body.error);
  const message = errorText(body.error) ?? "";
  return (
    code === "no_eligible_provider" ||
    code === "no_available_provider" ||
    /no (eligible|available) provider/i.test(message)
  );
}

function normalizeActualCost(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  try {
    return normalizeUsd(String(value), "usage.cost");
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseResponse(
  status: number,
  bytes: Buffer,
  apiKey: string,
  truncated: boolean,
): ParsedResponse {
  let body: unknown;
  let jsonParsed = false;
  try {
    body = JSON.parse(bytes.toString("utf8")) as unknown;
    jsonParsed = true;
  } catch {
    body = null;
  }
  const record = isRecord(body) ? body : null;
  const choices = record !== null && Array.isArray(record.choices) ? record.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice !== null && isRecord(choice.message) ? choice.message : null;
  const contentRaw = asString(message?.content);
  const content =
    contentRaw === null ? null : redactText(contentRaw, [apiKey]);
  const refusalRaw = asString(message?.refusal);
  const refusal =
    refusalRaw === null ? null : redactText(refusalRaw, [apiKey]);
  const reasoningRaw = asString(message?.reasoning);
  const reasoning =
    reasoningRaw === null ? null : redactText(reasoningRaw, [apiKey]);
  const finishReason = asString(choice?.finish_reason);
  const usageRecord = record !== null && isRecord(record.usage) ? record.usage : null;
  const promptDetails =
    usageRecord !== null && isRecord(usageRecord.prompt_tokens_details)
      ? usageRecord.prompt_tokens_details
      : null;
  const completionDetails =
    usageRecord !== null && isRecord(usageRecord.completion_tokens_details)
      ? usageRecord.completion_tokens_details
      : null;
  const usage: OpenRouterUsage = {
    promptTokens: asNumber(usageRecord?.prompt_tokens),
    completionTokens: asNumber(usageRecord?.completion_tokens),
    totalTokens: asNumber(usageRecord?.total_tokens),
    cachedReadTokens: asNumber(promptDetails?.cached_tokens),
    cachedWriteTokens: asNumber(promptDetails?.cache_write_tokens),
    reasoningTokens: asNumber(completionDetails?.reasoning_tokens),
  };
  const actualCostUsd = normalizeActualCost(usageRecord?.cost);
  const topLevelError = record?.error !== undefined && record?.error !== null;
  const choiceError = choice?.error !== undefined && choice?.error !== null;
  const generationId = generationIdFrom(record);
  const errorMessageRaw =
    errorText(record?.error) ?? errorText(choice?.error) ?? null;
  const errorMessage =
    errorMessageRaw === null ? null : redactText(errorMessageRaw, [apiKey]);
  const noProvider = noEligibleProvider(status, body);
  const hasOutput =
    (content !== null && content.length > 0) ||
    (reasoning !== null && reasoning.length > 0);
  const partialCompletion = finishReason === "length";
  let errorClassification = "ok";
  if (!jsonParsed) {
    errorClassification = "malformed_body";
  } else if (noProvider) {
    errorClassification = "no_eligible_provider";
  } else if (status === 429) {
    errorClassification = "rate_limit";
  } else if (status === 401) {
    errorClassification = "auth_error";
  } else if (status === 402) {
    errorClassification = "payment_required";
  } else if (status === 403) {
    errorClassification = "forbidden";
  } else if (status >= 500) {
    errorClassification = `http_${status}`;
  } else if (status !== 200) {
    errorClassification = `http_${status}`;
  } else if (topLevelError || choiceError) {
    errorClassification = "provider_error";
  } else if (finishReason === "length") {
    errorClassification = "length";
  } else if (finishReason === "content_filter" || refusal !== null) {
    errorClassification = "refusal";
  } else if (content === null || content.trim() === "") {
    errorClassification = reasoning !== null && reasoning.trim() !== ""
      ? "reasoning_only"
      : "missing_content";
  } else if (finishReason !== "stop") {
    errorClassification = "invalid_finish_reason";
  } else {
    try {
      JSON.parse(content);
    } catch {
      errorClassification = "invalid_json";
    }
  }
  if (truncated) {
    errorClassification = "response_too_large";
  }
  return {
    jsonParsed,
    body,
    content,
    refusal,
    reasoning,
    finishReason,
    generationId,
    usage,
    actualCostUsd,
    topLevelError,
    choiceError,
    errorMessage,
    errorClassification,
    partialCompletion,
    hasOutput,
    noEligibleProvider: noProvider,
  };
}

function classifyOutcome(
  status: number,
  parsed: ParsedResponse,
  truncated: boolean,
): OpenRouterOutcome {
  if (truncated) {
    return "uncertain";
  }
  if (!parsed.jsonParsed) {
    return "failed_known";
  }
  if (
    (status === 429 || parsed.noEligibleProvider) &&
    parsed.generationId === null &&
    parsed.usage.promptTokens === null &&
    parsed.usage.completionTokens === null &&
    parsed.usage.totalTokens === null &&
    parsed.actualCostUsd === null &&
    !parsed.hasOutput &&
    !parsed.partialCompletion
  ) {
    return "refused_unprocessed";
  }
  if (status === 429) {
    return "uncertain";
  }
  if (status === 401 || status === 402 || status === 403) {
    return "failed_known";
  }
  if (status >= 500) {
    return "uncertain";
  }
  if (status !== 200) {
    return "failed_known";
  }
  if (parsed.topLevelError || parsed.choiceError) {
    return "uncertain";
  }
  if (parsed.finishReason === "length") {
    return "failed_known";
  }
  if (parsed.finishReason === "content_filter" || parsed.refusal !== null) {
    return "failed_known";
  }
  if (parsed.content === null || parsed.content.trim() === "") {
    return "failed_known";
  }
  if (parsed.finishReason !== "stop") {
    return "failed_known";
  }
  try {
    JSON.parse(parsed.content);
    return "success";
  } catch {
    return "failed_known";
  }
}

function resultFor(
  logicalCallId: string,
  outcome: OpenRouterOutcome,
  parsed: ParsedResponse | null,
  attempts: readonly OpenRouterAttemptResult[],
  error: { code: string; message: string } | null,
): OpenRouterCallResult {
  const usage = parsed?.usage ?? EMPTY_USAGE;
  const actualCostUsd = parsed?.actualCostUsd ?? null;
  const costStatus =
    outcome === "refused_unprocessed" ||
    outcome === "paused_budget" ||
    outcome === "paused_retry_after" ||
    outcome === "already_dispatching"
      ? "not_applicable"
      : actualCostUsd === null
        ? "unknown"
        : "known";
  let parsedContent: unknown | null = null;
  if (outcome === "success" && parsed?.content !== null && parsed?.content !== undefined) {
    try {
      parsedContent = JSON.parse(parsed.content) as unknown;
    } catch {
      parsedContent = null;
    }
  }
  return {
    logicalCallId,
    outcome,
    content: outcome === "success" ? parsed?.content ?? null : null,
    parsedContent,
    usage,
    generationId: parsed?.generationId ?? null,
    actualCostUsd,
    costStatus,
    attempts,
    error,
  };
}

function attemptResult(
  attempt: RequestAttempt,
  outcome: OpenRouterOutcome,
  parsed: ParsedResponse | null,
  error: { code: string; message: string } | null,
  retryDelayMs: number | null,
): OpenRouterAttemptResult {
  return {
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    httpStatus: attempt.httpStatus,
    outcome,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    retryDelayMs,
    responseArtifactId: attempt.rawResponseArtifactId,
    generationId: parsed?.generationId ?? attempt.generationId,
    actualCostUsd: parsed?.actualCostUsd ?? attempt.actualCostUsd,
    costStatus:
      outcome === "refused_unprocessed"
        ? "not_applicable"
        : parsed?.actualCostUsd === null || parsed?.actualCostUsd === undefined
          ? "unknown"
          : "known",
  };
}

async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (response.body === null) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      return { bytes: bytes.subarray(0, maxBytes), truncated: true };
    }
    return { bytes, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    if (total + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function findActiveReservation(
  db: Database.Database,
  attemptId: string,
): { reservation_id: string; account_id: string; kind: string; amount_usd: string } | undefined {
  return db
    .prepare(
      "SELECT reservation_id, account_id, kind, amount_usd FROM budget_reservations WHERE attempt_id = ? AND state IN ('reserved', 'unknown') ORDER BY created_at DESC LIMIT 1",
    )
    .get(attemptId) as
    | { reservation_id: string; account_id: string; kind: string; amount_usd: string }
    | undefined;
}

export function createOpenRouterTransport(
  options: OpenRouterTransportOptions = {},
) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const clock = options.clock ?? {
    now: () => new Date(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const random = options.random ?? Math.random;
  const defaultDeadlineMs = options.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  const defaultMaxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  async function fetchAndRead(
    url: string,
    init: RequestInit,
    deadlineMs: number,
    maxBytes: number,
    apiKey: string,
  ): Promise<ReadResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
      });
      const body = await readBody(response, maxBytes);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bytes: body.bytes,
        truncated: body.truncated,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OpenRouterError(
          "NETWORK_TIMEOUT",
          `OpenRouter request exceeded ${deadlineMs} ms`,
          { cause: error },
        );
      }
      const message =
        error instanceof Error ? error.message : "OpenRouter request failed";
      throw new OpenRouterError(
        "NETWORK_DISCONNECT",
        redactText(message, [apiKey]),
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function executeCall(
    input: ExecuteOpenRouterCallInput,
  ): Promise<OpenRouterCallResult> {
    if (input.apiKey.trim() === "") {
      throw new OpenRouterError("INVALID_REQUEST", "an OpenRouter API key is required");
    }
    let call = getLogicalCall(input.db, input.logicalCallId);
    if (call.retryNotBefore !== null) {
      const retryAt = Date.parse(call.retryNotBefore);
      if (Number.isFinite(retryAt) && clock.now().getTime() < retryAt) {
        return resultFor(input.logicalCallId, "paused_retry_after", null, [], {
          code: "RETRY_AFTER_TOO_LONG",
          message: `retry not before ${call.retryNotBefore}`,
        });
      }
      call = setLogicalCallRetryNotBefore(
        input.db,
        call.logicalCallId,
        null,
        clock.now().toISOString(),
      );
    }
    if (call.state === "dispatching") {
      return resultFor(input.logicalCallId, "already_dispatching", null, [], {
        code: "RESUME_UNCERTAIN",
        message: "a dispatching attempt has no saved response and must not be resent",
      });
    }
    if (call.state !== "prepared" && call.state !== "refused_unprocessed") {
      throw new OpenRouterError(
        "INVALID_STATE",
        `logical call ${call.logicalCallId} is ${call.state}`,
      );
    }
    const intent = prepareRequestBody(call.requestBody);
    if (intent.hash !== call.requestHash) {
      throw new OpenRouterError(
        "INVALID_REQUEST",
        "stored request body does not match its canonical hash",
      );
    }
    const request = ChatRequestSchema.safeParse(call.requestBody);
    if (!request.success) {
      throw new OpenRouterError(
        "INVALID_REQUEST",
        "request body does not satisfy the OpenRouter transport schema",
        { cause: request.error },
      );
    }
    const existing = listAttempts(input.db, input.logicalCallId);
    if (existing.some((attempt) => attempt.state === "dispatching")) {
      return resultFor(input.logicalCallId, "already_dispatching", null, [], {
        code: "RESUME_UNCERTAIN",
        message: "a dispatching attempt has no saved response and must not be resent",
      });
    }
    let attempt = getOrCreatePreparedAttempt(input.db, input.logicalCallId);
    const attempts: OpenRouterAttemptResult[] = [];
    const deadlineMs = input.deadlineMs ?? defaultDeadlineMs;
    const maxResponseBytes = Math.min(
      input.maxResponseBytes ?? defaultMaxResponseBytes,
      ARTIFACT_LIMITS.raw_response,
    );
    const reservationUsd = normalizeUsd(input.reservationUsd, "reservationUsd");

    for (;;) {
      const activeReservation = findActiveReservation(input.db, attempt.attemptId);
      let reservationId: string;
      let reservationCreated = false;
      if (activeReservation !== undefined) {
        if (activeReservation.account_id !== input.accountId) {
          throw new OpenRouterError(
            "INVALID_STATE",
            "the active reservation belongs to a different budget account",
          );
        }
        if (input.nonBilling === true) {
          if (
            activeReservation.kind !== "nonbilling" ||
            compareUsd(activeReservation.amount_usd, "0") !== 0
          ) {
            throw new OpenRouterError(
              "INVALID_STATE",
              "a nonbilling call cannot reuse a billing reservation",
            );
          }
        } else {
          if (activeReservation.kind === "nonbilling") {
            throw new OpenRouterError(
              "INVALID_STATE",
              "a billing call cannot reuse a nonbilling reservation",
            );
          }
          if (compareUsd(activeReservation.amount_usd, reservationUsd) < 0) {
            throw new OpenRouterError(
              "INVALID_STATE",
              "the active reservation is smaller than the requested reservation",
            );
          }
        }
        const account = getBudgetAccount(input.db, input.accountId);
        if (
          input.nonBilling !== true &&
          compareUsd(
            addUsd(account.knownActualUsd, account.reservedUsd),
            account.maxCostUsd,
          ) > 0
        ) {
          return resultFor(input.logicalCallId, "paused_budget", null, attempts, {
            code: "BUDGET_NOT_ADMITTED",
            message: "INSUFFICIENT_BUDGET",
          });
        }
        try {
          assertCallBelongsToAccount(
            input.db,
            account,
            input.logicalCallId,
            attempt,
          );
        } catch (error) {
          throw new OpenRouterError(
            "INVALID_STATE",
            "the logical call does not match the reused budget account",
            { cause: error },
          );
        }
        if (account.runId !== null) {
          const run = input.db
            .prepare("SELECT control_state FROM runs WHERE run_id = ?")
            .get(account.runId) as { control_state: string } | undefined;
          if (run?.control_state !== "running") {
            return resultFor(input.logicalCallId, "paused_budget", null, attempts, {
              code: "BUDGET_NOT_ADMITTED",
              message: "RUN_PAUSED",
            });
          }
        }
        if (input.nonBilling !== true) {
          const blocked = input.db
            .prepare(
              "SELECT 1 AS blocked FROM budget_events WHERE account_id = ? AND event_type = 'pause' LIMIT 1",
            )
            .get(account.accountId);
          if (blocked !== undefined) {
            return resultFor(input.logicalCallId, "paused_budget", null, attempts, {
              code: "BUDGET_NOT_ADMITTED",
              message: "ADMISSION_BLOCKED",
            });
          }
        }
        reservationId = activeReservation.reservation_id;
      } else {
        try {
          const admission = admitRequest(input.db, {
            accountId: input.accountId,
            logicalCallId: input.logicalCallId,
            attemptId: attempt.attemptId,
            kind: input.nonBilling === true ? "nonbilling" : "attempt",
            amountUsd: input.nonBilling === true ? "0" : reservationUsd,
            nonBilling: input.nonBilling === true,
          });
          if (!admission.admitted) {
            return resultFor(input.logicalCallId, "paused_budget", null, attempts, {
              code: "BUDGET_NOT_ADMITTED",
              message: admission.reason,
            });
          }
          reservationId = admission.reservation.reservationId;
          reservationCreated = true;
        } catch (error) {
          if (
            error instanceof BudgetError &&
            error.code === "DUPLICATE_RESERVATION"
          ) {
            return resultFor(input.logicalCallId, "already_dispatching", null, attempts, {
              code: "CONCURRENT_ADMISSION",
              message: "another caller admitted this attempt",
            });
          }
          throw error;
        }
      }
      const startedAt = clock.now();
      try {
        markAttemptDispatching(input.db, attempt.attemptId, startedAt.toISOString());
      } catch (error) {
        if (error instanceof LedgerError && error.code === "RESERVATION_REQUIRED") {
          return resultFor(input.logicalCallId, "paused_budget", null, attempts, {
            code: "BUDGET_NOT_ADMITTED",
            message: "RESERVATION_REQUIRED",
          });
        }
        if (error instanceof LedgerError && error.code === "INVALID_STATE") {
          let unclaimed = false;
          if (reservationCreated) {
            try {
              unclaimed = getAttempt(input.db, attempt.attemptId).state === "prepared";
            } catch {
              unclaimed = false;
            }
          }
          if (unclaimed) {
            try {
              releaseReservation(input.db, {
                reservationId,
                createdAt: startedAt.toISOString(),
              });
            } catch {
              // The reservation changed concurrently; leave it for the winner.
            }
          }
          return resultFor(input.logicalCallId, "already_dispatching", null, attempts, {
            code: "CONCURRENT_DISPATCH",
            message: "another caller dispatched this attempt",
          });
        }
        throw error;
      }

      let response: ReadResponse;
      try {
        response = await fetchAndRead(
          `${baseUrl}${OPENROUTER_CHAT_PATH}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              "Content-Type": "application/json",
            },
            body: intent.json,
          },
          deadlineMs,
          maxResponseBytes,
          input.apiKey,
        );
      } catch (error) {
        const failure =
          error instanceof OpenRouterError
            ? error
            : new OpenRouterError("NETWORK_DISCONNECT", "OpenRouter request failed", {
                cause: error,
              });
        const finishedAt = clock.now();
        markAttemptUncertain(
          input.db,
          attempt.attemptId,
          failure.code,
          finishedAt.toISOString(),
        );
        settleReservation(input.db, {
          reservationId,
          actualCostUsd: null,
          createdAt: finishedAt.toISOString(),
        });
        attempts.push(
          attemptResult(attempt, "uncertain", null, {
            code: failure.code,
            message: failure.message,
          }, null),
        );
        return resultFor(input.logicalCallId, "uncertain", null, attempts, {
          code: failure.code,
          message: failure.message,
        });
      }

      const finishedAt = clock.now();
      const elapsedMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      const rawText = response.bytes.toString("utf8");
      const redactedText = redactText(rawText, [input.apiKey]);
      const redactedBytes = Buffer.from(redactedText, "utf8");
      const storedBytes =
        redactedBytes.length > maxResponseBytes
          ? redactedBytes.subarray(0, maxResponseBytes)
          : redactedBytes;
      const rawArtifact = storeArtifact(input.db, {
        kind: "raw_response",
        mediaType: "application/json",
        bytes: storedBytes,
        role: "response",
      });
      const parsed = parseResponse(
        response.status,
        response.bytes,
        input.apiKey,
        response.truncated,
      );
      const outcome = classifyOutcome(response.status, parsed, response.truncated);
      const retryAfterSeconds = parseRetryAfter(
        response.headers["retry-after"] ?? null,
        finishedAt,
      );
      const attemptAfterSave = saveAttemptResponse(input.db, {
        attemptId: attempt.attemptId,
        finishedAt: finishedAt.toISOString(),
        elapsedMs,
        httpStatus: response.status,
        generationId: parsed.generationId,
        rawResponseArtifactId: rawArtifact.artifactId,
        finishReason: parsed.finishReason,
        promptTokens: parsed.usage.promptTokens,
        completionTokens: parsed.usage.completionTokens,
        totalTokens: parsed.usage.totalTokens,
        cachedReadTokens: parsed.usage.cachedReadTokens,
        cachedWriteTokens: parsed.usage.cachedWriteTokens,
        reasoningTokens: parsed.usage.reasoningTokens,
        actualCostUsd: parsed.actualCostUsd,
        errorClassification: parsed.errorClassification,
        partialCompletion: parsed.partialCompletion,
        updatedAt: finishedAt.toISOString(),
      });

      if (outcome === "refused_unprocessed") {
        releaseReservation(input.db, {
          reservationId,
          createdAt: finishedAt.toISOString(),
        });
        markAttemptRefusedUnprocessed(
          input.db,
          attemptAfterSave.attemptId,
          finishedAt.toISOString(),
        );
      } else {
        settleReservation(input.db, {
          reservationId,
          actualCostUsd: parsed.actualCostUsd,
          createdAt: finishedAt.toISOString(),
        });
        if (outcome === "success") {
          markAttemptValidated(
            input.db,
            attemptAfterSave.attemptId,
            finishedAt.toISOString(),
          );
        } else if (outcome === "failed_known") {
          markAttemptFailedKnown(
            input.db,
            attemptAfterSave.attemptId,
            parsed.errorClassification,
            finishedAt.toISOString(),
          );
        } else {
          markAttemptUncertain(
            input.db,
            attemptAfterSave.attemptId,
            parsed.errorClassification,
            finishedAt.toISOString(),
          );
        }
      }

      const failure =
        outcome === "success"
          ? null
          : {
              code:
                outcome === "refused_unprocessed"
                  ? "REFUSED_UNPROCESSED"
                  : parsed.errorClassification.toUpperCase(),
              message:
                parsed.errorMessage ??
                parsed.errorClassification.replaceAll("_", " "),
            };
      const retryDecision =
        outcome === "refused_unprocessed"
          ? decideRetry({
              attemptNumber: attempt.attemptNumber,
              httpStatus: response.status,
              generationId: parsed.generationId,
              usage: {
                promptTokens: parsed.usage.promptTokens,
                completionTokens: parsed.usage.completionTokens,
                totalTokens: parsed.usage.totalTokens,
              },
              errorClassification: parsed.errorClassification,
              partialCompletion: parsed.hasOutput || parsed.partialCompletion,
              actualCostUsd: parsed.actualCostUsd,
              retryAfterSeconds,
              random,
            })
          : null;
      const retryDelayMs =
        retryDecision !== null && retryDecision.retry
          ? retryDecision.delayMs
          : null;
      attempts.push(
        attemptResult(
          attemptAfterSave,
          outcome,
          parsed,
          failure,
          retryDelayMs,
        ),
      );

      if (outcome !== "refused_unprocessed") {
        return resultFor(input.logicalCallId, outcome, parsed, attempts, failure);
      }
      if (retryDecision === null || !retryDecision.retry) {
        if (retryDecision !== null && retryDecision.reason === "retry_after_too_long") {
          const retryNotBefore = new Date(
            finishedAt.getTime() + (retryAfterSeconds ?? 0) * 1000,
          ).toISOString();
          setLogicalCallRetryNotBefore(
            input.db,
            input.logicalCallId,
            retryNotBefore,
            finishedAt.toISOString(),
          );
          return resultFor(input.logicalCallId, "paused_retry_after", parsed, attempts, {
            code: "RETRY_AFTER_TOO_LONG",
            message: `Retry-After ${retryAfterSeconds ?? 0}s exceeds 30s`,
          });
        }
        return resultFor(input.logicalCallId, "refused_unprocessed", parsed, attempts, failure);
      }
      await clock.sleep(retryDecision.delayMs);
      attempt = getOrCreatePreparedAttempt(input.db, input.logicalCallId);
    }
  }

  async function reconcileGeneration(
    input: ReconcileGenerationInput,
  ): Promise<GenerationReconciliationResult> {
    if (input.apiKey.trim() === "") {
      throw new OpenRouterError("INVALID_REQUEST", "an OpenRouter API key is required");
    }
    const attempt = getAttempt(input.db, input.attemptId);
    if (attempt.generationId === null) {
      throw new OpenRouterError(
        "GENERATION_ID_MISSING",
        "generation reconciliation requires a generation ID",
      );
    }
    const deadlineMs = input.deadlineMs ?? defaultDeadlineMs;
    const maxResponseBytes = Math.min(
      input.maxResponseBytes ?? defaultMaxResponseBytes,
      ARTIFACT_LIMITS.raw_response,
    );
    const response = await fetchAndRead(
      `${baseUrl}${OPENROUTER_GENERATION_PATH}?id=${encodeURIComponent(attempt.generationId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${input.apiKey}` },
      },
      deadlineMs,
      maxResponseBytes,
      input.apiKey,
    );
    if (response.status !== 200) {
      throw new OpenRouterError(
        "RECONCILIATION_FAILED",
        `generation reconciliation returned HTTP ${response.status}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new OpenRouterError(
        "RECONCILIATION_FAILED",
        "generation reconciliation returned invalid JSON",
        { cause: error },
      );
    }
    if (!isRecord(body) || !isRecord(body.data)) {
      throw new OpenRouterError(
        "RECONCILIATION_FAILED",
        "generation reconciliation response is missing data",
      );
    }
    const data = body.data;
    const costValue = data.total_cost ?? data.cost;
    if (costValue === undefined || costValue === null) {
      throw new OpenRouterError(
        "MISSING_COST",
        "generation reconciliation did not provide a cost",
      );
    }
    let actualCostUsd: string;
    try {
      actualCostUsd = normalizeUsd(String(costValue), "generation.total_cost");
    } catch (error) {
      throw new OpenRouterError("INVALID_COST", "generation cost is invalid", {
        cause: error,
      });
    }
    const existingReservation = input.db
      .prepare(
        "SELECT reservation_id, state FROM budget_reservations WHERE attempt_id = ? LIMIT 1",
      )
      .get(attempt.attemptId) as
      | { reservation_id: string; state: string }
      | undefined;
    if (existingReservation?.state === "settled") {
      throw new OpenRouterError(
        "RECONCILIATION_FAILED",
        "the attempt reservation is already settled",
      );
    }
    if (attempt.costStatus === "known" && attempt.actualCostUsd !== null) {
      throw new OpenRouterError(
        "RECONCILIATION_FAILED",
        "the attempt already has a known actual cost",
      );
    }
    const updated = reconcileAttemptUsage(input.db, {
      attemptId: attempt.attemptId,
      actualCostUsd,
      promptTokens:
        typeof data.tokens_prompt === "number" ? data.tokens_prompt : null,
      completionTokens:
        typeof data.tokens_completion === "number" ? data.tokens_completion : null,
      totalTokens:
        typeof data.tokens_total === "number" ? data.tokens_total : null,
    });
    const reservation =
      existingReservation !== undefined &&
      (existingReservation.state === "reserved" ||
        existingReservation.state === "unknown")
        ? existingReservation
        : undefined;
    if (reservation !== undefined) {
      settleReservation(input.db, {
        reservationId: reservation.reservation_id,
        actualCostUsd,
        createdAt: clock.now().toISOString(),
      });
    }
    return {
      attempt: updated,
      actualCostUsd,
      reservationSettled: reservation !== undefined,
    };
  }

  return { executeCall, reconcileGeneration };
}
