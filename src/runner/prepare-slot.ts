import type Database from "better-sqlite3";
import { z } from "zod";
import { addUsd } from "../ai/budget.js";
import {
  getLogicalCall,
  listAttempts,
  RequestStateSchema,
} from "../ai/ledger.js";
import {
  mockScenarioForFamily,
  type MockScenarioKind,
  type MockTransport,
} from "../ai/mock.js";
import type { createOpenRouterTransport } from "../ai/openrouter.js";
import type { ResolvedRoute } from "../ai/preflight.js";
import { proposeSpec, SpecProposalError } from "../ai/propose-spec.js";
import { writeWording, WordingError } from "../ai/write-wording.js";
import {
  ChoiceSetSchema,
  deepEqual,
  verifyChoiceSet,
  type ChoiceSet,
} from "../domain/answers.js";
import {
  CandidateBarrierInputSchema,
  CandidateFingerprintSchema,
  FailureRecordSchema,
  WorkflowStageSchema,
  type CandidateFingerprint,
  type CandidateVerdict,
  type FailureRecord,
  type WorkflowStage,
} from "../domain/candidate.js";
import {
  DifficultySchema,
  FamilySchema,
  LaneSchema,
  ModalitySchema,
  SLOT_ID_PATTERN,
  Sha256Schema,
  UsdSchema,
  type Difficulty,
  type Family,
  type Lane,
  type Modality,
  type SvgFamily,
} from "../domain/experiment.js";
import { SolverLimitError } from "../families/canonicalize.js";
import { SolveResultSchema, type SolveResult } from "../families/contracts.js";
import { productionRegistry, type AnyFamilyEngine } from "../families/registry.js";
import { fingerprintContentFor } from "../presentation/assemble.js";
import {
  assertFingerprintConsistency,
  computeContentHash,
  fingerprintCandidate,
} from "../validation/fingerprints.js";
import { failureClass } from "../validation/verdict.js";
import {
  assertPngNoTextMetadata,
  hashPng,
  renderScenePng,
} from "../render/png.js";
import { SCENE_SIZE, type Scene } from "../render/scene.js";
import { serializeScene } from "../render/svg.js";
import { getRun, getSlot, getStageResult, insertStageResult } from "../storage/repository.js";
import type { ArtifactInput } from "../storage/artifacts.js";
import { deriveStreamSeed } from "../util/random.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const PREPARATION_READY_STATUS = "ready_for_duplicate_barrier" as const;
export const PREPARATION_FAILURE_STATUS = "early_failure" as const;

export type PreparationErrorCode =
  | "INVALID_INPUT"
  | "RUN_KIND_UNSUPPORTED"
  | "SLOT_MISMATCH"
  | "INVALID_STAGE"
  | "EVIDENCE_KIND_MISMATCH"
  | "MOCK_SCENARIO_IN_LIVE_MODE"
  | "UNEXPECTED_ROLE";

export class PreparationError extends Error {
  readonly code: PreparationErrorCode;

  constructor(
    code: PreparationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreparationError";
    this.code = code;
  }
}

export const PREPARATION_MOCK_SCENARIO_KINDS = [
  "valid",
  "schema_invalid",
  "refusal",
  "http_error",
  "timeout",
] as const;
export type PreparationMockScenarioKind =
  (typeof PREPARATION_MOCK_SCENARIO_KINDS)[number];
export const PreparationMockScenarioKindSchema = z.enum(
  PREPARATION_MOCK_SCENARIO_KINDS,
);

export const PreparationCostSchema = z
  .strictObject({
    actualCostUsd: UsdSchema.nullable(),
    costStatus: z.enum(["known", "unknown", "not_applicable"]),
  })
  .superRefine((cost, ctx) => {
    if ((cost.costStatus === "known") !== (cost.actualCostUsd !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["actualCostUsd"],
        message: "known preparation cost requires an amount and other statuses omit it",
      });
    }
  });
export type PreparationCost = z.infer<typeof PreparationCostSchema>;

export const LogicalCallEvidenceSchema = z
  .strictObject({
    role: z.enum(["spec", "wording"]),
    logicalCallId: z.uuid(),
    state: RequestStateSchema,
    attemptIds: z.array(z.uuid()),
    rawResponseArtifactIds: z.array(z.number().int().positive()),
    actualCostUsd: UsdSchema.nullable(),
    costStatus: z.enum(["known", "unknown", "not_applicable"]),
  })
  .superRefine((call, ctx) => {
    if ((call.costStatus === "known") !== (call.actualCostUsd !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["actualCostUsd"],
        message: "known call cost requires an amount and other statuses omit it",
      });
    }
    if (call.rawResponseArtifactIds.length > call.attemptIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rawResponseArtifactIds"],
        message: "raw response artifacts cannot outnumber attempts",
      });
    }
  });
export type LogicalCallEvidence = z.infer<typeof LogicalCallEvidenceSchema>;

export const SpecFirstStagePayloadSchema = z.strictObject({
  version: z.literal(1),
  lane: z.literal("spec_first"),
  family: FamilySchema,
  modality: ModalitySchema,
  difficulty: DifficultySchema,
  spec: z.unknown(),
  seed: Sha256Schema,
  construction: z.strictObject({
    method: z.literal("engine.generateSpec"),
    seed: Sha256Schema,
    deterministic: z.literal(true),
  }),
});
export type SpecFirstStagePayload = z.infer<typeof SpecFirstStagePayloadSchema>;

export const FormalStagePayloadSchema = z
  .strictObject({
    version: z.literal(1),
    family: FamilySchema,
    modality: ModalitySchema,
    difficulty: DifficultySchema,
    lane: LaneSchema,
    spec: z.unknown(),
    solveResult: SolveResultSchema,
    choices: ChoiceSetSchema,
    seeds: z.strictObject({
      spec: Sha256Schema,
      options: Sha256Schema,
      layout: Sha256Schema,
    }),
    fingerprint: CandidateFingerprintSchema,
    render: z.strictObject({
      rendererVersion: z.string().min(1).max(64).nullable(),
      svgHash: Sha256Schema.nullable(),
      pngHash: Sha256Schema.nullable(),
      previewPngHash: Sha256Schema.nullable(),
    }),
    checks: z.strictObject({
      uniqueness: z.literal("pass"),
      options: z.literal("pass"),
      render: z.enum(["pass", "not_applicable"]),
    }),
  })
  .superRefine((stage, ctx) => {
    if (stage.fingerprint.contentHash !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint", "contentHash"],
        message: "formal checkpoints precede wording and cannot carry a content hash",
      });
    }
    if (
      stage.fingerprint.family !== stage.family ||
      stage.fingerprint.modality !== stage.modality
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "formal fingerprint family/modality must match the stage",
      });
    }
    if (stage.modality === "text") {
      if (
        stage.render.svgHash !== null ||
        stage.render.pngHash !== null ||
        stage.render.previewPngHash !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["render"],
          message: "text stages cannot carry render hashes",
        });
      }
      if (stage.checks.render !== "not_applicable") {
        ctx.addIssue({
          code: "custom",
          path: ["checks", "render"],
          message: "text stages must mark rendering as not applicable",
        });
      }
      return;
    }
    if (
      stage.render.svgHash === null ||
      stage.render.pngHash === null ||
      stage.render.previewPngHash === null ||
      stage.render.rendererVersion === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["render"],
        message: "SVG stages require full/preview render hashes and a renderer version",
      });
    }
    if (
      stage.fingerprint.renderHashes.svg !== stage.render.svgHash ||
      stage.fingerprint.renderHashes.png !== stage.render.pngHash
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint", "renderHashes"],
        message: "fingerprint render hashes must match the persisted render hashes",
      });
    }
    if (stage.checks.render !== "pass") {
      ctx.addIssue({
        code: "custom",
        path: ["checks", "render"],
        message: "SVG stages must mark rendering as passed",
      });
    }
  });
export type FormalStagePayload = z.infer<typeof FormalStagePayloadSchema>;

export const PreparationFailureStagePayloadSchema = z
  .strictObject({
    version: z.literal(1),
    status: z.literal("early_failure"),
    family: FamilySchema,
    modality: ModalitySchema,
    difficulty: DifficultySchema,
    lane: LaneSchema,
    failureStage: z.enum(["spec_ready", "formal_checked", "presentation_ready"]),
    failures: z.array(FailureRecordSchema).min(1),
    terminalVerdict: z.enum(["rejected", "inconclusive", "generation_error"]),
    fingerprint: CandidateFingerprintSchema.nullable(),
    stages: z.array(WorkflowStageSchema),
    logicalCalls: z.array(LogicalCallEvidenceSchema),
    cost: PreparationCostSchema,
  })
  .superRefine((payload, ctx) => {
    if (payload.stages.at(-1) !== "terminal") {
      ctx.addIssue({
        code: "custom",
        path: ["stages"],
        message: "an early failure checkpoint must end at terminal",
      });
    }
    if (payload.fingerprint !== null && payload.fingerprint.contentHash !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint", "contentHash"],
        message: "an early failure cannot carry a completed content hash",
      });
    }
    const expectedCost = aggregateCost(payload.logicalCalls);
    if (canonicalJson(expectedCost) !== canonicalJson(payload.cost)) {
      ctx.addIssue({
        code: "custom",
        path: ["cost"],
        message: "failure cost must match the logical call evidence",
      });
    }
  });
export type PreparationFailureStagePayload = z.infer<
  typeof PreparationFailureStagePayloadSchema
>;

export const PreparationResultSchema = z
  .strictObject({
    version: z.literal(1),
    runId: z.uuid(),
    slotId: z.string().regex(SLOT_ID_PATTERN),
    slotOrdinal: z.number().int().min(1).max(200),
    family: FamilySchema,
    modality: ModalitySchema,
    lane: LaneSchema,
    difficulty: DifficultySchema,
    status: z.enum([PREPARATION_READY_STATUS, PREPARATION_FAILURE_STATUS]),
    terminalVerdict: z
      .enum(["rejected", "inconclusive", "generation_error"])
      .nullable(),
    stages: z.array(WorkflowStageSchema),
    failures: z.array(FailureRecordSchema),
    fingerprint: CandidateFingerprintSchema.nullable(),
    candidate: CandidateBarrierInputSchema,
    logicalCalls: z.array(LogicalCallEvidenceSchema),
    cost: PreparationCostSchema,
  })
  .superRefine((result, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (
      result.candidate.slotId !== result.slotId ||
      result.candidate.slotOrdinal !== result.slotOrdinal ||
      result.candidate.family !== result.family ||
      result.candidate.modality !== result.modality ||
      result.candidate.lane !== result.lane
    ) {
      issue(["candidate"], "candidate identity must match the preparation result");
    }
    if (canonicalJson(result.candidate.fingerprint) !== canonicalJson(result.fingerprint)) {
      issue(["fingerprint"], "result fingerprint must match the candidate fingerprint");
    }
    const expectedCost = aggregateCost(result.logicalCalls);
    if (canonicalJson(expectedCost) !== canonicalJson(result.cost)) {
      issue(["cost"], "result cost must match the logical call evidence");
    }
    if (result.status === PREPARATION_READY_STATUS) {
      if (result.terminalVerdict !== null) {
        issue(["terminalVerdict"], "a ready preparation cannot carry a verdict");
      }
      if (result.failures.length > 0) {
        issue(["failures"], "a ready preparation cannot carry failures");
      }
      if (result.fingerprint === null) {
        issue(["fingerprint"], "a ready preparation requires a fingerprint");
      }
      if (result.candidate.preparationStatus !== "ready") {
        issue(["candidate", "preparationStatus"], "a ready result requires a ready candidate");
      }
      const expectedStages = [
        "spec_ready",
        "formal_checked",
        "presentation_ready",
      ] as const;
      if (
        result.stages.length !== expectedStages.length ||
        result.stages.some((stage, index) => stage !== expectedStages[index])
      ) {
        issue(["stages"], "a ready preparation must commit all three preparation stages");
      }
      return;
    }
    if (result.terminalVerdict === null) {
      issue(["terminalVerdict"], "an early failure requires a terminal verdict");
    }
    if (result.failures.length === 0) {
      issue(["failures"], "an early failure requires at least one failure record");
    }
    if (result.candidate.preparationStatus !== "early_failure") {
      issue(
        ["candidate", "preparationStatus"],
        "an early failure result requires an early_failure candidate",
      );
    }
    if (result.candidate.terminalVerdict !== result.terminalVerdict) {
      issue(["candidate", "terminalVerdict"], "candidate verdict must match the result");
    }
    if (result.stages.at(-1) !== "terminal") {
      issue(["stages"], "an early failure must end at terminal");
    }
    const preparedStages = result.stages.slice(0, -1);
    const expectedPrefix = (
      ["spec_ready", "formal_checked", "presentation_ready"] as const
    ).slice(0, preparedStages.length);
    if (preparedStages.some((stage, index) => stage !== expectedPrefix[index])) {
      issue(["stages"], "committed preparation stages must be a workflow prefix");
    }
    if (preparedStages.includes("presentation_ready")) {
      issue(["stages"], "an early failure cannot include presentation_ready");
    }
  });
export type PreparationResult = z.infer<typeof PreparationResultSchema>;

export interface PreparationRoutes {
  readonly spec?: ResolvedRoute;
  readonly wording: ResolvedRoute;
}

export interface PrepareSlotInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport> & {
    readonly isMock?: true;
  };
  readonly routes: PreparationRoutes;
  readonly reservations: {
    readonly spec: string;
    readonly wording: string;
  };
  readonly mockScenarioKinds?: Partial<
    Record<"spec" | "wording", PreparationMockScenarioKind>
  >;
  readonly clock?: { now(): Date };
  readonly yieldBetweenJobs?: () => Promise<void>;
}

interface PreparationSeeds {
  readonly spec: string;
  readonly options: string;
  readonly layout: string;
}

interface FormalCheckResult {
  readonly spec: unknown;
  readonly solveResult: SolveResult<unknown>;
  readonly choices: ChoiceSet<unknown>;
  readonly fingerprint: CandidateFingerprint;
  readonly render: FormalStagePayload["render"];
  readonly artifacts: readonly ArtifactInput[];
}

class CandidatePreparationFailure extends Error {
  readonly failure: FailureRecord;

  constructor(failure: FailureRecord, options?: ErrorOptions) {
    super(failure.evidence ?? failure.code, options);
    this.name = "CandidatePreparationFailure";
    this.failure = failure;
  }
}

function nowIso(clock: { now(): Date }): string {
  return clock.now().toISOString();
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function boundEvidence(value: string, apiKey: string): string {
  const redacted = value.split(apiKey).join("[REDACTED]");
  return redacted.length <= 2000 ? redacted : `${redacted.slice(0, 1997)}...`;
}

function failure(
  code: FailureRecord["code"],
  stage: FailureRecord["stage"],
  source: FailureRecord["source"],
  severity: FailureRecord["severity"],
  evidence: string,
): never {
  throw new CandidatePreparationFailure({
    code,
    stage,
    source,
    severity,
    evidence,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aggregateCost(calls: readonly LogicalCallEvidence[]): PreparationCost {
  if (calls.some((call) => call.costStatus === "unknown")) {
    return { actualCostUsd: null, costStatus: "unknown" };
  }
  const known = calls.filter(
    (call): call is LogicalCallEvidence & { actualCostUsd: string } =>
      call.costStatus === "known" && call.actualCostUsd !== null,
  );
  if (known.length === 0) {
    return { actualCostUsd: null, costStatus: "not_applicable" };
  }
  return {
    actualCostUsd: addUsd(...known.map((call) => call.actualCostUsd)),
    costStatus: "known",
  };
}

function collectLogicalCallEvidence(
  db: Database.Database,
  runId: string,
  slotId: string,
): LogicalCallEvidence[] {
  const rows = db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? AND slot_id = ? ORDER BY role, created_at, logical_call_id",
    )
    .all(runId, slotId) as Array<{ logical_call_id: string }>;
  return rows.map((row) => {
    const call = getLogicalCall(db, row.logical_call_id);
    if (call.role !== "spec" && call.role !== "wording") {
      throw new PreparationError(
        "UNEXPECTED_ROLE",
        `slot preparation made an unexpected ${call.role} call`,
      );
    }
    const attempts = listAttempts(db, call.logicalCallId);
    const unknown = attempts.some((attempt) => attempt.costStatus === "unknown");
    const knownCosts = attempts.flatMap((attempt) =>
      attempt.costStatus === "known" && attempt.actualCostUsd !== null
        ? [attempt.actualCostUsd]
        : [],
    );
    const costStatus = unknown
      ? "unknown"
      : knownCosts.length === 0
        ? "not_applicable"
        : "known";
    return LogicalCallEvidenceSchema.parse({
      role: call.role,
      logicalCallId: call.logicalCallId,
      state: call.state,
      attemptIds: attempts.map((attempt) => attempt.attemptId),
      rawResponseArtifactIds: attempts.flatMap((attempt) =>
        attempt.rawResponseArtifactId === null
          ? []
          : [attempt.rawResponseArtifactId],
      ),
      actualCostUsd: costStatus === "known" ? addUsd(...knownCosts) : null,
      costStatus,
    });
  });
}

function terminalVerdictFor(failureRecord: FailureRecord): Exclude<CandidateVerdict, "approved"> {
  const failureType = failureClass(failureRecord);
  if (failureType === "generation_error") {
    return "generation_error";
  }
  if (failureType === "rejected") {
    return "rejected";
  }
  return "inconclusive";
}

function validateRoutes(
  routes: PreparationRoutes,
  lane: Lane,
): { readonly spec: ResolvedRoute | null; readonly wording: ResolvedRoute } {
  if (routes.wording.role !== "wording") {
    throw new PreparationError(
      "INVALID_INPUT",
      `wording route must have role wording, received ${routes.wording.role}`,
    );
  }
  if (routes.wording.requiresImage) {
    throw new PreparationError(
      "INVALID_INPUT",
      "wording route must not require an image",
    );
  }
  if (lane === "spec_first") {
    return { spec: null, wording: routes.wording };
  }
  const spec = routes.spec;
  if (spec === undefined) {
    throw new PreparationError(
      "INVALID_INPUT",
      "ai_spec preparation requires a spec route",
    );
  }
  if (spec.role !== "spec") {
    throw new PreparationError(
      "INVALID_INPUT",
      `spec route must have role spec, received ${spec.role}`,
    );
  }
  if (spec.requiresImage) {
    throw new PreparationError(
      "INVALID_INPUT",
      "spec route must not require an image",
    );
  }
  return { spec, wording: routes.wording };
}

function instrumentMockTransport(
  transport: MockTransport,
  db: Database.Database,
  slot: {
    readonly family: Family;
    readonly difficulty: Difficulty;
  },
  seeds: PreparationSeeds,
  scenarioKinds: Partial<Record<"spec" | "wording", PreparationMockScenarioKind>>,
): ReturnType<typeof createOpenRouterTransport> {
  return {
    executeCall: async (input) => {
      const call = getLogicalCall(db, input.logicalCallId);
      if (call.role !== "spec" && call.role !== "wording") {
        throw new PreparationError(
          "UNEXPECTED_ROLE",
          `mock preparation refused to register a scenario for ${call.role}`,
        );
      }
      const kind = scenarioKinds[call.role] ?? "valid";
      transport.registerScenario(
        input.logicalCallId,
        mockScenarioForFamily(
          call.role,
          slot.family,
          slot.difficulty,
          seeds.spec,
          kind as MockScenarioKind,
        ),
      );
      return transport.executeCall({ ...input, nonBilling: true });
    },
    reconcileGeneration: transport.reconcileGeneration,
  };
}

function commitStage(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly stage: WorkflowStage;
  readonly startedAt: string;
  readonly clock: { now(): Date };
  readonly payload: unknown;
  readonly artifacts?: readonly ArtifactInput[];
  readonly verdict?: CandidateVerdict;
}): void {
  const finishedAt = nowIso(input.clock);
  insertStageResult(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    stage: input.stage,
    startedAt: input.startedAt,
    finishedAt,
    elapsedMs: elapsedMs(input.startedAt, finishedAt),
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    createdAt: finishedAt,
    payload: input.payload,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  });
}

function generateSpecFirst(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly family: Family;
  readonly modality: Modality;
  readonly difficulty: Difficulty;
  readonly engine: AnyFamilyEngine;
  readonly seeds: PreparationSeeds;
  readonly startedAt: string;
  readonly clock: { now(): Date };
  readonly apiKey: string;
}): unknown {
  let generated: unknown;
  try {
    generated = input.engine.generateSpec(input.seeds.spec, input.difficulty);
  } catch (error) {
    const code =
      error instanceof SolverLimitError ? "SOLVER_LIMIT" : "SCHEMA_INVALID";
    failure(
      code,
      "spec_ready",
      "deterministic",
      code === "SOLVER_LIMIT" ? "medium" : "high",
      boundEvidence(
        `spec_first construction failed: ${errorMessage(error)}`,
        input.apiKey,
      ),
    );
  }
  const parsed = input.engine.schema.safeParse(generated);
  if (!parsed.success) {
    failure(
      "SCHEMA_INVALID",
      "spec_ready",
      "deterministic",
      "high",
      boundEvidence(
        `generated spec does not satisfy the ${input.family} schema: ${parsed.error.message}`,
        input.apiKey,
      ),
    );
  }
  const payload = SpecFirstStagePayloadSchema.parse({
    version: 1,
    lane: "spec_first",
    family: input.family,
    modality: input.modality,
    difficulty: input.difficulty,
    spec: parsed.data,
    seed: input.seeds.spec,
    construction: {
      method: "engine.generateSpec",
      seed: input.seeds.spec,
      deterministic: true,
    },
  });
  commitStage({
    db: input.db,
    runId: input.runId,
    slotId: input.slotId,
    stage: "spec_ready",
    startedAt: input.startedAt,
    clock: input.clock,
    payload,
  });
  return parsed.data;
}

async function acquireAiSpec(input: {
  readonly db: Database.Database;
  readonly runId: string;
  readonly slotId: string;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly route: ResolvedRoute;
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly reservationUsd: string;
  readonly clock: { now(): Date };
}): Promise<unknown> {
  try {
    const result = await proposeSpec({
      db: input.db,
      accountId: input.accountId,
      apiKey: input.apiKey,
      transport: input.transport,
      runId: input.runId,
      slotId: input.slotId,
      family: input.family,
      difficulty: input.difficulty,
      route: input.route,
      reservationUsd: input.reservationUsd,
      clock: input.clock,
    });
    return result.spec;
  } catch (error) {
    if (!(error instanceof SpecProposalError)) {
      throw error;
    }
    const evidence = boundEvidence(
      `${error.code}: ${error.message}${
        error.issues.length === 0 ? "" : ` (${error.issues.join("; ")})`
      }`,
      input.apiKey,
    );
    switch (error.code) {
      case "TRANSPORT_FAILED":
        return failure("API_ERROR", "spec_ready", "infrastructure", "high", evidence);
      case "UNSAT":
        return failure("UNSAT", "spec_ready", "deterministic", "high", evidence);
      case "MULTIPLE_SOLUTIONS":
        return failure(
          "MULTIPLE_SOLUTIONS",
          "spec_ready",
          "deterministic",
          "high",
          evidence,
        );
      case "SOLVER_LIMIT":
        return failure("SOLVER_LIMIT", "spec_ready", "deterministic", "medium", evidence);
      case "MISSING_CONTENT":
      case "FORBIDDEN_FIELD":
      case "SCHEMA_INVALID":
      case "WRONG_FAMILY":
      case "DIFFICULTY_OUT_OF_BOUNDS":
      case "FORMAL_CHECK_FAILED":
        return failure("SCHEMA_INVALID", "spec_ready", "model", "high", evidence);
      default:
        throw error;
    }
  }
}

function solveAndRender(input: {
  readonly family: Family;
  readonly modality: Modality;
  readonly lane: Lane;
  readonly difficulty: Difficulty;
  readonly engine: AnyFamilyEngine;
  readonly spec: unknown;
  readonly seeds: PreparationSeeds;
  readonly apiKey: string;
}): FormalCheckResult {
  const parsedSpec = input.engine.schema.safeParse(input.spec);
  if (!parsedSpec.success) {
    failure(
      "SCHEMA_INVALID",
      "formal_checked",
      "deterministic",
      "high",
      boundEvidence(
        `spec does not satisfy the ${input.family} schema: ${parsedSpec.error.message}`,
        input.apiKey,
      ),
    );
  }
  const spec = parsedSpec.data;
  let solveResult: SolveResult<unknown>;
  try {
    solveResult = input.engine.enumerateSolutions(spec);
  } catch (error) {
    const code =
      error instanceof SolverLimitError ? "SOLVER_LIMIT" : "SCHEMA_INVALID";
    failure(
      code,
      "formal_checked",
      "deterministic",
      code === "SOLVER_LIMIT" ? "medium" : "high",
      boundEvidence(
        `independent solving failed: ${errorMessage(error)}`,
        input.apiKey,
      ),
    );
  }
  const parsedSolve = SolveResultSchema.safeParse(solveResult);
  if (!parsedSolve.success) {
    failure(
      "SCHEMA_INVALID",
      "formal_checked",
      "deterministic",
      "high",
      boundEvidence(
        `solver result does not satisfy the contract: ${parsedSolve.error.message}`,
        input.apiKey,
      ),
    );
  }
  if (solveResult.solutionCount === 0) {
    failure(
      "UNSAT",
      "formal_checked",
      "deterministic",
      "high",
      "independent solving found no solution",
    );
  }
  if (solveResult.solutionCount > 1) {
    failure(
      "MULTIPLE_SOLUTIONS",
      "formal_checked",
      "deterministic",
      "high",
      `independent solving found ${solveResult.solutionCount} solutions`,
    );
  }
  if (solveResult.answerCount !== 1 || solveResult.correctAnswer === null) {
    failure(
      "MULTIPLE_ANSWERS",
      "formal_checked",
      "deterministic",
      "high",
      `unique solution requires exactly one answer, received ${solveResult.answerCount}`,
    );
  }
  if (solveResult.proof === null) {
    failure(
      "MULTIPLE_ANSWERS",
      "formal_checked",
      "deterministic",
      "high",
      "unique solution is missing its proof",
    );
  }

  let choices: ChoiceSet<unknown>;
  try {
    choices = input.engine.makeOptions(
      spec,
      solveResult.correctAnswer,
      input.seeds.options,
    );
  } catch (error) {
    const code =
      error instanceof Error && error.name === "AnswerContractError"
        ? (error as Error & { code?: string }).code === "DUPLICATE_OPTION"
          ? "DUPLICATE_OPTION"
          : "MULTIPLE_ANSWERS"
        : "MULTIPLE_ANSWERS";
    failure(
      code,
      "formal_checked",
      "deterministic",
      "high",
      boundEvidence(
        `option construction failed: ${errorMessage(error)}`,
        input.apiKey,
      ),
    );
  }
  try {
    verifyChoiceSet(choices);
  } catch (error) {
    failure(
      "MULTIPLE_ANSWERS",
      "formal_checked",
      "deterministic",
      "high",
      boundEvidence(
        `option contract failed: ${errorMessage(error)}`,
        input.apiKey,
      ),
    );
  }
  const correctChoices = choices.choices.filter((choice) =>
    input.engine.verifyAnswer(spec, choice.value),
  );
  if (correctChoices.length !== 1) {
    failure(
      "MULTIPLE_ANSWERS",
      "formal_checked",
      "deterministic",
      "high",
      `expected exactly one correct option, received ${correctChoices.length}`,
    );
  }
  const selected = choices.choices.find(
    (choice) => choice.label === choices.correctLabel,
  );
  if (
    selected === undefined ||
    !deepEqual(selected.value, solveResult.correctAnswer) ||
    !deepEqual(correctChoices[0]?.value, solveResult.correctAnswer)
  ) {
    failure(
      "MULTIPLE_ANSWERS",
      "formal_checked",
      "deterministic",
      "high",
      "correct option label does not identify the solved answer",
    );
  }

  let svgHash: string | null = null;
  let pngHash: string | null = null;
  let previewPngHash: string | null = null;
  let rendererVersion: string | null = null;
  const artifacts: ArtifactInput[] = [];
  if (input.modality === "svg") {
    try {
      const renderer = productionRegistry.getRenderer(input.family as SvgFamily);
      const scene = renderer.buildScene(spec, input.seeds.options) as Scene;
      renderer.assertScene(scene, spec, choices);
      const svg = serializeScene(scene);
      const png = renderScenePng(scene, SCENE_SIZE);
      const previewPng = renderScenePng(scene, 512);
      assertPngNoTextMetadata(png);
      assertPngNoTextMetadata(previewPng);
      svgHash = sha256Hex(svg);
      pngHash = hashPng(png);
      previewPngHash = hashPng(previewPng);
      rendererVersion = renderer.version;
      artifacts.push(
        {
          kind: "svg",
          mediaType: "image/svg+xml",
          bytes: Buffer.from(svg, "utf8"),
          role: "source_svg",
        },
        {
          kind: "png",
          mediaType: "image/png",
          bytes: png,
          role: "full_png",
        },
        {
          kind: "png",
          mediaType: "image/png",
          bytes: previewPng,
          role: "preview_png",
        },
      );
    } catch (error) {
      failure(
        "SVG_RENDER_INVALID",
        "formal_checked",
        "deterministic",
        "high",
        boundEvidence(
          `SVG rendering or validation failed: ${errorMessage(error)}`,
          input.apiKey,
        ),
      );
    }
  }

  let fingerprint: CandidateFingerprint;
  try {
    fingerprint = fingerprintCandidate({
      engine: input.engine,
      spec,
      renderHashes: { svg: svgHash, png: pngHash },
    });
    assertFingerprintConsistency(fingerprint);
  } catch (error) {
    failure(
      "SCHEMA_INVALID",
      "formal_checked",
      "deterministic",
      "high",
      boundEvidence(
        `deterministic fingerprint failed: ${errorMessage(error)}`,
        input.apiKey,
      ),
    );
  }

  return {
    spec,
    solveResult,
    choices,
    fingerprint,
    render: {
      rendererVersion,
      svgHash,
      pngHash,
      previewPngHash,
    },
    artifacts,
  };
}

async function writePresentation(input: {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly runId: string;
  readonly slotId: string;
  readonly route: ResolvedRoute;
  readonly spec: unknown;
  readonly solveResult: unknown;
  readonly choices: unknown;
  readonly assets: { readonly svgHash: string | null; readonly pngHash: string | null };
  readonly reservationUsd: string;
  readonly clock: { now(): Date };
}): Promise<Awaited<ReturnType<typeof writeWording>>> {
  try {
    return await writeWording({
      db: input.db,
      accountId: input.accountId,
      apiKey: input.apiKey,
      transport: input.transport,
      runId: input.runId,
      slotId: input.slotId,
      route: input.route,
      spec: input.spec,
      solveResult: input.solveResult,
      choices: input.choices,
      assets: input.assets,
      reservationUsd: input.reservationUsd,
      clock: input.clock,
    });
  } catch (error) {
    if (!(error instanceof WordingError)) {
      throw error;
    }
    const evidence = boundEvidence(
      `${error.code}: ${error.message}${
        error.presentationCode === null ? "" : ` [${error.presentationCode}]`
      }${error.issues.length === 0 ? "" : ` (${error.issues.join("; ")})`}`,
      input.apiKey,
    );
    switch (error.code) {
      case "TRANSPORT_FAILED":
        return failure("API_ERROR", "presentation_ready", "infrastructure", "high", evidence);
      case "MISSING_CONTENT":
      case "INVALID_WORDING":
        return failure("SCHEMA_INVALID", "presentation_ready", "model", "high", evidence);
      case "MECHANICAL_CHECK_FAILED":
        switch (error.presentationCode) {
          case "UNKNOWN_FACT_REFERENCE":
            return failure(
              "EXPLANATION_MISMATCH",
              "presentation_ready",
              "deterministic",
              "high",
              evidence,
            );
          case "DUPLICATE_OPTION_TEXT":
            return failure(
              "DUPLICATE_OPTION",
              "presentation_ready",
              "deterministic",
              "high",
              evidence,
            );
          case "FACT_COVERAGE_MISMATCH":
          case "UNEXPECTED_CLUE_TEXTS":
          case "INVALID_OPTION_SET":
          case "INVALID_OPTION_VALUE":
          case "MISSING_IMAGE_ASSET":
          case "UNEXPECTED_IMAGE_ASSET":
          case "PUBLIC_REVEAL_LEAK":
            return failure(
              "TEXT_SPEC_MISMATCH",
              "presentation_ready",
              "deterministic",
              "high",
              evidence,
            );
          default:
            return failure(
              "SCHEMA_INVALID",
              "presentation_ready",
              "model",
              "high",
              evidence,
            );
        }
      default:
        throw error;
    }
  }
}

export async function prepareSlot(input: PrepareSlotInput): Promise<PreparationResult> {
  const run = getRun(input.db, input.runId);
  if (run.runKind !== "full" && run.runKind !== "smoke") {
    throw new PreparationError(
      "RUN_KIND_UNSUPPORTED",
      `slot preparation supports full and smoke runs, received ${run.runKind}`,
    );
  }
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (slot.stage !== "planned") {
    throw new PreparationError(
      "INVALID_STAGE",
      `slot ${slot.slotId} is already at ${slot.stage}; preparation requires planned`,
    );
  }
  const engine = productionRegistry.getEngine(slot.family);
  if (engine.modality !== slot.modality) {
    throw new PreparationError(
      "SLOT_MISMATCH",
      `slot ${slot.slotId} modality ${slot.modality} does not match engine ${engine.modality}`,
    );
  }
  const isMock = input.transport.isMock === true;
  if (run.evidenceKind === "mock" && !isMock) {
    throw new PreparationError(
      "EVIDENCE_KIND_MISMATCH",
      "mock runs require the deterministic mock transport",
    );
  }
  if (run.evidenceKind === "live" && isMock) {
    throw new PreparationError(
      "EVIDENCE_KIND_MISMATCH",
      "live runs cannot use the deterministic mock transport",
    );
  }
  if (!isMock && input.mockScenarioKinds !== undefined) {
    throw new PreparationError(
      "MOCK_SCENARIO_IN_LIVE_MODE",
      "mock scenario kinds are only valid with the mock transport",
    );
  }
  if (input.apiKey.trim() === "") {
    throw new PreparationError("INVALID_INPUT", "an API key is required");
  }
  const routes = validateRoutes(input.routes, slot.lane);
  const clock = input.clock ?? { now: () => new Date() };
  const seeds: PreparationSeeds = {
    spec: deriveStreamSeed({
      protocolVersion: run.protocolVersion,
      rootSeed: run.rootSeed,
      slotId: slot.slotId,
      purpose: "spec",
    }),
    options: deriveStreamSeed({
      protocolVersion: run.protocolVersion,
      rootSeed: run.rootSeed,
      slotId: slot.slotId,
      purpose: "options",
    }),
    layout: deriveStreamSeed({
      protocolVersion: run.protocolVersion,
      rootSeed: run.rootSeed,
      slotId: slot.slotId,
      purpose: "layout",
    }),
  };
  const transport = isMock
    ? instrumentMockTransport(
        input.transport as MockTransport,
        input.db,
        slot,
        seeds,
        input.mockScenarioKinds ?? {},
      )
    : input.transport;

  const committedStages: WorkflowStage[] = [];
  let formalPassed = false;
  let fingerprint: CandidateFingerprint | null = null;
  let activeStageStartedAt = nowIso(clock);

  try {
    let spec: unknown;
    activeStageStartedAt = nowIso(clock);
    if (slot.lane === "spec_first") {
      spec = generateSpecFirst({
        db: input.db,
        runId: input.runId,
        slotId: input.slotId,
        family: slot.family,
        modality: slot.modality,
        difficulty: slot.difficulty,
        engine,
        seeds,
        startedAt: activeStageStartedAt,
        clock,
        apiKey: input.apiKey,
      });
      committedStages.push("spec_ready");
    } else {
      if (routes.spec === null) {
        throw new PreparationError("INVALID_INPUT", "ai_spec requires a spec route");
      }
      spec = await acquireAiSpec({
        db: input.db,
        runId: input.runId,
        slotId: input.slotId,
        accountId: input.accountId,
        apiKey: input.apiKey,
        transport,
        route: routes.spec,
        family: slot.family,
        difficulty: slot.difficulty,
        reservationUsd: input.reservations.spec,
        clock,
      });
      committedStages.push("spec_ready");
    }
    if (getSlot(input.db, input.runId, input.slotId).stage !== "spec_ready") {
      throw new PreparationError(
        "INVALID_STAGE",
        "spec acquisition did not commit the spec_ready checkpoint",
      );
    }
    await input.yieldBetweenJobs?.();

    activeStageStartedAt = nowIso(clock);
    const formal = solveAndRender({
      family: slot.family,
      modality: slot.modality,
      lane: slot.lane,
      difficulty: slot.difficulty,
      engine,
      spec,
      seeds,
      apiKey: input.apiKey,
    });
    commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      stage: "formal_checked",
      startedAt: activeStageStartedAt,
      clock,
      payload: FormalStagePayloadSchema.parse({
        version: 1,
        family: slot.family,
        modality: slot.modality,
        difficulty: slot.difficulty,
        lane: slot.lane,
        spec: formal.spec,
        solveResult: formal.solveResult,
        choices: formal.choices,
        seeds,
        fingerprint: formal.fingerprint,
        render: formal.render,
        checks: {
          uniqueness: "pass",
          options: "pass",
          render: slot.modality === "svg" ? "pass" : "not_applicable",
        },
      }),
      artifacts: formal.artifacts,
    });
    committedStages.push("formal_checked");
    formalPassed = true;
    fingerprint = formal.fingerprint;
    await input.yieldBetweenJobs?.();

    activeStageStartedAt = nowIso(clock);
    const wordingResult = await writePresentation({
      db: input.db,
      accountId: input.accountId,
      apiKey: input.apiKey,
      transport,
      runId: input.runId,
      slotId: input.slotId,
      route: routes.wording,
      spec: formal.spec,
      solveResult: formal.solveResult,
      choices: formal.choices,
      assets: {
        svgHash: formal.render.svgHash,
        pngHash: formal.render.pngHash,
      },
      reservationUsd: input.reservations.wording,
      clock,
    });
    committedStages.push("presentation_ready");
    if (
      getSlot(input.db, input.runId, input.slotId).stage !==
      "presentation_ready"
    ) {
      throw new PreparationError(
        "INVALID_STAGE",
        "wording did not commit the presentation_ready checkpoint",
      );
    }
    const presentationStage = getStageResult(
      input.db,
      input.runId,
      input.slotId,
      "presentation_ready",
    );
    const persistedPresentation = (
      presentationStage.payload as { presentation?: unknown }
    ).presentation;
    if (persistedPresentation === undefined) {
      throw new PreparationError(
        "INVALID_STAGE",
        "persisted presentation checkpoint is missing its presentation",
      );
    }
    const finalFingerprint = assertFingerprintConsistency({
      ...formal.fingerprint,
      contentHash: computeContentHash(
        fingerprintContentFor(wordingResult.presentation),
      ),
    });
    if (
      canonicalJson(persistedPresentation) !==
      canonicalJson(wordingResult.presentation)
    ) {
      throw new PreparationError(
        "INVALID_STAGE",
        "persisted presentation does not match the wording adapter result",
      );
    }
    const logicalCalls = collectLogicalCallEvidence(
      input.db,
      input.runId,
      input.slotId,
    );
    const cost = aggregateCost(logicalCalls);
    const candidate = CandidateBarrierInputSchema.parse({
      slotId: slot.slotId,
      slotOrdinal: slot.slotOrdinal,
      family: slot.family,
      modality: slot.modality,
      lane: slot.lane,
      preparationStatus: "ready",
      presentationCheckPassed: true,
      formalPassed: true,
      terminalVerdict: null,
      fingerprint: finalFingerprint,
    });
    return PreparationResultSchema.parse({
      version: 1,
      runId: input.runId,
      slotId: slot.slotId,
      slotOrdinal: slot.slotOrdinal,
      family: slot.family,
      modality: slot.modality,
      lane: slot.lane,
      difficulty: slot.difficulty,
      status: PREPARATION_READY_STATUS,
      terminalVerdict: null,
      stages: committedStages,
      failures: [],
      fingerprint: finalFingerprint,
      candidate,
      logicalCalls,
      cost,
    });
  } catch (error) {
    if (!(error instanceof CandidatePreparationFailure)) {
      throw error;
    }
    const logicalCalls = collectLogicalCallEvidence(
      input.db,
      input.runId,
      input.slotId,
    );
    const cost = aggregateCost(logicalCalls);
    const failures: FailureRecord[] = [error.failure];
    if (
      cost.costStatus === "unknown" &&
      !failures.some((record) => record.code === "COST_UNKNOWN")
    ) {
      failures.push({
        code: "COST_UNKNOWN",
        stage: "terminal",
        severity: "medium",
        source: "infrastructure",
        evidence: "at least one preparation attempt has an unknown actual cost",
      });
    }
    const terminalVerdict = terminalVerdictFor(error.failure);
    const stages = [...committedStages, "terminal"];
    const candidateFingerprint = formalPassed ? fingerprint : null;
    const payload = PreparationFailureStagePayloadSchema.parse({
      version: 1,
      status: PREPARATION_FAILURE_STATUS,
      family: slot.family,
      modality: slot.modality,
      difficulty: slot.difficulty,
      lane: slot.lane,
      failureStage: error.failure.stage,
      failures,
      terminalVerdict,
      fingerprint: candidateFingerprint,
      stages,
      logicalCalls,
      cost,
    });
    const candidate = CandidateBarrierInputSchema.parse({
      slotId: slot.slotId,
      slotOrdinal: slot.slotOrdinal,
      family: slot.family,
      modality: slot.modality,
      lane: slot.lane,
      preparationStatus: "early_failure",
      presentationCheckPassed: false,
      formalPassed,
      terminalVerdict,
      fingerprint: candidateFingerprint,
    });
    const result = PreparationResultSchema.parse({
      version: 1,
      runId: input.runId,
      slotId: slot.slotId,
      slotOrdinal: slot.slotOrdinal,
      family: slot.family,
      modality: slot.modality,
      lane: slot.lane,
      difficulty: slot.difficulty,
      status: PREPARATION_FAILURE_STATUS,
      terminalVerdict,
      stages,
      failures,
      fingerprint: candidateFingerprint,
      candidate,
      logicalCalls,
      cost,
    });
    const evidenceArtifact: ArtifactInput = {
      kind: "json",
      mediaType: "application/json",
      bytes: Buffer.from(canonicalJson(payload), "utf8"),
      role: "preparation_evidence",
    };
    commitStage({
      db: input.db,
      runId: input.runId,
      slotId: input.slotId,
      stage: "terminal",
      startedAt: activeStageStartedAt,
      clock,
      verdict: terminalVerdict,
      payload,
      artifacts: [evidenceArtifact],
    });
    return result;
  }
}
