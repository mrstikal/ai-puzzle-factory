import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { exportDesignerRun } from "./design-report.js";
import { getDesignerRun } from "../storage/repository.js";
import { z } from "zod";
import { getLogicalCall, listAttempts, type LogicalCall } from "../ai/ledger.js";
import { REDACTED, isSensitiveKey } from "../ai/redact.js";
import {
  FailureRecordSchema,
  type FailureCode,
  type FailureRecord,
  type WorkflowStage,
} from "../domain/candidate.js";
import {
  getRun,
  listSlots,
  listStageResults,
  type SlotRecord,
  type StageResultRecord,
} from "../storage/repository.js";
import { getArtifact, getArtifactById } from "../storage/artifacts.js";
import { addUsd } from "../ai/budget.js";
import { StorageError } from "../storage/database.js";
import {
  computeRunMetrics,
  isProvablyUnbilledAttempt,
  type RunMetrics,
} from "./metrics.js";

export type ExportFormat = "all" | "csv" | "jsonl";

export type ExportErrorCode =
  | "INVALID_RUN"
  | "UNSAFE_PATH"
  | "INVALID_FORMAT"
  | "INVALID_EXPORT"
  | "UNSAFE_ARTIFACT";

export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportError";
    this.code = code;
  }
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\bOPENROUTER_API_KEY\s*=\s*[^\s"'`]+/g,
];

export function redactCredentialText(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

function containsCredentialShape(text: string): boolean {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    pattern.lastIndex = 0;
    if (matched) {
      return true;
    }
  }
  return false;
}

export function assertArtifactExportSafe(
  kind: "svg" | "png" | string,
  bytes: Buffer,
): void {
  if (containsCredentialShape(bytes.toString("latin1"))) {
    throw new ExportError(
      "UNSAFE_ARTIFACT",
      `${kind} artifact contains credential-shaped text and cannot be exported`,
    );
  }
}

export function validateArtifactForExport(
  db: Database.Database,
  contentHash: string,
  kind: "svg" | "png",
): void {
  try {
    const artifact = getArtifact(db, contentHash, kind);
    assertArtifactExportSafe(kind, artifact.bytes);
  } catch (error) {
    if (error instanceof StorageError && error.code === "NOT_FOUND") {
      return;
    }
    throw error;
  }
}

function redactCredentialStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return redactCredentialText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactCredentialStrings);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, item]) => [key, redactCredentialStrings(item)]),
    );
  }
  return value;
}

export function sanitizeExportValue<T>(value: T): T {
  return redactCredentialStrings(value) as T;
}

export const CandidateExportRowSchema = z.looseObject({
  version: z.literal(1),
  slotId: z.string().min(1),
  slotOrdinal: z.number().int().positive(),
  family: z.string().min(1),
  modality: z.string().min(1),
  lane: z.string().min(1),
  difficulty: z.number().int().min(1).max(5),
  stage: z.string().min(1),
  verdict: z.string().nullable(),
  checkpointVersion: z.number().int().nonnegative(),
  started: z.boolean(),
  terminal: z.boolean(),
  formalPassed: z.boolean(),
  presentationCheckPassed: z.boolean(),
  reviewed: z.boolean(),
  presentation: z.unknown().nullable(),
  fingerprint: z.unknown().nullable(),
  duplicateAssessment: z.unknown().nullable(),
  blindReview: z.unknown().nullable(),
  alignmentReview: z.unknown().nullable(),
  terminalPayload: z.unknown().nullable(),
  failures: z.array(z.unknown()),
  primaryFailure: z.string().nullable(),
  failureEvidence: z.string().nullable(),
  question: z.string().nullable(),
  hint: z.string().nullable(),
  explanation: z.string().nullable(),
  assets: z.object({ svg: z.boolean(), png: z.boolean() }),
  cost: z.object({
    knownActualUsd: z.string(),
    actualCostUsd: z.string().nullable(),
    costStatus: z.enum(["known", "unknown", "not_applicable"]),
    unknownAttempts: z.number().int().nonnegative(),
  }),
  preparationActiveMs: z.number().int().nonnegative().nullable(),
  reviewActiveMs: z.number().int().nonnegative().nullable(),
  wallTimeMs: z.number().int().nonnegative().nullable(),
});
export type CandidateExportRow = z.infer<typeof CandidateExportRowSchema>;

export const RequestExportRowSchema = z.looseObject({
  version: z.literal(1),
  logicalCallId: z.string().min(1),
  slotId: z.string().nullable(),
  role: z.string().min(1),
  state: z.string().min(1),
  requestHash: z.string().min(1),
  requestBody: z.unknown(),
  expectedSchemaHash: z.string().min(1),
  model: z.string().min(1),
  routingPolicy: z.literal("balanced"),
  outputCapField: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  retryNotBefore: z.string().nullable(),
  attempts: z.array(
    z.looseObject({
      attemptId: z.string().min(1),
      attemptNumber: z.number().int().positive(),
      state: z.string().min(1),
      observedModel: z.string().nullable(),
      observedProvider: z.string().nullable(),
      httpStatus: z.number().int().nullable(),
      generationId: z.string().nullable(),
      finishReason: z.string().nullable(),
      promptTokens: z.number().int().nullable(),
      completionTokens: z.number().int().nullable(),
      totalTokens: z.number().int().nullable(),
      cachedReadTokens: z.number().int().nullable(),
      cachedWriteTokens: z.number().int().nullable(),
      reasoningTokens: z.number().int().nullable(),
      actualCostUsd: z.string().nullable(),
      costStatus: z.enum(["known", "unknown"]),
      errorClassification: z.string().nullable(),
      partialCompletion: z.boolean(),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      elapsedMs: z.number().int().nullable(),
      updatedAt: z.string().min(1),
      rawResponseArtifactId: z.number().int().positive().nullable(),
      rawResponseArtifact: z
        .object({
          contentHash: z.string().min(1),
          mediaType: z.string().min(1),
          byteLength: z.number().int().nonnegative(),
        })
        .nullable(),
      rawResponse: z.unknown().nullable(),
      reservation: z
        .object({
          state: z.string().min(1),
          kind: z.string().min(1),
          amountUsd: z.string(),
          actualCostUsd: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
export type RequestExportRow = z.infer<typeof RequestExportRowSchema>;

export interface ExportOptions {
  readonly format?: ExportFormat;
  readonly outputRoot?: string;
}

export interface ExportResult {
  readonly runId: string;
  readonly directory: string;
  readonly files: readonly string[];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function failureRecords(payload: unknown): FailureRecord[] {
  const parsed = FailureRecordSchema.array().safeParse(objectValue(payload).failures);
  return parsed.success ? parsed.data : [];
}

function stageFailureFrom(payload: unknown): FailureRecord | null {
  const parsed = FailureRecordSchema.safeParse(objectValue(payload).failure);
  return parsed.success ? parsed.data : null;
}

function stageFailureRecords(
  stages: ReadonlyMap<WorkflowStage, StageResultRecord>,
): FailureRecord[] {
  return [
    stageFailureFrom(stages.get("spec_ready")?.payload),
    stageFailureFrom(stages.get("formal_checked")?.payload),
    stageFailureFrom(stages.get("presentation_ready")?.payload),
    stageFailureFrom(stages.get("blind_reviewed")?.payload),
    stageFailureFrom(stages.get("alignment_reviewed")?.payload),
  ].filter((failure): failure is FailureRecord => failure !== null);
}

function primaryFailureOf(
  payload: unknown,
  failures: readonly FailureRecord[],
): FailureCode | null {
  const value = objectValue(payload).primaryFailure;
  if (typeof value === "string") {
    return value as FailureCode;
  }
  return failures[0]?.code ?? null;
}

function presentationQuestion(presentation: unknown): string | null {
  const visible = objectValue(objectValue(presentation).visible);
  return stringOrNull(visible.question);
}

function presentationHint(presentation: unknown): string | null {
  const reveal = objectValue(objectValue(presentation).reveal);
  return stringOrNull(reveal.hint);
}

function presentationExplanation(presentation: unknown): string | null {
  const reveal = objectValue(objectValue(presentation).reveal);
  const steps = reveal.explanationSteps;
  if (Array.isArray(steps)) {
    const text = steps.filter((step): step is string => typeof step === "string");
    return text.length === 0 ? null : text.join(" ");
  }
  return stringOrNull(reveal.explanation);
}

function activeTime(
  stages: Map<WorkflowStage, StageResultRecord>,
  names: readonly WorkflowStage[],
): number | null {
  let total = 0;
  for (const name of names) {
    const value = stages.get(name)?.elapsedMs ?? null;
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function wallTime(stages: Map<WorkflowStage, StageResultRecord>): number | null {
  const terminal = stages.get("terminal");
  if (terminal?.finishedAt === null || terminal?.finishedAt === undefined) {
    return null;
  }
  const starts = [...stages.values()]
    .map((stage) => Date.parse(stage.startedAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (starts.length === 0) {
    return null;
  }
  return Math.max(0, Date.parse(terminal.finishedAt) - (starts[0] as number));
}

function costForSlot(
  db: Database.Database,
  runId: string,
  slotId: string,
): {
  readonly knownActualUsd: string;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly unknownAttempts: number;
} {
  const rows = db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ?",
    )
    .all(runId, slotId) as Array<{ logical_call_id: string }>;
  const attempts = rows.flatMap((row) =>
    listAttempts(db, row.logical_call_id),
  );
  const known = attempts.flatMap((attempt) =>
    attempt.costStatus === "known" && attempt.actualCostUsd !== null
      ? [attempt.actualCostUsd]
      : [],
  );
  const unknownAttempts = attempts.filter(
    (attempt) =>
      attempt.costStatus === "unknown" && !isProvablyUnbilledAttempt(attempt),
  ).length;
  const knownActualUsd = addUsd(...known);
  return {
    knownActualUsd,
    actualCostUsd:
      attempts.length === 0
        ? null
        : unknownAttempts > 0
          ? null
          : knownActualUsd,
    costStatus:
      attempts.length === 0
        ? "not_applicable"
        : unknownAttempts > 0
          ? "unknown"
          : "known",
    unknownAttempts,
  };
}

function buildCandidateRow(
  db: Database.Database,
  runId: string,
  slot: SlotRecord,
  stages: Map<WorkflowStage, StageResultRecord>,
): CandidateExportRow {
  const formalPayload = stages.get("formal_checked")?.payload;
  const terminalPayload = stages.get("terminal")?.payload ?? null;
  const presentation =
    objectValue(stages.get("presentation_ready")?.payload).presentation ?? null;
  const failures =
    terminalPayload === null
      ? stageFailureRecords(stages)
      : failureRecords(terminalPayload);
  const render = objectValue(objectValue(formalPayload).render);
  const svgHash = stringOrNull(render.svgHash);
  const pngHash = stringOrNull(render.pngHash);
  const svg = svgHash !== null && hasArtifact(db, svgHash, "svg");
  const png = pngHash !== null && hasArtifact(db, pngHash, "png");
  return CandidateExportRowSchema.parse(
    sanitizeExportValue({
      version: 1,
      slotId: slot.slotId,
      slotOrdinal: slot.slotOrdinal,
      family: slot.family,
      modality: slot.modality,
      lane: slot.lane,
      difficulty: slot.difficulty,
      stage: slot.stage,
      verdict: slot.verdict,
      checkpointVersion: slot.checkpointVersion,
      started: stages.size > 0 || hasCalls(db, runId, slot.slotId),
      terminal: stages.has("terminal"),
      formalPassed: stages.has("formal_checked"),
      presentationCheckPassed: stages.has("presentation_ready"),
      reviewed: stages.has("blind_reviewed"),
      presentation,
      fingerprint:
        objectValue(formalPayload).fingerprint ??
        objectValue(terminalPayload).fingerprint ??
        null,
      duplicateAssessment:
        objectValue(stages.get("duplicate_checked")?.payload).assessment ?? null,
      blindReview: stages.get("blind_reviewed")?.payload ?? null,
      alignmentReview: stages.get("alignment_reviewed")?.payload ?? null,
      terminalPayload,
      failures,
      primaryFailure: primaryFailureOf(terminalPayload, failures),
      failureEvidence:
        failures.length === 0
          ? null
          : failures
              .map(
                (failure) =>
                  `${failure.code}@${failure.stage}: ${failure.evidence ?? ""}`,
              )
              .join(" | "),
      question: presentationQuestion(presentation),
      hint: presentationHint(presentation),
      explanation: presentationExplanation(presentation),
      assets: { svg, png },
      cost: costForSlot(db, runId, slot.slotId),
      preparationActiveMs: activeTime(stages, [
        "spec_ready",
        "formal_checked",
        "presentation_ready",
      ]),
      reviewActiveMs: activeTime(stages, [
        "duplicate_checked",
        "blind_reviewed",
        "alignment_reviewed",
        "terminal",
      ]),
      wallTimeMs: wallTime(stages),
    }),
  );
}

export function buildCandidateRows(
  db: Database.Database,
  runId: string,
): CandidateExportRow[] {
  const slots = listSlots(db, runId);
  const stagesBySlot = new Map<string, Map<WorkflowStage, StageResultRecord>>();
  for (const stage of listStageResults(db, runId)) {
    const map = stagesBySlot.get(stage.slotId) ?? new Map();
    map.set(stage.stage, stage);
    stagesBySlot.set(stage.slotId, map);
  }
  return slots.map((slot) =>
    buildCandidateRow(
      db,
      runId,
      slot,
      stagesBySlot.get(slot.slotId) ?? new Map(),
    ),
  );
}

function hasCalls(db: Database.Database, runId: string, slotId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM logical_calls WHERE run_id = ? AND slot_id = ? LIMIT 1",
      )
      .get(runId, slotId) !== undefined
  );
}

function hasArtifact(
  db: Database.Database,
  contentHash: string,
  kind: "svg" | "png",
): boolean {
  try {
    getArtifact(db, contentHash, kind);
    return true;
  } catch (error) {
    if (error instanceof StorageError && error.code === "NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

export function buildRequestRows(
  db: Database.Database,
  runId: string,
): RequestExportRow[] {
  const rows = db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? ORDER BY role, created_at, logical_call_id",
    )
    .all(runId) as Array<{ logical_call_id: string }>;
  return rows.map((row) => buildRequestRow(db, getLogicalCall(db, row.logical_call_id)));
}

function buildRequestRow(
  db: Database.Database,
  call: LogicalCall,
): RequestExportRow {
  const attempts = listAttempts(db, call.logicalCallId).map((attempt) => {
    let rawResponse: unknown = null;
    let rawResponseArtifact: {
      contentHash: string;
      mediaType: string;
      byteLength: number;
    } | null = null;
    if (attempt.rawResponseArtifactId !== null) {
      try {
        const artifact = getArtifactById(db, attempt.rawResponseArtifactId);
        rawResponseArtifact = {
          contentHash: artifact.artifact.contentHash,
          mediaType: artifact.artifact.mediaType,
          byteLength: artifact.artifact.byteLength,
        };
        const text = artifact.bytes.toString("utf8");
        try {
          rawResponse = JSON.parse(text) as unknown;
        } catch {
          rawResponse = text;
        }
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "NOT_FOUND") {
          throw error;
        }
      }
    }
    const reservation = db
      .prepare(
        "SELECT state, kind, amount_usd, actual_cost_usd FROM budget_reservations WHERE attempt_id = ? LIMIT 1",
      )
      .get(attempt.attemptId) as
      | {
          state: string;
          kind: string;
          amount_usd: string;
          actual_cost_usd: string | null;
        }
      | undefined;
    return {
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      state: attempt.state,
      observedModel: attempt.observedModel,
      observedProvider: attempt.observedProvider,
      httpStatus: attempt.httpStatus,
      generationId: attempt.generationId,
      finishReason: attempt.finishReason,
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      totalTokens: attempt.totalTokens,
      cachedReadTokens: attempt.cachedReadTokens,
      cachedWriteTokens: attempt.cachedWriteTokens,
      reasoningTokens: attempt.reasoningTokens,
      actualCostUsd: attempt.actualCostUsd,
      costStatus: attempt.costStatus,
      errorClassification: attempt.errorClassification,
      partialCompletion: attempt.partialCompletion,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      elapsedMs: attempt.elapsedMs,
      updatedAt: attempt.updatedAt,
      rawResponseArtifactId: attempt.rawResponseArtifactId,
      rawResponseArtifact,
      rawResponse,
      reservation:
        reservation === undefined
          ? null
          : {
              state: reservation.state,
              kind: reservation.kind,
              amountUsd: reservation.amount_usd,
              actualCostUsd: reservation.actual_cost_usd,
            },
    };
  });
  return RequestExportRowSchema.parse(
    sanitizeExportValue({
      version: 1,
      logicalCallId: call.logicalCallId,
      slotId: call.slotId,
      role: call.role,
      state: call.state,
      requestHash: call.requestHash,
      requestBody: call.requestBody,
      expectedSchemaHash: call.expectedSchemaHash,
      model: call.model,
      routingPolicy: call.routingPolicy,
      outputCapField: call.outputCapField,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      retryNotBefore: call.retryNotBefore,
      attempts,
    }),
  );
}

function startsWithFormula(value: string): boolean {
  let index = 0;
  while (index < value.length && value.charCodeAt(index) <= 0x20) {
    index += 1;
  }
  const first = value[index];
  return (
    first === "=" ||
    first === "+" ||
    first === "-" ||
    first === "@" ||
    first === "\t" ||
    first === "\r"
  );
}

function hasLeadingControl(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const code = value.charCodeAt(0);
  return code >= 0 && code <= 0x1f;
}

export function escapeCsvFormulaText(value: string): string {
  return startsWithFormula(value) || hasLeadingControl(value)
    ? `'${value}`
    : value;
}

function csvField(value: string | number | null): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "number") {
    return String(value);
  }
  const escaped = escapeCsvFormulaText(value);
  return `"${escaped.replace(/"/g, '""')}"`;
}

const RESULT_COLUMNS = [
  "slot_id",
  "slot_ordinal",
  "family",
  "modality",
  "lane",
  "difficulty",
  "stage",
  "verdict",
  "formal_passed",
  "presentation_check_passed",
  "reviewed",
  "duplicate_outcome",
  "primary_failure",
  "failure_codes",
  "known_actual_cost_usd",
  "actual_cost_usd",
  "cost_status",
  "preparation_active_ms",
  "review_active_ms",
  "wall_time_ms",
  "question",
  "hint",
  "explanation",
  "failure_evidence",
] as const;

function buildResultsCsv(rows: readonly CandidateExportRow[]): string {
  const lines: string[] = [RESULT_COLUMNS.map((column) => csvField(column)).join(",")];
  for (const row of rows) {
    const assessment = objectValue(row.duplicateAssessment);
    const duplicateOutcome = stringOrNull(assessment.outcome);
    const failureCodes = row.failures
      .map((failure) => stringOrNull(objectValue(failure).code))
      .filter((code): code is string => code !== null)
      .join("|");
    lines.push(
      [
        row.slotId,
        row.slotOrdinal,
        row.family,
        row.modality,
        row.lane,
        row.difficulty,
        row.stage,
        row.verdict,
        row.formalPassed ? "1" : "0",
        row.presentationCheckPassed ? "1" : "0",
        row.reviewed ? "1" : "0",
        duplicateOutcome,
        row.primaryFailure,
        failureCodes,
        row.cost.knownActualUsd,
        row.cost.actualCostUsd,
        row.cost.costStatus,
        row.preparationActiveMs,
        row.reviewActiveMs,
        row.wallTimeMs,
        row.question,
        row.hint,
        row.explanation,
        row.failureEvidence,
      ]
        .map((value) => csvField(value as string | number | null))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function resolveRunDirectory(runId: string, outputRoot: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new ExportError("UNSAFE_PATH", `invalid run UUID: ${runId}`);
  }
  const root = resolve(outputRoot);
  const directory = resolve(root, runId);
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new ExportError("UNSAFE_PATH", "run directory escapes the export root");
  }
  return directory;
}

export function writeAtomicFile(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

export function exportRun(
  db: Database.Database,
  runId: string,
  options: ExportOptions = {},
): ExportResult {
  const format = options.format ?? "all";
  if (format !== "all" && format !== "csv" && format !== "jsonl") {
    throw new ExportError("INVALID_FORMAT", `unsupported export format: ${format}`);
  }
  let designerRun;
  try {
    designerRun = getDesignerRun(db, runId);
  } catch {
    designerRun = null;
  }
  if (designerRun !== null) {
    const designer = exportDesignerRun(db, runId, {
      ...(options.outputRoot === undefined ? {} : { outputRoot: options.outputRoot }),
      format,
    });
    return {
      runId: designer.runId,
      directory: designer.directory,
      files: designer.files,
    };
  }
  let run;
  try {
    run = getRun(db, runId);
  } catch (error) {
    throw new ExportError("INVALID_RUN", `run not found: ${runId}`, { cause: error });
  }
  const outputRoot = options.outputRoot ?? join("data", "runs");
  const directory = resolveRunDirectory(runId, outputRoot);
  mkdirSync(directory, { recursive: true });
  const files: string[] = [];
  const stageRows = listStageResults(db, runId);
  const stagesBySlot = new Map<string, Map<WorkflowStage, StageResultRecord>>();
  for (const stage of stageRows) {
    const map = stagesBySlot.get(stage.slotId) ?? new Map();
    map.set(stage.stage, stage);
    stagesBySlot.set(stage.slotId, map);
  }
  const candidateRows = buildCandidateRows(db, runId);
  const requestRows = buildRequestRows(db, runId);
  const metrics: RunMetrics = computeRunMetrics(db, runId);

  const manifestPath = join(directory, "manifest.json");
  writeAtomicFile(
    manifestPath,
    `${JSON.stringify(
      sanitizeExportValue({
        version: 1,
        run: {
          runId: run.runId,
          runKind: run.runKind,
          evidenceKind: run.evidenceKind,
          protocolVersion: run.protocolVersion,
          rootSeed: run.rootSeed,
          manifestHash: run.manifestHash,
          controlState: run.controlState,
          createdAt: run.createdAt,
        },
        manifest: run.manifest,
      }),
      null,
      2,
    )}\n`,
  );
  files.push(manifestPath);
  const summaryPath = join(directory, "summary.json");
  writeAtomicFile(summaryPath, `${JSON.stringify(metrics, null, 2)}\n`);
  files.push(summaryPath);

  if (format === "all" || format === "jsonl") {
    const candidatesPath = join(directory, "candidates.jsonl");
    writeAtomicFile(
      candidatesPath,
      `${candidateRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    files.push(candidatesPath);
    const requestsPath = join(directory, "requests.jsonl");
    writeAtomicFile(
      requestsPath,
      `${requestRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    files.push(requestsPath);
  }
  if (format === "all" || format === "csv") {
    const resultsPath = join(directory, "results.csv");
    writeAtomicFile(resultsPath, buildResultsCsv(candidateRows));
    files.push(resultsPath);
  }
  if (format === "all") {
    for (const row of candidateRows) {
      const formal = objectValue(
        stagesBySlot.get(row.slotId)?.get("formal_checked")?.payload,
      );
      const render = objectValue(formal.render);
      const svgHash = stringOrNull(render.svgHash);
      const pngHash = stringOrNull(render.pngHash);
      if (svgHash !== null) {
        validateArtifactForExport(db, svgHash, "svg");
      }
      if (pngHash !== null) {
        validateArtifactForExport(db, pngHash, "png");
      }
    }
    const puzzleDirectory = join(directory, "puzzles");
    const imageDirectory = join(directory, "images");
    for (const row of candidateRows) {
      const puzzlePath = join(puzzleDirectory, `${row.slotId}.json`);
      writeAtomicFile(puzzlePath, `${JSON.stringify(row, null, 2)}\n`);
      files.push(puzzlePath);
      const formal = objectValue(
        stagesBySlot.get(row.slotId)?.get("formal_checked")?.payload,
      );
      const render = objectValue(formal.render);
      const svgHash = stringOrNull(render.svgHash);
      const pngHash = stringOrNull(render.pngHash);
      if (svgHash !== null) {
        try {
          const artifact = getArtifact(db, svgHash, "svg");
          assertArtifactExportSafe("svg", artifact.bytes);
          const path = join(imageDirectory, `${row.slotId}.svg`);
          writeAtomicFile(path, artifact.bytes);
          files.push(path);
        } catch (error) {
          if (!(error instanceof StorageError) || error.code !== "NOT_FOUND") {
            throw error;
          }
        }
      }
      if (pngHash !== null) {
        try {
          const artifact = getArtifact(db, pngHash, "png");
          assertArtifactExportSafe("png", artifact.bytes);
          const path = join(imageDirectory, `${row.slotId}.png`);
          writeAtomicFile(path, artifact.bytes);
          files.push(path);
        } catch (error) {
          if (!(error instanceof StorageError) || error.code !== "NOT_FOUND") {
            throw error;
          }
        }
      }
    }
  }
  return { runId, directory, files };
}

function readJsonl<T>(
  path: string,
  schema: z.ZodType<T>,
): T[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new ExportError(
        "INVALID_EXPORT",
        `invalid JSONL at ${path}:${index + 1}`,
        { cause: error },
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ExportError(
        "INVALID_EXPORT",
        `invalid export row at ${path}:${index + 1}`,
        { cause: result.error },
      );
    }
    return result.data;
  });
}

export function readCandidatesExport(path: string): CandidateExportRow[] {
  return readJsonl(path, CandidateExportRowSchema);
}

export function readRequestsExport(path: string): RequestExportRow[] {
  return readJsonl(path, RequestExportRowSchema);
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character === "\r") {
      if (text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readResultsCsv(path: string): Array<Record<string, string>> {
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0] as string[];
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index] as string] = row[index] ?? "";
    }
    return record;
  });
}
