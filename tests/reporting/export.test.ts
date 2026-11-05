import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExportError,
  escapeCsvFormulaText,
  exportRun,
  parseCsv,
  readCandidatesExport,
  readRequestsExport,
  readResultsCsv,
} from "../../src/reporting/export.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  FIXTURE_RUN_ID,
  createPartialReviewFailureRun,
  createSyntheticRun,
  createUnbilledOnlyRun,
} from "./fixtures.js";

let tempDirectory: string;
let db: Database.Database;
let outputRoot: string;

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p37-export-"));
  db = openDatabase(join(tempDirectory, "export.sqlite"));
  migrate(db);
  outputRoot = join(tempDirectory, "runs");
  createSyntheticRun(db, { includeVisual: true });
});

afterEach(() => {
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("machine-readable exports", () => {
  it("writes one candidate row per planned slot, requests, summary, CSV, and assets", () => {
    const result = exportRun(db, FIXTURE_RUN_ID, { outputRoot, format: "all" });
    const directory = join(outputRoot, FIXTURE_RUN_ID);
    expect(result.directory).toBe(directory);
    expect(existsSync(join(directory, "manifest.json"))).toBe(true);
    expect(existsSync(join(directory, "summary.json"))).toBe(true);
    expect(existsSync(join(directory, "candidates.jsonl"))).toBe(true);
    expect(existsSync(join(directory, "requests.jsonl"))).toBe(true);
    expect(existsSync(join(directory, "results.csv"))).toBe(true);
    expect(existsSync(join(directory, "images", "svg-matrix-01.svg"))).toBe(true);
    expect(existsSync(join(directory, "images", "svg-matrix-01.png"))).toBe(true);
    expect(existsSync(join(directory, "puzzles", "text-ranking-01.json"))).toBe(true);
    expect(existsSync(join(directory, "puzzles", "text-ranking-02.json"))).toBe(true);

    const candidates = readCandidatesExport(join(directory, "candidates.jsonl"));
    expect(candidates).toHaveLength(20);
    expect(new Set(candidates.map((row) => row.slotId)).size).toBe(20);
    const bySlot = new Map(candidates.map((row) => [row.slotId, row]));
    expect(bySlot.get("text-ranking-01")).toMatchObject({
      family: "ranking",
      modality: "text",
      lane: "spec_first",
      stage: "terminal",
      verdict: "approved",
      formalPassed: true,
      presentationCheckPassed: true,
      reviewed: true,
      question: "=cmd|' /C calc'!A0",
      hint: "  +SUM(1,1)",
      assets: { svg: false, png: false },
    });
    expect(bySlot.get("text-ranking-01")?.cost).toMatchObject({
      knownActualUsd: "0.006",
      actualCostUsd: "0.006",
      costStatus: "known",
      unknownAttempts: 0,
    });
    expect(bySlot.get("text-ranking-02")).toMatchObject({
      stage: "terminal",
      verdict: "generation_error",
      presentationCheckPassed: false,
      question: null,
      assets: { svg: false, png: false },
    });
    expect(bySlot.get("text-ranking-02")?.cost.costStatus).toBe("unknown");
    expect(bySlot.get("text-truth-01")?.cost.costStatus).toBe("not_applicable");
    expect(bySlot.get("svg-matrix-01")).toMatchObject({
      family: "matrix",
      modality: "svg",
      stage: "terminal",
      verdict: "approved",
      assets: { svg: true, png: true },
    });
    expect(bySlot.get("text-matching-01")?.failures).toHaveLength(1);
    expect(bySlot.get("text-matching-01")?.primaryFailure).toBe(
      "NEAR_DUPLICATE_SUSPECTED",
    );

    const requests = readRequestsExport(join(directory, "requests.jsonl"));
    expect(requests).toHaveLength(9);
    const requestText = readFileSync(join(directory, "requests.jsonl"), "utf8");
    expect(requestText).not.toContain("Authorization");
    expect(requestText).not.toContain("sk-");
    expect(requestText).toContain("=cmd fixture request");
    expect(requestText).toContain("=cmd raw response");
    expect(requestText).toContain("\"reservation\"");
    const validated = requests.find((row) => row.role === "wording");
    expect(validated?.attempts[0]?.rawResponse).toEqual({
      id: "fixture-response",
      role: "wording",
      content: "=cmd raw response",
    });
    expect(validated?.attempts[0]?.reservation).toMatchObject({
      state: "settled",
      kind: "attempt",
      amountUsd: "0.01",
      actualCostUsd: "0.001",
    });
    const uncertain = requests.find((row) => row.role === "spec");
    expect(uncertain?.attempts[0]?.state).toBe("uncertain");
    expect(uncertain?.attempts[0]?.reservation).toMatchObject({
      state: "reserved",
      kind: "attempt",
      amountUsd: "0.01",
      actualCostUsd: null,
    });

    const csvRows = readResultsCsv(join(directory, "results.csv"));
    expect(csvRows).toHaveLength(20);
    const csvA = csvRows.find((row) => row.slot_id === "text-ranking-01");
    expect(csvA?.question).toBe("'=cmd|' /C calc'!A0");
    expect(csvA?.hint).toBe("'  +SUM(1,1)");
    expect(csvA?.known_actual_cost_usd).toBe("0.006");
    expect(csvA?.actual_cost_usd).toBe("0.006");
    expect(csvA?.cost_status).toBe("known");
    expect(csvRows.find((row) => row.slot_id === "text-ranking-02")?.cost_status).toBe(
      "unknown",
    );
    expect(csvRows.find((row) => row.slot_id === "svg-matrix-01")?.formal_passed).toBe(
      "1",
    );

    const manifest = JSON.parse(
      readFileSync(join(directory, "manifest.json"), "utf8"),
    ) as { run: { runId: string }; manifest: { slots: unknown[] } };
    expect(manifest.run.runId).toBe(FIXTURE_RUN_ID);
    expect(manifest.manifest.slots).toHaveLength(20);
    const summary = JSON.parse(
      readFileSync(join(directory, "summary.json"), "utf8"),
    ) as { version: number; counts: { planned: number } };
    expect(summary.version).toBe(1);
    expect(summary.counts.planned).toBe(20);
  });

  it("writes only the requested CSV or JSONL files", () => {
    const csvRoot = join(tempDirectory, "csv-runs");
    exportRun(db, FIXTURE_RUN_ID, { outputRoot: csvRoot, format: "csv" });
    const csvDirectory = join(csvRoot, FIXTURE_RUN_ID);
    expect(existsSync(join(csvDirectory, "results.csv"))).toBe(true);
    expect(existsSync(join(csvDirectory, "candidates.jsonl"))).toBe(false);
    expect(existsSync(join(csvDirectory, "requests.jsonl"))).toBe(false);
    expect(existsSync(join(csvDirectory, "puzzles"))).toBe(false);

    const jsonlRoot = join(tempDirectory, "jsonl-runs");
    exportRun(db, FIXTURE_RUN_ID, { outputRoot: jsonlRoot, format: "jsonl" });
    const jsonlDirectory = join(jsonlRoot, FIXTURE_RUN_ID);
    expect(existsSync(join(jsonlDirectory, "candidates.jsonl"))).toBe(true);
    expect(existsSync(join(jsonlDirectory, "requests.jsonl"))).toBe(true);
    expect(existsSync(join(jsonlDirectory, "results.csv"))).toBe(false);
    expect(existsSync(join(jsonlDirectory, "puzzles"))).toBe(false);
  });

  it("rejects unsafe paths, invalid formats, and missing runs", () => {
    expect(() =>
      exportRun(db, "../escape", { outputRoot, format: "all" }),
    ).toThrow(ExportError);
    expect(() =>
      exportRun(db, "not-a-uuid", { outputRoot, format: "all" }),
    ).toThrow(ExportError);
    expect(() =>
      exportRun(db, FIXTURE_RUN_ID, {
        outputRoot,
        format: "xml" as never,
      }),
    ).toThrow(ExportError);
    expect(() =>
      exportRun(db, "123e4567-e89b-42d3-a456-426614174199", {
        outputRoot,
        format: "all",
      }),
    ).toThrow(ExportError);
  });

  it("exports non-terminal review failures from stage evidence", () => {
    const { runId } = createPartialReviewFailureRun(db);
    const partialRoot = join(tempDirectory, "partial-runs");
    exportRun(db, runId, { outputRoot: partialRoot, format: "all" });
    const directory = join(partialRoot, runId);
    const candidates = readCandidatesExport(join(directory, "candidates.jsonl"));
    expect(candidates).toHaveLength(20);
    const row = candidates.find((candidate) => candidate.slotId === "text-ranking-01");
    expect(row).toMatchObject({
      stage: "blind_reviewed",
      terminal: false,
      reviewed: true,
      presentationCheckPassed: true,
      primaryFailure: "API_ERROR",
      question: "Partial question",
      reviewActiveMs: null,
      wallTimeMs: null,
    });
    expect(row?.failures).toEqual([
      expect.objectContaining({ code: "API_ERROR" }),
    ]);
    const csvRows = readResultsCsv(join(directory, "results.csv"));
    expect(
      csvRows.find((candidate) => candidate.slot_id === "text-ranking-01")
        ?.failure_codes,
    ).toBe("API_ERROR");
  });

  it("exports provably unbilled attempts as known zero cost", () => {
    const { runId } = createUnbilledOnlyRun(db);
    const unbilledRoot = join(tempDirectory, "unbilled-runs");
    exportRun(db, runId, { outputRoot: unbilledRoot, format: "all" });
    const directory = join(unbilledRoot, runId);
    const candidates = readCandidatesExport(join(directory, "candidates.jsonl"));
    for (const slotId of ["text-ranking-01", "text-ranking-02"]) {
      expect(
        candidates.find((candidate) => candidate.slotId === slotId)?.cost,
      ).toEqual({
        knownActualUsd: "0",
        actualCostUsd: "0",
        costStatus: "known",
        unknownAttempts: 0,
      });
    }
    const csvRows = readResultsCsv(join(directory, "results.csv"));
    for (const slotId of ["text-ranking-01", "text-ranking-02"]) {
      const row = csvRows.find((candidate) => candidate.slot_id === slotId);
      expect(row?.known_actual_cost_usd).toBe("0");
      expect(row?.actual_cost_usd).toBe("0");
      expect(row?.cost_status).toBe("known");
    }
    const summary = JSON.parse(
      readFileSync(join(directory, "summary.json"), "utf8"),
    ) as { cost: { actualCostUsd: string | null; costStatus: string } };
    expect(summary.cost.actualCostUsd).toBe("0");
    expect(summary.cost.costStatus).toBe("known");
  });

  it("escapes formula-like CSV text without changing the JSON source", () => {
    expect(escapeCsvFormulaText("=1+1")).toBe("'=1+1");
    expect(escapeCsvFormulaText("+SUM")).toBe("'+SUM");
    expect(escapeCsvFormulaText("-1")).toBe("'-1");
    expect(escapeCsvFormulaText("@cmd")).toBe("'@cmd");
    expect(escapeCsvFormulaText("  =1")).toBe("'  =1");
    expect(escapeCsvFormulaText("\t=1")).toBe("'\t=1");
    expect(escapeCsvFormulaText("\u0001safe")).toBe("'\u0001safe");
    expect(escapeCsvFormulaText("safe")).toBe("safe");
    expect(parseCsv('"a,b","line\nbreak"\n')).toEqual([["a,b", "line\nbreak"]]);
    const candidatesPath = join(
      outputRoot,
      FIXTURE_RUN_ID,
      "candidates.jsonl",
    );
    exportRun(db, FIXTURE_RUN_ID, { outputRoot, format: "jsonl" });
    const candidates = readCandidatesExport(candidatesPath);
    expect(
      candidates.find((row) => row.slotId === "text-ranking-01")?.question,
    ).toBe("=cmd|' /C calc'!A0");
  });
});
