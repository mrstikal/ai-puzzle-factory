import { z } from "zod";
import { ChoiceLabelSchema } from "../domain/answers.js";
import {
  DifficultySchema,
  FamilySchema,
  ModalitySchema,
} from "../domain/experiment.js";
import {
  FactIdSchema,
  SolveResultSchema,
  mergeFactInventory,
  ruleFacts,
} from "../families/contracts.js";
import { productionRegistry } from "../families/registry.js";
import type {
  CalibrationFixture,
  CalibrationPack,
} from "./fixtures.js";
import {
  CALIBRATION_DEFECT_CODES,
  CALIBRATION_FIELDS,
  CALIBRATION_VARIANTS,
} from "./fixtures.js";
import { hashCanonicalJson } from "../util/hash.js";

export const MOCK_AUDITOR = "mock-test-only";

export const CALIBRATION_LABEL_COLUMNS = [
  "pack_hash",
  "fixture_id",
  "slot_id",
  "source_fixture_id",
  "family",
  "modality",
  "difficulty",
  "sound_or_defective",
  "seed",
  "content_hash",
  "png_hash",
  "svg_hash",
  "fixture_hash",
  "proposed_blind_result",
  "proposed_correct_label",
  "accepted_defect_codes",
  "proposed_alignment_result",
  "accepted_failing_fields",
  "accepted_fact_ids",
  "corruption_explanation",
  "observed_blind_result",
  "observed_correct_label",
  "observed_defect_codes",
  "observed_alignment_result",
  "observed_failing_fields",
  "observed_fact_ids",
  "provenance",
  "human_verified",
  "auditor",
  "auditor_time",
  "notes",
] as const;

export type CalibrationLabelColumn = (typeof CALIBRATION_LABEL_COLUMNS)[number];

export const CALIBRATION_LABEL_PROVENANCE = [
  "",
  "mock_test_only",
  "human",
] as const;
export type CalibrationLabelProvenance =
  (typeof CALIBRATION_LABEL_PROVENANCE)[number];

const BlindResultSchema = z.enum(["correct", "defect", "no_unique"]);
const AlignmentResultSchema = z.enum(["pass", "fail"]);
const DefectCodeSchema = z.enum(CALIBRATION_DEFECT_CODES);
const FieldSchema = z.enum(CALIBRATION_FIELDS);

export const CalibrationLabelRowSchema = z.strictObject({
  packHash: z.string().regex(/^[0-9a-f]{64}$/),
  fixtureId: z.string().regex(/^cal-[a-z]+-\d{2}$/),
  slotId: z.string().min(1).max(80),
  sourceFixtureId: z.string().regex(/^cal-[a-z]+-\d{2}$/).nullable(),
  family: FamilySchema,
  modality: ModalitySchema,
  difficulty: DifficultySchema,
  soundOrDefective: z.enum(CALIBRATION_VARIANTS),
  seed: z.string().regex(/^[0-9a-f]{64}$/),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  pngHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  svgHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  fixtureHash: z.string().regex(/^[0-9a-f]{64}$/),
  proposedBlindResult: BlindResultSchema,
  proposedCorrectLabel: ChoiceLabelSchema.nullable(),
  acceptedDefectCodes: z.array(DefectCodeSchema),
  proposedAlignmentResult: AlignmentResultSchema,
  acceptedFailingFields: z.array(FieldSchema),
  acceptedFactIds: z.array(FactIdSchema),
  corruptionExplanation: z.string().max(1000),
  observedBlindResult: z.union([BlindResultSchema, z.literal("")]),
  observedCorrectLabel: ChoiceLabelSchema.nullable(),
  observedDefectCodes: z.array(DefectCodeSchema),
  observedAlignmentResult: z.union([AlignmentResultSchema, z.literal("")]),
  observedFailingFields: z.array(FieldSchema),
  observedFactIds: z.array(FactIdSchema),
  provenance: z.enum(CALIBRATION_LABEL_PROVENANCE),
  humanVerified: z.boolean(),
  auditor: z.string().max(200),
  auditorTime: z.string().max(40),
  notes: z.string().max(1000),
});

export type CalibrationLabelRow = z.infer<typeof CalibrationLabelRowSchema>;

export interface CalibrationLabels {
  readonly packHash: string;
  readonly rows: readonly CalibrationLabelRow[];
}

export class CalibrationLabelError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "CalibrationLabelError";
  }
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

function list(value: string): string[] {
  return value === "" ? [] : value.split(";").filter((item) => item !== "");
}

function nullable(value: string): string | null {
  return value === "" ? null : value;
}

function rowFromCells(cells: readonly string[]): CalibrationLabelRow {
  if (cells.length !== CALIBRATION_LABEL_COLUMNS.length) {
    throw new CalibrationLabelError(
      "INVALID_LABELS",
      `label row has ${cells.length} cells; expected ${CALIBRATION_LABEL_COLUMNS.length}`,
    );
  }
  const values = Object.fromEntries(
    CALIBRATION_LABEL_COLUMNS.map((column, index) => [column, cells[index] ?? ""]),
  ) as Record<CalibrationLabelColumn, string>;
  return CalibrationLabelRowSchema.parse({
    packHash: values.pack_hash,
    fixtureId: values.fixture_id,
    slotId: values.slot_id,
    sourceFixtureId: nullable(values.source_fixture_id),
    family: values.family,
    modality: values.modality,
    difficulty: Number(values.difficulty),
    soundOrDefective: values.sound_or_defective,
    seed: values.seed,
    contentHash: values.content_hash,
    pngHash: nullable(values.png_hash),
    svgHash: nullable(values.svg_hash),
    fixtureHash: values.fixture_hash,
    proposedBlindResult: values.proposed_blind_result,
    proposedCorrectLabel: nullable(values.proposed_correct_label),
    acceptedDefectCodes: list(values.accepted_defect_codes),
    proposedAlignmentResult: values.proposed_alignment_result,
    acceptedFailingFields: list(values.accepted_failing_fields),
    acceptedFactIds: list(values.accepted_fact_ids),
    corruptionExplanation: values.corruption_explanation,
    observedBlindResult: values.observed_blind_result,
    observedCorrectLabel: nullable(values.observed_correct_label),
    observedDefectCodes: list(values.observed_defect_codes),
    observedAlignmentResult: values.observed_alignment_result,
    observedFailingFields: list(values.observed_failing_fields),
    observedFactIds: list(values.observed_fact_ids),
    provenance: values.provenance,
    humanVerified: values.human_verified === "true",
    auditor: values.auditor,
    auditorTime: values.auditor_time,
    notes: values.notes,
  });
}

export function parseCalibrationLabelsCsv(text: string): CalibrationLabels {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) {
    throw new CalibrationLabelError("INVALID_LABELS", "label CSV is empty");
  }
  if (
    header.length !== CALIBRATION_LABEL_COLUMNS.length ||
    header.some((column, index) => column !== CALIBRATION_LABEL_COLUMNS[index])
  ) {
    throw new CalibrationLabelError(
      "INVALID_LABELS",
      "label CSV header does not match the P41 column contract",
    );
  }
  const parsed = rows.slice(1).map(rowFromCells);
  const packHashes = new Set(parsed.map((row) => row.packHash));
  if (packHashes.size !== 1) {
    throw new CalibrationLabelError(
      "INVALID_LABELS",
      "all label rows must reference the same pack hash",
    );
  }
  return { packHash: parsed[0]?.packHash ?? "", rows: parsed };
}

function labelRow(
  packHash: string,
  fixture: CalibrationFixture,
  observed: boolean,
): CalibrationLabelRow {
  return CalibrationLabelRowSchema.parse({
    packHash,
    fixtureId: fixture.fixtureId,
    slotId: fixture.slotId,
    sourceFixtureId: fixture.sourceFixtureId,
    family: fixture.family,
    modality: fixture.modality,
    difficulty: fixture.difficulty,
    soundOrDefective: fixture.variant,
    seed: fixture.seed,
    contentHash: fixture.contentHash,
    pngHash: fixture.pngHash,
    svgHash: fixture.svgHash,
    fixtureHash: fixture.fixtureHash,
    proposedBlindResult: fixture.expected.blind.result,
    proposedCorrectLabel: fixture.expected.blind.correctLabel,
    acceptedDefectCodes: fixture.expected.blind.acceptedDefectCodes,
    proposedAlignmentResult: fixture.expected.alignment.result,
    acceptedFailingFields: fixture.expected.alignment.acceptedFailingFields,
    acceptedFactIds: fixture.expected.alignment.acceptedFactIds,
    corruptionExplanation: fixture.mutation?.description ?? "",
    observedBlindResult: observed ? fixture.expected.blind.result : "",
    observedCorrectLabel: observed ? fixture.expected.blind.correctLabel : null,
    observedDefectCodes: observed ? fixture.expected.blind.acceptedDefectCodes : [],
    observedAlignmentResult: observed ? fixture.expected.alignment.result : "",
    observedFailingFields: observed ? fixture.expected.alignment.acceptedFailingFields : [],
    observedFactIds: observed ? fixture.expected.alignment.acceptedFactIds : [],
    provenance: "",
    humanVerified: false,
    auditor: "",
    auditorTime: "",
    notes: "",
  });
}

export function pendingLabelRows(pack: CalibrationPack): CalibrationLabelRow[] {
  return pack.fixtures.map((fixture) => labelRow(pack.packHash, fixture, false));
}

export function mockLabelRows(
  pack: CalibrationPack,
  options: {
    readonly auditorTime: string;
    readonly notes?: string;
  },
): CalibrationLabelRow[] {
  return pack.fixtures.map((fixture) =>
    CalibrationLabelRowSchema.parse({
      ...labelRow(pack.packHash, fixture, true),
      provenance: "mock_test_only",
      humanVerified: true,
      auditor: MOCK_AUDITOR,
      auditorTime: options.auditorTime,
      notes: options.notes ?? "Mock/test-only labels; not human evidence.",
    }),
  );
}

export function acceptProposedLabels(
  labels: CalibrationLabels,
  options: {
    readonly auditor: string;
    readonly auditorTime: string;
    readonly notes?: string;
  },
): CalibrationLabels {
  const unreviewed = labels.rows.filter(
    (row) => row.observedBlindResult === "",
  );
  if (unreviewed.length > 0) {
    throw new CalibrationLabelError(
      "UNREVIEWED_LABELS",
      `human review is missing observed_blind_result for: ${unreviewed
        .map((row) => row.fixtureId)
        .join(", ")}`,
    );
  }
  const rows = labels.rows.map((row) =>
    CalibrationLabelRowSchema.parse({
      ...row,
      observedBlindResult: row.observedBlindResult,
      observedCorrectLabel:
        row.observedBlindResult === "correct"
          ? row.observedCorrectLabel ?? row.proposedCorrectLabel
          : row.observedCorrectLabel,
      observedDefectCodes:
        row.observedBlindResult === "correct"
          ? row.observedDefectCodes
          : row.observedDefectCodes.length === 0
            ? row.acceptedDefectCodes
            : row.observedDefectCodes,
      observedAlignmentResult:
        row.observedAlignmentResult === ""
          ? row.proposedAlignmentResult
          : row.observedAlignmentResult,
      observedFailingFields:
        row.observedFailingFields.length === 0
          ? row.acceptedFailingFields
          : row.observedFailingFields,
      observedFactIds:
        row.observedFactIds.length === 0
          ? row.acceptedFactIds
          : row.observedFactIds,
      provenance: "human",
      humanVerified: true,
      auditor: options.auditor,
      auditorTime:
        row.auditorTime === "" ? options.auditorTime : row.auditorTime,
      notes:
        row.notes === ""
          ? options.notes ??
            "Accepted proposed labels after human review of observed_blind_result."
          : row.notes,
    }),
  );
  return { packHash: labels.packHash, rows };
}

export function calibrationLabelsHash(labels: CalibrationLabels): string {
  return hashCanonicalJson(labels.rows);
}

export function renderCalibrationLabelsCsv(
  rows: readonly CalibrationLabelRow[],
): string {
  const values = rows.map((row) => [
    row.packHash,
    row.fixtureId,
    row.slotId,
    row.sourceFixtureId ?? "",
    row.family,
    row.modality,
    String(row.difficulty),
    row.soundOrDefective,
    row.seed,
    row.contentHash,
    row.pngHash ?? "",
    row.svgHash ?? "",
    row.fixtureHash,
    row.proposedBlindResult,
    row.proposedCorrectLabel ?? "",
    row.acceptedDefectCodes.join(";"),
    row.proposedAlignmentResult,
    row.acceptedFailingFields.join(";"),
    row.acceptedFactIds.join(";"),
    row.corruptionExplanation,
    row.observedBlindResult,
    row.observedCorrectLabel ?? "",
    row.observedDefectCodes.join(";"),
    row.observedAlignmentResult,
    row.observedFailingFields.join(";"),
    row.observedFactIds.join(";"),
    row.provenance,
    String(row.humanVerified),
    row.auditor,
    row.auditorTime,
    row.notes,
  ]);
  return `${[CALIBRATION_LABEL_COLUMNS as unknown as string[], ...values]
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\n")}\n`;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftSet = new Set(left);
  return leftSet.size === right.length && right.every((value) => leftSet.has(value));
}

function fixtureFactIds(fixture: CalibrationFixture): Set<string> {
  const engine = productionRegistry.getEngine(fixture.family);
  const spec = engine.schema.parse(fixture.original.spec);
  const solve = SolveResultSchema.parse(fixture.original.solveResult);
  if (solve.proof === null) {
    throw new CalibrationLabelError(
      "INVALID_PACK",
      `${fixture.fixtureId} has no proof inventory`,
    );
  }
  return new Set(
    mergeFactInventory(
      ruleFacts(engine.visibleRules(spec)),
      engine.facts(spec),
      solve.proof.facts,
    ).map((fact) => fact.factId),
  );
}

function validateObserved(row: CalibrationLabelRow, factIds: ReadonlySet<string>): void {
  if (row.observedBlindResult === "") {
    throw new CalibrationLabelError(
      "INCOMPLETE_LABEL",
      `${row.fixtureId} has no observed blind result`,
    );
  }
  if (row.observedBlindResult === "correct") {
    if (row.observedCorrectLabel === null || row.observedDefectCodes.length > 0) {
      throw new CalibrationLabelError(
        "INCOMPLETE_LABEL",
        `${row.fixtureId} correct blind result requires a label and no defect codes`,
      );
    }
  } else if (
    row.observedCorrectLabel !== null ||
    row.observedDefectCodes.length === 0
  ) {
    throw new CalibrationLabelError(
      "INCOMPLETE_LABEL",
      `${row.fixtureId} defective blind result requires no correct label and accepted defect codes`,
    );
  }
  if (row.observedAlignmentResult === "") {
    throw new CalibrationLabelError(
      "INCOMPLETE_LABEL",
      `${row.fixtureId} has no observed alignment result`,
    );
  }
  if (row.observedAlignmentResult === "pass") {
    if (row.observedFailingFields.length > 0 || row.observedFactIds.length > 0) {
      throw new CalibrationLabelError(
        "INCOMPLETE_LABEL",
        `${row.fixtureId} passing alignment must not list failing fields`,
      );
    }
  } else if (row.observedFailingFields.length === 0) {
    throw new CalibrationLabelError(
      "INCOMPLETE_LABEL",
      `${row.fixtureId} failing alignment requires at least one field`,
    );
  }
  for (const factId of row.observedFactIds) {
    if (!factIds.has(factId)) {
      throw new CalibrationLabelError(
        "INVALID_LABEL_FACT",
        `${row.fixtureId} cites fact ${factId} outside the fixture inventory`,
      );
    }
  }
}

export interface ValidateCalibrationLabelsInput {
  readonly labels: CalibrationLabels;
  readonly pack: CalibrationPack;
  readonly mode: "mock" | "verify";
  readonly auditor?: string;
  readonly clock?: { now(): Date };
}

export function validateCalibrationLabels(
  input: ValidateCalibrationLabelsInput,
): void {
  const { labels, pack, mode } = input;
  if (labels.packHash !== pack.packHash) {
    throw new CalibrationLabelError(
      "PACK_MISMATCH",
      `labels reference pack ${labels.packHash}, current pack is ${pack.packHash}`,
    );
  }
  if (labels.rows.length !== 40) {
    throw new CalibrationLabelError(
      "INCOMPLETE_LABELS",
      `expected 40 label rows, received ${labels.rows.length}`,
    );
  }
  if (new Set(labels.rows.map((row) => row.fixtureId)).size !== 40) {
    throw new CalibrationLabelError(
      "INVALID_LABELS",
      "label fixture IDs must be unique",
    );
  }
  const fixtureById = new Map(
    pack.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );
  const now = (input.clock ?? { now: () => new Date() }).now();
  for (const row of labels.rows) {
    const fixture = fixtureById.get(row.fixtureId);
    if (fixture === undefined) {
      throw new CalibrationLabelError(
        "UNKNOWN_FIXTURE",
        `label references unknown fixture ${row.fixtureId}`,
      );
    }
    if (
      row.packHash !== pack.packHash ||
      row.slotId !== fixture.slotId ||
      row.sourceFixtureId !== fixture.sourceFixtureId ||
      row.family !== fixture.family ||
      row.modality !== fixture.modality ||
      row.difficulty !== fixture.difficulty ||
      row.soundOrDefective !== fixture.variant ||
      row.seed !== fixture.seed ||
      row.contentHash !== fixture.contentHash ||
      row.pngHash !== fixture.pngHash ||
      row.svgHash !== fixture.svgHash ||
      row.fixtureHash !== fixture.fixtureHash
    ) {
      throw new CalibrationLabelError(
        "FIXTURE_MISMATCH",
        `${row.fixtureId} label metadata does not match the pack fixture`,
      );
    }
    if (
      row.proposedBlindResult !== fixture.expected.blind.result ||
      row.proposedCorrectLabel !== fixture.expected.blind.correctLabel ||
      !sameSet(row.acceptedDefectCodes, fixture.expected.blind.acceptedDefectCodes) ||
      row.proposedAlignmentResult !== fixture.expected.alignment.result ||
      !sameSet(row.acceptedFailingFields, fixture.expected.alignment.acceptedFailingFields) ||
      !sameSet(row.acceptedFactIds, fixture.expected.alignment.acceptedFactIds) ||
      row.corruptionExplanation !== (fixture.mutation?.description ?? "")
    ) {
      throw new CalibrationLabelError(
        "PROPOSED_LABEL_MISMATCH",
        `${row.fixtureId} proposed labels do not match the pack ground truth`,
      );
    }
    const auditor = row.auditor.trim();
    if (auditor === "" || hasControlCharacters(auditor)) {
      throw new CalibrationLabelError(
        "INVALID_AUDITOR",
        `${row.fixtureId} has no valid auditor identity`,
      );
    }
    const time = Date.parse(row.auditorTime);
    if (!Number.isFinite(time)) {
      throw new CalibrationLabelError(
        "INVALID_AUDITOR_TIME",
        `${row.fixtureId} has no valid auditor time`,
      );
    }
    if (time > now.getTime() + 5 * 60 * 1000) {
      throw new CalibrationLabelError(
        "INVALID_AUDITOR_TIME",
        `${row.fixtureId} auditor time is in the future`,
      );
    }
    if (!row.humanVerified) {
      throw new CalibrationLabelError(
        "UNVERIFIED_LABEL",
        `${row.fixtureId} is not human-verified`,
      );
    }
    if (mode === "mock") {
      if (row.provenance !== "mock_test_only" || auditor !== MOCK_AUDITOR) {
        throw new CalibrationLabelError(
          "MOCK_LABEL_REQUIRED",
          "mock calibration requires mock_test_only labels with the mock-test-only auditor",
        );
      }
    } else {
      if (row.provenance !== "human") {
        throw new CalibrationLabelError(
          "HUMAN_LABEL_REQUIRED",
          "--verify-labels requires human provenance",
        );
      }
      if (input.auditor === undefined || auditor !== input.auditor.trim()) {
        throw new CalibrationLabelError(
          "AUDITOR_MISMATCH",
          `${row.fixtureId} auditor does not match --auditor`,
        );
      }
    }
    const factIds = fixtureFactIds(fixture);
    for (const factId of row.acceptedFactIds) {
      if (!factIds.has(factId)) {
        throw new CalibrationLabelError(
          "INVALID_LABEL_FACT",
          `${row.fixtureId} accepts fact ${factId} outside the fixture inventory`,
        );
      }
    }
    validateObserved(row, factIds);
    if (
      row.observedBlindResult !== row.proposedBlindResult ||
      row.observedCorrectLabel !== row.proposedCorrectLabel ||
      !sameSet(row.observedDefectCodes, row.acceptedDefectCodes) ||
      row.observedAlignmentResult !== row.proposedAlignmentResult ||
      !sameSet(row.observedFailingFields, row.acceptedFailingFields) ||
      !sameSet(row.observedFactIds, row.acceptedFactIds)
    ) {
      throw new CalibrationLabelError(
        "LABEL_MISMATCH",
        `${row.fixtureId} human observation disagrees with the pack; correct P40 and create a new pack hash`,
      );
    }
  }
  if (
    mode === "verify" &&
    (input.auditor === undefined || input.auditor.trim() === "")
  ) {
    throw new CalibrationLabelError(
      "INVALID_AUDITOR",
      "--verify-labels requires --auditor",
    );
  }
}
