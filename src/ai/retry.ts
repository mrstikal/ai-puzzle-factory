import { isCertifiedUnprocessedRefusal } from "./ledger.js";

export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAYS_MS = [500, 1000] as const;
export const RETRY_JITTER_MS = 250;
export const MAX_RETRY_AFTER_SECONDS = 30;

export interface RetryUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface RetryAssessmentInput {
  readonly attemptNumber: number;
  readonly httpStatus: number;
  readonly generationId: string | null;
  readonly usage: RetryUsage;
  readonly errorClassification: string | null;
  readonly partialCompletion: boolean;
  readonly actualCostUsd: string | null;
  readonly retryAfterSeconds: number | null;
  readonly random: () => number;
}

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | {
      readonly retry: false;
      readonly reason: "attempt_limit" | "not_allowlisted" | "retry_after_too_long";
    };

export function parseRetryAfter(
  value: string | null,
  now: Date = new Date(),
): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, (date - now.getTime()) / 1000);
}

export function decideRetry(input: RetryAssessmentInput): RetryDecision {
  if (input.attemptNumber >= MAX_RETRY_ATTEMPTS) {
    return { retry: false, reason: "attempt_limit" };
  }
  const allowlisted = isCertifiedUnprocessedRefusal({
    httpStatus: input.httpStatus,
    generationId: input.generationId,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    errorClassification: input.errorClassification,
    partialCompletion: input.partialCompletion,
    actualCostUsd: input.actualCostUsd,
  });
  if (!allowlisted) {
    return { retry: false, reason: "not_allowlisted" };
  }
  if (input.retryAfterSeconds !== null) {
    if (input.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
      return { retry: false, reason: "retry_after_too_long" };
    }
    return {
      retry: true,
      delayMs: Math.ceil(input.retryAfterSeconds * 1000),
    };
  }
  const base = RETRY_BASE_DELAYS_MS[input.attemptNumber - 1];
  if (base === undefined) {
    return { retry: false, reason: "attempt_limit" };
  }
  const random = Math.min(Math.max(input.random(), 0), 0.999999);
  return {
    retry: true,
    delayMs: base + Math.floor(random * RETRY_JITTER_MS),
  };
}
