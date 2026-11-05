import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BudgetError,
  addUsd,
  admitRequest,
  compareUsd,
  createBudgetAccount,
  getBudgetAccount,
  getBudgetSummary,
  increaseBudgetCap,
  listBudgetEvents,
  releaseReservation,
  settleReservation,
  type AdmissionAdmitted,
} from "../../src/ai/budget.js";
import {
  LedgerError,
  createAttempt,
  createLogicalCall,
  getLogicalCall,
  markAttemptDispatching,
  markAttemptRefusedUnprocessed,
  resumeDisposition,
  saveAttemptResponse,
  type LogicalCall,
} from "../../src/ai/ledger.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { createRun } from "../../src/storage/repository.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const FULL_PLAN = buildPlanManifest({ runKind: "full" });
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const SCHEMA_HASH = "a".repeat(64);

let tempDirectory: string;
let databasePath: string;
let db: Database.Database;
let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  const suffix = String(runCounter).padStart(12, "0");
  return `123e4567-e89b-42d3-a456-${suffix}`;
}

function at(seconds: number): string {
  return `2026-11-05T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function createSmokeRun(): { runId: string; slotId: string } {
  const runId = nextRunId();
  createRun(db, {
    runId,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  const slot = SMOKE_PLAN.slots[0];
  if (slot === undefined) {
    throw new Error("smoke plan has no slots");
  }
  return { runId, slotId: slot.slotId };
}

function createFullRun(): { runId: string; slotId: string } {
  const runId = nextRunId();
  createRun(db, {
    runId,
    plan: FULL_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  const slot = FULL_PLAN.slots[0];
  if (slot === undefined) {
    throw new Error("full plan has no slots");
  }
  return { runId, slotId: slot.slotId };
}

function makeCall(
  input: {
    runId?: string | null;
    slotId?: string | null;
    probeKey?: string | null;
    role?: "spec" | "wording" | "blind_text" | "preflight";
    runKind?: "full" | "smoke" | "calibration" | "preflight";
    requestBody?: unknown;
    requestHash?: string;
    createdAt?: string;
  } = {},
): LogicalCall {
  return createLogicalCall(db, {
    runId: input.runId ?? null,
    slotId: input.slotId ?? null,
    probeKey: input.probeKey ?? null,
    role: input.role ?? "spec",
    runKind: input.runKind ?? "smoke",
    requestBody: input.requestBody ?? { messages: [{ role: "user", content: "hello" }] },
    ...(input.requestHash === undefined ? {} : { requestHash: input.requestHash }),
    expectedSchemaHash: SCHEMA_HASH,
    model: "generator-model",
    provider: "provider-tag",
    createdAt: input.createdAt ?? at(0),
  });
}

function makeAttempt(logicalCallId: string, createdAt = at(1)) {
  return createAttempt(db, { logicalCallId, createdAt });
}

function makeAccount(
  accountId: string,
  runId: string | null,
  runKind: "full" | "smoke" | "calibration" | "preflight",
  maxCostUsd: string,
) {
  return createBudgetAccount(db, {
    accountId,
    runId,
    runKind,
    maxCostUsd,
    createdAt: CREATED_AT,
  });
}

function expectAdmitted(result: ReturnType<typeof admitRequest>): AdmissionAdmitted {
  expect(result.admitted).toBe(true);
  if (!result.admitted) {
    throw new Error(`expected admission, received ${result.reason}`);
  }
  return result;
}

function expectLedgerError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    return;
  }
  throw new Error(`expected LedgerError ${code}`);
}

function expectBudgetError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).code).toBe(code);
    return;
  }
  throw new Error(`expected BudgetError ${code}`);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-budget-"));
  databasePath = join(tempDirectory, "experiment.sqlite");
  db = openDatabase(databasePath);
  migrate(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // A test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("logical call ledger", () => {
  it("enforces unique slot and probe keys and derives the spending pool", () => {
    const { runId, slotId } = createSmokeRun();
    const slotCall = makeCall({ runId, slotId });
    expect(slotCall.state).toBe("prepared");
    expect(slotCall.pool).toBe("smoke");
    expect(slotCall.requestHash).toHaveLength(64);
    expectLedgerError(() => makeCall({ runId, slotId }), "DUPLICATE_LOGICAL_CALL");
    expectLedgerError(
      () => makeCall({ runId, slotId, runKind: "full" }),
      "RUN_KIND_MISMATCH",
    );

    const preflight = makeCall({
      role: "preflight",
      runKind: "preflight",
      probeKey: "probe-1",
    });
    expect(preflight.pool).toBe("preflight");
    expectLedgerError(
      () =>
        makeCall({
          role: "preflight",
          runKind: "preflight",
          probeKey: "probe-1",
        }),
      "DUPLICATE_LOGICAL_CALL",
    );

    const calibration = makeCall({
      role: "blind_text",
      runKind: "calibration",
      probeKey: "fixture-1",
    });
    expect(calibration.pool).toBe("calibration");
    expectLedgerError(
      () =>
        makeCall({
          role: "blind_text",
          runKind: "calibration",
          probeKey: "fixture-1",
        }),
      "DUPLICATE_LOGICAL_CALL",
    );

    expectLedgerError(
      () => makeCall({ role: "spec", runKind: "full" }),
      "INVALID_INPUT",
    );
  });

  it("classifies prepared and dispatching crashes and caps attempts at three", () => {
    const { runId, slotId } = createSmokeRun();
    const call = makeCall({ runId, slotId });
    const attempt = makeAttempt(call.logicalCallId);
    expect(attempt.requestHash).toBe(call.requestHash);
    expect(resumeDisposition(call.state)).toBe("send_prepared");
    expectLedgerError(
      () => markAttemptDispatching(db, attempt.attemptId, at(2)),
      "INVALID_STATE",
    );

    makeAccount("dispatch-account", runId, "smoke", "1");
    expectAdmitted(
      admitRequest(db, {
        accountId: "dispatch-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(2),
      }),
    );
    markAttemptDispatching(db, attempt.attemptId, at(2));
    expect(getLogicalCall(db, call.logicalCallId).state).toBe("dispatching");
    expect(resumeDisposition("dispatching")).toBe("uncertain_no_resend");
    expectLedgerError(
      () => makeAttempt(call.logicalCallId, at(3)),
      "INVALID_STATE",
    );

    const other = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(4),
    });
    makeAttempt(other.logicalCallId, at(5));
    makeAttempt(other.logicalCallId, at(6));
    makeAttempt(other.logicalCallId, at(7));
    expectLedgerError(
      () => makeAttempt(other.logicalCallId, at(8)),
      "TOO_MANY_ATTEMPTS",
    );
  });

  it("persists vision request intent with split text and PNG bounds", () => {
    const smallPng = Buffer.alloc(1024, 1).toString("base64");
    const visionCall = makeCall({
      role: "preflight",
      runKind: "preflight",
      probeKey: "vision-small",
      requestBody: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${smallPng}` },
              },
            ],
          },
        ],
      },
    });
    expect(visionCall.requestHash).toHaveLength(64);
    expectLedgerError(
      () =>
        makeCall({
          role: "preflight",
          runKind: "preflight",
          probeKey: "vision-text",
          requestBody: {
            text: "x".repeat(70_000),
            image_url: `data:image/png;base64,${smallPng}`,
          },
        }),
      "REQUEST_TOO_LARGE",
    );
    const bigPng = Buffer.alloc(1_048_577, 1).toString("base64");
    expectLedgerError(
      () =>
        makeCall({
          role: "preflight",
          runKind: "preflight",
          probeKey: "vision-big",
          requestBody: {
            image_url: `data:image/png;base64,${bigPng}`,
          },
        }),
      "REQUEST_TOO_LARGE",
    );
    expectLedgerError(
      () =>
        makeCall({
          role: "preflight",
          runKind: "preflight",
          probeKey: "vision-jpeg",
          requestBody: {
            image_url: "data:image/jpeg;base64,AAAA",
          },
        }),
      "UNSUPPORTED_MEDIA",
    );
  });

  it("rejects oversized request bodies and mismatched request hashes", () => {
    const { runId, slotId } = createSmokeRun();
    expectLedgerError(
      () =>
        makeCall({
          runId,
          slotId,
          requestBody: { text: "x".repeat(70_000) },
        }),
      "REQUEST_TOO_LARGE",
    );
    expectLedgerError(
      () =>
        makeCall({
          runId,
          slotId,
          requestHash: "b".repeat(64),
        }),
      "INVALID_INPUT",
    );
  });
});

describe("transactional budget admission", () => {
  it("adds 0.1 and 0.2 with exact decimal money", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("smoke-account", runId, "smoke", "0.30");
    const firstCall = makeCall({ runId, slotId, createdAt: at(0) });
    const firstAttempt = makeAttempt(firstCall.logicalCallId, at(1));
    const first = expectAdmitted(
      admitRequest(db, {
        accountId: "smoke-account",
        logicalCallId: firstCall.logicalCallId,
        attemptId: firstAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(2),
      }),
    );
    settleReservation(db, {
      reservationId: first.reservation.reservationId,
      actualCostUsd: "0.1",
      createdAt: at(3),
    });

    const secondCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(4),
    });
    const secondAttempt = makeAttempt(secondCall.logicalCallId, at(5));
    const second = expectAdmitted(
      admitRequest(db, {
        accountId: "smoke-account",
        logicalCallId: secondCall.logicalCallId,
        attemptId: secondAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(6),
      }),
    );
    settleReservation(db, {
      reservationId: second.reservation.reservationId,
      actualCostUsd: "0.2",
      createdAt: at(7),
    });

    const account = getBudgetAccount(db, "smoke-account");
    expect(account.maxCostUsd).toBe("0.3");
    expect(account.knownActualUsd).toBe("0.3");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
    expect(addUsd("0.1", "0.2")).toBe("0.3");
    expect(compareUsd(account.knownActualUsd, "0.3")).toBe(0);
    const summary = getBudgetSummary(db);
    expect(summary.byRole.find((entry) => entry.role === "spec")).toMatchObject({
      knownActualUsd: "0.3",
      reservedUsd: "0",
      unknownExposureUsd: "0",
    });
  });

  it("cannot spend the same remaining reservation twice at the boundary", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("boundary-account", runId, "smoke", "0.3");
    const firstCall = makeCall({ runId, slotId, createdAt: at(0) });
    const firstAttempt = makeAttempt(firstCall.logicalCallId, at(1));
    expectAdmitted(
      admitRequest(db, {
        accountId: "boundary-account",
        logicalCallId: firstCall.logicalCallId,
        attemptId: firstAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(2),
      }),
    );

    const secondCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(3),
    });
    const secondAttempt = makeAttempt(secondCall.logicalCallId, at(4));
    const secondDb = openDatabase(databasePath);
    let second: ReturnType<typeof admitRequest>;
    try {
      second = admitRequest(secondDb, {
        accountId: "boundary-account",
        logicalCallId: secondCall.logicalCallId,
        attemptId: secondAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(5),
      });
    } finally {
      secondDb.close();
    }
    expect(second.admitted).toBe(false);
    if (!second.admitted) {
      expect(second.reason).toBe("INSUFFICIENT_BUDGET");
    }
    const account = getBudgetAccount(db, "boundary-account");
    expect(account.reservedUsd).toBe("0.2");
    expect(account.knownActualUsd).toBe("0");
    expect(countRows("budget_reservations")).toBe(1);
    const run = db.prepare("SELECT control_state FROM runs WHERE run_id = ?").get(runId) as {
      control_state: string;
    };
    expect(run.control_state).toBe("paused_budget");

    const thirdCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[2]?.slotId ?? slotId,
      createdAt: at(6),
    });
    const thirdAttempt = makeAttempt(thirdCall.logicalCallId, at(7));
    const third = admitRequest(db, {
      accountId: "boundary-account",
      logicalCallId: thirdCall.logicalCallId,
      attemptId: thirdAttempt.attemptId,
      kind: "attempt",
      amountUsd: "0",
      createdAt: at(8),
    });
    expect(third.admitted).toBe(false);
    if (!third.admitted) {
      expect(third.reason).toBe("RUN_PAUSED");
    }
  });

  it("serializes overlapping admissions at the boundary with exactly one reservation", async () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("overlap-account", runId, "smoke", "0.3");
    const parentCall = makeCall({ runId, slotId, createdAt: at(0) });
    const parentAttempt = makeAttempt(parentCall.logicalCallId, at(1));
    const workerCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(2),
    });
    const workerAttempt = makeAttempt(workerCall.logicalCallId, at(3));
    const parentInput = {
      accountId: "overlap-account",
      logicalCallId: parentCall.logicalCallId,
      attemptId: parentAttempt.attemptId,
      kind: "attempt",
      amountUsd: "0.2",
      createdAt: at(4),
    };
    const workerInput = {
      accountId: "overlap-account",
      logicalCallId: workerCall.logicalCallId,
      attemptId: workerAttempt.attemptId,
      kind: "attempt",
      amountUsd: "0.2",
      createdAt: at(4),
    };
    const readyPath = join(tempDirectory, "worker-ready");
    const goPath = join(tempDirectory, "worker-go");
    const resultPath = join(tempDirectory, "worker-result.json");
    const errorPath = join(tempDirectory, "worker-error.json");
    const script = `
      import { existsSync, writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const { openDatabase } = await import(
        pathToFileURL(process.cwd() + "/src/storage/database.ts").href
      );
      const { admitRequest } = await import(
        pathToFileURL(process.cwd() + "/src/ai/budget.ts").href
      );
      const db = openDatabase(process.env.DB_PATH);
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = admitRequest(db, JSON.parse(process.env.INPUT_JSON));
        writeFileSync(process.env.READY_PATH, "ready");
        while (!existsSync(process.env.GO_PATH)) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        db.exec("COMMIT");
        writeFileSync(process.env.RESULT_PATH, JSON.stringify(result));
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        writeFileSync(
          process.env.ERROR_PATH,
          JSON.stringify({
            code: error && error.code ? error.code : null,
            message: String(error),
          }),
        );
      } finally {
        db.close();
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_PATH: databasePath,
          READY_PATH: readyPath,
          GO_PATH: goPath,
          RESULT_PATH: resultPath,
          ERROR_PATH: errorPath,
          INPUT_JSON: JSON.stringify(workerInput),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath)) {
        if (Date.now() > deadline) {
          throw new Error(`worker did not become ready: ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(goPath, "go");
      const parentResult = admitRequest(db, parentInput);
      const exitCode = await exited;
      if (existsSync(errorPath)) {
        const workerError = JSON.parse(readFileSync(errorPath, "utf8")) as {
          code: string | null;
          message: string;
        };
        throw new Error(`worker admission failed: ${workerError.code} ${workerError.message}`);
      }
      if (exitCode !== 0 || !existsSync(resultPath)) {
        throw new Error(`worker exited ${String(exitCode)}: ${stderr}`);
      }
      const workerResult = JSON.parse(readFileSync(resultPath, "utf8")) as ReturnType<
        typeof admitRequest
      >;
      expect(workerResult.admitted).toBe(true);
      expect(parentResult.admitted).toBe(false);
      if (!parentResult.admitted) {
        expect(parentResult.reason).toBe("INSUFFICIENT_BUDGET");
      }
      expect(countRows("budget_reservations")).toBe(1);
      const account = getBudgetAccount(db, "overlap-account");
      expect(account.reservedUsd).toBe("0.2");
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  }, 15000);

  it("returns a typed BUDGET_BUSY when another writer holds the admission lock", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("busy-account", runId, "smoke", "1");
    const call = makeCall({ runId, slotId, createdAt: at(0) });
    const attempt = makeAttempt(call.logicalCallId, at(1));
    const secondDb = openDatabase(databasePath);
    secondDb.pragma("busy_timeout = 10");
    db.exec("BEGIN IMMEDIATE");
    try {
      expectBudgetError(
        () =>
          admitRequest(secondDb, {
            accountId: "busy-account",
            logicalCallId: call.logicalCallId,
            attemptId: attempt.attemptId,
            kind: "attempt",
            amountUsd: "0.1",
            createdAt: at(2),
          }),
        "BUDGET_BUSY",
      );
    } finally {
      db.exec("ROLLBACK");
      secondDb.close();
    }
    expectAdmitted(
      admitRequest(db, {
        accountId: "busy-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(3),
      }),
    );
  });

  it("distinguishes explicit zero cost from missing actual cost", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("zero-account", runId, "smoke", "1");
    const zeroCall = makeCall({ runId, slotId, createdAt: at(0) });
    const zeroAttempt = makeAttempt(zeroCall.logicalCallId, at(1));
    const zeroReservation = expectAdmitted(
      admitRequest(db, {
        accountId: "zero-account",
        logicalCallId: zeroCall.logicalCallId,
        attemptId: zeroAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(2),
      }),
    );
    const zeroSettled = settleReservation(db, {
      reservationId: zeroReservation.reservation.reservationId,
      actualCostUsd: "0",
      createdAt: at(3),
    });
    expect(zeroSettled.state).toBe("settled");
    expect(zeroSettled.actualCostUsd).toBe("0");
    let account = getBudgetAccount(db, "zero-account");
    expect(account.knownActualUsd).toBe("0");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");

    const unknownCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(4),
    });
    const unknownAttempt = makeAttempt(unknownCall.logicalCallId, at(5));
    const unknownReservation = expectAdmitted(
      admitRequest(db, {
        accountId: "zero-account",
        logicalCallId: unknownCall.logicalCallId,
        attemptId: unknownAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(6),
      }),
    );
    const unknownSettled = settleReservation(db, {
      reservationId: unknownReservation.reservation.reservationId,
      actualCostUsd: null,
      createdAt: at(7),
    });
    expect(unknownSettled.state).toBe("unknown");
    expect(unknownSettled.actualCostUsd).toBeNull();
    account = getBudgetAccount(db, "zero-account");
    expect(account.knownActualUsd).toBe("0");
    expect(account.reservedUsd).toBe("0.2");
    expect(account.unknownExposureUsd).toBe("0.2");
    const summary = getBudgetSummary(db);
    expect(summary.byRole.find((entry) => entry.role === "spec")).toMatchObject({
      knownActualUsd: "0",
      reservedUsd: "0.2",
      unknownExposureUsd: "0.2",
    });
  });

  it("does not double count unknown exposure for unknown-kind reservations", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("unknown-kind-account", runId, "smoke", "1");
    const call = makeCall({ runId, slotId, createdAt: at(0) });
    const attempt = makeAttempt(call.logicalCallId, at(1));
    const admitted = expectAdmitted(
      admitRequest(db, {
        accountId: "unknown-kind-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "unknown",
        amountUsd: "0.2",
        createdAt: at(2),
      }),
    );
    let account = getBudgetAccount(db, "unknown-kind-account");
    expect(account.reservedUsd).toBe("0.2");
    expect(account.unknownExposureUsd).toBe("0.2");
    expect(
      getBudgetSummary(db).byRole.find((entry) => entry.role === "spec"),
    ).toMatchObject({
      reservedUsd: "0.2",
      unknownExposureUsd: "0.2",
    });
    const unknown = settleReservation(db, {
      reservationId: admitted.reservation.reservationId,
      actualCostUsd: null,
      createdAt: at(3),
    });
    expect(unknown.state).toBe("unknown");
    account = getBudgetAccount(db, "unknown-kind-account");
    expect(account.reservedUsd).toBe("0.2");
    expect(account.unknownExposureUsd).toBe("0.2");
    releaseReservation(db, {
      reservationId: admitted.reservation.reservationId,
      createdAt: at(4),
    });
    account = getBudgetAccount(db, "unknown-kind-account");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
  });

  it("records actual overshoot and pauses further admissions", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("overshoot-account", runId, "smoke", "0.2");
    const call = makeCall({ runId, slotId, createdAt: at(0) });
    const attempt = makeAttempt(call.logicalCallId, at(1));
    const admitted = expectAdmitted(
      admitRequest(db, {
        accountId: "overshoot-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(2),
      }),
    );
    settleReservation(db, {
      reservationId: admitted.reservation.reservationId,
      actualCostUsd: "0.25",
      createdAt: at(3),
    });
    const account = getBudgetAccount(db, "overshoot-account");
    expect(account.knownActualUsd).toBe("0.25");
    expect(account.reservedUsd).toBe("0");
    const run = db.prepare("SELECT control_state FROM runs WHERE run_id = ?").get(runId) as {
      control_state: string;
    };
    expect(run.control_state).toBe("paused_budget");
    const events = listBudgetEvents(db, "overshoot-account");
    expect(
      events.some(
        (event) =>
          event.eventType === "overshoot" && event.amountUsd === "0.15",
      ),
    ).toBe(true);

    const secondCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(4),
    });
    const secondAttempt = makeAttempt(secondCall.logicalCallId, at(5));
    const second = admitRequest(db, {
      accountId: "overshoot-account",
      logicalCallId: secondCall.logicalCallId,
      attemptId: secondAttempt.attemptId,
      kind: "attempt",
      amountUsd: "0.01",
      createdAt: at(6),
    });
    expect(second.admitted).toBe(false);
    if (!second.admitted) {
      expect(second.reason).toBe("RUN_PAUSED");
    }
  });

  it("retains unknown reservations and releases their exposure only on release", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("unknown-account", runId, "smoke", "0.3");
    const firstCall = makeCall({ runId, slotId, createdAt: at(0) });
    const firstAttempt = makeAttempt(firstCall.logicalCallId, at(1));
    const first = expectAdmitted(
      admitRequest(db, {
        accountId: "unknown-account",
        logicalCallId: firstCall.logicalCallId,
        attemptId: firstAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(2),
      }),
    );
    const unknown = settleReservation(db, {
      reservationId: first.reservation.reservationId,
      actualCostUsd: null,
      createdAt: at(3),
    });
    expect(unknown.state).toBe("unknown");
    let account = getBudgetAccount(db, "unknown-account");
    expect(account.reservedUsd).toBe("0.2");
    expect(account.unknownExposureUsd).toBe("0.2");

    const secondCall = makeCall({
      runId,
      slotId: SMOKE_PLAN.slots[1]?.slotId ?? slotId,
      createdAt: at(4),
    });
    const secondAttempt = makeAttempt(secondCall.logicalCallId, at(5));
    const second = admitRequest(db, {
      accountId: "unknown-account",
      logicalCallId: secondCall.logicalCallId,
      attemptId: secondAttempt.attemptId,
      kind: "attempt",
      amountUsd: "0.2",
      createdAt: at(6),
    });
    expect(second.admitted).toBe(false);
    account = getBudgetAccount(db, "unknown-account");
    expect(account.reservedUsd).toBe("0.2");
    expect(account.unknownExposureUsd).toBe("0.2");

    const released = releaseReservation(db, {
      reservationId: first.reservation.reservationId,
      createdAt: at(7),
    });
    expect(released.state).toBe("released");
    account = getBudgetAccount(db, "unknown-account");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
  });

  it("keeps calibration and primary spending separate", () => {
    const full = createFullRun();
    makeAccount("primary-account", full.runId, "full", "0.1");
    makeAccount("calibration-account", null, "calibration", "0.1");
    const primaryCall = makeCall({
      runId: full.runId,
      slotId: full.slotId,
      role: "spec",
      runKind: "full",
      createdAt: at(0),
    });
    const primaryAttempt = makeAttempt(primaryCall.logicalCallId, at(1));
    const primary = expectAdmitted(
      admitRequest(db, {
        accountId: "primary-account",
        logicalCallId: primaryCall.logicalCallId,
        attemptId: primaryAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(2),
      }),
    );
    settleReservation(db, {
      reservationId: primary.reservation.reservationId,
      actualCostUsd: "0.1",
      createdAt: at(3),
    });

    const calibrationCall = makeCall({
      role: "blind_text",
      runKind: "calibration",
      probeKey: "fixture-1",
      createdAt: at(4),
    });
    const calibrationAttempt = makeAttempt(calibrationCall.logicalCallId, at(5));
    const calibration = expectAdmitted(
      admitRequest(db, {
        accountId: "calibration-account",
        logicalCallId: calibrationCall.logicalCallId,
        attemptId: calibrationAttempt.attemptId,
        kind: "attempt",
        amountUsd: "0.05",
        createdAt: at(6),
      }),
    );
    settleReservation(db, {
      reservationId: calibration.reservation.reservationId,
      actualCostUsd: "0.05",
      createdAt: at(7),
    });

    expect(getBudgetAccount(db, "primary-account").knownActualUsd).toBe("0.1");
    expect(getBudgetAccount(db, "calibration-account").knownActualUsd).toBe("0.05");
    const summary = getBudgetSummary(db);
    expect(summary.byRunKind.find((entry) => entry.runKind === "full")?.knownActualUsd).toBe(
      "0.1",
    );
    expect(
      summary.byRunKind.find((entry) => entry.runKind === "calibration")?.knownActualUsd,
    ).toBe("0.05");
    expect(
      summary.byRole.find((entry) => entry.role === "blind_text")?.knownActualUsd,
    ).toBe("0.05");
  });

  it("requires an explicitly nonbilling transport on a zero budget", () => {
    makeAccount("zero-budget", null, "preflight", "0");
    const blockedCall = makeCall({
      role: "preflight",
      runKind: "preflight",
      probeKey: "probe-blocked",
      createdAt: at(0),
    });
    const blockedAttempt = makeAttempt(blockedCall.logicalCallId, at(1));
    const blocked = admitRequest(db, {
      accountId: "zero-budget",
      logicalCallId: blockedCall.logicalCallId,
      attemptId: blockedAttempt.attemptId,
      kind: "attempt",
      amountUsd: "0",
      createdAt: at(2),
    });
    expect(blocked.admitted).toBe(false);
    if (!blocked.admitted) {
      expect(blocked.reason).toBe("INSUFFICIENT_BUDGET");
    }

    const freeCall = makeCall({
      role: "preflight",
      runKind: "preflight",
      probeKey: "probe-free",
      createdAt: at(3),
    });
    const freeAttempt = makeAttempt(freeCall.logicalCallId, at(4));
    const free = expectAdmitted(
      admitRequest(db, {
        accountId: "zero-budget",
        logicalCallId: freeCall.logicalCallId,
        attemptId: freeAttempt.attemptId,
        kind: "nonbilling",
        amountUsd: "0",
        nonBilling: true,
        createdAt: at(5),
      }),
    );
    expect(free.reservation.kind).toBe("nonbilling");
    expect(free.reservation.amountUsd).toBe("0");
    const account = getBudgetAccount(db, "zero-budget");
    expect(account.knownActualUsd).toBe("0");
    expect(account.reservedUsd).toBe("0");
  });

  it("reopens a dispatching crash without silently resending and retains its reservation", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("crash-account", runId, "smoke", "1");
    const call = makeCall({ runId, slotId, createdAt: at(0) });
    const attempt = makeAttempt(call.logicalCallId, at(1));
    const admitted = expectAdmitted(
      admitRequest(db, {
        accountId: "crash-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(2),
      }),
    );
    markAttemptDispatching(db, attempt.attemptId, at(3));
    db.close();
    db = openDatabase(databasePath);
    migrate(db);
    const reopened = getLogicalCall(db, call.logicalCallId);
    expect(reopened.state).toBe("dispatching");
    expect(resumeDisposition(reopened.state)).toBe("uncertain_no_resend");
    const account = getBudgetAccount(db, "crash-account");
    expect(account.reservedUsd).toBe("0.2");
    const reservation = db
      .prepare("SELECT state FROM budget_reservations WHERE reservation_id = ?")
      .get(admitted.reservation.reservationId) as { state: string };
    expect(reservation.state).toBe("reserved");
  });

  it("releases a certified unprocessed refusal reservation", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("refusal-account", runId, "smoke", "1");
    const call = makeCall({ runId, slotId, createdAt: at(0) });
    const attempt = makeAttempt(call.logicalCallId, at(1));
    const admitted = expectAdmitted(
      admitRequest(db, {
        accountId: "refusal-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "attempt",
        amountUsd: "0.2",
        createdAt: at(2),
      }),
    );
    markAttemptDispatching(db, attempt.attemptId, at(3));
    saveAttemptResponse(db, {
      attemptId: attempt.attemptId,
      finishedAt: at(4),
      elapsedMs: 1000,
      httpStatus: 429,
      generationId: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorClassification: "rate_limit",
      partialCompletion: false,
      actualCostUsd: null,
      updatedAt: at(4),
    });
    const refused = markAttemptRefusedUnprocessed(db, attempt.attemptId, at(5));
    expect(refused.state).toBe("refused_unprocessed");
    expect(getLogicalCall(db, call.logicalCallId).state).toBe("refused_unprocessed");
    const released = releaseReservation(db, {
      reservationId: admitted.reservation.reservationId,
      createdAt: at(6),
    });
    expect(released.state).toBe("released");
    const account = getBudgetAccount(db, "refusal-account");
    expect(account.knownActualUsd).toBe("0");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
  });

  it("rejects duplicate reservations and keeps budget/request events append-only", () => {
    const { runId, slotId } = createSmokeRun();
    makeAccount("audit-account", runId, "smoke", "1");
    const call = makeCall({ runId, slotId, createdAt: at(0) });
    const attempt = makeAttempt(call.logicalCallId, at(1));
    expectAdmitted(
      admitRequest(db, {
        accountId: "audit-account",
        logicalCallId: call.logicalCallId,
        attemptId: attempt.attemptId,
        kind: "attempt",
        amountUsd: "0.1",
        createdAt: at(2),
      }),
    );
    expectBudgetError(
      () =>
        admitRequest(db, {
          accountId: "audit-account",
          logicalCallId: call.logicalCallId,
          attemptId: attempt.attemptId,
          kind: "attempt",
          amountUsd: "0.1",
          createdAt: at(3),
        }),
      "DUPLICATE_RESERVATION",
    );
    expect(() =>
      db.prepare("UPDATE budget_events SET amount_usd = '9' WHERE event_id = 1").run(),
    ).toThrow();
    expect(() => db.prepare("DELETE FROM budget_events WHERE event_id = 1").run()).toThrow();
    expect(() =>
      db.prepare("UPDATE request_events SET event_type = 'tampered' WHERE event_id = 1").run(),
    ).toThrow();
    expect(() => db.prepare("DELETE FROM request_events WHERE event_id = 1").run()).toThrow();
    expect(() => db.prepare("DELETE FROM logical_calls").run()).toThrow();
  });

  it("requires acknowledgement before increasing a budget cap", () => {
    const { runId } = createSmokeRun();
    makeAccount("cap-account", runId, "smoke", "0.1");
    expectBudgetError(
      () =>
        increaseBudgetCap(db, {
          accountId: "cap-account",
          newMaxCostUsd: "0.2",
          operator: "operator@example.test",
          acknowledged: false,
          createdAt: at(0),
        }),
      "CAP_CHANGE_UNAUTHORIZED",
    );
    const increased = increaseBudgetCap(db, {
      accountId: "cap-account",
      newMaxCostUsd: "0.2",
      operator: "operator@example.test",
      acknowledged: true,
      createdAt: at(1),
    });
    expect(increased.maxCostUsd).toBe("0.2");
    const event = listBudgetEvents(db, "cap-account").find(
      (entry) => entry.eventType === "cap_change",
    );
    expect(event?.payload).toMatchObject({
      oldMaxCostUsd: "0.1",
      newMaxCostUsd: "0.2",
      operator: "operator@example.test",
      acknowledged: true,
    });
  });
});
