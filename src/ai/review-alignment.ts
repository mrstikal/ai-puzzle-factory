import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  buildChatRequest,
  MAX_PNG_BYTES,
  type AiRoleSettings,
  type ChatMessage,
} from "./config.js";
import {
  getOrCreateLogicalCall,
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
  ALIGNMENT_FIELD_NAMES,
  ALIGNMENT_REVIEW_JSON_SCHEMA,
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  AlignmentContractError,
  deriveAlignmentOverall,
  strictSchemaHash,
  type AlignmentFieldName,
  type AlignmentFieldStatus,
  type AlignmentOverall,
  type AlignmentReviewResponse,
} from "./schemas.js";
import {
  ChoiceSetSchema,
  deepEqual,
  type ChoiceLabel,
} from "../domain/answers.js";
import type { Family, Modality } from "../domain/experiment.js";
import type { AssembledPresentation } from "../domain/presentation.js";
import {
  SolveResultSchema,
  mergeFactInventory,
  ruleFacts,
  type Fact,
  type SolveProof,
  type SolveResult,
} from "../families/contracts.js";
import { productionRegistry } from "../families/registry.js";
import { formatOptionText } from "../presentation/assemble.js";
import {
  PresentationError,
  assertAssembledPresentation,
} from "../validation/presentation.js";
import { getArtifact } from "../storage/artifacts.js";
import { StorageError } from "../storage/database.js";
import { getRun, getSlot, getStageResult } from "../storage/repository.js";
import {
  assertPngDimensions,
  assertPngNoTextMetadata,
  hashPng,
} from "../render/png.js";
import { SCENE_SIZE } from "../render/scene.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";

export const ALIGNMENT_TEXT_PROMPT_VERSION = "v1";
export const ALIGNMENT_VISION_PROMPT_VERSION = "v1";
export const ALIGNMENT_SCHEMA_VERSION = "v1";

const ALIGNMENT_TEXT_PROMPT_HEADER =
  /^PUZZLE_ALIGNMENT_TEXT_PROMPT_VERSION: (v\d+)\n/;
const ALIGNMENT_VISION_PROMPT_HEADER =
  /^PUZZLE_ALIGNMENT_VISION_PROMPT_VERSION: (v\d+)\n/;

export interface AlignmentPromptMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly schemaHash: string;
}

export interface AlignmentPayload {
  readonly family: Family;
  readonly modality: Modality;
  readonly difficulty: number;
  readonly dsl: unknown;
  readonly proof: unknown;
  readonly correctOption: {
    readonly label: ChoiceLabel;
    readonly value: unknown;
    readonly text: string;
  };
  readonly options: readonly {
    readonly label: ChoiceLabel;
    readonly value: unknown;
    readonly text: string;
  }[];
  readonly visible: {
    readonly question: string;
    readonly rules: unknown;
    readonly clues: readonly { readonly factId: string; readonly text: string }[];
    readonly options: readonly {
      readonly label: ChoiceLabel;
      readonly text: string;
    }[];
  };
  readonly wording: {
    readonly hint: string;
    readonly explanationSteps: readonly unknown[];
  };
  readonly inventory: readonly Fact[];
}

export interface AlignmentConcern {
  readonly field: AlignmentFieldName;
  readonly status: AlignmentFieldStatus;
  readonly reason: string;
  readonly factIds: readonly string[];
}

export interface AlignmentDeterministicEvidence {
  readonly inventoryFactIds: readonly string[];
  readonly proof: SolveProof<unknown>;
  readonly correctLabel: ChoiceLabel;
  readonly correctValue: unknown;
  readonly optionValues: readonly {
    readonly label: ChoiceLabel;
    readonly value: unknown;
  }[];
}

export type ReviewAlignmentErrorCode =
  | "INVALID_INPUT"
  | "ROUTE_ROLE_MISMATCH"
  | "INVALID_STAGE"
  | "PROMPT_ASSET_INVALID"
  | "MISSING_PNG_ASSET"
  | "PNG_NOT_FOUND"
  | "PNG_TOO_LARGE"
  | "INVALID_PNG"
  | "TRANSPORT_FAILED"
  | "MISSING_CONTENT"
  | "INVALID_ALIGNMENT";

export interface ReviewAlignmentErrorOptions {
  readonly logicalCallId?: string | null;
  readonly attemptIds?: readonly string[];
  readonly result?: OpenRouterCallResult | null;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
}

export class ReviewAlignmentError extends Error {
  readonly code: ReviewAlignmentErrorCode;
  readonly logicalCallId: string | null;
  readonly attemptIds: readonly string[];
  readonly result: OpenRouterCallResult | null;
  readonly issues: readonly string[];

  constructor(
    code: ReviewAlignmentErrorCode,
    message: string,
    options: ReviewAlignmentErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ReviewAlignmentError";
    this.code = code;
    this.logicalCallId = options.logicalCallId ?? null;
    this.attemptIds = options.attemptIds ?? [];
    this.result = options.result ?? null;
    this.issues = options.issues ?? [];
  }
}

function readPromptAsset(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), "utf8");
  } catch (error) {
    throw new ReviewAlignmentError(
      "PROMPT_ASSET_INVALID",
      `cannot read prompt asset ${relativePath}`,
      { cause: error },
    );
  }
}

const ALIGNMENT_TEXT_PROMPT = readPromptAsset("./prompts/v1/alignment-text.txt");
const ALIGNMENT_VISION_PROMPT = readPromptAsset(
  "./prompts/v1/alignment-vision.txt",
);
const TEXT_HEADER = ALIGNMENT_TEXT_PROMPT_HEADER.exec(ALIGNMENT_TEXT_PROMPT);
if (TEXT_HEADER?.[1] !== ALIGNMENT_TEXT_PROMPT_VERSION) {
  throw new ReviewAlignmentError(
    "PROMPT_ASSET_INVALID",
    `alignment-text prompt header must declare ${ALIGNMENT_TEXT_PROMPT_VERSION}`,
  );
}
const VISION_HEADER = ALIGNMENT_VISION_PROMPT_HEADER.exec(
  ALIGNMENT_VISION_PROMPT,
);
if (VISION_HEADER?.[1] !== ALIGNMENT_VISION_PROMPT_VERSION) {
  throw new ReviewAlignmentError(
    "PROMPT_ASSET_INVALID",
    `alignment-vision prompt header must declare ${ALIGNMENT_VISION_PROMPT_VERSION}`,
  );
}

const ALIGNMENT_TEXT_TEMPLATE_HASH = sha256Hex(ALIGNMENT_TEXT_PROMPT);
const ALIGNMENT_VISION_TEMPLATE_HASH = sha256Hex(ALIGNMENT_VISION_PROMPT);

export function alignmentPromptMetadata(
  modality: Modality,
): AlignmentPromptMetadata {
  const isText = modality === "text";
  const schemaHash = strictSchemaHash(ALIGNMENT_REVIEW_JSON_SCHEMA);
  const promptVersion = isText
    ? ALIGNMENT_TEXT_PROMPT_VERSION
    : ALIGNMENT_VISION_PROMPT_VERSION;
  const promptTemplateHash = isText
    ? ALIGNMENT_TEXT_TEMPLATE_HASH
    : ALIGNMENT_VISION_TEMPLATE_HASH;
  const promptHash = hashCanonicalJson({
    promptVersion,
    promptTemplateHash,
    schemaName: ALIGNMENT_REVIEW_JSON_SCHEMA.name,
    schemaVersion: ALIGNMENT_SCHEMA_VERSION,
    schemaHash,
  });
  return {
    promptVersion,
    promptHash,
    schemaName: ALIGNMENT_REVIEW_JSON_SCHEMA.name,
    schemaVersion: ALIGNMENT_SCHEMA_VERSION,
    schemaHash,
  };
}

export function buildAlignmentMessages(
  payload: AlignmentPayload,
  metadata: AlignmentPromptMetadata,
  pngBytes: Buffer | null,
): readonly ChatMessage[] {
  const prompt =
    payload.modality === "svg" ? ALIGNMENT_VISION_PROMPT : ALIGNMENT_TEXT_PROMPT;
  const textContent = [
    "Alignment review payload:",
    JSON.stringify(payload, null, 2),
    "",
    "Return exactly one JSON object matching the strict alignment schema.",
  ].join("\n");
  return [
    {
      role: "system",
      content: [
        prompt.trim(),
        "",
        "ALIGNMENT METADATA",
        `prompt_version: ${metadata.promptVersion}`,
        `prompt_hash: ${metadata.promptHash}`,
        `schema_name: ${metadata.schemaName}`,
        `schema_version: ${metadata.schemaVersion}`,
        `schema_hash: ${metadata.schemaHash}`,
      ].join("\n"),
    },
    {
      role: "user",
      content:
        pngBytes === null
          ? textContent
          : [
              { type: "text", text: textContent },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${pngBytes.toString("base64")}`,
                },
              },
            ],
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveUsd(value: string): boolean {
  return (
    /^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    !/^0(?:\.0+)?$/.test(value)
  );
}

function assertInput(input: ReviewAlignmentInput): void {
  if (input.apiKey.trim() === "") {
    throw new ReviewAlignmentError(
      "INVALID_INPUT",
      "an inference key is required for alignment review",
    );
  }
  if (!positiveUsd(input.reservationUsd)) {
    throw new ReviewAlignmentError(
      "INVALID_INPUT",
      "reservationUsd must be a positive decimal USD string",
    );
  }
}

export interface ReviewAlignmentInput {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly runId: string;
  readonly slotId: string;
  readonly route: ResolvedRoute;
  readonly reservationUsd: string;
  readonly clock?: { now(): Date };
}

export interface ReviewAlignmentResult {
  readonly logicalCallId: string;
  readonly role: "alignment_text" | "alignment_vision";
  readonly family: Family;
  readonly modality: Modality;
  readonly review: AlignmentReviewResponse;
  readonly modelOverall: AlignmentOverall;
  readonly derivedOverall: AlignmentOverall;
  readonly overallMismatch: boolean;
  readonly concerns: readonly AlignmentConcern[];
  readonly deterministicEvidence: AlignmentDeterministicEvidence;
  readonly publicPayload: AlignmentPayload;
  readonly pngHash: string | null;
  readonly pngByteLength: number | null;
  readonly proposal: AlignmentPromptMetadata;
  readonly usage: OpenRouterUsage;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly OpenRouterAttemptResult[];
}

function loadAlignmentPng(
  db: Database.Database,
  pngHash: string,
): { readonly bytes: Buffer; readonly pngHash: string; readonly byteLength: number } {
  let artifact;
  try {
    artifact = getArtifact(db, pngHash, "png");
  } catch (error) {
    const code =
      error instanceof StorageError && error.code === "NOT_FOUND"
        ? "PNG_NOT_FOUND"
        : "INVALID_PNG";
    throw new ReviewAlignmentError(code, `cannot load PNG asset ${pngHash}`, {
      cause: error,
    });
  }
  const bytes = artifact.bytes;
  if (bytes.length > MAX_PNG_BYTES) {
    throw new ReviewAlignmentError(
      "PNG_TOO_LARGE",
      `PNG is ${bytes.length} bytes; limit is ${MAX_PNG_BYTES}`,
    );
  }
  if (artifact.artifact.mediaType !== "image/png") {
    throw new ReviewAlignmentError(
      "INVALID_PNG",
      `PNG artifact media type is ${artifact.artifact.mediaType}`,
    );
  }
  if (hashPng(bytes) !== pngHash) {
    throw new ReviewAlignmentError(
      "INVALID_PNG",
      "PNG bytes do not match the stored source hash",
    );
  }
  try {
    assertPngNoTextMetadata(bytes);
    assertPngDimensions(bytes, SCENE_SIZE, SCENE_SIZE);
  } catch (error) {
    throw new ReviewAlignmentError("INVALID_PNG", "PNG safety check failed", {
      cause: error,
    });
  }
  return { bytes, pngHash, byteLength: bytes.length };
}

export async function reviewAlignment(
  input: ReviewAlignmentInput,
): Promise<ReviewAlignmentResult> {
  assertInput(input);
  const run = getRun(input.db, input.runId);
  if (run.runKind !== "full" && run.runKind !== "smoke") {
    throw new ReviewAlignmentError(
      "INVALID_INPUT",
      `alignment review requires a full or smoke run, received ${run.runKind}`,
    );
  }
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (
    slot.stage !== "presentation_ready" &&
    slot.stage !== "duplicate_checked" &&
    slot.stage !== "blind_reviewed"
  ) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      `alignment review requires presentation_ready, duplicate_checked, or blind_reviewed, received ${slot.stage}`,
    );
  }

  let formalStage;
  try {
    formalStage = getStageResult(
      input.db,
      input.runId,
      input.slotId,
      "formal_checked",
    );
  } catch (error) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "formal_checked stage is missing",
      { cause: error },
    );
  }
  if (
    !isRecord(formalStage.payload) ||
    !("spec" in formalStage.payload) ||
    !("solveResult" in formalStage.payload) ||
    !("choices" in formalStage.payload)
  ) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "formal_checked stage must store spec, solveResult, and choices",
    );
  }
  const engine = productionRegistry.getEngine(slot.family);
  if (engine.modality !== slot.modality) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      `slot ${input.slotId} modality does not match the ${slot.family} engine`,
    );
  }
  const parsedSpec = engine.schema.safeParse(formalStage.payload.spec);
  if (!parsedSpec.success) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored formal_checked spec does not satisfy the family schema",
      {
        issues: parsedSpec.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsedSpec.error,
      },
    );
  }
  const parsedSolve = SolveResultSchema.safeParse(formalStage.payload.solveResult);
  if (
    !parsedSolve.success ||
    parsedSolve.data.solutionCount !== 1 ||
    parsedSolve.data.answerCount !== 1 ||
    parsedSolve.data.correctAnswer === null ||
    parsedSolve.data.correctAnswer === undefined ||
    parsedSolve.data.proof === null
  ) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored formal_checked solve result is not a unique solved answer with proof",
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
  const parsedChoices = ChoiceSetSchema.safeParse(formalStage.payload.choices);
  if (!parsedChoices.success) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored formal_checked choices do not satisfy the shared choice-set contract",
      {
        issues: parsedChoices.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsedChoices.error,
      },
    );
  }

  let presentationStage;
  try {
    presentationStage = getStageResult(
      input.db,
      input.runId,
      input.slotId,
      "presentation_ready",
    );
  } catch (error) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "presentation_ready stage is missing",
      { cause: error },
    );
  }
  if (!isRecord(presentationStage.payload) || !("presentation" in presentationStage.payload)) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "presentation_ready stage must store the assembled presentation",
    );
  }
  let assembled: AssembledPresentation;
  try {
    assembled = assertAssembledPresentation(presentationStage.payload.presentation);
  } catch (error) {
    const code =
      error instanceof PresentationError && error.code === "MISSING_IMAGE_ASSET"
        ? "MISSING_PNG_ASSET"
        : "INVALID_STAGE";
    throw new ReviewAlignmentError(
      code,
      "stored presentation does not satisfy the assembled presentation contract",
      {
        issues:
          error instanceof PresentationError
            ? [`${error.code}: ${error.message}`]
            : [],
        cause: error,
      },
    );
  }
  if (assembled.visible.slotId !== input.slotId) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      `stored presentation slot ${assembled.visible.slotId} does not match ${input.slotId}`,
    );
  }
  if (
    assembled.visible.family !== slot.family ||
    assembled.visible.modality !== slot.modality
  ) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored presentation family/modality does not match the slot",
    );
  }
  if (!deepEqual(assembled.visible.rules, engine.visibleRules(parsedSpec.data))) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored presentation rules do not match the formal spec",
    );
  }
  const solve = parsedSolve.data as SolveResult<unknown>;
  const choices = parsedChoices.data;
  const expectedOptions = choices.choices.map((choice) => ({
    label: choice.label,
    text: formatOptionText(slot.family, choice.label, choice.value),
  }));
  if (!deepEqual(assembled.visible.options, expectedOptions)) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored presentation options do not match the formal choices",
    );
  }
  const correctChoice = choices.choices.find(
    (choice) => choice.label === choices.correctLabel,
  );
  if (
    correctChoice === undefined ||
    !deepEqual(assembled.reveal.correctValue, correctChoice.value) ||
    !deepEqual(solve.correctAnswer, correctChoice.value) ||
    assembled.reveal.correctLabel !== choices.correctLabel
  ) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "stored presentation key does not match the formal answer",
    );
  }
  if (solve.proof === null) {
    throw new ReviewAlignmentError(
      "INVALID_STAGE",
      "formal solve result has no proof",
    );
  }

  const expectedRole =
    slot.modality === "svg" ? "alignment_vision" : "alignment_text";
  if (input.route.role !== expectedRole) {
    throw new ReviewAlignmentError(
      "ROUTE_ROLE_MISMATCH",
      `alignment review requires a resolved ${expectedRole} route, received ${input.route.role}`,
    );
  }
  if (slot.modality === "svg" && !input.route.requiresImage) {
    throw new ReviewAlignmentError(
      "INVALID_INPUT",
      "alignment vision route must require image input",
    );
  }
  if (slot.modality === "text" && input.route.requiresImage) {
    throw new ReviewAlignmentError(
      "INVALID_INPUT",
      "alignment text route must not require image input",
    );
  }

  let png: ReturnType<typeof loadAlignmentPng> | null = null;
  if (slot.modality === "svg") {
    const pngHash = assembled.visible.assets.pngHash;
    if (pngHash === null) {
      throw new ReviewAlignmentError(
        "MISSING_PNG_ASSET",
        "SVG presentation has no stored PNG hash",
      );
    }
    png = loadAlignmentPng(input.db, pngHash);
  }

  let inventory: readonly Fact[];
  try {
    inventory = mergeFactInventory(
      ruleFacts(engine.visibleRules(parsedSpec.data)),
      engine.facts(parsedSpec.data),
      solve.proof.facts,
    );
  } catch (error) {
    throw new ReviewAlignmentError(
      "INVALID_INPUT",
      "cannot build the alignment fact inventory",
      { cause: error },
    );
  }
  const options = choices.choices.map((choice) => ({
    label: choice.label,
    value: choice.value,
    text: formatOptionText(slot.family, choice.label, choice.value),
  }));
  const publicPayload: AlignmentPayload = {
    family: slot.family,
    modality: slot.modality,
    difficulty: slot.difficulty,
    dsl: parsedSpec.data,
    proof: solve.proof,
    correctOption: {
      label: correctChoice.label,
      value: correctChoice.value,
      text: formatOptionText(slot.family, correctChoice.label, correctChoice.value),
    },
    options,
    visible: {
      question: assembled.visible.question,
      rules: assembled.visible.rules,
      clues: assembled.visible.clues.map((clue) => ({
        factId: clue.factId,
        text: clue.text,
      })),
      options: assembled.visible.options.map((option) => ({
        label: option.label,
        text: option.text,
      })),
    },
    wording: {
      hint: assembled.reveal.hint,
      explanationSteps: assembled.reveal.explanationSteps,
    },
    inventory,
  };

  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now();
  const metadata = alignmentPromptMetadata(slot.modality);
  const messages = buildAlignmentMessages(publicPayload, metadata, png?.bytes ?? null);
  const settings: AiRoleSettings | undefined =
    Object.keys(input.route.settings).length > 0
      ? input.route.settings
      : undefined;
  const built = buildChatRequest({
    role: expectedRole,
    model: input.route.model,
    providerTag: input.route.providerTag,
    outputCapField: input.route.outputCapField,
    maxOutputTokens: input.route.maxOutputTokens,
    messages,
    responseFormat: ALIGNMENT_REVIEW_JSON_SCHEMA,
    ...(settings === undefined ? {} : { settings }),
  });

  const call = getOrCreateLogicalCall(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    role: expectedRole,
    runKind: run.runKind,
    requestBody: built.body,
    expectedSchemaHash: metadata.schemaHash,
    model: input.route.model,
    provider: input.route.providerTag,
    outputCapField: input.route.outputCapField,
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
    throw new ReviewAlignmentError(
      "TRANSPORT_FAILED",
      `alignment review transport outcome was ${result.outcome}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }
  if (result.parsedContent === null) {
    throw new ReviewAlignmentError(
      "MISSING_CONTENT",
      "alignment review response has no parsed JSON content",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  const parsed = ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse(result.parsedContent);
  if (!parsed.success) {
    throw new ReviewAlignmentError(
      "INVALID_ALIGNMENT",
      "alignment response does not satisfy the strict alignment schema",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
        ),
        cause: parsed.error,
      },
    );
  }
  const inventoryIds = new Set(inventory.map((fact) => fact.factId));
  const unknownCitations: string[] = [];
  for (const field of ALIGNMENT_FIELD_NAMES) {
    for (const factId of parsed.data.fields[field].factIds) {
      if (!inventoryIds.has(factId)) {
        unknownCitations.push(`${field}:${factId}`);
      }
    }
  }
  if (unknownCitations.length > 0) {
    throw new ReviewAlignmentError(
      "INVALID_ALIGNMENT",
      "alignment response cites fact IDs outside the supplied inventory",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: unknownCitations,
      },
    );
  }

  let derivedOverall: AlignmentOverall;
  try {
    derivedOverall = deriveAlignmentOverall(parsed.data.fields, slot.modality);
  } catch (error) {
    if (error instanceof AlignmentContractError) {
      throw new ReviewAlignmentError(
        "INVALID_ALIGNMENT",
        "alignment field statuses violate the required applicability contract",
        {
          logicalCallId: call.logicalCallId,
          attemptIds,
          result,
          issues: [`${error.code}: ${error.message}`],
          cause: error,
        },
      );
    }
    throw error;
  }
  const modelOverall = parsed.data.overall;
  const concerns: AlignmentConcern[] = ALIGNMENT_FIELD_NAMES.filter(
    (field) =>
      parsed.data.fields[field].status !== "pass" &&
      parsed.data.fields[field].status !== "not_applicable",
  ).map((field) => ({
    field,
    status: parsed.data.fields[field].status,
    reason: parsed.data.fields[field].reason,
    factIds: parsed.data.fields[field].factIds,
  }));
  const deterministicEvidence: AlignmentDeterministicEvidence = {
    inventoryFactIds: inventory.map((fact) => fact.factId),
    proof: solve.proof,
    correctLabel: correctChoice.label,
    correctValue: correctChoice.value,
    optionValues: options.map((option) => ({
      label: option.label,
      value: option.value,
    })),
  };

  recordRequestEvent(input.db, {
    logicalCallId: call.logicalCallId,
    eventType: "alignment_review",
    payload: {
      role: expectedRole,
      family: slot.family,
      modality: slot.modality,
      difficulty: slot.difficulty,
      inputHash: hashCanonicalJson(publicPayload),
      ...(png === null
        ? {}
        : { pngHash: png.pngHash, pngByteLength: png.byteLength }),
      modelEvidence: {
        overall: modelOverall,
        fields: parsed.data.fields,
        concerns,
      },
      derivedOverall,
      overallMismatch: modelOverall !== derivedOverall,
      deterministicEvidence,
      ...metadata,
    },
    createdAt: startedAt.toISOString(),
  });

  return {
    logicalCallId: call.logicalCallId,
    role: expectedRole,
    family: slot.family,
    modality: slot.modality,
    review: parsed.data,
    modelOverall,
    derivedOverall,
    overallMismatch: modelOverall !== derivedOverall,
    concerns,
    deterministicEvidence,
    publicPayload,
    pngHash: png?.pngHash ?? null,
    pngByteLength: png?.byteLength ?? null,
    proposal: metadata,
    usage: result.usage,
    actualCostUsd: result.actualCostUsd,
    costStatus: result.costStatus,
    attempts: result.attempts,
  };
}
