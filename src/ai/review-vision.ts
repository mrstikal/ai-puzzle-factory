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
  BLIND_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
  strictSchemaHash,
  type BlindReviewResponse,
} from "./schemas.js";
import {
  BlindTextPublicPayloadSchema,
  type BlindChoiceAgreement,
  type BlindTextPublicPayload,
} from "./review-text.js";
import { getArtifact } from "../storage/artifacts.js";
import { StorageError } from "../storage/database.js";
import { getRun, getSlot, getStageResult } from "../storage/repository.js";
import {
  PresentationError,
  assertAssembledPresentation,
} from "../validation/presentation.js";
import {
  assertPngDimensions,
  assertPngNoTextMetadata,
  hashPng,
} from "../render/png.js";
import { SCENE_SIZE } from "../render/scene.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";

export const BLIND_VISION_PROMPT_VERSION = "v3";
export const BLIND_VISION_SCHEMA_VERSION = "v1";

const BLIND_VISION_PROMPT_HEADER = /^PUZZLE_BLIND_VISION_PROMPT_VERSION: (v\d+)\n/;

export interface BlindVisionPromptMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly schemaHash: string;
}

export type ReviewVisionErrorCode =
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
  | "INVALID_REVIEW";

export interface ReviewVisionErrorOptions {
  readonly logicalCallId?: string | null;
  readonly attemptIds?: readonly string[];
  readonly result?: OpenRouterCallResult | null;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
}

export class ReviewVisionError extends Error {
  readonly code: ReviewVisionErrorCode;
  readonly logicalCallId: string | null;
  readonly attemptIds: readonly string[];
  readonly result: OpenRouterCallResult | null;
  readonly issues: readonly string[];

  constructor(
    code: ReviewVisionErrorCode,
    message: string,
    options: ReviewVisionErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ReviewVisionError";
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
    throw new ReviewVisionError(
      "PROMPT_ASSET_INVALID",
      `cannot read prompt asset ${relativePath}`,
      { cause: error },
    );
  }
}

const BLIND_VISION_PROMPT = readPromptAsset("./prompts/v3/blind-vision.txt");
const PROMPT_HEADER = BLIND_VISION_PROMPT_HEADER.exec(BLIND_VISION_PROMPT);
if (PROMPT_HEADER?.[1] !== BLIND_VISION_PROMPT_VERSION) {
  throw new ReviewVisionError(
    "PROMPT_ASSET_INVALID",
    `blind-vision prompt header must declare ${BLIND_VISION_PROMPT_VERSION}`,
  );
}
const BLIND_VISION_PROMPT_TEMPLATE_HASH = sha256Hex(BLIND_VISION_PROMPT);

export function blindVisionPromptMetadata(): BlindVisionPromptMetadata {
  const schemaHash = strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA);
  const promptHash = hashCanonicalJson({
    promptVersion: BLIND_VISION_PROMPT_VERSION,
    promptTemplateHash: BLIND_VISION_PROMPT_TEMPLATE_HASH,
    schemaName: BLIND_REVIEW_JSON_SCHEMA.name,
    schemaVersion: BLIND_VISION_SCHEMA_VERSION,
    schemaHash,
  });
  return {
    promptVersion: BLIND_VISION_PROMPT_VERSION,
    promptHash,
    schemaName: BLIND_REVIEW_JSON_SCHEMA.name,
    schemaVersion: BLIND_VISION_SCHEMA_VERSION,
    schemaHash,
  };
}

export function buildBlindVisionMessages(
  payload: BlindTextPublicPayload,
  metadata: BlindVisionPromptMetadata,
  pngBytes: Buffer,
): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        BLIND_VISION_PROMPT.trim(),
        "",
        "BLIND VISION METADATA",
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
        {
          type: "text",
          text: [
            "Public puzzle:",
            JSON.stringify(payload, null, 2),
            "",
            "Solve from the actual PNG image and return exactly one JSON object matching the strict schema.",
          ].join("\n"),
        },
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

function assertInput(input: ReviewVisionInput): void {
  if (input.apiKey.trim() === "") {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      "an inference key is required for blind vision review",
    );
  }
  if (!positiveUsd(input.reservationUsd)) {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      "reservationUsd must be a positive decimal USD string",
    );
  }
  if (input.route.role !== "blind_vision") {
    throw new ReviewVisionError(
      "ROUTE_ROLE_MISMATCH",
      `blind vision review requires a resolved blind_vision route, received ${input.route.role}`,
    );
  }
  if (!input.route.requiresImage) {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      "a blind vision route must require image input",
    );
  }
}

export interface ReviewVisionInput {
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

export interface ReviewVisionResult {
  readonly logicalCallId: string;
  readonly review: BlindReviewResponse;
  readonly choiceAgreement: BlindChoiceAgreement;
  readonly publicPayload: BlindTextPublicPayload;
  readonly pngHash: string;
  readonly pngByteLength: number;
  readonly proposal: BlindVisionPromptMetadata;
  readonly usage: OpenRouterUsage;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly OpenRouterAttemptResult[];
}

export async function reviewVision(
  input: ReviewVisionInput,
): Promise<ReviewVisionResult> {
  assertInput(input);
  const run = getRun(input.db, input.runId);
  if (run.runKind !== "full" && run.runKind !== "smoke") {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      `blind vision review requires a full or smoke run, received ${run.runKind}`,
    );
  }
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (slot.modality !== "svg") {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      "blind vision review requires an SVG slot",
    );
  }
  if (slot.stage !== "presentation_ready" && slot.stage !== "duplicate_checked") {
    throw new ReviewVisionError(
      "INVALID_STAGE",
      `blind vision review requires presentation_ready or duplicate_checked, received ${slot.stage}`,
    );
  }

  const stage = getStageResult(
    input.db,
    input.runId,
    input.slotId,
    "presentation_ready",
  );
  if (!isRecord(stage.payload) || !("presentation" in stage.payload)) {
    throw new ReviewVisionError(
      "INVALID_STAGE",
      "presentation_ready stage must store the assembled presentation",
    );
  }
  let assembled;
  try {
    assembled = assertAssembledPresentation(stage.payload.presentation);
  } catch (error) {
    const code =
      error instanceof PresentationError && error.code === "MISSING_IMAGE_ASSET"
        ? "MISSING_PNG_ASSET"
        : "INVALID_STAGE";
    throw new ReviewVisionError(
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
    throw new ReviewVisionError(
      "INVALID_STAGE",
      `stored presentation slot ${assembled.visible.slotId} does not match ${input.slotId}`,
    );
  }
  if (
    assembled.visible.family !== slot.family ||
    assembled.visible.modality !== slot.modality
  ) {
    throw new ReviewVisionError(
      "INVALID_STAGE",
      "stored presentation family/modality does not match the slot",
    );
  }
  if (assembled.visible.modality !== "svg") {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      "blind vision review requires an SVG presentation; use the text reviewer for text",
    );
  }
  const pngHash = assembled.visible.assets.pngHash;
  if (pngHash === null) {
    throw new ReviewVisionError(
      "MISSING_PNG_ASSET",
      "SVG presentation has no stored PNG hash",
    );
  }

  let artifact;
  try {
    artifact = getArtifact(input.db, pngHash, "png");
  } catch (error) {
    const code =
      error instanceof StorageError && error.code === "NOT_FOUND"
        ? "PNG_NOT_FOUND"
        : "INVALID_PNG";
    throw new ReviewVisionError(code, `cannot load PNG asset ${pngHash}`, {
      cause: error,
    });
  }
  const pngBytes = artifact.bytes;
  if (pngBytes.length > MAX_PNG_BYTES) {
    throw new ReviewVisionError(
      "PNG_TOO_LARGE",
      `PNG is ${pngBytes.length} bytes; limit is ${MAX_PNG_BYTES}`,
    );
  }
  if (artifact.artifact.mediaType !== "image/png") {
    throw new ReviewVisionError(
      "INVALID_PNG",
      `PNG artifact media type is ${artifact.artifact.mediaType}`,
    );
  }
  if (hashPng(pngBytes) !== pngHash) {
    throw new ReviewVisionError(
      "INVALID_PNG",
      "PNG bytes do not match the stored source hash",
    );
  }
  try {
    assertPngNoTextMetadata(pngBytes);
    assertPngDimensions(pngBytes, SCENE_SIZE, SCENE_SIZE);
  } catch (error) {
    throw new ReviewVisionError("INVALID_PNG", "PNG safety check failed", {
      cause: error,
    });
  }

  let publicPayload: BlindTextPublicPayload;
  try {
    publicPayload = BlindTextPublicPayloadSchema.parse({
      question: assembled.visible.question,
      rules: assembled.visible.rules,
      clues: assembled.visible.clues.map((clue) => clue.text),
      options: assembled.visible.options.map((option) => ({
        label: option.label,
        text: option.text,
      })),
    });
  } catch (error) {
    throw new ReviewVisionError(
      "INVALID_INPUT",
      "cannot build the blind vision allowlisted text payload",
      { cause: error },
    );
  }

  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now();
  const metadata = blindVisionPromptMetadata();
  const messages = buildBlindVisionMessages(publicPayload, metadata, pngBytes);
  const settings: AiRoleSettings | undefined =
    Object.keys(input.route.settings).length > 0
      ? input.route.settings
      : undefined;
  const built = buildChatRequest({
    role: "blind_vision",
    model: input.route.model,
    outputCapField: input.route.outputCapField,
    maxOutputTokens: input.route.maxOutputTokens,
    messages,
    responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    ...(settings === undefined ? {} : { settings }),
  });

  const call = getOrCreateLogicalCall(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    role: "blind_vision",
    runKind: run.runKind,
    requestBody: built.body,
    expectedSchemaHash: metadata.schemaHash,
    model: input.route.model,
    routingPolicy: "balanced",
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
    throw new ReviewVisionError(
      "TRANSPORT_FAILED",
      `blind vision review transport outcome was ${result.outcome}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }
  if (result.parsedContent === null) {
    throw new ReviewVisionError(
      "MISSING_CONTENT",
      "blind vision review response has no parsed JSON content",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  const parsed = BLIND_REVIEW_RESPONSE_SCHEMA.safeParse(result.parsedContent);
  if (!parsed.success) {
    throw new ReviewVisionError(
      "INVALID_REVIEW",
      "blind vision review response does not satisfy the strict review schema",
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
  if (parsed.data.visualLegibility === "not_applicable") {
    throw new ReviewVisionError(
      "INVALID_REVIEW",
      "a visual blind review requires legible or unclear legibility",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: ["visualLegibility: expected legible or unclear"],
      },
    );
  }

  const choiceAgreement: BlindChoiceAgreement =
    parsed.data.answerStatus === "selected"
      ? parsed.data.chosenOption === assembled.reveal.correctLabel
        ? "agreed"
        : "disagreed"
      : "not_applicable";

  recordRequestEvent(input.db, {
    logicalCallId: call.logicalCallId,
    eventType: "blind_vision_review",
    payload: {
      family: assembled.visible.family,
      modality: assembled.visible.modality,
      inputHash: hashCanonicalJson(publicPayload),
      pngHash,
      pngByteLength: pngBytes.length,
      choiceAgreement,
      review: parsed.data,
      ...metadata,
    },
    createdAt: startedAt.toISOString(),
  });

  return {
    logicalCallId: call.logicalCallId,
    review: parsed.data,
    choiceAgreement,
    publicPayload,
    pngHash,
    pngByteLength: pngBytes.length,
    proposal: metadata,
    usage: result.usage,
    actualCostUsd: result.actualCostUsd,
    costStatus: result.costStatus,
    attempts: result.attempts,
  };
}
