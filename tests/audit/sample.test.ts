import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FailureRecord, WorkflowStage } from "../../src/domain/candidate.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import {
  buildAuditSummary,
  importAuditLabels,
  pendingAuditLabelRows,
  validateAuditImport,
  writeAuditOutputs,
  type AuditLabelRow,
} from "../../src/audit/labels.js";
import {
  AuditSampleError,
  auditSampleEntries,
  selectAuditSample,
  type AuditSampleManifest,
} from "../../src/audit/sample.js";
import { buildCandidateRows } from "../../src/reporting/export.js";
import {
  createRun,
  getRun,
  insertStageResult,
  setRunControlState,
} from "../../src/storage/repository.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { hashCanonicalJson } from "../../src/util/hash.js";
import { createSyntheticRun } from "../reporting/fixtures.js";

const FIXED_TIME = "2026-11-06T12:00:00.000Z";
const BASE = Date.parse(FIXED_TIME);
const AUDITOR = "test-auditor";

type Verdict = "approved" | "inconclusive" | "rejected" | "generation_error";
type CellPattern = (family: string, lane: string, index: number) => Verdict | "unstarted";

interface Cohort {
  readonly runId: string;
  readonly db: Database.Database;
}

let tempDirectory: string;
let db: Database.Database;

function iso(offset: number): string {
  return new Date(BASE + offset).toISOString();
}

function failure(code: string, source: "deterministic" | "model" | "infrastructure"): FailureRecord {
  return {
    code: code as FailureRecord["code"],
    stage: "terminal",
    severity: "high",
    source,
    evidence: "audit fixture",
  };
}

function formalPayload(slotId: string): unknown {
  return {
    fingerprint: {
      version: 1,
      family: "ranking",
      modality: "text",
      specHash: "1".repeat(64),
      structureHash: hashCanonicalJson({ slotId }),
      contentHash: null,
      renderHashes: { svg: null, png: null },
      canonicalStructure: null,
      features: [],
    },
    render: {
      rendererVersion: null,
      svgHash: null,
      pngHash: null,
      previewPngHash: null,
    },
    solveResult: {
      solutionCount: 1,
      answerCount: 1,
      enumeratedStates: 1,
      correctAnswer: { answer: "A" },
      proof: { facts: [] },
    },
    choices: {
      choices: [
        { label: "A", value: { answer: "A" } },
        { label: "B", value: { answer: "B" } },
        { label: "C", value: { answer: "C" } },
        { label: "D", value: { answer: "D" } },
      ],
      correctLabel: "A",
    },
  };
}

function presentationPayload(slotId: string, family: string, modality: "text" | "svg"): unknown {
  return {
    presentation: {
      visible: {
        slotId,
        family,
        modality,
        question: `Audit question for ${slotId}`,
        rules: {
          domain: "fixture",
          closedWorld: "closed",
          target: "choose the answer",
          operations: ["operation one"],
          conventions: [],
        },
        clues: [],
        options: [
          { label: "A", text: "Option A" },
          { label: "B", text: "Option B" },
          { label: "C", text: "Option C" },
          { label: "D", text: "Option D" },
        ],
        assets: { svgHash: null, pngHash: null },
      },
      reveal: {
        correctLabel: "A",
        hint: "fixture hint",
        explanationSteps: ["fixture explanation"],
        proof: "fixture proof",
      },
    },
  };
}

function terminalPayload(verdict: Verdict, failures: readonly FailureRecord[]): unknown {
  return {
    version: 1,
    verdict,
    completion: "complete",
    proceed: verdict === "approved",
    primaryFailure: failures[0]?.code ?? null,
    businessBlockers: [],
    failures,
    rationale: "audit fixture",
    duplicateOutcome: "unique",
    duplicateOwnerSlotId: null,
  };
}

function insertStage(
  database: Database.Database,
  runId: string,
  slotId: string,
  stage: WorkflowStage,
  payload: unknown,
  offset: number,
  verdict?: Verdict,
): void {
  insertStageResult(database, {
    runId,
    slotId,
    stage,
    startedAt: iso(offset),
    finishedAt: iso(offset + 10),
    elapsedMs: 10,
    ...(verdict === undefined ? {} : { verdict }),
    payload,
    createdAt: iso(offset + 10),
  });
}

function standardPattern(_family: string, _lane: string, index: number): Verdict | "unstarted" {
  if (index <= 4) return "approved";
  if (index <= 6) return "inconclusive";
  if (index <= 8) return "rejected";
  return "generation_error";
}

function createCohort(
  database: Database.Database,
  runId: string,
  pattern: CellPattern,
): Cohort {
  const plan = buildPlanManifest({ runKind: "full" });
  createRun(database, {
    runId,
    plan,
    evidenceKind: "mock",
    createdAt: FIXED_TIME,
  });
  const counters = new Map<string, number>();
  for (const slot of plan.slots) {
    const key = `${slot.family}:${slot.lane}`;
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const verdict = pattern(slot.family, slot.lane, index);
    if (verdict === "unstarted") {
      continue;
    }
    const offset = slot.slotOrdinal * 1000;
    insertStage(database, runId, slot.slotId, "formal_checked", formalPayload(slot.slotId), offset);
    if (verdict === "approved" || verdict === "inconclusive") {
      insertStage(
        database,
        runId,
        slot.slotId,
        "presentation_ready",
        presentationPayload(slot.slotId, slot.family, slot.modality),
        offset + 20,
      );
    }
    if (verdict === "inconclusive") {
      insertStage(
        database,
        runId,
        slot.slotId,
        "duplicate_checked",
        { version: 1, assessment: { outcome: "unique" } },
        offset + 40,
      );
      insertStage(
        database,
        runId,
        slot.slotId,
        "blind_reviewed",
        {
          version: 1,
          role: slot.modality === "svg" ? "blind_vision" : "blind_text",
          completed: true,
          choiceAgreement: "disagreed",
          review: { answerStatus: "no_unique_answer" },
        },
        offset + 60,
      );
      insertStage(
        database,
        runId,
        slot.slotId,
        "alignment_reviewed",
        {
          version: 1,
          role: slot.modality === "svg" ? "alignment_vision" : "alignment_text",
          completed: true,
          derivedOverall: "fail",
        },
        offset + 80,
      );
    }
    const failures =
      verdict === "generation_error"
        ? [failure("API_ERROR", "infrastructure")]
        : verdict === "rejected"
          ? [failure("UNSAT", "deterministic")]
          : verdict === "inconclusive"
            ? [failure("REVIEWER_DISAGREES", "model")]
            : [];
    insertStage(
      database,
      runId,
      slot.slotId,
      "terminal",
      terminalPayload(verdict, failures),
      offset + 100,
      verdict,
    );
  }
  setRunControlState(database, runId, "completed");
  return { runId, db: database };
}

function sampleFor(cohort: Cohort): AuditSampleManifest {
  const run = getRun(cohort.db, cohort.runId);
  const candidates = buildCandidateRows(cohort.db, cohort.runId);
  return selectAuditSample({ run, candidates });
}

function fillRows(
  manifest: AuditSampleManifest,
  overrides: (row: AuditLabelRow) => AuditLabelRow = (row) => row,
): AuditLabelRow[] {
  return pendingAuditLabelRows(manifest).map((row) =>
    overrides({
      ...row,
      correctness: row.inspectable ? "correct" : "not_inspectable",
      clarity: row.inspectable ? "clear" : "not_inspectable",
      hintSupport: row.inspectable ? "supported" : "not_inspectable",
      explanationSupport: row.inspectable ? "supported" : "not_inspectable",
      imageReadability: row.inspectable
        ? row.modality === "text"
          ? "not_applicable"
          : "readable"
        : "not_inspectable",
      noveltyConcern: row.inspectable ? "none" : "not_inspectable",
      enjoyment: row.inspectable ? 3 : null,
      perceivedDifficulty: row.inspectable ? 2 : null,
      solveTime: row.inspectable ? "<=60s" : "not_inspectable",
      notes: row.inspectable ? "test-only audit annotation" : "No presentation.",
      auditor: AUDITOR,
      auditorTime: FIXED_TIME,
    }),
  );
}

function primaryHash(database: Database.Database, runId: string): string {
  return hashCanonicalJson({
    runs: database.prepare("SELECT * FROM runs WHERE run_id = ?").all(runId),
    slots: database.prepare("SELECT * FROM slots WHERE run_id = ?").all(runId),
    stages: database.prepare("SELECT * FROM stage_results WHERE run_id = ?").all(runId),
    artifacts: database.prepare("SELECT * FROM artifacts").all(),
    events: database.prepare("SELECT * FROM events WHERE run_id = ?").all(runId),
  });
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p42-"));
  db = openDatabase(join(tempDirectory, "audit.sqlite"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("deterministic human-audit sample", { timeout: 120_000 }, () => {
  it("selects core40 with four per family, two per lane, and twenty reserved approvals", () => {
    const cohort = createCohort(db, "123e4567-e89b-42d3-a456-426614174200", standardPattern);
    const manifest = sampleFor(cohort);
    expect(manifest.production).toBe(true);
    expect(manifest.preview).toBe(false);
    expect(manifest.core).toHaveLength(40);
    expect(manifest.categoryAdditions.length).toBeLessThanOrEqual(4);
    expect(auditSampleEntries(manifest).length).toBeLessThanOrEqual(44);
    const standardCandidates = buildCandidateRows(db, cohort.runId);
    expect(
      manifest.core.filter(
        (entry) =>
          standardCandidates.find((candidate) => candidate.slotId === entry.slotId)
            ?.verdict === "approved",
      ),
    ).toHaveLength(20);
    for (const family of [
      "ranking",
      "matching",
      "scheduling",
      "truth",
      "arithmetic",
      "matrix",
      "transforms",
      "paths",
      "symmetry",
      "counting",
    ] as const) {
      const core = manifest.core.filter((entry) => entry.family === family);
      expect(core).toHaveLength(4);
      expect(core.filter((entry) => entry.lane === "spec_first")).toHaveLength(2);
      expect(core.filter((entry) => entry.lane === "ai_spec")).toHaveLength(2);
      expect(manifest.familyApprovalLanes[family]).toEqual({
        spec_first: 5,
        ai_spec: 5,
      });
    }
    expect(manifest.categories.core).toEqual(["approved", "inconclusive"]);
    expect(manifest.categories.additions).toEqual(["rejected", "generation_error"]);
    expect(manifest.denominators.total.sampled).toBe(42);
    expect(manifest.denominators.approved.sampled).toBe(20);
    expect(manifest.shortfalls).toEqual([]);
    const again = sampleFor(cohort);
    expect(again.sampleHash).toBe(manifest.sampleHash);
    expect(again.core).toEqual(manifest.core);
  });

  it("refuses a production audit for smoke and returns a labeled preview", () => {
    createSyntheticRun(db, { includeVisual: true });
    const run = getRun(db, "123e4567-e89b-42d3-a456-426614174100");
    const candidates = buildCandidateRows(db, run.runId);
    const preview = selectAuditSample({ run, candidates });
    expect(preview.preview).toBe(true);
    expect(preview.production).toBe(false);
    expect(preview.core.length).toBeGreaterThan(0);
    expect(() =>
      selectAuditSample({ run, candidates, mode: "production" }),
    ).toThrow(AuditSampleError);
  });

  it("records one-lane-only approvals and insufficient family approvals", () => {
    const oneLane = createCohort(
      db,
      "123e4567-e89b-42d3-a456-426614174201",
      (family, lane, index) => {
        if (family === "ranking" && lane === "ai_spec") {
          return index <= 8 ? "rejected" : "generation_error";
        }
        return standardPattern(family, lane, index);
      },
    );
    const oneLaneManifest = sampleFor(oneLane);
    expect(oneLaneManifest.familyApprovalLanes.ranking).toEqual({
      spec_first: 5,
      ai_spec: 0,
    });
    expect(
      oneLaneManifest.shortfalls.some(
        (shortfall) =>
          shortfall.kind === "ONE_LANE_APPROVALS" &&
          shortfall.family === "ranking",
      ),
    ).toBe(true);
    const oneLaneCandidates = buildCandidateRows(db, oneLane.runId);
    expect(
      oneLaneManifest.core
        .filter((entry) => entry.family === "ranking")
        .every(
          (entry) =>
            entry.lane === "spec_first" ||
            oneLaneCandidates.find((candidate) => candidate.slotId === entry.slotId)
              ?.verdict !== "approved",
        ),
    ).toBe(true);

    const insufficient = createCohort(
      db,
      "123e4567-e89b-42d3-a456-426614174202",
      (family, lane, index) => {
        if (family === "matching") {
          return lane === "spec_first" && index === 0
            ? "approved"
            : "rejected";
        }
        return standardPattern(family, lane, index);
      },
    );
    const insufficientManifest = sampleFor(insufficient);
    expect(
      insufficientManifest.shortfalls.some(
        (shortfall) =>
          shortfall.kind === "FAMILY_APPROVALS" &&
          shortfall.family === "matching" &&
          shortfall.available === 1,
      ),
    ).toBe(true);
  });

  it("records insufficient terminal slots without substituting another lane", () => {
    const cohort = createCohort(
      db,
      "123e4567-e89b-42d3-a456-426614174203",
      (family, lane, index) => {
        if (family === "paths" && lane === "spec_first") {
          return index === 0 ? "approved" : "unstarted";
        }
        return standardPattern(family, lane, index);
      },
    );
    const manifest = sampleFor(cohort);
    expect(
      manifest.shortfalls.some(
        (shortfall) =>
          shortfall.kind === "LANE_TERMINAL" &&
          shortfall.family === "paths" &&
          shortfall.lane === "spec_first" &&
          shortfall.available === 1,
      ),
    ).toBe(true);
    expect(manifest.core.length).toBeLessThan(40);
    expect(
      manifest.core.filter(
        (entry) => entry.family === "paths" && entry.lane === "spec_first",
      ),
    ).toHaveLength(1);
  });

  it("appends missing verdict categories at most four and preserves total 44", () => {
    const cohort = createCohort(
      db,
      "123e4567-e89b-42d3-a456-426614174204",
      (_family, _lane, index) => {
        if (index <= 7) return "approved";
        if (index === 8) return "rejected";
        return "generation_error";
      },
    );
    const manifest = sampleFor(cohort);
    expect(manifest.core).toHaveLength(40);
    const candidates = buildCandidateRows(db, cohort.runId);
    expect(
      manifest.core.every(
        (entry) =>
          candidates.find((candidate) => candidate.slotId === entry.slotId)
            ?.verdict === "approved",
      ),
    ).toBe(true);
    expect(manifest.categoryAdditions.length).toBeLessThanOrEqual(4);
    expect(manifest.categoryAdditions.length).toBe(2);
    expect(manifest.categories.additions).toEqual(["rejected", "generation_error"]);
    expect(auditSampleEntries(manifest)).toHaveLength(42);
  });

  it("refuses a production sample for a non-completed run", () => {
    const cohort = createCohort(db, "123e4567-e89b-42d3-a456-426614174208", standardPattern);
    setRunControlState(db, cohort.runId, "running");
    const run = getRun(db, cohort.runId);
    const candidates = buildCandidateRows(db, cohort.runId);
    expect(() => selectAuditSample({ run, candidates })).toThrow(
      /completed run/,
    );
  });

  it("rejects a tampered manifest even when its self-hash is recomputed", () => {
    const cohort = createCohort(db, "123e4567-e89b-42d3-a456-426614174209", standardPattern);
    const manifest = sampleFor(cohort);
    const run = getRun(db, cohort.runId);
    const candidates = buildCandidateRows(db, cohort.runId);
    const tampered = structuredClone(manifest) as unknown as {
      core: Array<AuditSampleManifest["core"][number]>;
      sampleHash: string;
      [key: string]: unknown;
    };
    tampered.core[0] = {
      ...tampered.core[0]!,
      slotHash: "0".repeat(64),
    };
    const withoutHash = Object.fromEntries(
      Object.entries(tampered).filter(([key]) => key !== "sampleHash"),
    );
    tampered.sampleHash = hashCanonicalJson(withoutHash);
    expect(() =>
      validateAuditImport({
        manifest: tampered as unknown as AuditSampleManifest,
        run,
        candidates,
        rows: fillRows(manifest),
        clock: { now: () => new Date(FIXED_TIME) },
      }),
    ).toThrow(/recomputed/);
  });

  it("breaks hash ties deterministically by slot ID", () => {
    const cohort = createCohort(db, "123e4567-e89b-42d3-a456-426614174205", standardPattern);
    const run = getRun(cohort.db, cohort.runId);
    const candidates = buildCandidateRows(cohort.db, cohort.runId);
    const hashFn = () => "0".repeat(64);
    const first = selectAuditSample({ run, candidates, hashFn });
    const second = selectAuditSample({ run, candidates, hashFn });
    expect(first.sampleHash).toBe(second.sampleHash);
    expect(first.core.map((entry) => entry.slotId)).toEqual(
      second.core.map((entry) => entry.slotId),
    );
  });

  it("writes a pending gallery/labels and imports append-only labels without mutating primary data", () => {
    const cohort = createCohort(db, "123e4567-e89b-42d3-a456-426614174206", standardPattern);
    const manifest = sampleFor(cohort);
    const candidates = buildCandidateRows(db, cohort.runId);
    const paths = writeAuditOutputs(db, getRun(db, cohort.runId), manifest, candidates, join(tempDirectory, "runs"));
    expect(readFileSync(paths.manifestPath, "utf8")).toContain(manifest.sampleHash);
    expect(readFileSync(paths.galleryPath, "utf8").match(/class="card"/g)).toHaveLength(42);
    const pending = readFileSync(paths.labelsPath, "utf8").trimEnd().split("\n");
    expect(pending).toHaveLength(43);
    expect(pending[0]).toContain("sample_hash");
    expect(pending[0]).toContain("auditor");
    expect(pending[0]).not.toContain("verdict");
    expect(pending.slice(1).every((row) => row.endsWith(",,,"))).toBe(true);

    const rows = fillRows(manifest);
    const importCandidates = buildCandidateRows(db, cohort.runId);
    validateAuditImport({
      manifest,
      run: getRun(db, cohort.runId),
      candidates: importCandidates,
      rows,
      clock: { now: () => new Date(FIXED_TIME) },
    });
    const before = primaryHash(db, cohort.runId);
    const first = importAuditLabels({
      db,
      manifest,
      run: getRun(db, cohort.runId),
      candidates: importCandidates,
      rows,
      clock: { now: () => new Date(FIXED_TIME) },
    });
    expect(first.imported).toBe(42);
    expect(first.summary.total.sampled).toBe(42);
    expect(first.summary.total.labelled).toBe(42);
    expect(first.summary.approved.sampled).toBe(20);
    expect(first.summary.approved.inspectable).toBe(10);
    expect(primaryHash(db, cohort.runId)).toBe(before);

    const second = importAuditLabels({
      db,
      manifest,
      run: getRun(db, cohort.runId),
      candidates: importCandidates,
      rows,
      clock: { now: () => new Date(FIXED_TIME) },
    });
    expect(Math.min(...second.revisions)).toBe(2);
    expect(Math.max(...second.revisions)).toBe(2);
    expect(primaryHash(db, cohort.runId)).toBe(before);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM human_labels WHERE run_id = ?").get(cohort.runId),
    ).toEqual({ count: 84 });
    expect(buildAuditSummary(db, manifest, importCandidates).maxRevision).toBe(2);
    expect(() =>
      db.prepare("UPDATE human_labels SET notes = 'changed'").run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM human_labels").run()).toThrow(
      /append-only/,
    );
  });

  it("rejects invalid audit imports", () => {
    const cohort = createCohort(db, "123e4567-e89b-42d3-a456-426614174207", standardPattern);
    const manifest = sampleFor(cohort);
    const run = getRun(db, cohort.runId);
    const candidates = buildCandidateRows(db, cohort.runId);
    const rows = fillRows(manifest);
    const expectReject = (candidateRows: AuditLabelRow[], pattern: RegExp) => {
      expect(() =>
        validateAuditImport({
          manifest,
          run,
          candidates,
          rows: candidateRows,
          clock: { now: () => new Date(FIXED_TIME) },
        }),
      ).toThrow(pattern);
    };
    expectReject(
      rows.map((row, index) =>
        index === 0 ? { ...row, sampleHash: "0".repeat(64) } : row,
      ),
      /metadata/,
    );
    expectReject(rows.slice(1), /expected/);
    expectReject([...rows, rows[0]!], /expected/);
    expectReject(
      rows.map((row, index) =>
        index === 0 ? { ...row, slotId: "text-ranking-99" } : row,
      ),
      /unsampled|expected/,
    );
    expectReject(
      rows.map((row, index) =>
        index === 0 ? { ...row, auditor: "mock-test-only" } : row,
      ),
      /mock/,
    );
    expectReject(
      rows.map((row, index) =>
        index === 0 ? { ...row, auditorTime: "2999-01-01T00:00:00.000Z" } : row,
      ),
      /future/,
    );
    const noninspectable = rows.find((row) => !row.inspectable);
    if (noninspectable !== undefined) {
      expectReject(
        rows.map((row) =>
          row.slotId === noninspectable.slotId
            ? { ...row, enjoyment: 3 }
            : row,
        ),
        /not_inspectable/,
      );
    }
    const textInspectable = rows.find(
      (row) => row.inspectable && row.modality === "text",
    );
    if (textInspectable !== undefined) {
      expectReject(
        rows.map((row) =>
          row.slotId === textInspectable.slotId
            ? { ...row, imageReadability: "readable" }
            : row,
        ),
        /text/,
      );
    }
    createSyntheticRun(db, { includeVisual: true });
    const previewManifest = selectAuditSample({
      run: getRun(db, "123e4567-e89b-42d3-a456-426614174100"),
      candidates: buildCandidateRows(db, "123e4567-e89b-42d3-a456-426614174100"),
    });
    // A fresh smoke preview is not importable as production evidence.
    expect(() =>
      validateAuditImport({
        manifest: previewManifest,
        run: getRun(db, "123e4567-e89b-42d3-a456-426614174100"),
        candidates: buildCandidateRows(db, "123e4567-e89b-42d3-a456-426614174100"),
        rows: [],
        clock: { now: () => new Date(FIXED_TIME) },
      }),
    ).toThrow(/preview|production/);
  });
});
