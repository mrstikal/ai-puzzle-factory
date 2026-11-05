import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBudgetAccount,
  getBudgetAccount,
} from "../../src/ai/budget.js";
import { getLogicalCall, listAttempts } from "../../src/ai/ledger.js";
import { createMockTransport } from "../../src/ai/mock.js";
import { main } from "../../src/cli/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { resumeSmokeExperiment } from "../../src/runner/resume.js";
import { runSmokeMockExperiment } from "../../src/runner/run.js";
import { acquireWriterLock, migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getEvents,
  getSlot,
  listSlots,
} from "../../src/storage/repository.js";
import {
  LOOPBACK_API_KEY,
  buildLoopbackResponses,
  chatEnvelope,
  createLoopbackTransport,
  type CrashPoint,
} from "../helpers/runner-child.js";
import { createFakeOpenRouter } from "../helpers/fake-openrouter.js";
import { allowLocalFake, clearLocalFakes } from "../setup.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_IDS: Record<CrashPoint, string> = {
  none: "123e4567-e89b-42d3-a456-426614174080",
  before_dispatch: "123e4567-e89b-42d3-a456-426614174081",
  after_dispatch: "123e4567-e89b-42d3-a456-426614174082",
  after_response_saved: "123e4567-e89b-42d3-a456-426614174083",
  after_stage_commit: "123e4567-e89b-42d3-a456-426614174084",
  during_review: "123e4567-e89b-42d3-a456-426614174085",
};

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p36-"));
});

afterEach(() => {
  clearLocalFakes();
  rmSync(tempDirectory, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function crashChild(crashPoint: CrashPoint): Promise<{
  readonly db: Database.Database;
  readonly fake: Awaited<ReturnType<typeof createFakeOpenRouter>>;
  readonly runId: string;
  readonly accountId: string;
  readonly dbPath: string;
}> {
  const dbPath = join(tempDirectory, `${crashPoint}.sqlite`);
  const markerPath = join(tempDirectory, `${crashPoint}.marker`);
  const runId = RUN_IDS[crashPoint];
  const accountId = `p36-${crashPoint}`;
  const responses = buildLoopbackResponses(SMOKE_PLAN);
  const fake = await createFakeOpenRouter({
    respond: (request) => {
      const slot = request.headers["x-p36-slot"] ?? "";
      const role = request.headers["x-p36-role"] ?? "";
      const content = responses.get(`${slot}/${role}`);
      if (content === undefined) {
        return {
          status: 500,
          body: { error: { message: `no loopback response for ${slot}/${role}` } },
        };
      }
      return { status: 200, body: chatEnvelope(content) };
    },
  });
  allowLocalFake(fake.baseUrl);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/runner-child.ts"],
    {
      cwd: process.cwd(),
    env: {
      ...process.env,
      P36_DB: dbPath,
      P36_RUN_ID: runId,
      P36_ACCOUNT_ID: accountId,
      P36_FAKE_URL: fake.baseUrl,
      P36_CRASH_POINT: crashPoint,
      P36_MARKER: markerPath,
    },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(markerPath)) {
      if (child.exitCode !== null) {
        throw new Error(`child exited ${child.exitCode}: ${stderr}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${crashPoint}: ${stderr}`);
      }
      await sleep(10);
    }
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null) {
      await once(child, "exit");
    }
  }
  const db = openDatabase(dbPath);
  return { db, fake, runId, accountId, dbPath };
}

function findCall(
  db: Database.Database,
  runId: string,
  slotId: string,
  role: string,
) {
  const row = db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ? AND role = ?",
    )
    .get(runId, slotId, role) as { logical_call_id: string } | undefined;
  if (row === undefined) {
    throw new Error(`logical call not found: ${slotId}/${role}`);
  }
  return getLogicalCall(db, row.logical_call_id);
}

function requestCounts(
  fake: Awaited<ReturnType<typeof createFakeOpenRouter>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const request of fake.requests) {
    const key = `${request.headers["x-p36-slot"]}/${request.headers["x-p36-role"]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function assertCompletedResume(
  db: Database.Database,
  runId: string,
  result: Awaited<ReturnType<typeof resumeSmokeExperiment>>,
): Promise<void> {
  expect(result.status).toBe("completed");
  const slots = listSlots(db, runId);
  expect(slots).toHaveLength(20);
  expect(slots.every((slot) => slot.stage === "terminal")).toBe(true);
  expect(
    db
      .prepare(
        "SELECT slot_id, role, COUNT(*) AS count FROM logical_calls WHERE run_id = ? GROUP BY slot_id, role HAVING count > 1",
      )
      .all(runId),
  ).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT slot_id, stage, COUNT(*) AS count FROM stage_results WHERE run_id = ? GROUP BY slot_id, stage HAVING count > 1",
      )
      .all(runId),
  ).toEqual([]);
}

describe("crash-safe resume", () => {
  it(
    "resumes a prepared call that never dispatched",
    async () => {
      const { db, fake, runId, accountId } = await crashChild("before_dispatch");
      try {
        const call = findCall(db, runId, "text-ranking-01", "wording");
        expect(call.state).toBe("prepared");
        expect(listAttempts(db, call.logicalCallId)).toHaveLength(0);
        const transport = createLoopbackTransport({
          baseUrl: fake.baseUrl,
          db,
        });
        const result = await resumeSmokeExperiment({
          db,
          runId,
          apiKey: LOOPBACK_API_KEY,
          transport,
          concurrency: 1,
        });
        await assertCompletedResume(db, runId, result);
        expect(getSlot(db, runId, "text-ranking-01").verdict).toBe("approved");
        expect(listAttempts(db, call.logicalCallId)).toHaveLength(1);
        expect(requestCounts(fake).get("text-ranking-01/wording")).toBe(1);
        expect(fake.requests).toHaveLength(70);
        expect(getBudgetAccount(db, accountId).reservedUsd).toBe("0");
      } finally {
        db.close();
        await fake.close();
      }
    },
    60_000,
  );

  it(
    "marks a dispatching call uncertain without resending it",
    async () => {
      const { db, fake, runId, accountId } = await crashChild("after_dispatch");
      try {
        const call = findCall(db, runId, "text-ranking-01", "wording");
        expect(call.state).toBe("dispatching");
        const before = listAttempts(db, call.logicalCallId);
        expect(before).toHaveLength(1);
        expect(before[0]?.state).toBe("dispatching");
        const transport = createLoopbackTransport({
          baseUrl: fake.baseUrl,
          db,
        });
        const result = await resumeSmokeExperiment({
          db,
          runId,
          apiKey: LOOPBACK_API_KEY,
          transport,
          concurrency: 1,
        });
        await assertCompletedResume(db, runId, result);
        expect(getSlot(db, runId, "text-ranking-01").verdict).toBe(
          "generation_error",
        );
        const after = listAttempts(db, call.logicalCallId);
        expect(after).toHaveLength(1);
        expect(after[0]?.state).toBe("uncertain");
        const reservation = db
          .prepare(
            "SELECT state, amount_usd FROM budget_reservations WHERE attempt_id = ?",
          )
          .get(after[0]?.attemptId) as {
          state: string;
          amount_usd: string;
        };
        expect(["reserved", "unknown"]).toContain(reservation.state);
        expect(reservation.amount_usd).toBe("0.01");
        expect(requestCounts(fake).get("text-ranking-01/wording")).toBeUndefined();
        expect(fake.requests).toHaveLength(67);
        expect(getBudgetAccount(db, accountId).reservedUsd).toBe("0.01");
      } finally {
        db.close();
        await fake.close();
      }
    },
    60_000,
  );

  it(
    "reuses a response saved before validation without a new request",
    async () => {
      const { db, fake, runId } = await crashChild("after_response_saved");
      try {
        const call = findCall(db, runId, "text-ranking-01", "wording");
        expect(call.state).toBe("response_saved");
        const before = listAttempts(db, call.logicalCallId);
        expect(before).toHaveLength(1);
        expect(before[0]?.state).toBe("response_saved");
        expect(before[0]?.rawResponseArtifactId).not.toBeNull();
        const transport = createLoopbackTransport({
          baseUrl: fake.baseUrl,
          db,
        });
        const result = await resumeSmokeExperiment({
          db,
          runId,
          apiKey: LOOPBACK_API_KEY,
          transport,
          concurrency: 1,
        });
        await assertCompletedResume(db, runId, result);
        expect(getSlot(db, runId, "text-ranking-01").verdict).toBe("approved");
        expect(listAttempts(db, call.logicalCallId)[0]?.state).toBe("validated");
        expect(requestCounts(fake).get("text-ranking-01/wording")).toBe(1);
        expect(fake.requests).toHaveLength(70);
      } finally {
        db.close();
        await fake.close();
      }
    },
    60_000,
  );

  it(
    "resumes after a committed presentation checkpoint without duplicating work",
    async () => {
      const { db, fake, runId } = await crashChild("after_stage_commit");
      try {
        expect(getSlot(db, runId, "text-ranking-01").stage).toBe(
          "presentation_ready",
        );
        const call = findCall(db, runId, "text-ranking-01", "wording");
        const transport = createLoopbackTransport({
          baseUrl: fake.baseUrl,
          db,
        });
        const result = await resumeSmokeExperiment({
          db,
          runId,
          apiKey: LOOPBACK_API_KEY,
          transport,
          concurrency: 1,
        });
        await assertCompletedResume(db, runId, result);
        expect(getSlot(db, runId, "text-ranking-01").verdict).toBe("approved");
        expect(listAttempts(db, call.logicalCallId)).toHaveLength(1);
        expect(requestCounts(fake).get("text-ranking-01/wording")).toBe(1);
        expect(fake.requests).toHaveLength(70);
      } finally {
        db.close();
        await fake.close();
      }
    },
    60_000,
  );

  it(
    "reuses the persisted barrier and resumes reviews after a review-stage crash",
    async () => {
      const { db, fake, runId } = await crashChild("during_review");
      try {
        expect(
          getEvents(db, runId).some(
            (event) => event.eventType === "duplicate_barrier",
          ),
        ).toBe(true);
        expect(getSlot(db, runId, "text-ranking-01").stage).toBe("terminal");
        expect(getSlot(db, runId, "text-ranking-01").verdict).toBe("approved");
        const transport = createLoopbackTransport({
          baseUrl: fake.baseUrl,
          db,
        });
        const result = await resumeSmokeExperiment({
          db,
          runId,
          apiKey: LOOPBACK_API_KEY,
          transport,
          concurrency: 1,
        });
        await assertCompletedResume(db, runId, result);
        expect(getSlot(db, runId, "text-ranking-01").verdict).toBe("approved");
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage = 'duplicate_checked'",
            )
            .get(runId),
        ).toEqual({ count: 20 });
        expect(requestCounts(fake).get("text-ranking-01/wording")).toBe(1);
        expect(fake.requests).toHaveLength(70);
      } finally {
        db.close();
        await fake.close();
      }
    },
    60_000,
  );

  it("rejects a completed run", async () => {
    const dbPath = join(tempDirectory, "completed.sqlite");
    const db = openDatabase(dbPath);
    migrate(db);
    const runId = RUN_IDS.none;
    const accountId = "p36-completed";
    const mock = createMockTransport({
      db,
      clock: {
        now: () => new Date(),
        sleep: (ms: number) => sleep(ms),
      },
      random: () => 0,
    });
    try {
      await runSmokeMockExperiment({
        db,
        runId,
        accountId,
        apiKey: "p36-mock-key",
        transport: mock,
        maxCostUsd: "0",
      });
      await expect(
        resumeSmokeExperiment({
          db,
          runId,
          apiKey: "p36-mock-key",
          transport: mock,
        }),
      ).rejects.toMatchObject({ code: "ALREADY_COMPLETED" });
    } finally {
      db.close();
    }
  }, 60_000);

  it("rejects a manifest/protocol change", async () => {
    const dbPath = join(tempDirectory, "manifest.sqlite");
    const db = openDatabase(dbPath);
    migrate(db);
    const runId = RUN_IDS.none;
    try {
      createRun(db, {
        runId,
        plan: SMOKE_PLAN,
        evidenceKind: "mock",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      createBudgetAccount(db, {
        accountId: "p36-manifest",
        runId,
        runKind: "smoke",
        maxCostUsd: "10",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      db.prepare("UPDATE runs SET manifest_hash = ? WHERE run_id = ?").run(
        "b".repeat(64),
        runId,
      );
      const mock = createMockTransport({
        db,
        clock: { now: () => new Date(), sleep: (ms) => sleep(ms) },
        random: () => 0,
      });
      await expect(
        resumeSmokeExperiment({
          db,
          runId,
          apiKey: "p36-mock-key",
          transport: mock,
        }),
      ).rejects.toMatchObject({ code: "MANIFEST_MISMATCH" });
    } finally {
      db.close();
    }
  });

  it("rejects a mode mismatch", async () => {
    const dbPath = join(tempDirectory, "mode.sqlite");
    const db = openDatabase(dbPath);
    migrate(db);
    const runId = RUN_IDS.none;
    try {
      createRun(db, {
        runId,
        plan: SMOKE_PLAN,
        evidenceKind: "mock",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      createBudgetAccount(db, {
        accountId: "p36-mode",
        runId,
        runKind: "smoke",
        maxCostUsd: "10",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      const fake = await createFakeOpenRouter();
      allowLocalFake(fake.baseUrl);
      try {
        const transport = createLoopbackTransport({
          baseUrl: fake.baseUrl,
          db,
        });
        await expect(
          resumeSmokeExperiment({
            db,
            runId,
            apiKey: LOOPBACK_API_KEY,
            transport,
          }),
        ).rejects.toMatchObject({ code: "MODE_MISMATCH" });
      } finally {
        await fake.close();
      }
    } finally {
      db.close();
    }
  });

  it("rejects a stored request/model configuration change", async () => {
    const { db, fake, runId } = await crashChild("before_dispatch");
    try {
      const call = findCall(db, runId, "text-ranking-01", "wording");
      db.prepare("UPDATE logical_calls SET model = ? WHERE logical_call_id = ?").run(
        "changed/model",
        call.logicalCallId,
      );
      const transport = createLoopbackTransport({
        baseUrl: fake.baseUrl,
        db,
      });
      await expect(
        resumeSmokeExperiment({
          db,
          runId,
          apiKey: LOOPBACK_API_KEY,
          transport,
          concurrency: 1,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_MISMATCH" });
    } finally {
      db.close();
      await fake.close();
    }
  }, 60_000);

  it("reports a missing run and requires an authorized budget increase", async () => {
    const dbPath = join(tempDirectory, "budget.sqlite");
    const db = openDatabase(dbPath);
    migrate(db);
    const runId = RUN_IDS.none;
    const accountId = "p36-budget";
    const mock = createMockTransport({
      db,
      clock: { now: () => new Date(), sleep: (ms) => sleep(ms) },
      random: () => 0,
    });
    try {
      await expect(
        resumeSmokeExperiment({
          db,
          runId: "123e4567-e89b-42d3-a456-426614174099",
          apiKey: "p36-mock-key",
          transport: mock,
        }),
      ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
      createRun(db, {
        runId,
        plan: SMOKE_PLAN,
        evidenceKind: "mock",
        controlState: "paused_budget",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      createBudgetAccount(db, {
        accountId,
        runId,
        runKind: "smoke",
        maxCostUsd: "0.01",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      await expect(
        resumeSmokeExperiment({
          db,
          runId,
          apiKey: "p36-mock-key",
          transport: mock,
        }),
      ).rejects.toMatchObject({ code: "BUDGET_INCREASE_REQUIRED" });
      await expect(
        resumeSmokeExperiment({
          db,
          runId,
          apiKey: "p36-mock-key",
          transport: mock,
          budgetIncrease: {
            newMaxCostUsd: "0.02",
            operator: "test",
            acknowledged: false,
          },
        }),
      ).rejects.toMatchObject({ code: "BUDGET_INCREASE_UNAUTHORIZED" });
      const result = await resumeSmokeExperiment({
        db,
        runId,
        apiKey: "p36-mock-key",
        transport: mock,
        budgetIncrease: {
          newMaxCostUsd: "0.02",
          operator: "test",
          acknowledged: true,
        },
      });
      expect(result.status).toBe("completed");
      expect(getBudgetAccount(db, accountId).maxCostUsd).toBe("0.02");
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM budget_events WHERE account_id = ? AND event_type = 'cap_change'",
          )
          .get(accountId),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  it("reports an active writer instead of resuming", async () => {
    const dbPath = join(tempDirectory, "writer.sqlite");
    const db = openDatabase(dbPath);
    migrate(db);
    const runId = RUN_IDS.none;
    try {
      createRun(db, {
        runId,
        plan: SMOKE_PLAN,
        evidenceKind: "mock",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      createBudgetAccount(db, {
        accountId: "p36-writer",
        runId,
        runKind: "smoke",
        maxCostUsd: "10",
        createdAt: "2026-11-05T00:00:00.000Z",
      });
      const lock = await acquireWriterLock(dbPath);
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
            "--resume",
            runId,
            "--mock",
            "--db",
            dbPath,
          ]),
        ).resolves.toBe(1);
      } finally {
        stderrSpy.mockRestore();
        await lock.release();
      }
      expect(stderr.join("").toLowerCase()).toContain("lock");
    } finally {
      db.close();
    }
  }, 60_000);
});
