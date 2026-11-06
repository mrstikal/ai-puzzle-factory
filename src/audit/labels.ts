import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { VisibleRules } from "../families/contracts.js";
import {
  getArtifact,
} from "../storage/artifacts.js";
import { withTransaction } from "../storage/database.js";
import type { CandidateExportRow } from "../reporting/export.js";
import {
  resolveRunDirectory,
  writeAtomicFile,
} from "../reporting/export.js";
import type { RunRecord } from "../storage/repository.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";
import {
  auditSampleEntries,
  selectAuditSample,
  type AuditSampleEntry,
  type AuditSampleManifest,
} from "./sample.js";

export const AUDIT_LABEL_COLUMNS = [
  "sample_hash",
  "run_id",
  "slot_id",
  "slot_hash",
  "family",
  "lane",
  "modality",
  "difficulty",
  "inspectable",
  "correctness",
  "clarity",
  "hint_support",
  "explanation_support",
  "image_readability",
  "novelty_concern",
  "enjoyment",
  "perceived_difficulty",
  "solve_time",
  "notes",
  "auditor",
  "auditor_time",
] as const;

export const AUDIT_CORRECTNESS = [
  "correct",
  "incorrect",
  "unresolved",
  "not_inspectable",
] as const;
export const AUDIT_CLARITY = ["clear", "unclear", "not_inspectable"] as const;
export const AUDIT_SUPPORT = [
  "supported",
  "unsupported",
  "unresolved",
  "not_inspectable",
] as const;
export const AUDIT_IMAGE_READABILITY = [
  "readable",
  "unreadable",
  "not_applicable",
  "not_inspectable",
] as const;
export const AUDIT_NOVELTY = [
  "none",
  "concern",
  "unresolved",
  "not_inspectable",
] as const;
export const AUDIT_SOLVE_TIME = [
  "<=60s",
  "61-180s",
  ">180s",
  "not_solved",
  "not_inspectable",
] as const;

export const MOCK_AUDITOR = "mock-test-only";

const CorrectnessSchema = z.enum(AUDIT_CORRECTNESS);
const ClaritySchema = z.enum(AUDIT_CLARITY);
const SupportSchema = z.enum(AUDIT_SUPPORT);
const ImageReadabilitySchema = z.enum(AUDIT_IMAGE_READABILITY);
const NoveltySchema = z.enum(AUDIT_NOVELTY);
const SolveTimeSchema = z.enum(AUDIT_SOLVE_TIME);

export const AuditLabelRowSchema = z.strictObject({
  sampleHash: z.string().regex(/^[0-9a-f]{64}$/),
  runId: z.uuid(),
  slotId: z.string().min(1).max(80),
  slotHash: z.string().regex(/^[0-9a-f]{64}$/),
  family: z.string().min(1),
  lane: z.string().min(1),
  modality: z.enum(["text", "svg"]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  inspectable: z.boolean(),
  correctness: z.union([CorrectnessSchema, z.literal("")]),
  clarity: z.union([ClaritySchema, z.literal("")]),
  hintSupport: z.union([SupportSchema, z.literal("")]),
  explanationSupport: z.union([SupportSchema, z.literal("")]),
  imageReadability: z.union([ImageReadabilitySchema, z.literal("")]),
  noveltyConcern: z.union([NoveltySchema, z.literal("")]),
  enjoyment: z.number().int().min(1).max(5).nullable(),
  perceivedDifficulty: z.number().int().min(1).max(5).nullable(),
  solveTime: z.union([SolveTimeSchema, z.literal("")]),
  notes: z.string().max(2000),
  auditor: z.string().max(200),
  auditorTime: z.string().max(40),
});

export type AuditLabelRow = z.infer<typeof AuditLabelRowSchema>;

export interface AuditImportResult {
  readonly sampleHash: string;
  readonly imported: number;
  readonly revisions: readonly number[];
  readonly auditor: string;
  readonly auditorTime: string;
  readonly summary: AuditSummary;
}

export interface AuditSummary {
  readonly version: 1;
  readonly runId: string;
  readonly sampleHash: string;
  readonly production: boolean;
  readonly total: {
    readonly sampled: number;
    readonly labelled: number;
    readonly inspectable: number;
  };
  readonly approved: {
    readonly sampled: number;
    readonly labelled: number;
    readonly inspectable: number;
  };
  readonly labelRows: number;
  readonly maxRevision: number;
  readonly auditors: readonly string[];
}

export class AuditLabelError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "AuditLabelError";
  }
}

function csvCell(value: string): string {
  let text = value;
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) {
        rows.push(row);
      }
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "")) {
      rows.push(row);
    }
  }
  return rows;
}

function nullableNumber(value: string): number | null {
  return value === "" ? null : Number(value);
}

function rowFromCells(cells: readonly string[]): AuditLabelRow {
  if (cells.length !== AUDIT_LABEL_COLUMNS.length) {
    throw new AuditLabelError(
      "INVALID_AUDIT_LABELS",
      `audit label row has ${cells.length} cells; expected ${AUDIT_LABEL_COLUMNS.length}`,
    );
  }
  const values = Object.fromEntries(
    AUDIT_LABEL_COLUMNS.map((column, index) => [column, cells[index] ?? ""]),
  ) as Record<(typeof AUDIT_LABEL_COLUMNS)[number], string>;
  return AuditLabelRowSchema.parse({
    sampleHash: values.sample_hash,
    runId: values.run_id,
    slotId: values.slot_id,
    slotHash: values.slot_hash,
    family: values.family,
    lane: values.lane,
    modality: values.modality,
    difficulty: Number(values.difficulty),
    inspectable: values.inspectable === "true",
    correctness: values.correctness,
    clarity: values.clarity,
    hintSupport: values.hint_support,
    explanationSupport: values.explanation_support,
    imageReadability: values.image_readability,
    noveltyConcern: values.novelty_concern,
    enjoyment: nullableNumber(values.enjoyment),
    perceivedDifficulty: nullableNumber(values.perceived_difficulty),
    solveTime: values.solve_time,
    notes: values.notes,
    auditor: values.auditor,
    auditorTime: values.auditor_time,
  });
}

export function parseAuditLabelsCsv(text: string): AuditLabelRow[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) {
    throw new AuditLabelError("INVALID_AUDIT_LABELS", "audit label CSV is empty");
  }
  if (
    header.length !== AUDIT_LABEL_COLUMNS.length ||
    header.some((column, index) => column !== AUDIT_LABEL_COLUMNS[index])
  ) {
    throw new AuditLabelError(
      "INVALID_AUDIT_LABELS",
      "audit label CSV header does not match the P42 contract",
    );
  }
  return rows.slice(1).map(rowFromCells);
}

function entryRow(
  manifest: AuditSampleManifest,
  entry: AuditSampleEntry,
): AuditLabelRow {
  return AuditLabelRowSchema.parse({
    sampleHash: manifest.sampleHash,
    runId: manifest.runId,
    slotId: entry.slotId,
    slotHash: entry.slotHash,
    family: entry.family,
    lane: entry.lane,
    modality: entry.modality,
    difficulty: entry.difficulty,
    inspectable: entry.inspectable,
    correctness: "",
    clarity: "",
    hintSupport: "",
    explanationSupport: "",
    imageReadability: "",
    noveltyConcern: "",
    enjoyment: null,
    perceivedDifficulty: null,
    solveTime: "",
    notes: "",
    auditor: "",
    auditorTime: "",
  });
}

export function pendingAuditLabelRows(
  manifest: AuditSampleManifest,
): AuditLabelRow[] {
  return auditSampleEntries(manifest).map((entry) => entryRow(manifest, entry));
}

export function renderAuditLabelsCsv(rows: readonly AuditLabelRow[]): string {
  const values = rows.map((row) => [
    row.sampleHash,
    row.runId,
    row.slotId,
    row.slotHash,
    row.family,
    row.lane,
    row.modality,
    String(row.difficulty),
    String(row.inspectable),
    row.correctness,
    row.clarity,
    row.hintSupport,
    row.explanationSupport,
    row.imageReadability,
    row.noveltyConcern,
    row.enjoyment === null ? "" : String(row.enjoyment),
    row.perceivedDifficulty === null ? "" : String(row.perceivedDifficulty),
    row.solveTime,
    row.notes,
    row.auditor,
    row.auditorTime,
  ]);
  return `${[AUDIT_LABEL_COLUMNS as unknown as string[], ...values]
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\n")}\n`;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32) {
      return true;
    }
  }
  return false;
}

function validateManifest(manifest: AuditSampleManifest): void {
  const { sampleHash, ...withoutHash } = manifest;
  if (hashCanonicalJson(withoutHash) !== sampleHash) {
    throw new AuditLabelError(
      "SAMPLE_HASH_MISMATCH",
      "audit sample manifest hash does not match its content",
    );
  }
  if (manifest.preview) {
    throw new AuditLabelError(
      "PREVIEW_IMPORT_REJECTED",
      "a preview sample cannot be imported as production human evidence",
    );
  }
  const entries = auditSampleEntries(manifest);
  if (new Set(entries.map((entry) => entry.slotId)).size !== entries.length) {
    throw new AuditLabelError(
      "DUPLICATE_SAMPLE_SLOT",
      "audit sample contains duplicate slot IDs",
    );
  }
  if (entries.length > 44) {
    throw new AuditLabelError(
      "SAMPLE_TOO_LARGE",
      `audit sample has ${entries.length} entries; maximum is 44`,
    );
  }
  if (manifest.production && manifest.core.length > 40) {
    throw new AuditLabelError(
      "CORE_TOO_LARGE",
      `audit core has ${manifest.core.length} entries; maximum is 40`,
    );
  }
}

export interface ValidateAuditImportInput {
  readonly manifest: AuditSampleManifest;
  readonly run: RunRecord;
  readonly candidates: readonly CandidateExportRow[];
  readonly rows: readonly AuditLabelRow[];
  readonly clock?: { now(): Date };
}

export function validateAuditImport(input: ValidateAuditImportInput): void {
  validateManifest(input.manifest);
  if (input.manifest.runId !== input.run.runId) {
    throw new AuditLabelError(
      "RUN_MISMATCH",
      "audit sample does not belong to this run",
    );
  }
  const recomputed = selectAuditSample({
    run: input.run,
    candidates: input.candidates,
  });
  if (recomputed.sampleHash !== input.manifest.sampleHash) {
    throw new AuditLabelError(
      "STALE_AUDIT_SAMPLE",
      "audit sample manifest does not match the deterministic sample recomputed from the run",
    );
  }
  const entries = auditSampleEntries(input.manifest);
  const bySlot = new Map(entries.map((entry) => [entry.slotId, entry]));
  if (input.rows.length !== entries.length) {
    throw new AuditLabelError(
      "INCOMPLETE_AUDIT_LABELS",
      `expected ${entries.length} audit rows, received ${input.rows.length}`,
    );
  }
  const seen = new Set<string>();
  const auditors = new Set<string>();
  const times = new Set<string>();
  const now = (input.clock ?? { now: () => new Date() }).now();
  for (const row of input.rows) {
    if (seen.has(row.slotId)) {
      throw new AuditLabelError(
        "DUPLICATE_AUDIT_ROW",
        `duplicate audit row for ${row.slotId}`,
      );
    }
    seen.add(row.slotId);
    const entry = bySlot.get(row.slotId);
    if (entry === undefined) {
      throw new AuditLabelError(
        "UNKNOWN_AUDIT_SLOT",
        `audit row references unsampled slot ${row.slotId}`,
      );
    }
    if (
      row.sampleHash !== input.manifest.sampleHash ||
      row.runId !== input.manifest.runId ||
      row.slotHash !== entry.slotHash ||
      row.family !== entry.family ||
      row.lane !== entry.lane ||
      row.modality !== entry.modality ||
      row.difficulty !== entry.difficulty ||
      row.inspectable !== entry.inspectable
    ) {
      throw new AuditLabelError(
        "AUDIT_SAMPLE_MISMATCH",
        `audit row metadata does not match sample entry ${row.slotId}`,
      );
    }
    const auditor = row.auditor.trim();
    if (auditor === "" || hasControlCharacters(auditor)) {
      throw new AuditLabelError(
        "INVALID_AUDITOR",
        `${row.slotId} has no valid auditor identity`,
      );
    }
    if (auditor === MOCK_AUDITOR) {
      throw new AuditLabelError(
        "MOCK_AUDITOR_REJECTED",
        "mock/test-only identity cannot be imported as human audit evidence",
      );
    }
    const time = Date.parse(row.auditorTime);
    if (!Number.isFinite(time)) {
      throw new AuditLabelError(
        "INVALID_AUDITOR_TIME",
        `${row.slotId} has no valid auditor time`,
      );
    }
    if (time > now.getTime() + 5 * 60 * 1000) {
      throw new AuditLabelError(
        "INVALID_AUDITOR_TIME",
        `${row.slotId} auditor time is in the future`,
      );
    }
    if (time < Date.parse(input.run.createdAt)) {
      throw new AuditLabelError(
        "INVALID_AUDITOR_TIME",
        `${row.slotId} auditor time is before the run was created`,
      );
    }
    auditors.add(auditor);
    times.add(row.auditorTime);
    if (!row.inspectable) {
      if (
        row.correctness !== "not_inspectable" ||
        row.clarity !== "not_inspectable" ||
        row.hintSupport !== "not_inspectable" ||
        row.explanationSupport !== "not_inspectable" ||
        row.imageReadability !== "not_inspectable" ||
        row.noveltyConcern !== "not_inspectable" ||
        row.solveTime !== "not_inspectable" ||
        row.enjoyment !== null ||
        row.perceivedDifficulty !== null
      ) {
        throw new AuditLabelError(
          "NONINSPECTABLE_LABEL_INVALID",
          `${row.slotId} is not inspectable and must use explicit not_inspectable labels`,
        );
      }
      if (row.notes.trim() === "") {
        throw new AuditLabelError(
          "NONINSPECTABLE_NOTES_REQUIRED",
          `${row.slotId} needs a note explaining why it is not inspectable`,
        );
      }
      continue;
    }
    if (
      row.correctness === "" ||
      row.correctness === "not_inspectable" ||
      row.clarity === "" ||
      row.clarity === "not_inspectable" ||
      row.hintSupport === "" ||
      row.hintSupport === "not_inspectable" ||
      row.explanationSupport === "" ||
      row.explanationSupport === "not_inspectable" ||
      row.imageReadability === "" ||
      row.imageReadability === "not_inspectable" ||
      row.noveltyConcern === "" ||
      row.noveltyConcern === "not_inspectable" ||
      row.solveTime === "" ||
      row.solveTime === "not_inspectable"
    ) {
      throw new AuditLabelError(
        "INCOMPLETE_AUDIT_LABEL",
        `${row.slotId} is inspectable but has incomplete labels`,
      );
    }
    if (row.modality === "text" && row.imageReadability !== "not_applicable") {
      throw new AuditLabelError(
        "INVALID_IMAGE_LABEL",
        `${row.slotId} is text and must use image_readability=not_applicable`,
      );
    }
    if (row.modality === "svg" && row.imageReadability === "not_applicable") {
      throw new AuditLabelError(
        "INVALID_IMAGE_LABEL",
        `${row.slotId} is SVG and cannot use image_readability=not_applicable`,
      );
    }
  }
  if (seen.size !== entries.length) {
    throw new AuditLabelError(
      "INCOMPLETE_AUDIT_LABELS",
      "audit labels do not cover every sampled slot",
    );
  }
  if (auditors.size > 1 || times.size > 1) {
    throw new AuditLabelError(
      "AUDITOR_MISMATCH",
      "one import must use a single auditor identity and time",
    );
  }
}

function labelHash(row: AuditLabelRow): string {
  return hashCanonicalJson({
    sampleHash: row.sampleHash,
    slotId: row.slotId,
    slotHash: row.slotHash,
    correctness: row.correctness,
    clarity: row.clarity,
    hintSupport: row.hintSupport,
    explanationSupport: row.explanationSupport,
    imageReadability: row.imageReadability,
    noveltyConcern: row.noveltyConcern,
    enjoyment: row.enjoyment,
    perceivedDifficulty: row.perceivedDifficulty,
    solveTime: row.solveTime,
    notes: row.notes,
    auditor: row.auditor,
    auditorTime: row.auditorTime,
  });
}

export interface ImportAuditLabelsInput {
  readonly db: Database.Database;
  readonly manifest: AuditSampleManifest;
  readonly run: RunRecord;
  readonly candidates: readonly CandidateExportRow[];
  readonly rows: readonly AuditLabelRow[];
  readonly clock?: { now(): Date };
}

export function importAuditLabels(
  input: ImportAuditLabelsInput,
): AuditImportResult {
  validateAuditImport(input);
  const clock = input.clock ?? { now: () => new Date() };
  const createdAt = clock.now().toISOString();
  const revisions: number[] = [];
  const insert = input.db.prepare(
    `INSERT INTO human_labels (
      run_id, slot_id, revision, sample_hash, slot_hash, auditor, auditor_time,
      correctness, clarity, hint_support, explanation_support, image_readability,
      novelty_concern, enjoyment, perceived_difficulty, solve_time, notes,
      label_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  withTransaction(input.db, () => {
    for (const row of input.rows) {
      const current = input.db
        .prepare(
          "SELECT COALESCE(MAX(revision), 0) AS revision FROM human_labels WHERE run_id = ? AND slot_id = ?",
        )
        .get(input.run.runId, row.slotId) as { revision: number };
      const revision = current.revision + 1;
      revisions.push(revision);
      insert.run(
        input.run.runId,
        row.slotId,
        revision,
        row.sampleHash,
        row.slotHash,
        row.auditor.trim(),
        row.auditorTime,
        row.correctness,
        row.clarity,
        row.hintSupport,
        row.explanationSupport,
        row.imageReadability,
        row.noveltyConcern,
        row.enjoyment,
        row.perceivedDifficulty,
        row.solveTime,
        row.notes,
        labelHash(row),
        createdAt,
      );
    }
  });
  const first = input.rows[0];
  if (first === undefined) {
    throw new AuditLabelError("EMPTY_AUDIT_IMPORT", "no audit labels to import");
  }
  return {
    sampleHash: input.manifest.sampleHash,
    imported: input.rows.length,
    revisions,
    auditor: first.auditor.trim(),
    auditorTime: first.auditorTime,
    summary: buildAuditSummary(input.db, input.manifest, input.candidates),
  };
}

export function buildAuditSummary(
  db: Database.Database,
  manifest: AuditSampleManifest,
  candidates: readonly CandidateExportRow[],
): AuditSummary {
  const entries = auditSampleEntries(manifest);
  const verdictBySlot = new Map(
    candidates.map((candidate) => [candidate.slotId, candidate.verdict]),
  );
  const latest = new Map<
    string,
    {
      correctness: string;
      revision: number;
    }
  >();
  const rows = db
    .prepare(
      `SELECT slot_id, correctness, revision FROM human_labels
       WHERE run_id = ? AND revision = (
         SELECT MAX(revision) FROM human_labels inner_labels
         WHERE inner_labels.run_id = human_labels.run_id
           AND inner_labels.slot_id = human_labels.slot_id
       )`,
    )
    .all(manifest.runId) as Array<{
    slot_id: string;
    correctness: string;
    revision: number;
  }>;
  for (const row of rows) {
    latest.set(row.slot_id, {
      correctness: row.correctness,
      revision: row.revision,
    });
  }
  const inspectable = (entry: AuditSampleEntry): boolean =>
    latest.get(entry.slotId)?.correctness !== undefined &&
    latest.get(entry.slotId)?.correctness !== "not_inspectable";
  const approved = entries.filter(
    (entry) => verdictBySlot.get(entry.slotId) === "approved",
  );
  const labelRows = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(MAX(revision), 0) AS max_revision FROM human_labels WHERE run_id = ?")
    .get(manifest.runId) as { count: number; max_revision: number };
  const auditorRows = db
    .prepare("SELECT DISTINCT auditor FROM human_labels WHERE run_id = ? ORDER BY auditor")
    .all(manifest.runId) as Array<{ auditor: string }>;
  return {
    version: 1,
    runId: manifest.runId,
    sampleHash: manifest.sampleHash,
    production: manifest.production,
    total: {
      sampled: entries.length,
      labelled: entries.filter((entry) => latest.has(entry.slotId)).length,
      inspectable: entries.filter(inspectable).length,
    },
    approved: {
      sampled: approved.length,
      labelled: approved.filter((entry) => latest.has(entry.slotId)).length,
      inspectable: approved.filter(inspectable).length,
    },
    labelRows: labelRows.count,
    maxRevision: labelRows.max_revision,
    auditors: auditorRows.map((row) => row.auditor),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cspHash(content: string): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("base64")}`;
}

const AUDIT_STYLE = `:root { color-scheme: light; --bg: #f4f5f7; --surface: #fff; --text: #1c2430; --muted: #55616f; --border: #cfd6df; --accent: #174f8a; --warn: #7a4b00; --warn-bg: #fdf0d5; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: "DejaVu Sans", "Segoe UI", Arial, sans-serif; line-height: 1.5; margin: 0; padding: 1.5rem; }
h1 { font-size: clamp(1.4rem, 4vw, 2rem); margin: 0 0 0.4rem; }
h2 { font-size: 1.05rem; margin: 0; overflow-wrap: anywhere; }
h3 { color: var(--muted); font-size: 0.82rem; letter-spacing: 0.03em; margin: 0.9rem 0 0.25rem; text-transform: uppercase; }
p, li, code, dt, dd { overflow-wrap: anywhere; }
code { background: #eef1f5; border-radius: 0.2rem; font-family: "DejaVu Sans Mono", monospace; font-size: 0.82em; padding: 0.05rem 0.25rem; }
header { margin: 0 auto 1rem; max-width: 1500px; }
.warning { background: var(--warn-bg); border: 1px solid #d9b25e; border-radius: 0.4rem; color: var(--warn); font-weight: 700; margin: 0.75rem 0; padding: 0.65rem 0.85rem; }
.meta { color: var(--muted); display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.9rem; margin: 0.4rem 0 0; }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 26rem), 1fr)); margin: 0 auto; max-width: 1500px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.55rem; min-width: 0; padding: 1rem; }
.slot { color: var(--muted); font-size: 0.82rem; font-weight: 400; margin-left: 0.4rem; }
.rules { display: grid; gap: 0.2rem 0.7rem; grid-template-columns: max-content 1fr; margin: 0; }
.rules dt { color: var(--muted); font-weight: 700; }
.rules dd { margin: 0; }
.list { margin: 0; padding-left: 1.2rem; }
.options { display: grid; gap: 0.3rem; list-style: none; margin: 0; padding: 0; }
.option { background: #eef1f5; border-radius: 0.3rem; padding: 0.35rem 0.5rem; }
.option-label { color: var(--accent); font-weight: 700; margin-right: 0.4rem; }
figure { margin: 0.75rem 0 0; }
img { background: #eef1f5; border: 1px solid var(--border); border-radius: 0.3rem; display: block; height: auto; max-width: 100%; }
.missing { background: #eef1f5; border: 1px dashed var(--border); border-radius: 0.3rem; color: var(--muted); padding: 0.65rem; }
.hash { color: var(--muted); font-size: 0.75rem; margin: 0.75rem 0 0; }
@media (max-width: 640px) { body { padding: 0.75rem; } .cards { grid-template-columns: minmax(0, 1fr); } .card { padding: 0.8rem; } .rules { grid-template-columns: 1fr; } .rules dd { margin-bottom: 0.3rem; } }`;

const FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function renderRules(rules: VisibleRules): string {
  const operations = rules.operations
    .map((operation) => `<li>${escapeHtml(operation)}</li>`)
    .join("");
  const conventions = rules.conventions
    .map((convention) => `<li>${escapeHtml(convention)}</li>`)
    .join("");
  return `<dl class="rules"><dt>Domain</dt><dd>${escapeHtml(
    rules.domain,
  )}</dd><dt>Closed world</dt><dd>${escapeHtml(
    rules.closedWorld,
  )}</dd><dt>Target</dt><dd>${escapeHtml(
    rules.target,
  )}</dd><dt>Operations</dt><dd><ul class="list">${operations}</ul></dd><dt>Conventions</dt><dd>${
    conventions === ""
      ? "No additional convention."
      : `<ul class="list">${conventions}</ul>`
  }</dd></dl>`;
}

function renderAuditCard(
  entry: AuditSampleEntry,
  candidate: CandidateExportRow,
  pngAvailable: boolean,
  svgAvailable: boolean,
): string {
  const visible = (candidate.presentation as {
    visible?: {
      question?: string;
      rules?: VisibleRules;
      clues?: Array<{ text: string }>;
      options?: Array<{ label: string; text: string }>;
    };
  } | null)?.visible;
  if (visible === undefined) {
    return `<article class="card" data-slot-id="${escapeHtml(
      entry.slotId,
    )}"><h2>${escapeHtml(entry.slotId)}<span class="slot">${escapeHtml(
      entry.family,
    )} / ${escapeHtml(entry.lane)}</span></h2><p class="missing">No public presentation was committed. This slot is sampled as not inspectable.</p></article>`;
  }
  const clues =
    visible.clues === undefined || visible.clues.length === 0
      ? `<p>No textual clues; observations are in the diagram.</p>`
      : `<ul class="list">${visible.clues
          .map((clue) => `<li>${escapeHtml(clue.text)}</li>`)
          .join("")}</ul>`;
  const options =
    visible.options === undefined
      ? ""
      : `<ol class="options">${visible.options
          .map(
            (option) =>
              `<li class="option"><span class="option-label">${escapeHtml(
                option.label,
              )}</span><span>${escapeHtml(option.text)}</span></li>`,
          )
          .join("")}</ol>`;
  const image =
    entry.modality === "text"
      ? ""
      : pngAvailable
        ? `<figure><img src="images/${escapeHtml(
            entry.slotId,
          )}.png" alt="Puzzle diagram for ${escapeHtml(
            entry.slotId,
          )}" loading="lazy" decoding="async">${
            svgAvailable
              ? `<p class="hash"><a href="images/${escapeHtml(
                  entry.slotId,
                )}.svg">Source SVG</a></p>`
              : ""
          }</figure>`
        : `<p class="missing">PNG preview is unavailable; inspect the text and report image readability as not inspectable.</p>`;
  return `<article class="card" data-slot-id="${escapeHtml(
    entry.slotId,
  )}"><h2>${escapeHtml(entry.slotId)}<span class="slot">${escapeHtml(
    entry.family,
  )} / ${escapeHtml(entry.lane)} / ${escapeHtml(
    entry.modality,
  )} / difficulty ${entry.difficulty}</span></h2><h3>Question</h3><p>${escapeHtml(
    visible.question ?? "No question recorded.",
  )}</p><h3>Rules</h3>${renderRules(
    visible.rules as VisibleRules,
  )}<h3>Clues</h3>${clues}${image}<h3>Options</h3>${options}<p class="hash">slot hash <code>${escapeHtml(
    entry.slotHash,
  )}</code></p></article>`;
}

export function renderAuditGallery(
  manifest: AuditSampleManifest,
  candidates: readonly CandidateExportRow[],
  imageAvailability: ReadonlyMap<string, { readonly png: boolean; readonly svg: boolean }>,
): string {
  const bySlot = new Map(candidates.map((candidate) => [candidate.slotId, candidate]));
  const entries = auditSampleEntries(manifest);
  const styleHash = cspHash(AUDIT_STYLE);
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "img-src 'self' data:",
    `style-src '${styleHash}'`,
    "script-src 'none'",
  ].join("; ");
  const labelFile = manifest.preview ? "preview-labels.csv" : "labels.csv";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<link rel="icon" href="${FAVICON}">
<title>Audit Sample - ${escapeHtml(manifest.runId)}</title>
<style>${AUDIT_STYLE}</style>
</head>
<body>
<header><h1>${manifest.preview ? "Audit Preview" : "Audit Sample"}</h1><p class="warning">${manifest.preview ? "READ-ONLY AUDIT PREVIEW" : "READ-ONLY AUDIT SAMPLE"} - pending human labels. Inspect the public presentation only; the answer key, proof, and automatic verdict are not shown. ${manifest.preview ? "This is a smoke preview and is not a production 40-slot audit." : "Fill the pending CSV offline; import it with npm run audit -- --import."}</p><p class="meta"><span>run <code>${escapeHtml(
    manifest.runId,
  )}</code></span><span>sample <code>${escapeHtml(
    manifest.sampleHash,
  )}</code></span><span>${entries.length} slots</span><span>core ${manifest.core.length}</span><span>additions ${manifest.categoryAdditions.length}</span><a href="${escapeHtml(
    labelFile,
  )}">Pending labels CSV</a></p></header>
<main class="cards">
${entries
  .map((entry) => {
    const candidate = bySlot.get(entry.slotId);
    const images = imageAvailability.get(entry.slotId) ?? {
      png: false,
      svg: false,
    };
    return candidate === undefined
      ? `<article class="card" data-slot-id="${escapeHtml(
          entry.slotId,
        )}"><h2>${escapeHtml(entry.slotId)}</h2><p class="missing">Candidate record unavailable.</p></article>`
      : renderAuditCard(entry, candidate, images.png, images.svg);
  })
  .join("\n")}
</main>
</body>
</html>
`;
}

function candidateImageHashes(candidate: CandidateExportRow): {
  png: string | null;
  svg: string | null;
} {
  const visible = (candidate.presentation as {
    visible?: { assets?: { pngHash?: string | null; svgHash?: string | null } };
  } | null)?.visible;
  return {
    png: visible?.assets?.pngHash ?? null,
    svg: visible?.assets?.svgHash ?? null,
  };
}

export interface AuditOutputPaths {
  readonly directory: string;
  readonly manifestPath: string;
  readonly labelsPath: string;
  readonly galleryPath: string;
  readonly imagesDirectory: string;
}

export function writeAuditOutputs(
  db: Database.Database,
  run: RunRecord,
  manifest: AuditSampleManifest,
  candidates: readonly CandidateExportRow[],
  outputRoot = "data/runs",
): AuditOutputPaths {
  const directory = join(resolveRunDirectory(run.runId, outputRoot), "audit");
  const imagesDirectory = join(directory, "images");
  mkdirSync(imagesDirectory, { recursive: true });
  const manifestPath = join(
    directory,
    manifest.preview ? "preview.json" : "sample.json",
  );
  const labelsPath = join(
    directory,
    manifest.preview ? "preview-labels.csv" : "labels.csv",
  );
  const galleryPath = join(
    directory,
    manifest.preview ? "preview-gallery.html" : "gallery.html",
  );
  const bySlot = new Map(candidates.map((candidate) => [candidate.slotId, candidate]));
  const imageAvailability = new Map<string, { png: boolean; svg: boolean }>();
  for (const entry of auditSampleEntries(manifest)) {
    const candidate = bySlot.get(entry.slotId);
    const hashes = candidate === undefined ? { png: null, svg: null } : candidateImageHashes(candidate);
    let png = false;
    let svg = false;
    if (hashes.png !== null) {
      try {
        const artifact = getArtifact(db, hashes.png, "png");
        writeAtomicFile(join(imagesDirectory, `${entry.slotId}.png`), artifact.bytes);
        png = true;
      } catch {
        png = false;
      }
    }
    if (hashes.svg !== null) {
      try {
        const artifact = getArtifact(db, hashes.svg, "svg");
        writeAtomicFile(join(imagesDirectory, `${entry.slotId}.svg`), artifact.bytes);
        svg = true;
      } catch {
        svg = false;
      }
    }
    imageAvailability.set(entry.slotId, { png, svg });
  }
  writeAtomicFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeAtomicFile(
    labelsPath,
    renderAuditLabelsCsv(pendingAuditLabelRows(manifest)),
  );
  writeAtomicFile(
    galleryPath,
    renderAuditGallery(manifest, candidates, imageAvailability),
  );
  return { directory, manifestPath, labelsPath, galleryPath, imagesDirectory };
}

export function loadAuditManifest(path: string): AuditSampleManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as AuditSampleManifest;
  validateManifest(parsed);
  return parsed;
}

export function sha256File(path: string): string {
  return sha256Hex(readFileSync(path).toString("utf8"));
}
