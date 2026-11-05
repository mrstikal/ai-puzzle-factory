import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBudgetAccount,
  getBudgetAccount,
} from "../../src/ai/budget.js";
import {
  createMockTransport,
  type MockScenarioKind,
  type MockTransport,
} from "../../src/ai/mock.js";
import { main } from "../../src/cli/experiment.js";
import {
  CandidateDuplicateAssessmentSchema,
  WORKFLOW_STAGES,
  type CandidateDuplicateAssessment,
  type WorkflowStage,
} from "../../src/domain/candidate.js";
import { FAMILIES, LANES } from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import {
  PREPARATION_READY_STATUS,
  prepareSlot,
  type PreparationResult,
} from "../../src/runner/prepare-slot.js";
import {
  AlignmentReviewStagePayloadSchema,
  BlindReviewStagePayloadSchema,
  DuplicateCheckedStagePayloadSchema,
  TerminalStagePayloadSchema,
  recordDuplicateAssessment,
  reviewSlot,
} from "../../src/runner/review-slot.js";
import {
  buildMockRoutes,
  mockRoute,
  runSmokeMockExperiment,
} from "../../src/runner/run.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getEvents,
  getRun,
  getSlot,
  getStageResult,
  listSlots,
  listStageResults,
} from "../../src/storage/repository.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174050";
const ACCOUNT_ID = "p34-smoke-account";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p34-mock-secret-do-not-persist";

let tempDirectory: string;
let dbPath: string;
let db: Database.Database;
let mock: MockTransport;
let clock: {
  now(): Date;
  sleep(ms: number): Promise<void>;
};

function createClock(): {
  now(): Date;
  sleep(ms: number): Promise<void>;
} {
  let tick = Date.parse(CREATED_AT);
  return {
    now: () => {
      const value = new Date(tick);
      tick += 1000;
      return value;
    },
    sleep: async (_ms: number): Promise<void> => {},
  };
}

function run(options: {
  readonly preparationScenarios?: Readonly<
    Record<
      string,
      {
        readonly spec?: "valid" | "schema_invalid" | "refusal" | "http_error" | "timeout";
        readonly wording?: "valid" | "schema_invalid" | "refusal" | "http_error" | "timeout";
      }
    >
  >;
  readonly reviewScenarioKinds?: {
    readonly blind?: MockScenarioKind;
    readonly alignment?: MockScenarioKind;
  };
} = {}) {
  return runSmokeMockExperiment({
    db,
    runId: RUN_ID,
    accountId: ACCOUNT_ID,
    apiKey: API_KEY,
    transport: mock,
    maxCostUsd: "0",
    clock,
    ...options,
  });
}

function createBaseRun(): void {
  createRun(db, {
    runId: RUN_ID,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId: ACCOUNT_ID,
    runId: RUN_ID,
    runKind: "smoke",
    maxCostUsd: "0",
    createdAt: CREATED_AT,
  });
}

function prepareOne(slotId: string): Promise<PreparationResult> {
  return prepareSlot({
    db,
    runId: RUN_ID,
    slotId,
    accountId: ACCOUNT_ID,
    apiKey: API_KEY,
    transport: mock,
    routes: { spec: mockRoute("spec"), wording: mockRoute("wording") },
    reservations: { spec: "0.01", wording: "0.01" },
    clock,
  });
}

function assessmentFor(
  preparation: PreparationResult,
  outcome: "exact_duplicate" | "near_suspected" | "unique",
): CandidateDuplicateAssessment {
  const candidate = preparation.candidate;
  const fingerprint = candidate.fingerprint;
  if (fingerprint === null) {
    throw new Error("prepared candidate must carry a fingerprint");
  }
  return CandidateDuplicateAssessmentSchema.parse({
    slotId: candidate.slotId,
    slotOrdinal: candidate.slotOrdinal,
    family: candidate.family,
    modality: candidate.modality,
    lane: candidate.lane,
    eligible: true,
    fingerprintable: true,
    groupOwner: false,
    outcome,
    ownerSlotId: outcome === "exact_duplicate" ? "text-ranking-02" : null,
    duplicateKind: outcome === "exact_duplicate" ? "exact_content" : null,
    nearPairSlotIds: outcome === "near_suspected" ? ["text-ranking-02"] : [],
    failureCodes:
      outcome === "exact_duplicate"
        ? ["EXACT_DUPLICATE"]
        : outcome === "near_suspected"
          ? ["NEAR_DUPLICATE_SUSPECTED"]
          : [],
    terminalVerdict: null,
    specHash: fingerprint.specHash,
    structureHash: fingerprint.structureHash,
    contentHash: fingerprint.contentHash,
    renderHashes: fingerprint.renderHashes,
    canonicalStructure: fingerprint.canonicalStructure,
    features: fingerprint.features,
  });
}

function recordAssessment(
  preparation: PreparationResult,
  assessment: CandidateDuplicateAssessment,
): void {
  recordDuplicateAssessment({
    db,
    runId: RUN_ID,
    slotId: preparation.slotId,
    barrierResultHash: "a".repeat(64),
    assessment,
    startedAt: CREATED_AT,
    clock,
  });
}

function review(
  slotId: string,
  mockScenarioKinds?: {
    readonly blind?: MockScenarioKind;
    readonly alignment?: MockScenarioKind;
  },
) {
  const routes = buildMockRoutes();
  return reviewSlot({
    db,
    runId: RUN_ID,
    slotId,
    accountId: ACCOUNT_ID,
    apiKey: API_KEY,
    transport: mock,
    routes: {
      blindText: routes.blindText,
      blindVision: routes.blindVision,
      alignmentText: routes.alignmentText,
      alignmentVision: routes.alignmentVision,
    },
    reservations: { blind: "0.01", alignment: "0.01" },
    ...(mockScenarioKinds === undefined ? {} : { mockScenarioKinds }),
    clock,
  });
}

function orderedStages(slotId: string) {
  return listStageResults(db, RUN_ID, slotId).sort(
    (left, right) =>
      WORKFLOW_STAGES.indexOf(left.stage as WorkflowStage) -
      WORKFLOW_STAGES.indexOf(right.stage as WorkflowStage),
  );
}

function count(sql: string, ...params: unknown[]): number {
  return (
    db.prepare(sql).get(...params) as {
      count: number;
    }
  ).count;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p34-"));
  dbPath = join(tempDirectory, "experiment.sqlite");
  db = openDatabase(dbPath);
  migrate(db);
  clock = createClock();
  mock = createMockTransport({ db, clock, random: () => 0 });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // The CLI test may already have closed its own connection.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("serial smoke mock run", () => {
  it(
    "runs all 20 smoke slots through the barrier, both reviews, and terminal verdicts",
    async () => {
      const result = await run();

      expect(result.plan.slots).toHaveLength(20);
      expect(new Set(result.plan.slots.map((slot) => slot.family))).toEqual(
        new Set(FAMILIES),
      );
      expect(new Set(result.plan.slots.map((slot) => slot.lane))).toEqual(
        new Set(LANES),
      );
      expect(result.summary.verdicts).toEqual({
        approved: 20,
        rejected: 0,
        inconclusive: 0,
        generation_error: 0,
      });
      expect(result.summary.terminalSlots).toBe(20);
      expect(result.summary.callsByRole).toEqual({
        spec: 10,
        wording: 20,
        blind_text: 10,
        blind_vision: 10,
        alignment_text: 10,
        alignment_vision: 10,
      });
      expect(result.summary.attempts).toBe(70);
      expect(result.summary.unknownAttempts).toBe(0);
      expect(result.summary.cost).toEqual({
        actualCostUsd: "0",
        costStatus: "known",
      });
      expect(result.barrier.summary).toMatchObject({
        plannedSlots: 20,
        preparedSlots: 20,
        readyCandidates: 20,
        earlyFailures: 0,
        eligibleCandidates: 20,
        owners: 0,
        uniqueCandidates: 20,
        nearPairs: 0,
        exactDuplicates: 0,
        specDuplicates: 0,
        structuralDuplicates: 0,
        replacements: 0,
        terminalFailuresRewritten: 0,
      });
      expect(getRun(db, RUN_ID).controlState).toBe("completed");

      const slots = listSlots(db, RUN_ID);
      expect(slots).toHaveLength(20);
      for (const slot of slots) {
        expect(slot.stage).toBe("terminal");
        expect(slot.verdict).toBe("approved");
        expect(orderedStages(slot.slotId).map((stage) => stage.stage)).toEqual([
          "spec_ready",
          "formal_checked",
          "presentation_ready",
          "duplicate_checked",
          "blind_reviewed",
          "alignment_reviewed",
          "terminal",
        ]);
        for (const stage of orderedStages(slot.slotId)) {
          expect(stage.createdAt).toBe(stage.finishedAt);
        }
        const duplicate = DuplicateCheckedStagePayloadSchema.parse(
          getStageResult(db, RUN_ID, slot.slotId, "duplicate_checked").payload,
        );
        expect(duplicate.assessment.outcome).toBe("unique");
        expect(duplicate.barrierResultHash).toBe(result.barrier.resultHash);
        const blind = BlindReviewStagePayloadSchema.parse(
          getStageResult(db, RUN_ID, slot.slotId, "blind_reviewed").payload,
        );
        expect(blind.completed).toBe(true);
        expect(blind.role).toBe(
          slot.modality === "text" ? "blind_text" : "blind_vision",
        );
        expect(blind.choiceAgreement).toBe("agreed");
        expect(blind.expectedOption).not.toBeNull();
        expect(blind.failure).toBeNull();
        const alignment = AlignmentReviewStagePayloadSchema.parse(
          getStageResult(db, RUN_ID, slot.slotId, "alignment_reviewed").payload,
        );
        expect(alignment.completed).toBe(true);
        expect(alignment.role).toBe(
          slot.modality === "text" ? "alignment_text" : "alignment_vision",
        );
        expect(alignment.derivedOverall).toBe("pass");
        expect(alignment.failure).toBeNull();
        const terminal = TerminalStagePayloadSchema.parse(
          getStageResult(db, RUN_ID, slot.slotId, "terminal").payload,
        );
        expect(terminal.verdict).toBe("approved");
        expect(terminal.primaryFailure).toBeNull();
        expect(terminal.failures).toEqual([]);
        expect(terminal.proceed).toBe(true);
      }

      const events = getEvents(db, RUN_ID);
      const barrierEvent = events.find(
        (event) => event.eventType === "duplicate_barrier",
      );
      expect(barrierEvent).toBeDefined();
      expect(events.some((event) => event.eventType === "run_completed")).toBe(
        true,
      );
      const reviewCalls = db
        .prepare(
          "SELECT role, created_at FROM logical_calls WHERE run_id = ? AND role IN ('blind_text','blind_vision','alignment_text','alignment_vision') ORDER BY created_at",
        )
        .all(RUN_ID) as Array<{ role: string; created_at: string }>;
      expect(reviewCalls).toHaveLength(40);
      for (const call of reviewCalls) {
        expect(Date.parse(call.created_at)).toBeGreaterThanOrEqual(
          Date.parse(barrierEvent?.createdAt as string),
        );
      }
      for (const slot of slots) {
        const duplicate = getStageResult(
          db,
          RUN_ID,
          slot.slotId,
          "duplicate_checked",
        );
        const blind = getStageResult(
          db,
          RUN_ID,
          slot.slotId,
          "blind_reviewed",
        );
        expect(Date.parse(duplicate.createdAt)).toBeLessThanOrEqual(
          Date.parse(blind.createdAt),
        );
      }

      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ?",
          RUN_ID,
        ),
      ).toBe(70);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND state != 'validated'",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?)",
          RUN_ID,
        ),
      ).toBe(70);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND (state != 'validated' OR actual_cost_usd != '0' OR cost_status != 'known')",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM budget_reservations WHERE account_id = ? AND (kind != 'nonbilling' OR state != 'settled' OR amount_usd != '0' OR actual_cost_usd != '0')",
          ACCOUNT_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM budget_reservations WHERE account_id = ?",
          ACCOUNT_ID,
        ),
      ).toBe(70);
      const account = getBudgetAccount(db, ACCOUNT_ID);
      expect(account.knownActualUsd).toBe("0");
      expect(account.reservedUsd).toBe("0");
      expect(account.unknownExposureUsd).toBe("0");
      expect(
        count("SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ?", RUN_ID),
      ).toBe(140);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_artifacts WHERE run_id = ?",
          RUN_ID,
        ),
      ).toBe(30);
      expect(
        count("SELECT COUNT(*) AS count FROM artifacts WHERE kind IN ('html', 'json')"),
      ).toBe(0);
      expect(events.some((event) => event.eventType.startsWith("report"))).toBe(
        false,
      );
      expect(mock.requests).toHaveLength(70);
      for (const request of mock.requests) {
        expect(request.body).not.toContain("mockScenario");
        expect(request.body).not.toContain("oracle");
        expect(request.body).not.toContain(API_KEY);
      }
    },
    180_000,
  );

  it(
    "preserves an early failure while reviewing the remaining 19 slots",
    async () => {
      const result = await run({
        preparationScenarios: {
          "text-ranking-02": { spec: "schema_invalid" },
        },
      });

      expect(result.summary.verdicts).toEqual({
        approved: 19,
        rejected: 0,
        inconclusive: 0,
        generation_error: 1,
      });
      expect(result.summary.callsByRole).toEqual({
        spec: 10,
        wording: 19,
        blind_text: 9,
        blind_vision: 10,
        alignment_text: 9,
        alignment_vision: 10,
      });
      expect(result.summary.attempts).toBe(67);
      expect(result.barrier.summary).toMatchObject({
        plannedSlots: 20,
        readyCandidates: 19,
        earlyFailures: 1,
        uniqueCandidates: 19,
      });
      const failed = getSlot(db, RUN_ID, "text-ranking-02");
      expect(failed.stage).toBe("terminal");
      expect(failed.verdict).toBe("generation_error");
      expect(orderedStages("text-ranking-02").map((stage) => stage.stage)).toEqual([
        "terminal",
      ]);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND slot_id = 'text-ranking-02'",
          RUN_ID,
        ),
      ).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND slot_id = 'text-ranking-02' AND role = 'spec'",
          RUN_ID,
        ),
      ).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND slot_id = 'text-ranking-02' AND stage IN ('duplicate_checked','blind_reviewed','alignment_reviewed')",
          RUN_ID,
        ),
      ).toBe(0);
      const preserved = result.reviews.find(
        (reviewResult) => reviewResult.slotId === "text-ranking-02",
      );
      expect(preserved?.status).toBe("preserved");
      expect(preserved?.verdict).toBe("generation_error");
      expect(getRun(db, RUN_ID).controlState).toBe("completed");
      expect(
        count(
          "SELECT COUNT(*) AS count FROM slots WHERE run_id = ? AND stage = 'terminal' AND verdict IS NOT NULL",
          RUN_ID,
        ),
      ).toBe(20);
    },
    180_000,
  );

  it("skips both reviews for a confirmed duplicate", async () => {
    createBaseRun();
    const preparation = await prepareOne("text-ranking-01");
    expect(preparation.status).toBe(PREPARATION_READY_STATUS);
    recordAssessment(preparation, assessmentFor(preparation, "exact_duplicate"));
    const requestsBefore = mock.requests.length;

    const result = await review("text-ranking-01");
    if (result.status !== "reviewed") {
      throw new Error("expected a reviewed duplicate outcome");
    }

    expect(result.status).toBe("reviewed");
    expect(result.verdict).toBe("rejected");
    expect(result.blind).toBeNull();
    expect(result.alignment).toBeNull();
    expect(mock.requests).toHaveLength(requestsBefore);
    expect(orderedStages("text-ranking-01").map((stage) => stage.stage)).toEqual([
      "spec_ready",
      "formal_checked",
      "presentation_ready",
      "duplicate_checked",
      "terminal",
    ]);
    const terminal = TerminalStagePayloadSchema.parse(
      getStageResult(db, RUN_ID, "text-ranking-01", "terminal").payload,
    );
    expect(terminal.primaryFailure).toBe("EXACT_DUPLICATE");
    expect(terminal.failures.map((failure) => failure.code)).toContain(
      "EXACT_DUPLICATE",
    );
    expect(
      count(
        "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND slot_id = 'text-ranking-01'",
        RUN_ID,
      ),
    ).toBe(1);
  });

  it("reviews a near-suspected candidate twice and keeps it inconclusive", async () => {
    createBaseRun();
    const preparation = await prepareOne("text-ranking-01");
    recordAssessment(preparation, assessmentFor(preparation, "near_suspected"));
    const requestsBefore = mock.requests.length;

    const result = await review("text-ranking-01");
    if (result.status !== "reviewed") {
      throw new Error("expected a reviewed near-suspected outcome");
    }

    expect(result.status).toBe("reviewed");
    expect(result.verdict).toBe("inconclusive");
    expect(result.blind?.completed).toBe(true);
    expect(result.blind?.choiceAgreement).toBe("agreed");
    expect(result.alignment?.completed).toBe(true);
    expect(result.alignment?.derivedOverall).toBe("pass");
    expect(mock.requests).toHaveLength(requestsBefore + 2);
    expect(result.terminal.primaryFailure).toBe("NEAR_DUPLICATE_SUSPECTED");
    expect(
      result.terminal.failures.map((failure) => failure.code),
    ).toContain("NEAR_DUPLICATE_SUSPECTED");
    expect(
      result.terminal.failures.map((failure) => failure.code),
    ).not.toContain("REVIEWER_DISAGREES");
    expect(orderedStages("text-ranking-01").map((stage) => stage.stage)).toEqual([
      "spec_ready",
      "formal_checked",
      "presentation_ready",
      "duplicate_checked",
      "blind_reviewed",
      "alignment_reviewed",
      "terminal",
    ]);
  });

  it("still runs alignment after a blind disagreement", async () => {
    createBaseRun();
    const preparation = await prepareOne("text-ranking-01");
    recordAssessment(preparation, assessmentFor(preparation, "unique"));
    const requestsBefore = mock.requests.length;

    const result = await review("text-ranking-01", { blind: "wrong_answer" });
    if (result.status !== "reviewed") {
      throw new Error("expected a reviewed disagreement outcome");
    }

    expect(result.status).toBe("reviewed");
    expect(result.verdict).toBe("inconclusive");
    expect(result.blind?.completed).toBe(true);
    expect(result.blind?.choiceAgreement).toBe("disagreed");
    expect(result.alignment?.completed).toBe(true);
    expect(result.alignment?.derivedOverall).toBe("pass");
    expect(mock.requests).toHaveLength(requestsBefore + 2);
    expect(result.terminal.primaryFailure).toBe("REVIEWER_DISAGREES");
    expect(
      result.terminal.failures.map((failure) => failure.code),
    ).toContain("REVIEWER_DISAGREES");
  });

  it("rejects a second run with the same UUID instead of resuming", async () => {
    createBaseRun();
    await expect(run()).rejects.toMatchObject({ code: "DUPLICATE_RUN" });
    expect(
      count(
        "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ?",
        RUN_ID,
      ),
    ).toBe(0);
    expect(listSlots(db, RUN_ID)).toHaveLength(20);
  });

  it(
    "executes the smoke mock CLI and prints a reopenable run UUID",
    async () => {
      const cliPath = join(tempDirectory, "cli.sqlite");
      const writes: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          writes.push(String(chunk));
          return true;
        });
      let exitCode: number;
      try {
        exitCode = await main([
          "node",
          "experiment",
          "--smoke",
          "--mock",
          "--seed",
          "puzzle-smoke-v1",
          "--max-cost",
          "0",
          "--db",
          cliPath,
        ]);
      } finally {
        stdout.mockRestore();
      }
      expect(exitCode).toBe(0);
      const output = writes.join("");
      expect(output).toContain("slots 20/20 terminal");
      expect(output).toContain("verdicts approved=20");
      expect(output).toContain("cost status=known actual=0");
      const match = /^run ([0-9a-f-]{36})$/m.exec(output);
      expect(match).not.toBeNull();
      const runId = match?.[1] as string;
      const cliDb = openDatabase(cliPath);
      try {
        const slots = listSlots(cliDb, runId);
        expect(slots).toHaveLength(20);
        expect(slots.every((slot) => slot.stage === "terminal")).toBe(true);
        expect(
          slots.filter((slot) => slot.verdict === "approved"),
        ).toHaveLength(20);
        expect(getRun(cliDb, runId).controlState).toBe("completed");
      } finally {
        cliDb.close();
      }
    },
    180_000,
  );

  it("rejects full, live, resume, invalid cost, and mismatched seeds explicitly", async () => {
    const rejectDb = join(tempDirectory, "reject.sqlite");
    const stderr: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
    try {
      await expect(
        main(["node", "experiment", "--full", "--mock", "--db", rejectDb]),
      ).resolves.toBe(1);
      await expect(
        main(["node", "experiment", "--smoke", "--live", "--db", rejectDb]),
      ).resolves.toBe(1);
      await expect(
        main([
          "node",
          "experiment",
          "--smoke",
          "--mock",
          "--resume",
          "--db",
          rejectDb,
        ]),
      ).resolves.toBe(1);
      await expect(
        main([
          "node",
          "experiment",
          "--smoke",
          "--mock",
          "--max-cost",
          "abc",
          "--db",
          rejectDb,
        ]),
      ).resolves.toBe(1);
      await expect(
        main([
          "node",
          "experiment",
          "--smoke",
          "--mock",
          "--seed",
          "puzzle-poc-v1",
          "--db",
          rejectDb,
        ]),
      ).resolves.toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
    const text = stderr.join("");
    expect(text).toContain("P34 execution supports only --smoke --mock");
    expect(text).toContain("live execution is not implemented");
    expect(text).toContain("resume is not implemented until P36");
    expect(text).toContain("--max-cost must be a non-negative decimal USD string");
    expect(text).toContain("fixed to puzzle-smoke-v1");
    expect(existsSync(rejectDb)).toBe(false);
  });
});
