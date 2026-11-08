import { readFileSync } from "node:fs";
import type { DesignProposal, DesignProposalSchemaOptions } from "../domain/design.js";
import {
  DESIGNER_SKIN_THEMES,
  DESIGNER_SKIN_THEME_LABELS,
  designerSkinEntityIdsForDifficulty,
} from "../domain/design.js";
import type { DesignProposalSchemaOptions as ProposalSchemaOptions } from "../domain/design.js";
import {
  buildChatRequest,
  type AiRoleSettings,
  type ChatMessage,
  type OutputCapField,
} from "./config.js";
import {
  FAMILY_SPEC_JSON_SCHEMAS,
  designerProposalJsonSchema,
  strictSchemaHash,
  type StrictJsonSchema,
} from "./schemas.js";
import {
  DesignProposalError,
  parseDesignProposal,
  type DesignAssignment,
} from "./design-proposal.js";
import {
  assertRepairProposalIsNew,
  computeDesignRepairInputHash,
  type DesignRepairInput,
} from "../design/feedback.js";
import { designerBoundsBrief } from "../design/bounds.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";

const PROMPT_HEADER = /^PUZZLE_DESIGN_PROMPT_VERSION: (v\d+)\n/;
const PROMPT_SOURCE = readFileSync(
  new URL("./prompts/designer-v1/design-repair.txt", import.meta.url),
  "utf8",
);
const PROMPT_HEADER_MATCH = PROMPT_HEADER.exec(PROMPT_SOURCE);
if (PROMPT_HEADER_MATCH === null || PROMPT_HEADER_MATCH[1] === undefined) {
  throw new Error(
    "designer repair prompt asset must start with PUZZLE_DESIGN_PROMPT_VERSION: vN",
  );
}

export const DESIGN_REPAIR_PROMPT_VERSION = PROMPT_HEADER_MATCH[1];
export const DESIGN_REPAIR_PROMPT = PROMPT_SOURCE.slice(
  PROMPT_HEADER_MATCH[0].length,
).trim();
export const DESIGN_REPAIR_PROMPT_TEMPLATE_HASH = sha256Hex(PROMPT_SOURCE);

export type DesignRepairIndex = 1 | 2;

export interface DesignRepairMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaHash: string;
  readonly repairIndex: DesignRepairIndex;
  readonly repairInputHash: string;
  readonly skinEnabled: boolean;
}

export function designRepairMetadataFor(
  assignment: DesignAssignment,
  repairInput: DesignRepairInput,
  repairIndex: DesignRepairIndex,
  options: DesignProposalSchemaOptions,
): DesignRepairMetadata {
  const schema = designerProposalJsonSchema(
    assignment.family,
    assignment.difficulty,
    options,
  );
  const schemaHash = strictSchemaHash(schema);
  const repairInputHash = computeDesignRepairInputHash(repairInput);
  const promptHash = hashCanonicalJson({
    promptVersion: DESIGN_REPAIR_PROMPT_VERSION,
    promptTemplateHash: DESIGN_REPAIR_PROMPT_TEMPLATE_HASH,
    family: assignment.family,
    difficulty: assignment.difficulty,
    repairIndex,
    repairInputHash,
    skinEnabled: options.skinEnabled,
    schemaName: schema.name,
    schemaHash,
    bounds: designerBoundsBrief(assignment.family, assignment.difficulty),
  });
  return {
    promptVersion: DESIGN_REPAIR_PROMPT_VERSION,
    promptHash,
    schemaName: schema.name,
    schemaHash,
    repairIndex,
    repairInputHash,
    skinEnabled: options.skinEnabled,
  };
}

export function buildDesignRepairMessages(
  assignment: DesignAssignment,
  repairInput: DesignRepairInput,
  metadata: DesignRepairMetadata,
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
    repairInput,
    bounds: designerBoundsBrief(assignment.family, assignment.difficulty),
    dslSchema: FAMILY_SPEC_JSON_SCHEMAS[assignment.family].schema,
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
        DESIGN_REPAIR_PROMPT,
        "",
        "REPAIR METADATA",
        `prompt_version: ${metadata.promptVersion}`,
        `schema_name: ${metadata.schemaName}`,
        `schema_hash: ${metadata.schemaHash}`,
        `repair_index: ${metadata.repairIndex}`,
        `repair_input_hash: ${metadata.repairInputHash}`,
        `skin_enabled: ${String(metadata.skinEnabled)}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

export interface BuildDesignRepairRequestInput {
  readonly assignment: DesignAssignment;
  readonly repairInput: DesignRepairInput;
  readonly repairIndex: DesignRepairIndex;
  readonly model: string;
  readonly outputCapField: OutputCapField;
  readonly maxOutputTokens: number;
  readonly settings?: AiRoleSettings;
  readonly skinEnabled?: boolean;
}

export interface BuiltDesignRepairRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
  readonly schemaHash: string;
  readonly promptHash: string;
  readonly messages: readonly ChatMessage[];
  readonly responseFormat: StrictJsonSchema;
  readonly metadata: DesignRepairMetadata;
}

export function buildDesignRepairRequest(
  input: BuildDesignRepairRequestInput,
): BuiltDesignRepairRequest {
  if (input.repairIndex !== 1 && input.repairIndex !== 2) {
    throw new DesignProposalError(
      "INVALID_INPUT",
      `repair index must be 1 or 2, received ${String(input.repairIndex)}`,
    );
  }
  const options: ProposalSchemaOptions = {
    skinEnabled: input.skinEnabled ?? true,
  };
  const metadata = designRepairMetadataFor(
    input.assignment,
    input.repairInput,
    input.repairIndex,
    options,
  );
  const responseFormat = designerProposalJsonSchema(
    input.assignment.family,
    input.assignment.difficulty,
    options,
  );
  const messages = buildDesignRepairMessages(
    input.assignment,
    input.repairInput,
    metadata,
    options,
  );
  const role = input.repairIndex === 1 ? "design_repair_1" : "design_repair_2";
  const built = buildChatRequest({
    role,
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

export function parseDesignRepairProposal(
  input: unknown,
  assignment: DesignAssignment,
  previousProposal: DesignProposal | null,
  options: DesignProposalSchemaOptions = { skinEnabled: true },
): DesignProposal {
  const proposal = parseDesignProposal(input, assignment, options);
  assertRepairProposalIsNew(previousProposal, proposal);
  return proposal;
}
