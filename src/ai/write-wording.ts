import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  buildChatRequest,
  type AiRoleSettings,
  type ChatMessage,
} from "./config.js";
import {
  createLogicalCall,
  recordRequestEvent,
} from "./ledger.js";
import type {
  OpenRouterAttemptResult,
  OpenRouterCallResult,
  OpenRouterUsage,
  createOpenRouterTransport,
} from "./openrouter.js";
import type { ResolvedRoute } from "./preflight.js";
import {
  WORDING_JSON_SCHEMA,
  strictSchemaHash,
} from "./schemas.js";
import { ChoiceSetSchema, deepEqual } from "../domain/answers.js";
import type { Family, Modality } from "../domain/experiment.js";
import {
  PresentationAssetsSchema,
  WordingBundleSchema,
  WordingResponseSchema,
  type AssembledPresentation,
  type PresentationAssets,
  type WordingBundle,
} from "../domain/presentation.js";
import {
  SolveResultSchema,
  mergeFactInventory,
  ruleFacts,
  type Fact,
  type SolveResult,
} from "../families/contracts.js";
import { productionRegistry } from "../families/registry.js";
import {
  getRun,
  getSlot,
  getStageResult,
  insertStageResult,
} from "../storage/repository.js";
import {
  assemblePresentation,
  formatOptionText,
} from "../presentation/assemble.js";
import { makeFixtureWording } from "../presentation/wording.js";
import {
  PresentationError,
  type PresentationErrorCode,
} from "../validation/presentation.js";
import { canonicalJson, hashCanonicalJson, sha256Hex } from "../util/hash.js";

export const WORDING_PROMPT_VERSION = "v1";
export const WORDING_SCHEMA_VERSION = "v1";

const WORDING_PROMPT_HEADER = /^PUZZLE_WORDING_PROMPT_VERSION: (v\d+)\n/;

export interface WordingPromptMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly schemaHash: string;
}

export type WordingErrorCode =
  | "INVALID_INPUT"
  | "ROUTE_ROLE_MISMATCH"
  | "SLOT_MISMATCH"
  | "INVALID_STAGE"
  | "PROMPT_ASSET_INVALID"
  | "TRANSPORT_FAILED"
  | "MISSING_CONTENT"
  | "INVALID_WORDING"
  | "MECHANICAL_CHECK_FAILED";

export interface WordingErrorOptions {
  readonly logicalCallId?: string | null;
  readonly attemptIds?: readonly string[];
  readonly result?: OpenRouterCallResult | null;
  readonly issues?: readonly string[];
  readonly presentationCode?: PresentationErrorCode | null;
  readonly cause?: unknown;
}

export class WordingError extends Error {
  readonly code: WordingErrorCode;
  readonly logicalCallId: string | null;
  readonly attemptIds: readonly string[];
  readonly result: OpenRouterCallResult | null;
  readonly issues: readonly string[];
  readonly presentationCode: PresentationErrorCode | null;

  constructor(
    code: WordingErrorCode,
    message: string,
    options: WordingErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WordingError";
    this.code = code;
    this.logicalCallId = options.logicalCallId ?? null;
    this.attemptIds = options.attemptIds ?? [];
    this.result = options.result ?? null;
    this.issues = options.issues ?? [];
    this.presentationCode = options.presentationCode ?? null;
  }
}

function readPromptAsset(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), "utf8");
  } catch (error) {
    throw new WordingError(
      "PROMPT_ASSET_INVALID",
      `cannot read prompt asset ${relativePath}`,
      { cause: error },
    );
  }
}

const WORDING_PROMPT = readPromptAsset("./prompts/v1/wording.txt");
const PROMPT_HEADER = WORDING_PROMPT_HEADER.exec(WORDING_PROMPT);
if (PROMPT_HEADER?.[1] !== WORDING_PROMPT_VERSION) {
  throw new WordingError(
    "PROMPT_ASSET_INVALID",
    `wording prompt header must declare ${WORDING_PROMPT_VERSION}`,
  );
}
const WORDING_PROMPT_TEMPLATE_HASH = sha256Hex(WORDING_PROMPT);

export function wordingPromptMetadata(): WordingPromptMetadata {
  const schemaHash = strictSchemaHash(WORDING_JSON_SCHEMA);
  const promptHash = hashCanonicalJson({
    promptVersion: WORDING_PROMPT_VERSION,
    promptTemplateHash: WORDING_PROMPT_TEMPLATE_HASH,
    schemaName: WORDING_JSON_SCHEMA.name,
    schemaVersion: WORDING_SCHEMA_VERSION,
    schemaHash,
  });
  return {
    promptVersion: WORDING_PROMPT_VERSION,
    promptHash,
    schemaName: WORDING_JSON_SCHEMA.name,
    schemaVersion: WORDING_SCHEMA_VERSION,
    schemaHash,
  };
}

export interface WordingPayload {
  readonly family: Family;
  readonly spec: unknown;
  readonly modality: Modality;
  readonly difficulty: number;
  readonly rules: unknown;
  readonly localFacts: readonly Fact[];
  readonly localFactIds: readonly string[];
  readonly inventory: readonly Fact[];
  readonly proof: unknown;
  readonly correctOption: {
    readonly label: string;
    readonly value: unknown;
    readonly text: string;
  };
  readonly options: readonly {
    readonly label: string;
    readonly value: unknown;
    readonly text: string;
  }[];
}

export function buildWordingMessages(
  payload: WordingPayload,
  metadata: WordingPromptMetadata,
): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        WORDING_PROMPT.trim(),
        "",
        "WORDING METADATA",
        `prompt_version: ${metadata.promptVersion}`,
        `prompt_hash: ${metadata.promptHash}`,
        `schema_name: ${metadata.schemaName}`,
        `schema_version: ${metadata.schemaVersion}`,
        `schema_hash: ${metadata.schemaHash}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Validated puzzle payload:",
        JSON.stringify(payload, null, 2),
        "",
        "Return exactly one JSON object matching the strict wording schema.",
      ].join("\n"),
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function positiveUsd(value: string): boolean {
  return (
    /^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    !/^0(?:\.0+)?$/.test(value)
  );
}

function presentationIssue(error: PresentationError): string[] {
  return [`${error.code}: ${error.message}`];
}

function asPresentationError(error: unknown): PresentationError | null {
  return error instanceof PresentationError ? error : null;
}

function assertInput(input: WriteWordingInput): void {
  if (input.apiKey.trim() === "") {
    throw new WordingError(
      "INVALID_INPUT",
      "an inference key is required for wording generation",
    );
  }
  if (!positiveUsd(input.reservationUsd)) {
    throw new WordingError(
      "INVALID_INPUT",
      "reservationUsd must be a positive decimal USD string",
    );
  }
  if (input.route.role !== "wording") {
    throw new WordingError(
      "ROUTE_ROLE_MISMATCH",
      `wording requires a resolved wording route, received ${input.route.role}`,
    );
  }
  if (input.route.requiresImage) {
    throw new WordingError(
      "INVALID_INPUT",
      "a wording route must not require an image",
    );
  }
}

export interface WriteWordingInput {
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
  readonly assets?: unknown;
  readonly reservationUsd: string;
  readonly clock?: { now(): Date };
}

export interface WriteWordingResult {
  readonly logicalCallId: string;
  readonly family: Family;
  readonly modality: Modality;
  readonly wording: WordingBundle;
  readonly presentation: AssembledPresentation;
  readonly proposal: WordingPromptMetadata;
  readonly usage: OpenRouterUsage;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly OpenRouterAttemptResult[];
}

export async function writeWording(
  input: WriteWordingInput,
): Promise<WriteWordingResult> {
  assertInput(input);
  const run = getRun(input.db, input.runId);
  if (run.runKind !== "full" && run.runKind !== "smoke") {
    throw new WordingError(
      "INVALID_INPUT",
      `wording requires a full or smoke run, received ${run.runKind}`,
    );
  }
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (slot.stage !== "formal_checked") {
    throw new WordingError(
      "INVALID_STAGE",
      `wording requires a formal_checked slot, received ${slot.stage}`,
    );
  }
  const engine = productionRegistry.getEngine(slot.family);
  if (engine.modality !== slot.modality) {
    throw new WordingError(
      "SLOT_MISMATCH",
      `slot ${input.slotId} modality does not match the ${slot.family} engine`,
    );
  }

  const formalStage = getStageResult(
    input.db,
    input.runId,
    input.slotId,
    "formal_checked",
  );
  if (
    !isRecord(formalStage.payload) ||
    !("spec" in formalStage.payload) ||
    !("solveResult" in formalStage.payload) ||
    !("choices" in formalStage.payload)
  ) {
    throw new WordingError(
      "INVALID_STAGE",
      "formal_checked stage must store spec, solveResult, and choices",
    );
  }
  const storedSpec = formalStage.payload.spec;
  const storedSolve = formalStage.payload.solveResult;
  const storedChoices = formalStage.payload.choices;
  if (
    !sameJson(input.spec, storedSpec) ||
    !sameJson(input.solveResult, storedSolve) ||
    !sameJson(input.choices, storedChoices)
  ) {
    throw new WordingError(
      "INVALID_INPUT",
      "caller artifacts do not match the slot's formal_checked evidence",
    );
  }

  const parsedSpec = engine.schema.safeParse(storedSpec);
  if (!parsedSpec.success) {
    throw new WordingError(
      "INVALID_INPUT",
      "spec does not satisfy the family schema",
      {
        issues: parsedSpec.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsedSpec.error,
      },
    );
  }
  const parsedSolve = SolveResultSchema.safeParse(storedSolve);
  if (
    !parsedSolve.success ||
    parsedSolve.data.solutionCount !== 1 ||
    parsedSolve.data.answerCount !== 1 ||
    parsedSolve.data.correctAnswer === null ||
    parsedSolve.data.correctAnswer === undefined ||
    parsedSolve.data.proof === null
  ) {
    throw new WordingError(
      "INVALID_INPUT",
      "wording requires a unique solved answer with a proof",
      parsedSolve.success
        ? {}
        : {
            issues: parsedSolve.error.issues.map(
              (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
            ),
            cause: parsedSolve.error,
          },
    );
  }
  const parsedChoices = ChoiceSetSchema.safeParse(storedChoices);
  if (!parsedChoices.success) {
    throw new WordingError(
      "INVALID_INPUT",
      "choices do not satisfy the shared choice-set contract",
      {
        issues: parsedChoices.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsedChoices.error,
      },
    );
  }
  const parsedAssets = PresentationAssetsSchema.safeParse(
    input.assets ?? { svgHash: null, pngHash: null },
  );
  if (!parsedAssets.success) {
    throw new WordingError(
      "INVALID_INPUT",
      "presentation assets do not satisfy the hash schema",
      {
        issues: parsedAssets.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsedAssets.error,
      },
    );
  }

  const solve = parsedSolve.data as SolveResult<unknown>;
  const choices = parsedChoices.data;
  const assets: PresentationAssets = parsedAssets.data;
  let independent: SolveResult<unknown>;
  try {
    independent = engine.enumerateSolutions(parsedSpec.data);
  } catch (error) {
    throw new WordingError(
      "INVALID_INPUT",
      "cannot independently solve the formal_checked spec",
      { cause: error },
    );
  }
  if (
    independent.solutionCount !== 1 ||
    independent.answerCount !== 1 ||
    !deepEqual(independent.correctAnswer, solve.correctAnswer)
  ) {
    throw new WordingError(
      "INVALID_INPUT",
      "formal_checked evidence is not independently unique or its answer differs",
      {
        issues: [
          `independent solutionCount=${independent.solutionCount} answerCount=${independent.answerCount}`,
        ],
      },
    );
  }
  let fixtureWording: WordingBundle;
  try {
    fixtureWording = makeFixtureWording(engine, parsedSpec.data);
  } catch (error) {
    throw new WordingError(
      "INVALID_INPUT",
      "cannot build the fixture wording used to preflight the slot",
      { cause: error },
    );
  }
  try {
    assemblePresentation({
      slotId: input.slotId,
      engine,
      spec: parsedSpec.data,
      solveResult: solve,
      choices,
      wording: fixtureWording,
      assets,
    });
  } catch (error) {
    const presentationError = asPresentationError(error);
    throw new WordingError(
      "INVALID_INPUT",
      "slot inputs fail the P22 mechanical preflight",
      {
        issues: presentationError === null ? [] : presentationIssue(presentationError),
        presentationCode: presentationError?.code ?? null,
        cause: error,
      },
    );
  }

  let payload: WordingPayload;
  try {
    const rules = engine.visibleRules(parsedSpec.data);
    const localFacts = engine.facts(parsedSpec.data);
    const inventory = mergeFactInventory(
      ruleFacts(rules),
      localFacts,
      solve.proof?.facts ?? [],
    );
    const options = choices.choices.map((choice) => ({
      label: choice.label,
      value: choice.value,
      text: formatOptionText(slot.family, choice.label, choice.value),
    }));
    const correctChoice = choices.choices.find(
      (choice) => choice.label === choices.correctLabel,
    );
    if (correctChoice === undefined) {
      throw new Error("correct choice is missing from the choice set");
    }
    payload = {
      family: slot.family,
      spec: parsedSpec.data,
      modality: slot.modality,
      difficulty: slot.difficulty,
      rules,
      localFacts,
      localFactIds: localFacts.map((fact) => fact.factId),
      inventory,
      proof: solve.proof,
      correctOption: {
        label: correctChoice.label,
        value: correctChoice.value,
        text: formatOptionText(slot.family, correctChoice.label, correctChoice.value),
      },
      options,
    };
  } catch (error) {
    const presentationError = asPresentationError(error);
    throw new WordingError(
      "INVALID_INPUT",
      "cannot serialize the validated puzzle payload for wording",
      {
        issues: presentationError === null ? [] : presentationIssue(presentationError),
        presentationCode: presentationError?.code ?? null,
        cause: error,
      },
    );
  }

  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now();
  const metadata = wordingPromptMetadata();
  const messages = buildWordingMessages(payload, metadata);
  const settings: AiRoleSettings | undefined =
    Object.keys(input.route.settings).length > 0
      ? input.route.settings
      : undefined;
  const built = buildChatRequest({
    role: "wording",
    model: input.route.model,
    providerTag: input.route.providerTag,
    outputCapField: input.route.outputCapField,
    maxOutputTokens: input.route.maxOutputTokens,
    messages,
    responseFormat: WORDING_JSON_SCHEMA,
    ...(settings === undefined ? {} : { settings }),
  });

  const call = createLogicalCall(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    role: "wording",
    runKind: run.runKind,
    requestBody: built.body,
    expectedSchemaHash: metadata.schemaHash,
    model: input.route.model,
    provider: input.route.providerTag,
    outputCapField: input.route.outputCapField,
    createdAt: startedAt.toISOString(),
  });

  recordRequestEvent(input.db, {
    logicalCallId: call.logicalCallId,
    eventType: "wording_metadata",
    payload: {
      family: slot.family,
      modality: slot.modality,
      difficulty: slot.difficulty,
      ...metadata,
    },
    createdAt: startedAt.toISOString(),
  });

  const result = await input.transport.executeCall({
    db: input.db,
    accountId: input.accountId,
    logicalCallId: call.logicalCallId,
    apiKey: input.apiKey,
    reservationUsd: input.reservationUsd,
  });
  const attemptIds = result.attempts.map((attempt) => attempt.attemptId);

  if (result.outcome !== "success") {
    throw new WordingError(
      "TRANSPORT_FAILED",
      `wording transport outcome was ${result.outcome}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }
  if (result.parsedContent === null) {
    throw new WordingError(
      "MISSING_CONTENT",
      "wording response has no parsed JSON content",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  const parsedWording = WordingResponseSchema.safeParse(result.parsedContent);
  if (!parsedWording.success) {
    throw new WordingError(
      "INVALID_WORDING",
      "wording response does not satisfy the strict wording schema",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: parsedWording.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsedWording.error,
      },
    );
  }
  const wording = WordingBundleSchema.parse({
    source: "model",
    response: parsedWording.data,
  });

  let presentation: AssembledPresentation;
  try {
    presentation = assemblePresentation({
      slotId: input.slotId,
      engine,
      spec: parsedSpec.data,
      solveResult: solve,
      choices,
      wording,
      assets,
    });
  } catch (error) {
    const presentationError = asPresentationError(error);
    throw new WordingError(
      "MECHANICAL_CHECK_FAILED",
      "wording fails the P22 mechanical checks",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: presentationError === null ? [] : presentationIssue(presentationError),
        presentationCode: presentationError?.code ?? null,
        cause: error,
      },
    );
  }

  const finishedAt = clock.now();
  const elapsedMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  insertStageResult(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    stage: "presentation_ready",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs,
    payload: {
      family: slot.family,
      modality: slot.modality,
      difficulty: slot.difficulty,
      wording,
      presentation,
      proposal: {
        ...metadata,
        logicalCallId: call.logicalCallId,
        attemptIds,
        model: input.route.model,
        provider: input.route.providerTag,
        outputCapField: input.route.outputCapField,
        maxOutputTokens: input.route.maxOutputTokens,
        usage: result.usage,
        actualCostUsd: result.actualCostUsd,
        costStatus: result.costStatus,
      },
    },
  });

  return {
    logicalCallId: call.logicalCallId,
    family: slot.family,
    modality: slot.modality,
    wording,
    presentation,
    proposal: metadata,
    usage: result.usage,
    actualCostUsd: result.actualCostUsd,
    costStatus: result.costStatus,
    attempts: result.attempts,
  };
}
