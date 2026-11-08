import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  DESIGNER_PROTOCOL_VERSION,
  DesignerPlanManifestSchema,
  type DesignProposal,
  type DesignerArm,
  type DesignerAssignment,
  type DesignerPlanManifest,
  type DesignerSlotRecord,
  type DesignerRunKind,
} from "../domain/design.js";
import type { SolveResult } from "../families/contracts.js";
import type { ChoiceSet } from "../domain/answers.js";
import {
  buildDesignProposalRequest,
  parseDesignProposal,
} from "../ai/design-proposal.js";
import {
  buildDesignRepairRequest,
  parseDesignRepairProposal,
} from "../ai/repair-proposal.js";
import {
  buildDesignRepairInput,
  type DesignAttemptCandidateResult,
  type DesignRepairInput,
} from "./feedback.js";
import {
  attemptRoleFor,
  diagnosticForRepair,
  maxAttemptIndexForArm,
  type DesignAttemptRecord,
} from "./attempts.js";
import {
  evaluateDesignAttempt,
  reduceDesignCandidate,
  type DesignCandidateFinal,
} from "./verdict.js";
import {
  diagnoseBaselineConstructionFailure,
  diagnoseGenerationError,
  diagnoseInfrastructureFailure,
  diagnoseOptionFailure,
  diagnosePresentationFailure,
  diagnoseProposalFailure,
  diagnoseRenderFailure,
  diagnoseRepairReplay,
  diagnoseSolverLimit,
  diagnoseDesignSpec,
  passedDownstreamEvidence,
  pendingDownstreamEvidence,
  type DesignDiagnostic,
  type DesignDownstreamEvidence,
} from "./diagnostics.js";
import { SolverLimitError } from "../families/canonicalize.js";
import { productionRegistry } from "../families/registry.js";
import { buildBaselineOutcome, type BaselineOutcome } from "./baseline.js";
import {
  buildDesignView,
  type BuiltDesignView,
  type DesignView,
} from "../presentation/design-view.js";
import {
  createLogicalCall,
  getLogicalCall,
  listAttempts,
  type LogicalCall,
  type RequestAttempt,
} from "../ai/ledger.js";
import type { OpenRouterCallResult } from "../ai/openrouter.js";
import {
  getArtifactById,
  type ArtifactInput,
} from "../storage/artifacts.js";
import {
  createDesignerRun,
  getDesignerRun,
  getDesignerSlot,
  insertDesignAttempt,
  insertDesignerStageResult,
  insertEvent,
  listDesignAttempts,
  listDesignerSlots,
  listDesignerStageResults,
  setRunControlState,
  type DesignerStageResultRecord,
} from "../storage/repository.js";
import {
  createBudgetAccount,
  getBudgetAccount,
  settleReservation,
} from "../ai/budget.js";
import {
  assertConcurrency,
  DEFAULT_CONCURRENCY,
  runBoundedPool,
  yieldToEventLoop,
  type Concurrency,
} from "../runner/workers.js";
import {
  RunCancellation,
  markUnfinishedDispatchesUncertain,
  withCancellationTransport,
} from "../runner/cancel.js";
import type { createOpenRouterTransport } from "../ai/openrouter.js";
import type { AiRoleSettings, OutputCapField } from "../ai/config.js";
import { UsdSchema } from "../domain/experiment.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { canonicalStructureHash } from "../families/canonicalize.js";
import {
  designerMockScenarioFor,
  type DesignerMockScenario,
} from "./mock.js";
import {
  computeDesignerConfigurationHash,
  DESIGNER_CONFIGURATION_HASH_FIELDS,
  readDesignerConfigurationEvent,
  type DesignerConfigurationSnapshot,
} from "./freeze.js";

export type DesignerTransport = ReturnType<typeof createOpenRouterTransport> & {
  readonly isMock?: true;
  readonly registerDesignerScenario?: (
    logicalCallId: string,
    scenario: DesignerMockScenario,
  ) => void;
  readonly getDesignerScenario?: (
    logicalCallId: string,
  ) => DesignerMockScenario | null;
};

export const DESIGNER_RUN_STAGE_PAYLOAD_VERSION = 1 as const;

export type DesignerRunErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "INCOMPLETE_RUN"
  | "BUDGET_PAUSED"
  | "OPERATOR_PAUSED"
  | "PROTOCOL_MISMATCH";

export class DesignerRunError extends Error {
  readonly code: DesignerRunErrorCode;

  constructor(code: DesignerRunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesignerRunError";
    this.code = code;
  }
}

export interface DesignerFaultHooks {
  readonly beforeDispatch?: (input: { readonly logicalCallId: string }) => Promise<void> | void;
  readonly afterDispatch?: (input: { readonly logicalCallId: string }) => Promise<void> | void;
  readonly afterResponseSaved?: (input: { readonly logicalCallId: string }) => Promise<void> | void;
  readonly afterAttemptCommit?: (input: { readonly attemptId: string }) => Promise<void> | void;
  readonly afterRepairResponse?: (input: { readonly logicalCallId: string }) => Promise<void> | void;
  readonly beforeTerminalCommit?: (input: { readonly slotId: string }) => Promise<void> | void;
}

export interface DesignerRunHooks {
  readonly onSlotCompleted?: (slotId: string) => Promise<void> | void;
  readonly onAttemptPersisted?: (attempt: DesignAttemptRecord) => Promise<void> | void;
  readonly faults?: DesignerFaultHooks;
}

export interface DesignerRunConfig {
  readonly model: string;
  readonly outputCapField: OutputCapField;
  readonly maxOutputTokens: number;
  readonly settings?: AiRoleSettings;
  readonly skinEnabled: boolean;
  readonly reservationUsd: string;
  readonly nonBilling: boolean;
}

export interface RunDesignerCohortInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly plan: DesignerPlanManifest;
  readonly evidenceKind: "mock" | "live";
  readonly apiKey: string;
  readonly transport: DesignerTransport;
  readonly accountId: string;
  readonly maxCostUsd: string;
  readonly config: DesignerRunConfig;
  readonly concurrency?: Concurrency;
  readonly clock?: { now(): Date };
  readonly cancellation?: RunCancellation;
  readonly yieldBetweenJobs?: () => Promise<void>;
  readonly drainTimeoutMs?: number;
  readonly resume?: boolean;
  readonly slotIds?: readonly string[];
  readonly configurationSnapshot?: DesignerConfigurationSnapshot;
  readonly beforeRun?: (input: {
    readonly db: Database.Database;
    readonly runId: string;
  }) => Promise<void> | void;
  readonly hooks?: DesignerRunHooks;
}

export interface DesignerRunSummary {
  readonly runId: string;
  readonly planHash: string;
  readonly status: "completed" | "cancelled";
  readonly assignments: number;
  readonly candidates: number;
  readonly terminalCandidates: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly inconclusive: number;
  readonly generationErrors: number;
  readonly attempts: number;
  readonly knownCostUsd: string | null;
  readonly unknownAttempts: number;
  readonly budget: {
    readonly knownActualUsd: string;
    readonly reservedUsd: string;
    readonly unknownExposureUsd: string;
    readonly maxCostUsd: string;
  };
  readonly cancellation: {
    readonly reason: string;
    readonly phase: string;
    readonly drained: "drained" | "timeout";
    readonly markedUncertain: number;
  } | null;
}

export interface RunDesignerCohortResult {
  readonly runId: string;
  readonly plan: DesignerPlanManifest;
  readonly status: DesignerRunSummary["status"];
  readonly slots: readonly DesignerSlotRecord[];
  readonly summary: DesignerRunSummary;
  readonly cancellation: DesignerRunSummary["cancellation"];
}

export interface DesignerStageFormalPayload {
  readonly version: typeof DESIGNER_RUN_STAGE_PAYLOAD_VERSION;
  readonly spec: unknown;
  readonly solve: {
    readonly solutionCount: number;
    readonly answerCount: number;
  };
  readonly choices: unknown;
  readonly choicesSeed: string | null;
  readonly structuralFingerprint: string;
  readonly contentHash: string;
}

export interface DesignerStagePresentationPayload {
  readonly version: typeof DESIGNER_RUN_STAGE_PAYLOAD_VERSION;
  readonly view: DesignView;
  readonly svgHash: string | null;
  readonly pngHash: string | null;
  readonly templateHash: string;
  readonly certificateHash: string;
}

export interface DesignerStageTerminalPayload {
  readonly version: typeof DESIGNER_RUN_STAGE_PAYLOAD_VERSION;
  readonly final: DesignCandidateFinal;
  readonly firstProposalHash: string | null;
  readonly finalProposalHash: string | null;
  readonly firstAccepted: boolean;
  readonly finalAccepted: boolean;
  readonly baseline: BaselineOutcome | null;
  readonly designViewHash: string | null;
}

export interface DesignerAttemptEvidenceArtifact {
  readonly version: typeof DESIGNER_RUN_STAGE_PAYLOAD_VERSION;
  readonly proposal: unknown | null;
  readonly rawValue: unknown | null;
  readonly diagnostic: DesignDiagnostic | null;
  readonly downstream: DesignDownstreamEvidence;
  readonly spec: unknown | null;
  readonly solve: unknown | null;
  readonly choices: unknown | null;
  readonly choicesSeed: string | null;
  readonly builtView: unknown | null;
}

const EvidenceArtifactSchema = z.looseObject({
  version: z.literal(DESIGNER_RUN_STAGE_PAYLOAD_VERSION),
  proposal: z.unknown().nullable(),
  rawValue: z.unknown().nullable(),
  diagnostic: z.unknown().nullable(),
  downstream: z.unknown(),
  spec: z.unknown().nullable(),
  solve: z.unknown().nullable(),
  choices: z.unknown().nullable(),
  choicesSeed: z.unknown().nullable(),
  builtView: z.unknown().nullable(),
});

function nowIso(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function stageExists(
  db: Database.Database,
  runId: string,
  slotId: string,
  stage: DesignerStageResultRecord["stage"],
): boolean {
  return listDesignerStageResults(db, runId, slotId).some(
    (record) => record.stage === stage,
  );
}

function proposalArtifact(proposal: DesignProposal): ArtifactInput {
  return {
    role: "proposal",
    kind: "json",
    mediaType: "application/json",
    bytes: Buffer.from(canonicalJson(proposal), "utf8"),
  };
}

function evidenceArtifact(evidence: DesignerAttemptEvidenceArtifact): ArtifactInput {
  return {
    role: "solver_result",
    kind: "json",
    mediaType: "application/json",
    bytes: Buffer.from(canonicalJson(evidence), "utf8"),
  };
}

function rawResponseArtifact(
  db: Database.Database,
  logicalCallId: string,
): ArtifactInput | null {
  const attempts = listAttempts(db, logicalCallId);
  const saved = [...attempts]
    .reverse()
    .find((attempt) => attempt.rawResponseArtifactId !== null);
  if (saved?.rawResponseArtifactId === null || saved?.rawResponseArtifactId === undefined) {
    return null;
  }
  const artifact = getArtifactById(db, saved.rawResponseArtifactId);
  return {
    role: "raw_response",
    kind: "raw_response",
    mediaType: artifact.artifact.mediaType,
    bytes: artifact.bytes,
  };
}

function choicesSeedFor(assignment: DesignerAssignment): string {
  return sha256Hex(
    canonicalJson(["designer-choices", assignment.assignmentId]),
  );
}

interface EvaluatedCandidateAttempt {
  readonly candidate: DesignAttemptCandidateResult;
  readonly evidence: DesignerAttemptEvidenceArtifact;
  readonly spec: unknown | null;
  readonly solve: SolveResult<unknown> | null;
  readonly choices: ChoiceSet<unknown> | null;
  readonly choicesSeed: string | null;
  readonly built: BuiltDesignView | null;
}

function solveAndPresent(input: {
  readonly assignment: DesignerAssignment;
  readonly viewId: string;
  readonly proposal: DesignProposal;
  readonly skinEnabled: boolean;
}): {
  readonly solve: SolveResult<unknown>;
  readonly choices: ChoiceSet<unknown>;
  readonly choicesSeed: string | null;
  readonly built: BuiltDesignView;
} {
  const engine = productionRegistry.getEngine(input.assignment.family);
  const spec = engine.schema.parse(input.proposal.spec) as never;
  const solve = engine.enumerateSolutions(spec) as SolveResult<unknown>;
  if (
    solve.solutionCount !== 1 ||
    solve.answerCount !== 1 ||
    solve.correctAnswer === null
  ) {
    throw new DesignerRunError(
      "INVALID_STATE",
      "solveAndPresent requires one verified answer",
    );
  }
  const choicesSeed =
    engine.modality === "svg" ? choicesSeedFor(input.assignment) : null;
  const choices = engine.makeOptions(
    spec,
    solve.correctAnswer,
    choicesSeed ?? choicesSeedFor(input.assignment),
  ) as ChoiceSet<unknown>;
  const built = buildDesignView({
    viewId: input.viewId,
    engine,
    spec,
    solveResult: solve as never,
    choices: choices as never,
    difficulty: input.assignment.difficulty,
    skin: input.skinEnabled ? input.proposal.presentationSkin : null,
    ...(choicesSeed === null ? {} : { choicesSeed }),
  });
  return { solve, choices, choicesSeed, built };
}

function evaluateProposal(input: {
  readonly assignment: DesignerAssignment;
  readonly viewId: string;
  readonly proposal: DesignProposal | null;
  readonly rawValue: unknown | null;
  readonly logicalCallId: string | null;
  readonly costStatus: DesignAttemptCandidateResult["costStatus"];
  readonly costUsd: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly artifacts: readonly ArtifactInput[];
  readonly previousProposal: DesignProposal | null;
  readonly repair: boolean;
  readonly skinEnabled: boolean;
  readonly simulatedFailure: "solver_limit" | "render_failure" | null;
  readonly initialDiagnostic?: DesignDiagnostic | null;
}): EvaluatedCandidateAttempt {
  let diagnostic: DesignDiagnostic | null = input.initialDiagnostic ?? null;
  let downstream: DesignDownstreamEvidence = pendingDownstreamEvidence();
  let spec: unknown | null = null;
  let solve: SolveResult<unknown> | null = null;
  let choices: ChoiceSet<unknown> | null = null;
  let choicesSeed: string | null = null;
  let built: BuiltDesignView | null = null;

  if (input.proposal !== null) {
    try {
      const proposal =
        input.repair
          ? parseDesignRepairProposal(
              input.proposal,
              input.assignment,
              input.previousProposal,
              { skinEnabled: input.skinEnabled },
            )
          : parseDesignProposal(input.proposal, input.assignment, {
              skinEnabled: input.skinEnabled,
            });
      if (input.simulatedFailure === "solver_limit") {
        diagnostic = diagnoseSolverLimit(new SolverLimitError(200_000, 200_001));
      } else {
        diagnostic = diagnoseDesignSpec(
          input.assignment.family,
          input.assignment.difficulty,
          proposal.spec,
        );
      }
      if (diagnostic === null) {
        if (input.simulatedFailure === "render_failure") {
          diagnostic = diagnoseRenderFailure(
            "RENDER_INVALID",
            "deterministic designer mock input-level renderability failure",
            input.assignment.family,
          );
        } else {
          const presented = solveAndPresent({
            assignment: input.assignment,
            viewId: input.viewId,
            proposal,
            skinEnabled: input.skinEnabled,
          });
          spec = proposal.spec;
          solve = presented.solve;
          choices = presented.choices;
          choicesSeed = presented.choicesSeed;
          built = presented.built;
          downstream = passedDownstreamEvidence();
        }
      }
    } catch (error) {
      if (error instanceof DesignerRunError) {
        throw error;
      }
      if (isOptionError(error)) {
        diagnostic = diagnoseOptionFailure(
          "NON_DISTINCT_OPTIONS",
          errorMessage(error),
          4,
          null,
        );
      } else if (isRenderError(error)) {
        diagnostic = diagnoseRenderFailure(
          "RENDER_INVALID",
          errorMessage(error),
          input.assignment.family,
        );
      } else if (isPresentationError(error)) {
        diagnostic = diagnosePresentationFailure(
          errorMessage(error),
          input.assignment.family,
        );
      } else {
        throw error;
      }
    }
  }

  const candidate: DesignAttemptCandidateResult = {
    proposal: input.proposal,
    rawValue: input.rawValue,
    diagnostic,
    downstream,
    logicalCallId: input.logicalCallId,
    costStatus: input.costStatus,
    costUsd: input.costUsd,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    elapsedMs: input.elapsedMs,
    artifacts: input.artifacts,
  };
  return {
    candidate,
    evidence: {
      version: DESIGNER_RUN_STAGE_PAYLOAD_VERSION,
      proposal: input.proposal,
      rawValue: input.rawValue,
      diagnostic,
      downstream,
      spec,
      solve,
      choices,
      choicesSeed,
      builtView: built?.view ?? null,
    },
    spec,
    solve,
    choices,
    choicesSeed,
    built,
  };
}

function isOptionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name.includes("Option") ||
      error.message.toLowerCase().includes("option") ||
      error.message.toLowerCase().includes("choice"))
  );
}

function isRenderError(error: unknown): boolean {
  return error instanceof Error && error.name.includes("Render");
}

function isPresentationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name.includes("DesignView") ||
      error.name.includes("Presentation") ||
      error.name.includes("Certificate") ||
      error.name.includes("Template"))
  );
}

function diagnosticFromProposalError(error: unknown): DesignDiagnostic {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    const issues = (error as { issues?: unknown }).issues;
    if (typeof code === "string") {
      if (code === "REPAIR_REPLAY") {
        return diagnoseRepairReplay(error.message);
      }
      return diagnoseProposalFailure({
        code,
        message: error.message,
        issues: Array.isArray(issues) ? issues.map(String) : [],
      });
    }
  }
  return diagnoseInfrastructureFailure(error);
}

function parseContent(
  result: OpenRouterCallResult,
): { readonly parsed: unknown | null; readonly parseError: unknown | null } {
  if (result.parsedContent !== null && result.parsedContent !== undefined) {
    return { parsed: result.parsedContent, parseError: null };
  }
  if (result.content === null || result.content.trim() === "") {
    return { parsed: null, parseError: null };
  }
  try {
    return { parsed: JSON.parse(result.content) as unknown, parseError: null };
  } catch (error) {
    return { parsed: null, parseError: error };
  }
}

function transportDiagnostic(
  result: OpenRouterCallResult,
): DesignDiagnostic | null {
  if (result.outcome === "success") {
    return null;
  }
  if (result.outcome === "already_dispatching" || result.outcome === "uncertain") {
    return diagnoseInfrastructureFailure(
      new Error(result.error?.message ?? "an ambiguous dispatch has no saved response"),
    );
  }
  if (result.outcome === "paused_budget" || result.outcome === "paused_retry_after") {
    return diagnoseInfrastructureFailure(
      new Error(result.error?.message ?? `transport paused: ${result.outcome}`),
    );
  }
  return diagnoseGenerationError(
    new Error(result.error?.message ?? `transport outcome ${result.outcome}`),
  );
}

async function loadOrCreateLogicalCall(input: {
  readonly db: Database.Database;
  readonly runKind: DesignerRunKind;
  readonly runId: string;
  readonly slotId: string;
  readonly assignment: DesignerAssignment;
  readonly arm: Extract<DesignerArm, "ai_one_shot" | "ai_feedback">;
  readonly attemptIndex: 0 | 1 | 2;
  readonly model: string;
  readonly outputCapField: OutputCapField;
  readonly maxOutputTokens: number;
  readonly settings?: AiRoleSettings;
  readonly skinEnabled: boolean;
  readonly previousProposal: DesignProposal | null;
  readonly repairInput: DesignRepairInput | null;
  readonly createdAt: string;
}): Promise<{
  readonly call: LogicalCall;
  readonly created: boolean;
}> {
  const role = attemptRoleFor(input.arm, input.attemptIndex);
  if (input.attemptIndex > 0 && input.repairInput === null) {
    throw new DesignerRunError(
      "INVALID_STATE",
      "a repair call requires a repair input",
    );
  }
  const built =
    input.attemptIndex === 0
      ? buildDesignProposalRequest({
          assignment: input.assignment,
          model: input.model,
          outputCapField: input.outputCapField,
          maxOutputTokens: input.maxOutputTokens,
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          skinEnabled: input.skinEnabled,
        })
      : buildDesignRepairRequest({
          assignment: input.assignment,
          repairInput: input.repairInput as DesignRepairInput,
          repairIndex: input.attemptIndex,
          model: input.model,
          outputCapField: input.outputCapField,
          maxOutputTokens: input.maxOutputTokens,
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          skinEnabled: input.skinEnabled,
        });
  const existingCalls = input.db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ? AND role = ?",
    )
    .all(input.runId, input.slotId, role) as Array<{ logical_call_id: string }>;
  if (existingCalls.length > 1) {
    throw new DesignerRunError(
      "INVALID_STATE",
      `multiple logical calls exist for ${input.slotId}/${role}`,
    );
  }
  if (existingCalls.length === 1) {
    const call = getLogicalCall(input.db, existingCalls[0]!.logical_call_id);
    if (
      call.model !== input.model ||
      call.outputCapField !== input.outputCapField ||
      call.expectedSchemaHash !== built.schemaHash ||
      (input.attemptIndex === 0 && call.requestHash !== built.requestHash)
    ) {
      throw new DesignerRunError(
        "PROTOCOL_MISMATCH",
        `logical call ${call.logicalCallId} does not match the current model, output cap, schema, or request`,
      );
    }
    return { call, created: false };
  }
  const call = createLogicalCall(input.db, {
    logicalCallId: randomUUID(),
    runId: input.runId,
    slotId: input.slotId,
    role,
    runKind: input.runKind,
    requestBody: built.body,
    requestHash: built.requestHash,
    expectedSchemaHash: built.schemaHash,
    model: input.model,
    outputCapField: input.outputCapField,
    createdAt: input.createdAt,
  });
  return { call, created: true };
}

async function executeAttempt(input: {
  readonly db: Database.Database;
  readonly transport: DesignerTransport;
  readonly accountId: string;
  readonly logicalCallId: string;
  readonly apiKey: string;
  readonly reservationUsd: string;
  readonly nonBilling: boolean;
  readonly clock: { now(): Date };
}): Promise<{
  readonly result: OpenRouterCallResult;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
}> {
  const started = input.clock.now();
  const result = await input.transport.executeCall({
    db: input.db,
    accountId: input.accountId,
    logicalCallId: input.logicalCallId,
    apiKey: input.apiKey,
    reservationUsd: input.reservationUsd,
    ...(input.nonBilling ? { nonBilling: true } : {}),
  });
  const finished = input.clock.now();
  return {
    result,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
  };
}

async function evaluateTransportAttempt(input: {
  readonly db: Database.Database;
  readonly assignment: DesignerAssignment;
  readonly attemptIndex: 0 | 1 | 2;
  readonly logicalCallId: string;
  readonly viewId: string;
  readonly result: OpenRouterCallResult;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly previousProposal: DesignProposal | null;
  readonly skinEnabled: boolean;
  readonly simulatedFailure: "solver_limit" | "render_failure" | null;
}): Promise<EvaluatedCandidateAttempt> {
  const { parsed, parseError } = parseContent(input.result);
  let proposal: DesignProposal | null = null;
  let diagnostic = transportDiagnostic(input.result);
  let rawValue: unknown | null = parsed;
  if (parseError !== null) {
    diagnostic = diagnoseGenerationError(
      new Error(`design response is not valid JSON: ${errorMessage(parseError)}`),
    );
    rawValue = null;
  }
  if (diagnostic === null && parsed !== null) {
    try {
      proposal =
        input.attemptIndex === 0
          ? parseDesignProposal(parsed, input.assignment, {
              skinEnabled: input.skinEnabled,
            })
          : parseDesignRepairProposal(
              parsed,
              input.assignment,
              input.previousProposal,
              { skinEnabled: input.skinEnabled },
            );
    } catch (error) {
      diagnostic = diagnosticFromProposalError(error);
    }
  }
  if (diagnostic !== null) {
    proposal = null;
  }
  const artifacts: ArtifactInput[] = [];
  const raw = rawResponseArtifact(input.db, input.logicalCallId);
  if (raw !== null) {
    artifacts.push(raw);
  }
  const cost =
    input.result.costStatus === "not_applicable"
      ? { costStatus: "known" as const, costUsd: "0" }
      : {
          costStatus: input.result.costStatus,
          costUsd: input.result.actualCostUsd,
        };
  return evaluateProposal({
    assignment: input.assignment,
    viewId: input.viewId,
    proposal,
    rawValue,
    logicalCallId: input.logicalCallId,
    costStatus: cost.costStatus,
    costUsd: cost.costUsd,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    elapsedMs: input.elapsedMs,
    artifacts,
    previousProposal: input.previousProposal,
    repair: input.attemptIndex > 0,
    skinEnabled: input.skinEnabled,
    simulatedFailure: input.simulatedFailure,
    initialDiagnostic: diagnostic,
  });
}

function persistEvaluatedAttempt(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly arm: DesignerArm;
  readonly attemptIndex: 0 | 1 | 2;
  readonly evaluated: EvaluatedCandidateAttempt;
}): DesignAttemptRecord {
  const role = attemptRoleFor(input.arm, input.attemptIndex);
  const verdict = evaluateDesignAttempt({
    arm: input.arm,
    attemptIndex: input.attemptIndex,
    responsePresent:
      input.evaluated.candidate.proposal !== null ||
      input.evaluated.candidate.rawValue !== null,
    solverDiagnostic: input.evaluated.candidate.diagnostic,
    downstream: input.evaluated.candidate.downstream,
  });
  const built = input.evaluated.built;
  const presentationArtifacts: ArtifactInput[] = [];
  if (built?.svg !== null && built?.svg !== undefined) {
    presentationArtifacts.push({
      role: "other",
      kind: "svg",
      mediaType: "image/svg+xml",
      bytes: Buffer.from(built.svg, "utf8"),
    });
  }
  if (built?.png !== null && built?.png !== undefined) {
    presentationArtifacts.push({
      role: "other",
      kind: "png",
      mediaType: "image/png",
      bytes: built.png,
    });
  }
  const artifacts = [
    ...input.evaluated.candidate.artifacts.filter(
      (artifact) => artifact.role !== "proposal",
    ),
    ...presentationArtifacts,
    evidenceArtifact(input.evaluated.evidence),
  ];
  return insertDesignAttempt(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    attemptIndex: input.attemptIndex,
    role,
    arm: input.arm,
    logicalCallId: input.evaluated.candidate.logicalCallId,
    proposalArtifact:
      input.evaluated.candidate.proposal === null
        ? null
        : proposalArtifact(input.evaluated.candidate.proposal),
    diagnostic: verdict.diagnostic,
    verdict: verdict.verdict,
    costStatus: input.evaluated.candidate.costStatus,
    costUsd: input.evaluated.candidate.costUsd,
    startedAt: input.evaluated.candidate.startedAt,
    finishedAt: input.evaluated.candidate.finishedAt,
    elapsedMs: input.evaluated.candidate.elapsedMs,
    artifacts,
  });
}

async function commitStage(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly stage: DesignerStageResultRecord["stage"];
  readonly payload: unknown;
  readonly artifacts?: readonly ArtifactInput[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly verdict?: DesignCandidateFinal["finalVerdict"];
}): Promise<void> {
  insertDesignerStageResult(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    stage: input.stage,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    elapsedMs: input.elapsedMs,
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    payload: input.payload,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  });
}

function stagePayloads(input: {
  readonly assignment: DesignerAssignment;
  readonly evaluated: EvaluatedCandidateAttempt;
}): {
  readonly formal: DesignerStageFormalPayload | null;
  readonly presentation: DesignerStagePresentationPayload | null;
  readonly svgArtifact: ArtifactInput | null;
  readonly pngArtifact: ArtifactInput | null;
} {
  const built = input.evaluated.built;
  if (built === null || input.evaluated.spec === null || input.evaluated.choices === null) {
    return {
      formal: null,
      presentation: null,
      svgArtifact: null,
      pngArtifact: null,
    };
  }
  const engine = productionRegistry.getEngine(input.assignment.family);
  const canonical = engine.canonicalData(input.evaluated.spec as never);
  const view = built.view;
  const formal: DesignerStageFormalPayload = {
    version: DESIGNER_RUN_STAGE_PAYLOAD_VERSION,
    spec: input.evaluated.spec,
    solve: {
      solutionCount: input.evaluated.solve?.solutionCount ?? 0,
      answerCount: input.evaluated.solve?.answerCount ?? 0,
    },
    choices: input.evaluated.choices,
    choicesSeed: input.evaluated.choicesSeed,
    structuralFingerprint: canonicalStructureHash(canonical),
    contentHash: sha256Hex(
      canonicalJson({
        spec: input.evaluated.spec,
        choices: input.evaluated.choices,
      }),
    ),
  };
  const presentation: DesignerStagePresentationPayload = {
    version: DESIGNER_RUN_STAGE_PAYLOAD_VERSION,
    view,
    svgHash: view.visible.assets.svgHash,
    pngHash: view.visible.assets.pngHash,
    templateHash: view.templateHash,
    certificateHash: view.certificate.certificateHash,
  };
  const svg = built.svg;
  return {
    formal,
    presentation,
    svgArtifact:
      svg === null
        ? null
        : {
            role: "presentation",
            kind: "svg",
            mediaType: "image/svg+xml",
            bytes: Buffer.from(svg, "utf8"),
          },
    pngArtifact:
      built.png === null
        ? null
        : {
            role: "presentation",
            kind: "png",
            mediaType: "image/png",
            bytes: built.png,
          },
  };
}

function proposalFromAttempt(
  db: Database.Database,
  attempt: DesignAttemptRecord,
): DesignProposal | null {
  if (attempt.proposalArtifactId === null) {
    return null;
  }
  const artifact = getArtifactById(db, attempt.proposalArtifactId);
  return JSON.parse(artifact.bytes.toString("utf8")) as DesignProposal;
}

function evidenceFromAttempt(
  db: Database.Database,
  attempt: DesignAttemptRecord,
): DesignerAttemptEvidenceArtifact | null {
  const artifact = attempt.artifacts.find(
    (entry) => entry.role === "solver_result",
  );
  if (artifact === undefined) {
    return null;
  }
  const bytes = getArtifactById(db, artifact.artifact.artifactId);
  const parsed = EvidenceArtifactSchema.safeParse(
    JSON.parse(bytes.bytes.toString("utf8")),
  );
  if (!parsed.success) {
    return null;
  }
  return parsed.data as DesignerAttemptEvidenceArtifact;
}

function evaluatedFromRecord(
  db: Database.Database,
  attempt: DesignAttemptRecord,
): EvaluatedCandidateAttempt {
  const evidence = evidenceFromAttempt(db, attempt);
  if (evidence === null) {
    throw new DesignerRunError(
      "INVALID_STATE",
      `attempt ${attempt.attemptIndex} has no evidence artifact`,
    );
  }
  return {
    candidate: {
      proposal: proposalFromAttempt(db, attempt),
      rawValue: evidence.rawValue,
      diagnostic: evidence.diagnostic,
      downstream: evidence.downstream as DesignDownstreamEvidence,
      logicalCallId: attempt.logicalCallId,
      costStatus: attempt.costStatus,
      costUsd: attempt.costUsd,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      elapsedMs: attempt.elapsedMs,
      artifacts: [],
    },
    evidence,
    spec: evidence.spec,
    solve: evidence.solve as SolveResult<unknown> | null,
    choices: evidence.choices as ChoiceSet<unknown> | null,
    choicesSeed: evidence.choicesSeed,
    built: (() => {
      if (evidence.builtView === null) {
        return null;
      }
      const svgArtifact = attempt.artifacts.find(
        (artifact) =>
          artifact.role === "other" &&
          artifact.artifact.kind === "svg",
      );
      const pngArtifact = attempt.artifacts.find(
        (artifact) =>
          artifact.role === "other" &&
          artifact.artifact.kind === "png",
      );
      return {
        view: evidence.builtView,
        svg:
          svgArtifact === undefined
            ? null
            : getArtifactById(db, svgArtifact.artifact.artifactId).bytes.toString(
                "utf8",
              ),
        png:
          pngArtifact === undefined
            ? null
            : getArtifactById(db, pngArtifact.artifact.artifactId).bytes,
        previewPng: null,
      } as BuiltDesignView;
    })(),
  };
}

function rawValueFromAttempt(
  db: Database.Database,
  attempt: DesignAttemptRecord,
): unknown | null {
  return evidenceFromAttempt(db, attempt)?.rawValue ?? null;
}

async function commitTerminal(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slot: DesignerSlotRecord;
  readonly assignment: DesignerAssignment;
  readonly clock: { now(): Date };
  readonly hooks?: DesignerRunHooks;
}): Promise<void> {
  if (stageExists(input.db, input.runId, input.slot.slotId, "terminal")) {
    return;
  }
  await input.hooks?.faults?.beforeTerminalCommit?.({ slotId: input.slot.slotId });
  const attempts = listDesignAttempts(input.db, input.runId, input.slot.slotId);
  const finalAttempt = attempts[attempts.length - 1];
  if (finalAttempt === undefined) {
    throw new DesignerRunError(
      "INCOMPLETE_RUN",
      `candidate ${input.slot.slotId} has no attempts`,
    );
  }
  const final = reduceDesignCandidate({
    slotId: input.slot.slotId,
    assignmentId: input.assignment.assignmentId,
    arm: input.slot.arm,
    family: input.assignment.family,
    difficulty: input.assignment.difficulty,
    attempts,
    paused: null,
    repairBlocked: null,
  });
  const firstProposal = proposalFromAttempt(input.db, attempts[0]!);
  const finalProposal = proposalFromAttempt(input.db, finalAttempt);
  const acceptedAttempt = [...attempts]
    .reverse()
    .find((attempt) => attempt.verdict === "accepted");
  const acceptedEvidence =
    acceptedAttempt === undefined ? null : evaluatedFromRecord(input.db, acceptedAttempt);
  await commitStage({
    db: input.db,
    runId: input.runId,
    slotId: input.slot.slotId,
    stage: "terminal",
    payload: {
      version: DESIGNER_RUN_STAGE_PAYLOAD_VERSION,
      final,
      firstProposalHash:
        firstProposal === null ? null : sha256Hex(canonicalJson(firstProposal)),
      finalProposalHash:
        finalProposal === null ? null : sha256Hex(canonicalJson(finalProposal)),
      firstAccepted: attempts[0]?.verdict === "accepted",
      finalAccepted: final.finalVerdict === "accepted",
      baseline: null,
      designViewHash:
        acceptedEvidence?.built?.view.certificate.certificateHash ?? null,
    } satisfies DesignerStageTerminalPayload,
    startedAt: attempts[0]!.startedAt,
    finishedAt: nowIso(input.clock),
    elapsedMs: 0,
    verdict: final.finalVerdict,
  });
}

async function processBaselineCandidate(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slot: DesignerSlotRecord;
  readonly assignment: DesignerAssignment;
  readonly clock: { now(): Date };
  readonly hooks?: DesignerRunHooks;
}): Promise<void> {
  if (stageExists(input.db, input.runId, input.slot.slotId, "terminal")) {
    return;
  }
  const started = input.clock.now();
  let outcome: BaselineOutcome;
  try {
    outcome = buildBaselineOutcome({
      source: "cohort",
      sourceIndex: input.assignment.assignmentOrdinal,
      assignmentId: input.assignment.assignmentId,
      family: input.assignment.family,
      difficulty: input.assignment.difficulty,
      seed: input.assignment.assignmentSeed,
    });
  } catch (error) {
    const finished = input.clock.now();
    const diagnostic = diagnoseBaselineConstructionFailure(errorMessage(error));
    const evaluated = evaluateProposal({
      assignment: input.assignment,
      viewId: input.slot.slotId,
      proposal: null,
      rawValue: null,
      logicalCallId: null,
      costStatus: "none",
      costUsd: "0",
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
      artifacts: [],
      previousProposal: null,
      repair: false,
      skinEnabled: false,
      simulatedFailure: null,
    });
    const record = insertDesignAttempt(input.db, {
      runId: input.runId,
      slotId: input.slot.slotId,
      attemptIndex: 0,
      role: "baseline",
      arm: "baseline",
      logicalCallId: null,
      proposalArtifact: null,
      diagnostic,
      verdict: "inconclusive",
      costStatus: "none",
      costUsd: "0",
      startedAt: evaluated.candidate.startedAt,
      finishedAt: evaluated.candidate.finishedAt,
      elapsedMs: evaluated.candidate.elapsedMs,
      artifacts: [evidenceArtifact(evaluated.evidence)],
    });
    await input.hooks?.onAttemptPersisted?.(record);
    await commitTerminal(input);
    return;
  }
  if (outcome.status !== "constructed" || outcome.spec === null) {
    const finished = input.clock.now();
    const record = insertDesignAttempt(input.db, {
      runId: input.runId,
      slotId: input.slot.slotId,
      attemptIndex: 0,
      role: "baseline",
      arm: "baseline",
      logicalCallId: null,
      proposalArtifact: null,
      diagnostic: diagnoseBaselineConstructionFailure(
        outcome.failureMessage ?? "baseline construction failed",
      ),
      verdict: "inconclusive",
      costStatus: "none",
      costUsd: "0",
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
      artifacts: [],
    });
    await input.hooks?.onAttemptPersisted?.(record);
    await commitTerminal(input);
    return;
  }
  const proposal = {
    family: input.assignment.family,
    difficulty: input.assignment.difficulty,
    spec: outcome.spec,
    designIntent: null,
    presentationSkin: null,
  } as DesignProposal;
  const finished = input.clock.now();
  const evaluated = evaluateProposal({
    assignment: input.assignment,
    viewId: input.slot.slotId,
    proposal,
    rawValue: null,
    logicalCallId: null,
    costStatus: "none",
    costUsd: "0",
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
    artifacts: [],
    previousProposal: null,
    repair: false,
    skinEnabled: false,
    simulatedFailure: null,
  });
  const verdict = evaluateDesignAttempt({
    arm: "baseline",
    attemptIndex: 0,
    responsePresent: true,
    solverDiagnostic: evaluated.candidate.diagnostic,
    downstream: evaluated.candidate.downstream,
  });
  const record = insertDesignAttempt(input.db, {
    runId: input.runId,
    slotId: input.slot.slotId,
    attemptIndex: 0,
    role: "baseline",
    arm: "baseline",
    logicalCallId: null,
    proposalArtifact: proposalArtifact(proposal),
    diagnostic: verdict.diagnostic,
    verdict: verdict.verdict,
    costStatus: "none",
    costUsd: "0",
    startedAt: evaluated.candidate.startedAt,
    finishedAt: evaluated.candidate.finishedAt,
    elapsedMs: evaluated.candidate.elapsedMs,
    artifacts: [evidenceArtifact(evaluated.evidence)],
  });
  await input.hooks?.onAttemptPersisted?.(record);
  const payloads = stagePayloads({
    assignment: input.assignment,
    evaluated,
  });
  if (payloads.formal !== null) {
    await commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slot.slotId,
      stage: "formal_checked",
      payload: payloads.formal,
      startedAt: evaluated.candidate.startedAt,
      finishedAt: evaluated.candidate.finishedAt,
      elapsedMs: evaluated.candidate.elapsedMs,
    });
  }
  if (payloads.presentation !== null) {
    await commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slot.slotId,
      stage: "presentation_ready",
      payload: payloads.presentation,
      startedAt: evaluated.candidate.startedAt,
      finishedAt: evaluated.candidate.finishedAt,
      elapsedMs: evaluated.candidate.elapsedMs,
      ...(payloads.svgArtifact === null && payloads.pngArtifact === null
        ? {}
        : {
            artifacts: [
              ...(payloads.svgArtifact === null ? [] : [payloads.svgArtifact]),
              ...(payloads.pngArtifact === null ? [] : [payloads.pngArtifact]),
            ],
          }),
    });
  }
  await commitTerminal(input);
}

async function processAiCandidate(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly runKind: DesignerRunKind;
  readonly slot: DesignerSlotRecord;
  readonly assignment: DesignerAssignment;
  readonly arm: Extract<DesignerArm, "ai_one_shot" | "ai_feedback">;
  readonly evidenceKind: "mock" | "live";
  readonly apiKey: string;
  readonly transport: DesignerTransport;
  readonly accountId: string;
  readonly config: DesignerRunConfig;
  readonly clock: { now(): Date };
  readonly hooks?: DesignerRunHooks;
}): Promise<void> {
  if (stageExists(input.db, input.runId, input.slot.slotId, "terminal")) {
    return;
  }
  const records: DesignAttemptRecord[] = [
    ...listDesignAttempts(input.db, input.runId, input.slot.slotId),
  ];
  let previousProposal: DesignProposal | null = null;
  let previousDiagnostic: DesignDiagnostic | null = null;
  let previousRaw: unknown | null = null;
  let paused: "budget" | "operator" | null = null;
  if (records.length > 0) {
    const last = records[records.length - 1]!;
    previousProposal = proposalFromAttempt(input.db, last);
    previousDiagnostic = diagnosticForRepair(last);
    previousRaw = rawValueFromAttempt(input.db, last);
  }
  for (let index = records.length; index <= maxAttemptIndexForArm(input.arm); index += 1) {
    const attemptIndex = index as 0 | 1 | 2;
    if (attemptIndex > 0) {
      if (previousDiagnostic === null) {
        break;
      }
      if (previousProposal === null && previousRaw === null) {
        break;
      }
    }
    const repairInput =
      attemptIndex === 0
        ? null
        : buildDesignRepairInput({
            assignment: {
              assignmentId: input.assignment.assignmentId,
              family: input.assignment.family,
              difficulty: input.assignment.difficulty,
            },
            previousProposal,
            previousRawValue: previousRaw,
            diagnostic: previousDiagnostic as DesignDiagnostic,
          });
    const logical = await loadOrCreateLogicalCall({
      db: input.db,
      runKind: input.runKind,
      runId: input.runId,
      slotId: input.slot.slotId,
      assignment: input.assignment,
      arm: input.arm,
      attemptIndex,
      model: input.config.model,
      outputCapField: input.config.outputCapField,
      maxOutputTokens: input.config.maxOutputTokens,
      ...(input.config.settings === undefined
        ? {}
        : { settings: input.config.settings }),
      skinEnabled: input.config.skinEnabled,
      previousProposal,
      repairInput,
      createdAt: nowIso(input.clock),
    });
    const callAttempts = listAttempts(input.db, logical.call.logicalCallId);
    const saved = callAttempts.find(
      (attempt) => attempt.state === "response_saved" || attempt.state === "validated",
    );
    if (saved !== undefined) {
      settleSavedResponseReservation(input.db, logical.call.logicalCallId, saved);
      const evaluated = evaluateSavedResponse({
        db: input.db,
        assignment: input.assignment,
        attemptIndex,
        logicalCallId: logical.call.logicalCallId,
        viewId: input.slot.slotId,
        saved,
        previousProposal,
        skinEnabled: input.config.skinEnabled,
        simulatedFailure: mockSimulationFor(
          input.transport,
          logical.call.logicalCallId,
          input.assignment,
          input.arm,
          attemptIndex,
          input.evidenceKind,
        ),
      });
      const record = persistEvaluatedAttempt({
        db: input.db,
        runId: input.runId,
        slotId: input.slot.slotId,
        arm: input.arm,
        attemptIndex,
        evaluated,
      });
      records.push(record);
      await input.hooks?.onAttemptPersisted?.(record);
      await input.hooks?.faults?.afterAttemptCommit?.({
        attemptId: `${input.slot.slotId}/${attemptIndex}`,
      });
      previousProposal = evaluated.candidate.proposal;
      previousDiagnostic = diagnosticForRepair(record);
      previousRaw = evaluated.candidate.rawValue;
      if (record.verdict === "accepted") {
        break;
      }
      continue;
    }
    if (
      logical.call.state === "dispatching" ||
      callAttempts.some((attempt) => attempt.state === "dispatching")
    ) {
      const evaluated = evaluateProposal({
        assignment: input.assignment,
        viewId: input.slot.slotId,
        proposal: null,
        rawValue: null,
        logicalCallId: logical.call.logicalCallId,
        costStatus: "unknown",
        costUsd: null,
        startedAt: nowIso(input.clock),
        finishedAt: nowIso(input.clock),
        elapsedMs: 0,
        artifacts: [],
        previousProposal,
        repair: attemptIndex > 0,
        skinEnabled: input.config.skinEnabled,
        simulatedFailure: null,
        initialDiagnostic: diagnoseInfrastructureFailure(
          new Error("a dispatching call has no saved response; refusing to resend"),
        ),
      });
      const record = persistEvaluatedAttempt({
        db: input.db,
        runId: input.runId,
        slotId: input.slot.slotId,
        arm: input.arm,
        attemptIndex,
        evaluated,
      });
      records.push(record);
      await input.hooks?.onAttemptPersisted?.(record);
      break;
    }
    const mockScenario =
      input.evidenceKind === "mock" && input.transport.isMock === true
        ? designerMockScenarioFor(
            {
              assignmentId: input.assignment.assignmentId,
              assignmentOrdinal: input.assignment.assignmentOrdinal,
              family: input.assignment.family,
              difficulty: input.assignment.difficulty,
            },
            input.arm,
            attemptIndex,
          )
        : null;
    if (
      mockScenario !== null &&
      input.transport.registerDesignerScenario !== undefined
    ) {
      input.transport.registerDesignerScenario(
        logical.call.logicalCallId,
        mockScenario,
      );
    }
    await input.hooks?.faults?.beforeDispatch?.({
      logicalCallId: logical.call.logicalCallId,
    });
    const executed = await executeAttempt({
      db: input.db,
      transport: input.transport,
      accountId: input.accountId,
      logicalCallId: logical.call.logicalCallId,
      apiKey: input.apiKey,
      reservationUsd: input.config.reservationUsd,
      nonBilling: input.config.nonBilling,
      clock: input.clock,
    });
    await input.hooks?.faults?.afterDispatch?.({
      logicalCallId: logical.call.logicalCallId,
    });
    if (
      executed.result.outcome === "paused_budget" ||
      executed.result.outcome === "paused_retry_after"
    ) {
      paused = "budget";
      break;
    }
    if (attemptIndex > 0) {
      await input.hooks?.faults?.afterRepairResponse?.({
        logicalCallId: logical.call.logicalCallId,
      });
    }
    const evaluated = await evaluateTransportAttempt({
      db: input.db,
      assignment: input.assignment,
      attemptIndex,
      logicalCallId: logical.call.logicalCallId,
      viewId: input.slot.slotId,
      result: executed.result,
      startedAt: executed.startedAt,
      finishedAt: executed.finishedAt,
      elapsedMs: executed.elapsedMs,
      previousProposal,
      skinEnabled: input.config.skinEnabled,
      simulatedFailure: mockSimulationFor(
        input.transport,
        logical.call.logicalCallId,
        input.assignment,
        input.arm,
        attemptIndex,
        input.evidenceKind,
      ),
    });
    await input.hooks?.faults?.afterResponseSaved?.({
      logicalCallId: logical.call.logicalCallId,
    });
    const record = persistEvaluatedAttempt({
      db: input.db,
      runId: input.runId,
      slotId: input.slot.slotId,
      arm: input.arm,
      attemptIndex,
      evaluated,
    });
    records.push(record);
    await input.hooks?.onAttemptPersisted?.(record);
    await input.hooks?.faults?.afterAttemptCommit?.({
      attemptId: `${input.slot.slotId}/${attemptIndex}`,
    });
    previousProposal = evaluated.candidate.proposal;
    previousDiagnostic = diagnosticForRepair(record);
    previousRaw = evaluated.candidate.rawValue;
    if (record.verdict === "accepted" || paused !== null) {
      break;
    }
  }
  if (records.length === 0) {
    throw new DesignerRunError(
      "INCOMPLETE_RUN",
      `candidate ${input.slot.slotId} has no attempts`,
    );
  }
  reduceDesignCandidate({
    slotId: input.slot.slotId,
    assignmentId: input.assignment.assignmentId,
    arm: input.arm,
    family: input.assignment.family,
    difficulty: input.assignment.difficulty,
    attempts: records,
    paused,
    repairBlocked: null,
  });
  if (paused !== null) {
    return;
  }
  const firstEvaluated = evaluatedFromRecord(input.db, records[0]!);
  const firstPayloads = stagePayloads({
    assignment: input.assignment,
    evaluated: firstEvaluated,
  });
  const acceptedRecord = [...records]
    .reverse()
    .find((record) => record.verdict === "accepted");
  const acceptedEvaluated =
    acceptedRecord === undefined
      ? null
      : evaluatedFromRecord(input.db, acceptedRecord);
  const acceptedPayloads =
    acceptedEvaluated === null
      ? null
      : stagePayloads({
          assignment: input.assignment,
          evaluated: acceptedEvaluated,
        });
  if (
    !stageExists(input.db, input.runId, input.slot.slotId, "design_proposed") &&
    listDesignerStageResults(input.db, input.runId, input.slot.slotId).length === 0
  ) {
    const firstProposal = proposalFromAttempt(input.db, records[0]!);
    await commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slot.slotId,
      stage: "design_proposed",
      payload: {
        version: DESIGNER_RUN_STAGE_PAYLOAD_VERSION,
        attemptIndex: 0,
        proposalHash:
          firstProposal === null ? null : sha256Hex(canonicalJson(firstProposal)),
        diagnosticHash:
          records[0]!.diagnostic === null
            ? null
            : sha256Hex(canonicalJson(records[0]!.diagnostic)),
        verdict: records[0]!.verdict,
      },
      startedAt: records[0]!.startedAt,
      finishedAt: records[0]!.finishedAt,
      elapsedMs: records[0]!.elapsedMs,
    });
  }
  const formalPayloads =
    firstPayloads.formal !== null ? firstPayloads : acceptedPayloads;
  const formalRecord =
    firstPayloads.formal !== null ? records[0]! : acceptedRecord;
  if (
    formalPayloads !== null &&
    formalPayloads.formal !== null &&
    formalRecord !== undefined &&
    !stageExists(input.db, input.runId, input.slot.slotId, "formal_checked")
  ) {
    await commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slot.slotId,
      stage: "formal_checked",
      payload: formalPayloads.formal,
      startedAt: formalRecord.startedAt,
      finishedAt: formalRecord.finishedAt,
      elapsedMs: formalRecord.elapsedMs,
    });
  }
  if (
    acceptedPayloads !== null &&
    acceptedPayloads.presentation !== null &&
    !stageExists(input.db, input.runId, input.slot.slotId, "presentation_ready")
  ) {
    await commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slot.slotId,
      stage: "presentation_ready",
      payload: acceptedPayloads.presentation,
      startedAt: acceptedRecord?.startedAt ?? records[0]!.startedAt,
      finishedAt: acceptedRecord?.finishedAt ?? records[0]!.finishedAt,
      elapsedMs: acceptedRecord?.elapsedMs ?? records[0]!.elapsedMs,
      ...(acceptedPayloads.svgArtifact === null && acceptedPayloads.pngArtifact === null
        ? {}
        : {
            artifacts: [
              ...(acceptedPayloads.svgArtifact === null
                ? []
                : [acceptedPayloads.svgArtifact]),
              ...(acceptedPayloads.pngArtifact === null
                ? []
                : [acceptedPayloads.pngArtifact]),
            ],
          }),
    });
  }
  await commitTerminal(input);
}

function settleSavedResponseReservation(
  db: Database.Database,
  logicalCallId: string,
  saved: RequestAttempt,
): void {
  const row = db
    .prepare(
      "SELECT reservation_id, state FROM budget_reservations WHERE logical_call_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(logicalCallId) as
    | { reservation_id: string; state: string }
    | undefined;
  if (row === undefined || row.state !== "reserved") {
    return;
  }
  settleReservation(db, {
    reservationId: row.reservation_id,
    actualCostUsd: saved.actualCostUsd,
    createdAt: saved.finishedAt ?? new Date().toISOString(),
  });
}

function evaluateSavedResponse(input: {
  readonly db: Database.Database;
  readonly assignment: DesignerAssignment;
  readonly attemptIndex: 0 | 1 | 2;
  readonly logicalCallId: string;
  readonly viewId: string;
  readonly saved: RequestAttempt;
  readonly previousProposal: DesignProposal | null;
  readonly skinEnabled: boolean;
  readonly simulatedFailure: "solver_limit" | "render_failure" | null;
}): EvaluatedCandidateAttempt {
  const raw = rawResponseArtifact(input.db, input.logicalCallId);
  if (raw === null) {
    throw new DesignerRunError(
      "INVALID_STATE",
      `saved response is missing its artifact for ${input.logicalCallId}`,
    );
  }
  const rawBody = JSON.parse(raw.bytes.toString("utf8")) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = rawBody.choices?.[0]?.message?.content ?? null;
  let parsed: unknown | null = null;
  if (content !== null && content.trim() !== "") {
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      parsed = null;
    }
  }
  let proposal: DesignProposal | null = null;
  let diagnostic: DesignDiagnostic | null = null;
  if (parsed === null) {
    diagnostic = diagnoseGenerationError(
      new Error("saved design response has no JSON content"),
    );
  } else {
    try {
      proposal =
        input.attemptIndex === 0
          ? parseDesignProposal(parsed, input.assignment, {
              skinEnabled: input.skinEnabled,
            })
          : parseDesignRepairProposal(
              parsed,
              input.assignment,
              input.previousProposal,
              { skinEnabled: input.skinEnabled },
            );
    } catch (error) {
      diagnostic = diagnosticFromProposalError(error);
    }
  }
  if (diagnostic !== null) {
    proposal = null;
  }
  return evaluateProposal({
    assignment: input.assignment,
    viewId: input.viewId,
    proposal,
    rawValue: parsed,
    logicalCallId: input.logicalCallId,
    costStatus: input.saved.costStatus,
    costUsd: input.saved.actualCostUsd,
    startedAt:
      input.saved.startedAt ??
      input.saved.createdAt,
    finishedAt:
      input.saved.finishedAt ??
      input.saved.startedAt ??
      input.saved.createdAt,
    elapsedMs: input.saved.elapsedMs ?? 0,
    artifacts: [raw],
    previousProposal: input.previousProposal,
    repair: input.attemptIndex > 0,
    skinEnabled: input.skinEnabled,
    simulatedFailure: input.simulatedFailure,
    initialDiagnostic: diagnostic,
  });
}

function mockSimulationFor(
  transport: DesignerTransport,
  logicalCallId: string,
  assignment: DesignerAssignment,
  arm: Extract<DesignerArm, "ai_one_shot" | "ai_feedback">,
  attemptIndex: 0 | 1 | 2,
  evidenceKind: "mock" | "live",
): "solver_limit" | "render_failure" | null {
  const registered = transport.getDesignerScenario?.(logicalCallId)?.simulation;
  if (registered !== undefined && registered !== null) {
    return registered;
  }
  if (evidenceKind !== "mock") {
    return null;
  }
  return (
    designerMockScenarioFor(
      {
        assignmentId: assignment.assignmentId,
        assignmentOrdinal: assignment.assignmentOrdinal,
        family: assignment.family,
        difficulty: assignment.difficulty,
      },
      arm,
      attemptIndex,
    )?.simulation ?? null
  );
}

function summarizeRun(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly plan: DesignerPlanManifest;
  readonly accountId: string;
  readonly status: DesignerRunSummary["status"];
  readonly cancellation: DesignerRunSummary["cancellation"];
}): DesignerRunSummary {
  const slots = listDesignerSlots(input.db, input.runId);
  const verdicts = {
    accepted: 0,
    rejected: 0,
    inconclusive: 0,
    generation_error: 0,
  };
  for (const slot of slots) {
    if (slot.verdict !== null) {
      verdicts[slot.verdict] += 1;
    }
  }
  const attemptRows = input.db
    .prepare(
      "SELECT cost_status, cost_usd FROM design_attempts WHERE run_id = ?",
    )
    .all(input.runId) as Array<{ cost_status: string; cost_usd: string | null }>;
  const unknown = attemptRows.filter((row) => row.cost_status === "unknown").length;
  const known = attemptRows
    .filter((row) => row.cost_status === "known" && row.cost_usd !== null)
    .reduce((sum, row) => sum + Number(row.cost_usd), 0);
  const account = getBudgetAccount(input.db, input.accountId);
  return {
    runId: input.runId,
    planHash: input.plan.planHash,
    status: input.status,
    assignments: input.plan.assignments.length,
    candidates: input.plan.candidates.length,
    terminalCandidates: slots.filter((slot) => slot.stage === "terminal").length,
    accepted: verdicts.accepted,
    rejected: verdicts.rejected,
    inconclusive: verdicts.inconclusive,
    generationErrors: verdicts.generation_error,
    attempts: attemptRows.length,
    knownCostUsd: unknown > 0 ? null : known.toFixed(6),
    unknownAttempts: unknown,
    budget: {
      knownActualUsd: account.knownActualUsd,
      reservedUsd: account.reservedUsd,
      unknownExposureUsd: account.unknownExposureUsd,
      maxCostUsd: account.maxCostUsd,
    },
    cancellation: input.cancellation,
  };
}

function finishCancelled(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly plan: DesignerPlanManifest;
  readonly accountId: string;
  readonly clock: { now(): Date };
  readonly cancellation: RunCancellation;
  readonly phase: string;
  readonly drained: "drained" | "timeout";
}): RunDesignerCohortResult {
  const marked = markUnfinishedDispatchesUncertain(
    input.db,
    input.runId,
    nowIso(input.clock),
  );
  const cancellation = {
    reason: input.cancellation.stopReason ?? "operator",
    phase: input.phase,
    drained: input.drained,
    markedUncertain: marked.length,
  };
  const summary = summarizeRun({
    db: input.db,
    runId: input.runId,
    plan: input.plan,
    accountId: input.accountId,
    status: "cancelled",
    cancellation,
  });
  insertEvent(input.db, {
    runId: input.runId,
    slotId: null,
    eventType: "run_cancelled",
    stage: null,
    payload: { ...cancellation, terminalCandidates: summary.terminalCandidates },
    createdAt: nowIso(input.clock),
  });
  return {
    runId: input.runId,
    plan: input.plan,
    status: "cancelled",
    slots: listDesignerSlots(input.db, input.runId),
    summary,
    cancellation,
  };
}

export async function runDesignerCohort(
  input: RunDesignerCohortInput,
): Promise<RunDesignerCohortResult> {
  const isMock = input.transport.isMock === true;
  if (input.evidenceKind === "mock" && !isMock) {
    throw new DesignerRunError(
      "INVALID_INPUT",
      "mock designer runs require the deterministic mock transport",
    );
  }
  if (input.evidenceKind === "live" && isMock) {
    throw new DesignerRunError(
      "INVALID_INPUT",
      "live designer runs cannot use the deterministic mock transport",
    );
  }
  if (!UsdSchema.safeParse(input.maxCostUsd).success) {
    throw new DesignerRunError(
      "INVALID_INPUT",
      "maxCostUsd must be a non-negative decimal USD string",
    );
  }
  let concurrency: Concurrency;
  try {
    concurrency = assertConcurrency(input.concurrency ?? DEFAULT_CONCURRENCY);
  } catch (error) {
    throw new DesignerRunError("INVALID_INPUT", errorMessage(error), {
      cause: error,
    });
  }
  const plan = DesignerPlanManifestSchema.parse(input.plan);
  if (
    input.evidenceKind === "mock" &&
    plan.runKind !== "design_mock" &&
    plan.runKind !== "design_pilot"
  ) {
    throw new DesignerRunError(
      "INVALID_INPUT",
      "mock designer runs must use a design_mock or design_pilot plan",
    );
  }
  if (plan.protocolVersion !== DESIGNER_PROTOCOL_VERSION) {
    throw new DesignerRunError("PROTOCOL_MISMATCH", "designer protocol mismatch");
  }
  const clock = input.clock ?? { now: () => new Date() };
  const cancellation = input.cancellation ?? new RunCancellation();
  const yieldBetweenJobs = input.yieldBetweenJobs ?? yieldToEventLoop;
  const drainTimeoutMs = input.drainTimeoutMs ?? 95_000;
  const wrapped = withCancellationTransport(input.transport, cancellation);
  const transport = Object.assign(wrapped, {
    ...(input.transport.isMock === true ? { isMock: true as const } : {}),
    ...(input.transport.registerDesignerScenario === undefined
      ? {}
      : {
          registerDesignerScenario:
            input.transport.registerDesignerScenario.bind(input.transport),
        }),
    ...(input.transport.getDesignerScenario === undefined
      ? {}
      : {
          getDesignerScenario:
            input.transport.getDesignerScenario.bind(input.transport),
        }),
  }) as DesignerTransport;
  const createdAt = nowIso(clock);
  const resume = input.resume === true;
  let created = false;
  let phase = "baseline";
  try {
    if (resume) {
      const run = getDesignerRun(input.db, input.runId);
      if (run.evidenceKind !== input.evidenceKind) {
        throw new DesignerRunError(
          "INVALID_INPUT",
          `run evidence mode is ${run.evidenceKind}, not ${input.evidenceKind}`,
        );
      }
      if (
        run.manifestHash !== plan.planHash ||
        run.protocolVersion !== plan.protocolVersion ||
        run.rootSeed !== plan.rootSeed ||
        run.runKind !== plan.runKind ||
        run.manifest.planHash !== plan.planHash
      ) {
        throw new DesignerRunError(
          "PROTOCOL_MISMATCH",
          "stored designer manifest, protocol, seed, or mode no longer matches",
        );
      }
      if (run.controlState === "completed") {
        throw new DesignerRunError("INVALID_INPUT", "run is already completed");
      }
      const storedConfiguration = readDesignerConfigurationEvent(
        input.db,
        input.runId,
      );
      if (storedConfiguration !== null) {
        if (input.configurationSnapshot === undefined) {
          throw new DesignerRunError(
            "PROTOCOL_MISMATCH",
            "resume requires the same configuration snapshot that started the run",
          );
        }
        if (
          computeDesignerConfigurationHash(storedConfiguration) !==
          computeDesignerConfigurationHash(input.configurationSnapshot)
        ) {
          const differingFields = DESIGNER_CONFIGURATION_HASH_FIELDS.filter(
            (field) =>
              canonicalJson(storedConfiguration[field]) !==
              canonicalJson(input.configurationSnapshot?.[field]),
          );
          throw new DesignerRunError(
            "PROTOCOL_MISMATCH",
            `resume configuration differs from the stored designer configuration: ${differingFields.join(", ") || "configuration hash"}`,
          );
        }
      }
      if (run.controlState !== "running") {
        setRunControlState(input.db, input.runId, "running");
        insertEvent(input.db, {
          runId: input.runId,
          slotId: null,
          eventType: "run_resumed",
          stage: null,
          payload: { previousControlState: run.controlState },
          createdAt,
        });
      }
    } else {
      createDesignerRun(input.db, {
        runId: input.runId,
        plan,
        evidenceKind: input.evidenceKind,
        createdAt,
      });
      if (input.configurationSnapshot !== undefined) {
        insertEvent(input.db, {
          runId: input.runId,
          slotId: null,
          eventType: "designer_configuration",
          stage: null,
          payload: input.configurationSnapshot,
          createdAt,
        });
      }
      createBudgetAccount(input.db, {
        accountId: input.accountId,
        runId: input.runId,
        runKind: plan.runKind,
        maxCostUsd: input.maxCostUsd,
        createdAt,
      });
      created = true;
    }
    if (input.beforeRun !== undefined) {
      await input.beforeRun({ db: input.db, runId: input.runId });
    }
    const assignments = new Map(
      plan.assignments.map((assignment) => [assignment.assignmentId, assignment]),
    );
    const selected = input.slotIds === undefined
      ? null
      : new Set(input.slotIds);
    if (
      selected !== null &&
      [...selected].some(
        (slotId) =>
          !plan.candidates.some(
            (candidate) => candidate.candidateSlotId === slotId,
          ),
      )
    ) {
      throw new DesignerRunError(
        "INVALID_INPUT",
        "slotIds contains a candidate outside the designer plan",
      );
    }
    const slots = plan.candidates
      .filter(
        (candidate) =>
          selected === null || selected.has(candidate.candidateSlotId),
      )
      .map((candidate) =>
        getDesignerSlot(input.db, input.runId, candidate.candidateSlotId),
      );
    const baselineSlots = slots.filter((slot) => slot.arm === "baseline");
    phase = "baseline";
    const baselinePool = await runBoundedPool(
      baselineSlots,
      async (slot) => {
        cancellation.throwIfStopping();
        const assignment = assignments.get(slot.assignmentId);
        if (assignment === undefined) {
          throw new DesignerRunError(
            "INVALID_STATE",
            `no assignment for ${slot.assignmentId}`,
          );
        }
        await processBaselineCandidate({
          db: input.db,
          runId: input.runId,
          slot,
          assignment,
          clock,
          ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
        });
        await input.hooks?.onSlotCompleted?.(slot.slotId);
      },
      { concurrency, cancellation, drainTimeoutMs, yieldBetweenJobs },
    );
    if (baselinePool.stopped || cancellation.isStopping) {
      return finishCancelled({
        db: input.db,
        runId: input.runId,
        plan,
        accountId: input.accountId,
        clock,
        cancellation,
        phase,
        drained: baselinePool.drained === "timeout" ? "timeout" : "drained",
      });
    }
    if (baselinePool.errors.length > 0) {
      throw baselinePool.errors[0];
    }
    phase = "ai";
    const aiSlots = slots.filter((slot) => slot.arm !== "baseline");
    const aiPool = await runBoundedPool(
      aiSlots,
      async (slot) => {
        cancellation.throwIfStopping();
        const assignment = assignments.get(slot.assignmentId);
        if (assignment === undefined) {
          throw new DesignerRunError(
            "INVALID_STATE",
            `no assignment for ${slot.assignmentId}`,
          );
        }
        if (slot.arm === "baseline") {
          throw new DesignerRunError("INVALID_STATE", "unexpected baseline slot");
        }
        await processAiCandidate({
          db: input.db,
          runId: input.runId,
          runKind: plan.runKind,
          slot,
          assignment,
          arm: slot.arm,
          evidenceKind: input.evidenceKind,
          apiKey: input.apiKey,
          transport,
          accountId: input.accountId,
          config: input.config,
          clock,
          ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
        });
        await input.hooks?.onSlotCompleted?.(slot.slotId);
      },
      { concurrency, cancellation, drainTimeoutMs, yieldBetweenJobs },
    );
    if (aiPool.stopped || cancellation.isStopping) {
      return finishCancelled({
        db: input.db,
        runId: input.runId,
        plan,
        accountId: input.accountId,
        clock,
        cancellation,
        phase,
        drained: aiPool.drained === "timeout" ? "timeout" : "drained",
      });
    }
    if (aiPool.errors.length > 0) {
      throw aiPool.errors[0];
    }
    const finalSlots = listDesignerSlots(input.db, input.runId);
    const relevantSlots =
      selected === null
        ? finalSlots
        : finalSlots.filter((slot) => selected.has(slot.slotId));
    const incomplete = relevantSlots.filter(
      (slot) => slot.stage !== "terminal" || slot.verdict === null,
    );
    if (incomplete.length > 0) {
      throw new DesignerRunError(
        "INCOMPLETE_RUN",
        `designer run has ${incomplete.length} non-terminal candidates`,
      );
    }
    const summary = summarizeRun({
      db: input.db,
      runId: input.runId,
      plan,
      accountId: input.accountId,
      status: "completed",
      cancellation: null,
    });
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
      slots: finalSlots,
      summary,
      cancellation: null,
    };
  } catch (error) {
    if (created) {
      try {
        const run = getDesignerRun(input.db, input.runId);
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
            message: errorMessage(error),
            phase,
          },
          createdAt: nowIso(clock),
        });
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

export async function resumeDesignerCohort(
  input: Omit<RunDesignerCohortInput, "resume">,
): Promise<RunDesignerCohortResult> {
  return runDesignerCohort({ ...input, resume: true });
}
