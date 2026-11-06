import { z } from "zod";
import { REQUEST_ROLES, type RequestRole } from "../domain/experiment.js";
import {
  STRICT_SCHEMA_NAME_PATTERN,
  strictSchemaHash,
  type StrictJsonSchema,
} from "./schemas.js";

export const DEFAULT_REQUEST_DEADLINE_MS = 90_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_TEXT_BYTES = 65_536;
export const MAX_PNG_BYTES = 1_048_576;
export const MAX_STORED_REQUEST_BYTES = 2_097_152;

export const DEFAULT_MAX_OUTPUT_TOKENS = {
  spec: 8192,
  wording: 8192,
  blind_text: 4096,
  blind_vision: 4096,
  alignment_text: 4096,
  alignment_vision: 4096,
} as const satisfies Readonly<Record<RequestRole, number>>;

export const OUTPUT_CAP_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
] as const;
export type OutputCapField = (typeof OUTPUT_CAP_FIELDS)[number];
export const OutputCapFieldSchema = z.enum(OUTPUT_CAP_FIELDS);

export const MODEL_ROLE_KINDS = [
  "generator",
  "reviewer",
  "vision_reviewer",
] as const;
export type ModelRoleKind = (typeof MODEL_ROLE_KINDS)[number];

export const ROLE_TO_MODEL_ROLE: Readonly<Record<RequestRole, ModelRoleKind>> = {
  spec: "generator",
  wording: "generator",
  blind_text: "reviewer",
  alignment_text: "reviewer",
  blind_vision: "vision_reviewer",
  alignment_vision: "vision_reviewer",
};

export const LIVE_ENV_KEYS = {
  apiKey: "OPENROUTER_API_KEY",
  generatorModel: "GENERATOR_MODEL",
  reviewerModel: "REVIEWER_MODEL",
  visionReviewerModel: "VISION_REVIEWER_MODEL",
} as const;

export const BALANCED_ROUTING_POLICY = {
  allow_fallbacks: true,
  require_parameters: true,
} as const;

export type AiConfigErrorCode =
  | "MISSING_INFERENCE_KEY"
  | "MISSING_MODEL"
  | "INVALID_ENV_VALUE"
  | "ROLE_SEPARATION_VIOLATION"
  | "UNSUPPORTED_SETTING"
  | "INVALID_OUTPUT_CAP"
  | "INVALID_REQUEST";

export class AiConfigError extends Error {
  readonly code: AiConfigErrorCode;
  readonly field: string | null;

  constructor(
    code: AiConfigErrorCode,
    message: string,
    field: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiConfigError";
    this.code = code;
    this.field = field;
  }
}

export interface LiveModelConfig {
  readonly model: string;
}

export interface LiveEnvironmentConfig {
  readonly apiKey: string;
  readonly generator: LiveModelConfig;
  readonly reviewer: LiveModelConfig;
  readonly visionReviewer: LiveModelConfig;
  readonly correlations: readonly string[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function requiredValue(
  env: NodeJS.ProcessEnv,
  key: string,
  code: "MISSING_INFERENCE_KEY" | "MISSING_MODEL",
): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new AiConfigError(code, `${key} must be set and non-empty`, key);
  }
  return value.trim();
}

function identifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value) || value.includes("*")) {
    throw new AiConfigError(
      "INVALID_ENV_VALUE",
      `${field} must be an exact model identifier without wildcards`,
      field,
    );
  }
  return value;
}

export function readLiveEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): LiveEnvironmentConfig {
  const apiKey = requiredValue(env, LIVE_ENV_KEYS.apiKey, "MISSING_INFERENCE_KEY");
  const generator: LiveModelConfig = {
    model: identifier(
      requiredValue(env, LIVE_ENV_KEYS.generatorModel, "MISSING_MODEL"),
      LIVE_ENV_KEYS.generatorModel,
    ),
  };
  const reviewer: LiveModelConfig = {
    model: identifier(
      requiredValue(env, LIVE_ENV_KEYS.reviewerModel, "MISSING_MODEL"),
      LIVE_ENV_KEYS.reviewerModel,
    ),
  };
  const visionReviewer: LiveModelConfig = {
    model: identifier(
      requiredValue(env, LIVE_ENV_KEYS.visionReviewerModel, "MISSING_MODEL"),
      LIVE_ENV_KEYS.visionReviewerModel,
    ),
  };

  if (generator.model === reviewer.model) {
    throw new AiConfigError(
      "ROLE_SEPARATION_VIOLATION",
      "GENERATOR_MODEL must differ from REVIEWER_MODEL",
      LIVE_ENV_KEYS.reviewerModel,
    );
  }
  if (generator.model === visionReviewer.model) {
    throw new AiConfigError(
      "ROLE_SEPARATION_VIOLATION",
      "GENERATOR_MODEL must differ from VISION_REVIEWER_MODEL",
      LIVE_ENV_KEYS.visionReviewerModel,
    );
  }

  const correlations: string[] = [];
  if (visionReviewer.model === reviewer.model) {
    correlations.push("vision_reviewer_uses_text_reviewer_model");
  }
  const authorOf = (model: string): string => model.split("/")[0] ?? model;
  if (authorOf(generator.model) === authorOf(reviewer.model)) {
    correlations.push("generator_and_text_reviewer_share_model_author");
  }
  if (authorOf(generator.model) === authorOf(visionReviewer.model)) {
    correlations.push("generator_and_vision_reviewer_share_model_author");
  }
  if (authorOf(reviewer.model) === authorOf(visionReviewer.model)) {
    correlations.push("text_and_vision_reviewers_share_model_author");
  }

  return {
    apiKey,
    generator,
    reviewer,
    visionReviewer,
    correlations,
  };
}

export function modelConfigForRole(
  role: RequestRole,
  config: LiveEnvironmentConfig,
): LiveModelConfig {
  switch (ROLE_TO_MODEL_ROLE[role]) {
    case "generator":
      return config.generator;
    case "reviewer":
      return config.reviewer;
    case "vision_reviewer":
      return config.visionReviewer;
  }
}

export function defaultMaxOutputTokensFor(role: RequestRole): number {
  return DEFAULT_MAX_OUTPUT_TOKENS[role];
}

export function requiresImageForRole(role: RequestRole): boolean {
  return role === "blind_vision" || role === "alignment_vision";
}

export const AiRoleSettingsSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  reasoning: z.boolean().optional(),
});
export type AiRoleSettings = z.infer<typeof AiRoleSettingsSchema>;

export const SETTING_SUPPORT_PARAMETER = {
  temperature: "temperature",
  seed: "seed",
  reasoning: "reasoning",
} as const satisfies Readonly<Record<keyof AiRoleSettings, string>>;

export type ChatContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: { readonly url: string };
    };

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly ChatContentPart[];
}

export interface BuildChatRequestInput {
  readonly role: RequestRole;
  readonly model: string;
  readonly outputCapField: OutputCapField;
  readonly maxOutputTokens: number;
  readonly messages: readonly ChatMessage[];
  readonly responseFormat: StrictJsonSchema;
  readonly settings?: AiRoleSettings;
}

export interface BuiltChatRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly outputCapField: OutputCapField;
  readonly schemaHash: string;
}

function assertIdentifier(value: string, field: string): string {
  if (value.trim() === "" || !IDENTIFIER_PATTERN.test(value) || value.includes("*")) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      `${field} must be a non-empty exact identifier without wildcards`,
      field,
    );
  }
  if (value.endsWith(":nitro") || value.endsWith(":floor")) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      `${field} must use Balanced routing without a :nitro or :floor suffix`,
      field,
    );
  }
  return value;
}

function assertMessages(messages: readonly ChatMessage[]): void {
  if (messages.length === 0) {
    throw new AiConfigError("INVALID_REQUEST", "at least one chat message is required");
  }
  for (const message of messages) {
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant"
    ) {
      throw new AiConfigError("INVALID_REQUEST", "unknown chat message role");
    }
    if (typeof message.content === "string") {
      if (message.content.length === 0) {
        throw new AiConfigError("INVALID_REQUEST", "chat message content is empty");
      }
      continue;
    }
    if (message.content.length === 0) {
      throw new AiConfigError("INVALID_REQUEST", "chat message content is empty");
    }
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.length === 0) {
          throw new AiConfigError("INVALID_REQUEST", "text part is empty");
        }
      } else if (part.type === "image_url") {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(part.image_url.url)) {
          throw new AiConfigError(
            "INVALID_REQUEST",
            "image_url must be a PNG data URL",
          );
        }
      } else {
        throw new AiConfigError("INVALID_REQUEST", "unknown chat content part");
      }
    }
  }
}

export function assertExactlyOneOutputCap(
  body: Readonly<Record<string, unknown>>,
): OutputCapField {
  const present = OUTPUT_CAP_FIELDS.filter((field) => field in body);
  if (present.length !== 1) {
    throw new AiConfigError(
      "INVALID_OUTPUT_CAP",
      "exactly one of max_tokens or max_completion_tokens is required",
    );
  }
  const field = present[0];
  if (field === undefined) {
    throw new AiConfigError(
      "INVALID_OUTPUT_CAP",
      "exactly one of max_tokens or max_completion_tokens is required",
    );
  }
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AiConfigError(
      "INVALID_OUTPUT_CAP",
      `${field} must be a positive integer`,
      field,
    );
  }
  return field;
}

export function assertNoForbiddenRequestFields(
  body: Readonly<Record<string, unknown>>,
): void {
  for (const field of ["models", "tools", "plugins", "route"]) {
    if (field in body) {
      throw new AiConfigError(
        "INVALID_REQUEST",
        `${field} is forbidden in an OpenRouter request`,
        field,
      );
    }
  }
  const provider = body.provider;
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      "provider must contain the Balanced routing policy",
      "provider",
    );
  }
  const record = provider as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "allow_fallbacks" ||
    keys[1] !== "require_parameters" ||
    record.allow_fallbacks !== true ||
    record.require_parameters !== true
  ) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      "provider must be exactly {allow_fallbacks:true,require_parameters:true} with no sort/order/only/ignore selectors",
      "provider",
    );
  }
}

export function buildChatRequest(input: BuildChatRequestInput): BuiltChatRequest {
  const model = assertIdentifier(input.model, "model");
  if (!REQUEST_ROLES.includes(input.role)) {
    throw new AiConfigError("INVALID_REQUEST", `unknown role ${String(input.role)}`);
  }
  if (!OUTPUT_CAP_FIELDS.includes(input.outputCapField)) {
    throw new AiConfigError(
      "INVALID_OUTPUT_CAP",
      `unsupported output cap field ${String(input.outputCapField)}`,
    );
  }
  if (
    !Number.isInteger(input.maxOutputTokens) ||
    input.maxOutputTokens <= 0
  ) {
    throw new AiConfigError(
      "INVALID_OUTPUT_CAP",
      "maxOutputTokens must be a positive integer",
    );
  }
  if (input.responseFormat.strict !== true) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      "response format must be strict",
    );
  }
  if (!STRICT_SCHEMA_NAME_PATTERN.test(input.responseFormat.name)) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      "response format name is not provider-compatible",
    );
  }
  assertMessages(input.messages);
  const imageParts = input.messages.reduce((count, message) => {
    if (typeof message.content === "string") {
      return count;
    }
    return (
      count +
      message.content.filter((part) => part.type === "image_url").length
    );
  }, 0);
  if (requiresImageForRole(input.role) && imageParts === 0) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      "a vision role requires at least one PNG image part",
      "messages",
    );
  }
  if (!requiresImageForRole(input.role) && imageParts > 0) {
    throw new AiConfigError(
      "INVALID_REQUEST",
      "a text role must not include image parts",
      "messages",
    );
  }

  let settings: AiRoleSettings | undefined;
  if (input.settings !== undefined) {
    const parsed = AiRoleSettingsSchema.safeParse(input.settings);
    if (!parsed.success) {
      throw new AiConfigError(
        "UNSUPPORTED_SETTING",
        "role settings do not satisfy the supported setting schema",
        null,
        { cause: parsed.error },
      );
    }
    settings = parsed.data;
  }

  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: input.responseFormat.name,
        strict: true,
        schema: input.responseFormat.schema,
      },
    },
    provider: { ...BALANCED_ROUTING_POLICY },
    [input.outputCapField]: input.maxOutputTokens,
  };
  if (settings?.temperature !== undefined) {
    body.temperature = settings.temperature;
  }
  if (settings?.seed !== undefined) {
    body.seed = settings.seed;
  }
  if (settings?.reasoning !== undefined) {
    body.reasoning = settings.reasoning;
  }

  assertExactlyOneOutputCap(body);
  assertNoForbiddenRequestFields(body);
  return {
    body,
    outputCapField: input.outputCapField,
    schemaHash: strictSchemaHash(input.responseFormat),
  };
}
