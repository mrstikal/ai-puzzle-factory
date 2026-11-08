import { readFileSync } from "node:fs";
import type { ZodError } from "zod";
import {
  DESIGNER_SKIN_THEMES,
  DESIGNER_SKIN_THEME_LABELS,
  DesignerSkinError,
  designProposalSchemaFor,
  designerSkinEntityIdsForDifficulty,
  validatePresentationSkin,
  type DesignProposal,
  type DesignProposalSchemaOptions,
  type DesignerArm,
} from "../domain/design.js";
import { FAMILIES, type Difficulty, type Family } from "../domain/experiment.js";
import {
  DesignerBoundsError,
  assertDesignerBounds,
  designerBoundsBrief,
} from "../design/bounds.js";
import {
  TruthRpnParseError,
  truthRpnSpecToCanonical,
} from "../families/truth/schema.js";
import {
  buildChatRequest,
  type AiRoleSettings,
  type ChatMessage,
  type OutputCapField,
} from "./config.js";
import {
  designerFamilySpecJsonSchema,
  designerProposalJsonSchema,
  strictSchemaHash,
  type StrictJsonSchema,
} from "./schemas.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";

const PROMPT_HEADER = /^PUZZLE_DESIGN_PROMPT_VERSION: (v\d+)\n/;
const PROMPT_SOURCE = readFileSync(
  new URL("./prompts/designer-v1/design.txt", import.meta.url),
  "utf8",
);
const PROMPT_HEADER_MATCH = PROMPT_HEADER.exec(PROMPT_SOURCE);
if (PROMPT_HEADER_MATCH === null || PROMPT_HEADER_MATCH[1] === undefined) {
  throw new Error(
    "designer prompt asset must start with PUZZLE_DESIGN_PROMPT_VERSION: vN",
  );
}

export const DESIGN_PROMPT_VERSION = PROMPT_HEADER_MATCH[1];
export const DESIGN_PROMPT = PROMPT_SOURCE.slice(
  PROMPT_HEADER_MATCH[0].length,
).trim();
export const DESIGN_PROMPT_TEMPLATE_HASH = sha256Hex(PROMPT_SOURCE);

export interface DesignAssignment {
  readonly assignmentId: string;
  readonly family: Family;
  readonly difficulty: Difficulty;
}

export interface DesignProposalMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaHash: string;
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly skinEnabled: boolean;
}

export type DesignProposalErrorCode =
  | "INVALID_INPUT"
  | "PROMPT_ASSET_INVALID"
  | "SCHEMA_INVALID"
  | "WRONG_FAMILY"
  | "WRONG_DIFFICULTY"
  | "OUT_OF_BOUNDS"
  | "FORBIDDEN_CONTENT"
  | "SKIN_INVALID"
  | "UNSUPPORTED_SCHEMA";

export class DesignProposalError extends Error {
  readonly code: DesignProposalErrorCode;
  readonly issues: readonly string[];

  constructor(
    code: DesignProposalErrorCode,
    message: string,
    issues: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignProposalError";
    this.code = code;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatZodIssues(error: ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path =
      issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".");
    return `${path}: ${issue.message}`;
  });
}

export function designProposalMetadataFor(
  family: Family,
  difficulty: Difficulty,
  options: DesignProposalSchemaOptions,
): DesignProposalMetadata {
  const schema = designerProposalJsonSchema(family, difficulty, options);
  const schemaHash = strictSchemaHash(schema);
  const bounds = designerBoundsBrief(family, difficulty);
  const promptHash = hashCanonicalJson({
    promptVersion: DESIGN_PROMPT_VERSION,
    promptTemplateHash: DESIGN_PROMPT_TEMPLATE_HASH,
    family,
    difficulty,
    skinEnabled: options.skinEnabled,
    schemaName: schema.name,
    schemaHash,
    bounds,
  });
  return {
    promptVersion: DESIGN_PROMPT_VERSION,
    promptHash,
    schemaName: schema.name,
    schemaHash,
    family,
    difficulty,
    skinEnabled: options.skinEnabled,
  };
}

export function buildDesignProposalMessages(
  assignment: DesignAssignment,
  metadata: DesignProposalMetadata,
  options: DesignProposalSchemaOptions,
): readonly ChatMessage[] {
  const schema = designerProposalJsonSchema(
    assignment.family,
    assignment.difficulty,
    options,
  );
  const skinEntityIds = designerSkinEntityIdsForDifficulty(
    assignment.family,
    assignment.difficulty,
  );
  const payload = {
    assignment: {
      assignmentId: assignment.assignmentId,
      family: assignment.family,
      difficulty: assignment.difficulty,
    },
    bounds: designerBoundsBrief(assignment.family, assignment.difficulty),
    dslSchema: designerFamilySpecJsonSchema(assignment.family).schema,
    responseSchema: schema.schema,
    skinCatalog: options.skinEnabled
      ? {
          themes: DESIGNER_SKIN_THEMES,
          entityIds: skinEntityIds,
          labelsByTheme: DESIGNER_SKIN_THEME_LABELS,
          maxLabels: skinEntityIds.length,
        }
      : null,
  };
  return [
    {
      role: "system",
      content: [
        DESIGN_PROMPT,
        "",
        "PROPOSAL METADATA",
        `prompt_version: ${metadata.promptVersion}`,
        `schema_name: ${metadata.schemaName}`,
        `schema_hash: ${metadata.schemaHash}`,
        `family: ${metadata.family}`,
        `difficulty: ${metadata.difficulty}`,
        `skin_enabled: ${String(metadata.skinEnabled)}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

export interface BuildDesignProposalRequestInput {
  readonly assignment: DesignAssignment;
  readonly model: string;
  readonly outputCapField: OutputCapField;
  readonly maxOutputTokens: number;
  readonly settings?: AiRoleSettings;
  readonly skinEnabled?: boolean;
}

export interface BuiltDesignProposalRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
  readonly schemaHash: string;
  readonly promptHash: string;
  readonly messages: readonly ChatMessage[];
  readonly responseFormat: StrictJsonSchema;
  readonly metadata: DesignProposalMetadata;
}

export function buildDesignProposalRequest(
  input: BuildDesignProposalRequestInput,
): BuiltDesignProposalRequest {
  const options: DesignProposalSchemaOptions = {
    skinEnabled: input.skinEnabled ?? true,
  };
  const metadata = designProposalMetadataFor(
    input.assignment.family,
    input.assignment.difficulty,
    options,
  );
  const responseFormat = designerProposalJsonSchema(
    input.assignment.family,
    input.assignment.difficulty,
    options,
  );
  const messages = buildDesignProposalMessages(
    input.assignment,
    metadata,
    options,
  );
  const built = buildChatRequest({
    role: "design",
    model: input.model,
    outputCapField: input.outputCapField,
    maxOutputTokens: input.maxOutputTokens,
    messages,
    responseFormat,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
  });
  return {
    body: built.body,
    requestHash: hashCanonicalJson(built.body),
    schemaHash: built.schemaHash,
    promptHash: metadata.promptHash,
    messages,
    responseFormat,
    metadata,
  };
}

export function buildDesignProposalRequestForArm(
  input: BuildDesignProposalRequestInput & {
    readonly arm: Extract<DesignerArm, "ai_one_shot" | "ai_feedback">;
  },
): BuiltDesignProposalRequest {
  return buildDesignProposalRequest(input);
}

const FORBIDDEN_TEXT_PATTERNS = [
  /<[A-Za-z!/?]/,
  /\/>/,
  /```/,
  /\bjavascript:/i,
  /\bdata:/i,
  /https?:\/\//i,
  /<\?/,
  /<!DOCTYPE/i,
];

function collectStrings(
  value: unknown,
  path: string,
  output: Array<{ readonly path: string; readonly value: string }>,
): void {
  if (typeof value === "string") {
    output.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectStrings(item, `${path}[${index}]`, output);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, `${path}.${key}`, output);
    }
  }
}

function assertNoForbiddenProposalContent(proposal: DesignProposal): void {
  const strings: Array<{ readonly path: string; readonly value: string }> = [];
  collectStrings(proposal, "proposal", strings);
  const issues = strings
    .filter((entry) =>
      FORBIDDEN_TEXT_PATTERNS.some((pattern) => pattern.test(entry.value)),
    )
    .map(
      (entry) =>
        `${entry.path}: string contains markup, a URL, or code-like text`,
    );
  if (issues.length > 0) {
    throw new DesignProposalError(
      "FORBIDDEN_CONTENT",
      "design proposal contains markup, a URL, or code-like text",
      issues,
    );
  }
}

export function parseDesignProposal(
  input: unknown,
  assignment: DesignAssignment,
  options: DesignProposalSchemaOptions = { skinEnabled: true },
): DesignProposal {
  if (!isRecord(input)) {
    throw new DesignProposalError(
      "SCHEMA_INVALID",
      "design proposal must be a JSON object",
    );
  }
  const family = input.family;
  if (
    typeof family !== "string" ||
    !(FAMILIES as readonly string[]).includes(family)
  ) {
    throw new DesignProposalError(
      "SCHEMA_INVALID",
      "design proposal family is not a declared family",
    );
  }
  if (family !== assignment.family) {
    throw new DesignProposalError(
      "WRONG_FAMILY",
      `expected family ${assignment.family}, received ${family}`,
    );
  }
  const difficulty = input.difficulty;
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new DesignProposalError(
      "SCHEMA_INVALID",
      "design proposal difficulty must be 1, 2, or 3",
    );
  }
  if (difficulty !== assignment.difficulty) {
    throw new DesignProposalError(
      "WRONG_DIFFICULTY",
      `expected difficulty ${assignment.difficulty}, received ${difficulty}`,
    );
  }
  const parsed = designProposalSchemaFor(
    assignment.family,
    assignment.difficulty,
    options,
  ).safeParse(input);
  if (!parsed.success) {
    throw new DesignProposalError(
      "SCHEMA_INVALID",
      "design proposal does not satisfy the selected-family strict schema",
      formatZodIssues(parsed.error),
      { cause: parsed.error },
    );
  }
  let proposal = parsed.data;
  if (assignment.family === "truth") {
    try {
      proposal = {
        ...proposal,
        spec: truthRpnSpecToCanonical(proposal.spec),
      } as DesignProposal;
    } catch (error) {
      if (error instanceof TruthRpnParseError) {
        throw new DesignProposalError(
          "SCHEMA_INVALID",
          error.message,
          error.issues,
          { cause: error },
        );
      }
      throw error;
    }
  }
  assertNoForbiddenProposalContent(proposal);
  try {
    assertDesignerBounds(
      proposal.family,
      proposal.difficulty,
      proposal.spec,
    );
  } catch (error) {
    if (error instanceof DesignerBoundsError) {
      throw new DesignProposalError(
        "OUT_OF_BOUNDS",
        error.message,
        error.issues.map((issue) => `${issue.path}: ${issue.message}`),
        { cause: error },
      );
    }
    throw error;
  }
  try {
    validatePresentationSkin(
      proposal.family,
      proposal.spec,
      proposal.presentationSkin,
    );
  } catch (error) {
    if (error instanceof DesignerSkinError) {
      throw new DesignProposalError(
        "SKIN_INVALID",
        error.message,
        error.issues.map((issue) => `${issue.entityId}: ${issue.message}`),
        { cause: error },
      );
    }
    throw error;
  }
  return proposal;
}
