import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  buildChatRequest,
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
import { ChoiceLabelSchema } from "../domain/answers.js";
import { VisibleRulesSchema } from "../families/contracts.js";
import { getRun, getSlot, getStageResult } from "../storage/repository.js";
import {
  PresentationError,
  assertAssembledPresentation,
} from "../validation/presentation.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";

export const BLIND_TEXT_PROMPT_VERSION = "v1";
export const BLIND_TEXT_SCHEMA_VERSION = "v1";

const BLIND_TEXT_PROMPT_HEADER = /^PUZZLE_BLIND_TEXT_PROMPT_VERSION: (v\d+)\n/;

export interface BlindTextPromptMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly schemaHash: string;
}

export const BlindTextPublicPayloadSchema = z.strictObject({
  question: z.string().min(1).max(400),
  rules: VisibleRulesSchema,
  clues: z.array(z.string().min(1).max(200)).max(12),
  options: z
    .array(
      z.strictObject({
        label: ChoiceLabelSchema,
        text: z.string().min(1).max(300),
      }),
    )
    .length(4),
});

export type BlindTextPublicPayload = z.infer<typeof BlindTextPublicPayloadSchema>;

export type BlindChoiceAgreement =
  | "agreed"
  | "disagreed"
  | "not_applicable";

export type ReviewTextErrorCode =
  | "INVALID_INPUT"
  | "ROUTE_ROLE_MISMATCH"
  | "INVALID_STAGE"
  | "PROMPT_ASSET_INVALID"
  | "TRANSPORT_FAILED"
  | "MISSING_CONTENT"
  | "INVALID_REVIEW";

export interface ReviewTextErrorOptions {
  readonly logicalCallId?: string | null;
  readonly attemptIds?: readonly string[];
  readonly result?: OpenRouterCallResult | null;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
}

export class ReviewTextError extends Error {
  readonly code: ReviewTextErrorCode;
  readonly logicalCallId: string | null;
  readonly attemptIds: readonly string[];
  readonly result: OpenRouterCallResult | null;
  readonly issues: readonly string[];

  constructor(
    code: ReviewTextErrorCode,
    message: string,
    options: ReviewTextErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ReviewTextError";
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
    throw new ReviewTextError(
      "PROMPT_ASSET_INVALID",
      `cannot read prompt asset ${relativePath}`,
      { cause: error },
    );
  }
}

const BLIND_TEXT_PROMPT = readPromptAsset("./prompts/v1/blind-text.txt");
const PROMPT_HEADER = BLIND_TEXT_PROMPT_HEADER.exec(BLIND_TEXT_PROMPT);
if (PROMPT_HEADER?.[1] !== BLIND_TEXT_PROMPT_VERSION) {
  throw new ReviewTextError(
    "PROMPT_ASSET_INVALID",
    `blind-text prompt header must declare ${BLIND_TEXT_PROMPT_VERSION}`,
  );
}
const BLIND_TEXT_PROMPT_TEMPLATE_HASH = sha256Hex(BLIND_TEXT_PROMPT);

export function blindTextPromptMetadata(): BlindTextPromptMetadata {
  const schemaHash = strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA);
  const promptHash = hashCanonicalJson({
    promptVersion: BLIND_TEXT_PROMPT_VERSION,
    promptTemplateHash: BLIND_TEXT_PROMPT_TEMPLATE_HASH,
    schemaName: BLIND_REVIEW_JSON_SCHEMA.name,
    schemaVersion: BLIND_TEXT_SCHEMA_VERSION,
    schemaHash,
  });
  return {
    promptVersion: BLIND_TEXT_PROMPT_VERSION,
    promptHash,
    schemaName: BLIND_REVIEW_JSON_SCHEMA.name,
    schemaVersion: BLIND_TEXT_SCHEMA_VERSION,
    schemaHash,
  };
}

export function buildBlindTextMessages(
  payload: BlindTextPublicPayload,
  metadata: BlindTextPromptMetadata,
): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        BLIND_TEXT_PROMPT.trim(),
        "",
        "BLIND TEXT METADATA",
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
        "Public puzzle:",
        JSON.stringify(payload, null, 2),
        "",
        "Return exactly one JSON object matching the strict schema.",
      ].join("\n"),
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

function assertInput(input: ReviewTextInput): void {
  if (input.apiKey.trim() === "") {
    throw new ReviewTextError(
      "INVALID_INPUT",
      "an inference key is required for blind text review",
    );
  }
  if (!positiveUsd(input.reservationUsd)) {
    throw new ReviewTextError(
      "INVALID_INPUT",
      "reservationUsd must be a positive decimal USD string",
    );
  }
  if (input.route.role !== "blind_text") {
    throw new ReviewTextError(
      "ROUTE_ROLE_MISMATCH",
      `blind text review requires a resolved blind_text route, received ${input.route.role}`,
    );
  }
  if (input.route.requiresImage) {
    throw new ReviewTextError(
      "INVALID_INPUT",
      "a blind text route must not require an image",
    );
  }
}

export interface ReviewTextInput {
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

export interface ReviewTextResult {
  readonly logicalCallId: string;
  readonly review: BlindReviewResponse;
  readonly choiceAgreement: BlindChoiceAgreement;
  readonly publicPayload: BlindTextPublicPayload;
  readonly proposal: BlindTextPromptMetadata;
  readonly usage: OpenRouterUsage;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly OpenRouterAttemptResult[];
}

export async function reviewText(
  input: ReviewTextInput,
): Promise<ReviewTextResult> {
  assertInput(input);
  const run = getRun(input.db, input.runId);
  if (run.runKind !== "full" && run.runKind !== "smoke") {
    throw new ReviewTextError(
      "INVALID_INPUT",
      `blind text review requires a full or smoke run, received ${run.runKind}`,
    );
  }
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (slot.stage !== "presentation_ready" && slot.stage !== "duplicate_checked") {
    throw new ReviewTextError(
      "INVALID_STAGE",
      `blind text review requires presentation_ready or duplicate_checked, received ${slot.stage}`,
    );
  }

  const stage = getStageResult(
    input.db,
    input.runId,
    input.slotId,
    "presentation_ready",
  );
  if (!isRecord(stage.payload) || !("presentation" in stage.payload)) {
    throw new ReviewTextError(
      "INVALID_STAGE",
      "presentation_ready stage must store the assembled presentation",
    );
  }
  let assembled;
  try {
    assembled = assertAssembledPresentation(stage.payload.presentation);
  } catch (error) {
    throw new ReviewTextError(
      "INVALID_STAGE",
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
    throw new ReviewTextError(
      "INVALID_STAGE",
      `stored presentation slot ${assembled.visible.slotId} does not match ${input.slotId}`,
    );
  }
  if (
    assembled.visible.family !== slot.family ||
    assembled.visible.modality !== slot.modality
  ) {
    throw new ReviewTextError(
      "INVALID_STAGE",
      "stored presentation family/modality does not match the slot",
    );
  }
  if (assembled.visible.modality !== "text") {
    throw new ReviewTextError(
      "INVALID_INPUT",
      "blind text review requires a text presentation; use the vision reviewer for SVG",
    );
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
    throw new ReviewTextError(
      "INVALID_INPUT",
      "cannot build the blind text allowlisted payload",
      { cause: error },
    );
  }

  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now();
  const metadata = blindTextPromptMetadata();
  const messages = buildBlindTextMessages(publicPayload, metadata);
  const settings: AiRoleSettings | undefined =
    Object.keys(input.route.settings).length > 0
      ? input.route.settings
      : undefined;
  const built = buildChatRequest({
    role: "blind_text",
    model: input.route.model,
    providerTag: input.route.providerTag,
    outputCapField: input.route.outputCapField,
    maxOutputTokens: input.route.maxOutputTokens,
    messages,
    responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    ...(settings === undefined ? {} : { settings }),
  });

  const call = getOrCreateLogicalCall(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    role: "blind_text",
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
    throw new ReviewTextError(
      "TRANSPORT_FAILED",
      `blind text review transport outcome was ${result.outcome}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }
  if (result.parsedContent === null) {
    throw new ReviewTextError(
      "MISSING_CONTENT",
      "blind text review response has no parsed JSON content",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  const parsed = BLIND_REVIEW_RESPONSE_SCHEMA.safeParse(result.parsedContent);
  if (!parsed.success) {
    throw new ReviewTextError(
      "INVALID_REVIEW",
      "blind text review response does not satisfy the strict review schema",
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
  if (parsed.data.visualLegibility !== "not_applicable") {
    throw new ReviewTextError(
      "INVALID_REVIEW",
      "a text-only blind review requires visualLegibility not_applicable",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: [
          `visualLegibility: expected not_applicable, received ${parsed.data.visualLegibility}`,
        ],
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
    eventType: "blind_text_review",
    payload: {
      family: assembled.visible.family,
      modality: assembled.visible.modality,
      inputHash: hashCanonicalJson(publicPayload),
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
    proposal: metadata,
    usage: result.usage,
    actualCostUsd: result.actualCostUsd,
    costStatus: result.costStatus,
    attempts: result.attempts,
  };
}
