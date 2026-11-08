import { z } from "zod";
import type { ChoiceSet } from "../domain/answers.js";
import type { Difficulty, Family, Modality } from "../domain/experiment.js";
import { FamilySchema, MODALITY_BY_FAMILY } from "../domain/experiment.js";

export const RULE_FACT_IDS = {
  domain: "r-domain",
  closedWorld: "r-closed",
  target: "r-target",
  operations: "r-operations",
  conventions: "r-conventions",
} as const;

export type RuleFactId = (typeof RULE_FACT_IDS)[keyof typeof RULE_FACT_IDS];

export const RULE_FACT_ID_VALUES: readonly RuleFactId[] = Object.values(RULE_FACT_IDS);

export const VisibleRulesSchema = z.strictObject({
  domain: z.string().min(1).max(400),
  closedWorld: z.string().min(1).max(400),
  target: z.string().min(1).max(400),
  operations: z.array(z.string().min(1).max(200)).min(1).max(20),
  conventions: z.array(z.string().min(1).max(200)).max(20),
});

export type VisibleRules = z.infer<typeof VisibleRulesSchema>;

export const FACT_KINDS = ["local", "observation", "rule", "derived"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FactKindSchema = z.enum(FACT_KINDS);

export const FACT_ID_PATTERN =
  /^(?:[fps](?:[1-9]\d{2,5}|\d[1-9]\d{1,4}|\d{2}[1-9]\d{0,3}|\d{3}[1-9]\d{0,2}|\d{4}[1-9]\d?|\d{5}[1-9])|r-(?:domain|closed|target|operations|conventions))$/;

export const FactIdSchema = z.string().regex(FACT_ID_PATTERN);

export const FactSchema = z.strictObject({
  factId: FactIdSchema,
  kind: FactKindSchema,
  text: z.string().min(1).max(1000),
});

export type Fact = z.infer<typeof FactSchema>;

export type FactNamespaceKind = "local" | "observation" | "derived";

const FACT_PREFIX: Readonly<Record<FactNamespaceKind, string>> = {
  local: "f",
  observation: "p",
  derived: "s",
};

export type FactContractErrorCode =
  | "FACT_NAMESPACE_MISMATCH"
  | "DUPLICATE_FACT_ID"
  | "UNKNOWN_FACT_ID"
  | "FACT_COVERAGE_MISMATCH";

export class FactContractError extends Error {
  readonly code: FactContractErrorCode;

  constructor(code: FactContractErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FactContractError";
    this.code = code;
  }
}

export function formatFactId(kind: FactNamespaceKind, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 999_998) {
    throw new RangeError(`fact index must be an integer between 0 and 999998, received ${index}`);
  }
  return `${FACT_PREFIX[kind]}${String(index + 1).padStart(3, "0")}`;
}

export function assertFactNamespace(fact: Fact): Fact {
  const result = FactSchema.safeParse(fact);
  if (!result.success) {
    throw new FactContractError(
      "FACT_NAMESPACE_MISMATCH",
      `fact ${String((fact as { factId?: unknown }).factId)} does not satisfy the fact schema`,
      { cause: result.error },
    );
  }
  const parsed = result.data;
  const expectedPattern: Readonly<Record<FactNamespaceKind, RegExp>> = {
    local: /^f\d{3,6}$/,
    observation: /^p\d{3,6}$/,
    derived: /^s\d{3,6}$/,
  };
  if (parsed.kind === "rule") {
    if (!RULE_FACT_ID_VALUES.includes(parsed.factId as RuleFactId)) {
      throw new FactContractError(
        "FACT_NAMESPACE_MISMATCH",
        `rule fact ${parsed.factId} is not a fixed code-owned rule ID`,
      );
    }
    return parsed;
  }
  if (!expectedPattern[parsed.kind].test(parsed.factId)) {
    throw new FactContractError(
      "FACT_NAMESPACE_MISMATCH",
      `fact ${parsed.factId} does not belong to the ${parsed.kind} namespace`,
    );
  }
  return parsed;
}

export function ruleFacts(rules: VisibleRules): readonly Fact[] {
  const parsed = VisibleRulesSchema.parse(rules);
  return [
    { factId: RULE_FACT_IDS.domain, kind: "rule", text: parsed.domain },
    { factId: RULE_FACT_IDS.closedWorld, kind: "rule", text: parsed.closedWorld },
    { factId: RULE_FACT_IDS.target, kind: "rule", text: parsed.target },
    { factId: RULE_FACT_IDS.operations, kind: "rule", text: parsed.operations.join("; ") },
    {
      factId: RULE_FACT_IDS.conventions,
      kind: "rule",
      text:
        parsed.conventions.length > 0
          ? parsed.conventions.join("; ")
          : "No additional coordinate or counting convention applies.",
    },
  ];
}

export function mergeFactInventory(
  ...groups: readonly (readonly Fact[])[]
): readonly Fact[] {
  const merged = new Map<string, Fact>();
  for (const group of groups) {
    for (const fact of group) {
      const parsed = assertFactNamespace(fact);
      if (merged.has(parsed.factId)) {
        throw new FactContractError(
          "DUPLICATE_FACT_ID",
          `fact ID ${parsed.factId} appears more than once in the merged inventory`,
        );
      }
      merged.set(parsed.factId, parsed);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0,
  );
}

export function assertFactReferences(
  references: readonly string[],
  inventory: readonly Fact[],
): void {
  const known = new Set(inventory.map((fact) => fact.factId));
  for (const reference of references) {
    if (!known.has(reference)) {
      throw new FactContractError(
        "UNKNOWN_FACT_ID",
        `reference ${reference} is not present in the fact inventory`,
      );
    }
  }
}

export function assertLocalClueFactCoverage(
  references: readonly string[],
  localFacts: readonly Fact[],
): void {
  const localIds = localFacts.map((fact) => {
    assertFactNamespace(fact);
    if (fact.kind !== "local") {
      throw new FactContractError(
        "FACT_NAMESPACE_MISMATCH",
        `clue fact ${fact.factId} must have kind local, received ${fact.kind}`,
      );
    }
    return fact.factId;
  });
  const expected = new Map<string, number>();
  for (const factId of localIds) {
    expected.set(factId, (expected.get(factId) ?? 0) + 1);
  }
  const actual = new Map<string, number>();
  for (const reference of references) {
    actual.set(reference, (actual.get(reference) ?? 0) + 1);
  }
  if (actual.size !== expected.size) {
    throw new FactContractError(
      "FACT_COVERAGE_MISMATCH",
      "clue text references do not cover the local fact inventory exactly once",
    );
  }
  for (const [factId, count] of expected) {
    if (actual.get(factId) !== count || count !== 1) {
      throw new FactContractError(
        "FACT_COVERAGE_MISMATCH",
        `local fact ${factId} must be referenced exactly once`,
      );
    }
  }
}

export const CANONICAL_STRUCTURE_VERSION = 1 as const;

export const CANONICAL_QUERY_KINDS = [
  "full_order",
  "full_table",
  "full_schedule",
  "full_truth_vector",
  "full_tuple",
  "xor_matrix",
  "apply_D4",
  "S_to_G_route",
  "reflect_half",
  "membership_count",
] as const;

export type CanonicalQueryKind = (typeof CANONICAL_QUERY_KINDS)[number];
export const CanonicalQueryKindSchema = z.enum(CANONICAL_QUERY_KINDS);

export const CANONICAL_QUERY_KIND_BY_FAMILY: Readonly<Record<Family, CanonicalQueryKind>> = {
  ranking: "full_order",
  matching: "full_table",
  scheduling: "full_schedule",
  truth: "full_truth_vector",
  arithmetic: "full_tuple",
  matrix: "xor_matrix",
  transforms: "apply_D4",
  paths: "S_to_G_route",
  symmetry: "reflect_half",
  counting: "membership_count",
};

export const CANONICAL_TOKEN_PATTERN =
  /^(?:[a-z][A-Za-z0-9]*(?::[^\s:]+)+|[a-z][A-Za-z0-9]*=[^\s=]+)$/;

export const CanonicalTokenSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    CANONICAL_TOKEN_PATTERN,
    "canonical tokens must be typed code-owned tokens without whitespace",
  );

export const D4_OPERATIONS = [
  "identity",
  "rotate90",
  "rotate180",
  "rotate270",
  "reflectLeftRight",
  "reflectTopBottom",
  "reflectMainDiagonal",
  "reflectAntiDiagonal",
] as const;

export type D4Operation = (typeof D4_OPERATIONS)[number];
export const D4OperationSchema = z.enum(D4_OPERATIONS);

export type CanonicalStructureErrorCode = "INVALID_TRANSFORM_OPERATION";

export class CanonicalStructureError extends Error {
  readonly code: CanonicalStructureErrorCode;

  constructor(code: CanonicalStructureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanonicalStructureError";
    this.code = code;
  }
}

export function isD4Operation(value: string): value is D4Operation {
  return (D4_OPERATIONS as readonly string[]).includes(value);
}

export function assertKnownTransformOperation(value: string): D4Operation {
  if (!isD4Operation(value)) {
    throw new CanonicalStructureError(
      "INVALID_TRANSFORM_OPERATION",
      `transform operation ${value} is not one of the eight declared D4 operations`,
    );
  }
  return value;
}

interface FamilyCanonicalShape {
  readonly queryKind: CanonicalQueryKind;
  readonly queryTokens: "empty" | "nonempty";
  readonly relationTokens: "empty" | "nonempty";
  readonly geometryTokens: "empty" | "nonempty";
  readonly geometryTokenCount?: number;
}

const FAMILY_CANONICAL_SHAPES: Readonly<Record<Family, FamilyCanonicalShape>> = {
  ranking: {
    queryKind: "full_order",
    queryTokens: "empty",
    relationTokens: "nonempty",
    geometryTokens: "empty",
  },
  matching: {
    queryKind: "full_table",
    queryTokens: "empty",
    relationTokens: "nonempty",
    geometryTokens: "empty",
  },
  scheduling: {
    queryKind: "full_schedule",
    queryTokens: "empty",
    relationTokens: "nonempty",
    geometryTokens: "empty",
  },
  truth: {
    queryKind: "full_truth_vector",
    queryTokens: "empty",
    relationTokens: "nonempty",
    geometryTokens: "empty",
  },
  arithmetic: {
    queryKind: "full_tuple",
    queryTokens: "empty",
    relationTokens: "nonempty",
    geometryTokens: "empty",
  },
  matrix: {
    queryKind: "xor_matrix",
    queryTokens: "nonempty",
    relationTokens: "empty",
    geometryTokens: "nonempty",
    geometryTokenCount: 8,
  },
  transforms: {
    queryKind: "apply_D4",
    queryTokens: "nonempty",
    relationTokens: "empty",
    geometryTokens: "nonempty",
  },
  paths: {
    queryKind: "S_to_G_route",
    queryTokens: "nonempty",
    relationTokens: "nonempty",
    geometryTokens: "nonempty",
  },
  symmetry: {
    queryKind: "reflect_half",
    queryTokens: "empty",
    relationTokens: "empty",
    geometryTokens: "nonempty",
  },
  counting: {
    queryKind: "membership_count",
    queryTokens: "nonempty",
    relationTokens: "nonempty",
    geometryTokens: "nonempty",
    geometryTokenCount: 25,
  },
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUnsignedInteger(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function isCanonicalSignedInteger(value: string): boolean {
  return /^(?:0|-?[1-9]\d*)$/.test(value);
}

function isSorted(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1];
    const current = tokens[index];
    if (previous === undefined || current === undefined || previous > current) {
      return false;
    }
  }
  return true;
}

function tokenSetEquals(tokens: readonly string[], expected: readonly string[]): boolean {
  if (tokens.length !== expected.length) {
    return false;
  }
  const seen = new Set(tokens);
  if (seen.size !== tokens.length) {
    return false;
  }
  return expected.every((token) => seen.has(token));
}

function domainValue(tokens: readonly string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const matches = tokens.filter((token) => token.startsWith(prefix));
  return matches.length === 1 ? matches[0]?.slice(prefix.length) : undefined;
}

function parseCoordinateToken(
  tokens: readonly string[],
  name: "start" | "goal",
): { readonly row: number; readonly column: number } | undefined {
  const prefix = `${name}:`;
  const matches = tokens.filter((token) => token.startsWith(prefix));
  if (matches.length !== 1) {
    return undefined;
  }
  const match = /^(\d+):(\d+)$/.exec(matches[0]?.slice(prefix.length) ?? "");
  if (match === null) {
    return undefined;
  }
  const rowText = match[1] ?? "";
  const columnText = match[2] ?? "";
  if (!isCanonicalUnsignedInteger(rowText) || !isCanonicalUnsignedInteger(columnText)) {
    return undefined;
  }
  return { row: Number(rowText), column: Number(columnText) };
}

function validateTransformQuery(
  tokens: readonly string[],
  issue: (path: (string | number)[], message: string) => void,
): void {
  const stepTokens = tokens.filter((token) => token.startsWith("steps="));
  if (stepTokens.length !== 1) {
    issue(["queryTokens"], "transforms require exactly one steps=N token");
    return;
  }
  const stepsValue = stepTokens[0]?.slice("steps=".length);
  const steps = stepsValue === "1" || stepsValue === "2" ? Number(stepsValue) : undefined;
  if (steps === undefined) {
    issue(["queryTokens"], "transform steps must be 1 or 2");
  }

  const netTokens = tokens.filter((token) => token.startsWith("net="));
  if (netTokens.length !== 1) {
    issue(["queryTokens"], "transforms require exactly one net=operation token");
  } else {
    const netValue = netTokens[0]?.slice("net=".length) ?? "";
    if (!isD4Operation(netValue)) {
      issue(["queryTokens"], `net=${netValue} is not a declared D4 operation`);
    }
  }

  const opTokens = tokens.filter((token) => /^op\d+=/.test(token));
  const otherTokens = tokens.filter(
    (token) =>
      !token.startsWith("steps=") && !token.startsWith("net=") && !/^op\d+=/.test(token),
  );
  if (otherTokens.length > 0) {
    issue(["queryTokens"], `unexpected transform query tokens: ${otherTokens.join(", ")}`);
  }

  const seenIndices = new Set<number>();
  for (const token of opTokens) {
    const match = /^op(\d+)=(.+)$/.exec(token);
    if (match === null) {
      issue(["queryTokens"], `malformed transform operation token ${token}`);
      continue;
    }
    const index = Number(match[1]);
    const indexText = match[1] ?? "";
    const operation = match[2] ?? "";
    if (!isCanonicalUnsignedInteger(indexText)) {
      issue(["queryTokens"], `${token} uses a non-canonical operation index`);
      continue;
    }
    seenIndices.add(index);
    if (!isD4Operation(operation)) {
      issue(["queryTokens"], `${token} uses an arbitrary transform operation`);
    }
  }

  const expectedOperations = steps ?? opTokens.length;
  if (opTokens.length !== expectedOperations) {
    issue(
      ["queryTokens"],
      `expected ${expectedOperations} indexed operations, received ${opTokens.length}`,
    );
  }
  for (let index = 0; index < expectedOperations; index += 1) {
    if (!seenIndices.has(index)) {
      issue(["queryTokens"], `missing ordered transform operation op${index}`);
    }
  }
  if (tokens.length !== expectedOperations + 2) {
    issue(
      ["queryTokens"],
      `expected ${expectedOperations + 2} query tokens including steps and net`,
    );
  }
}

function validateCountingQuery(
  tokens: readonly string[],
  shapes: number | undefined,
  issue: (path: (string | number)[], message: string) => void,
): void {
  const operationTokens = tokens.filter((token) => token.startsWith("operation="));
  if (operationTokens.length !== 1) {
    issue(["queryTokens"], "counting requires exactly one operation token");
    return;
  }
  const operation = operationTokens[0]?.slice("operation=".length) ?? "";
  const allowedOperations = new Set([
    "unionCount",
    "intersectionAll",
    "exactlyOneShape",
    "exactlyKShapes",
  ]);
  if (!allowedOperations.has(operation)) {
    issue(["queryTokens"], `unsupported counting operation ${operation}`);
  }

  const kTokens = tokens.filter((token) => token.startsWith("k="));
  if (operation === "exactlyKShapes") {
    if (kTokens.length !== 1) {
      issue(["queryTokens"], "exactlyKShapes requires exactly one k token");
    } else {
      const kValue = kTokens[0]?.slice("k=".length) ?? "";
      if (!isCanonicalUnsignedInteger(kValue)) {
        issue(["queryTokens"], "counting k must use a canonical decimal integer");
      } else {
        const k = Number(kValue);
        if (k !== 2 && k !== 3) {
          issue(["queryTokens"], "counting k must be 2 or 3");
        } else if (shapes !== undefined && k > shapes) {
          issue(["queryTokens"], `counting k=${k} exceeds shapes=${shapes}`);
        }
      }
    }
    if (tokens.length !== 2) {
      issue(["queryTokens"], "exactlyKShapes requires exactly operation and k tokens");
    }
  } else if (kTokens.length > 0) {
    issue(["queryTokens"], "a k token is allowed only for exactlyKShapes");
  } else if (tokens.length !== 1) {
    issue(["queryTokens"], "counting query requires exactly one operation token");
  }
}

function validateCanonicalStructure(
  structure: CanonicalStructure,
  ctx: z.RefinementCtx,
): void {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: "custom", path, message });
  };

  for (const field of [
    "domainTokens",
    "queryTokens",
    "relationTokens",
    "geometryTokens",
  ] as const) {
    if (!isSorted(structure[field])) {
      issue([field], `${field} must be lexicographically sorted`);
    }
  }

  if (structure.domainTokens.length === 0) {
    issue(["domainTokens"], "canonical structures require at least one domain token");
  }

  const shape = FAMILY_CANONICAL_SHAPES[structure.family];
  if (structure.queryKind !== shape.queryKind) {
    issue(
      ["queryKind"],
      `family ${structure.family} requires queryKind ${shape.queryKind}, received ${structure.queryKind}`,
    );
  }
  if (shape.queryTokens === "empty" && structure.queryTokens.length > 0) {
    issue(["queryTokens"], `family ${structure.family} requires an empty query token list`);
  }
  if (shape.queryTokens === "nonempty" && structure.queryTokens.length === 0) {
    issue(["queryTokens"], `family ${structure.family} requires query tokens`);
  }
  if (shape.relationTokens === "empty" && structure.relationTokens.length > 0) {
    issue(["relationTokens"], `family ${structure.family} requires an empty relation token list`);
  }
  if (shape.relationTokens === "nonempty" && structure.relationTokens.length === 0) {
    issue(["relationTokens"], `family ${structure.family} requires relation tokens`);
  }
  if (shape.geometryTokens === "empty" && structure.geometryTokens.length > 0) {
    issue(["geometryTokens"], `family ${structure.family} requires an empty geometry token list`);
  }
  if (shape.geometryTokens === "nonempty" && structure.geometryTokens.length === 0) {
    issue(["geometryTokens"], `family ${structure.family} requires geometry tokens`);
  }
  if (
    shape.geometryTokenCount !== undefined &&
    structure.geometryTokens.length !== shape.geometryTokenCount
  ) {
    issue(
      ["geometryTokens"],
      `family ${structure.family} requires exactly ${shape.geometryTokenCount} geometry tokens`,
    );
  }

  const { domainTokens, queryTokens, relationTokens, geometryTokens } = structure;

  switch (structure.family) {
    case "ranking": {
      if (
        !tokenSetEquals(domainTokens, ["size=4"]) &&
        !tokenSetEquals(domainTokens, ["size=5"])
      ) {
        issue(["domainTokens"], "ranking requires exactly size=4 or size=5");
      }
      const sizeValue = domainValue(domainTokens, "size");
      const size =
        sizeValue === "4" || sizeValue === "5" ? Number(sizeValue) : undefined;
      if (relationTokens.length < 3 || relationTokens.length > 12) {
        issue(["relationTokens"], "ranking requires between 3 and 12 clues");
      }
      for (const [index, token] of relationTokens.entries()) {
        const match = /^(before|immediatelyBefore|at|notAt):(\d+):(\d+)$/.exec(token);
        if (match === null) {
          issue(["relationTokens", index], `malformed ranking clue ${token}`);
          continue;
        }
        const kind = match[1] ?? "";
        const firstText = match[2] ?? "";
        const secondText = match[3] ?? "";
        if (
          !isCanonicalUnsignedInteger(firstText) ||
          !isCanonicalUnsignedInteger(secondText)
        ) {
          issue(
            ["relationTokens", index],
            `ranking clue ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const first = Number(firstText);
        const second = Number(secondText);
        if (size === undefined) {
          continue;
        }
        if (first < 0 || first >= size) {
          issue(["relationTokens", index], `ranking item ${first} is outside 0..${size - 1}`);
        }
        if (kind === "before" || kind === "immediatelyBefore") {
          if (second < 0 || second >= size || first === second) {
            issue(["relationTokens", index], `ranking relation ${token} has an invalid target item`);
          }
        } else if (second < 1 || second > size) {
          issue(["relationTokens", index], `ranking position ${second} is outside 1..${size}`);
        }
      }
      break;
    }
    case "matching": {
      if (!tokenSetEquals(domainTokens, ["categories=3", "size=4"])) {
        issue(["domainTokens"], "matching requires categories=3 and size=4");
      }
      if (relationTokens.length < 4 || relationTokens.length > 12) {
        issue(["relationTokens"], "matching requires between 4 and 12 clues");
      }
      for (const [index, token] of relationTokens.entries()) {
        const match = /^(same|different):([^:]+):([^:]+)$/.exec(token);
        if (match === null) {
          issue(["relationTokens", index], `malformed matching clue ${token}`);
          continue;
        }
        const left = match[2] ?? "";
        const right = match[3] ?? "";
        if (!/^[^.]+\.[^.]+$/.test(left) || !/^[^.]+\.[^.]+$/.test(right)) {
          issue(["relationTokens", index], `matching endpoints must use category.item notation`);
        }
        const leftParts = left.split(".");
        const rightParts = right.split(".");
        const leftCategory = leftParts[0];
        const leftItem = leftParts[1];
        const rightCategory = rightParts[0];
        const rightItem = rightParts[1];
        if (
          leftCategory === undefined ||
          leftItem === undefined ||
          rightCategory === undefined ||
          rightItem === undefined ||
          !isCanonicalUnsignedInteger(leftCategory) ||
          !isCanonicalUnsignedInteger(leftItem) ||
          !isCanonicalUnsignedInteger(rightCategory) ||
          !isCanonicalUnsignedInteger(rightItem)
        ) {
          issue(
            ["relationTokens", index],
            `matching endpoints must use canonical integer category and item IDs`,
          );
        }
        if (compareStrings(left, right) > 0) {
          issue(["relationTokens", index], `matching endpoints must be sorted`);
        }
      }
      break;
    }
    case "scheduling": {
      if (!tokenSetEquals(domainTokens, ["capacities=2,2", "events=4", "slots=4"])) {
        issue(["domainTokens"], "scheduling requires events=4, slots=4, capacities=2,2");
      }
      if (relationTokens.length < 4 || relationTokens.length > 12) {
        issue(["relationTokens"], "scheduling requires between 4 and 12 clues");
      }
      for (const [index, token] of relationTokens.entries()) {
        const match =
          /^(at|notAt|before|immediatelyBefore|usesResource|notResource):(\d+):(\d+)$/.exec(
            token,
          );
        if (match === null) {
          issue(["relationTokens", index], `malformed scheduling clue ${token}`);
          continue;
        }
        const kind = match[1] ?? "";
        const firstText = match[2] ?? "";
        const secondText = match[3] ?? "";
        if (
          !isCanonicalUnsignedInteger(firstText) ||
          !isCanonicalUnsignedInteger(secondText)
        ) {
          issue(
            ["relationTokens", index],
            `scheduling clue ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const first = Number(firstText);
        const second = Number(secondText);
        if (first < 0 || first >= 4) {
          issue(["relationTokens", index], `scheduling event ${first} is outside 0..3`);
        }
        if (kind === "at" || kind === "notAt") {
          if (second < 1 || second > 4) {
            issue(["relationTokens", index], `scheduling slot ${second} is outside 1..4`);
          }
        } else if (kind === "before" || kind === "immediatelyBefore") {
          if (second < 0 || second >= 4 || first === second) {
            issue(["relationTokens", index], `scheduling relation ${token} has an invalid event`);
          }
        } else if (second < 0 || second > 1) {
          issue(["relationTokens", index], `scheduling resource ${second} is outside 0..1`);
        }
      }
      break;
    }
    case "truth": {
      const peopleValue = domainValue(domainTokens, "people");
      const truthfulValue = domainValue(domainTokens, "exactTruthful");
      const people =
        peopleValue === "3" || peopleValue === "4" ? Number(peopleValue) : undefined;
      const truthful =
        truthfulValue !== undefined && /^\d+$/.test(truthfulValue)
          ? Number(truthfulValue)
          : undefined;
      if (people === undefined) {
        issue(["domainTokens"], "truth requires people=3 or people=4");
      }
      if (truthful === undefined || people === undefined || truthful < 1 || truthful >= people) {
        issue(["domainTokens"], "truth requires exactTruthful between 1 and people-1");
      } else if (
        !tokenSetEquals(domainTokens, [
          `exactTruthful=${truthful}`,
          `people=${people}`,
        ])
      ) {
        issue(["domainTokens"], "truth domain tokens are inconsistent");
      }
      if (people !== undefined && relationTokens.length > people) {
        issue(
          ["relationTokens"],
          `truth cannot carry more than ${people} speaker statements`,
        );
      }
      const speakers = new Set<number>();
      for (const [index, token] of relationTokens.entries()) {
        const match = /^speaker:(\d+):(.+)$/.exec(token);
        if (match === null) {
          issue(["relationTokens", index], `malformed truth statement ${token}`);
          continue;
        }
        const speakerText = match[1] ?? "";
        if (!isCanonicalUnsignedInteger(speakerText)) {
          issue(
            ["relationTokens", index],
            `truth statement ${token} uses a non-canonical speaker index`,
          );
          continue;
        }
        const speaker = Number(speakerText);
        if (people !== undefined && (speaker < 0 || speaker >= people)) {
          issue(["relationTokens", index], `truth speaker ${speaker} is outside 0..${people - 1}`);
        }
        if (speakers.has(speaker)) {
          issue(["relationTokens", index], `duplicate truth speaker ${speaker}`);
        }
        speakers.add(speaker);
      }
      break;
    }
    case "arithmetic": {
      if (
        !tokenSetEquals(domainTokens, [
          "allDifferent=false",
          "domain=0..12",
          "variables=3",
        ]) &&
        !tokenSetEquals(domainTokens, [
          "allDifferent=true",
          "domain=0..12",
          "variables=3",
        ])
      ) {
        issue(
          ["domainTokens"],
          "arithmetic requires variables=3, domain=0..12, and an allDifferent boolean",
        );
      }
      if (relationTokens.length < 2 || relationTokens.length > 5) {
        issue(["relationTokens"], "arithmetic requires between 2 and 5 constraint rows");
      }
      for (const [index, token] of relationTokens.entries()) {
        const match = /^(eq|le):(-?\d+),(-?\d+),(-?\d+):(-?\d+)$/.exec(token);
        if (match === null) {
          issue(["relationTokens", index], `malformed arithmetic row ${token}`);
          continue;
        }
        const coefficientTexts = [match[2], match[3], match[4], match[5]];
        if (
          coefficientTexts.some(
            (value) => value === undefined || !isCanonicalSignedInteger(value),
          )
        ) {
          issue(
            ["relationTokens", index],
            `arithmetic row ${token} uses a non-canonical signed integer`,
          );
          continue;
        }
        const coefficients = [
          Number(match[2]),
          Number(match[3]),
          Number(match[4]),
        ];
        const constant = Number(match[5]);
        if (coefficients.some((value) => value < -3 || value > 3)) {
          issue(["relationTokens", index], `arithmetic coefficients must stay within -3..3`);
        }
        if (coefficients.every((value) => value === 0)) {
          issue(["relationTokens", index], `arithmetic row cannot have all-zero coefficients`);
        }
        if (constant < -108 || constant > 108) {
          issue(["relationTokens", index], `arithmetic constant must stay within -108..108`);
        }
      }
      break;
    }
    case "matrix": {
      if (!tokenSetEquals(domainTokens, ["glyphs=4", "grid=3x3", "missing=2,2"])) {
        issue(["domainTokens"], "matrix requires grid=3x3, glyphs=4, missing=2,2");
      }
      if (!tokenSetEquals(queryTokens, ["column=xor", "row=xor"])) {
        issue(["queryTokens"], "matrix requires row=xor and column=xor");
      }
      const cells = new Set<string>();
      for (const [index, token] of geometryTokens.entries()) {
        const match = /^cell:([0-2]):([0-2]):(\d+)$/.exec(token);
        if (match === null) {
          issue(["geometryTokens", index], `malformed matrix cell token ${token}`);
          continue;
        }
        const rowText = match[1] ?? "";
        const columnText = match[2] ?? "";
        const maskText = match[3] ?? "";
        if (
          !isCanonicalUnsignedInteger(rowText) ||
          !isCanonicalUnsignedInteger(columnText) ||
          !isCanonicalUnsignedInteger(maskText)
        ) {
          issue(
            ["geometryTokens", index],
            `matrix cell token ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const row = Number(rowText);
        const column = Number(columnText);
        const mask = Number(maskText);
        if (mask > 15) {
          issue(["geometryTokens", index], `matrix mask ${mask} is outside 0..15`);
        }
        if (row === 2 && column === 2) {
          issue(["geometryTokens", index], "the missing matrix cell must not be present");
        }
        const key = `${row},${column}`;
        if (cells.has(key)) {
          issue(["geometryTokens", index], `duplicate matrix cell ${key}`);
        }
        cells.add(key);
      }
      if (cells.size !== 8) {
        issue(["geometryTokens"], "matrix requires the eight visible cells exactly once");
      }
      break;
    }
    case "transforms": {
      if (!tokenSetEquals(domainTokens, ["grid=5x5"])) {
        issue(["domainTokens"], "transforms requires grid=5x5");
      }
      validateTransformQuery(queryTokens, issue);
      if (geometryTokens.length < 4 || geometryTokens.length > 8) {
        issue(["geometryTokens"], "transforms requires 4 to 8 occupied source cells");
      }
      const cells = new Set<string>();
      for (const [index, token] of geometryTokens.entries()) {
        const match = /^cell:([0-4]):([0-4])$/.exec(token);
        if (match === null) {
          issue(["geometryTokens", index], `malformed transform cell token ${token}`);
          continue;
        }
        const rowText = match[1] ?? "";
        const columnText = match[2] ?? "";
        if (
          !isCanonicalUnsignedInteger(rowText) ||
          !isCanonicalUnsignedInteger(columnText)
        ) {
          issue(
            ["geometryTokens", index],
            `transform cell token ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const key = `${rowText},${columnText}`;
        if (cells.has(key)) {
          issue(["geometryTokens", index], `duplicate transform cell ${key}`);
        }
        cells.add(key);
      }
      break;
    }
    case "paths": {
      if (!tokenSetEquals(domainTokens, ["grid=4x4"])) {
        issue(["domainTokens"], "paths requires grid=4x4");
      }
      const start = parseCoordinateToken(queryTokens, "start");
      const goal = parseCoordinateToken(queryTokens, "goal");
      if (queryTokens.length !== 2 || start === undefined || goal === undefined) {
        issue(["queryTokens"], "paths requires exactly one start:r:c and one goal:r:c token");
      }
      if (start !== undefined && goal !== undefined) {
        if (
          start.row < 0 ||
          start.row > 3 ||
          start.column < 0 ||
          start.column > 3 ||
          goal.row < 0 ||
          goal.row > 3 ||
          goal.column < 0 ||
          goal.column > 3
        ) {
          issue(["queryTokens"], "path endpoints must stay inside the 4x4 grid");
        }
        if (start.row === goal.row && start.column === goal.column) {
          issue(["queryTokens"], "path start and goal must be distinct");
        }
      }
      if (geometryTokens.length < 6 || geometryTokens.length > 12) {
        issue(["geometryTokens"], "paths requires 6 to 12 active cells");
      }
      const active = new Set<string>();
      for (const [index, token] of geometryTokens.entries()) {
        const match = /^active:([0-3]):([0-3])$/.exec(token);
        if (match === null) {
          issue(["geometryTokens", index], `malformed path active-cell token ${token}`);
          continue;
        }
        const rowText = match[1] ?? "";
        const columnText = match[2] ?? "";
        if (
          !isCanonicalUnsignedInteger(rowText) ||
          !isCanonicalUnsignedInteger(columnText)
        ) {
          issue(
            ["geometryTokens", index],
            `path active-cell token ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const key = `${rowText},${columnText}`;
        if (active.has(key)) {
          issue(["geometryTokens", index], `duplicate active cell ${key}`);
        }
        active.add(key);
      }
      if (relationTokens.length !== geometryTokens.length - 1) {
        issue(["relationTokens"], "a path tree requires exactly activeCells-1 open edges");
      }
      const edges = new Set<string>();
      for (const [index, token] of relationTokens.entries()) {
        const match = /^open:([0-3]):([0-3]):([0-3]):([0-3])$/.exec(token);
        if (match === null) {
          issue(["relationTokens", index], `malformed path edge token ${token}`);
          continue;
        }
        const coordinateTexts = [match[1], match[2], match[3], match[4]];
        if (
          coordinateTexts.some(
            (value) => value === undefined || !isCanonicalUnsignedInteger(value),
          )
        ) {
          issue(
            ["relationTokens", index],
            `path edge token ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const row1 = Number(match[1]);
        const column1 = Number(match[2]);
        const row2 = Number(match[3]);
        const column2 = Number(match[4]);
        if (row1 > row2 || (row1 === row2 && column1 > column2)) {
          issue(["relationTokens", index], "path edge endpoints must be sorted");
        }
        if (Math.abs(row1 - row2) + Math.abs(column1 - column2) !== 1) {
          issue(["relationTokens", index], "path edges must be orthogonally adjacent");
        }
        const firstKey = `${row1},${column1}`;
        const secondKey = `${row2},${column2}`;
        if (!active.has(firstKey) || !active.has(secondKey)) {
          issue(["relationTokens", index], "path edge endpoints must be active cells");
        }
        const edgeKey = `${firstKey}:${secondKey}`;
        if (edges.has(edgeKey)) {
          issue(["relationTokens", index], `duplicate path edge ${edgeKey}`);
        }
        edges.add(edgeKey);
      }
      break;
    }
    case "symmetry": {
      const axis = domainValue(domainTokens, "axis");
      const knownSide = domainValue(domainTokens, "knownSide");
      if (axis === "vertical" && knownSide === "left") {
        if (
          !tokenSetEquals(domainTokens, ["axis=vertical", "grid=8x8", "knownSide=left"])
        ) {
          issue(["domainTokens"], "vertical symmetry requires knownSide=left");
        }
      } else if (axis === "horizontal" && knownSide === "top") {
        if (
          !tokenSetEquals(domainTokens, ["axis=horizontal", "grid=8x8", "knownSide=top"])
        ) {
          issue(["domainTokens"], "horizontal symmetry requires knownSide=top");
        }
      } else {
        issue(
          ["domainTokens"],
          "symmetry requires grid=8x8 and a consistent vertical/left or horizontal/top axis",
        );
      }
      if (geometryTokens.length < 4 || geometryTokens.length > 10) {
        issue(["geometryTokens"], "symmetry requires 4 to 10 occupied known-half cells");
      }
      const cells = new Set<string>();
      for (const [index, token] of geometryTokens.entries()) {
        const match = /^cell:([0-7]):([0-7])$/.exec(token);
        if (match === null) {
          issue(["geometryTokens", index], `malformed symmetry cell token ${token}`);
          continue;
        }
        const rowText = match[1] ?? "";
        const columnText = match[2] ?? "";
        if (
          !isCanonicalUnsignedInteger(rowText) ||
          !isCanonicalUnsignedInteger(columnText)
        ) {
          issue(
            ["geometryTokens", index],
            `symmetry cell token ${token} uses a non-canonical integer`,
          );
          continue;
        }
        const row = Number(rowText);
        const column = Number(columnText);
        if (axis === "vertical" && column > 3) {
          issue(["geometryTokens", index], "vertical symmetry cells must stay in the left half");
        }
        if (axis === "horizontal" && row > 3) {
          issue(["geometryTokens", index], "horizontal symmetry cells must stay in the top half");
        }
        const key = `${row},${column}`;
        if (cells.has(key)) {
          issue(["geometryTokens", index], `duplicate symmetry cell ${key}`);
        }
        cells.add(key);
      }
      break;
    }
    case "counting": {
      const shapesValue = domainValue(domainTokens, "shapes");
      const shapes =
        shapesValue === "2" || shapesValue === "3" ? Number(shapesValue) : undefined;
      if (shapes === undefined) {
        issue(["domainTokens"], "counting requires shapes=2 or shapes=3");
      } else if (!tokenSetEquals(domainTokens, ["grid=5x5", `shapes=${shapes}`])) {
        issue(["domainTokens"], "counting requires grid=5x5 and a shapes count");
      }
      validateCountingQuery(queryTokens, shapes, issue);

      if (shapes !== undefined) {
        const maxMask = (1 << shapes) - 1;
        const cellKeys = new Set<string>();
        const maskCounts = new Map<number, number>();
        for (const [index, token] of geometryTokens.entries()) {
          const match = /^cell:([0-4]):([0-4]):(\d+)$/.exec(token);
          if (match === null) {
            issue(["geometryTokens", index], `malformed counting cell token ${token}`);
            continue;
          }
          const rowText = match[1] ?? "";
          const columnText = match[2] ?? "";
          const maskText = match[3] ?? "";
          if (
            !isCanonicalUnsignedInteger(rowText) ||
            !isCanonicalUnsignedInteger(columnText) ||
            !isCanonicalUnsignedInteger(maskText)
          ) {
            issue(
              ["geometryTokens", index],
              `counting cell token ${token} uses a non-canonical integer`,
            );
            continue;
          }
          const row = Number(rowText);
          const column = Number(columnText);
          const mask = Number(maskText);
          if (mask < 0 || mask > maxMask) {
            issue(["geometryTokens", index], `counting cell mask ${mask} is outside 0..${maxMask}`);
          }
          const key = `${row},${column}`;
          if (cellKeys.has(key)) {
            issue(["geometryTokens", index], `duplicate counting cell ${key}`);
          }
          cellKeys.add(key);
          maskCounts.set(mask, (maskCounts.get(mask) ?? 0) + 1);
        }
        if (cellKeys.size !== 25) {
          issue(["geometryTokens"], "counting requires all 25 grid cells exactly once");
        }

        const expectedRegions = maxMask;
        if (relationTokens.length !== expectedRegions) {
          issue(
            ["relationTokens"],
            `counting requires ${expectedRegions} region tokens for masks 1..${maxMask}`,
          );
        }
        const regionMasks = new Set<number>();
        for (const [index, token] of relationTokens.entries()) {
          const match = /^region:(\d+):(\d+)$/.exec(token);
          if (match === null) {
            issue(["relationTokens", index], `malformed counting region token ${token}`);
            continue;
          }
          const maskText = match[1] ?? "";
          const countText = match[2] ?? "";
          if (
            !isCanonicalUnsignedInteger(maskText) ||
            !isCanonicalUnsignedInteger(countText)
          ) {
            issue(
              ["relationTokens", index],
              `counting region token ${token} uses a non-canonical integer`,
            );
            continue;
          }
          const mask = Number(maskText);
          const count = Number(countText);
          if (mask < 1 || mask > maxMask) {
            issue(["relationTokens", index], `counting mask ${mask} is outside 1..${maxMask}`);
          }
          if (count < 0 || count > 25) {
            issue(["relationTokens", index], `counting region count ${count} is outside 0..25`);
          }
          if (regionMasks.has(mask)) {
            issue(["relationTokens", index], `duplicate counting region mask ${mask}`);
          }
          regionMasks.add(mask);
          const expectedCount = maskCounts.get(mask) ?? 0;
          if (count !== expectedCount) {
            issue(
              ["relationTokens", index],
              `counting region mask ${mask} count ${count} does not match geometry count ${expectedCount}`,
            );
          }
        }
      }
      break;
    }
  }
}

export const CanonicalStructureSchema = z
  .strictObject({
    version: z.literal(CANONICAL_STRUCTURE_VERSION),
    family: FamilySchema,
    domainTokens: z.array(CanonicalTokenSchema).min(1).max(8),
    queryKind: CanonicalQueryKindSchema,
    queryTokens: z.array(CanonicalTokenSchema).max(8),
    relationTokens: z.array(CanonicalTokenSchema).max(64),
    geometryTokens: z.array(CanonicalTokenSchema).max(64),
  })
  .superRefine(validateCanonicalStructure);

export type CanonicalStructure = z.infer<typeof CanonicalStructureSchema>;

export const SolveProofSchema = z.strictObject({
  facts: z.array(FactSchema),
  witness: z.unknown(),
});

export type SolveProof<A> = {
  readonly facts: readonly Fact[];
  readonly witness: A | null;
};

export const SolveResultSchema = z
  .strictObject({
    solutionCount: z.number().int().nonnegative(),
    answerCount: z.number().int().nonnegative(),
    correctAnswer: z.unknown(),
    proof: SolveProofSchema.nullable(),
    enumeratedStates: z.number().int().nonnegative(),
    checkerVersion: z.string().min(1).max(64),
  })
  .superRefine((result, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (result.solutionCount === 0) {
      if (result.answerCount !== 0) {
        issue(["answerCount"], "an unsatisfiable domain requires answerCount 0");
      }
      if (result.correctAnswer !== null && result.correctAnswer !== undefined) {
        issue(["correctAnswer"], "an unsatisfiable domain cannot carry a correct answer");
      }
      if (result.proof !== null) {
        issue(["proof"], "an unsatisfiable domain cannot carry a uniqueness proof");
      }
    }
    if (result.solutionCount === 1) {
      if (result.answerCount !== 1) {
        issue(["answerCount"], "a unique solution requires answerCount 1");
      }
      if (result.correctAnswer === null || result.correctAnswer === undefined) {
        issue(["correctAnswer"], "a unique solution requires a correct answer");
      }
      if (result.proof === null) {
        issue(["proof"], "a unique solution requires a proof");
      }
    }
    if (result.proof !== null) {
      for (const [index, fact] of result.proof.facts.entries()) {
        if (fact.kind !== "derived" || !/^s\d{3,6}$/.test(fact.factId)) {
          issue(
            ["proof", "facts", index],
            "proof facts must use the derived sNNN namespace",
          );
        }
      }
    }
  });

export type SolveResult<A> = {
  readonly solutionCount: number;
  readonly answerCount: number;
  readonly correctAnswer: A | null;
  readonly proof: SolveProof<A> | null;
  readonly enumeratedStates: number;
  readonly checkerVersion: string;
};

export function assertSolveResult<A>(result: SolveResult<A>): void {
  SolveResultSchema.parse(result);
}

export interface TestMutation<S> {
  readonly id: string;
  readonly description: string;
  readonly spec: S;
}

export interface FamilySolutionDiagnostics<A> {
  readonly solutionCount: number;
  readonly answerCount: number;
  readonly witnesses: readonly A[];
  readonly complete: boolean;
  readonly enumeratedStates: number;
}

export interface FamilyEngine<S, A> {
  readonly family: Family;
  readonly modality: Modality;
  readonly schema: z.ZodType<S>;
  generateSpec(seed: string, difficulty: Difficulty): S;
  enumerateSolutions(spec: S): SolveResult<A>;
  verifyAnswer(spec: S, answer: A): boolean;
  makeOptions(spec: S, answer: A, seed: string): ChoiceSet<A>;
  visibleRules(spec: S): VisibleRules;
  facts(spec: S): readonly Fact[];
  canonicalData(spec: S): CanonicalStructure;
  testMutations(spec: S): readonly TestMutation<S>[];
}

export function engineModalityMatchesFamily(engine: FamilyEngine<unknown, unknown>): boolean {
  return engine.modality === MODALITY_BY_FAMILY[engine.family];
}
