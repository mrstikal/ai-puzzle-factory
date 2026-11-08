import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, migrate } from "../../src/storage/database.js";
import { createMockTransport } from "../../src/ai/mock.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import {
  runDesignerCohort,
  type DesignerRunConfig,
  type DesignerRunHooks,
} from "../../src/design/run.js";
import {
  getOrCreatePreparedAttempt,
  markAttemptDispatching,
  listAttempts,
} from "../../src/ai/ledger.js";
import { admitRequest } from "../../src/ai/budget.js";
import {
  getDesignerSlot,
  listDesignAttempts,
  listDesignerStageResults,
  setRunControlState,
} from "../../src/storage/repository.js";
import {
  buildCohortReference,
  buildFrozenReference,
} from "../../src/design/baseline.js";
import {
  loadDesignerCohortMetrics,
} from "../../src/reporting/design-metrics.js";
import type { DesignerPlanManifest } from "../../src/domain/design.js";
import {
  DesignerConfigurationSnapshotSchema,
} from "../../src/design/freeze.js";

const PILOT_PLAN = buildDesignerPlanManifest({ runKind: "design_pilot" });
const PRIMARY_PLAN = buildDesignerPlanManifest({ runKind: "design_primary" });
const FEEDBACK_SLOT = "design-text-ranking-01-ai_feedback";

const CONFIG: DesignerRunConfig = {
  model: "mock/model",
  outputCapField: "max_tokens",
  maxOutputTokens: 8192,
  skinEnabled: true,
  reservationUsd: "0.01",
  nonBilling: true,
};

interface Harness {
  readonly db: Database.Database;
  readonly directory: string;
  readonly runId: string;
  readonly accountId: string;
  readonly plan: DesignerPlanManifest;
  close(): void;
}

const harnesses: Harness[] = [];

function harness(plan: DesignerPlanManifest = PILOT_PLAN): Harness {
  const directory = mkdtempSync(join(tmpdir(), "designer-resume-"));
  const db = openDatabase(join(directory, "test.sqlite"));
  migrate(db);
  const value: Harness = {
    db,
    directory,
    runId: randomUUID(),
    accountId: randomUUID(),
    plan,
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harnesses.push(value);
  return value;
}

function runInput(
  h: Harness,
  transport: ReturnType<typeof createMockTransport>,
  options: {
    readonly slotIds?: readonly string[];
    readonly concurrency?: 1 | 2;
    readonly resume?: boolean;
    readonly hooks?: DesignerRunHooks;
  } = {},
) {
  return runDesignerCohort({
    db: h.db,
    runId: h.runId,
    plan: h.plan,
    evidenceKind: "mock",
    apiKey: "mock",
    transport,
    accountId: h.accountId,
    maxCostUsd: "0",
    config: CONFIG,
    concurrency: options.concurrency ?? 1,
    ...(options.slotIds === undefined ? {} : { slotIds: options.slotIds }),
    ...(options.resume === true ? { resume: true } : {}),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
}

function withoutLatency<T extends { readonly latency: unknown }>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "latency"),
  );
}

beforeAll(() => {
  expect(PILOT_PLAN.assignments).toHaveLength(20);
  expect(PRIMARY_PLAN.assignments).toHaveLength(100);
}, 120_000);

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

describe("P50.1 designer mock scenarios", () => {
  it("covers accepted, repaired, all-repairs-fail, solver-limit, render-failure, and generation-error outcomes", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    const result = await runInput(h, transport);
    expect(result.status).toBe("completed");
    expect(result.slots).toHaveLength(60);
    expect(result.slots.every((slot) => slot.stage === "terminal")).toBe(true);

    const attempts = result.slots.flatMap((slot) =>
      listDesignAttempts(h.db, h.runId, slot.slotId),
    );
    const baselineAttempts = attempts.filter((attempt) => attempt.arm === "baseline");
    expect(baselineAttempts).toHaveLength(20);
    expect(baselineAttempts.every((attempt) => attempt.logicalCallId === null)).toBe(
      true,
    );
    expect(attempts.length).toBeLessThanOrEqual(400);
    expect(transport.requests.length).toBeLessThanOrEqual(400);

    expect(
      attempts.some(
        (attempt) => attempt.verdict === "accepted" && attempt.attemptIndex === 0,
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) => attempt.attemptIndex === 1 && attempt.verdict === "accepted",
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) =>
          attempt.attemptIndex === 2 &&
          (attempt.verdict === "rejected" || attempt.verdict === "inconclusive"),
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) => attempt.diagnostic?.errorCode === "SOLVER_LIMIT",
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) => attempt.diagnostic?.errorCode === "SVG_RENDER_INVALID",
      ),
    ).toBe(true);
    expect(
      attempts.some((attempt) => attempt.verdict === "generation_error"),
    ).toBe(true);
    expect(
      attempts.some((attempt) => attempt.diagnostic?.errorCode === "SCHEMA_INVALID"),
    ).toBe(true);
    expect(
      attempts.some((attempt) => attempt.diagnostic?.errorCode === "UNSAT"),
    ).toBe(true);

    const generationErrorSlots = result.slots.filter(
      (slot) => slot.verdict === "generation_error",
    );
    for (const slot of generationErrorSlots) {
      expect(listDesignAttempts(h.db, h.runId, slot.slotId)).toHaveLength(1);
    }
  }, 240_000);

  it("keeps first and final attempt evidence separate", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    await runInput(h, transport);
    const feedback = getDesignerSlot(h.db, h.runId, FEEDBACK_SLOT);
    expect(feedback.verdict).toBe("accepted");
    const attempts = listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.verdict).not.toBe("accepted");
    expect(attempts[1]?.verdict).toBe("accepted");
    expect(attempts[0]?.proposalArtifactId).not.toBe(attempts[1]?.proposalArtifactId);
    expect(
      listDesignerStageResults(h.db, h.runId, FEEDBACK_SLOT).map(
        (stage) => stage.stage,
      ),
    ).toEqual([
      "design_proposed",
      "formal_checked",
      "presentation_ready",
      "terminal",
    ]);
  }, 240_000);
});

describe("P50.1 designer resume crash windows", () => {
  it("resumes a prepared call after a crash before dispatch", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    let crashed = false;
    await expect(
      runInput(h, transport, {
        slotIds: [FEEDBACK_SLOT],
        hooks: {
          faults: {
            beforeDispatch: () => {
              if (!crashed) {
                crashed = true;
                throw new Error("crash before dispatch");
              }
            },
          },
        },
      }),
    ).rejects.toThrow("crash before dispatch");
    expect(transport.requests).toHaveLength(0);

    const result = await runInput(h, transport, {
      slotIds: [FEEDBACK_SLOT],
      resume: true,
    });
    expect(result.status).toBe("completed");
    const attempts = listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.verdict).toBe("accepted");
    expect(transport.requests).toHaveLength(2);
  }, 120_000);

  it("never resends a dispatching call without a saved response", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    await expect(
      runInput(h, transport, {
        slotIds: [FEEDBACK_SLOT],
        hooks: {
          faults: {
            beforeDispatch: () => {
              throw new Error("crash before dispatch");
            },
          },
        },
      }),
    ).rejects.toThrow("crash before dispatch");
    const call = h.db
      .prepare("SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ? AND role = 'design'")
      .get(h.runId, FEEDBACK_SLOT) as { logical_call_id: string };
    const attempt = getOrCreatePreparedAttempt(
      h.db,
      call.logical_call_id,
      new Date().toISOString(),
    );
    setRunControlState(h.db, h.runId, "running");
    const admitted = admitRequest(h.db, {
      accountId: h.accountId,
      logicalCallId: call.logical_call_id,
      attemptId: attempt.attemptId,
      kind: "nonbilling",
      amountUsd: "0",
      nonBilling: true,
    });
    expect(admitted.admitted).toBe(true);
    markAttemptDispatching(
      h.db,
      attempt.attemptId,
      new Date().toISOString(),
    );

    const result = await runInput(h, transport, {
      slotIds: [FEEDBACK_SLOT],
      resume: true,
    });
    expect(result.status).toBe("completed");
    expect(transport.requests).toHaveLength(0);
    const attempts = listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.verdict).toBe("inconclusive");
    expect(attempts[0]?.diagnostic?.errorCode).toBe("INFRASTRUCTURE_ERROR");
    expect(attempts[0]?.costStatus).toBe("unknown");
  }, 120_000);

  it("reuses a saved first response without dispatching it again", async () => {
    const h = harness();
    let crash = true;
    const transport = createMockTransport({
      db: h.db,
      afterResponseSaved: () => {
        if (crash) {
          crash = false;
          throw new Error("crash after response save");
        }
      },
    });
    await expect(
      runInput(h, transport, { slotIds: [FEEDBACK_SLOT] }),
    ).rejects.toThrow("crash after response save");
    expect(transport.requests).toHaveLength(1);
    const saved = listAttempts(
      h.db,
      (
        h.db
          .prepare("SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ? AND role = 'design'")
          .get(h.runId, FEEDBACK_SLOT) as { logical_call_id: string }
      ).logical_call_id,
    );
    expect(saved.some((attempt) => attempt.state === "response_saved")).toBe(true);
    const beforeResumeHashes = h.db
      .prepare("SELECT request_hash FROM logical_calls WHERE run_id = ? AND slot_id = ? ORDER BY role")
      .all(h.runId, FEEDBACK_SLOT) as Array<{ request_hash: string }>;

    const result = await runInput(h, transport, {
      slotIds: [FEEDBACK_SLOT],
      resume: true,
    });
    expect(result.status).toBe("completed");
    expect(transport.requests).toHaveLength(2);
    const afterResumeHashes = h.db
      .prepare("SELECT request_hash FROM logical_calls WHERE run_id = ? AND slot_id = ? ORDER BY role")
      .all(h.runId, FEEDBACK_SLOT) as Array<{ request_hash: string }>;
    expect(afterResumeHashes[0]?.request_hash).toBe(beforeResumeHashes[0]?.request_hash);
    const attempts = listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.verdict).toBe("accepted");
  }, 120_000);

  it("continues to repair after a crash after the first attempt commit", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    let crashed = false;
    await expect(
      runInput(h, transport, {
        slotIds: [FEEDBACK_SLOT],
        hooks: {
          faults: {
            afterAttemptCommit: () => {
              if (!crashed) {
                crashed = true;
                throw new Error("crash after attempt commit");
              }
            },
          },
        },
      }),
    ).rejects.toThrow("crash after attempt commit");
    expect(listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT)).toHaveLength(1);

    const result = await runInput(h, transport, {
      slotIds: [FEEDBACK_SLOT],
      resume: true,
    });
    expect(result.status).toBe("completed");
    const attempts = listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.verdict).toBe("accepted");
    expect(transport.requests).toHaveLength(2);
  }, 120_000);

  it("commits terminal evidence after a crash after the repair response", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    let crashed = false;
    await expect(
      runInput(h, transport, {
        slotIds: [FEEDBACK_SLOT],
        hooks: {
          faults: {
            afterRepairResponse: () => {
              if (!crashed) {
                crashed = true;
                throw new Error("crash after repair response");
              }
            },
          },
        },
      }),
    ).rejects.toThrow("crash after repair response");
    expect(listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT)).toHaveLength(1);
    expect(transport.requests).toHaveLength(2);

    const result = await runInput(h, transport, {
      slotIds: [FEEDBACK_SLOT],
      resume: true,
    });
    expect(result.status).toBe("completed");
    expect(transport.requests).toHaveLength(2);
    const attempts = listDesignAttempts(h.db, h.runId, FEEDBACK_SLOT);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.verdict).toBe("accepted");
    expect(getDesignerSlot(h.db, h.runId, FEEDBACK_SLOT).stage).toBe("terminal");
  }, 120_000);
});

describe("P50.1 designer resume identity checks", () => {
  it("preserves a solver-limit simulation when resuming with a fresh mock transport", async () => {
    const h = harness();
    const slotId = "design-text-scheduling-01-ai_feedback";
    let crash = true;
    const firstTransport = createMockTransport({
      db: h.db,
      afterResponseSaved: () => {
        if (crash) {
          crash = false;
          throw new Error("crash after solver-limit response");
        }
      },
    });
    await expect(
      runInput(h, firstTransport, { slotIds: [slotId] }),
    ).rejects.toThrow("crash after solver-limit response");
    const secondTransport = createMockTransport({ db: h.db });
    const result = await runInput(h, secondTransport, {
      slotIds: [slotId],
      resume: true,
    });
    expect(result.status).toBe("completed");
    const attempts = listDesignAttempts(h.db, h.runId, slotId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.diagnostic?.errorCode).toBe("SOLVER_LIMIT");
    expect(attempts[1]?.verdict).toBe("accepted");
    expect(secondTransport.requests).toHaveLength(1);
  }, 120_000);

  it("rejects resume with a changed stored configuration snapshot", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    const snapshot = (model: string) =>
      DesignerConfigurationSnapshotSchema.parse({
        model,
        routingPolicy: "balanced",
        providerSort: "default",
        byokProviderKeysConfigured: false,
        outputCapField: "max_tokens",
        maxOutputTokens: 8192,
        concurrency: 1,
        settingsMode: "default",
        settings: null,
        promptsHash: "a".repeat(64),
        schemaHash: "a".repeat(64),
        sourceHash: "a".repeat(64),
        fontHash: "a".repeat(64),
        referenceHash: "a".repeat(64),
        cohortHash: "a".repeat(64),
        dependencyLockHash: "a".repeat(64),
        templateHash: "a".repeat(64),
        comparatorHash: "a".repeat(64),
        metricsHash: "a".repeat(64),
        decisionEvaluatorHash: "a".repeat(64),
        humanRubricHash: "a".repeat(64),
      });
    await expect(
      runDesignerCohort({
        db: h.db,
        runId: h.runId,
        plan: h.plan,
        evidenceKind: "mock",
        apiKey: "mock",
        transport,
        accountId: h.accountId,
        maxCostUsd: "0",
        config: CONFIG,
        concurrency: 1,
        slotIds: [FEEDBACK_SLOT],
        configurationSnapshot: snapshot("mock/model"),
        hooks: {
          faults: {
            beforeDispatch: () => {
              throw new Error("crash before dispatch");
            },
          },
        },
      }),
    ).rejects.toThrow("crash before dispatch");
    await expect(
      runDesignerCohort({
        db: h.db,
        runId: h.runId,
        plan: h.plan,
        evidenceKind: "mock",
        apiKey: "mock",
        transport,
        accountId: h.accountId,
        maxCostUsd: "0",
        config: CONFIG,
        concurrency: 1,
        slotIds: [FEEDBACK_SLOT],
        configurationSnapshot: snapshot("other/model"),
        resume: true,
      }),
    ).rejects.toThrow(/configuration differs/);
  }, 120_000);

  it("rejects reuse of an existing logical call with a different model", async () => {
    const h = harness();
    const transport = createMockTransport({ db: h.db });
    await expect(
      runInput(h, transport, {
        slotIds: [FEEDBACK_SLOT],
        hooks: {
          faults: {
            beforeDispatch: () => {
              throw new Error("crash before dispatch");
            },
          },
        },
      }),
    ).rejects.toThrow("crash before dispatch");
    await expect(
      runDesignerCohort({
        db: h.db,
        runId: h.runId,
        plan: h.plan,
        evidenceKind: "mock",
        apiKey: "mock",
        transport,
        accountId: h.accountId,
        maxCostUsd: "0",
        config: { ...CONFIG, model: "other/model" },
        concurrency: 1,
        slotIds: [FEEDBACK_SLOT],
        resume: true,
      }),
    ).rejects.toThrow(/does not match the current model/);
  }, 120_000);
});

describe("P50.1 deterministic metrics", () => {
  it("produces the same novelty annotations and counts at concurrency 1 and 2", async () => {
    const slotIds = PILOT_PLAN.candidates
      .filter((candidate) => candidate.assignmentOrdinal <= 4)
      .map((candidate) => candidate.candidateSlotId);
    const frozen = buildFrozenReference();
    const cohort = buildCohortReference(PRIMARY_PLAN);

    const first = harness();
    const firstTransport = createMockTransport({ db: first.db });
    await runInput(first, firstTransport, { slotIds, concurrency: 1 });
    const firstMetrics = loadDesignerCohortMetrics(first.db, first.runId, {
      frozen,
      cohort,
    });

    const second = harness();
    const secondTransport = createMockTransport({ db: second.db });
    await runInput(second, secondTransport, { slotIds, concurrency: 2 });
    const secondMetrics = loadDesignerCohortMetrics(second.db, second.runId, {
      frozen,
      cohort,
    });

    expect({
      baseline: withoutLatency(firstMetrics.arms.baseline),
      ai_one_shot: withoutLatency(firstMetrics.arms.ai_one_shot),
      ai_feedback: withoutLatency(firstMetrics.arms.ai_feedback),
    }).toEqual({
      baseline: withoutLatency(secondMetrics.arms.baseline),
      ai_one_shot: withoutLatency(secondMetrics.arms.ai_one_shot),
      ai_feedback: withoutLatency(secondMetrics.arms.ai_feedback),
    });
    expect(firstMetrics.novelty).toEqual(secondMetrics.novelty);
    expect(
      firstMetrics.strata.byFamilyArm.map((row) => ({
        key: row.key,
        firstAccepted: row.firstAccepted,
        finalAccepted: row.finalAccepted,
        novelAccepted: row.novelAccepted,
      })),
    ).toEqual(
      secondMetrics.strata.byFamilyArm.map((row) => ({
        key: row.key,
        firstAccepted: row.firstAccepted,
        finalAccepted: row.finalAccepted,
        novelAccepted: row.novelAccepted,
      })),
    );
  }, 240_000);
});
