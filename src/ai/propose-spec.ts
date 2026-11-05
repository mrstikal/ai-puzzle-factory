import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
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
  familySpecEnvelopeJsonSchema,
  strictSchemaHash,
} from "./schemas.js";
import {
  FAMILIES,
  type Difficulty,
  type Family,
} from "../domain/experiment.js";
import {
  safeParseFamilySpecEnvelope,
  type FamilySpecByFamily,
  type FamilySpecEnvelope,
} from "../domain/spec.js";
import { getRun, getSlot, insertStageResult } from "../storage/repository.js";
import { SolverLimitError } from "../families/canonicalize.js";
import { solveArithmetic } from "../families/arithmetic/schema.js";
import { maskPopcount } from "../families/matrix/schema.js";
import { productionRegistry } from "../families/registry.js";
import { symmetryKnownComponents } from "../families/symmetry/schema.js";
import { composeD4Sequence } from "../families/transforms/schema.js";
import type { D4Operation } from "../families/contracts.js";
import { containsBinary, containsXor } from "../families/truth/schema.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";
import type { SolveResult } from "../families/contracts.js";

export const SPEC_PROMPT_VERSION = "v1";

const SPEC_PROMPT_HEADER = /^PUZZLE_SPEC_PROMPT_VERSION: (v\d+)\n/;

const FamilyGuidanceSchema = z.strictObject({
  schemaName: z.string().min(1).max(128),
  domain: z.string().min(1).max(2000),
  difficulty: z.record(z.enum(["1", "2", "3"]), z.record(z.string(), z.unknown())),
  rules: z.array(z.string().min(1).max(1000)).min(1).max(12),
});
type FamilyGuidance = z.infer<typeof FamilyGuidanceSchema>;

const GuidanceFileSchema = z.strictObject({
  guidanceVersion: z.literal("v1"),
  schemaVersion: z.literal("v1"),
  families: z.record(z.string().min(1), FamilyGuidanceSchema),
});
type GuidanceFile = z.infer<typeof GuidanceFileSchema>;

export interface SpecProposalMetadata {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly schemaHash: string;
}

export type SpecProposalErrorCode =
  | "INVALID_INPUT"
  | "ROUTE_ROLE_MISMATCH"
  | "SLOT_MISMATCH"
  | "STAGE_ALREADY_EXISTS"
  | "PROMPT_ASSET_INVALID"
  | "TRANSPORT_FAILED"
  | "MISSING_CONTENT"
  | "FORBIDDEN_FIELD"
  | "SCHEMA_INVALID"
  | "WRONG_FAMILY"
  | "DIFFICULTY_OUT_OF_BOUNDS"
  | "UNSAT"
  | "MULTIPLE_SOLUTIONS"
  | "SOLVER_LIMIT"
  | "FORMAL_CHECK_FAILED";

export interface SpecProposalErrorOptions {
  readonly logicalCallId?: string | null;
  readonly attemptIds?: readonly string[];
  readonly result?: OpenRouterCallResult | null;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
}

export class SpecProposalError extends Error {
  readonly code: SpecProposalErrorCode;
  readonly logicalCallId: string | null;
  readonly attemptIds: readonly string[];
  readonly result: OpenRouterCallResult | null;
  readonly issues: readonly string[];

  constructor(
    code: SpecProposalErrorCode,
    message: string,
    options: SpecProposalErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SpecProposalError";
    this.code = code;
    this.logicalCallId = options.logicalCallId ?? null;
    this.attemptIds = options.attemptIds ?? [];
    this.result = options.result ?? null;
    this.issues = options.issues ?? [];
  }
}

class DifficultyBoundsError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "DifficultyBoundsError";
    this.issues = issues;
  }
}

function readPromptAsset(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), "utf8");
  } catch (error) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      `cannot read prompt asset ${relativePath}`,
      { cause: error },
    );
  }
}

function loadGuidance(): GuidanceFile {
  const raw = readPromptAsset("./prompts/v1/family-guidance.json");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      "family guidance is not valid JSON",
      { cause: error },
    );
  }
  const parsed = GuidanceFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      "family guidance does not satisfy the versioned schema",
      { cause: parsed.error },
    );
  }
  const missingFamilies = FAMILIES.filter(
    (family) => !(family in parsed.data.families),
  );
  if (missingFamilies.length > 0) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      `family guidance is missing: ${missingFamilies.join(", ")}`,
    );
  }
  const extraFamilies = Object.keys(parsed.data.families).filter(
    (family) => !FAMILIES.includes(family as Family),
  );
  if (extraFamilies.length > 0) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      `family guidance contains unknown families: ${extraFamilies.join(", ")}`,
    );
  }
  for (const family of FAMILIES) {
    const guidance = parsed.data.families[family];
    if (guidance === undefined) {
      throw new SpecProposalError(
        "PROMPT_ASSET_INVALID",
        `family guidance is missing: ${family}`,
      );
    }
    for (const difficulty of ["1", "2", "3"] as const) {
      if (!(difficulty in guidance.difficulty)) {
        throw new SpecProposalError(
          "PROMPT_ASSET_INVALID",
          `family guidance ${family} is missing difficulty ${difficulty}`,
        );
      }
    }
  }
  return parsed.data;
}

const SPEC_PROMPT = readPromptAsset("./prompts/v1/spec.txt");
const PROMPT_HEADER = SPEC_PROMPT_HEADER.exec(SPEC_PROMPT);
if (PROMPT_HEADER?.[1] !== SPEC_PROMPT_VERSION) {
  throw new SpecProposalError(
    "PROMPT_ASSET_INVALID",
    `spec prompt header must declare ${SPEC_PROMPT_VERSION}`,
  );
}
const GUIDANCE = loadGuidance();
const PROMPT_TEMPLATE_HASH = sha256Hex(SPEC_PROMPT);

function guidanceFor(family: Family): FamilyGuidance {
  const guidance = GUIDANCE.families[family];
  if (guidance === undefined) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      `family guidance is missing: ${family}`,
    );
  }
  return guidance;
}

export function specProposalMetadataForFamily(
  family: Family,
): SpecProposalMetadata {
  const guidance = guidanceFor(family);
  const schema = familySpecEnvelopeJsonSchema(family);
  if (guidance.schemaName !== schema.name) {
    throw new SpecProposalError(
      "PROMPT_ASSET_INVALID",
      `guidance schema name ${guidance.schemaName} does not match ${schema.name}`,
    );
  }
  const schemaHash = strictSchemaHash(schema);
  const guidanceHash = hashCanonicalJson(guidance);
  const promptHash = hashCanonicalJson({
    promptVersion: SPEC_PROMPT_VERSION,
    promptTemplateHash: PROMPT_TEMPLATE_HASH,
    guidanceVersion: GUIDANCE.guidanceVersion,
    schemaName: schema.name,
    schemaVersion: GUIDANCE.schemaVersion,
    guidanceHash,
    schemaHash,
  });
  return {
    promptVersion: SPEC_PROMPT_VERSION,
    promptHash,
    schemaName: schema.name,
    schemaVersion: GUIDANCE.schemaVersion,
    schemaHash,
  };
}

export function buildSpecProposalMessages(
  family: Family,
  difficulty: Difficulty,
  metadata: SpecProposalMetadata,
): readonly ChatMessage[] {
  const guidance = guidanceFor(family);
  return [
    {
      role: "system",
      content: [
        SPEC_PROMPT.trim(),
        "",
        "PROPOSAL METADATA",
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
        `Family: ${family}`,
        `Difficulty: ${difficulty}`,
        "",
        "Normative family guidance:",
        JSON.stringify(guidance, null, 2),
        "",
        `Return exactly one JSON object with the envelope {"family":"${family}","spec":{...}} that satisfies the supplied strict schema.`,
      ].join("\n"),
    },
  ];
}

const FORBIDDEN_RESPONSE_KEYS = new Set([
  "answer",
  "answers",
  "answerKey",
  "key",
  "options",
  "choices",
  "prose",
  "hint",
  "explanation",
  "svg",
  "html",
  "constraintText",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function forbiddenKeysIn(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value).filter((key) => FORBIDDEN_RESPONSE_KEYS.has(key));
}

function forbiddenResponseFields(value: unknown): string[] {
  const topLevel = forbiddenKeysIn(value);
  const nested =
    isRecord(value) && isRecord(value.spec) ? forbiddenKeysIn(value.spec) : [];
  return [...new Set([...topLevel, ...nested])];
}

function difficultyFloor(difficulty: Difficulty): number {
  return difficulty === 1 ? 8 : difficulty === 2 ? 6 : 4;
}

const LEVEL_ONE_ROTATIONS = new Set<D4Operation>([
  "rotate90",
  "rotate180",
  "rotate270",
]);
const QUARTER_TURNS = new Set<D4Operation>(["rotate90", "rotate270"]);
const REFLECTIONS = new Set<D4Operation>([
  "reflectLeftRight",
  "reflectTopBottom",
  "reflectMainDiagonal",
  "reflectAntiDiagonal",
]);

function assertDifficultyBounds(
  envelope: FamilySpecEnvelope,
  difficulty: Difficulty,
): void {
  const issues: string[] = [];
  switch (envelope.family) {
    case "ranking": {
      const expectedSize = difficulty === 1 ? 4 : 5;
      if (envelope.spec.size !== expectedSize) {
        issues.push(
          `ranking difficulty ${difficulty} requires size ${expectedSize}, received ${envelope.spec.size}`,
        );
      }
      break;
    }
    case "matching": {
      const floor = difficultyFloor(difficulty);
      if (envelope.spec.clues.length < floor) {
        issues.push(
          `matching difficulty ${difficulty} requires at least ${floor} clues, received ${envelope.spec.clues.length}`,
        );
      }
      break;
    }
    case "scheduling": {
      const floor = difficultyFloor(difficulty);
      if (envelope.spec.clues.length < floor) {
        issues.push(
          `scheduling difficulty ${difficulty} requires at least ${floor} clues, received ${envelope.spec.clues.length}`,
        );
      }
      break;
    }
    case "truth": {
      const expectedPeople = difficulty === 1 ? 3 : 4;
      if (envelope.spec.people !== expectedPeople) {
        issues.push(
          `truth difficulty ${difficulty} requires ${expectedPeople} people, received ${envelope.spec.people}`,
        );
      }
      if (difficulty === 1) {
        const binaryStatements = envelope.spec.statements.filter(containsBinary).length;
        if (binaryStatements > 1) {
          issues.push(
            `truth difficulty 1 allows at most one binary statement, received ${binaryStatements}`,
          );
        }
      }
      if (difficulty < 3 && envelope.spec.statements.some(containsXor)) {
        issues.push(`truth difficulty ${difficulty} forbids xor`);
      }
      break;
    }
    case "arithmetic": {
      const maxAbs = Math.max(
        ...envelope.spec.constraints.flatMap((constraint) =>
          constraint.coeffs.map((coefficient) => Math.abs(coefficient)),
        ),
      );
      if (maxAbs > difficulty) {
        issues.push(
          `arithmetic difficulty ${difficulty} allows max |coefficient| ${difficulty}, received ${maxAbs}`,
        );
      }
      break;
    }
    case "matrix": {
      const [minimum, maximum] =
        difficulty === 1 ? [1, 2] : difficulty === 2 ? [1, 3] : [2, 3];
      const seeds = [
        envelope.spec.cells[0][0],
        envelope.spec.cells[0][1],
        envelope.spec.cells[1][0],
        envelope.spec.cells[1][1],
      ];
      for (const [index, mask] of seeds.entries()) {
        const population = maskPopcount(mask);
        if (population < minimum || population > maximum) {
          issues.push(
            `matrix difficulty ${difficulty} seed ${index} requires population ${minimum}-${maximum}, received ${population}`,
          );
        }
      }
      break;
    }
    case "transforms": {
      const operations = envelope.spec.operations;
      if (difficulty === 1) {
        if (operations.length !== 1) {
          issues.push("transforms difficulty 1 requires exactly one operation");
        } else {
          const operation = operations[0];
          if (operation === undefined || !LEVEL_ONE_ROTATIONS.has(operation)) {
            issues.push(
              "transforms difficulty 1 requires one nonidentity rotation",
            );
          }
        }
      } else if (difficulty === 2) {
        if (operations.length !== 1) {
          issues.push("transforms difficulty 2 requires exactly one operation");
        } else {
          const operation = operations[0];
          if (operation === undefined || !REFLECTIONS.has(operation)) {
            issues.push("transforms difficulty 2 requires one reflection");
          }
        }
      } else {
        if (operations.length !== 2) {
          issues.push("transforms difficulty 3 requires exactly two operations");
        } else {
          const first = operations[0];
          const second = operations[1];
          if (first === undefined || second === undefined) {
            issues.push("transforms difficulty 3 requires two operations");
          } else {
            const hasQuarterTurn =
              (QUARTER_TURNS.has(first) && REFLECTIONS.has(second)) ||
              (QUARTER_TURNS.has(second) && REFLECTIONS.has(first));
            if (!hasQuarterTurn) {
              issues.push(
                "transforms difficulty 3 requires one quarter-turn rotation and one reflection",
              );
            } else if (
              composeD4Sequence([first, second]) ===
              composeD4Sequence([second, first])
            ) {
              issues.push("transforms difficulty 3 operations must not commute");
            }
          }
        }
      }
      break;
    }
    case "paths": {
      const [minimum, maximum] =
        difficulty === 1 ? [6, 8] : difficulty === 2 ? [7, 10] : [9, 12];
      if (
        envelope.spec.active.length < minimum ||
        envelope.spec.active.length > maximum
      ) {
        issues.push(
          `paths difficulty ${difficulty} requires ${minimum}-${maximum} active cells, received ${envelope.spec.active.length}`,
        );
      }
      break;
    }
    case "symmetry": {
      const [minimum, maximum] =
        difficulty === 1 ? [4, 5] : difficulty === 2 ? [6, 7] : [8, 10];
      const occupied = envelope.spec.cells.flatMap((row, rowIndex) =>
        row.flatMap((state, columnIndex) =>
          state === "occupied" ? [{ row: rowIndex, column: columnIndex }] : [],
        ),
      );
      if (occupied.length < minimum || occupied.length > maximum) {
        issues.push(
          `symmetry difficulty ${difficulty} requires ${minimum}-${maximum} occupied cells, received ${occupied.length}`,
        );
      }
      if (difficulty === 1 && envelope.spec.axis !== "vertical") {
        issues.push("symmetry difficulty 1 requires a vertical axis");
      }
      if (difficulty === 2 && envelope.spec.axis !== "horizontal") {
        issues.push("symmetry difficulty 2 requires a horizontal axis");
      }
      if (
        difficulty === 3 &&
        symmetryKnownComponents(envelope.spec.axis, occupied) < 2
      ) {
        issues.push(
          "symmetry difficulty 3 requires at least two known occupied components",
        );
      }
      break;
    }
    case "counting": {
      const shapeCount = difficulty === 3 ? 3 : 2;
      const [minimum, maximum] =
        difficulty === 1 ? [3, 5] : difficulty === 2 ? [6, 8] : [4, 8];
      if (envelope.spec.shapes.length !== shapeCount) {
        issues.push(
          `counting difficulty ${difficulty} requires ${shapeCount} shapes, received ${envelope.spec.shapes.length}`,
        );
      }
      for (const [index, shape] of envelope.spec.shapes.entries()) {
        if (shape.cells.length < minimum || shape.cells.length > maximum) {
          issues.push(
            `counting difficulty ${difficulty} shape ${index} requires ${minimum}-${maximum} cells, received ${shape.cells.length}`,
          );
        }
      }
      const operation = envelope.spec.query.operation;
      if (difficulty === 1 && operation !== "unionCount") {
        issues.push("counting difficulty 1 requires unionCount");
      }
      if (
        difficulty === 2 &&
        operation !== "intersectionAll" &&
        operation !== "exactlyOneShape"
      ) {
        issues.push(
          "counting difficulty 2 requires intersectionAll or exactlyOneShape",
        );
      }
      if (
        difficulty === 3 &&
        operation !== "intersectionAll" &&
        operation !== "exactlyKShapes"
      ) {
        issues.push(
          "counting difficulty 3 requires intersectionAll or exactlyKShapes",
        );
      }
      break;
    }
  }
  if (issues.length > 0) {
    throw new DifficultyBoundsError(issues);
  }
}

function solveArithmeticSubset(
  spec: FamilySpecByFamily["arithmetic"],
  constraints: readonly FamilySpecByFamily["arithmetic"]["constraints"][number][],
): readonly (readonly number[])[] {
  if (constraints.length === 0) {
    return [];
  }
  const first = constraints[0];
  if (first === undefined) {
    return [];
  }
  const padded =
    constraints.length === 1 ? [first, first] : [...constraints];
  return solveArithmetic({
    allDifferent: spec.allDifferent,
    constraints: padded,
  }).solutions;
}

function countNonredundantInequalities(
  spec: FamilySpecByFamily["arithmetic"],
): number {
  let count = 0;
  for (const [index, constraint] of spec.constraints.entries()) {
    if (constraint.op === "eq") {
      continue;
    }
    const reduced = spec.constraints.filter(
      (_candidate, candidateIndex) => candidateIndex !== index,
    );
    if (solveArithmeticSubset(spec, reduced).length !== 1) {
      count += 1;
    }
  }
  return count;
}

function assertPostFormalDifficulty(
  envelope: FamilySpecEnvelope,
  difficulty: Difficulty,
  solveResult: SolveResult<unknown>,
): void {
  const issues: string[] = [];
  if (envelope.family === "paths") {
    const route = solveResult.correctAnswer;
    if (Array.isArray(route)) {
      const edges = route.length - 1;
      const [minimum, maximum] =
        difficulty === 1 ? [3, 5] : difficulty === 2 ? [5, 7] : [7, 11];
      if (edges < minimum || edges > maximum) {
        issues.push(
          `paths difficulty ${difficulty} requires route length ${minimum}-${maximum} edges, received ${edges}`,
        );
      }
    }
  }
  if (envelope.family === "arithmetic" && difficulty === 3) {
    try {
      if (countNonredundantInequalities(envelope.spec) === 0) {
        issues.push(
          "arithmetic difficulty 3 requires at least one nonredundant inequality",
        );
      }
    } catch (error) {
      issues.push(
        `arithmetic difficulty 3 inequality check failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  if (issues.length > 0) {
    throw new DifficultyBoundsError(issues);
  }
}

function positiveUsd(value: string): boolean {
  return (
    /^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    !/^0(?:\.0+)?$/.test(value)
  );
}

export interface ProposeSpecInput<F extends Family = Family> {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly runId: string;
  readonly slotId: string;
  readonly family: F;
  readonly difficulty: Difficulty;
  readonly route: ResolvedRoute;
  readonly reservationUsd: string;
  readonly clock?: { now(): Date };
}

export interface SpecProposalResult<F extends Family = Family> {
  readonly logicalCallId: string;
  readonly family: F;
  readonly difficulty: Difficulty;
  readonly spec: FamilySpecByFamily[F];
  readonly solveResult: SolveResult<unknown>;
  readonly proposal: SpecProposalMetadata;
  readonly usage: OpenRouterUsage;
  readonly actualCostUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly OpenRouterAttemptResult[];
}

function assertInput(input: ProposeSpecInput): void {
  if (!FAMILIES.includes(input.family)) {
    throw new SpecProposalError(
      "INVALID_INPUT",
      `unknown family ${String(input.family)}`,
    );
  }
  if (input.difficulty !== 1 && input.difficulty !== 2 && input.difficulty !== 3) {
    throw new SpecProposalError(
      "INVALID_INPUT",
      `difficulty must be 1, 2, or 3, received ${String(input.difficulty)}`,
    );
  }
  if (input.apiKey.trim() === "") {
    throw new SpecProposalError(
      "INVALID_INPUT",
      "an inference key is required for a spec proposal",
    );
  }
  if (!positiveUsd(input.reservationUsd)) {
    throw new SpecProposalError(
      "INVALID_INPUT",
      "reservationUsd must be a positive decimal USD string",
    );
  }
  if (input.route.role !== "spec") {
    throw new SpecProposalError(
      "ROUTE_ROLE_MISMATCH",
      `spec proposal requires a resolved spec route, received ${input.route.role}`,
    );
  }
  if (input.route.requiresImage) {
    throw new SpecProposalError(
      "INVALID_INPUT",
      "a spec proposal route must not require an image",
    );
  }
}

export async function proposeSpec<F extends Family>(
  input: ProposeSpecInput<F>,
): Promise<SpecProposalResult<F>> {
  assertInput(input);
  const run = getRun(input.db, input.runId);
  if (run.runKind !== "full" && run.runKind !== "smoke") {
    throw new SpecProposalError(
      "INVALID_INPUT",
      `spec proposals require a full or smoke run, received ${run.runKind}`,
    );
  }
  const slot = getSlot(input.db, input.runId, input.slotId);
  if (slot.family !== input.family || slot.difficulty !== input.difficulty) {
    throw new SpecProposalError(
      "SLOT_MISMATCH",
      `slot ${input.slotId} is ${slot.family}/difficulty ${slot.difficulty}, not ${input.family}/difficulty ${input.difficulty}`,
    );
  }
  if (slot.stage !== "planned") {
    throw new SpecProposalError(
      "STAGE_ALREADY_EXISTS",
      `slot ${input.slotId} is already at stage ${slot.stage}`,
    );
  }

  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now();
  const metadata = specProposalMetadataForFamily(input.family);
  const responseFormat = familySpecEnvelopeJsonSchema(input.family);
  const messages = buildSpecProposalMessages(
    input.family,
    input.difficulty,
    metadata,
  );
  const settings: AiRoleSettings | undefined =
    Object.keys(input.route.settings).length > 0
      ? input.route.settings
      : undefined;
  const built = buildChatRequest({
    role: "spec",
    model: input.route.model,
    providerTag: input.route.providerTag,
    outputCapField: input.route.outputCapField,
    maxOutputTokens: input.route.maxOutputTokens,
    messages,
    responseFormat,
    ...(settings === undefined ? {} : { settings }),
  });

  const call = createLogicalCall(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    role: "spec",
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
    eventType: "proposal_metadata",
    payload: {
      family: input.family,
      difficulty: input.difficulty,
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
    throw new SpecProposalError(
      "TRANSPORT_FAILED",
      `spec proposal transport outcome was ${result.outcome}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }
  if (result.parsedContent === null) {
    throw new SpecProposalError(
      "MISSING_CONTENT",
      "spec proposal response has no parsed JSON content",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  const forbidden = forbiddenResponseFields(result.parsedContent);
  if (forbidden.length > 0) {
    throw new SpecProposalError(
      "FORBIDDEN_FIELD",
      `response contains forbidden supplied fields: ${forbidden.join(", ")}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: forbidden,
      },
    );
  }

  const parsed = safeParseFamilySpecEnvelope(result.parsedContent);
  if (!parsed.success) {
    throw new SpecProposalError(
      "SCHEMA_INVALID",
      "spec proposal response does not satisfy the requested family schema",
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        issues: parsed.error.issues.map(
          (issue) =>
            `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`,
        ),
        cause: parsed.error,
      },
    );
  }
  if (parsed.data.family !== input.family) {
    throw new SpecProposalError(
      "WRONG_FAMILY",
      `requested family ${input.family}, received ${parsed.data.family}`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  try {
    assertDifficultyBounds(parsed.data, input.difficulty);
  } catch (error) {
    if (error instanceof DifficultyBoundsError) {
      throw new SpecProposalError(
        "DIFFICULTY_OUT_OF_BOUNDS",
        `spec proposal does not satisfy ${input.family} difficulty ${input.difficulty}`,
        {
          logicalCallId: call.logicalCallId,
          attemptIds,
          result,
          issues: error.issues,
          cause: error,
        },
      );
    }
    throw error;
  }

  const engine = productionRegistry.getEngine(input.family);
  let solveResult: SolveResult<unknown>;
  try {
    solveResult = engine.enumerateSolutions(parsed.data.spec);
  } catch (error) {
    if (error instanceof SolverLimitError) {
      throw new SpecProposalError(
        "SOLVER_LIMIT",
        `independent engine hit its solver limit for ${input.family}`,
        {
          logicalCallId: call.logicalCallId,
          attemptIds,
          result,
          cause: error,
        },
      );
    }
    throw new SpecProposalError(
      "FORMAL_CHECK_FAILED",
      `independent engine rejected the ${input.family} spec`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
        cause: error,
      },
    );
  }

  if (solveResult.solutionCount === 0) {
    throw new SpecProposalError(
      "UNSAT",
      `independent engine found no solution for the ${input.family} spec`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }
  if (solveResult.solutionCount !== 1 || solveResult.answerCount !== 1) {
    throw new SpecProposalError(
      "MULTIPLE_SOLUTIONS",
      `independent engine found ${solveResult.solutionCount} solutions and ${solveResult.answerCount} answers for the ${input.family} spec`,
      {
        logicalCallId: call.logicalCallId,
        attemptIds,
        result,
      },
    );
  }

  try {
    assertPostFormalDifficulty(parsed.data, input.difficulty, solveResult);
  } catch (error) {
    if (error instanceof DifficultyBoundsError) {
      throw new SpecProposalError(
        "DIFFICULTY_OUT_OF_BOUNDS",
        `spec proposal does not satisfy ${input.family} difficulty ${input.difficulty}`,
        {
          logicalCallId: call.logicalCallId,
          attemptIds,
          result,
          issues: error.issues,
          cause: error,
        },
      );
    }
    throw error;
  }

  const finishedAt = clock.now();
  const elapsedMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  insertStageResult(input.db, {
    runId: input.runId,
    slotId: input.slotId,
    stage: "spec_ready",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs,
    payload: {
      family: input.family,
      difficulty: input.difficulty,
      spec: parsed.data.spec,
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
      formal: {
        solutionCount: solveResult.solutionCount,
        answerCount: solveResult.answerCount,
        enumeratedStates: solveResult.enumeratedStates,
        checkerVersion: solveResult.checkerVersion,
      },
    },
  });

  return {
    logicalCallId: call.logicalCallId,
    family: input.family,
    difficulty: input.difficulty,
    spec: parsed.data.spec as FamilySpecByFamily[F],
    solveResult,
    proposal: metadata,
    usage: result.usage,
    actualCostUsd: result.actualCostUsd,
    costStatus: result.costStatus,
    attempts: result.attempts,
  };
}
