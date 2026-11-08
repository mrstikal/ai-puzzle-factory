import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DESIGN_EVALUATION_RUBRIC,
  renderDesignEvaluationRevealGallery,
  renderDesignEvaluationSolveGallery,
  type DesignEvaluationSample,
} from "./design-sample.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import type { DesignerHumanEvaluationSummary } from "../reporting/design-decision.js";
import { withTransaction } from "../storage/database.js";

export const DESIGN_EVALUATION_LABEL_HEADER = [
  "sample_hash",
  "unit_key",
  "unit_type",
  "triplet_id",
  "evaluation_id",
  "paired_vs",
  "paired_metric",
  "revision",
  "previous_revision",
  "auditor",
  "recorded_at",
  "pre_reveal",
  "synthetic",
  "correct",
  "clarity",
  "interest",
  "difficulty",
  "solve_time",
  "preference",
  "reason",
  "defect_notes",
  "content_hash",
] as const;

export const DESIGN_EVALUATION_SOLVE_TIMES = [
  "<=60s",
  "61-180s",
  ">180s",
  "not_solved",
  "not_inspectable",
] as const;

export const DesignEvaluationLabelRowSchema = z.strictObject({
  sample_hash: z.string().regex(/^[0-9a-f]{64}$/),
  unit_key: z.string().min(1).max(300),
  unit_type: z.enum(["member_pre", "member_post", "pairwise"]),
  triplet_id: z.string().regex(/^triplet-\d{2}$/).nullable(),
  evaluation_id: z.string().regex(/^ev-[0-9a-f]{24}$/),
  paired_vs: z.string().regex(/^ev-[0-9a-f]{24}$/).nullable(),
  paired_metric: z.enum(["interest", "clarity", "difficulty"]).nullable(),
  revision: z.number().int().positive(),
  previous_revision: z.number().int().positive().nullable(),
  auditor: z.string().min(1).max(200),
  recorded_at: z.iso.datetime(),
  pre_reveal: z.boolean(),
  synthetic: z.boolean(),
  correct: z.boolean().nullable(),
  clarity: z.number().int().min(1).max(5).nullable(),
  interest: z.number().int().min(1).max(5).nullable(),
  difficulty: z.number().int().min(1).max(5).nullable(),
  solve_time: z.enum(DESIGN_EVALUATION_SOLVE_TIMES).nullable(),
  preference: z.enum(["left", "right", "tie"]).nullable(),
  reason: z.string().max(2_000),
  defect_notes: z.string().max(2_000),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignEvaluationLabelRow = z.infer<
  typeof DesignEvaluationLabelRowSchema
>;

export type DesignEvaluationLabelRowInput = Omit<
  DesignEvaluationLabelRow,
  "content_hash"
>;

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return csvEscape(String(value));
}

export function computeDesignEvaluationLabelContentHash(
  row: DesignEvaluationLabelRowInput,
): string {
  return sha256Hex(canonicalJson(row));
}

export function buildDesignEvaluationLabelsCsv(
  sample: DesignEvaluationSample,
  options: { readonly syntheticTestOnly?: boolean } = {},
): string {
  const lines: string[] = [];
  if (options.syntheticTestOnly === true) {
    lines.push("# synthetic_test_only=true");
  }
  lines.push(DESIGN_EVALUATION_LABEL_HEADER.join(","));
  const empty = (row: Partial<Record<(typeof DESIGN_EVALUATION_LABEL_HEADER)[number], unknown>>) =>
    DESIGN_EVALUATION_LABEL_HEADER.map((column) =>
      csvValue(row[column] ?? ""),
    ).join(",");
  const privateTripletById = new Map(
    sample.privateBundle.triplets.map((triplet) => [triplet.tripletId, triplet]),
  );
  for (const evaluationId of sample.publicBundle.additions) {
    lines.push(
      empty({
        sample_hash: sample.sampleHash,
        unit_key: `member_pre:${evaluationId}`,
        unit_type: "member_pre",
        triplet_id: "",
        evaluation_id: evaluationId,
        pre_reveal: true,
        synthetic: options.syntheticTestOnly === true ? true : "",
      }),
    );
    lines.push(
      empty({
        sample_hash: sample.sampleHash,
        unit_key: `member_post:${evaluationId}`,
        unit_type: "member_post",
        triplet_id: "",
        evaluation_id: evaluationId,
        pre_reveal: false,
        synthetic: options.syntheticTestOnly === true ? true : "",
      }),
    );
  }
  for (const triplet of sample.publicBundle.triplets) {
    const privateTriplet = privateTripletById.get(triplet.tripletId);
    if (privateTriplet === undefined) {
      throw new Error(`missing private triplet ${triplet.tripletId}`);
    }
    for (const evaluationId of triplet.memberIds) {
      lines.push(
        empty({
          sample_hash: sample.sampleHash,
          unit_key: `member_pre:${evaluationId}`,
          unit_type: "member_pre",
          triplet_id: triplet.tripletId,
          evaluation_id: evaluationId,
          pre_reveal: true,
          synthetic: options.syntheticTestOnly === true ? true : "",
        }),
      );
      lines.push(
        empty({
          sample_hash: sample.sampleHash,
          unit_key: `member_post:${evaluationId}`,
          unit_type: "member_post",
          triplet_id: triplet.tripletId,
          evaluation_id: evaluationId,
          pre_reveal: false,
          synthetic: options.syntheticTestOnly === true ? true : "",
        }),
      );
    }
    for (let left = 0; left < triplet.memberIds.length; left += 1) {
      for (let right = left + 1; right < triplet.memberIds.length; right += 1) {
        for (const metric of ["interest", "clarity", "difficulty"] as const) {
          lines.push(
            empty({
              sample_hash: sample.sampleHash,
              unit_key: `pairwise:${triplet.tripletId}:${triplet.memberIds[left]}:${triplet.memberIds[right]}:${metric}`,
              unit_type: "pairwise",
              triplet_id: triplet.tripletId,
              evaluation_id: triplet.memberIds[left],
              paired_vs: triplet.memberIds[right],
              paired_metric: metric,
              pre_reveal: true,
              synthetic: options.syntheticTestOnly === true ? true : "",
            }),
          );
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("design evaluation CSV is empty");
  }
  const header = parseCsvLine(lines[0] as string);
  if (canonicalJson(header) !== canonicalJson([...DESIGN_EVALUATION_LABEL_HEADER])) {
    throw new Error("design evaluation CSV header does not match the fixed schema");
  }
  return lines.slice(1).map((line, index) => {
    const cells = parseCsvLine(line);
    if (cells.length !== header.length) {
      throw new Error(
        `design evaluation CSV row ${index + 2} has ${cells.length} cells, expected ${header.length}`,
      );
    }
    return Object.fromEntries(
      header.map((column, columnIndex) => [column, cells[columnIndex] ?? ""]),
    );
  });
}

function nullableString(value: string): string | null {
  return value === "" ? null : value;
}

function nullableInt(value: string, name: string): number | null {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function nullableBoolean(value: string, name: string): boolean | null {
  if (value === "") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export interface ParsedDesignEvaluationLabels {
  readonly rows: readonly DesignEvaluationLabelRow[];
  readonly synthetic: boolean;
}

export function parseDesignEvaluationLabelsCsv(input: {
  readonly text: string;
  readonly sample: DesignEvaluationSample;
  readonly syntheticTestOnly: boolean;
  readonly now: Date;
}): ParsedDesignEvaluationLabels {
  const rawRows = parseCsv(input.text);
  if (rawRows.length === 0) {
    throw new Error("design evaluation CSV has no data rows");
  }
  const unitKeys = new Set<string>();
  const additionIds = new Set(input.sample.publicBundle.additions);
  const privateTripletById = new Map(
    input.sample.privateBundle.triplets.map((triplet) => [triplet.tripletId, triplet]),
  );
  for (const evaluationId of additionIds) {
    unitKeys.add(`member_pre:${evaluationId}`);
    unitKeys.add(`member_post:${evaluationId}`);
  }
  for (const triplet of input.sample.publicBundle.triplets) {
    for (const evaluationId of triplet.memberIds) {
      unitKeys.add(`member_pre:${evaluationId}`);
      unitKeys.add(`member_post:${evaluationId}`);
    }
    for (let left = 0; left < triplet.memberIds.length; left += 1) {
      for (let right = left + 1; right < triplet.memberIds.length; right += 1) {
        for (const metric of ["interest", "clarity", "difficulty"] as const) {
          unitKeys.add(
            `pairwise:${triplet.tripletId}:${triplet.memberIds[left]}:${triplet.memberIds[right]}:${metric}`,
          );
        }
      }
    }
  }
  const rows = rawRows.map((raw, index) => {
    const lineNumber = index + 2;
    const sampleHash = raw.sample_hash ?? "";
    if (sampleHash !== input.sample.sampleHash) {
      throw new Error(
        `row ${lineNumber} sample hash does not match the prepared sample`,
      );
    }
    const unitKey = raw.unit_key ?? "";
    if (!unitKeys.has(unitKey)) {
      throw new Error(`row ${lineNumber} unit key is not in the prepared sample`);
    }
    const unitType = raw.unit_type as DesignEvaluationLabelRow["unit_type"];
    const tripletId = nullableString(raw.triplet_id ?? "");
    const evaluationId = raw.evaluation_id ?? "";
    const privateTriplet =
      tripletId === null ? undefined : privateTripletById.get(tripletId);
    if (tripletId === null) {
      if (unitType === "pairwise") {
        throw new Error(`row ${lineNumber} pairwise rows require a triplet`);
      }
      if (!additionIds.has(evaluationId)) {
        throw new Error(`row ${lineNumber} addition evaluation ID is not in the sample`);
      }
    } else {
      if (privateTriplet === undefined) {
        throw new Error(`row ${lineNumber} unknown triplet ${tripletId}`);
      }
      if (!privateTriplet.memberIds.includes(evaluationId)) {
        throw new Error(`row ${lineNumber} evaluation ID is not in triplet ${tripletId}`);
      }
    }
    const preReveal = nullableBoolean(raw.pre_reveal ?? "", "pre_reveal");
    const expectedPreReveal = unitType !== "member_post";
    if (preReveal !== expectedPreReveal) {
      throw new Error(
        `row ${lineNumber} pre_reveal must be ${expectedPreReveal} for ${unitType}`,
      );
    }
    const synthetic = nullableBoolean(raw.synthetic ?? "", "synthetic");
    if (synthetic === null) {
      throw new Error(`row ${lineNumber} synthetic must be explicit`);
    }
    if (input.syntheticTestOnly && synthetic !== true) {
      throw new Error(`row ${lineNumber} must be marked synthetic in test-only mode`);
    }
    if (!input.syntheticTestOnly && synthetic !== false) {
      throw new Error(`row ${lineNumber} genuine labels must set synthetic=false`);
    }
    const auditor = raw.auditor ?? "";
    if (auditor.trim() === "") {
      throw new Error(`row ${lineNumber} missing auditor identity`);
    }
    const recordedAt = raw.recorded_at ?? "";
    if (!z.iso.datetime().safeParse(recordedAt).success) {
      throw new Error(`row ${lineNumber} recorded_at is not an ISO timestamp`);
    }
    if (Date.parse(recordedAt) > input.now.getTime() + 5 * 60_000) {
      throw new Error(`row ${lineNumber} recorded_at is in the future`);
    }
    const revision = nullableInt(raw.revision ?? "", "revision");
    if (revision === null || revision < 1) {
      throw new Error(`row ${lineNumber} revision must be a positive integer`);
    }
    const previousRevision = nullableInt(
      raw.previous_revision ?? "",
      "previous_revision",
    );
    if (revision > 1 && previousRevision !== revision - 1) {
      throw new Error(
        `row ${lineNumber} previous_revision must be ${revision - 1}`,
      );
    }
    if (revision === 1 && previousRevision !== null) {
      throw new Error(`row ${lineNumber} first revision must not have a previous revision`);
    }
    const pairedVs = nullableString(raw.paired_vs ?? "");
    const pairedMetric = nullableString(raw.paired_metric ?? "") as
      | DesignEvaluationLabelRow["paired_metric"];
    const correct = nullableBoolean(raw.correct ?? "", "correct");
    const clarity = nullableInt(raw.clarity ?? "", "clarity");
    const interest = nullableInt(raw.interest ?? "", "interest");
    const difficulty = nullableInt(raw.difficulty ?? "", "difficulty");
    const solveTime = nullableString(raw.solve_time ?? "");
    const preference = nullableString(raw.preference ?? "") as
      | DesignEvaluationLabelRow["preference"];
    for (const [name, value] of [
      ["clarity", clarity],
      ["interest", interest],
      ["difficulty", difficulty],
    ] as const) {
      if (value !== null && (value < 1 || value > 5)) {
        throw new Error(`row ${lineNumber} ${name} must be 1..5`);
      }
    }
    if (solveTime !== null && !DESIGN_EVALUATION_SOLVE_TIMES.includes(solveTime as never)) {
      throw new Error(`row ${lineNumber} solve_time is not in the fixed categories`);
    }
    if (unitType === "member_pre") {
      if (clarity === null || interest === null || difficulty === null || solveTime === null) {
        throw new Error(
          `row ${lineNumber} member_pre requires clarity, interest, difficulty, and solve_time`,
        );
      }
      if (correct !== null || preference !== null || pairedVs !== null) {
        throw new Error(`row ${lineNumber} member_pre cannot include post-reveal or pairwise fields`);
      }
    } else if (unitType === "member_post") {
      if (correct === null) {
        throw new Error(`row ${lineNumber} member_post requires correctness`);
      }
      if (clarity !== null || interest !== null || difficulty !== null || solveTime !== null) {
        throw new Error(`row ${lineNumber} member_post cannot include pre-reveal ratings`);
      }
      if (preference !== null || pairedVs !== null) {
        throw new Error(`row ${lineNumber} member_post cannot include pairwise fields`);
      }
    } else {
      if (preference === null) {
        throw new Error(`row ${lineNumber} pairwise requires a preference`);
      }
      if (
        privateTriplet === undefined ||
        pairedVs === null ||
        !privateTriplet.memberIds.includes(pairedVs)
      ) {
        throw new Error(`row ${lineNumber} pairwise target is not in the triplet`);
      }
      if (
        pairedMetric === null ||
        !["interest", "clarity", "difficulty"].includes(pairedMetric)
      ) {
        throw new Error(`row ${lineNumber} pairwise metric is invalid`);
      }
      if (correct !== null || clarity !== null || interest !== null || difficulty !== null || solveTime !== null) {
        throw new Error(`row ${lineNumber} pairwise cannot include member ratings`);
      }
    }
    const body: DesignEvaluationLabelRowInput = {
      sample_hash: sampleHash,
      unit_key: unitKey,
      unit_type: unitType,
      triplet_id: tripletId,
      evaluation_id: evaluationId,
      paired_vs: pairedVs,
      paired_metric: pairedMetric,
      revision,
      previous_revision: previousRevision,
      auditor,
      recorded_at: recordedAt,
      pre_reveal: preReveal ?? expectedPreReveal,
      synthetic,
      correct,
      clarity,
      interest,
      difficulty,
      solve_time: solveTime as DesignEvaluationLabelRow["solve_time"],
      preference,
      reason: raw.reason ?? "",
      defect_notes: raw.defect_notes ?? "",
    };
    const contentHash = computeDesignEvaluationLabelContentHash(body);
    if (raw.content_hash !== undefined && raw.content_hash !== "" && raw.content_hash !== contentHash) {
      throw new Error(`row ${lineNumber} content hash mismatch`);
    }
    return DesignEvaluationLabelRowSchema.parse({
      ...body,
      content_hash: contentHash,
    });
  });
  return {
    rows,
    synthetic: rows.every((row) => row.synthetic),
  };
}

export function importDesignEvaluationRows(
  db: Database.Database,
  sample: DesignEvaluationSample,
  rows: readonly DesignEvaluationLabelRow[],
): { readonly inserted: number } {
  const sampleRow = db
    .prepare("SELECT 1 AS present FROM design_evaluation_samples WHERE sample_hash = ?")
    .get(sample.sampleHash);
  if (sampleRow === undefined) {
    throw new Error("design evaluation sample is not stored; run --prepare first");
  }
  let inserted = 0;
  withTransaction(db, () => {
    for (const row of rows) {
      const latest = db
        .prepare(
          "SELECT revision FROM design_evaluations WHERE sample_hash = ? AND unit_key = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(sample.sampleHash, row.unit_key) as
        | { revision: number }
        | undefined;
      const expectedRevision = (latest?.revision ?? 0) + 1;
      if (row.revision !== expectedRevision) {
        throw new Error(
          `label revision for ${row.unit_key} must be ${expectedRevision}, received ${row.revision}`,
        );
      }
      if (
        (expectedRevision === 1 && row.previous_revision !== null) ||
        (expectedRevision > 1 && row.previous_revision !== expectedRevision - 1)
      ) {
        throw new Error(`label previous revision for ${row.unit_key} is inconsistent`);
      }
      const payload = canonicalJson(row);
      db.prepare(
        "INSERT INTO design_evaluations (evaluation_id, sample_hash, unit_key, revision, previous_revision, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(),
        sample.sampleHash,
        row.unit_key,
        row.revision,
        row.previous_revision,
        payload,
        sha256Hex(payload),
        row.recorded_at,
      );
      inserted += 1;
    }
  });
  return { inserted };
}

export function writeDesignEvaluationArtifacts(input: {
  readonly sample: DesignEvaluationSample;
  readonly outputDirectory: string;
  readonly labelsCsv: string;
}): {
  readonly samplePath: string;
  readonly privatePath: string;
  readonly labelsPath: string;
  readonly solveHtmlPath: string;
  readonly revealHtmlPath: string;
  readonly manifestPath: string;
  readonly publicHash: string;
  readonly privateHash: string;
  readonly labelsHash: string;
} {
  mkdirSync(input.outputDirectory, { recursive: true });
  const samplePath = join(input.outputDirectory, "sample.json");
  const privatePath = join(input.outputDirectory, "sample-private.json");
  const labelsPath = join(input.outputDirectory, "labels.csv");
  const solveHtmlPath = join(input.outputDirectory, "solve.html");
  const revealHtmlPath = join(input.outputDirectory, "reveal.html");
  const reportPath = join(input.outputDirectory, "report.html");
  const manifestPath = join(input.outputDirectory, "manifest.json");
  const publicJson = canonicalJson({
    sampleHash: input.sample.sampleHash,
    runId: input.sample.runId,
    planHash: input.sample.planHash,
    createdAt: input.sample.createdAt,
    publicBundle: input.sample.publicBundle,
  });
  const privateJson = canonicalJson(input.sample.privateBundle);
  const solveHtml = renderDesignEvaluationSolveGallery(input.sample);
  const revealHtml = renderDesignEvaluationRevealGallery(input.sample);
  writeFileSync(samplePath, `${publicJson}\n`, "utf8");
  writeFileSync(privatePath, `${privateJson}\n`, "utf8");
  writeFileSync(labelsPath, input.labelsCsv, "utf8");
  writeFileSync(solveHtmlPath, solveHtml, "utf8");
  writeFileSync(revealHtmlPath, revealHtml, "utf8");
  writeFileSync(reportPath, solveHtml, "utf8");
  const publicHash = sha256Hex(publicJson);
  const privateHash = sha256Hex(privateJson);
  const labelsHash = sha256Hex(input.labelsCsv);
  const manifest = {
    kind: "design_evaluation_manifest",
    version: "p50.3-artifacts-v1",
    sampleHash: input.sample.sampleHash,
    publicHash,
    privateHash,
    labelsHash,
    solveHtmlHash: sha256Hex(solveHtml),
    revealHtmlHash: sha256Hex(revealHtml),
    rubricVersion: DESIGN_EVALUATION_RUBRIC.version,
    files: {
      sample: samplePath,
      private: privatePath,
      labels: labelsPath,
      solve: solveHtmlPath,
      reveal: revealHtmlPath,
      report: reportPath,
    },
  };
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, "utf8");
  return {
    samplePath,
    privatePath,
    labelsPath,
    solveHtmlPath,
    revealHtmlPath,
    manifestPath,
    publicHash,
    privateHash,
    labelsHash,
  };
}

export function storeDesignEvaluationSample(
  db: Database.Database,
  sample: DesignEvaluationSample,
): DesignEvaluationSample {
  const payload = canonicalJson(sample);
  const publicPayload = canonicalJson(sample.publicBundle);
  const privatePayload = canonicalJson(sample.privateBundle);
  db.prepare(
    "INSERT OR IGNORE INTO design_evaluation_samples (sample_hash, run_id, plan_hash, payload_json, public_payload_json, private_payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    sample.sampleHash,
    sample.runId,
    sample.planHash,
    payload,
    publicPayload,
    privatePayload,
    sample.createdAt,
  );
  return getDesignEvaluationSample(db, sample.sampleHash);
}

export function getDesignEvaluationSample(
  db: Database.Database,
  sampleHash: string,
): DesignEvaluationSample {
  const row = db
    .prepare(
      "SELECT payload_json FROM design_evaluation_samples WHERE sample_hash = ?",
    )
    .get(sampleHash) as { payload_json: string } | undefined;
  if (row === undefined) {
    throw new Error(`design evaluation sample not found: ${sampleHash}`);
  }
  return JSON.parse(row.payload_json) as DesignEvaluationSample;
}

export function loadDesignEvaluationSummary(
  db: Database.Database,
  sampleHash: string,
): DesignerHumanEvaluationSummary {
  const sample = getDesignEvaluationSample(db, sampleHash);
  const rows = db
    .prepare(
      "SELECT unit_key, revision, payload_json FROM design_evaluations WHERE sample_hash = ? ORDER BY unit_key, revision",
    )
    .all(sampleHash) as Array<{
    unit_key: string;
    revision: number;
    payload_json: string;
  }>;
  const latest = new Map<string, DesignEvaluationLabelRow>();
  for (const row of rows) {
    latest.set(
      row.unit_key,
      DesignEvaluationLabelRowSchema.parse(JSON.parse(row.payload_json)),
    );
  }
  const memberById = new Map(
    sample.privateBundle.members.map((member) => [member.evaluationId, member]),
  );
  const coreMemberIds = new Set(
    sample.privateBundle.triplets.flatMap((triplet) => triplet.memberIds),
  );
  let coreInspected = 0;
  let aiCoreClearSolved = 0;
  let correctnessDefects = 0;
  const defectFamilies = new Map<string, number>();
  for (const member of sample.privateBundle.members) {
    const post = latest.get(`member_post:${member.evaluationId}`);
    if (post === undefined) {
      continue;
    }
    const defective = post.correct === false || post.defect_notes.trim() !== "";
    if (defective) {
      correctnessDefects += 1;
      if (member.arm !== "baseline") {
        defectFamilies.set(
          member.family,
          (defectFamilies.get(member.family) ?? 0) + 1,
        );
      }
    }
  }
  for (const evaluationId of coreMemberIds) {
    const member = memberById.get(evaluationId);
    if (member === undefined) {
      continue;
    }
    const pre = latest.get(`member_pre:${evaluationId}`);
    const post = latest.get(`member_post:${evaluationId}`);
    if (post !== undefined) {
      coreInspected += 1;
    }
    if (member.arm !== "baseline" && pre !== undefined) {
      if (
        pre.clarity !== null &&
        pre.clarity >= 4 &&
        (pre.solve_time === "<=60s" || pre.solve_time === "61-180s")
      ) {
        aiCoreClearSolved += 1;
      }
    }
  }
  const paired = (metric: "interest" | "clarity") => {
    let wins = 0;
    let ties = 0;
    let losses = 0;
    for (const triplet of sample.privateBundle.triplets) {
      for (let left = 0; left < triplet.memberIds.length; left += 1) {
        for (let right = left + 1; right < triplet.memberIds.length; right += 1) {
          const leftMember = memberById.get(triplet.memberIds[left] as string);
          const rightMember = memberById.get(triplet.memberIds[right] as string);
          if (leftMember === undefined || rightMember === undefined) {
            continue;
          }
          const feedbackIsLeft =
            leftMember.arm === "ai_feedback" && rightMember.arm === "baseline";
          const feedbackIsRight =
            leftMember.arm === "baseline" && rightMember.arm === "ai_feedback";
          if (!feedbackIsLeft && !feedbackIsRight) {
            continue;
          }
          const row = latest.get(
            `pairwise:${triplet.tripletId}:${triplet.memberIds[left]}:${triplet.memberIds[right]}:${metric}`,
          );
          if (row === undefined || row.preference === null) {
            losses += 1;
          } else if (row.preference === "tie") {
            ties += 1;
          } else if (
            (feedbackIsLeft && row.preference === "left") ||
            (feedbackIsRight && row.preference === "right")
          ) {
            wins += 1;
          } else {
            losses += 1;
          }
        }
      }
    }
    return { wins, ties, losses, denominator: 10 };
  };
  const synthetic =
    latest.size > 0 && [...latest.values()].every((row) => row.synthetic);
  return {
    synthetic,
    sampleHash,
    corePlanned: 30,
    coreInspected,
    aiCorePlanned: 20,
    aiCoreClearSolved,
    correctnessDefects,
    repeatableFamilyCorrectnessDefect: [...defectFamilies.values()].some(
      (count) => count >= 2,
    ),
    pairedInterest: paired("interest"),
    pairedClarity: paired("clarity"),
  };
}
