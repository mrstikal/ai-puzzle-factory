import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockTransport } from "../../src/ai/mock.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { computeRunMetrics } from "../../src/reporting/metrics.js";
import { exportRun, readResultsCsv } from "../../src/reporting/export.js";
import { writeHtmlReport } from "../../src/reporting/html.js";
import { RunCancellation } from "../../src/runner/cancel.js";
import { resumeMockExperiment } from "../../src/runner/resume.js";
import {
  runFullMockExperiment,
  type RunSmokeMockResult,
} from "../../src/runner/run.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { getRun } from "../../src/storage/repository.js";
import { hashCanonicalJson } from "../../src/util/hash.js";

const NOW = new Date("2026-11-06T00:00:00.000Z");
const CLOCK = {
  now: () => NOW,
  sleep: async (_ms: number) => undefined,
};
const VOLATILE_KEYS = new Set([
  "attemptId",
  "attemptIds",
  "createdAt",
  "finishedAt",
  "logicalCallId",
  "logicalCalls",
  "proposal",
  "rawResponseArtifactIds",
  "runId",
  "startedAt",
  "updatedAt",
]);

let tempDirectory: string;
let dbConcurrencyTwo: Database.Database;
let dbConcurrencyOne: Database.Database;
let runConcurrencyTwo: RunSmokeMockResult;
let runConcurrencyOne: RunSmokeMockResult;

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_KEYS.has(key))
        .map(([key, item]) => [key, stripVolatile(item)]),
    );
  }
  return value;
}

async function runFull(
  db: Database.Database,
  concurrency: 1 | 2,
  options: {
    readonly cancellation?: RunCancellation;
    readonly hooks?: Parameters<typeof runFullMockExperiment>[0]["hooks"];
  } = {},
): Promise<{ readonly runId: string; readonly result: RunSmokeMockResult }> {
  const runId = randomUUID();
  const transport = createMockTransport({
    db,
    clock: CLOCK,
    random: () => 0,
    deadlineMs: 30_000,
  });
  const result = await runFullMockExperiment({
    db,
    runId,
    accountId: `full-${runId}`,
    apiKey: "mock-offline-key",
    transport,
    maxCostUsd: "0",
    concurrency,
    clock: CLOCK,
    ...(options.cancellation === undefined
      ? {}
      : { cancellation: options.cancellation }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return { runId, result };
}

function stageCounts(db: Database.Database, runId: string): Record<string, number> {
  return Object.fromEntries(
    (
      db
        .prepare(
          "SELECT stage, COUNT(*) AS count FROM stage_results WHERE run_id = ? GROUP BY stage ORDER BY stage",
        )
        .all(runId) as Array<{ stage: string; count: number }>
    ).map((row) => [row.stage, row.count]),
  );
}

function stableRunSnapshot(
  db: Database.Database,
  runId: string,
): Record<string, unknown> {
  const run = getRun(db, runId);
  const slots = db
    .prepare(
      "SELECT slot_id, slot_ordinal, family, modality, lane, difficulty, stage, verdict, checkpoint_version FROM slots WHERE run_id = ? ORDER BY slot_ordinal",
    )
    .all(runId);
  const stages = (
    db
      .prepare(
        "SELECT slot_id, stage, version, payload_json FROM stage_results WHERE run_id = ? ORDER BY slot_id, stage, version",
      )
      .all(runId) as Array<{
      slot_id: string;
      stage: string;
      version: number;
      payload_json: string;
    }>
  ).map((row) => ({
    slotId: row.slot_id,
    stage: row.stage,
    version: row.version,
    payload: stripVolatile(JSON.parse(row.payload_json)),
  }));
  const calls = db
    .prepare(
      "SELECT slot_id, role, state FROM logical_calls WHERE run_id = ? ORDER BY slot_id, role",
    )
    .all(runId);
  const attempts = db
    .prepare(
      "SELECT role, state, cost_status, http_status, error_classification, partial_completion FROM request_attempts ORDER BY role, state, cost_status, http_status, error_classification, partial_completion",
    )
    .all();
  const artifactCounts = db
    .prepare("SELECT kind, COUNT(*) AS count FROM artifacts GROUP BY kind ORDER BY kind")
    .all();
  const barrier = (
    db
      .prepare(
        "SELECT payload_json FROM events WHERE run_id = ? AND event_type = 'duplicate_barrier'",
      )
      .get(runId) as { payload_json: string } | undefined
  );
  return {
    run: {
      protocolVersion: run.protocolVersion,
      runKind: run.runKind,
      rootSeed: run.rootSeed,
      evidenceKind: run.evidenceKind,
      manifestHash: run.manifestHash,
      controlState: run.controlState,
    },
    slots,
    stages,
    calls,
    attempts,
    artifactCounts,
    barrier: barrier === undefined ? null : stripVolatile(JSON.parse(barrier.payload_json)),
  };
}

beforeAll(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p45-full-"));
  dbConcurrencyTwo = openDatabase(join(tempDirectory, "concurrency-two.sqlite"));
  dbConcurrencyOne = openDatabase(join(tempDirectory, "concurrency-one.sqlite"));
  migrate(dbConcurrencyTwo);
  migrate(dbConcurrencyOne);
  const first = await runFull(dbConcurrencyTwo, 2);
  runConcurrencyTwo = first.result;
  const second = await runFull(dbConcurrencyOne, 1);
  runConcurrencyOne = second.result;
}, 300_000);

afterAll(() => {
  dbConcurrencyTwo.close();
  dbConcurrencyOne.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("full offline release run", () => {
  it(
    "completes all 200 slots with exact quotas and complete stage/ledger records",
    () => {
      const plan = buildPlanManifest({ runKind: "full" });
      expect(runConcurrencyTwo.status).toBe("completed");
      expect(runConcurrencyTwo.plan.planHash).toBe(plan.planHash);
      expect(runConcurrencyTwo.slots).toHaveLength(200);
      expect(runConcurrencyTwo.summary).toMatchObject({
        status: "completed",
        slots: 200,
        terminalSlots: 200,
        attempts: 644,
        unknownAttempts: 0,
        cost: { actualCostUsd: "0", costStatus: "known" },
      });
      expect(runConcurrencyTwo.summary.callsByRole.spec).toBe(80);
      expect(runConcurrencyTwo.summary.callsByRole.wording).toBe(200);
      expect(runConcurrencyTwo.summary.callsByRole.blind_vision).toBe(100);
      expect(runConcurrencyTwo.summary.callsByRole.alignment_vision).toBe(100);
      expect(runConcurrencyTwo.summary.callsByRole.blind_text).toBeGreaterThan(0);
      expect(runConcurrencyTwo.summary.callsByRole.blind_text).toBeLessThanOrEqual(
        100,
      );
      expect(runConcurrencyTwo.summary.callsByRole.blind_text).toBe(
        runConcurrencyTwo.summary.callsByRole.alignment_text,
      );
      expect(
        Object.values(runConcurrencyTwo.summary.callsByRole).reduce(
          (sum, count) => sum + count,
          0,
        ),
      ).toBe(runConcurrencyTwo.summary.attempts);
      expect(runConcurrencyTwo.summary.verdicts).toEqual({
        approved: 148,
        rejected: 18,
        inconclusive: 34,
        generation_error: 0,
      });
      expect(runConcurrencyTwo.summary.barrier).toMatchObject({
        plannedSlots: 200,
        preparedSlots: 200,
        readyCandidates: 200,
        eligibleCandidates: 200,
        fingerprintableCandidates: 200,
        owners: 11,
        uniqueCandidates: 145,
        structuralDuplicates: 18,
        nearPairs: 27,
        nearSuspectedCandidates: 34,
        replacements: 0,
        terminalFailuresRewritten: 0,
      });

      const run = getRun(dbConcurrencyTwo, runConcurrencyTwo.runId);
      expect(run.evidenceKind).toBe("mock");
      expect(run.runKind).toBe("full");
      expect(run.controlState).toBe("completed");
      expect(stageCounts(dbConcurrencyTwo, runConcurrencyTwo.runId)).toEqual({
        spec_ready: 200,
        formal_checked: 200,
        presentation_ready: 200,
        duplicate_checked: 200,
        blind_reviewed: 182,
        alignment_reviewed: 182,
        terminal: 200,
      });
      expect(
        dbConcurrencyTwo
          .prepare(
            "SELECT COUNT(*) AS count FROM slots WHERE run_id = ? AND stage = 'terminal'",
          )
          .get(runConcurrencyTwo.runId),
      ).toEqual({ count: 200 });
      expect(
        dbConcurrencyTwo
          .prepare(
            "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND state = 'validated'",
          )
          .get(runConcurrencyTwo.runId),
      ).toEqual({ count: 644 });
      expect(
        dbConcurrencyTwo
          .prepare(
            "SELECT COUNT(*) AS count FROM request_attempts WHERE state = 'validated' AND cost_status = 'known'",
          )
          .get(),
      ).toEqual({ count: 644 });
      expect(
        dbConcurrencyTwo
          .prepare(
            "SELECT kind, COUNT(*) AS count FROM artifacts GROUP BY kind ORDER BY kind",
          )
          .all(),
      ).toEqual([
        { kind: "png", count: 200 },
        { kind: "raw_response", count: 644 },
        { kind: "svg", count: 100 },
      ]);
      expect(
        dbConcurrencyTwo
          .prepare("SELECT COUNT(*) AS count FROM stage_artifacts")
          .get(),
      ).toEqual({ count: 300 });
      expect(
        dbConcurrencyTwo
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND event_type = 'duplicate_barrier'",
          )
          .get(runConcurrencyTwo.runId),
      ).toEqual({ count: 1 });

      const metrics = computeRunMetrics(
        dbConcurrencyTwo,
        runConcurrencyTwo.runId,
      );
      expect(metrics.planned.total).toBe(200);
      expect(metrics.planned.byModality).toEqual({ text: 100, svg: 100 });
      expect(metrics.planned.byLane).toEqual({ spec_first: 120, ai_spec: 80 });
      expect(metrics.planned.byDifficulty).toEqual({
        1: 70,
        2: 70,
        3: 60,
        4: 0,
        5: 0,
      });
      expect(metrics.counts).toMatchObject({
        planned: 200,
        started: 200,
        terminal: 200,
        fingerprintable: 200,
        formalPassed: 200,
        presentationCheckPassed: 200,
        reviewed: 182,
        blindReviewed: 182,
        alignmentReviewed: 182,
        approved: 148,
        rejected: 18,
        inconclusive: 34,
        generationError: 0,
        paused: 0,
        unstarted: 0,
        infrastructureOnlyTerminal: 0,
        terminalWithoutVerdict: 0,
      });
      expect(metrics.rates).toMatchObject({
        formalPassRate: 1,
        preReviewPassRate: 1,
        reviewCoverage: 1,
        fingerprintCoverage: 1,
        conditionalReviewAgreement: 1,
        blindAmbiguityRate: 0,
        structuralUniqueness: 0.91,
      });
      expect(metrics.uniqueness).toMatchObject({
        fingerprintable: 200,
        distinctStructures: 182,
        structuralUniqueness: 0.91,
        fingerprintCoverage: 1,
      });
      expect(metrics.cost).toMatchObject({
        costStatus: "known",
        actualCostUsd: "0",
        unknownAttempts: 0,
        missingCostAttempts: 0,
      });
      expect(metrics.failures.verdictHistogram).toEqual({
        approved: 148,
        rejected: 18,
        inconclusive: 34,
        generation_error: 0,
      });
    },
    120_000,
  );

  it(
    "produces identical stable content at concurrency 1 and 2",
    () => {
      expect(
        hashCanonicalJson(
          stableRunSnapshot(dbConcurrencyOne, runConcurrencyOne.runId),
        ),
      ).toBe(
        hashCanonicalJson(
          stableRunSnapshot(dbConcurrencyTwo, runConcurrencyTwo.runId),
        ),
      );
    },
    120_000,
  );

  it(
    "exports every planned slot and card with a synthetic-only label",
    () => {
      const outputRoot = join(tempDirectory, "export");
      const exported = exportRun(dbConcurrencyTwo, runConcurrencyTwo.runId, {
        outputRoot,
        format: "all",
      });
      const report = writeHtmlReport(dbConcurrencyTwo, runConcurrencyTwo.runId, {
        outputRoot,
      });
      const plan = buildPlanManifest({ runKind: "full" });
      const planSlotIds = new Set(plan.slots.map((slot) => slot.slotId));

      const candidates = readFileSync(
        join(exported.directory, "candidates.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { slotId: string; terminal: boolean });
      expect(candidates).toHaveLength(200);
      expect(new Set(candidates.map((candidate) => candidate.slotId)).size).toBe(
        200,
      );
      for (const candidate of candidates) {
        expect(planSlotIds.has(candidate.slotId)).toBe(true);
        expect(candidate.terminal).toBe(true);
      }

      const requests = readFileSync(
        join(exported.directory, "requests.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n");
      expect(requests).toHaveLength(644);

      const csvRows = readResultsCsv(join(exported.directory, "results.csv"));
      expect(csvRows).toHaveLength(200);
      expect(new Set(csvRows.map((row) => row.slot_id)).size).toBe(200);

      const puzzleFiles = readdirSync(join(exported.directory, "puzzles"));
      expect(puzzleFiles).toHaveLength(200);
      for (const file of puzzleFiles) {
        const puzzle = JSON.parse(
          readFileSync(join(exported.directory, "puzzles", file), "utf8"),
        ) as { slotId: string };
        expect(planSlotIds.has(puzzle.slotId)).toBe(true);
      }
      expect(
        readdirSync(join(exported.directory, "images")).filter((file) =>
          file.endsWith(".svg"),
        ),
      ).toHaveLength(100);
      expect(
        readdirSync(join(exported.directory, "images")).filter((file) =>
          file.endsWith(".png"),
        ),
      ).toHaveLength(100);

      expect(report.cardCount).toBe(200);
      const html = readFileSync(report.htmlPath, "utf8");
      expect(html.match(/<article class="card"/g)).toHaveLength(200);
      expect(html.match(/data-slot-id="[^"]+"/g)).toHaveLength(200);
      expect(html).toContain("MOCK DATA");
      expect(html).not.toContain("FinalDecision");
      const manifest = JSON.parse(
        readFileSync(join(exported.directory, "manifest.json"), "utf8"),
      ) as {
        run: { runKind: string; evidenceKind: string };
        manifest: { slots: unknown[] };
      };
      expect(manifest.run).toMatchObject({
        runKind: "full",
        evidenceKind: "mock",
      });
      expect(manifest.manifest.slots).toHaveLength(200);
    },
    180_000,
  );

  it(
    "resumes a cancelled full run to 200 terminal slots without duplicating records",
    async () => {
      const db = openDatabase(join(tempDirectory, "resume.sqlite"));
      try {
        migrate(db);
        const cancellation = new RunCancellation();
        let commits = 0;
        const started = await runFull(db, 2, {
          cancellation,
          hooks: {
            onStageCommitted: () => {
              commits += 1;
              if (commits >= 4) {
                cancellation.stop("test");
              }
            },
          },
        });
        expect(started.result.status).toBe("cancelled");
        expect(started.result.cancellation?.reason).toBe("test");
        expect(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM slots WHERE run_id = ? AND stage = 'terminal'",
              )
              .get(started.runId) as { count: number }
          ).count,
        ).toBeLessThan(200);

        const transport = createMockTransport({
          db,
          clock: CLOCK,
          random: () => 0,
          deadlineMs: 30_000,
        });
        const resumed = await resumeMockExperiment({
          db,
          runId: started.runId,
          apiKey: "mock-offline-key",
          transport,
          concurrency: 2,
          clock: CLOCK,
        });
        expect(resumed.status).toBe("completed");
        expect(resumed.summary.slots).toBe(200);
        expect(resumed.summary.terminalSlots).toBe(200);
        expect(resumed.summary.unknownAttempts).toBe(0);
        expect(stageCounts(db, started.runId).terminal).toBe(200);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage = 'terminal'",
            )
            .get(started.runId),
        ).toEqual({ count: 200 });
        expect(
          db
            .prepare(
              "SELECT slot_id, role, COUNT(*) AS count FROM logical_calls WHERE run_id = ? GROUP BY slot_id, role HAVING COUNT(*) > 1",
            )
            .all(started.runId),
        ).toEqual([]);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM request_attempts WHERE state != 'validated'",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
    300_000,
  );
});
