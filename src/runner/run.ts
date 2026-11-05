import type Database from "better-sqlite3";
import {
  addUsd,
  createBudgetAccount,
  getBudgetAccount,
} from "../ai/budget.js";
import type { MockScenarioKind, MockTransport } from "../ai/mock.js";
import type { ResolvedRoute } from "../ai/preflight.js";
import {
  ALIGNMENT_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_JSON_SCHEMA,
  FAMILY_SPEC_JSON_SCHEMAS,
  WORDING_JSON_SCHEMA,
  strictSchemaHash,
} from "../ai/schemas.js";
import {
  type CandidateVerdict,
  type DuplicateBarrierSummary,
} from "../domain/candidate.js";
import {
  REQUEST_ROLES,
  UsdSchema,
  type PlanManifest,
  type RequestRole,
} from "../domain/experiment.js";
import { buildPlanManifest } from "../experiment/planner.js";
import { runDuplicateBarrier } from "../validation/duplicates.js";
import {
  createRun,
  getRun,
  insertEvent,
  listSlots,
  setRunControlState,
  type SlotRecord,
} from "../storage/repository.js";
import {
  prepareSlot,
  type PreparationMockScenarioKind,
  type PreparationResult,
} from "./prepare-slot.js";
import {
  recordDuplicateAssessment,
  reviewSlot,
  type ReviewSlotOutcome,
} from "./review-slot.js";
import {
  markUnfinishedDispatchesUncertain,
  RunCancellation,
  withCancellationTransport,
  type CancellationReason,
} from "./cancel.js";
import {
  DEFAULT_CONCURRENCY,
  assertConcurrency,
  runBoundedPool,
  yieldToEventLoop,
  type Concurrency,
} from "./workers.js";

export type RunErrorCode =
  | "INVALID_INPUT"
  | "LIVE_NOT_SUPPORTED"
  | "BARRIER_ASSESSMENT_MISSING"
  | "INCOMPLETE_RUN";

export class RunError extends Error {
  readonly code: RunErrorCode;

  constructor(code: RunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunError";
    this.code = code;
  }
}

export interface MockRoutes {
  readonly spec: ResolvedRoute;
  readonly wording: ResolvedRoute;
  readonly blindText: ResolvedRoute;
  readonly blindVision: ResolvedRoute;
  readonly alignmentText: ResolvedRoute;
  readonly alignmentVision: ResolvedRoute;
}

export function mockRoute(role: RequestRole): ResolvedRoute {
  const responseFormat =
    role === "spec"
      ? FAMILY_SPEC_JSON_SCHEMAS.ranking
      : role === "wording"
        ? WORDING_JSON_SCHEMA
        : role.startsWith("blind")
          ? BLIND_REVIEW_JSON_SCHEMA
          : ALIGNMENT_REVIEW_JSON_SCHEMA;
  const vision = role === "blind_vision" || role === "alignment_vision";
  return {
    role,
    model: "mock/model",
    providerTag: "mock",
    providerName: "Mock Provider",
    endpointTag: "mock",
    outputCapField: "max_tokens",
    maxOutputTokens: 8192,
    minPromptTokens: 16_384,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: { prompt: "0", completion: "0" },
    requiresImage: vision,
    imageInputDeclared: vision,
    visionProbeRequired: vision,
    responseFormat,
    schemaHash: strictSchemaHash(responseFormat),
    settings: {},
  };
}

export function buildMockRoutes(): MockRoutes {
  return {
    spec: mockRoute("spec"),
    wording: mockRoute("wording"),
    blindText: mockRoute("blind_text"),
    blindVision: mockRoute("blind_vision"),
    alignmentText: mockRoute("alignment_text"),
    alignmentVision: mockRoute("alignment_vision"),
  };
}

export interface PreparationScenarioOverride {
  readonly spec?: PreparationMockScenarioKind;
  readonly wording?: PreparationMockScenarioKind;
}

export interface RunSmokeMockInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: MockTransport;
  readonly maxCostUsd: string;
  readonly rootSeed?: string;
  readonly clock?: { now(): Date };
  readonly concurrency?: Concurrency;
  readonly cancellation?: RunCancellation;
  readonly drainTimeoutMs?: number;
  readonly yieldBetweenJobs?: () => Promise<void>;
  readonly preparationScenarios?: Readonly<
    Record<string, PreparationScenarioOverride>
  >;
  readonly reviewScenarioKinds?: {
    readonly blind?: MockScenarioKind;
    readonly alignment?: MockScenarioKind;
  };
}

export type RunSmokeMockStatus = "completed" | "cancelled";

export interface RunCancellationSummary {
  readonly reason: CancellationReason;
  readonly phase: "preparation" | "barrier" | "review" | "unknown";
  readonly drained: "drained" | "timeout";
  readonly markedUncertain: number;
}

export interface RunSmokeMockSummary {
  readonly runId: string;
  readonly planHash: string;
  readonly status: RunSmokeMockStatus;
  readonly slots: number;
  readonly terminalSlots: number;
  readonly verdicts: Readonly<Record<CandidateVerdict, number>>;
  readonly callsByRole: Readonly<Record<RequestRole, number>>;
  readonly attempts: number;
  readonly unknownAttempts: number;
  readonly cost: {
    readonly actualCostUsd: string | null;
    readonly costStatus: "known" | "unknown" | "not_applicable";
  };
  readonly budget: {
    readonly knownActualUsd: string;
    readonly reservedUsd: string;
    readonly unknownExposureUsd: string;
    readonly maxCostUsd: string;
  };
  readonly barrier: DuplicateBarrierSummary | null;
  readonly cancellation: RunCancellationSummary | null;
}

export interface RunSmokeMockResult {
  readonly runId: string;
  readonly plan: PlanManifest;
  readonly status: RunSmokeMockStatus;
  readonly barrier: ReturnType<typeof runDuplicateBarrier> | null;
  readonly preparations: readonly PreparationResult[];
  readonly reviews: readonly ReviewSlotOutcome[];
  readonly slots: readonly SlotRecord[];
  readonly summary: RunSmokeMockSummary;
  readonly cancellation: RunCancellationSummary | null;
}

function nowIso(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

function boundEvidence(value: string, apiKey: string): string {
  const redacted = value.split(apiKey).join("[REDACTED]");
  return redacted.length <= 2000 ? redacted : `${redacted.slice(0, 1997)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (error instanceof RunError) {
    return error.code;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function summarizeRun(
  db: Database.Database,
  runId: string,
  accountId: string,
  plan: PlanManifest,
  slots: readonly SlotRecord[],
  barrier: ReturnType<typeof runDuplicateBarrier> | null,
  status: RunSmokeMockStatus,
  cancellation: RunCancellationSummary | null,
): RunSmokeMockSummary {
  const verdicts: Record<CandidateVerdict, number> = {
    approved: 0,
    rejected: 0,
    inconclusive: 0,
    generation_error: 0,
  };
  for (const slot of slots) {
    if (slot.verdict !== null) {
      verdicts[slot.verdict] += 1;
    }
  }
  const callsByRole = Object.fromEntries(
    REQUEST_ROLES.map((role) => [role, 0]),
  ) as Record<RequestRole, number>;
  const roleRows = db
    .prepare(
      "SELECT role, COUNT(*) AS count FROM logical_calls WHERE run_id = ? GROUP BY role",
    )
    .all(runId) as Array<{ role: RequestRole; count: number }>;
  for (const row of roleRows) {
    callsByRole[row.role] = row.count;
  }
  const attemptRow = db
    .prepare(
      "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?)",
    )
    .get(runId) as { count: number };
  const unknownRow = db
    .prepare(
      "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND cost_status = 'unknown'",
    )
    .get(runId) as { count: number };
  const knownRows = db
    .prepare(
      "SELECT actual_cost_usd FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND cost_status = 'known' AND actual_cost_usd IS NOT NULL",
    )
    .all(runId) as Array<{ actual_cost_usd: string }>;
  const costStatus =
    unknownRow.count > 0
      ? "unknown"
      : knownRows.length === 0
        ? "not_applicable"
        : "known";
  const actualCostUsd =
    costStatus === "known"
      ? addUsd(...knownRows.map((row) => row.actual_cost_usd))
      : null;
  const account = getBudgetAccount(db, accountId);
  return {
    runId,
    planHash: plan.planHash,
    status,
    slots: slots.length,
    terminalSlots: slots.filter((slot) => slot.stage === "terminal").length,
    verdicts,
    callsByRole,
    attempts: attemptRow.count,
    unknownAttempts: unknownRow.count,
    cost: { actualCostUsd, costStatus },
    budget: {
      knownActualUsd: account.knownActualUsd,
      reservedUsd: account.reservedUsd,
      unknownExposureUsd: account.unknownExposureUsd,
      maxCostUsd: account.maxCostUsd,
    },
    barrier: barrier?.summary ?? null,
    cancellation,
  };
}

function finishCancelled(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly accountId: string;
  readonly plan: PlanManifest;
  readonly clock: { now(): Date };
  readonly cancellation: RunCancellation;
  readonly phase: RunCancellationSummary["phase"];
  readonly drained: "drained" | "timeout";
  readonly preparations: readonly PreparationResult[];
  readonly reviews: readonly ReviewSlotOutcome[];
  readonly barrier: ReturnType<typeof runDuplicateBarrier> | null;
}): RunSmokeMockResult {
  const marked = markUnfinishedDispatchesUncertain(
    input.db,
    input.runId,
    nowIso(input.clock),
  );
  const slots = listSlots(input.db, input.runId);
  const cancellation: RunCancellationSummary = {
    reason: input.cancellation.stopReason ?? "operator",
    phase: input.phase,
    drained: input.drained,
    markedUncertain: marked.length,
  };
  const summary = summarizeRun(
    input.db,
    input.runId,
    input.accountId,
    input.plan,
    slots,
    input.barrier,
    "cancelled",
    cancellation,
  );
  insertEvent(input.db, {
    runId: input.runId,
    slotId: null,
    eventType: "run_cancelled",
    stage: null,
    payload: {
      ...cancellation,
      markedAttemptIds: marked,
      terminalSlots: summary.terminalSlots,
      budget: summary.budget,
    },
    createdAt: nowIso(input.clock),
  });
  return {
    runId: input.runId,
    plan: input.plan,
    status: "cancelled",
    barrier: input.barrier,
    preparations: input.preparations,
    reviews: input.reviews,
    slots,
    summary,
    cancellation,
  };
}

export async function runSmokeMockExperiment(
  input: RunSmokeMockInput,
): Promise<RunSmokeMockResult> {
  if (input.transport.isMock !== true) {
    throw new RunError(
      "LIVE_NOT_SUPPORTED",
      "P35 supports only the deterministic mock transport",
    );
  }
  const maxCost = UsdSchema.safeParse(input.maxCostUsd);
  if (!maxCost.success) {
    throw new RunError(
      "INVALID_INPUT",
      "maxCostUsd must be a non-negative decimal USD string",
      { cause: maxCost.error },
    );
  }
  let concurrency: Concurrency;
  try {
    concurrency = assertConcurrency(input.concurrency ?? DEFAULT_CONCURRENCY);
  } catch (error) {
    throw new RunError("INVALID_INPUT", errorMessage(error), {
      cause: error,
    });
  }
  const plan = buildPlanManifest({
    runKind: "smoke",
    ...(input.rootSeed === undefined ? {} : { rootSeed: input.rootSeed }),
  });
  if (plan.slots.length !== 20) {
    throw new RunError(
      "INVALID_INPUT",
      `smoke plan must contain 20 slots, received ${plan.slots.length}`,
    );
  }
  const clock = input.clock ?? { now: () => new Date() };
  const cancellation = input.cancellation ?? new RunCancellation();
  const yieldBetweenJobs = input.yieldBetweenJobs ?? yieldToEventLoop;
  const drainTimeoutMs = input.drainTimeoutMs ?? 95_000;
  const transport = withCancellationTransport(input.transport, cancellation);
  const createdAt = nowIso(clock);
  let created = false;
  let phase: RunCancellationSummary["phase"] = "preparation";
  try {
    createRun(input.db, {
      runId: input.runId,
      plan,
      evidenceKind: "mock",
      createdAt,
    });
    created = true;
    createBudgetAccount(input.db, {
      accountId: input.accountId,
      runId: input.runId,
      runKind: "smoke",
      maxCostUsd: maxCost.data,
      createdAt,
    });
    const routes = buildMockRoutes();

    const preparationPool = await runBoundedPool(
      plan.slots,
      async (slot) => {
        cancellation.throwIfStopping();
        const scenario = input.preparationScenarios?.[slot.slotId];
        return prepareSlot({
          db: input.db,
          runId: input.runId,
          slotId: slot.slotId,
          accountId: input.accountId,
          apiKey: input.apiKey,
          transport,
          routes: { spec: routes.spec, wording: routes.wording },
          reservations: { spec: "0.01", wording: "0.01" },
          ...(scenario === undefined ? {} : { mockScenarioKinds: scenario }),
          clock,
          yieldBetweenJobs,
        });
      },
      { concurrency, cancellation, drainTimeoutMs, yieldBetweenJobs },
    );
    phase = "preparation";
    if (preparationPool.stopped || cancellation.isStopping) {
      return finishCancelled({
        db: input.db,
        runId: input.runId,
        accountId: input.accountId,
        plan,
        clock,
        cancellation,
        phase,
        drained:
          preparationPool.drained === "timeout" ? "timeout" : "drained",
        preparations: preparationPool.results.filter(defined),
        reviews: [],
        barrier: null,
      });
    }
    if (preparationPool.errors.length > 0) {
      throw preparationPool.errors[0];
    }
    const preparations = preparationPool.results.filter(defined);
    if (preparations.length !== plan.slots.length) {
      throw new RunError(
        "INCOMPLETE_RUN",
        `preparation completed ${preparations.length}/${plan.slots.length} slots`,
      );
    }

    if (cancellation.isStopping) {
      return finishCancelled({
        db: input.db,
        runId: input.runId,
        accountId: input.accountId,
        plan,
        clock,
        cancellation,
        phase: "preparation",
        drained: "drained",
        preparations,
        reviews: [],
        barrier: null,
      });
    }
    phase = "barrier";
    const barrierStartedAt = nowIso(clock);
    const barrier = runDuplicateBarrier({
      plannedSlots: plan.slots,
      candidates: preparations.map((preparation) => preparation.candidate),
    });
    const barrierFinishedAt = nowIso(clock);
    insertEvent(input.db, {
      runId: input.runId,
      slotId: null,
      eventType: "duplicate_barrier",
      stage: null,
      payload: barrier,
      createdAt: barrierFinishedAt,
    });
    const assessmentBySlot = new Map(
      barrier.assessments.map((assessment) => [assessment.slotId, assessment]),
    );
    for (const preparation of preparations) {
      if (preparation.status !== "ready_for_duplicate_barrier") {
        continue;
      }
      const assessment = assessmentBySlot.get(preparation.slotId);
      if (assessment === undefined) {
        throw new RunError(
          "BARRIER_ASSESSMENT_MISSING",
          `barrier result is missing ${preparation.slotId}`,
        );
      }
      recordDuplicateAssessment({
        db: input.db,
        runId: input.runId,
        slotId: preparation.slotId,
        barrierResultHash: barrier.resultHash,
        assessment,
        startedAt: barrierStartedAt,
        clock,
      });
    }
    if (cancellation.isStopping) {
      return finishCancelled({
        db: input.db,
        runId: input.runId,
        accountId: input.accountId,
        plan,
        clock,
        cancellation,
        phase: "barrier",
        drained: "drained",
        preparations,
        reviews: [],
        barrier,
      });
    }

    phase = "review";
    const reviewPool = await runBoundedPool(
      plan.slots,
      async (slot) => {
        cancellation.throwIfStopping();
        return reviewSlot({
          db: input.db,
          runId: input.runId,
          slotId: slot.slotId,
          accountId: input.accountId,
          apiKey: input.apiKey,
          transport,
          routes: {
            blindText: routes.blindText,
            blindVision: routes.blindVision,
            alignmentText: routes.alignmentText,
            alignmentVision: routes.alignmentVision,
          },
          reservations: { blind: "0.01", alignment: "0.01" },
          ...(input.reviewScenarioKinds === undefined
            ? {}
            : { mockScenarioKinds: input.reviewScenarioKinds }),
          clock,
          yieldBetweenJobs,
        });
      },
      { concurrency, cancellation, drainTimeoutMs, yieldBetweenJobs },
    );
    if (reviewPool.stopped || cancellation.isStopping) {
      return finishCancelled({
        db: input.db,
        runId: input.runId,
        accountId: input.accountId,
        plan,
        clock,
        cancellation,
        phase,
        drained: reviewPool.drained === "timeout" ? "timeout" : "drained",
        preparations,
        reviews: reviewPool.results.filter(defined),
        barrier,
      });
    }
    if (reviewPool.errors.length > 0) {
      throw reviewPool.errors[0];
    }
    const reviews = reviewPool.results.filter(defined);
    if (reviews.length !== plan.slots.length) {
      throw new RunError(
        "INCOMPLETE_RUN",
        `review completed ${reviews.length}/${plan.slots.length} slots`,
      );
    }

    const slots = listSlots(input.db, input.runId);
    if (slots.length !== plan.slots.length) {
      throw new RunError(
        "INCOMPLETE_RUN",
        `run has ${slots.length} slots, expected ${plan.slots.length}`,
      );
    }
    const incomplete = slots.filter(
      (slot) => slot.stage !== "terminal" || slot.verdict === null,
    );
    if (incomplete.length > 0) {
      throw new RunError(
        "INCOMPLETE_RUN",
        `run has ${incomplete.length} non-terminal slots: ${incomplete
          .map((slot) => slot.slotId)
          .join(", ")}`,
      );
    }
    const summary = summarizeRun(
      input.db,
      input.runId,
      input.accountId,
      plan,
      slots,
      barrier,
      "completed",
      null,
    );
    insertEvent(input.db, {
      runId: input.runId,
      slotId: null,
      eventType: "run_completed",
      stage: null,
      payload: summary,
      createdAt: nowIso(clock),
    });
    setRunControlState(input.db, input.runId, "completed");
    return {
      runId: input.runId,
      plan,
      status: "completed",
      barrier,
      preparations,
      reviews,
      slots,
      summary,
      cancellation: null,
    };
  } catch (error) {
    if (created) {
      try {
        const run = getRun(input.db, input.runId);
        if (run.controlState === "running") {
          setRunControlState(input.db, input.runId, "failed");
        }
        insertEvent(input.db, {
          runId: input.runId,
          slotId: null,
          eventType: "run_failed",
          stage: null,
          payload: {
            code: errorCode(error),
            message: boundEvidence(errorMessage(error), input.apiKey),
            phase,
          },
          createdAt: nowIso(clock),
        });
      } catch {
        // Preserve the original failure if the failure event cannot be written.
      }
    }
    throw error;
  }
}
