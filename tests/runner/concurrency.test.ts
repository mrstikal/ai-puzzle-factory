import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitRequest,
  createBudgetAccount,
  getBudgetAccount,
} from "../../src/ai/budget.js";
import {
  createMockTransport,
  type MockTransport,
} from "../../src/ai/mock.js";
import {
  createAttempt,
  createLogicalCall,
  getAttempt,
  getLogicalCall,
} from "../../src/ai/ledger.js";
import { main } from "../../src/cli/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import {
  CancellationError,
  RunCancellation,
  markUnfinishedDispatchesUncertain,
  withCancellationTransport,
} from "../../src/runner/cancel.js";
import { prepareSlot } from "../../src/runner/prepare-slot.js";
import {
  mockRoute,
  runSmokeMockExperiment,
  type RunSmokeMockResult,
} from "../../src/runner/run.js";
import {
  assertConcurrency,
  runBoundedPool,
  yieldToEventLoop,
  type Concurrency,
} from "../../src/runner/workers.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getEvents,
  getRun,
  listSlots,
} from "../../src/storage/repository.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174060";
const RUN_ID_ONE = "123e4567-e89b-42d3-a456-426614174061";
const RUN_ID_TWO = "123e4567-e89b-42d3-a456-426614174062";
const ACCOUNT_ID = "p35-smoke-account";
const ACCOUNT_ID_ONE = "p35-smoke-account-one";
const ACCOUNT_ID_TWO = "p35-smoke-account-two";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p35-mock-secret-do-not-persist";

let tempDirectory: string;
let dbPath: string;
let db: Database.Database;
let mock: MockTransport;
let clock: {
  now(): Date;
  sleep(ms: number): Promise<void>;
};

function createClock(): {
  now(): Date;
  sleep(ms: number): Promise<void>;
} {
  let tick = Date.parse(CREATED_AT);
  return {
    now: () => {
      const value = new Date(tick);
      tick += 1000;
      return value;
    },
    sleep: async (_ms: number): Promise<void> => {},
  };
}

function run(overrides: {
  readonly runId?: string;
  readonly accountId?: string;
  readonly transport?: MockTransport;
  readonly concurrency?: Concurrency;
  readonly cancellation?: RunCancellation;
  readonly drainTimeoutMs?: number;
  readonly preparationScenarios?: Readonly<
    Record<
      string,
      {
        readonly spec?: "valid" | "schema_invalid" | "refusal" | "http_error" | "timeout";
        readonly wording?: "valid" | "schema_invalid" | "refusal" | "http_error" | "timeout";
      }
    >
  >;
} = {}) {
  return runSmokeMockExperiment({
    db,
    runId: overrides.runId ?? RUN_ID,
    accountId: overrides.accountId ?? ACCOUNT_ID,
    apiKey: API_KEY,
    transport: overrides.transport ?? mock,
    maxCostUsd: "0",
    concurrency: overrides.concurrency ?? 2,
    ...(overrides.cancellation === undefined
      ? {}
      : { cancellation: overrides.cancellation }),
    ...(overrides.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: overrides.drainTimeoutMs }),
    ...(overrides.preparationScenarios === undefined
      ? {}
      : { preparationScenarios: overrides.preparationScenarios }),
    clock,
  });
}

function requireBarrier(
  result: RunSmokeMockResult,
): NonNullable<RunSmokeMockResult["barrier"]> {
  if (result.barrier === null) {
    throw new Error("expected a persisted duplicate barrier");
  }
  return result.barrier;
}

function count(sql: string, ...params: unknown[]): number {
  return (
    db.prepare(sql).get(...params) as {
      count: number;
    }
  ).count;
}

function createBaseRun(
  runId = RUN_ID,
  accountId = ACCOUNT_ID,
  maxCostUsd = "0",
): void {
  createRun(db, {
    runId,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId,
    runId,
    runKind: "smoke",
    maxCostUsd,
    createdAt: CREATED_AT,
  });
}

async function waitForDispatching(runId: string): Promise<string> {
  const deadline = Date.now() + 800;
  for (;;) {
    const row = db
      .prepare(
        "SELECT attempt_id FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND state = 'dispatching' LIMIT 1",
      )
      .get(runId) as { attempt_id: string } | undefined;
    if (row !== undefined) {
      return row.attempt_id;
    }
    if (Date.now() > deadline) {
      throw new Error("expected a dispatching attempt");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p35-"));
  dbPath = join(tempDirectory, "experiment.sqlite");
  db = openDatabase(dbPath);
  migrate(db);
  clock = createClock();
  mock = createMockTransport({ db, clock, random: () => 0 });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // The CLI test may already have closed its own connection.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("bounded concurrency and cancellation", () => {
  it("accepts only concurrency one or two", async () => {
    expect(assertConcurrency(1)).toBe(1);
    expect(assertConcurrency(2)).toBe(2);
    expect(() => assertConcurrency(0)).toThrow(/1 or 2/);
    expect(() => assertConcurrency(3)).toThrow(/1 or 2/);
    expect(() => assertConcurrency(1.5)).toThrow(/1 or 2/);

    const rejectDb = join(tempDirectory, "reject.sqlite");
    const stderr: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      await expect(
        main([
          "node",
          "experiment",
          "--smoke",
          "--mock",
          "--concurrency",
          "0",
          "--db",
          rejectDb,
        ]),
      ).resolves.toBe(1);
      await expect(
        main([
          "node",
          "experiment",
          "--smoke",
          "--mock",
          "--concurrency",
          "3",
          "--db",
          rejectDb,
        ]),
      ).resolves.toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
    expect(stderr.join("")).toContain("concurrency must be 1 or 2");
    expect(existsSync(rejectDb)).toBe(false);
  });

  it(
    "keeps at most two requests in flight and completes all 20 slots",
    async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const counting: MockTransport = {
        ...mock,
        executeCall: async (input) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await mock.executeCall(input);
          } finally {
            inFlight -= 1;
          }
        },
      };

      const result = await run({ transport: counting, concurrency: 2 });

      expect(result.status).toBe("completed");
      expect(maxInFlight).toBe(2);
      expect(result.summary.terminalSlots).toBe(20);
      expect(result.summary.verdicts).toEqual({
        approved: 20,
        rejected: 0,
        inconclusive: 0,
        generation_error: 0,
      });
      expect(result.summary.callsByRole).toEqual({
        spec: 10,
        wording: 20,
        blind_text: 10,
        blind_vision: 10,
        alignment_text: 10,
        alignment_vision: 10,
      });
      expect(result.summary.unknownAttempts).toBe(0);
      expect(result.summary.cost).toEqual({
        actualCostUsd: "0",
        costStatus: "known",
      });
      expect(getBudgetAccount(db, ACCOUNT_ID).reservedUsd).toBe("0");
    },
    180_000,
  );

  it(
    "produces identical barrier assessments and verdicts at concurrency one and two",
    async () => {
      const one = await run({
        runId: RUN_ID_ONE,
        accountId: ACCOUNT_ID_ONE,
        concurrency: 1,
      });
      const two = await run({
        runId: RUN_ID_TWO,
        accountId: ACCOUNT_ID_TWO,
        concurrency: 2,
      });

      expect(one.status).toBe("completed");
      expect(two.status).toBe("completed");
      const oneBarrier = requireBarrier(one);
      const twoBarrier = requireBarrier(two);
      expect(twoBarrier.resultHash).toBe(oneBarrier.resultHash);
      expect(twoBarrier.assessments).toEqual(oneBarrier.assessments);
      expect(twoBarrier.summary).toEqual(oneBarrier.summary);
      expect(
        two.slots.map((slot) => ({
          slotId: slot.slotId,
          stage: slot.stage,
          verdict: slot.verdict,
        })),
      ).toEqual(
        one.slots.map((slot) => ({
          slotId: slot.slotId,
          stage: slot.stage,
          verdict: slot.verdict,
        })),
      );
      expect(two.summary.verdicts).toEqual(one.summary.verdicts);
      expect(two.summary.callsByRole).toEqual(one.summary.callsByRole);
      expect(getRun(db, RUN_ID_ONE).controlState).toBe("completed");
      expect(getRun(db, RUN_ID_TWO).controlState).toBe("completed");
    },
    240_000,
  );

  it(
    "stops scheduling new slots after cancellation and leaves a resumable checkpoint",
    async () => {
      const cancellation = new RunCancellation();
      let calls = 0;
      const stopping: MockTransport = {
        ...mock,
        executeCall: async (input) => {
          const result = await mock.executeCall(input);
          calls += 1;
          if (calls === 1) {
            cancellation.stop("sigint");
          }
          return result;
        },
      };

      const result = await run({
        transport: stopping,
        concurrency: 2,
        cancellation,
        drainTimeoutMs: 5_000,
      });

      expect(result.status).toBe("cancelled");
      expect(result.summary.status).toBe("cancelled");
      expect(result.summary.terminalSlots).toBe(0);
      expect(result.barrier).toBeNull();
      expect(result.cancellation).toMatchObject({
        reason: "sigint",
        phase: "preparation",
        drained: "drained",
        markedUncertain: 0,
      });
      expect(getRun(db, RUN_ID).controlState).toBe("running");
      const events = getEvents(db, RUN_ID);
      expect(events.some((event) => event.eventType === "run_cancelled")).toBe(
        true,
      );
      expect(
        events.some((event) => event.eventType === "duplicate_barrier"),
      ).toBe(false);
      expect(events.some((event) => event.eventType === "run_completed")).toBe(
        false,
      );
      const slots = listSlots(db, RUN_ID);
      expect(slots).toHaveLength(20);
      expect(slots.every((slot) => slot.stage !== "terminal")).toBe(true);
      expect(slots.some((slot) => slot.stage !== "planned")).toBe(true);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage = 'terminal'",
          RUN_ID,
        ),
      ).toBe(0);
      expect(result.summary.budget.reservedUsd).toBe("0");
      expect(result.summary.budget.unknownExposureUsd).toBe("0");
    },
    180_000,
  );

  it("stops admission at the transport guard after cancellation", async () => {
    const cancellation = new RunCancellation();
    cancellation.stop("writer_lock_compromised");
    const guarded = withCancellationTransport(mock, cancellation);
    await expect(
      guarded.executeCall({
        db,
        accountId: ACCOUNT_ID,
        apiKey: API_KEY,
        logicalCallId: "123e4567-e89b-42d3-a456-426614174099",
        reservationUsd: "0.01",
        nonBilling: true,
      }),
    ).rejects.toBeInstanceOf(CancellationError);
  });

  it("marks an unfinished dispatch uncertain without releasing its reservation", async () => {
    createBaseRun();
    const slowMock = createMockTransport({
      db,
      clock,
      random: () => 0,
      deadlineMs: 1_000,
    });
    const preparation = prepareSlot({
      db,
      runId: RUN_ID,
      slotId: "text-ranking-02",
      accountId: ACCOUNT_ID,
      apiKey: API_KEY,
      transport: slowMock,
      routes: { spec: mockRoute("spec"), wording: mockRoute("wording") },
      reservations: { spec: "0.01", wording: "0.01" },
      mockScenarioKinds: { spec: "timeout" },
      clock,
    });

    const attemptId = await waitForDispatching(RUN_ID);
    const marked = markUnfinishedDispatchesUncertain(
      db,
      RUN_ID,
      "2026-11-05T00:00:05.000Z",
    );
    expect(marked).toContain(attemptId);
    const attempt = getAttempt(db, attemptId);
    expect(attempt.state).toBe("uncertain");
    expect(getLogicalCall(db, attempt.logicalCallId).state).toBe("uncertain");
    const reservation = db
      .prepare(
        "SELECT state, amount_usd, actual_cost_usd FROM budget_reservations WHERE attempt_id = ?",
      )
      .get(attemptId) as {
      state: string;
      amount_usd: string;
      actual_cost_usd: string | null;
    };
    expect(["reserved", "unknown"]).toContain(reservation.state);
    expect(reservation.amount_usd).toBe("0");
    expect(reservation.actual_cost_usd).toBeNull();

    await expect(preparation).rejects.toThrow();
  });

  it(
    "reports a drain timeout and marks the unfinished dispatch uncertain",
    async () => {
      const cancellation = new RunCancellation();
      let dispatchingAttemptId: string | null = null;
      let scheduled = false;
      let poller: Promise<void> | null = null;
      let pollerError: unknown = null;
      const slowMock = createMockTransport({
        db,
        clock,
        random: () => 0,
        deadlineMs: 400,
      });
      const blocking: MockTransport = {
        ...slowMock,
        executeCall: async (input) => {
          if (!scheduled) {
            scheduled = true;
            poller = (async () => {
              try {
                dispatchingAttemptId = await waitForDispatching(RUN_ID);
                cancellation.stop("sigint");
              } catch (error) {
                pollerError = error;
                cancellation.stop("test");
              }
            })();
          }
          return slowMock.executeCall(input);
        },
      };

      const result = await run({
        transport: blocking,
        concurrency: 2,
        cancellation,
        drainTimeoutMs: 50,
        preparationScenarios: {
          "text-ranking-02": { spec: "timeout" },
        },
      });

      expect(pollerError).toBeNull();
      expect(result.status).toBe("cancelled");
      expect(result.cancellation?.reason).toBe("sigint");
      expect(result.cancellation?.phase).toBe("preparation");
      expect(result.cancellation?.drained).toBe("timeout");
      expect(result.cancellation?.markedUncertain).toBeGreaterThanOrEqual(1);
      if (dispatchingAttemptId === null) {
        throw new Error(
          `expected a dispatching attempt${
            pollerError === null ? "" : `: ${String(pollerError)}`
          }`,
        );
      }
      const attempt = getAttempt(db, dispatchingAttemptId);
      expect(attempt.state).toBe("uncertain");
      const reservation = db
        .prepare(
          "SELECT state, actual_cost_usd FROM budget_reservations WHERE attempt_id = ?",
        )
        .get(dispatchingAttemptId) as {
        state: string;
        actual_cost_usd: string | null;
      };
      expect(["reserved", "unknown"]).toContain(reservation.state);
      expect(reservation.actual_cost_usd).toBeNull();
      expect(getEvents(db, RUN_ID).some((event) => event.eventType === "run_completed")).toBe(
        false,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (poller === null) {
        throw new Error("expected a dispatching poller");
      }
      await poller;
      expect(pollerError).toBeNull();
    },
    30_000,
  );

  it(
    "admits only one of two pool workers against a one-reservation cap",
    async () => {
      createBaseRun(RUN_ID, ACCOUNT_ID, "0.01");
      const first = createLogicalCall(db, {
        runId: RUN_ID,
        slotId: "text-ranking-01",
        role: "spec",
        runKind: "smoke",
        requestBody: { model: "mock/model", messages: [] },
        expectedSchemaHash: "a".repeat(64),
        model: "mock/model",
        provider: "mock",
        createdAt: CREATED_AT,
      });
      const second = createLogicalCall(db, {
        runId: RUN_ID,
        slotId: "text-ranking-02",
        role: "spec",
        runKind: "smoke",
        requestBody: { model: "mock/model", messages: [] },
        expectedSchemaHash: "a".repeat(64),
        model: "mock/model",
        provider: "mock",
        createdAt: CREATED_AT,
      });
      const firstAttempt = createAttempt(db, {
        logicalCallId: first.logicalCallId,
        createdAt: CREATED_AT,
      });
      const secondAttempt = createAttempt(db, {
        logicalCallId: second.logicalCallId,
        createdAt: CREATED_AT,
      });

      const pool = await runBoundedPool(
        [firstAttempt, secondAttempt],
        async (attempt) =>
          admitRequest(db, {
            accountId: ACCOUNT_ID,
            logicalCallId: attempt.logicalCallId,
            attemptId: attempt.attemptId,
            kind: "attempt",
            amountUsd: "0.01",
            nonBilling: false,
            createdAt: CREATED_AT,
          }),
        { concurrency: 2, yieldBetweenJobs: yieldToEventLoop },
      );

      expect(pool.stopped).toBe(false);
      expect(pool.errors).toEqual([]);
      const admitted = pool.results.filter(
        (result) => result !== undefined && result.admitted,
      );
      const blocked = pool.results.filter(
        (result) =>
          result !== undefined &&
          !result.admitted &&
          result.reason === "INSUFFICIENT_BUDGET",
      );
      expect(admitted).toHaveLength(1);
      expect(blocked).toHaveLength(1);
      const account = getBudgetAccount(db, ACCOUNT_ID);
      expect(account.knownActualUsd).toBe("0");
      expect(account.reservedUsd).toBe("0.01");
      expect(account.maxCostUsd).toBe("0.01");
      expect(
        count(
          "SELECT COUNT(*) AS count FROM budget_events WHERE account_id = ? AND event_type = 'pause'",
          ACCOUNT_ID,
        ),
      ).toBe(1);
    },
    30_000,
  );

  it(
    "runs the pool without starvation",
    async () => {
      const completed: number[] = [];
      const pool = await runBoundedPool(
        Array.from({ length: 20 }, (_, index) => index),
        async (index) => {
          completed.push(index);
          return index;
        },
        { concurrency: 2, yieldBetweenJobs: yieldToEventLoop },
      );
      expect(pool.stopped).toBe(false);
      expect(pool.errors).toEqual([]);
      expect(pool.completed).toBe(20);
      expect(pool.results).toEqual(Array.from({ length: 20 }, (_, index) => index));
      expect(new Set(completed)).toEqual(
        new Set(Array.from({ length: 20 }, (_, index) => index)),
      );
    },
    30_000,
  );
});
