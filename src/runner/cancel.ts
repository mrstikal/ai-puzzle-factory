import type Database from "better-sqlite3";
import { LedgerError, markAttemptUncertain } from "../ai/ledger.js";
import type { createOpenRouterTransport } from "../ai/openrouter.js";

export type CancellationReason =
  | "sigint"
  | "writer_lock_compromised"
  | "operator"
  | "test";

export class CancellationError extends Error {
  readonly reason: CancellationReason;

  constructor(reason: CancellationReason, options?: ErrorOptions) {
    super(`run cancelled: ${reason}`, options);
    this.name = "CancellationError";
    this.reason = reason;
  }
}

export class RunCancellation {
  private reason: CancellationReason | null = null;
  private cause: Error | null = null;
  private readonly listeners = new Set<() => void>();

  stop(reason: CancellationReason, cause?: Error): void {
    if (this.reason !== null) {
      return;
    }
    this.reason = reason;
    this.cause = cause ?? null;
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }

  get isStopping(): boolean {
    return this.reason !== null;
  }

  get stopReason(): CancellationReason | null {
    return this.reason;
  }

  get stopCause(): Error | null {
    return this.cause;
  }

  throwIfStopping(): void {
    if (this.reason !== null) {
      throw new CancellationError(
        this.reason,
        this.cause === null ? undefined : { cause: this.cause },
      );
    }
  }

  onStop(listener: () => void): () => void {
    if (this.reason !== null) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

}

export function withCancellationTransport<
  T extends ReturnType<typeof createOpenRouterTransport> & {
    readonly isMock?: true;
  },
>(transport: T, cancellation: RunCancellation): T {
  return {
    ...transport,
    executeCall: async (input) => {
      cancellation.throwIfStopping();
      return transport.executeCall(input);
    },
  } as T;
}

export function markUnfinishedDispatchesUncertain(
  db: Database.Database,
  runId: string,
  at = new Date().toISOString(),
): string[] {
  const rows = db
    .prepare(
      "SELECT attempt_id FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND state = 'dispatching' ORDER BY attempt_id",
    )
    .all(runId) as Array<{ attempt_id: string }>;
  const marked: string[] = [];
  for (const row of rows) {
    try {
      markAttemptUncertain(db, row.attempt_id, "run_cancelled_after_drain", at);
      marked.push(row.attempt_id);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "INVALID_STATE") {
        continue;
      }
      throw error;
    }
  }
  return marked;
}
