import { RunCancellation } from "./cancel.js";

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 2;
export const DEFAULT_CONCURRENCY = 2;
export type Concurrency = 1 | 2;

export class ConcurrencyError extends Error {
  readonly code = "INVALID_CONCURRENCY";

  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

export function assertConcurrency(value: number): Concurrency {
  if (!Number.isInteger(value) || value < MIN_CONCURRENCY || value > MAX_CONCURRENCY) {
    throw new ConcurrencyError(
      `concurrency must be ${MIN_CONCURRENCY} or ${MAX_CONCURRENCY}`,
    );
  }
  return value as Concurrency;
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface BoundedPoolOptions {
  readonly concurrency: Concurrency;
  readonly cancellation?: RunCancellation;
  readonly drainTimeoutMs?: number;
  readonly yieldBetweenJobs?: () => Promise<void>;
}

export interface BoundedPoolResult<T> {
  readonly results: readonly (T | undefined)[];
  readonly completed: number;
  readonly stopped: boolean;
  readonly drained: "not_stopped" | "drained" | "timeout";
  readonly errors: readonly unknown[];
}

async function waitForLoops(
  loops: readonly Promise<void>[],
  timeoutMs: number,
): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const drained = Promise.allSettled(loops).then(() => "drained" as const);
  const result = await Promise.race([drained, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    void drained.catch(() => undefined);
  }
  return result;
}

export async function runBoundedPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: BoundedPoolOptions,
): Promise<BoundedPoolResult<R>> {
  const concurrency = assertConcurrency(options.concurrency);
  const cancellation = options.cancellation ?? new RunCancellation();
  const drainTimeoutMs = options.drainTimeoutMs ?? 95_000;
  const yieldBetweenJobs = options.yieldBetweenJobs ?? yieldToEventLoop;
  const results: Array<R | undefined> = new Array(items.length);
  const errors: unknown[] = [];
  let nextIndex = 0;
  let completed = 0;
  let failed = false;

  const workerLoop = async (): Promise<void> => {
    for (;;) {
      if (failed || cancellation.isStopping) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await worker(items[index] as T, index);
        completed += 1;
      } catch (error) {
        errors.push(error);
        failed = true;
        return;
      }
      if (failed || cancellation.isStopping) {
        return;
      }
      await yieldBetweenJobs();
    }
  };

  const loops = Array.from({ length: concurrency }, () => workerLoop());
  const all = Promise.allSettled(loops);
  if (cancellation.isStopping) {
    const drained = await waitForLoops(loops, drainTimeoutMs);
    return { results, completed, stopped: true, drained, errors };
  }

  let unsubscribe = (): void => undefined;
  const stopped = new Promise<"stopped">((resolve) => {
    unsubscribe = cancellation.onStop(() => resolve("stopped"));
  });
  const outcome = await Promise.race([
    all.then(() => "completed" as const),
    stopped,
  ]);
  unsubscribe();
  if (outcome === "completed") {
    return {
      results,
      completed,
      stopped: false,
      drained: "not_stopped",
      errors,
    };
  }
  const drained = await waitForLoops(loops, drainTimeoutMs);
  return { results, completed, stopped: true, drained, errors };
}
