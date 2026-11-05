import type Database from "better-sqlite3";
import {
  getBudgetAccount,
  increaseBudgetCap,
} from "../ai/budget.js";
import {
  LedgerError,
  getLogicalCall,
  listAttempts,
  markAttemptUncertain,
  type LogicalCall,
  type RequestAttempt,
} from "../ai/ledger.js";
import {
  replaySavedResponse,
  type OpenRouterAttemptResult,
  type OpenRouterCallResult,
  type createOpenRouterTransport,
} from "../ai/openrouter.js";
import type { PlanManifest } from "../domain/experiment.js";
import { buildPlanManifest } from "../experiment/planner.js";
import {
  getRun,
  setRunControlState,
} from "../storage/repository.js";
import { StorageError } from "../storage/database.js";
import {
  buildMockRoutes,
  runSmokeCohort,
  type MockRoutes,
  type RunSmokeHooks,
  type RunSmokeMockResult,
} from "./run.js";
import type { RunCancellation } from "./cancel.js";
import type { Concurrency } from "./workers.js";

export type ResumeErrorCode =
  | "INVALID_INPUT"
  | "RUN_NOT_FOUND"
  | "UNSUPPORTED_RUN_KIND"
  | "ALREADY_COMPLETED"
  | "ACCOUNT_NOT_FOUND"
  | "MODE_MISMATCH"
  | "MANIFEST_MISMATCH"
  | "BUDGET_INCREASE_REQUIRED"
  | "BUDGET_INCREASE_UNAUTHORIZED"
  | "CONFIG_MISMATCH";

export class ResumeError extends Error {
  readonly code: ResumeErrorCode;

  constructor(code: ResumeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResumeError";
    this.code = code;
  }
}

export interface ResumeHooks extends RunSmokeHooks {
  readonly onBeforeExecute?: (logicalCallId: string) => Promise<void> | void;
}

export interface ResumeBudgetIncrease {
  readonly newMaxCostUsd: string;
  readonly operator: string;
  readonly acknowledged: boolean;
}

export interface ResumeSmokeInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport> & {
    readonly isMock?: true;
  };
  readonly routes?: MockRoutes;
  readonly clock?: { now(): Date };
  readonly concurrency?: Concurrency;
  readonly cancellation?: RunCancellation;
  readonly drainTimeoutMs?: number;
  readonly yieldBetweenJobs?: () => Promise<void>;
  readonly budgetIncrease?: ResumeBudgetIncrease;
  readonly hooks?: ResumeHooks;
}

function nowIso(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

function uncertainResult(
  call: LogicalCall,
  attempts: readonly RequestAttempt[],
): OpenRouterCallResult {
  const last = attempts.at(-1);
  const attemptResults: OpenRouterAttemptResult[] = attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    httpStatus: attempt.httpStatus,
    outcome: "uncertain",
    errorCode: "RESUME_UNCERTAIN",
    errorMessage:
      "dispatching call has no saved response and was not resent",
    retryDelayMs: null,
    responseArtifactId: attempt.rawResponseArtifactId,
    generationId: attempt.generationId,
    actualCostUsd: attempt.actualCostUsd,
    costStatus: attempt.costStatus,
  }));
  return {
    logicalCallId: call.logicalCallId,
    outcome: "uncertain",
    content: null,
    parsedContent: null,
    usage: {
      promptTokens: last?.promptTokens ?? null,
      completionTokens: last?.completionTokens ?? null,
      totalTokens: last?.totalTokens ?? null,
      cachedReadTokens: last?.cachedReadTokens ?? null,
      cachedWriteTokens: last?.cachedWriteTokens ?? null,
      reasoningTokens: last?.reasoningTokens ?? null,
    },
    generationId: last?.generationId ?? null,
    actualCostUsd: last?.actualCostUsd ?? null,
    costStatus: last?.costStatus ?? "unknown",
    attempts: attemptResults,
    error: {
      code: "RESUME_UNCERTAIN",
      message: "dispatching call has no saved response and was not resent",
    },
  };
}

export function createResumeTransport(
  transport: ReturnType<typeof createOpenRouterTransport> & {
    readonly isMock?: true;
  },
  db: Database.Database,
  hooks?: ResumeHooks,
): ReturnType<typeof createOpenRouterTransport> {
  return {
    ...transport,
    executeCall: async (input) => {
      const call = getLogicalCall(db, input.logicalCallId);
      if (call.state === "prepared" || call.state === "refused_unprocessed") {
        await hooks?.onBeforeExecute?.(call.logicalCallId);
        return transport.executeCall(input);
      }
      if (call.state === "dispatching") {
        const at = new Date().toISOString();
        for (const attempt of listAttempts(db, call.logicalCallId)) {
          if (attempt.state !== "dispatching") {
            continue;
          }
          try {
            markAttemptUncertain(
              db,
              attempt.attemptId,
              "RESUME_UNCERTAIN",
              at,
            );
          } catch (error) {
            if (
              !(error instanceof LedgerError) ||
              error.code !== "INVALID_STATE"
            ) {
              throw error;
            }
          }
        }
        return uncertainResult(call, listAttempts(db, call.logicalCallId));
      }
      if (
        call.state === "response_saved" ||
        call.state === "validated" ||
        call.state === "failed_known" ||
        call.state === "uncertain"
      ) {
        const attempts = listAttempts(db, call.logicalCallId);
        const attempt =
          attempts.find((candidate) => candidate.state === "response_saved") ??
          attempts.at(-1);
        if (attempt === undefined || attempt.rawResponseArtifactId === null) {
          return uncertainResult(call, attempts);
        }
        return replaySavedResponse(db, attempt.attemptId, input.apiKey);
      }
      throw new ResumeError(
        "INVALID_INPUT",
        `logical call ${call.logicalCallId} cannot resume from ${call.state}`,
      );
    },
    reconcileGeneration: transport.reconcileGeneration,
  };
}

function findAccountId(db: Database.Database, runId: string): string {
  const row = db
    .prepare(
      "SELECT account_id FROM budget_accounts WHERE run_id = ? AND run_kind = 'smoke' LIMIT 1",
    )
    .get(runId) as { account_id: string } | undefined;
  if (row === undefined) {
    throw new ResumeError(
      "ACCOUNT_NOT_FOUND",
      `smoke budget account not found for run ${runId}`,
    );
  }
  return row.account_id;
}

export async function resumeSmokeExperiment(
  input: ResumeSmokeInput,
): Promise<RunSmokeMockResult> {
  let run: ReturnType<typeof getRun>;
  try {
    run = getRun(input.db, input.runId);
  } catch (error) {
    if (error instanceof StorageError && error.code === "INVALID_STORED_DATA") {
      throw new ResumeError(
        "MANIFEST_MISMATCH",
        "stored run manifest is invalid or no longer matches its columns",
        { cause: error },
      );
    }
    throw new ResumeError(
      "RUN_NOT_FOUND",
      `run not found: ${input.runId}`,
      { cause: error },
    );
  }
  if (run.runKind !== "smoke") {
    throw new ResumeError(
      "UNSUPPORTED_RUN_KIND",
      `P36 resume supports only smoke runs, received ${run.runKind}`,
    );
  }
  if (run.controlState === "completed") {
    throw new ResumeError("ALREADY_COMPLETED", `run ${run.runId} is already completed`);
  }
  const isMock = input.transport.isMock === true;
  if (run.evidenceKind === "mock" && !isMock) {
    throw new ResumeError(
      "MODE_MISMATCH",
      "stored run is mock but the resume transport is live",
    );
  }
  if (run.evidenceKind === "live" && isMock) {
    throw new ResumeError(
      "MODE_MISMATCH",
      "stored run is live but the resume transport is mock",
    );
  }
  const clock = input.clock ?? { now: () => new Date() };
  const currentPlan = buildPlanManifest({
    runKind: "smoke",
    rootSeed: run.rootSeed,
  });
  if (
    currentPlan.planHash !== run.manifestHash ||
    currentPlan.protocolVersion !== run.protocolVersion
  ) {
    throw new ResumeError(
      "MANIFEST_MISMATCH",
      "current plan/protocol no longer matches the stored run manifest",
    );
  }
  const accountId = findAccountId(input.db, run.runId);
  let account = getBudgetAccount(input.db, accountId);
  if (input.budgetIncrease !== undefined) {
    try {
      account = increaseBudgetCap(input.db, {
        accountId,
        newMaxCostUsd: input.budgetIncrease.newMaxCostUsd,
        operator: input.budgetIncrease.operator,
        acknowledged: input.budgetIncrease.acknowledged,
        createdAt: nowIso(clock),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: unknown }).code === "CAP_CHANGE_UNAUTHORIZED"
      ) {
        throw new ResumeError(
          "BUDGET_INCREASE_UNAUTHORIZED",
          "budget cap increase requires --ack-budget-increase",
          { cause: error },
        );
      }
      throw error;
    }
  } else if (run.controlState === "paused_budget") {
    throw new ResumeError(
      "BUDGET_INCREASE_REQUIRED",
      "run is paused; resume requires --max-cost with --ack-budget-increase",
    );
  }
  if (run.controlState !== "running") {
    setRunControlState(input.db, run.runId, "running");
  }
  const routes = input.routes ?? buildMockRoutes();
  const transport = createResumeTransport(input.transport, input.db, input.hooks);
  try {
    return await runSmokeCohort({
      db: input.db,
      runId: run.runId,
      accountId,
      apiKey: input.apiKey,
      transport,
      evidenceKind: run.evidenceKind,
      runKind: "smoke",
      routes,
      maxCostUsd: account.maxCostUsd,
      plan: run.manifest as PlanManifest,
      resume: true,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(input.concurrency === undefined
        ? {}
        : { concurrency: input.concurrency }),
      ...(input.cancellation === undefined
        ? {}
        : { cancellation: input.cancellation }),
      ...(input.drainTimeoutMs === undefined
        ? {}
        : { drainTimeoutMs: input.drainTimeoutMs }),
      ...(input.yieldBetweenJobs === undefined
        ? {}
        : { yieldBetweenJobs: input.yieldBetweenJobs }),
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "CALL_CONFIG_MISMATCH"
    ) {
      throw new ResumeError(
        "CONFIG_MISMATCH",
        "stored request/schema/model configuration no longer matches",
        { cause: error },
      );
    }
    throw error;
  }
}
