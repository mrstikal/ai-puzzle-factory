import { z } from "zod";
import { collectPermutations, SolverLimitError } from "../canonicalize.js";

export const MATCHING_CATEGORIES = ["A", "B", "C"] as const;
export type MatchingCategory = (typeof MATCHING_CATEGORIES)[number];
export const MatchingCategorySchema = z.enum(MATCHING_CATEGORIES);

export const MATCHING_CATEGORY_INDEX: Readonly<Record<MatchingCategory, number>> = {
  A: 0,
  B: 1,
  C: 2,
};

export const MATCHING_ITEM_IDS = [0, 1, 2, 3] as const;
export const MATCHING_ITEM_COUNT = MATCHING_ITEM_IDS.length;

const itemSchema = z.number().int().min(0).max(3);

export const MatchingEndpointSchema = z.strictObject({
  category: MatchingCategorySchema,
  item: itemSchema,
});
export type MatchingEndpoint = z.infer<typeof MatchingEndpointSchema>;

export const MatchingClueSchema = z.strictObject({
  kind: z.enum(["same", "different"]),
  left: MatchingEndpointSchema,
  right: MatchingEndpointSchema,
});
export type MatchingClue = z.infer<typeof MatchingClueSchema>;

export const MatchingRowSchema = z.strictObject({
  a: itemSchema,
  b: itemSchema,
  c: itemSchema,
});
export type MatchingRow = z.infer<typeof MatchingRowSchema>;

export const MatchingTableSchema = z
  .tuple([MatchingRowSchema, MatchingRowSchema, MatchingRowSchema, MatchingRowSchema])
  .superRefine((rows, ctx) => {
    const bItems = new Set<number>();
    const cItems = new Set<number>();
    for (const [index, row] of rows.entries()) {
      if (row.a !== index) {
        ctx.addIssue({
          code: "custom",
          path: [index, "a"],
          message: "matching table rows must be ordered by A item 0..3",
        });
      }
      bItems.add(row.b);
      cItems.add(row.c);
    }
    if (bItems.size !== MATCHING_ITEM_COUNT) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "matching table must use every B item exactly once",
      });
    }
    if (cItems.size !== MATCHING_ITEM_COUNT) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "matching table must use every C item exactly once",
      });
    }
  });
export type MatchingTable = z.infer<typeof MatchingTableSchema>;
export type MatchingAnswer = MatchingTable;

export function matchingItemLabel(
  category: MatchingCategory,
  item: number,
): string {
  if (!Number.isInteger(item) || item < 0 || item >= MATCHING_ITEM_COUNT) {
    throw new RangeError(`matching item ${item} is outside 0..3`);
  }
  return `${category}${item + 1}`;
}

export function endpointKey(endpoint: MatchingEndpoint): string {
  return `${MATCHING_CATEGORY_INDEX[endpoint.category]}.${endpoint.item}`;
}

function compareEndpoints(left: MatchingEndpoint, right: MatchingEndpoint): number {
  const categoryDifference =
    MATCHING_CATEGORY_INDEX[left.category] - MATCHING_CATEGORY_INDEX[right.category];
  if (categoryDifference !== 0) {
    return categoryDifference;
  }
  return left.item - right.item;
}

export function orderedEndpoints(
  left: MatchingEndpoint,
  right: MatchingEndpoint,
): readonly [MatchingEndpoint, MatchingEndpoint] {
  return compareEndpoints(left, right) <= 0 ? [left, right] : [right, left];
}

export function matchingPairKey(
  left: MatchingEndpoint,
  right: MatchingEndpoint,
): string {
  const [first, second] = orderedEndpoints(left, right);
  return `${endpointKey(first)}:${endpointKey(second)}`;
}

export function clueKey(clue: MatchingClue): string {
  return `${clue.kind}:${matchingPairKey(clue.left, clue.right)}`;
}

export function clueText(clue: MatchingClue): string {
  const left = matchingItemLabel(clue.left.category, clue.left.item);
  const right = matchingItemLabel(clue.right.category, clue.right.item);
  return clue.kind === "same"
    ? `${left} is in the same row as ${right}.`
    : `${left} is not in the same row as ${right}.`;
}

export const MatchingSpecSchema = z
  .strictObject({
    clues: z.array(MatchingClueSchema).min(4).max(12),
  })
  .superRefine((spec, ctx) => {
    const pairs = new Map<string, "same" | "different">();
    for (const [index, clue] of spec.clues.entries()) {
      if (clue.left.category === clue.right.category) {
        ctx.addIssue({
          code: "custom",
          path: ["clues", index],
          message: "matching clues must relate different categories",
        });
        continue;
      }
      const pair = matchingPairKey(clue.left, clue.right);
      const existing = pairs.get(pair);
      if (existing !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["clues", index],
          message:
            existing === clue.kind
              ? "duplicate matching clue"
              : "contradictory matching clue",
        });
        continue;
      }
      pairs.set(pair, clue.kind);
    }
  });
export type MatchingSpec = z.infer<typeof MatchingSpecSchema>;

export interface MatchingAssignment {
  readonly bByA: readonly number[];
  readonly cByA: readonly number[];
}

export function assignmentToTable(assignment: MatchingAssignment): MatchingTable {
  const rows: MatchingRow[] = [];
  for (let index = 0; index < MATCHING_ITEM_COUNT; index += 1) {
    const b = assignment.bByA[index];
    const c = assignment.cByA[index];
    if (b === undefined || c === undefined) {
      throw new RangeError("matching assignment is incomplete");
    }
    rows.push({ a: index, b, c });
  }
  return MatchingTableSchema.parse(rows);
}

export function tableToAssignment(table: MatchingTable): MatchingAssignment {
  const parsed = MatchingTableSchema.parse(table);
  return {
    bByA: parsed.map((row) => row.b),
    cByA: parsed.map((row) => row.c),
  };
}

export function matchingBToC(assignment: MatchingAssignment): readonly number[] {
  const bToC = Array.from<number | undefined>({ length: MATCHING_ITEM_COUNT }).fill(
    undefined,
  );
  for (let a = 0; a < MATCHING_ITEM_COUNT; a += 1) {
    const b = assignment.bByA[a];
    const c = assignment.cByA[a];
    if (b === undefined || c === undefined) {
      throw new RangeError("matching assignment is incomplete");
    }
    bToC[b] = c;
  }
  return bToC.map((value) => {
    if (value === undefined) {
      throw new RangeError("matching assignment does not define every B item");
    }
    return value;
  });
}

export function matchingPairSame(
  assignment: MatchingAssignment,
  left: MatchingEndpoint,
  right: MatchingEndpoint,
): boolean {
  if (left.category === right.category) {
    return false;
  }
  if (
    (left.category === "A" && right.category === "B") ||
    (left.category === "B" && right.category === "A")
  ) {
    const aItem = left.category === "A" ? left.item : right.item;
    const bItem = left.category === "B" ? left.item : right.item;
    return assignment.bByA[aItem] === bItem;
  }
  if (
    (left.category === "A" && right.category === "C") ||
    (left.category === "C" && right.category === "A")
  ) {
    const aItem = left.category === "A" ? left.item : right.item;
    const cItem = left.category === "C" ? left.item : right.item;
    return assignment.cByA[aItem] === cItem;
  }
  const bToC = matchingBToC(assignment);
  if (left.category === "B" && right.category === "C") {
    return bToC[left.item] === right.item;
  }
  if (left.category === "C" && right.category === "B") {
    return bToC[right.item] === left.item;
  }
  return false;
}

export function clueSatisfied(
  clue: MatchingClue,
  assignment: MatchingAssignment,
): boolean {
  const same = matchingPairSame(assignment, clue.left, clue.right);
  return clue.kind === "same" ? same : !same;
}

export function matchingViolationCount(
  clues: readonly MatchingClue[],
  assignment: MatchingAssignment,
): number {
  let violations = 0;
  for (const clue of clues) {
    if (!clueSatisfied(clue, assignment)) {
      violations += 1;
    }
  }
  return violations;
}

export interface MatchingSolutions {
  readonly solutions: readonly MatchingAssignment[];
  readonly enumeratedStates: number;
}

export function solveMatchingPermutations(
  clues: readonly MatchingClue[],
): MatchingSolutions {
  const perms = collectPermutations(MATCHING_ITEM_IDS, {
    maxResults: 24,
  });
  if (!perms.complete || perms.visited !== 24) {
    throw new SolverLimitError(24, perms.visited + 1);
  }
  const solutions: MatchingAssignment[] = [];
  for (const bByA of perms.items) {
    for (const cByA of perms.items) {
      const assignment: MatchingAssignment = { bByA, cByA };
      if (clues.every((clue) => clueSatisfied(clue, assignment))) {
        solutions.push(assignment);
      }
    }
  }
  return { solutions, enumeratedStates: perms.visited * perms.visited };
}

function permutationSwapDistance(
  correct: readonly number[],
  candidate: readonly number[],
): number {
  if (correct.length !== candidate.length) {
    throw new RangeError("matching permutations have different lengths");
  }
  const mapping = new Map<number, number>();
  for (let index = 0; index < correct.length; index += 1) {
    const from = correct[index];
    const to = candidate[index];
    if (from === undefined || to === undefined) {
      throw new RangeError("matching permutation is incomplete");
    }
    mapping.set(from, to);
  }
  const visited = new Set<number>();
  let cycles = 0;
  for (let value = 0; value < correct.length; value += 1) {
    if (visited.has(value)) {
      continue;
    }
    cycles += 1;
    let current: number | undefined = value;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      current = mapping.get(current);
    }
  }
  return correct.length - cycles;
}

export function matchingSwapDistance(
  correct: MatchingAssignment,
  candidate: MatchingAssignment,
): number {
  return (
    permutationSwapDistance(correct.bByA, candidate.bByA) +
    permutationSwapDistance(correct.cByA, candidate.cByA)
  );
}
