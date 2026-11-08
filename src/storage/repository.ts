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
import {
  DESIGNER_CANDIDATE_SLOT_ID_PATTERN,
  DESIGNER_WORKFLOW_STAGES,
  DesignerCandidateVerdictSchema,
  DesignerPlanManifestSchema,
  DesignerRunRecordSchema,
  DesignerSlotRecordSchema,
  DesignerWorkflowStageSchema,
  type DesignerRunRecord,
  type DesignerSlotRecord,
  type DesignerWorkflowStage,
  type DesignerCandidateVerdict,
  type DesignerArm,
} from "../domain/design.js";
import {
  DesignAttemptIdentitySchema,
  DesignAttemptRecordSchema,
  DesignerAttemptArtifactRoleSchema,
  diagnosticForRepair,
  type DesignAttemptRecord,
  type DesignerAttemptRole,
  type DesignerAttemptCostStatus,
} from "../design/attempts.js";
import {
  DesignDiagnosticSchema,
  type DesignDiagnostic,
} from "../design/diagnostics.js";
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

const CreateDesignerRunInputSchema = z.strictObject({
  runId: z.uuid(),
  plan: DesignerPlanManifestSchema,
  evidenceKind: z.enum(["mock", "live"]),
  controlState: RunControlStateSchema.optional(),
  createdAt: z.iso.datetime().optional(),
});

export type CreateDesignerRunInput = z.infer<
  typeof CreateDesignerRunInputSchema
>;

export const DesignerStageResultRecordSchema = z.strictObject({
  runId: z.uuid(),
  slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  stage: DesignerWorkflowStageSchema,
  version: z.literal(1),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),
  payloadHash: Sha256Schema,
  artifacts: z.array(ArtifactRecordSchema),
  createdAt: z.iso.datetime(),
});

export type DesignerStageResultRecord = z.infer<
  typeof DesignerStageResultRecordSchema
>;

export const DesignerEventRecordSchema = z.strictObject({
  eventId: z.number().int().positive(),
  runId: z.uuid(),
  slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN).nullable(),
  eventType: z.string().min(1).max(64),
  stage: DesignerWorkflowStageSchema.nullable(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
});

export type DesignerEventRecord = z.infer<typeof DesignerEventRecordSchema>;

export interface InsertDesignerStageResultInput {
  readonly runId: string;
  readonly slotId: string;
  readonly stage: DesignerWorkflowStage;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly elapsedMs?: number | null;
  readonly verdict?: DesignerCandidateVerdict;
  readonly payload: unknown;
  readonly artifacts?: readonly ArtifactInput[];
  readonly createdAt?: string;
}

export interface InsertDesignAttemptInput {
  readonly runId: string;
  readonly slotId: string;
  readonly attemptIndex: number;
  readonly role: DesignerAttemptRole;
  readonly arm: DesignerArm;
  readonly logicalCallId?: string | null;
  readonly proposalArtifact?: ArtifactInput | null;
  readonly diagnostic: DesignDiagnostic | null;
  readonly verdict: DesignerCandidateVerdict;
  readonly costStatus: DesignerAttemptCostStatus;
  readonly costUsd?: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly artifacts?: readonly ArtifactInput[];
  readonly createdAt?: string;
}

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
  slot_kind: string;
  assignment_id: string | null;
  arm: string | null;
  lane: string | null;
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

interface DesignAttemptRow {
  run_id: string;
  slot_id: string;
  attempt_index: number;
  role: string;
  arm: string;
  logical_call_id: string | null;
  proposal_artifact_id: number | null;
  diagnostic_json: string | null;
  verdict: string;
  cost_status: string;
  cost_usd: string | null;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  created_at: string;
}

interface DesignerAttemptArtifactRow extends ArtifactRow {
  artifact_role: string;
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

function rowToDesignerRun(row: RunRow): DesignerRunRecord {
  const manifest = parseStored(
    DesignerPlanManifestSchema,
    parseJson(row.manifest_json, "designer run manifest"),
    "designer run manifest",
  );
  return parseStored(
    DesignerRunRecordSchema,
    {
      kind: "designer",
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
    `designer run ${row.run_id}`,
  );
}

function rowToDesignerSlot(row: SlotRow): DesignerSlotRecord {
  return parseStored(
    DesignerSlotRecordSchema,
    {
      kind: "designer",
      runId: row.run_id,
      slotId: row.slot_id,
      slotOrdinal: row.slot_ordinal,
      family: row.family,
      modality: row.modality,
      slotKind: row.slot_kind,
      assignmentId: row.assignment_id,
      arm: row.arm,
      lane: row.lane,
      difficulty: row.difficulty,
      stage: row.stage,
      verdict: row.verdict,
      checkpointVersion: row.checkpoint_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `designer slot ${row.run_id}/${row.slot_id}`,
  );
}

function rowToDesignerStageResult(
  row: StageResultRow,
  artifacts: ArtifactRecord[],
): DesignerStageResultRecord {
  const payload = parseJson(row.payload_json, "designer stage payload");
  if (sha256Hex(canonicalJson(payload)) !== row.payload_hash) {
    throw new StorageError(
      "INVALID_STORED_DATA",
      `designer stage result ${row.run_id}/${row.slot_id}/${row.stage} failed payload integrity check`,
    );
  }
  return parseStored(
    DesignerStageResultRecordSchema,
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
    `designer stage result ${row.run_id}/${row.slot_id}/${row.stage}`,
  );
}

function rowToDesignerEvent(row: EventRow): DesignerEventRecord {
  return parseStored(
    DesignerEventRecordSchema,
    {
      eventId: row.event_id,
      runId: row.run_id,
      slotId: row.slot_id,
      eventType: row.event_type,
      stage: row.stage,
      payload: parseJson(row.payload_json, "designer event payload"),
      createdAt: row.created_at,
    },
    `designer event ${row.event_id}`,
  );
}

function listArtifactsForDesignAttempt(
  db: Database.Database,
  runId: string,
  slotId: string,
  attemptIndex: number,
): DesignerAttemptArtifactRow[] {
  return db
    .prepare(
      "SELECT a.artifact_id, a.content_hash, a.kind, a.media_type, a.byte_length, a.bytes, a.created_at, daa.role AS artifact_role FROM artifacts a JOIN design_attempt_artifacts daa ON daa.artifact_id = a.artifact_id WHERE daa.run_id = ? AND daa.slot_id = ? AND daa.attempt_index = ? ORDER BY a.artifact_id, daa.role",
    )
    .all(runId, slotId, attemptIndex) as DesignerAttemptArtifactRow[];
}

function rowToDesignAttempt(
  db: Database.Database,
  row: DesignAttemptRow,
): DesignAttemptRecord {
  const diagnostic =
    row.diagnostic_json === null
      ? null
      : parseStored(
          DesignDiagnosticSchema,
          parseJson(row.diagnostic_json, "design attempt diagnostic"),
          `design attempt ${row.run_id}/${row.slot_id}/${row.attempt_index} diagnostic`,
        );
  const artifacts = listArtifactsForDesignAttempt(
    db,
    row.run_id,
    row.slot_id,
    row.attempt_index,
  ).map((artifactRow) => ({
    artifact: artifactRowToRecord(artifactRow),
    role: artifactRow.artifact_role,
  }));
  return parseStored(
    DesignAttemptRecordSchema,
    {
      kind: "design_attempt",
      runId: row.run_id,
      slotId: row.slot_id,
      attemptIndex: row.attempt_index,
      role: row.role,
      arm: row.arm,
      logicalCallId: row.logical_call_id,
      proposalArtifactId: row.proposal_artifact_id,
      diagnostic,
      verdict: row.verdict,
      costStatus: row.cost_status,
      costUsd: row.cost_usd,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedMs: row.elapsed_ms,
      createdAt: row.created_at,
      artifacts,
    },
    `design attempt ${row.run_id}/${row.slot_id}/${row.attempt_index}`,
  );
}

function getSlotRow(
  db: Database.Database,
  runId: string,
  slotId: string,
): SlotRow | undefined {
  return db
    .prepare(
      "SELECT run_id, slot_id, slot_ordinal, family, modality, slot_kind, assignment_id, arm, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at FROM slots WHERE run_id = ? AND slot_id = ?",
    )
    .get(runId, slotId) as SlotRow | undefined;
}

export function insertEvent(
  db: Database.Database,
  input: {
    runId: string;
    slotId: string | null;
    eventType: string;
    stage: WorkflowStage | DesignerWorkflowStage | null;
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
  stage: WorkflowStage | DesignerWorkflowStage,
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

export function createDesignerRun(
  db: Database.Database,
  input: CreateDesignerRunInput,
): DesignerRunRecord {
  const parsed = CreateDesignerRunInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new StorageError("INVALID_INPUT", "invalid designer run input", {
      cause: parsed.error,
    });
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
        "INSERT INTO slots (run_id, slot_id, slot_ordinal, family, modality, slot_kind, assignment_id, arm, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'designer', ?, ?, NULL, ?, 'planned', NULL, 0, ?, ?)",
      );
      for (const candidate of plan.candidates) {
        insertSlot.run(
          runId,
          candidate.candidateSlotId,
          candidate.candidateOrdinal,
          candidate.family,
          candidate.modality,
          candidate.assignmentId,
          candidate.arm,
          candidate.difficulty,
          createdAt,
          createdAt,
        );
      }
      insertEvent(db, {
        runId,
        slotId: null,
        eventType: "run_created",
        stage: null,
        payload: {
          planHash: plan.planHash,
          slotCount: plan.candidates.length,
          runKind: plan.runKind,
        },
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
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `designer run constraint failed: ${runId}`,
        { cause: error },
      );
    }
    throw error;
  }

  return getDesignerRun(db, runId);
}

function getRunRow(
  db: Database.Database,
  runId: string,
): RunRow | undefined {
  return db
    .prepare(
      "SELECT run_id, protocol_version, run_kind, root_seed, evidence_kind, manifest_json, manifest_hash, control_state, created_at FROM runs WHERE run_id = ?",
    )
    .get(runId) as RunRow | undefined;
}

function requireDesignerRun(
  db: Database.Database,
  runId: string,
): RunRow {
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (!run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is not a designer run`,
    );
  }
  return run;
}

export function getRunRecord(
  db: Database.Database,
  runId: string,
): RunRecord | DesignerRunRecord {
  assertUuid(runId, "runId");
  const row = getRunRow(db, runId);
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  return row.run_kind.startsWith("design_")
    ? rowToDesignerRun(row)
    : rowToRun(row);
}

export function getDesignerRun(
  db: Database.Database,
  runId: string,
): DesignerRunRecord {
  assertUuid(runId, "runId");
  const row = getRunRow(db, runId);
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (!row.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is not a designer run`,
    );
  }
  return rowToDesignerRun(row);
}

export function getRun(db: Database.Database, runId: string): RunRecord {
  assertUuid(runId, "runId");
  const row = getRunRow(db, runId);
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (row.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is a designer run; use getDesignerRun`,
    );
  }
  return rowToRun(row);
}

export function setRunControlState(
  db: Database.Database,
  runId: string,
  controlState: z.infer<typeof RunControlStateSchema>,
): void {
  assertUuid(runId, "runId");
  const parsed = RunControlStateSchema.parse(controlState);
  const result = db
    .prepare("UPDATE runs SET control_state = ? WHERE run_id = ?")
    .run(parsed, runId);
  if (result.changes === 0) {
    throw new StorageError("NOT_FOUND", `run ${runId} does not exist`);
  }
}

export function listSlots(db: Database.Database, runId: string): SlotRecord[] {
  assertUuid(runId, "runId");
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is a designer run; use listDesignerSlots`,
    );
  }
  const rows = db
    .prepare(
      "SELECT run_id, slot_id, slot_ordinal, family, modality, slot_kind, assignment_id, arm, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at FROM slots WHERE run_id = ? ORDER BY slot_ordinal",
    )
    .all(runId) as SlotRow[];
  return rows.map(rowToSlot);
}

export function listDesignerSlots(
  db: Database.Database,
  runId: string,
): DesignerSlotRecord[] {
  assertUuid(runId, "runId");
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (!run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is not a designer run`,
    );
  }
  const rows = db
    .prepare(
      "SELECT run_id, slot_id, slot_ordinal, family, modality, slot_kind, assignment_id, arm, lane, difficulty, stage, verdict, checkpoint_version, created_at, updated_at FROM slots WHERE run_id = ? ORDER BY slot_ordinal",
    )
    .all(runId) as SlotRow[];
  return rows.map(rowToDesignerSlot);
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
  if (row.slot_kind === "designer") {
    throw new StorageError(
      "INVALID_INPUT",
      `slot ${runId}/${slotId} is a designer slot; use getDesignerSlot`,
    );
  }
  return rowToSlot(row);
}

export function getDesignerSlot(
  db: Database.Database,
  runId: string,
  slotId: string,
): DesignerSlotRecord {
  assertUuid(runId, "runId");
  requireDesignerRun(db, runId);
  const row = getSlotRow(db, runId, slotId);
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `slot not found: ${runId}/${slotId}`);
  }
  if (row.slot_kind !== "designer") {
    throw new StorageError(
      "INVALID_INPUT",
      `slot ${runId}/${slotId} is not a designer slot`,
    );
  }
  return rowToDesignerSlot(row);
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
    createdAt: input.createdAt ?? input.finishedAt ?? new Date().toISOString(),
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
      if (slot.slot_kind === "designer") {
        throw new StorageError(
          "INVALID_INPUT",
          `slot ${runId}/${slotId} is a designer slot; use insertDesignerStageResult`,
        );
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
  const slot = getSlotRow(db, runId, slotId);
  if (slot !== undefined && slot.slot_kind === "designer") {
    throw new StorageError(
      "INVALID_INPUT",
      `slot ${runId}/${slotId} is a designer slot; use getDesignerStageResult`,
    );
  }
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
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is a designer run; use listDesignerStageResults`,
    );
  }
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

function assertDesignerStageOrder(
  current: DesignerWorkflowStage,
  next: DesignerWorkflowStage,
): void {
  const currentIndex = DESIGNER_WORKFLOW_STAGES.indexOf(current);
  const nextIndex = DESIGNER_WORKFLOW_STAGES.indexOf(next);
  if (nextIndex < currentIndex) {
    throw new StorageError(
      "STAGE_ORDER",
      `cannot move designer slot from ${current} back to ${next}`,
    );
  }
}

export function insertDesignerStageResult(
  db: Database.Database,
  input: InsertDesignerStageResultInput,
): DesignerStageResultRecord {
  assertUuid(input.runId, "runId");
  if (!z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN).safeParse(input.slotId).success) {
    throw new StorageError("INVALID_INPUT", "invalid designer slot ID");
  }
  const stage = DesignerWorkflowStageSchema.safeParse(input.stage);
  if (!stage.success) {
    throw new StorageError("INVALID_INPUT", "invalid designer stage", {
      cause: stage.error,
    });
  }
  const verdict =
    input.verdict === undefined
      ? null
      : DesignerCandidateVerdictSchema.safeParse(input.verdict);
  if (verdict !== null && !verdict.success) {
    throw new StorageError("INVALID_INPUT", "invalid designer verdict", {
      cause: verdict.error,
    });
  }
  const parsedVerdict = verdict === null ? null : verdict.data;
  const finishedAt = input.finishedAt ?? null;
  const elapsedMs = input.elapsedMs ?? null;
  if ((finishedAt === null) !== (elapsedMs === null)) {
    throw new StorageError(
      "INVALID_INPUT",
      "finishedAt and elapsedMs must both be present or both be null",
    );
  }
  if (stage.data === "terminal" && parsedVerdict === null) {
    throw new StorageError("INVALID_INPUT", "a terminal stage requires a verdict");
  }
  if (stage.data !== "terminal" && parsedVerdict !== null) {
    throw new StorageError(
      "INVALID_INPUT",
      "a non-terminal designer stage cannot carry a verdict",
    );
  }
  if (!z.iso.datetime().safeParse(input.startedAt).success) {
    throw new StorageError("INVALID_INPUT", "startedAt must be an ISO timestamp");
  }
  if (finishedAt !== null && !z.iso.datetime().safeParse(finishedAt).success) {
    throw new StorageError("INVALID_INPUT", "finishedAt must be an ISO timestamp");
  }
  const createdAt = input.createdAt ?? finishedAt ?? new Date().toISOString();
  if (!z.iso.datetime().safeParse(createdAt).success) {
    throw new StorageError("INVALID_INPUT", "createdAt must be an ISO timestamp");
  }

  let payloadJson: string;
  try {
    payloadJson = canonicalJson(input.payload);
  } catch (error) {
    throw new StorageError(
      "INVALID_INPUT",
      "designer stage payload is not JSON-serializable",
      { cause: error },
    );
  }
  if (Buffer.byteLength(payloadJson, "utf8") > ARTIFACT_LIMITS.json) {
    throw new StorageError("ARTIFACT_TOO_LARGE", "designer stage payload exceeds 2 MiB");
  }
  const payloadHash = sha256Hex(payloadJson);
  const artifacts = input.artifacts ?? [];

  try {
    withTransaction(db, () => {
      const slot = getSlotRow(db, input.runId, input.slotId);
      if (slot === undefined) {
        throw new StorageError(
          "NOT_FOUND",
          `slot not found: ${input.runId}/${input.slotId}`,
        );
      }
      if (slot.slot_kind !== "designer") {
        throw new StorageError(
          "INVALID_INPUT",
          `slot ${input.runId}/${input.slotId} is not a designer slot`,
        );
      }
      requireDesignerRun(db, input.runId);
      const currentStage = parseStored(
        DesignerWorkflowStageSchema,
        slot.stage,
        `designer slot ${input.runId}/${input.slotId} stage`,
      );
      assertDesignerStageOrder(currentStage, stage.data);

      const duplicate = db
        .prepare(
          "SELECT 1 FROM stage_results WHERE run_id = ? AND slot_id = ? AND stage = ? AND version = 1",
        )
        .get(input.runId, input.slotId, stage.data);
      if (duplicate !== undefined) {
        throw new StorageError(
          "DUPLICATE_STAGE",
          `stage already exists: ${input.runId}/${input.slotId}/${stage.data}`,
        );
      }

      db.prepare(
        "INSERT INTO stage_results (run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.runId,
        input.slotId,
        stage.data,
        input.startedAt,
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
          "INSERT INTO stage_artifacts (run_id, slot_id, stage, version, artifact_id, role) VALUES (?, ?, ?, 1, ?, ?)",
        ).run(input.runId, input.slotId, stage.data, record.artifactId, artifact.role);
      }

      db.prepare(
        "UPDATE slots SET stage = ?, verdict = ?, checkpoint_version = checkpoint_version + 1, updated_at = ? WHERE run_id = ? AND slot_id = ?",
      ).run(stage.data, parsedVerdict, createdAt, input.runId, input.slotId);

      insertEvent(db, {
        runId: input.runId,
        slotId: input.slotId,
        eventType: "stage_committed",
        stage: stage.data,
        payload: {
          stage: stage.data,
          payloadHash,
          artifactHashes,
          verdict: parsedVerdict,
        },
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
        `designer stage result constraint failed: ${input.runId}/${input.slotId}/${stage.data}`,
        { cause: error },
      );
    }
    throw error;
  }

  return getDesignerStageResult(db, input.runId, input.slotId, stage.data);
}

export function getDesignerStageResult(
  db: Database.Database,
  runId: string,
  slotId: string,
  stage: DesignerWorkflowStage,
): DesignerStageResultRecord {
  assertUuid(runId, "runId");
  const parsedStage = DesignerWorkflowStageSchema.parse(stage);
  const row = db
    .prepare(
      "SELECT run_id, slot_id, stage, version, started_at, finished_at, elapsed_ms, payload_json, payload_hash, created_at FROM stage_results WHERE run_id = ? AND slot_id = ? AND stage = ? AND version = 1",
    )
    .get(runId, slotId, parsedStage) as StageResultRow | undefined;
  if (row === undefined) {
    throw new StorageError(
      "NOT_FOUND",
      `designer stage result not found: ${runId}/${slotId}/${parsedStage}`,
    );
  }
  return rowToDesignerStageResult(
    row,
    listArtifactsForStage(db, runId, slotId, parsedStage),
  );
}

export function listDesignerStageResults(
  db: Database.Database,
  runId: string,
  slotId?: string,
): DesignerStageResultRecord[] {
  assertUuid(runId, "runId");
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (!run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is not a designer run`,
    );
  }
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
      DesignerWorkflowStageSchema,
      row.stage,
      `designer stage result ${row.run_id}/${row.slot_id} stage`,
    );
    return rowToDesignerStageResult(
      row,
      listArtifactsForStage(db, row.run_id, row.slot_id, stage),
    );
  });
}

export function getDesignerEvents(
  db: Database.Database,
  runId: string,
): DesignerEventRecord[] {
  assertUuid(runId, "runId");
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (!run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is not a designer run`,
    );
  }
  const rows = db
    .prepare(
      "SELECT event_id, run_id, slot_id, event_type, stage, payload_json, created_at FROM events WHERE run_id = ? ORDER BY event_id",
    )
    .all(runId) as EventRow[];
  return rows.map(rowToDesignerEvent);
}

export function insertDesignAttempt(
  db: Database.Database,
  input: InsertDesignAttemptInput,
): DesignAttemptRecord {
  assertUuid(input.runId, "runId");
  if (
    !z
      .string()
      .regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN)
      .safeParse(input.slotId).success
  ) {
    throw new StorageError("INVALID_INPUT", "invalid designer slot ID");
  }
  const identity = DesignAttemptIdentitySchema.safeParse({
    attemptIndex: input.attemptIndex,
    role: input.role,
    arm: input.arm,
    logicalCallId: input.logicalCallId ?? null,
    costStatus: input.costStatus,
    costUsd: input.costUsd ?? null,
  });
  if (!identity.success) {
    throw new StorageError("INVALID_INPUT", "invalid design attempt identity", {
      cause: identity.error,
    });
  }
  if (!z.iso.datetime().safeParse(input.startedAt).success) {
    throw new StorageError("INVALID_INPUT", "startedAt must be an ISO timestamp");
  }
  if (!z.iso.datetime().safeParse(input.finishedAt).success) {
    throw new StorageError("INVALID_INPUT", "finishedAt must be an ISO timestamp");
  }
  if (!Number.isInteger(input.elapsedMs) || input.elapsedMs < 0) {
    throw new StorageError("INVALID_INPUT", "elapsedMs must be nonnegative");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!z.iso.datetime().safeParse(createdAt).success) {
    throw new StorageError("INVALID_INPUT", "createdAt must be an ISO timestamp");
  }

  const diagnostic =
    input.diagnostic === null
      ? null
      : parseStored(
          DesignDiagnosticSchema,
          input.diagnostic,
          "design attempt diagnostic",
        );
  const diagnosticJson =
    diagnostic === null ? null : canonicalJson(diagnostic);
  if (
    diagnosticJson !== null &&
    Buffer.byteLength(diagnosticJson, "utf8") > ARTIFACT_LIMITS.json
  ) {
    throw new StorageError(
      "ARTIFACT_TOO_LARGE",
      "design attempt diagnostic exceeds 2 MiB",
    );
  }

  const extraArtifacts = input.artifacts ?? [];
  for (const artifact of extraArtifacts) {
    const role = DesignerAttemptArtifactRoleSchema.safeParse(artifact.role);
    if (!role.success) {
      throw new StorageError(
        "INVALID_INPUT",
        `invalid design attempt artifact role: ${artifact.role}`,
      );
    }
  }
  if (
    input.proposalArtifact !== null &&
    input.proposalArtifact !== undefined &&
    input.proposalArtifact.role !== "proposal"
  ) {
    throw new StorageError(
      "INVALID_INPUT",
      "proposalArtifact must use the proposal artifact role",
    );
  }

  try {
    withTransaction(db, () => {
      const slot = getSlotRow(db, input.runId, input.slotId);
      if (slot === undefined) {
        throw new StorageError(
          "NOT_FOUND",
          `slot not found: ${input.runId}/${input.slotId}`,
        );
      }
      if (slot.slot_kind !== "designer") {
        throw new StorageError(
          "INVALID_INPUT",
          `slot ${input.runId}/${input.slotId} is not a designer slot`,
        );
      }
      if (slot.arm !== input.arm) {
        throw new StorageError(
          "INVALID_INPUT",
          `attempt arm ${input.arm} does not match slot arm ${String(slot.arm)}`,
        );
      }
      requireDesignerRun(db, input.runId);

      const existing = db
        .prepare(
          "SELECT 1 FROM design_attempts WHERE run_id = ? AND slot_id = ? AND attempt_index = ?",
        )
        .get(input.runId, input.slotId, input.attemptIndex);
      if (existing !== undefined) {
        throw new StorageError(
          "DUPLICATE_ATTEMPT",
          `design attempt already exists: ${input.runId}/${input.slotId}/${input.attemptIndex}`,
        );
      }

      if (input.attemptIndex > 0) {
        const previousRow = db
          .prepare(
            "SELECT run_id, slot_id, attempt_index, role, arm, logical_call_id, proposal_artifact_id, diagnostic_json, verdict, cost_status, cost_usd, started_at, finished_at, elapsed_ms, created_at FROM design_attempts WHERE run_id = ? AND slot_id = ? AND attempt_index = ?",
          )
          .get(
            input.runId,
            input.slotId,
            input.attemptIndex - 1,
          ) as DesignAttemptRow | undefined;
        if (previousRow === undefined) {
          throw new StorageError(
            "INVALID_INPUT",
            "repair attempts require the immediately preceding attempt",
          );
        }
        const previous = rowToDesignAttempt(db, previousRow);
        if (diagnosticForRepair(previous) === null) {
          throw new StorageError(
            "INVALID_INPUT",
            "previous attempt is not repairable",
          );
        }
        if (
          previous.proposalArtifactId === null &&
          !previous.artifacts.some(
            (artifact) =>
              artifact.role === "raw_response" || artifact.role === "proposal",
          )
        ) {
          throw new StorageError(
            "INVALID_INPUT",
            "previous attempt has no saved response to repair",
          );
        }
      }

      if (input.logicalCallId !== null && input.logicalCallId !== undefined) {
        const call = db
          .prepare(
            "SELECT run_id, slot_id, role FROM logical_calls WHERE logical_call_id = ?",
          )
          .get(input.logicalCallId) as
          | { run_id: string | null; slot_id: string | null; role: string }
          | undefined;
        if (call === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `logical call not found: ${input.logicalCallId}`,
          );
        }
        if (
          call.run_id !== input.runId ||
          call.slot_id !== input.slotId ||
          call.role !== input.role
        ) {
          throw new StorageError(
            "INVALID_INPUT",
            "logical call does not match the design attempt",
          );
        }
      }

      let proposalArtifactId: number | null = null;
      const storedArtifacts: Array<{
        readonly artifactId: number;
        readonly role: string;
      }> = [];
      if (input.proposalArtifact !== null && input.proposalArtifact !== undefined) {
        const proposal = storeArtifact(db, input.proposalArtifact, createdAt);
        proposalArtifactId = proposal.artifactId;
        storedArtifacts.push({ artifactId: proposal.artifactId, role: "proposal" });
      }
      for (const artifact of extraArtifacts) {
        const record = storeArtifact(db, artifact, createdAt);
        storedArtifacts.push({ artifactId: record.artifactId, role: artifact.role });
      }

      db.prepare(
        "INSERT INTO design_attempts (run_id, slot_id, attempt_index, role, arm, logical_call_id, proposal_artifact_id, diagnostic_json, verdict, cost_status, cost_usd, started_at, finished_at, elapsed_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.runId,
        input.slotId,
        input.attemptIndex,
        input.role,
        input.arm,
        input.logicalCallId ?? null,
        proposalArtifactId,
        diagnosticJson,
        input.verdict,
        input.costStatus,
        input.costUsd ?? null,
        input.startedAt,
        input.finishedAt,
        input.elapsedMs,
        createdAt,
      );

      for (const artifact of storedArtifacts) {
        db.prepare(
          "INSERT INTO design_attempt_artifacts (run_id, slot_id, attempt_index, role, artifact_id) VALUES (?, ?, ?, ?, ?)",
        ).run(
          input.runId,
          input.slotId,
          input.attemptIndex,
          artifact.role,
          artifact.artifactId,
        );
      }

      const insertedRow = db
        .prepare(
          "SELECT run_id, slot_id, attempt_index, role, arm, logical_call_id, proposal_artifact_id, diagnostic_json, verdict, cost_status, cost_usd, started_at, finished_at, elapsed_ms, created_at FROM design_attempts WHERE run_id = ? AND slot_id = ? AND attempt_index = ?",
        )
        .get(
          input.runId,
          input.slotId,
          input.attemptIndex,
        ) as DesignAttemptRow | undefined;
      if (insertedRow === undefined) {
        throw new StorageError(
          "INVALID_STORED_DATA",
          "design attempt insert did not return a row",
        );
      }
      rowToDesignAttempt(db, insertedRow);

      insertEvent(db, {
        runId: input.runId,
        slotId: input.slotId,
        eventType: "design_attempt_committed",
        stage: input.arm === "baseline" ? "planned" : "design_proposed",
        payload: {
          attemptIndex: input.attemptIndex,
          role: input.role,
          arm: input.arm,
          verdict: input.verdict,
          diagnosticHash:
            diagnostic === null ? null : sha256Hex(diagnosticJson ?? ""),
          logicalCallId: input.logicalCallId ?? null,
        },
        createdAt,
      });
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    const code = constraintCode(error);
    if (
      code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      throw new StorageError(
        "DUPLICATE_ATTEMPT",
        `design attempt already exists: ${input.runId}/${input.slotId}/${input.attemptIndex}`,
        { cause: error },
      );
    }
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      throw new StorageError(
        "CONSTRAINT_VIOLATION",
        `design attempt constraint failed: ${input.runId}/${input.slotId}/${input.attemptIndex}`,
        { cause: error },
      );
    }
    throw error;
  }

  return getDesignAttempt(db, input.runId, input.slotId, input.attemptIndex);
}

export function getDesignAttempt(
  db: Database.Database,
  runId: string,
  slotId: string,
  attemptIndex: number,
): DesignAttemptRecord {
  assertUuid(runId, "runId");
  const slot = getSlotRow(db, runId, slotId);
  if (slot === undefined) {
    throw new StorageError("NOT_FOUND", `slot not found: ${runId}/${slotId}`);
  }
  if (slot.slot_kind !== "designer") {
    throw new StorageError(
      "INVALID_INPUT",
      `slot ${runId}/${slotId} is not a designer slot`,
    );
  }
  requireDesignerRun(db, runId);
  const row = db
    .prepare(
      "SELECT run_id, slot_id, attempt_index, role, arm, logical_call_id, proposal_artifact_id, diagnostic_json, verdict, cost_status, cost_usd, started_at, finished_at, elapsed_ms, created_at FROM design_attempts WHERE run_id = ? AND slot_id = ? AND attempt_index = ?",
    )
    .get(runId, slotId, attemptIndex) as DesignAttemptRow | undefined;
  if (row === undefined) {
    throw new StorageError(
      "NOT_FOUND",
      `design attempt not found: ${runId}/${slotId}/${attemptIndex}`,
    );
  }
  return rowToDesignAttempt(db, row);
}

export function listDesignAttempts(
  db: Database.Database,
  runId: string,
  slotId: string,
): DesignAttemptRecord[] {
  assertUuid(runId, "runId");
  const slot = getSlotRow(db, runId, slotId);
  if (slot === undefined) {
    throw new StorageError("NOT_FOUND", `slot not found: ${runId}/${slotId}`);
  }
  if (slot.slot_kind !== "designer") {
    throw new StorageError(
      "INVALID_INPUT",
      `slot ${runId}/${slotId} is not a designer slot`,
    );
  }
  requireDesignerRun(db, runId);
  const rows = db
    .prepare(
      "SELECT run_id, slot_id, attempt_index, role, arm, logical_call_id, proposal_artifact_id, diagnostic_json, verdict, cost_status, cost_usd, started_at, finished_at, elapsed_ms, created_at FROM design_attempts WHERE run_id = ? AND slot_id = ? ORDER BY attempt_index",
    )
    .all(runId, slotId) as DesignAttemptRow[];
  return rows.map((row) => rowToDesignAttempt(db, row));
}

export function getEvents(db: Database.Database, runId: string): EventRecord[] {
  assertUuid(runId, "runId");
  const run = getRunRow(db, runId);
  if (run === undefined) {
    throw new StorageError("NOT_FOUND", `run not found: ${runId}`);
  }
  if (run.run_kind.startsWith("design_")) {
    throw new StorageError(
      "INVALID_INPUT",
      `run ${runId} is a designer run; use getDesignerEvents`,
    );
  }
  const rows = db
    .prepare(
      "SELECT event_id, run_id, slot_id, event_type, stage, payload_json, created_at FROM events WHERE run_id = ? ORDER BY event_id",
    )
    .all(runId) as EventRow[];
  return rows.map(rowToEvent);
}
