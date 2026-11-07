import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import { addUsd, listBudgetEvents } from "../ai/budget.js";
import type { ChatMessage } from "../ai/config.js";
import {
  getLogicalCall,
  getOrCreateLogicalCall,
  listAttempts,
  type RequestAttempt,
} from "../ai/ledger.js";
import type {
  createOpenRouterTransport,
  OpenRouterCallResult,
} from "../ai/openrouter.js";
import {
  conservativeReservationUsd,
  estimatePromptTokens,
  type ResolvedRoute,
} from "../ai/preflight.js";
import { sha256Hex } from "../util/hash.js";
import type { BuiltCalibrationPack, CalibrationFixture } from "./fixtures.js";
import type { CalibrationLabels } from "./labels.js";
import {
  buildAlignmentReviewRequest,
  buildBlindReviewRequest,
  parseAlignmentReviewResponse,
  parseBlindReviewResponse,
  type CalibrationRole,
  type CalibrationReviewRequest,
} from "./run.js";
import type { CalibrationObservation } from "./score.js";

export const CALIBRATION_LIVE_STATUSES = [
  "completed",
  "paused_budget",
  "incomplete",
] as const;
export type CalibrationLiveStatus = (typeof CALIBRATION_LIVE_STATUSES)[number];

export interface CalibrationLiveRouteSet {
  readonly blindText: ResolvedRoute;
  readonly blindVision: ResolvedRoute;
  readonly alignmentText: ResolvedRoute;
  readonly alignmentVision: ResolvedRoute;
}

export interface CalibrationLiveAttemptRecord {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly state: string;
  readonly outcome: string;
  readonly httpStatus: number | null;
  readonly observedModel: string | null;
  readonly observedProvider: string | null;
  readonly generationId: string | null;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly elapsedMs: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface CalibrationLiveCallRecord {
  readonly fixtureId: string;
  readonly role: CalibrationRole;
  readonly logicalCallId: string | null;
  readonly requestHash: string | null;
  readonly model: string;
  readonly routingPolicy: "balanced";
  readonly outputCapField: string;
  readonly reservationUsd: string;
  readonly requestBody: unknown;
  readonly response: unknown | null;
  readonly responseHash: string | null;
  readonly error: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly actualCostUsd: string | null;
  readonly attempts: readonly CalibrationLiveAttemptRecord[];
}

export interface CalibrationLiveProviderMixEntry {
  readonly role: CalibrationRole;
  readonly observedModel: string | null;
  readonly observedProvider: string | null;
  readonly calls: number;
  readonly attempts: number;
}

export interface CalibrationLiveFailure {
  readonly fixtureId: string;
  readonly role: CalibrationRole;
  readonly message: string;
}

export interface CalibrationLiveRunResult {
  readonly status: CalibrationLiveStatus;
  readonly observations: readonly CalibrationObservation[];
  readonly calls: readonly CalibrationLiveCallRecord[];
  readonly reviewCalls: number;
  readonly generationCalls: 0;
  readonly transportAttempts: number;
  readonly providerMix: readonly CalibrationLiveProviderMixEntry[];
  readonly knownCostUsd: string;
  readonly unknownCalls: number;
  readonly unknownAttempts: number;
  readonly budgetPaused: boolean;
  readonly budgetBreached: boolean;
  readonly firstFailure: CalibrationLiveFailure | null;
  readonly fatalError: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface RunCalibrationLiveInput {
  readonly built: BuiltCalibrationPack;
  readonly labels: CalibrationLabels;
  readonly routes: CalibrationLiveRouteSet;
  readonly db: Database.Database;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly expectedCalls?: number;
  readonly clock?: {
    now(): Date;
    sleep?(ms: number): Promise<void>;
  };
}

interface PreparedCalibrationCall {
  readonly fixture: CalibrationFixture;
  readonly request: CalibrationReviewRequest;
  readonly route: ResolvedRoute;
  readonly reservationUsd: string;
}

function routeFor(
  routes: CalibrationLiveRouteSet,
  role: CalibrationRole,
): ResolvedRoute {
  switch (role) {
    case "blind_text":
      return routes.blindText;
    case "blind_vision":
      return routes.blindVision;
    case "alignment_text":
      return routes.alignmentText;
    case "alignment_vision":
      return routes.alignmentVision;
  }
}

function prepareCall(
  fixture: CalibrationFixture,
  entry: BuiltCalibrationPack["fixtures"][number],
  kind: "blind" | "alignment",
  routes: CalibrationLiveRouteSet,
): PreparedCalibrationCall {
  const role: CalibrationRole =
    kind === "blind"
      ? fixture.modality === "svg"
        ? "blind_vision"
        : "blind_text"
      : fixture.modality === "svg"
        ? "alignment_vision"
        : "alignment_text";
  const route = routeFor(routes, role);
  const request =
    kind === "blind"
      ? buildBlindReviewRequest(fixture, entry, route)
      : buildAlignmentReviewRequest(fixture, entry, route);
  const messages = request.body.messages as readonly ChatMessage[];
  const promptTokens = estimatePromptTokens(messages, route.requiresImage);
  return {
    fixture,
    request,
    route,
    reservationUsd: conservativeReservationUsd(
      route,
      promptTokens,
      route.maxOutputTokens,
    ),
  };
}

function prepareCalls(input: RunCalibrationLiveInput): PreparedCalibrationCall[] {
  const labels = new Set(input.labels.rows.map((row) => row.fixtureId));
  const prepared: PreparedCalibrationCall[] = [];
  for (const entry of input.built.fixtures) {
    if (!labels.has(entry.fixture.fixtureId)) {
      throw new Error(`missing label for ${entry.fixture.fixtureId}`);
    }
    prepared.push(prepareCall(entry.fixture, entry, "blind", input.routes));
    prepared.push(prepareCall(entry.fixture, entry, "alignment", input.routes));
  }
  if (prepared.length !== (input.expectedCalls ?? 80)) {
    throw new Error(
      `live calibration requires exactly ${input.expectedCalls ?? 80} calls, prepared ${prepared.length}`,
    );
  }
  return prepared;
}

function attemptRecord(
  attempt: RequestAttempt,
  resultAttempt: OpenRouterCallResult["attempts"][number] | undefined,
): CalibrationLiveAttemptRecord {
  return {
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    state: attempt.state,
    outcome: resultAttempt?.outcome ?? attempt.state,
    httpStatus: attempt.httpStatus,
    observedModel: attempt.observedModel,
    observedProvider: attempt.observedProvider,
    generationId: attempt.generationId,
    actualCostUsd: attempt.actualCostUsd,
    costStatus: attempt.costStatus,
    promptTokens: attempt.promptTokens,
    completionTokens: attempt.completionTokens,
    totalTokens: attempt.totalTokens,
    elapsedMs: attempt.elapsedMs,
    errorCode: resultAttempt?.errorCode ?? null,
    errorMessage: resultAttempt?.errorMessage ?? null,
  };
}

function validateCall(
  prepared: PreparedCalibrationCall,
  parsedContent: unknown,
): { readonly response: unknown | null; readonly error: string | null } {
  if (prepared.request.role.startsWith("blind")) {
    const parsed = parseBlindReviewResponse(prepared.fixture, parsedContent);
    return { response: parsed.response, error: parsed.error };
  }
  if (prepared.request.inventoryIds === null) {
    return {
      response: null,
      error: `${prepared.fixture.fixtureId} alignment request has no fact inventory`,
    };
  }
  const parsed = parseAlignmentReviewResponse(
    prepared.fixture,
    parsedContent,
    prepared.request.inventoryIds,
  );
  return { response: parsed.response, error: parsed.error };
}

function outcomeError(result: OpenRouterCallResult): string | null {
  if (result.outcome === "success") {
    return null;
  }
  const detail =
    result.error === null
      ? null
      : `${result.error.code}: ${result.error.message}`;
  return detail ?? `calibration call outcome ${result.outcome}`;
}

function providerMix(
  calls: readonly CalibrationLiveCallRecord[],
): CalibrationLiveProviderMixEntry[] {
  const entries = new Map<
    string,
    {
      role: CalibrationRole;
      observedModel: string | null;
      observedProvider: string | null;
      calls: number;
      attempts: number;
    }
  >();
  const add = (
    role: CalibrationRole,
    observedModel: string | null,
    observedProvider: string | null,
    callsDelta: number,
    attemptsDelta: number,
  ): void => {
    const key = `${role}|${observedModel ?? ""}|${observedProvider ?? ""}`;
    const existing = entries.get(key) ?? {
      role,
      observedModel,
      observedProvider,
      calls: 0,
      attempts: 0,
    };
    entries.set(key, {
      ...existing,
      calls: existing.calls + callsDelta,
      attempts: existing.attempts + attemptsDelta,
    });
  };
  for (const call of calls) {
    for (const attempt of call.attempts) {
      add(call.role, attempt.observedModel, attempt.observedProvider, 0, 1);
    }
    const last = call.attempts[call.attempts.length - 1];
    add(
      call.role,
      last?.observedModel ?? null,
      last?.observedProvider ?? null,
      1,
      0,
    );
  }
  return [...entries.values()].sort((left, right) =>
    `${left.role}|${left.observedProvider ?? ""}|${left.observedModel ?? ""}`.localeCompare(
      `${right.role}|${right.observedProvider ?? ""}|${right.observedModel ?? ""}`,
    ),
  );
}

function sumKnownCost(calls: readonly CalibrationLiveCallRecord[]): string {
  let total = "0";
  for (const call of calls) {
    for (const attempt of call.attempts) {
      if (attempt.actualCostUsd !== null) {
        total = addUsd(total, attempt.actualCostUsd);
      }
    }
  }
  return new Decimal(total).toFixed();
}

export function failedRunResult(
  built: BuiltCalibrationPack,
  startedAt: string,
  completedAt: string,
  message: string,
): CalibrationLiveRunResult {
  return {
    status: "incomplete",
    observations: built.fixtures.map((entry) => ({
      fixtureId: entry.fixture.fixtureId,
      blind: { response: null, error: "not executed" },
      alignment: { response: null, error: "not executed" },
    })),
    calls: [],
    reviewCalls: 0,
    generationCalls: 0,
    transportAttempts: 0,
    providerMix: [],
    knownCostUsd: "0",
    unknownCalls: 0,
    unknownAttempts: 0,
    budgetPaused: false,
    budgetBreached: false,
    firstFailure: null,
    fatalError: message,
    startedAt,
    completedAt,
  };
}

export async function runCalibrationLive(
  input: RunCalibrationLiveInput,
): Promise<CalibrationLiveRunResult> {
  const clock = input.clock ?? {
    now: () => new Date(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const startedAt = clock.now().toISOString();
  let prepared: PreparedCalibrationCall[];
  try {
    prepared = prepareCalls(input);
  } catch (error) {
    return failedRunResult(
      input.built,
      startedAt,
      clock.now().toISOString(),
      error instanceof Error ? error.message : String(error),
    );
  }
  const observations = new Map<
    string,
    {
      blind: { response: unknown | null; error: string | null };
      alignment: { response: unknown | null; error: string | null };
    }
  >();
  for (const entry of input.built.fixtures) {
    observations.set(entry.fixture.fixtureId, {
      blind: { response: null, error: "not executed" },
      alignment: { response: null, error: "not executed" },
    });
  }
  const calls: CalibrationLiveCallRecord[] = [];
  let status: CalibrationLiveStatus = "completed";
  let firstFailure: CalibrationLiveFailure | null = null;

  outer: for (const preparedCall of prepared) {
    const { fixture, request, route, reservationUsd } = preparedCall;
    let result: OpenRouterCallResult;
    try {
      const createdAt = clock.now().toISOString();
      const call = getOrCreateLogicalCall(input.db, {
        runId: null,
        slotId: null,
        probeKey: fixture.fixtureId,
        role: request.role,
        runKind: "calibration",
        requestBody: request.body,
        expectedSchemaHash: request.schemaHash,
        model: route.model,
        routingPolicy: "balanced",
        outputCapField: route.outputCapField,
        createdAt,
      });
      result = await input.transport.executeCall({
        db: input.db,
        accountId: input.accountId,
        logicalCallId: call.logicalCallId,
        apiKey: input.apiKey,
        reservationUsd,
      });
      const stored = getLogicalCall(input.db, call.logicalCallId);
      const attempts = listAttempts(input.db, call.logicalCallId);
      const resultAttempts = new Map(
        result.attempts.map((attempt) => [attempt.attemptId, attempt]),
      );
      const validation =
        result.outcome === "success" && result.parsedContent !== null
          ? validateCall(preparedCall, result.parsedContent)
          : {
              response: null,
              error:
                outcomeError(result) ??
                "calibration response has no parseable JSON content",
            };
      const error = validation.error;
      const record: CalibrationLiveCallRecord = {
        fixtureId: fixture.fixtureId,
        role: request.role,
        logicalCallId: call.logicalCallId,
        requestHash: stored.requestHash,
        model: stored.model,
        routingPolicy: "balanced",
        outputCapField: stored.outputCapField ?? route.outputCapField,
        reservationUsd,
        requestBody: stored.requestBody,
        response: validation.response,
        responseHash:
          result.content === null ? null : sha256Hex(result.content),
        error,
        costStatus: result.costStatus,
        actualCostUsd: result.actualCostUsd,
        attempts: attempts.map((attempt) =>
          attemptRecord(attempt, resultAttempts.get(attempt.attemptId)),
        ),
      };
      calls.push(record);
      const observation = observations.get(fixture.fixtureId);
      if (observation !== undefined) {
        const target =
          request.role.startsWith("blind") ? observation.blind : observation.alignment;
        target.response = validation.response;
        target.error = error;
      }
      if (error !== null && firstFailure === null) {
        firstFailure = {
          fixtureId: fixture.fixtureId,
          role: request.role,
          message: error,
        };
      }
      if (result.outcome === "paused_budget") {
        status = "paused_budget";
        break outer;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      calls.push({
        fixtureId: fixture.fixtureId,
        role: request.role,
        logicalCallId: null,
        requestHash: null,
        model: route.model,
        routingPolicy: "balanced",
        outputCapField: route.outputCapField,
        reservationUsd,
        requestBody: request.body,
        response: null,
        responseHash: null,
        error: message,
        costStatus: "not_applicable",
        actualCostUsd: null,
        attempts: [],
      });
      if (firstFailure === null) {
        firstFailure = {
          fixtureId: fixture.fixtureId,
          role: request.role,
          message,
        };
      }
      status = "incomplete";
      break outer;
    }
  }

  const orderedObservations: CalibrationObservation[] = input.built.fixtures.map(
    (entry) => {
      const observation = observations.get(entry.fixture.fixtureId);
      return {
        fixtureId: entry.fixture.fixtureId,
        blind: observation?.blind ?? {
          response: null,
          error: "not executed",
        },
        alignment: observation?.alignment ?? {
          response: null,
          error: "not executed",
        },
      };
    },
  );
  const unknownAttempts = calls.reduce(
    (total, call) =>
      total +
      call.attempts.filter(
        (attempt) =>
          attempt.costStatus === "unknown" && attempt.state !== "prepared",
      ).length,
    0,
  );
  const budgetEvents = listBudgetEvents(input.db, input.accountId);
  const budgetBreached = budgetEvents.some(
    (event) => event.eventType === "overshoot",
  );
  const budgetPausedByEvent = budgetEvents.some(
    (event) => event.eventType === "pause",
  );
  if (budgetBreached || budgetPausedByEvent) {
    status = "paused_budget";
  }
  return {
    status,
    observations: orderedObservations,
    calls,
    reviewCalls: calls.length,
    generationCalls: 0,
    transportAttempts: calls.reduce(
      (total, call) => total + call.attempts.length,
      0,
    ),
    providerMix: providerMix(calls),
    knownCostUsd: sumKnownCost(calls),
    unknownCalls: calls.filter((call) => call.costStatus === "unknown").length,
    unknownAttempts,
    budgetPaused: status === "paused_budget",
    budgetBreached,
    firstFailure,
    fatalError: null,
    startedAt,
    completedAt: clock.now().toISOString(),
  };
}
