import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import {
  DesignerRunRecordSchema,
  DesignerSlotRecordSchema,
} from "../../src/domain/design.js";
import {
  DesignAttemptRecordSchema,
} from "../../src/design/attempts.js";
import { diagnoseDesignSpec } from "../../src/design/diagnostics.js";
import {
  StorageError,
  migrate,
  openDatabase,
} from "../../src/storage/database.js";
import {
  createDesignerRun,
  getDesignerEvents,
  getDesignerRun,
  getDesignerSlot,
  getDesignerStageResult,
  getRun,
  getRunRecord,
  getStageResult,
  insertDesignAttempt,
  insertDesignerStageResult,
  listDesignAttempts,
  listDesignerSlots,
  listSlots,
} from "../../src/storage/repository.js";
import {
  createAttempt,
  createLogicalCall,
  getAttempt,
  getLogicalCall,
  LedgerRoleSchema,
} from "../../src/ai/ledger.js";
import {
  createBudgetAccount,
  getBudgetAccount,
} from "../../src/ai/budget.js";
import { MockScenarioSchema } from "../../src/ai/mock.js";
import { canonicalJson, sha256Hex } from "../../src/util/hash.js";
import { hashArtifactBytes } from "../../src/storage/artifacts.js";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../src/storage/migrations/", import.meta.url),
);
const LEGACY_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const DESIGNER_RUN_ID = "223e4567-e89b-42d3-a456-426614174000";
const PILOT_RUN_ID = "323e4567-e89b-42d3-a456-426614174000";
const MOCK_RUN_ID = "423e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-11-07T00:00:00.000Z";
const LEGACY_PLAN = buildPlanManifest({ runKind: "smoke" });
const LEGACY_BODY = { model: "mock/generator", messages: [] };
const LEGACY_BODY_JSON = canonicalJson(LEGACY_BODY);
const LEGACY_BODY_HASH = sha256Hex(LEGACY_BODY_JSON);
const LEGACY_STAGE_PAYLOAD = { step: 1 };
const LEGACY_STAGE_JSON = canonicalJson(LEGACY_STAGE_PAYLOAD);
const LEGACY_STAGE_HASH = sha256Hex(LEGACY_STAGE_JSON);

let tempDirectory: string;
let databasePath: string;
let db: Database.Database;

function applyLegacyMigrations(): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const file of [
    "0001_runs.sql",
    "0002_requests.sql",
    "0003_human_labels.sql",
    "0003_retry_not_before.sql",
    "0004_protocol_freezes.sql",
    "0005_balanced_routing.sql",
  ]) {
    db.exec(readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8"));
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(file, CREATED_AT);
  }
}

function populateLegacyDatabase(): void {
  db.prepare(
    "INSERT INTO runs (run_id, protocol_version, run_kind, root_seed, evidence_kind, manifest_json, manifest_hash, control_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    LEGACY_RUN_ID,
    LEGACY_PLAN.protocolVersion,
    LEGACY_PLAN.runKind,
    LEGACY_PLAN.rootSeed,
    "mock",
    canonicalJson(LEGACY_PLAN),
    LEGACY_PLAN.planHash,
    "running",
    CREATED_AT,
  );
  const insertSlot = db.prepare(
    "INSERT INTO slots (run_id, slot_id, slot_ordinal, family, modality, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', NULL, 0, ?, ?)",
  );
  for (const slot of LEGACY_PLAN.slots) {
    insertSlot.run(
      LEGACY_RUN_ID,
      slot.slotId,
      slot.slotOrdinal,
      slot.family,
      slot.modality,
      slot.lane,
      slot.difficulty,
      CREATED_AT,
      CREATED_AT,
    );
  }
  db.prepare(
    "INSERT INTO stage_results (run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at) VALUES (?, ?, 'spec_ready', 1, ?, ?, 1000, ?, ?, ?)",
  ).run(
    LEGACY_RUN_ID,
    "text-ranking-01",
    CREATED_AT,
    "2026-11-07T00:00:01.000Z",
    LEGACY_STAGE_JSON,
    LEGACY_STAGE_HASH,
    "2026-11-07T00:00:01.000Z",
  );
  db.prepare(
    "UPDATE slots SET stage = 'spec_ready', checkpoint_version = 1, updated_at = ? WHERE run_id = ? AND slot_id = ?",
  ).run("2026-11-07T00:00:01.000Z", LEGACY_RUN_ID, "text-ranking-01");
  const artifactBytes = Buffer.from('{"artifact":1}', "utf8");
  db.prepare(
    "INSERT INTO artifacts (content_hash, kind, media_type, byte_length, bytes, created_at) VALUES (?, 'json', 'application/json', ?, ?, ?)",
  ).run(
    hashArtifactBytes(artifactBytes),
    artifactBytes.length,
    artifactBytes,
    CREATED_AT,
  );
  db.prepare(
    "INSERT INTO stage_artifacts (run_id, slot_id, stage, version, artifact_id, role) VALUES (?, ?, 'spec_ready', 1, 1, 'payload')",
  ).run(LEGACY_RUN_ID, "text-ranking-01");
  db.prepare(
    "INSERT INTO logical_calls (logical_call_id, run_id, slot_id, probe_key, role, run_kind, pool, state, request_hash, request_body_json, expected_schema_hash, model, provider, output_cap_field, created_at, updated_at, retry_not_before, routing_policy) VALUES (?, ?, ?, NULL, 'spec', 'smoke', 'smoke', 'prepared', ?, ?, ?, 'mock/generator', 'balanced', 'max_tokens', ?, ?, NULL, 'balanced')",
  ).run(
    "523e4567-e89b-42d3-a456-426614174000",
    LEGACY_RUN_ID,
    "text-ranking-01",
    LEGACY_BODY_HASH,
    LEGACY_BODY_JSON,
    "a".repeat(64),
    CREATED_AT,
    CREATED_AT,
  );
  db.prepare(
    "INSERT INTO request_attempts (attempt_id, logical_call_id, attempt_number, state, request_hash, request_body_json, expected_schema_hash, role, model, provider, cost_status, partial_completion, created_at, updated_at, routing_policy) VALUES (?, ?, 1, 'prepared', ?, ?, ?, 'spec', 'mock/generator', 'balanced', 'unknown', 0, ?, ?, 'balanced')",
  ).run(
    "623e4567-e89b-42d3-a456-426614174000",
    "523e4567-e89b-42d3-a456-426614174000",
    LEGACY_BODY_HASH,
    LEGACY_BODY_JSON,
    "a".repeat(64),
    CREATED_AT,
    CREATED_AT,
  );
  db.prepare(
    "INSERT INTO budget_accounts (account_id, run_id, run_kind, pool, max_cost_usd, known_actual_usd, reserved_usd, unknown_exposure_usd, created_at, updated_at) VALUES ('legacy-smoke-budget', ?, 'smoke', 'smoke', '10', '0', '0.01', '0', ?, ?)",
  ).run(LEGACY_RUN_ID, CREATED_AT, CREATED_AT);
  db.prepare(
    "INSERT INTO budget_reservations (reservation_id, account_id, logical_call_id, attempt_id, kind, state, amount_usd, actual_cost_usd, created_at, updated_at) VALUES ('823e4567-e89b-42d3-a456-426614174000', 'legacy-smoke-budget', ?, ?, 'attempt', 'reserved', '0.01', NULL, ?, ?)",
  ).run(
    "523e4567-e89b-42d3-a456-426614174000",
    "623e4567-e89b-42d3-a456-426614174000",
    CREATED_AT,
    CREATED_AT,
  );
  db.prepare(
    "INSERT INTO budget_events (account_id, logical_call_id, attempt_id, event_type, amount_usd, payload_json, created_at) VALUES ('legacy-smoke-budget', ?, ?, 'reservation_created', '0.01', '{}', ?)",
  ).run(
    "523e4567-e89b-42d3-a456-426614174000",
    "623e4567-e89b-42d3-a456-426614174000",
    CREATED_AT,
  );
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

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-designer-migration-"));
  databasePath = join(tempDirectory, "experiment.sqlite");
  db = openDatabase(databasePath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // A test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("P47 designer migration", () => {
  it("preserves populated legacy rows, hashes, and foreign keys", () => {
    applyLegacyMigrations();
    populateLegacyDatabase();
    migrate(db);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string }>;
    expect(versions.map((row) => row.version)).toContain(
      "0006_design_attempts.sql",
    );

    const run = getRun(db, LEGACY_RUN_ID);
    expect(run.manifest).toEqual(LEGACY_PLAN);
    expect(run.manifestHash).toBe(LEGACY_PLAN.planHash);
    expect(listSlots(db, LEGACY_RUN_ID)).toHaveLength(20);
    const stage = getStageResult(
      db,
      LEGACY_RUN_ID,
      "text-ranking-01",
      "spec_ready",
    );
    expect(stage.payload).toEqual(LEGACY_STAGE_PAYLOAD);
    expect(stage.payloadHash).toBe(LEGACY_STAGE_HASH);
    expect(stage.artifacts).toHaveLength(1);
    expect(stage.artifacts[0]?.contentHash).toBe(
      hashArtifactBytes(Buffer.from('{"artifact":1}', "utf8")),
    );
    const call = getLogicalCall(
      db,
      "523e4567-e89b-42d3-a456-426614174000",
    );
    expect(call.requestHash).toBe(LEGACY_BODY_HASH);
    expect(call.pool).toBe("smoke");
    const attempt = getAttempt(
      db,
      "623e4567-e89b-42d3-a456-426614174000",
    );
    expect(attempt.state).toBe("prepared");
    expect(attempt.requestHash).toBe(LEGACY_BODY_HASH);
    const budget = getBudgetAccount(db, "legacy-smoke-budget");
    expect(budget.maxCostUsd).toBe("10");
    expect(budget.reservedUsd).toBe("0.01");
    expect(budget.pool).toBe("smoke");
    expect(
      db
        .prepare(
          "SELECT amount_usd, state FROM budget_reservations WHERE reservation_id = ?",
        )
        .get("823e4567-e89b-42d3-a456-426614174000"),
    ).toEqual({ amount_usd: "0.01", state: "reserved" });
    expect(
      db
        .prepare(
          "SELECT event_type, amount_usd FROM budget_events WHERE account_id = 'legacy-smoke-budget'",
        )
        .get(),
    ).toEqual({ event_type: "reservation_created", amount_usd: "0.01" });

    migrate(db);
    expect(getRun(db, LEGACY_RUN_ID).manifestHash).toBe(LEGACY_PLAN.planHash);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 9 });
  });

  it("round-trips a 300-slot designer run, stage checkpoints, and attempts", () => {
    migrate(db);
    const plan = buildDesignerPlanManifest({ runKind: "design_primary" });
    const run = createDesignerRun(db, {
      runId: DESIGNER_RUN_ID,
      plan,
      evidenceKind: "mock",
      createdAt: CREATED_AT,
    });
    expect(DesignerRunRecordSchema.safeParse(run).success).toBe(true);
    expect(getRunRecord(db, DESIGNER_RUN_ID)).toEqual(run);
    expect(getDesignerRun(db, DESIGNER_RUN_ID).manifestHash).toBe(plan.planHash);
    expectStorageError(() => getRun(db, DESIGNER_RUN_ID), "INVALID_INPUT");
    expectStorageError(() => listSlots(db, DESIGNER_RUN_ID), "INVALID_INPUT");
    const slots = listDesignerSlots(db, DESIGNER_RUN_ID);
    expect(slots).toHaveLength(300);
    expect(DesignerSlotRecordSchema.safeParse(slots[0]).success).toBe(true);
    expect(slots[0]).toMatchObject({
      slotId: "design-text-ranking-01-baseline",
      arm: "baseline",
      lane: null,
      stage: "planned",
    });

    const slotId = "design-text-ranking-01-ai_one_shot";
    insertDesignerStageResult(db, {
      runId: DESIGNER_RUN_ID,
      slotId,
      stage: "design_proposed",
      startedAt: CREATED_AT,
      finishedAt: "2026-11-07T00:00:01.000Z",
      elapsedMs: 1_000,
      payload: { proposalHash: "b".repeat(64) },
      createdAt: "2026-11-07T00:00:01.000Z",
    });
    expect(getDesignerSlot(db, DESIGNER_RUN_ID, slotId)).toMatchObject({
      stage: "design_proposed",
      checkpointVersion: 1,
    });
    expect(
      getDesignerStageResult(
        db,
        DESIGNER_RUN_ID,
        slotId,
        "design_proposed",
      ).payload,
    ).toEqual({ proposalHash: "b".repeat(64) });
    expect(getDesignerEvents(db, DESIGNER_RUN_ID)).toHaveLength(2);

    const baseline = insertDesignAttempt(db, {
      runId: DESIGNER_RUN_ID,
      slotId: "design-text-ranking-01-baseline",
      attemptIndex: 0,
      role: "baseline",
      arm: "baseline",
      diagnostic: null,
      verdict: "accepted",
      costStatus: "none",
      costUsd: "0",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      elapsedMs: 0,
      createdAt: CREATED_AT,
      proposalArtifact: {
        kind: "json",
        mediaType: "application/json",
        bytes: Buffer.from("{}"),
        role: "proposal",
      },
    });
    expect(baseline).toMatchObject({
      role: "baseline",
      logicalCallId: null,
      costStatus: "none",
      costUsd: "0",
    });
    expect(() =>
      db
        .prepare("DELETE FROM slots WHERE run_id = ? AND slot_id = ?")
        .run(DESIGNER_RUN_ID, "design-text-ranking-01-baseline"),
    ).toThrow();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM design_attempts WHERE run_id = ? AND slot_id = ?",
        )
        .get(DESIGNER_RUN_ID, "design-text-ranking-01-baseline"),
    ).toEqual({ count: 1 });

    const call = createLogicalCall(db, {
      runId: DESIGNER_RUN_ID,
      slotId,
      role: "design",
      runKind: "design_primary",
      requestBody: LEGACY_BODY,
      expectedSchemaHash: "a".repeat(64),
      model: "mock/designer",
      outputCapField: "max_tokens",
      createdAt: CREATED_AT,
    });
    const requestAttempt = createAttempt(db, {
      logicalCallId: call.logicalCallId,
      createdAt: CREATED_AT,
    });
    expect(requestAttempt.role).toBe("design");
    const diagnostic = diagnoseDesignSpec("ranking", 1, {
      size: 4,
      clues: [
        { kind: "before", before: 0, after: 1 },
        { kind: "before", before: 1, after: 2 },
        { kind: "before", before: 0, after: 2 },
      ],
    });
    const attempt = insertDesignAttempt(db, {
      runId: DESIGNER_RUN_ID,
      slotId,
      attemptIndex: 0,
      role: "design",
      arm: "ai_one_shot",
      logicalCallId: call.logicalCallId,
      diagnostic,
      verdict: "rejected",
      costStatus: "known",
      costUsd: "0.01",
      startedAt: CREATED_AT,
      finishedAt: "2026-11-07T00:00:01.000Z",
      elapsedMs: 1_000,
      createdAt: "2026-11-07T00:00:01.000Z",
      artifacts: [
        {
          kind: "raw_response",
          mediaType: "application/json",
          bytes: Buffer.from("{}"),
          role: "raw_response",
        },
      ],
    });
    expect(DesignAttemptRecordSchema.safeParse(attempt).success).toBe(true);
    expect(listDesignAttempts(db, DESIGNER_RUN_ID, slotId)).toHaveLength(1);
    expectStorageError(
      () =>
        insertDesignAttempt(db, {
          runId: DESIGNER_RUN_ID,
          slotId,
          attemptIndex: 0,
          role: "design",
          arm: "ai_feedback",
          logicalCallId: call.logicalCallId,
          diagnostic,
          verdict: "rejected",
          costStatus: "known",
          costUsd: "0.01",
          startedAt: CREATED_AT,
          finishedAt: "2026-11-07T00:00:01.000Z",
          elapsedMs: 1_000,
          createdAt: "2026-11-07T00:00:01.000Z",
        }),
      "INVALID_INPUT",
    );
    expect(() =>
      db
        .prepare(
          "UPDATE design_attempts SET verdict = 'accepted' WHERE run_id = ? AND slot_id = ? AND attempt_index = 0",
        )
        .run(DESIGNER_RUN_ID, slotId),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "DELETE FROM design_attempts WHERE run_id = ? AND slot_id = ? AND attempt_index = 0",
        )
        .run(DESIGNER_RUN_ID, slotId),
    ).toThrow();
  });

  it("rejects a third repair and keeps baseline cost at zero", () => {
    migrate(db);
    const plan = buildDesignerPlanManifest({ runKind: "design_primary" });
    createDesignerRun(db, {
      runId: DESIGNER_RUN_ID,
      plan,
      evidenceKind: "mock",
      createdAt: CREATED_AT,
    });
    const slotId = "design-text-ranking-01-ai_feedback";
    const diagnostic = diagnoseDesignSpec("ranking", 1, {
      size: 4,
      clues: [
        { kind: "before", before: 0, after: 1 },
        { kind: "before", before: 1, after: 2 },
        { kind: "before", before: 0, after: 2 },
      ],
    });
    const roles = ["design", "design_repair_1", "design_repair_2"] as const;
    for (const [index, role] of roles.entries()) {
      const call = createLogicalCall(db, {
        runId: DESIGNER_RUN_ID,
        slotId,
        role,
        runKind: "design_primary",
        requestBody: LEGACY_BODY,
        expectedSchemaHash: "a".repeat(64),
        model: "mock/designer",
        outputCapField: "max_tokens",
        createdAt: CREATED_AT,
      });
      insertDesignAttempt(db, {
        runId: DESIGNER_RUN_ID,
        slotId,
        attemptIndex: index,
        role,
        arm: "ai_feedback",
        logicalCallId: call.logicalCallId,
        diagnostic,
        verdict: "rejected",
        costStatus: "known",
        costUsd: "0.01",
        startedAt: CREATED_AT,
        finishedAt: "2026-11-07T00:00:01.000Z",
        elapsedMs: 1_000,
        createdAt: "2026-11-07T00:00:01.000Z",
        artifacts: [
          {
            kind: "raw_response",
            mediaType: "application/json",
            bytes: Buffer.from("{}"),
            role: "raw_response",
          },
        ],
      });
    }
    expectStorageError(
      () =>
        insertDesignAttempt(db, {
          runId: DESIGNER_RUN_ID,
          slotId,
          attemptIndex: 3,
          role: "design_repair_2",
          arm: "ai_feedback",
          logicalCallId: "723e4567-e89b-42d3-a456-426614174000",
          diagnostic,
          verdict: "rejected",
          costStatus: "known",
          costUsd: "0.01",
          startedAt: CREATED_AT,
          finishedAt: "2026-11-07T00:00:01.000Z",
          elapsedMs: 1_000,
          createdAt: "2026-11-07T00:00:01.000Z",
        }),
      "INVALID_INPUT",
    );
  });

  it("round-trips pilot content calls, pilot probes, and designer budget pools", () => {
    migrate(db);
    const primary = buildDesignerPlanManifest({ runKind: "design_primary" });
    const pilot = buildDesignerPlanManifest({ runKind: "design_pilot" });
    const mock = buildDesignerPlanManifest({ runKind: "design_mock" });
    createDesignerRun(db, {
      runId: DESIGNER_RUN_ID,
      plan: primary,
      evidenceKind: "mock",
      createdAt: CREATED_AT,
    });
    createDesignerRun(db, {
      runId: PILOT_RUN_ID,
      plan: pilot,
      evidenceKind: "mock",
      createdAt: CREATED_AT,
    });
    createDesignerRun(db, {
      runId: MOCK_RUN_ID,
      plan: mock,
      evidenceKind: "mock",
      createdAt: CREATED_AT,
    });
    expect(listDesignerSlots(db, PILOT_RUN_ID)).toHaveLength(60);

    const pilotContent = createLogicalCall(db, {
      runId: PILOT_RUN_ID,
      slotId: "design-text-ranking-01-ai_one_shot",
      role: "design",
      runKind: "design_pilot",
      requestBody: LEGACY_BODY,
      expectedSchemaHash: "a".repeat(64),
      model: "mock/designer",
      outputCapField: "max_tokens",
      createdAt: CREATED_AT,
    });
    expect(pilotContent.pool).toBe("pilot");
    const pilotProbe = createLogicalCall(db, {
      runId: PILOT_RUN_ID,
      slotId: null,
      probeKey: "design_text_probe",
      role: "preflight",
      runKind: "design_pilot",
      requestBody: LEGACY_BODY,
      expectedSchemaHash: "a".repeat(64),
      model: "mock/designer",
      outputCapField: "max_tokens",
      createdAt: CREATED_AT,
    });
    expect(pilotProbe.pool).toBe("preflight");
    expect(pilotProbe.slotId).toBeNull();

    expect(
      createBudgetAccount(db, {
        runId: DESIGNER_RUN_ID,
        runKind: "design_primary",
        pool: "primary",
        maxCostUsd: "10",
        createdAt: CREATED_AT,
      }).pool,
    ).toBe("primary");
    expect(
      createBudgetAccount(db, {
        runId: PILOT_RUN_ID,
        runKind: "design_pilot",
        pool: "pilot",
        maxCostUsd: "10",
        createdAt: CREATED_AT,
      }).pool,
    ).toBe("pilot");
    expect(
      createBudgetAccount(db, {
        runId: PILOT_RUN_ID,
        runKind: "design_pilot",
        pool: "preflight",
        maxCostUsd: "1",
        createdAt: CREATED_AT,
      }).pool,
    ).toBe("preflight");
    expect(
      createBudgetAccount(db, {
        runId: MOCK_RUN_ID,
        runKind: "design_mock",
        pool: "mock",
        maxCostUsd: "0",
        createdAt: CREATED_AT,
      }).pool,
    ).toBe("mock");
  });

  it("keeps legacy role and mock parsers explicit about designer roles", () => {
    expect(LedgerRoleSchema.safeParse("design").success).toBe(true);
    expect(LedgerRoleSchema.safeParse("design_repair_1").success).toBe(true);
    expect(
      MockScenarioSchema.safeParse({
        role: "design",
        family: "ranking",
        difficulty: 1,
        seed: "a".repeat(64),
        kind: "valid",
      }).success,
    ).toBe(false);
  });
});
