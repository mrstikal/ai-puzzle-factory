import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CandidateVerdictSchema,
  RunControlStateSchema,
  WORKFLOW_STAGES,
  WorkflowStageSchema,
  type CandidateVerdict,
  type WorkflowStage,
} from "../domain/candidate.js";
import {
  DifficultySchema,
  FamilySchema,
  LaneSchema,
  ModalitySchema,
  PlanManifestSchema,
  RunKindSchema,
  SLOT_ID_PATTERN,
  Sha256Schema,
} from "../domain/experiment.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import {
  ARTIFACT_LIMITS,
  ArtifactRecordSchema,
  artifactRowToRecord,
  storeArtifact,
  type ArtifactInput,
  type ArtifactRecord,
  type ArtifactRow,
} from "./artifacts.js";
import { StorageError, withTransaction } from "./database.js";

export const RunRecordSchema = z.strictObject({
  runId: z.uuid(),
  protocolVersion: z.string().min(1),
  runKind: RunKindSchema,
  rootSeed: z.string().min(1),
  evidenceKind: z.enum(["mock", "live"]),
  manifest: PlanManifestSchema,
  manifestHash: Sha256Schema,
  controlState: RunControlStateSchema,
  createdAt: z.iso.datetime(),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;

export const SlotRecordSchema = z.strictObject({
  runId: z.uuid(),
  slotId: z.string().regex(SLOT_ID_PATTERN),
  slotOrdinal: z.number().int().min(1).max(200),
  family: FamilySchema,
  modality: ModalitySchema,
  lane: LaneSchema,
  difficulty: DifficultySchema,
  stage: WorkflowStageSchema,
  verdict: CandidateVerdictSchema.nullable(),
  checkpointVersion: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type SlotRecord = z.infer<typeof SlotRecordSchema>;

export const StageResultRecordSchema = z.strictObject({
  runId: z.uuid(),
  slotId: z.string().regex(SLOT_ID_PATTERN),
  stage: WorkflowStageSchema,
  version: z.literal(1),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),
  payloadHash: Sha256Schema,
  artifacts: z.array(ArtifactRecordSchema),
  createdAt: z.iso.datetime(),
});

export type StageResultRecord = z.infer<typeof StageResultRecordSchema>;

export const EventRecordSchema = z.strictObject({
  eventId: z.number().int().positive(),
  runId: z.uuid(),
  slotId: z.string().regex(SLOT_ID_PATTERN).nullable(),
  eventType: z.string().min(1).max(64),
  stage: WorkflowStageSchema.nullable(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
});

export type EventRecord = z.infer<typeof EventRecordSchema>;

const CreateRunInputSchema = z.strictObject({
  runId: z.uuid(),
  plan: PlanManifestSchema,
  evidenceKind: z.enum(["mock", "live"]),
  controlState: RunControlStateSchema.optional(),
  createdAt: z.iso.datetime().optional(),
});

export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

const InsertStageResultScalarSchema = z.strictObject({
  runId: z.uuid(),
  slotId: z.string().regex(SLOT_ID_PATTERN),
  stage: WorkflowStageSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  verdict: CandidateVerdictSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export interface InsertStageResultInput {
  readonly runId: string;
  readonly slotId: string;
  readonly stage: WorkflowStage;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly elapsedMs?: number | null;
  readonly verdict?: CandidateVerdict;
  readonly payload: unknown;
  readonly artifacts?: readonly ArtifactInput[];
  readonly createdAt?: string;
}

interface RunRow {
  run_id: string;
  protocol_version: string;
  run_kind: string;
  root_seed: string;
  evidence_kind: string;
  manifest_json: string;
  manifest_hash: string;
  control_state: string;
  created_at: string;
}

interface SlotRow {
  run_id: string;
  slot_id: string;
  slot_ordinal: number;
  family: string;
  modality: string;
  lane: string;
  difficulty: number;
  stage: string;
  verdict: string | null;
  checkpoint_version: number;
  created_at: string;
  updated_at: string;
}

interface StageResultRow {
  run_id: string;
  slot_id: string;
  stage: string;
  version: number;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  payload_json: string;
  payload_hash: string;
  created_at: string;
}

interface EventRow {
  event_id: number;
  run_id: string;
  slot_id: string | null;
  event_type: string;
  stage: string | null;
  payload_json: string;
  created_at: string;
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StorageError("INVALID_STORED_DATA", `${context} is invalid`, {
      cause: result.error,
    });
  }
  return result.data;
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StorageError("INVALID_STORED_DATA", `${context} is not valid JSON`, {
      cause: error,
    });
  }
}

function assertUuid(value: string, field: string): void {
  if (!z.uuid().safeParse(value).success) {
    throw new StorageError("INVALID_INPUT", `${field} must be a UUID`);
  }
}

function constraintCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function rowToRun(row: RunRow): RunRecord {
  const manifest = parseStored(
    PlanManifestSchema,
    parseJson(row.manifest_json, "run manifest"),
    "run manifest",
  );
  if (
    manifest.planHash !== row.manifest_hash ||
    manifest.protocolVersion !== row.protocol_version ||
    manifest.runKind !== row.run_kind ||
    manifest.rootSeed !== row.root_seed
  ) {
    throw new StorageError(
      "INVALID_STORED_DATA",
      `run ${row.run_id} manifest does not match its stored columns`,
    );
  }
  return parseStored(
    RunRecordSchema,
    {
      runId: row.run_id,
      protocolVersion: row.protocol_version,
      runKind: row.run_kind,
      rootSeed: row.root_seed,
      evidenceKind: row.evidence_kind,
      manifest,
      manifestHash: row.manifest_hash,
      controlState: row.control_state,
      createdAt: row.created_at,
    },
    `run ${row.run_id}`,
  );
}

function rowToSlot(row: SlotRow): SlotRecord {
  return parseStored(
    SlotRecordSchema,
    {
      runId: row.run_id,
      slotId: row.slot_id,
      slotOrdinal: row.slot_ordinal,
      family: row.family,
      modality: row.modality,
      lane: row.lane,
      difficulty: row.difficulty,
      stage: row.stage,
      verdict: row.verdict,
      checkpointVersion: row.checkpoint_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `slot ${row.run_id}/${row.slot_id}`,
  );
}

function rowToStageResult(row: StageResultRow, artifacts: ArtifactRecord[]): StageResultRecord {
  const payload = parseJson(row.payload_json, "stage payload");
  if (sha256Hex(canonicalJson(payload)) !== row.payload_hash) {
    throw new StorageError(
      "INVALID_STORED_DATA",
      `stage result ${row.run_id}/${row.slot_id}/${row.stage} failed payload integrity check`,
    );
  }
  return parseStored(
    StageResultRecordSchema,
    {
      runId: row.run_id,
      slotId: row.slot_id,
      stage: row.stage,
      version: row.version,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedMs: row.elapsed_ms,
      payload,
      payloadHash: row.payload_hash,
      artifacts,
      createdAt: row.created_at,
    },
    `stage result ${row.run_id}/${row.slot_id}/${row.stage}`,
  );
}

function rowToEvent(row: EventRow): EventRecord {
  return parseStored(
    EventRecordSchema,
    {
      eventId: row.event_id,
      runId: row.run_id,
      slotId: row.slot_id,
      eventType: row.event_type,
      stage: row.stage,
      payload: parseJson(row.payload_json, "event payload"),
      createdAt: row.created_at,
    },
    `event ${row.event_id}`,
  );
}

function assertRunExists(db: Database.Database, runId: string): void {
  const row = db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
}

function getSlotRow(
  db: Database.Database,
  runId: string,
  slotId: string,
): SlotRow | undefined {
  return db
    .prepare(
      "SELECT run_id, slot_id, slot_ordinal, family, modality, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at FROM slots WHERE run_id = ? AND slot_id = ?",
    )
    .get(runId, slotId) as SlotRow | undefined;
}

function insertEvent(
  db: Database.Database,
  input: {
    runId: string;
    slotId: string | null;
    eventType: string;
    stage: WorkflowStage | null;
    payload: unknown;
    createdAt: string;
  },
): void {
  const payloadJson = canonicalJson(input.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > ARTIFACT_LIMITS.json) {
    throw new StorageError("ARTIFACT_TOO_LARGE", "event payload exceeds 2 MiB");
  }
  db.prepare(
    "INSERT INTO events (run_id, slot_id, event_type, stage, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    input.runId,
    input.slotId,
    input.eventType,
    input.stage,
    payloadJson,
    input.createdAt,
  );
}

function assertStageOrder(current: WorkflowStage, next: WorkflowStage): void {
  const currentIndex = WORKFLOW_STAGES.indexOf(current);
  const nextIndex = WORKFLOW_STAGES.indexOf(next);
  if (nextIndex < currentIndex) {
    throw new StorageError(
      "STAGE_ORDER",
      `cannot move slot from ${current} back to ${next}`,
    );
  }
}

function listArtifactsForStage(
  db: Database.Database,
  runId: string,
  slotId: string,
  stage: WorkflowStage,
): ArtifactRecord[] {
  const rows = db
    .prepare(
      "SELECT a.artifact_id, a.content_hash, a.kind, a.media_type, a.byte_length, a.bytes, a.created_at FROM artifacts a JOIN stage_artifacts sa ON sa.artifact_id = a.artifact_id WHERE sa.run_id = ? AND sa.slot_id = ? AND sa.stage = ? AND sa.version = 1 ORDER BY a.artifact_id",
    )
    .all(runId, slotId, stage) as ArtifactRow[];
  return rows.map(artifactRowToRecord);
}

export function createRun(db: Database.Database, input: CreateRunInput): RunRecord {
  const parsed = CreateRunInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new StorageError("INVALID_INPUT", "invalid run input", { cause: parsed.error });
  }
  const { runId, plan, evidenceKind } = parsed.data;
  const controlState = parsed.data.controlState ?? "running";
  const createdAt = parsed.data.createdAt ?? new Date().toISOString();

  const existing = db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
  if (existing !== undefined) {
    throw new StorageError("DUPLICATE_RUN", `run already exists: ${runId}`);
  }

  try {
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO runs (run_id, protocol_version, run_kind, root_seed, evidence_kind, manifest_json, manifest_hash, control_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        runId,
        plan.protocolVersion,
        plan.runKind,
        plan.rootSeed,
        evidenceKind,
        canonicalJson(plan),
        plan.planHash,
        controlState,
        createdAt,
      );
      const insertSlot = db.prepare(
        "INSERT INTO slots (run_id, slot_id, slot_ordinal, family, modality, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const slot of plan.slots) {
        insertSlot.run(
          runId,
          slot.slotId,
          slot.slotOrdinal,
          slot.family,
          slot.modality,
          slot.lane,
          slot.difficulty,
          "planned",
          null,
          0,
          createdAt,
          createdAt,
        );
      }
      insertEvent(db, {
        runId,
        slotId: null,
        eventType: "run_created",
        stage: null,
        payload: { planHash: plan.planHash, slotCount: plan.slots.length },
        createdAt,
      });
    });
  } catch (error) {
    const code = constraintCode(error);
    if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new StorageError("DUPLICATE_RUN", `run already exists: ${runId}`, {
        cause: error,
      });
    }
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new StorageError("CONSTRAINT_VIOLATION", `run constraint failed: ${runId}`, {
        cause: error,
      });
    }
    throw error;
  }

  return getRun(db, runId);
}

export function getRun(db: Database.Database, runId: string): RunRecord {
  assertUuid(runId, "runId");
  const row = db
    .prepare(
      "SELECT run_id, protocol_version, run_kind, root_seed, evidence_kind, manifest_json, manifest_hash, control_state, created_at FROM runs WHERE run_id = ?",
    )
    .get(runId) as RunRow | undefined;
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  return rowToRun(row);
}

export function listSlots(db: Database.Database, runId: string): SlotRecord[] {
  assertUuid(runId, "runId");
  assertRunExists(db, runId);
  const rows = db
    .prepare(
      "SELECT run_id, slot_id, slot_ordinal, family, modality, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at FROM slots WHERE run_id = ? ORDER BY slot_ordinal",
    )
    .all(runId) as SlotRow[];
  return rows.map(rowToSlot);
}

export function getSlot(
  db: Database.Database,
  runId: string,
  slotId: string,
): SlotRecord {
  assertUuid(runId, "runId");
  const row = getSlotRow(db, runId, slotId);
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `slot not found: ${runId}/${slotId}`);
  }
  return rowToSlot(row);
}

export function insertStageResult(
  db: Database.Database,
  input: InsertStageResultInput,
): StageResultRecord {
  const scalar = InsertStageResultScalarSchema.safeParse({
    runId: input.runId,
    slotId: input.slotId,
    stage: input.stage,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    elapsedMs: input.elapsedMs ?? null,
    verdict: input.verdict ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  if (!scalar.success) {
    throw new StorageError("INVALID_INPUT", "invalid stage result input", {
      cause: scalar.error,
    });
  }
  const { runId, slotId, stage, startedAt, finishedAt, elapsedMs, verdict, createdAt } =
    scalar.data;

  if ((finishedAt === null) !== (elapsedMs === null)) {
    throw new StorageError(
      "INVALID_INPUT",
      "finishedAt and elapsedMs must both be present or both be null",
    );
  }
  if (stage === "terminal" && verdict === null) {
    throw new StorageError("INVALID_INPUT", "a terminal stage requires a verdict");
  }
  if (stage !== "terminal" && verdict !== null) {
    throw new StorageError("INVALID_INPUT", "a non-terminal stage cannot carry a verdict");
  }

  let payloadJson: string;
  try {
    payloadJson = canonicalJson(input.payload);
  } catch (error) {
    throw new StorageError("INVALID_INPUT", "stage payload is not JSON-serializable", {
      cause: error,
    });
  }
  if (Buffer.byteLength(payloadJson, "utf8") > ARTIFACT_LIMITS.json) {
    throw new StorageError("ARTIFACT_TOO_LARGE", "stage payload exceeds 2 MiB");
  }
  const payloadHash = sha256Hex(payloadJson);
  const artifacts = input.artifacts ?? [];

  try {
    withTransaction(db, () => {
      const slot = getSlotRow(db, runId, slotId);
      if (slot === undefined) {
        throw new StorageError("NOT_FOUND", `slot not found: ${runId}/${slotId}`);
      }
      const currentStage = parseStored(
        WorkflowStageSchema,
        slot.stage,
        `slot ${runId}/${slotId} stage`,
      );
      assertStageOrder(currentStage, stage);

      const duplicate = db
        .prepare(
          "SELECT 1 FROM stage_results WHERE run_id = ? AND slot_id = ? AND stage = ? AND version = 1",
        )
        .get(runId, slotId, stage);
      if (duplicate !== undefined) {
        throw new StorageError(
          "DUPLICATE_STAGE",
          `stage already exists: ${runId}/${slotId}/${stage}`,
        );
      }

      db.prepare(
        "INSERT INTO stage_results (run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        runId,
        slotId,
        stage,
        1,
        startedAt,
        finishedAt,
        elapsedMs,
        payloadJson,
        payloadHash,
        createdAt,
      );

      const artifactHashes: string[] = [];
      for (const artifact of artifacts) {
        const record = storeArtifact(db, artifact, createdAt);
        artifactHashes.push(record.contentHash);
        db.prepare(
          "INSERT INTO stage_artifacts (run_id, slot_id, stage, version, artifact_id, role) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(runId, slotId, stage, 1, record.artifactId, artifact.role);
      }

      db.prepare(
        "UPDATE slots SET stage = ?, verdict = ?, checkpoint_version = checkpoint_version + 1, updated_at = ? WHERE run_id = ? AND slot_id = ?",
      ).run(stage, verdict, createdAt, runId, slotId);

      insertEvent(db, {
        runId,
        slotId,
        eventType: "stage_committed",
        stage,
        payload: { stage, payloadHash, artifactHashes, verdict },
        createdAt,
      });
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    const code = constraintCode(error);
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `stage result constraint failed: ${runId}/${slotId}/${stage}`,
        { cause: error },
      );
    }
    throw error;
  }

  return getStageResult(db, runId, slotId, stage);
}

export function getStageResult(
  db: Database.Database,
  runId: string,
  slotId: string,
  stage: WorkflowStage,
): StageResultRecord {
  assertUuid(runId, "runId");
  const row = db
    .prepare(
      "SELECT run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at FROM stage_results WHERE run_id = ? AND slot_id = ? AND stage = ? AND version = 1",
    )
    .get(runId, slotId, stage) as StageResultRow | undefined;
  if (row === undefined) {
    throw new StorageError(
      "NOT_FOUND",
      `stage result not found: ${runId}/${slotId}/${stage}`,
    );
  }
  return rowToStageResult(row, listArtifactsForStage(db, runId, slotId, stage));
}

export function listStageResults(
  db: Database.Database,
  runId: string,
  slotId?: string,
): StageResultRecord[] {
  assertUuid(runId, "runId");
  assertRunExists(db, runId);
  const rows =
    slotId === undefined
      ? (db
          .prepare(
            "SELECT run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at FROM stage_results WHERE run_id = ? ORDER BY slot_id, stage",
          )
          .all(runId) as StageResultRow[])
      : (db
          .prepare(
            "SELECT run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at FROM stage_results WHERE run_id = ? AND slot_id = ? ORDER BY stage",
          )
          .all(runId, slotId) as StageResultRow[]);
  return rows.map((row) => {
    const stage = parseStored(
      WorkflowStageSchema,
      row.stage,
      `stage result ${row.run_id}/${row.slot_id} stage`,
    );
    return rowToStageResult(
      row,
      listArtifactsForStage(db, row.run_id, row.slot_id, stage),
    );
  });
}

export function getEvents(db: Database.Database, runId: string): EventRecord[] {
  assertUuid(runId, "runId");
  assertRunExists(db, runId);
  const rows = db
    .prepare(
      "SELECT event_id, run_id, slot_id, event_type, stage, payload_json, created_at FROM events WHERE run_id = ? ORDER BY event_id",
    )
    .all(runId) as EventRow[];
  return rows.map(rowToEvent);
}
