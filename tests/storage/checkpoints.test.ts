import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import {
  ARTIFACT_LIMITS,
  getArtifact,
  hashArtifactBytes,
  resolveExportPath,
  type ArtifactInput,
} from "../../src/storage/artifacts.js";
import {
  StorageError,
  acquireWriterLock,
  migrate,
  openDatabase,
} from "../../src/storage/database.js";
import {
  createRun,
  getEvents,
  getRun,
  getSlot,
  getStageResult,
  insertStageResult,
  listSlots,
  listStageResults,
} from "../../src/storage/repository.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-11-03T22:00:00.000Z";
const STARTED_AT = "2026-11-03T22:01:00.000Z";
const FINISHED_AT = "2026-11-03T22:01:05.000Z";
const PLAN = buildPlanManifest({ runKind: "smoke" });

let tempDirectory: string;
let databasePath: string;
let db: Database.Database;

function jsonArtifact(bytes: Buffer, role = "payload"): ArtifactInput {
  return { kind: "json", mediaType: "application/json", bytes, role };
}

function createSmokeRun(): void {
  createRun(db, {
    runId: RUN_ID,
    plan: PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function expectStorageError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe(code);
    return;
  }
  throw new Error(`expected StorageError ${code}`);
}

async function expectStorageErrorAsync(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe(code);
    return;
  }
  throw new Error(`expected StorageError ${code}`);
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-storage-"));
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

describe("run and slot persistence", () => {
  it("creates a run atomically and reopens it with unchanged manifest and slots", () => {
    createSmokeRun();
    const created = getRun(db, RUN_ID);
    const createdSlots = listSlots(db, RUN_ID);
    expect(created.manifest).toEqual(PLAN);
    expect(created.manifestHash).toBe(PLAN.planHash);
    expect(createdSlots).toHaveLength(20);
    expect(createdSlots.every((slot) => slot.stage === "planned")).toBe(true);
    expect(createdSlots.every((slot) => slot.checkpointVersion === 0)).toBe(true);

    db.close();
    db = openDatabase(databasePath);
    migrate(db);

    expect(getRun(db, RUN_ID)).toEqual(created);
    expect(listSlots(db, RUN_ID)).toEqual(createdSlots);
    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("is idempotent across repeated migrations", () => {
    migrate(db);
    migrate(db);
    expect(countRows("schema_migrations")).toBe(5);
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string }>;
    expect(versions.map((row) => row.version)).toEqual([
      "0001_runs.sql",
      "0002_requests.sql",
      "0003_human_labels.sql",
      "0003_retry_not_before.sql",
      "0004_protocol_freezes.sql",
    ]);
    expect(countRows("runs")).toBe(0);
  });

  it("rejects duplicate runs and invalid run IDs", () => {
    createSmokeRun();
    expectStorageError(() => createSmokeRun(), "DUPLICATE_RUN");
    expectStorageError(
      () =>
        createRun(db, {
          runId: "not-a-uuid",
          plan: PLAN,
          evidenceKind: "mock",
        }),
      "INVALID_INPUT",
    );
    expectStorageError(
      () => getRun(db, "123e4567-e89b-42d3-a456-426614174999"),
      "NOT_FOUND",
    );
  });

  it("validates stored manifests on read", () => {
    createSmokeRun();
    db.prepare("UPDATE runs SET manifest_json = ? WHERE run_id = ?").run("{}", RUN_ID);
    expectStorageError(() => getRun(db, RUN_ID), "INVALID_STORED_DATA");
    expectStorageError(
      () => listSlots(db, "123e4567-e89b-42d3-a456-426614174999"),
      "NOT_FOUND",
    );
  });
});

describe("stage results and checkpoints", () => {
  it("inserts immutable stage results and advances the slot checkpoint", () => {
    createSmokeRun();
    const artifactBytes = Buffer.from('{"step":1}', "utf8");
    const stage = insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: { step: 1 },
      artifacts: [jsonArtifact(artifactBytes)],
      createdAt: FINISHED_AT,
    });

    expect(stage.payload).toEqual({ step: 1 });
    expect(stage.artifacts).toHaveLength(1);
    expect(stage.artifacts[0]?.contentHash).toBe(hashArtifactBytes(artifactBytes));
    expect(getSlot(db, RUN_ID, "text-ranking-01")).toMatchObject({
      stage: "spec_ready",
      checkpointVersion: 1,
      verdict: null,
    });

    expectStorageError(
      () =>
        insertStageResult(db, {
          runId: RUN_ID,
          slotId: "text-ranking-01",
          stage: "spec_ready",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          elapsedMs: 5_000,
          payload: { step: 2 },
        }),
      "DUPLICATE_STAGE",
    );

    expectStorageError(
      () =>
        insertStageResult(db, {
          runId: RUN_ID,
          slotId: "text-ranking-01",
          stage: "planned",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          elapsedMs: 5_000,
          payload: {},
        }),
      "STAGE_ORDER",
    );

    expect(getStageResult(db, RUN_ID, "text-ranking-01", "spec_ready").payload).toEqual({
      step: 1,
    });
    expect(listStageResults(db, RUN_ID, "text-ranking-01")).toHaveLength(1);
  });

  it("persists a terminal verdict and rejects invalid verdict placement", () => {
    createSmokeRun();
    expectStorageError(
      () =>
        insertStageResult(db, {
          runId: RUN_ID,
          slotId: "text-ranking-01",
          stage: "spec_ready",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          elapsedMs: 5_000,
          verdict: "approved",
          payload: {},
        }),
      "INVALID_INPUT",
    );

    expectStorageError(
      () =>
        insertStageResult(db, {
          runId: RUN_ID,
          slotId: "text-ranking-01",
          stage: "terminal",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          elapsedMs: 5_000,
          payload: {},
        }),
      "INVALID_INPUT",
    );

    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "terminal",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      verdict: "approved",
      payload: { reason: "all checks passed" },
    });
    expect(getSlot(db, RUN_ID, "text-ranking-01")).toMatchObject({
      stage: "terminal",
      verdict: "approved",
      checkpointVersion: 1,
    });
  });

  it("detects tampered stage payloads on read", () => {
    createSmokeRun();
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: { step: 1 },
    });
    db.exec("DROP TRIGGER stage_results_immutable_update");
    db.prepare(
      "UPDATE stage_results SET payload_json = ? WHERE run_id = ? AND slot_id = ? AND stage = ?",
    ).run('{"step":2}', RUN_ID, "text-ranking-01", "spec_ready");
    expectStorageError(
      () => getStageResult(db, RUN_ID, "text-ranking-01", "spec_ready"),
      "INVALID_STORED_DATA",
    );
  });

  it("rejects updates and deletes of stage results", () => {
    createSmokeRun();
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: {},
    });
    expect(() =>
      db.prepare("UPDATE stage_results SET payload_json = '{}' WHERE run_id = ?").run(RUN_ID),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare("DELETE FROM stage_results WHERE run_id = ?").run(RUN_ID),
    ).toThrow(/immutable/);
  });

  it("rolls back the stage, artifact, and checkpoint on an injected failure", () => {
    createSmokeRun();
    db.exec(
      "CREATE TRIGGER fail_stage_event BEFORE INSERT ON events WHEN NEW.event_type = 'stage_committed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );

    expect(() =>
      insertStageResult(db, {
        runId: RUN_ID,
        slotId: "text-ranking-01",
        stage: "spec_ready",
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        elapsedMs: 5_000,
        payload: { step: 1 },
        artifacts: [jsonArtifact(Buffer.from('{"step":1}', "utf8"))],
      }),
    ).toThrow();

    expect(countRows("stage_results")).toBe(0);
    expect(countRows("artifacts")).toBe(0);
    expect(countRows("stage_artifacts")).toBe(0);
    expect(getSlot(db, RUN_ID, "text-ranking-01")).toMatchObject({
      stage: "planned",
      checkpointVersion: 0,
    });
    expect(countRows("events")).toBe(1);

    db.exec("DROP TRIGGER fail_stage_event");
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: { step: 1 },
      artifacts: [jsonArtifact(Buffer.from('{"step":1}', "utf8"))],
    });
    expect(countRows("stage_results")).toBe(1);
    expect(countRows("artifacts")).toBe(1);
    expect(getSlot(db, RUN_ID, "text-ranking-01").checkpointVersion).toBe(1);
  });

  it("records run and stage events", () => {
    createSmokeRun();
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: { step: 1 },
    });
    const events = getEvents(db, RUN_ID);
    expect(events.map((event) => event.eventType)).toEqual([
      "run_created",
      "stage_committed",
    ]);
    expect(events[1]?.stage).toBe("spec_ready");
  });
});

describe("artifacts", () => {
  it("deduplicates content-addressed artifacts and enforces size bounds", () => {
    createSmokeRun();
    const bytes = Buffer.from('{"shared":true}', "utf8");
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: {},
      artifacts: [jsonArtifact(bytes, "first")],
    });
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "formal_checked",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: {},
      artifacts: [jsonArtifact(bytes, "second")],
    });
    expect(countRows("artifacts")).toBe(1);
    expect(countRows("stage_artifacts")).toBe(2);
    expect(getArtifact(db, hashArtifactBytes(bytes), "json").bytes.equals(bytes)).toBe(true);

    expectStorageError(
      () =>
        insertStageResult(db, {
          runId: RUN_ID,
          slotId: "text-ranking-02",
          stage: "spec_ready",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          elapsedMs: 5_000,
          payload: {},
          artifacts: [
            {
              kind: "svg",
              mediaType: "image/svg+xml",
              bytes: Buffer.alloc(ARTIFACT_LIMITS.svg + 1),
              role: "source",
            },
          ],
        }),
      "ARTIFACT_TOO_LARGE",
    );
    expect(countRows("stage_results")).toBe(2);
  });

  it("detects tampered artifact bytes on read", () => {
    createSmokeRun();
    const bytes = Buffer.from('{"ok":true}', "utf8");
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: "text-ranking-01",
      stage: "spec_ready",
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      elapsedMs: 5_000,
      payload: {},
      artifacts: [jsonArtifact(bytes)],
    });
    db.prepare("UPDATE artifacts SET bytes = ? WHERE content_hash = ?").run(
      Buffer.from('{"ok":null}', "utf8"),
      hashArtifactBytes(bytes),
    );
    expectStorageError(
      () => getArtifact(db, hashArtifactBytes(bytes), "json"),
      "INVALID_STORED_DATA",
    );
  });
});

describe("export path safety", () => {
  it("accepts controlled paths beneath the run directory", () => {
    expect(resolveExportPath(tempDirectory, RUN_ID, "puzzles/text-ranking-01.json")).toBe(
      join(tempDirectory, "runs", RUN_ID, "puzzles", "text-ranking-01.json"),
    );
  });

  it("rejects traversal, absolute, drive, backslash, and empty paths", () => {
    const unsafe = [
      "",
      "../escape",
      "/absolute",
      "a/../../b",
      "C:\\windows",
      "a\\b",
      "a//b",
      "a/./b",
      ".",
    ];
    for (const path of unsafe) {
      expectStorageError(
        () => resolveExportPath(tempDirectory, RUN_ID, path),
        "UNSAFE_PATH",
      );
    }
    expectStorageError(
      () => resolveExportPath(tempDirectory, "not-a-uuid", "safe.json"),
      "UNSAFE_PATH",
    );
  });

  it("rejects symbolic links inside the run directory", () => {
    const runDirectory = join(tempDirectory, "runs", RUN_ID);
    mkdirSync(runDirectory, { recursive: true });
    const outside = join(tempDirectory, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(runDirectory, "evil.json"));
    expectStorageError(
      () => resolveExportPath(tempDirectory, RUN_ID, "evil.json"),
      "UNSAFE_PATH",
    );
  });

  it("rejects dangling symlinks and a symlinked runs parent", () => {
    const runDirectory = join(tempDirectory, "runs", RUN_ID);
    mkdirSync(runDirectory, { recursive: true });
    symlinkSync(join(tempDirectory, "missing-target"), join(runDirectory, "dangling.json"));
    expectStorageError(
      () => resolveExportPath(tempDirectory, RUN_ID, "dangling.json"),
      "UNSAFE_PATH",
    );

    const otherRoot = join(tempDirectory, "other-root");
    const realRuns = join(otherRoot, "real-runs");
    mkdirSync(realRuns, { recursive: true });
    symlinkSync(realRuns, join(otherRoot, "runs"));
    expectStorageError(
      () => resolveExportPath(otherRoot, RUN_ID, "safe.json"),
      "UNSAFE_PATH",
    );
  });
});

describe("writer exclusion", () => {
  it("detects a competing writer and allows a new lock after release", async () => {
    const first = await acquireWriterLock(databasePath);
    try {
      await expectStorageErrorAsync(acquireWriterLock(databasePath), "WRITER_LOCKED");
    } finally {
      await first.release();
    }
    const second = await acquireWriterLock(databasePath);
    await second.release();
  });
});

describe("storage errors", () => {
  it("exposes typed storage errors", () => {
    const error = new StorageError("NOT_FOUND", "missing");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NOT_FOUND");
  });
});
