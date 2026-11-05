import { z } from "zod";
import { FAMILIES, type Family, type Modality } from "../domain/experiment.js";
import { WordingResponseSchema } from "../domain/presentation.js";
import { FAMILY_SPEC_SCHEMAS } from "../domain/spec.js";
import { FactIdSchema } from "../families/contracts.js";
import { hashCanonicalJson } from "../util/hash.js";

export const STRICT_SCHEMA_DIALECT = "draft-7" as const;
export const STRICT_SCHEMA_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface StrictJsonSchema {
  readonly name: string;
  readonly strict: true;
  readonly schema: Readonly<Record<string, unknown>>;
}

export type StrictSchemaErrorCode =
  | "INVALID_SCHEMA_NAME"
  | "UNREPRESENTABLE_SCHEMA"
  | "UNSUPPORTED_SCHEMA_KEYWORD"
  | "INVALID_OBJECT_SCHEMA"
  | "INVALID_REF"
  | "INVALID_DEFINITIONS";

export class StrictSchemaError extends Error {
  readonly code: StrictSchemaErrorCode;

  constructor(code: StrictSchemaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StrictSchemaError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

const FORBIDDEN_SCHEMA_KEYWORDS = new Set([
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
  "additionalItems",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "if",
  "maxContains",
  "minContains",
  "multipleOf",
  "not",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function normalizeDefinitions(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new StrictSchemaError(
      "INVALID_DEFINITIONS",
      `${path} definitions must be an object`,
    );
  }
  const definitions: JsonObject = {};
  for (const [name, schema] of Object.entries(value)) {
    definitions[name] = normalizeNode(schema, `${path}.$defs.${name}`);
  }
  return definitions;
}

function normalizeProperties(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new StrictSchemaError(
      "INVALID_OBJECT_SCHEMA",
      `${path} properties must be an object`,
    );
  }
  const properties: JsonObject = {};
  for (const [name, schema] of Object.entries(value)) {
    properties[name] = normalizeNode(schema, `${path}.properties.${name}`);
  }
  return properties;
}

function normalizeNode(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeNode(item, `${path}[${index}]`));
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const output: JsonObject = {};
  let requiredValue: unknown;
  let hasAdditionalProperties = false;

  for (const [key, child] of Object.entries(value)) {
    switch (key) {
      case "$schema":
      case "$id":
      case "$comment":
      case "title":
      case "default":
      case "examples":
      case "readOnly":
      case "writeOnly":
      case "deprecated":
        break;
      case "definitions":
      case "$defs":
        output.$defs = normalizeDefinitions(child, path);
        break;
      case "$ref":
        if (typeof child !== "string") {
          throw new StrictSchemaError(
            "INVALID_REF",
            `${path} $ref must be a string`,
          );
        }
        output.$ref = child.replace(/^#\/definitions\//, "#/$defs/");
        break;
      case "oneOf":
        output.anyOf = normalizeBranchList(child, `${path}.oneOf`);
        break;
      case "anyOf":
        output.anyOf = normalizeBranchList(child, `${path}.anyOf`);
        break;
      case "allOf":
        output.allOf = normalizeBranchList(child, `${path}.allOf`);
        break;
      case "const":
        output.enum = [child];
        break;
      case "type":
        if (Array.isArray(child)) {
          if (!child.every((item) => typeof item === "string")) {
            throw new StrictSchemaError(
              "UNSUPPORTED_SCHEMA_KEYWORD",
              `${path} type array must contain only strings`,
            );
          }
          output.anyOf = child.map((item) => ({ type: item }));
        } else {
          output.type = child;
        }
        break;
      case "items":
        if (Array.isArray(child)) {
          output.items = {
            anyOf: child.map((item, index) =>
              normalizeNode(item, `${path}.items[${index}]`),
            ),
          };
          output.minItems ??= child.length;
          output.maxItems ??= child.length;
        } else {
          output.items = normalizeNode(child, `${path}.items`);
        }
        break;
      case "additionalItems":
        break;
      case "additionalProperties":
        if (child !== false) {
          throw new StrictSchemaError(
            "INVALID_OBJECT_SCHEMA",
            `${path} additionalProperties must be false for a strict provider schema`,
          );
        }
        hasAdditionalProperties = true;
        break;
      case "properties":
        output.properties = normalizeProperties(child, path);
        break;
      case "required":
        requiredValue = child;
        break;
      default:
        if (FORBIDDEN_SCHEMA_KEYWORDS.has(key)) {
          throw new StrictSchemaError(
            "UNSUPPORTED_SCHEMA_KEYWORD",
            `${path} uses unsupported provider schema keyword ${key}`,
          );
        }
        output[key] = normalizeNode(child, `${path}.${key}`);
        break;
    }
  }

  const isObjectSchema = output.type === "object" || output.properties !== undefined;
  if (isObjectSchema) {
    const properties = isJsonObject(output.properties) ? output.properties : {};
    output.properties = properties;
    output.additionalProperties = false;
    const required = Array.isArray(requiredValue)
      ? requiredValue.filter((item): item is string => typeof item === "string")
      : [];
    output.required = [...new Set(required)];
  } else if (requiredValue !== undefined) {
    output.required = requiredValue;
  }

  if (hasAdditionalProperties && !isObjectSchema) {
    throw new StrictSchemaError(
      "INVALID_OBJECT_SCHEMA",
      `${path} declares additionalProperties without an object schema`,
    );
  }

  return output;
}

function normalizeBranchList(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new StrictSchemaError(
      "UNREPRESENTABLE_SCHEMA",
      `${path} must be an array`,
    );
  }
  return value.map((item, index) => normalizeNode(item, `${path}[${index}]`));
}

function collectRefs(value: unknown, refs: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      refs.push(child);
    } else {
      collectRefs(child, refs);
    }
  }
}

function definitionNames(schema: JsonObject): ReadonlySet<string> {
  const definitions = schema.$defs;
  if (definitions === undefined) {
    return new Set();
  }
  if (!isJsonObject(definitions)) {
    throw new StrictSchemaError(
      "INVALID_DEFINITIONS",
      "strict schema $defs must be an object",
    );
  }
  return new Set(Object.keys(definitions));
}

export function assertStrictJsonSchema(schema: unknown, path = "schema"): void {
  if (!isJsonObject(schema)) {
    throw new StrictSchemaError(
      "UNREPRESENTABLE_SCHEMA",
      `${path} must be an object schema`,
    );
  }

  const refs: string[] = [];
  collectRefs(schema, refs);
  const definitions = definitionNames(schema);
  for (const ref of refs) {
    if (ref === "#") {
      continue;
    }
    if (!ref.startsWith("#/$defs/")) {
      throw new StrictSchemaError(
        "INVALID_REF",
        `${path} contains unsupported $ref ${ref}`,
      );
    }
    const name = ref.slice("#/$defs/".length);
    if (!definitions.has(name)) {
      throw new StrictSchemaError(
        "INVALID_REF",
        `${path} references missing definition ${name}`,
      );
    }
  }

  const visit = (node: unknown, nodePath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${nodePath}[${index}]`));
      return;
    }
    if (!isJsonObject(node)) {
      return;
    }
    if (node.type === "object" || node.properties !== undefined) {
      const properties = node.properties;
      if (!isJsonObject(properties)) {
        throw new StrictSchemaError(
          "INVALID_OBJECT_SCHEMA",
          `${nodePath} object properties must be an object`,
        );
      }
      if (node.additionalProperties !== false) {
        throw new StrictSchemaError(
          "INVALID_OBJECT_SCHEMA",
          `${nodePath} object must set additionalProperties to false`,
        );
      }
      const required = node.required;
      if (required !== undefined) {
        if (!Array.isArray(required) || !required.every((item) => typeof item === "string")) {
          throw new StrictSchemaError(
            "INVALID_OBJECT_SCHEMA",
            `${nodePath} required must be an array of strings`,
          );
        }
        for (const name of required) {
          if (!(name in properties)) {
            throw new StrictSchemaError(
              "INVALID_OBJECT_SCHEMA",
              `${nodePath} requires unknown property ${name}`,
            );
          }
        }
      }
      const requiredSet = new Set(Array.isArray(required) ? required : []);
      for (const name of Object.keys(properties)) {
        if (!requiredSet.has(name)) {
          throw new StrictSchemaError(
            "INVALID_OBJECT_SCHEMA",
            `${nodePath} property ${name} must be listed in required for provider strict mode`,
          );
        }
      }
    }
    if (Array.isArray(node.items)) {
      throw new StrictSchemaError(
        "UNSUPPORTED_SCHEMA_KEYWORD",
        `${nodePath} tuple items are not provider-compatible`,
      );
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && isJsonObject(child)) {
        for (const [name, property] of Object.entries(child)) {
          visit(property, `${nodePath}.properties.${name}`);
        }
      } else if (key === "$defs" && isJsonObject(child)) {
        for (const [name, definition] of Object.entries(child)) {
          visit(definition, `${nodePath}.$defs.${name}`);
        }
      } else if (key !== "required" && key !== "$ref") {
        visit(child, `${nodePath}.${key}`);
      }
    }
  };

  visit(schema, path);
}

export function compileStrictJsonSchema(
  name: string,
  schema: z.ZodType,
): StrictJsonSchema {
  if (!STRICT_SCHEMA_NAME_PATTERN.test(name)) {
    throw new StrictSchemaError(
      "INVALID_SCHEMA_NAME",
      `schema name ${name} must match ${STRICT_SCHEMA_NAME_PATTERN.source}`,
    );
  }
  let raw: unknown;
  try {
    raw = z.toJSONSchema(schema, {
      target: STRICT_SCHEMA_DIALECT,
      io: "output",
    });
  } catch (error) {
    throw new StrictSchemaError(
      "UNREPRESENTABLE_SCHEMA",
      `schema ${name} cannot be represented as JSON Schema`,
      { cause: error },
    );
  }
  const normalized = normalizeNode(cloneJson(raw), name);
  assertStrictJsonSchema(normalized, name);
  return {
    name,
    strict: true,
    schema: normalized as JsonObject,
  };
}

export function strictSchemaHash(format: StrictJsonSchema): string {
  return hashCanonicalJson({
    name: format.name,
    strict: format.strict,
    schema: format.schema,
  });
}

export const FAMILY_SPEC_SCHEMA_NAMES: Readonly<Record<Family, string>> = {
  ranking: "puzzle_spec_ranking",
  matching: "puzzle_spec_matching",
  scheduling: "puzzle_spec_scheduling",
  truth: "puzzle_spec_truth",
  arithmetic: "puzzle_spec_arithmetic",
  matrix: "puzzle_spec_matrix",
  transforms: "puzzle_spec_transforms",
  paths: "puzzle_spec_paths",
  symmetry: "puzzle_spec_symmetry",
  counting: "puzzle_spec_counting",
};

export const FAMILY_SPEC_JSON_SCHEMAS: Readonly<
  Record<Family, StrictJsonSchema>
> = Object.fromEntries(
  FAMILIES.map((family) => [
    family,
    compileStrictJsonSchema(
      FAMILY_SPEC_SCHEMA_NAMES[family],
      FAMILY_SPEC_SCHEMAS[family],
    ),
  ]),
) as Record<Family, StrictJsonSchema>;

const FAMILY_SPEC_ENVELOPE_JSON_SCHEMAS: Readonly<
  Record<Family, StrictJsonSchema>
> = Object.fromEntries(
  FAMILIES.map((family) => [
    family,
    compileStrictJsonSchema(
      `${FAMILY_SPEC_SCHEMA_NAMES[family]}_envelope`,
      z.strictObject({
        family: z.literal(family),
        spec: FAMILY_SPEC_SCHEMAS[family],
      }),
    ),
  ]),
) as Record<Family, StrictJsonSchema>;

export function familySpecJsonSchema(family: Family): StrictJsonSchema {
  return FAMILY_SPEC_JSON_SCHEMAS[family];
}

export function familySpecEnvelopeJsonSchema(family: Family): StrictJsonSchema {
  return FAMILY_SPEC_ENVELOPE_JSON_SCHEMAS[family];
}

export const WORDING_JSON_SCHEMA = compileStrictJsonSchema(
  "puzzle_wording",
  WordingResponseSchema,
);

export const BLIND_ISSUE_CODES = [
  "duplicate_options",
  "no_correct_option",
  "ambiguous_rules",
  "missing_information",
  "unreadable_image",
  "contradictory_clues",
  "answer_leak",
  "other",
] as const;

export type BlindIssueCode = (typeof BLIND_ISSUE_CODES)[number];
export const BlindIssueCodeSchema = z.enum(BLIND_ISSUE_CODES);

export const BLIND_ANSWER_STATUSES = [
  "selected",
  "no_unique_answer",
  "cannot_determine",
] as const;
export type BlindAnswerStatus = (typeof BLIND_ANSWER_STATUSES)[number];
export const BlindAnswerStatusSchema = z.enum(BLIND_ANSWER_STATUSES);

export const BLIND_CLARITY_VALUES = ["clear", "unclear"] as const;
export type BlindClarity = (typeof BLIND_CLARITY_VALUES)[number];
export const BlindClaritySchema = z.enum(BLIND_CLARITY_VALUES);

export const BLIND_AMBIGUITY_VALUES = ["none", "present", "uncertain"] as const;
export type BlindAmbiguity = (typeof BLIND_AMBIGUITY_VALUES)[number];
export const BlindAmbiguitySchema = z.enum(BLIND_AMBIGUITY_VALUES);

export const BLIND_LEGIBILITY_VALUES = [
  "legible",
  "unclear",
  "not_applicable",
] as const;
export type BlindLegibility = (typeof BLIND_LEGIBILITY_VALUES)[number];
export const BlindLegibilitySchema = z.enum(BLIND_LEGIBILITY_VALUES);

function boundedNonBlankString(max: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "string must not be blank");
}

export const BlindIssueSchema = z.strictObject({
  code: BlindIssueCodeSchema,
  evidence: boundedNonBlankString(300),
});
export type BlindIssue = z.infer<typeof BlindIssueSchema>;

export const BLIND_REVIEW_RESPONSE_SCHEMA = z
  .strictObject({
    answerStatus: BlindAnswerStatusSchema,
    chosenOption: z.enum(["A", "B", "C", "D"]).nullable(),
    reasoning: boundedNonBlankString(2000),
    clarity: BlindClaritySchema,
    ambiguity: BlindAmbiguitySchema,
    confidence: z.number().min(0).max(1),
    visualLegibility: BlindLegibilitySchema,
    issues: z.array(BlindIssueSchema).max(8),
  })
  .superRefine((review, ctx) => {
    if (review.answerStatus === "selected" && review.chosenOption === null) {
      ctx.addIssue({
        code: "custom",
        path: ["chosenOption"],
        message: "selected requires a non-null chosenOption",
      });
    }
    if (review.answerStatus !== "selected" && review.chosenOption !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["chosenOption"],
        message: "a non-selected answer status requires chosenOption null",
      });
    }
  });

export type BlindReviewResponse = z.infer<typeof BLIND_REVIEW_RESPONSE_SCHEMA>;

export const BLIND_REVIEW_JSON_SCHEMA = compileStrictJsonSchema(
  "puzzle_blind_review",
  BLIND_REVIEW_RESPONSE_SCHEMA,
);

export const ALIGNMENT_FIELD_NAMES = [
  "question",
  "rulesAndClues",
  "options",
  "hint",
  "explanation",
  "image",
] as const;
export type AlignmentFieldName = (typeof ALIGNMENT_FIELD_NAMES)[number];

export const ALIGNMENT_FIELD_STATUSES = [
  "pass",
  "fail",
  "uncertain",
  "not_applicable",
] as const;
export type AlignmentFieldStatus = (typeof ALIGNMENT_FIELD_STATUSES)[number];
export const AlignmentFieldStatusSchema = z.enum(ALIGNMENT_FIELD_STATUSES);

export const AlignmentFieldSchema = z.strictObject({
  status: AlignmentFieldStatusSchema,
  factIds: z.array(FactIdSchema).max(32),
  reason: boundedNonBlankString(500),
});
export type AlignmentField = z.infer<typeof AlignmentFieldSchema>;

export const ALIGNMENT_FIELDS_SCHEMA = z.strictObject({
  question: AlignmentFieldSchema,
  rulesAndClues: AlignmentFieldSchema,
  options: AlignmentFieldSchema,
  hint: AlignmentFieldSchema,
  explanation: AlignmentFieldSchema,
  image: AlignmentFieldSchema,
});
export type AlignmentFields = z.infer<typeof ALIGNMENT_FIELDS_SCHEMA>;

export const ALIGNMENT_REVIEW_RESPONSE_SCHEMA = z.strictObject({
  overall: z.enum(["pass", "fail", "uncertain"]),
  fields: ALIGNMENT_FIELDS_SCHEMA,
});
export type AlignmentReviewResponse = z.infer<
  typeof ALIGNMENT_REVIEW_RESPONSE_SCHEMA
>;

export const ALIGNMENT_REVIEW_JSON_SCHEMA = compileStrictJsonSchema(
  "puzzle_alignment_review",
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
);

export type AlignmentOverall = "pass" | "fail" | "uncertain";

export type AlignmentContractErrorCode =
  | "IMPROPER_NOT_APPLICABLE"
  | "INVALID_ALIGNMENT_FIELD";

export class AlignmentContractError extends Error {
  readonly code: AlignmentContractErrorCode;

  constructor(code: AlignmentContractErrorCode, message: string) {
    super(message);
    this.name = "AlignmentContractError";
    this.code = code;
  }
}

export function deriveAlignmentOverall(
  fields: AlignmentFields,
  modality: Modality,
): AlignmentOverall {
  const statuses: AlignmentFieldStatus[] = [];
  for (const fieldName of ALIGNMENT_FIELD_NAMES) {
    const status = fields[fieldName].status;
    if (fieldName === "image") {
      if (modality === "text" && status !== "not_applicable") {
        throw new AlignmentContractError(
          "IMPROPER_NOT_APPLICABLE",
          "the text family image field must be not_applicable",
        );
      }
      if (modality === "svg" && status === "not_applicable") {
        throw new AlignmentContractError(
          "IMPROPER_NOT_APPLICABLE",
          "the svg family image field cannot be not_applicable",
        );
      }
    } else if (status === "not_applicable") {
      throw new AlignmentContractError(
        "IMPROPER_NOT_APPLICABLE",
        `${fieldName} cannot be not_applicable`,
      );
    }
    if (status !== "not_applicable") {
      statuses.push(status);
    }
  }
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("uncertain")) {
    return "uncertain";
  }
  return "pass";
}

export const STRICT_SCHEMA_FORMATS = {
  wording: WORDING_JSON_SCHEMA,
  blindReview: BLIND_REVIEW_JSON_SCHEMA,
  alignmentReview: ALIGNMENT_REVIEW_JSON_SCHEMA,
  families: FAMILY_SPEC_JSON_SCHEMAS,
} as const;
