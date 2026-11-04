import { z } from "zod";
import { collectPermutations, countPermutations, SolverLimitError } from "../canonicalize.js";

export const RANKING_LABELS = ["A", "B", "C", "D", "E"] as const;
export type RankingLabel = (typeof RANKING_LABELS)[number];
export const RankingLabelSchema = z.enum(RANKING_LABELS);

export const RankingSizeSchema = z.union([z.literal(4), z.literal(5)]);
export type RankingSize = z.infer<typeof RankingSizeSchema>;

const itemSchema = z.number().int().min(0).max(4);
const positionSchema = z.number().int().min(1).max(5);

export const RankingClueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("before"),
    before: itemSchema,
    after: itemSchema,
  }),
  z.strictObject({
    kind: z.literal("immediatelyBefore"),
    before: itemSchema,
    after: itemSchema,
  }),
  z.strictObject({
    kind: z.literal("at"),
    item: itemSchema,
    position: positionSchema,
  }),
  z.strictObject({
    kind: z.literal("notAt"),
    item: itemSchema,
    position: positionSchema,
  }),
]);

export type RankingClue = z.infer<typeof RankingClueSchema>;

export const RankingSpecSchema = z
  .strictObject({
    size: RankingSizeSchema,
    clues: z.array(RankingClueSchema).min(3).max(12),
  })
  .superRefine((spec, ctx) => {
    for (const [index, clue] of spec.clues.entries()) {
      if (clue.kind === "before" || clue.kind === "immediatelyBefore") {
        if (clue.before >= spec.size) {
          ctx.addIssue({
            code: "custom",
            path: ["clues", index, "before"],
            message: `item ${clue.before} is outside 0..${spec.size - 1}`,
          });
        }
        if (clue.after >= spec.size) {
          ctx.addIssue({
            code: "custom",
            path: ["clues", index, "after"],
            message: `item ${clue.after} is outside 0..${spec.size - 1}`,
          });
        }
        if (clue.before === clue.after) {
          ctx.addIssue({
            code: "custom",
            path: ["clues", index],
            message: "a ranking relation cannot point an item at itself",
          });
        }
      } else {
        if (clue.item >= spec.size) {
          ctx.addIssue({
            code: "custom",
            path: ["clues", index, "item"],
            message: `item ${clue.item} is outside 0..${spec.size - 1}`,
          });
        }
        if (clue.position > spec.size) {
          ctx.addIssue({
            code: "custom",
            path: ["clues", index, "position"],
            message: `position ${clue.position} is outside 1..${spec.size}`,
          });
        }
      }
    }
  });

export type RankingSpec = z.infer<typeof RankingSpecSchema>;

export const RankingAnswerSchema = z.array(RankingLabelSchema).min(4).max(5);
export type RankingAnswer = z.infer<typeof RankingAnswerSchema>;

export function itemIds(size: RankingSize): readonly number[] {
  return Array.from({ length: size }, (_value, index) => index);
}

export function labelsForSize(size: RankingSize): readonly RankingLabel[] {
  return RANKING_LABELS.slice(0, size) as RankingLabel[];
}

export function labelForItem(item: number): RankingLabel {
  const label = RANKING_LABELS[item];
  if (label === undefined) {
    throw new RangeError(`ranking item ${item} has no visible label`);
  }
  return label;
}

export function itemForLabel(label: RankingLabel): number {
  const index = RANKING_LABELS.indexOf(label);
  if (index < 0) {
    throw new RangeError(`ranking label ${label} is not declared`);
  }
  return index;
}

export function clueKey(clue: RankingClue): string {
  switch (clue.kind) {
    case "before":
      return `before:${clue.before}:${clue.after}`;
    case "immediatelyBefore":
      return `immediatelyBefore:${clue.before}:${clue.after}`;
    case "at":
      return `at:${clue.item}:${clue.position}`;
    case "notAt":
      return `notAt:${clue.item}:${clue.position}`;
  }
}

export function clueText(clue: RankingClue): string {
  switch (clue.kind) {
    case "before":
      return `${labelForItem(clue.before)} is somewhere to the left of ${labelForItem(clue.after)}.`;
    case "immediatelyBefore":
      return `${labelForItem(clue.before)} is immediately to the left of ${labelForItem(clue.after)}.`;
    case "at":
      return `${labelForItem(clue.item)} is at position ${clue.position}.`;
    case "notAt":
      return `${labelForItem(clue.item)} is not at position ${clue.position}.`;
  }
}

export function positionsOf(order: readonly number[]): ReadonlyMap<number, number> {
  const positions = new Map<number, number>();
  for (const [index, item] of order.entries()) {
    positions.set(item, index + 1);
  }
  return positions;
}

export function clueSatisfied(
  clue: RankingClue,
  positions: ReadonlyMap<number, number>,
): boolean {
  if (clue.kind === "at") {
    return positions.get(clue.item) === clue.position;
  }
  if (clue.kind === "notAt") {
    const position = positions.get(clue.item);
    return position !== undefined && position !== clue.position;
  }
  const first = positions.get(clue.before);
  const second = positions.get(clue.after);
  if (first === undefined || second === undefined) {
    return false;
  }
  return clue.kind === "before" ? first < second : second === first + 1;
}

export function rankingViolationCount(
  clues: readonly RankingClue[],
  order: readonly number[],
): number {
  const positions = positionsOf(order);
  let violations = 0;
  for (const clue of clues) {
    if (!clueSatisfied(clue, positions)) {
      violations += 1;
    }
  }
  return violations;
}

export function relabelClue(
  clue: RankingClue,
  mapping: ReadonlyMap<number, number>,
): RankingClue {
  const relabel = (item: number): number => {
    const mapped = mapping.get(item);
    if (mapped === undefined) {
      throw new RangeError(`ranking relabeling has no target for item ${item}`);
    }
    return mapped;
  };
  switch (clue.kind) {
    case "before":
      return { kind: "before", before: relabel(clue.before), after: relabel(clue.after) };
    case "immediatelyBefore":
      return {
        kind: "immediatelyBefore",
        before: relabel(clue.before),
        after: relabel(clue.after),
      };
    case "at":
      return { kind: "at", item: relabel(clue.item), position: clue.position };
    case "notAt":
      return { kind: "notAt", item: relabel(clue.item), position: clue.position };
  }
}

export function answerToItemOrder(
  answer: RankingAnswer,
  size: RankingSize,
): readonly number[] | null {
  const parsed = RankingAnswerSchema.safeParse(answer);
  if (!parsed.success || parsed.data.length !== size) {
    return null;
  }
  const seen = new Set<number>();
  const order: number[] = [];
  for (const label of parsed.data) {
    const item = itemForLabel(label);
    if (item >= size || seen.has(item)) {
      return null;
    }
    seen.add(item);
    order.push(item);
  }
  return order.length === size ? order : null;
}

export function itemOrderToAnswer(
  order: readonly number[],
  size: RankingSize,
): RankingAnswer {
  if (order.length !== size) {
    throw new RangeError(`ranking order length ${order.length} does not match size ${size}`);
  }
  const seen = new Set<number>();
  const answer: RankingLabel[] = [];
  for (const item of order) {
    if (!Number.isInteger(item) || item < 0 || item >= size || seen.has(item)) {
      throw new RangeError(`ranking order contains an invalid item ${item}`);
    }
    seen.add(item);
    answer.push(labelForItem(item));
  }
  return answer;
}

export interface RankingPermutationSolutions {
  readonly solutions: readonly (readonly number[])[];
  readonly enumeratedStates: number;
}

export function solveRankingPermutations(
  size: RankingSize,
  clues: readonly RankingClue[],
): RankingPermutationSolutions {
  const expectedStates = countPermutations(size);
  const enumeration = collectPermutations(itemIds(size), {
    maxResults: expectedStates,
  });
  if (!enumeration.complete || enumeration.visited !== expectedStates) {
    throw new SolverLimitError(expectedStates, enumeration.visited + 1);
  }
  const solutions = enumeration.items.filter((order) => {
    const positions = positionsOf(order);
    return clues.every((clue) => clueSatisfied(clue, positions));
  });
  return { solutions, enumeratedStates: enumeration.visited };
}
