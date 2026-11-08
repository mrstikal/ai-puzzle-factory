import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import {
  SolverLimitError,
  collectPermutations,
  countPermutations,
} from "../canonicalize.js";
import {
  formatFactId,
  type Fact,
  type FamilyEngine,
  type FamilySolutionDiagnostics,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizeRankingSpec } from "./canonical.js";
import {
  RankingSpecSchema,
  answerToItemOrder,
  clueSatisfied,
  clueText,
  itemIds,
  itemOrderToAnswer,
  labelsForSize,
  positionsOf,
  rankingViolationCount,
  solveRankingPermutations,
  type RankingAnswer,
  type RankingClue,
  type RankingSize,
  type RankingSpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_ANCHORS = 5;
const MIN_CLUES = 3;
const MAX_CLUES = 12;

export type RankingConstructionErrorCode =
  | "DRAW_LIMIT"
  | "UNIQUENESS_FAILED"
  | "INVALID_DIFFICULTY";

export class RankingConstructionError extends Error {
  readonly code: RankingConstructionErrorCode;

  constructor(
    code: RankingConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RankingConstructionError";
    this.code = code;
  }
}

export type RankingEngineErrorCode =
  | "INVALID_ANSWER"
  | "NOT_UNIQUE"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class RankingEngineError extends Error {
  readonly code: RankingEngineErrorCode;

  constructor(code: RankingEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RankingEngineError";
    this.code = code;
  }
}

class DrawBudget {
  private readonly prng: HashCounterPrng;
  private draws = 0;

  constructor(prng: HashCounterPrng) {
    this.prng = prng;
  }

  get used(): number {
    return this.draws;
  }

  nextInt(maxExclusive: number): number {
    if (this.draws >= MAX_CONSTRUCTION_DRAWS) {
      throw new RankingConstructionError(
        "DRAW_LIMIT",
        `ranking construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextInt(index + 1);
      const current = copy[index];
      const replacement = copy[swapIndex];
      if (current === undefined || replacement === undefined) {
        throw new Error("ranking shuffle encountered an invalid index");
      }
      copy[index] = replacement;
      copy[swapIndex] = current;
    }
    return copy;
  }

  sampleDistinct<T>(items: readonly T[], count: number): T[] {
    if (!Number.isInteger(count) || count < 0 || count > items.length) {
      throw new RangeError(
        `ranking sample count ${count} is outside 0..${items.length}`,
      );
    }
    const pool = [...items];
    const selected: T[] = [];
    for (let index = 0; index < count; index += 1) {
      const remaining = pool.length - index;
      const pick = this.nextInt(remaining);
      const chosen = pool[pick];
      const lastIndex = pool.length - 1 - index;
      const last = pool[lastIndex];
      if (chosen === undefined || last === undefined) {
        throw new Error("ranking sample encountered an invalid index");
      }
      selected.push(chosen);
      pool[pick] = last;
      pool[lastIndex] = chosen;
    }
    return selected;
  }
}

function sameOrder(left: readonly number[], right: readonly number[]): boolean {
  return deepEqual(left, right);
}

function buildNonAnchorPool(
  size: RankingSize,
  witness: readonly number[],
): RankingClue[] {
  const positions = positionsOf(witness);
  const pool: RankingClue[] = [];
  for (const first of itemIds(size)) {
    for (const second of itemIds(size)) {
      if (first === second) {
        continue;
      }
      const firstPosition = positions.get(first);
      const secondPosition = positions.get(second);
      if (
        firstPosition !== undefined &&
        secondPosition !== undefined &&
        firstPosition < secondPosition
      ) {
        pool.push({ kind: "before", before: first, after: second });
      }
    }
  }
  for (let index = 0; index + 1 < witness.length; index += 1) {
    const first = witness[index];
    const second = witness[index + 1];
    if (first !== undefined && second !== undefined) {
      pool.push({ kind: "immediatelyBefore", before: first, after: second });
    }
  }
  for (const item of itemIds(size)) {
    const itemPosition = positions.get(item);
    for (let position = 1; position <= size; position += 1) {
      if (itemPosition !== position) {
        pool.push({ kind: "notAt", item, position });
      }
    }
  }
  return pool;
}

function buildAtPool(witness: readonly number[]): RankingClue[] {
  return witness.map((item, index) => ({
    kind: "at" as const,
    item,
    position: index + 1,
  }));
}

export interface RankingConstructionTrace {
  readonly nonAnchorRequested: number;
  readonly nonAnchorAdded: number;
  readonly anchorsAdded: number;
  readonly prunedClues: number;
  readonly clueCountBeforePruning: number;
  readonly clueCountAfterPruning: number;
  readonly drawsUsed: number;
}

export interface RankingConstructionResult {
  readonly spec: RankingSpec;
  readonly trace: RankingConstructionTrace;
}

export function constructRankingSpec(
  seed: string,
  difficulty: Difficulty,
): RankingConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new RankingConstructionError(
      "INVALID_DIFFICULTY",
      `ranking difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const size: RankingSize = difficulty === 1 ? 4 : 5;
  const witness = draw.shuffle(itemIds(size));
  const nonAnchorPool = buildNonAnchorPool(size, witness);
  const atPool = buildAtPool(witness);

  const nonAnchorRequested = 3 + draw.nextInt(5);
  const nonAnchors = draw.sampleDistinct(nonAnchorPool, nonAnchorRequested);
  let clues: RankingClue[] = [...nonAnchors];
  const anchorOrder = draw.shuffle(atPool);
  let anchorsAdded = 0;

  for (;;) {
    const solved = solveRankingPermutations(size, clues);
    if (solved.solutions.length === 1) {
      break;
    }
    if (solved.solutions.length === 0) {
      throw new RankingConstructionError(
        "UNIQUENESS_FAILED",
        "true ranking clues unexpectedly produced no solution",
      );
    }
    if (anchorsAdded >= MAX_ANCHORS || anchorsAdded >= anchorOrder.length) {
      throw new RankingConstructionError(
        "UNIQUENESS_FAILED",
        "ranking clues did not become unique within the anchor cap",
      );
    }
    const anchor = anchorOrder[anchorsAdded];
    if (anchor === undefined) {
      throw new RankingConstructionError(
        "UNIQUENESS_FAILED",
        "ranking anchor list ended unexpectedly",
      );
    }
    clues.push(anchor);
    anchorsAdded += 1;
  }

  const clueCountBeforePruning = clues.length;
  let prunedClues = 0;
  if (difficulty >= 2) {
    const pruneOrder = draw.shuffle(clues.map((_clue, index) => index));
    const retained = new Set<number>(clues.map((_clue, index) => index));
    const removalOrder: number[] = [];
    for (const index of pruneOrder) {
      if (retained.size <= MIN_CLUES) {
        break;
      }
      if (!retained.has(index)) {
        continue;
      }
      const candidate = [...retained]
        .filter((candidateIndex) => candidateIndex !== index)
        .sort((left, right) => left - right)
        .map((candidateIndex) => clues[candidateIndex] as RankingClue);
      const solved = solveRankingPermutations(size, candidate);
      const solution = solved.solutions[0];
      if (
        solved.solutions.length === 1 &&
        solution !== undefined &&
        sameOrder(solution, witness)
      ) {
        retained.delete(index);
        removalOrder.push(index);
      }
    }

    const deleteCount =
      difficulty === 2 ? Math.floor(removalOrder.length / 2) : removalOrder.length;
    const finalRetained = new Set<number>(clues.map((_clue, index) => index));
    for (let index = 0; index < deleteCount; index += 1) {
      const removal = removalOrder[index];
      if (removal !== undefined) {
        finalRetained.delete(removal);
      }
    }
    clues = [...finalRetained]
      .sort((left, right) => left - right)
      .map((index) => clues[index] as RankingClue);
    prunedClues = deleteCount;
  }

  const finalSolved = solveRankingPermutations(size, clues);
  const finalSolution = finalSolved.solutions[0];
  if (
    finalSolved.solutions.length !== 1 ||
    finalSolution === undefined ||
    !sameOrder(finalSolution, witness)
  ) {
    throw new RankingConstructionError(
      "UNIQUENESS_FAILED",
      "ranking construction did not retain the intended unique order",
    );
  }

  if (clues.length < MIN_CLUES || clues.length > MAX_CLUES) {
    throw new RankingConstructionError(
      "UNIQUENESS_FAILED",
      `ranking construction produced ${clues.length} clues outside ${MIN_CLUES}..${MAX_CLUES}`,
    );
  }

  const spec = RankingSpecSchema.parse({ size, clues });
  return {
    spec,
    trace: {
      nonAnchorRequested,
      nonAnchorAdded: nonAnchors.length,
      anchorsAdded,
      prunedClues,
      clueCountBeforePruning,
      clueCountAfterPruning: spec.clues.length,
      drawsUsed: draw.used,
    },
  };
}

function enumerateSolutions(spec: RankingSpec): SolveResult<RankingAnswer> {
  const parsed = RankingSpecSchema.parse(spec);
  const solved = solveRankingPermutations(parsed.size, parsed.clues);
  const solution = solved.solutions.length === 1 ? solved.solutions[0] : undefined;
  const correctAnswer =
    solution === undefined ? null : itemOrderToAnswer(solution, parsed.size);
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    correctAnswer,
    proof:
      correctAnswer === null
        ? null
        : {
            facts: [
              {
                factId: "s001",
                kind: "derived",
                text: `The unique left-to-right order is ${correctAnswer.join(" ")}.`,
              },
            ],
            witness: correctAnswer,
          },
    enumeratedStates: solved.enumeratedStates,
    checkerVersion: "ranking-v1",
  };
}

function verifyAnswer(spec: RankingSpec, answer: RankingAnswer): boolean {
  const parsed = RankingSpecSchema.parse(spec);
  const order = answerToItemOrder(answer, parsed.size);
  if (order === null) {
    return false;
  }
  const positions = positionsOf(order);
  return parsed.clues.every((clue) => clueSatisfied(clue, positions));
}

function makeOptions(
  spec: RankingSpec,
  answer: RankingAnswer,
  seed: string,
): ChoiceSet<RankingAnswer> {
  const parsed = RankingSpecSchema.parse(spec);
  const solvedSpec = solveRankingPermutations(parsed.size, parsed.clues);
  const uniqueOrder =
    solvedSpec.solutions.length === 1 ? solvedSpec.solutions[0] : undefined;
  if (uniqueOrder === undefined) {
    throw new RankingEngineError(
      "NOT_UNIQUE",
      `ranking options require one full order, received ${solvedSpec.solutions.length}`,
    );
  }
  const expectedAnswer = itemOrderToAnswer(uniqueOrder, parsed.size);
  if (!deepEqual(expectedAnswer, answer) || !verifyAnswer(parsed, answer)) {
    throw new RankingEngineError(
      "INVALID_ANSWER",
      "ranking options require the unique satisfying answer",
    );
  }
  const expectedStates = countPermutations(parsed.size);
  const enumeration = collectPermutations(itemIds(parsed.size), {
    maxResults: expectedStates,
  });
  if (!enumeration.complete || enumeration.visited !== expectedStates) {
    throw new SolverLimitError(expectedStates, enumeration.visited + 1);
  }

  const preferred: RankingAnswer[] = [];
  const fallback: RankingAnswer[] = [];
  for (const order of enumeration.items) {
    const violations = rankingViolationCount(parsed.clues, order);
    if (violations === 0) {
      continue;
    }
    const candidate = itemOrderToAnswer(order, parsed.size);
    if (violations === 1 || violations === 2) {
      preferred.push(candidate);
    } else {
      fallback.push(candidate);
    }
  }

  const prng = new HashCounterPrng(seed);
  const ordered = [...prng.shuffle(preferred), ...prng.shuffle(fallback)];
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new RankingEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "ranking spec has fewer than three false full orders",
    );
  }

  const choices = makeChoiceSet({
    correct: answer,
    distractors: [first, second, third] as [RankingAnswer, RankingAnswer, RankingAnswer],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    if (verifyAnswer(parsed, choice.value)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new RankingEngineError(
      "INVALID_OPTION_SET",
      `ranking option set contains ${trueChoices} satisfying choices`,
    );
  }
  return choices;
}

function visibleRules(spec: RankingSpec): VisibleRules {
  const parsed = RankingSpecSchema.parse(spec);
  const labels = labelsForSize(parsed.size);
  const labelList = labels.join(", ");
  return {
    domain: `${parsed.size} distinct items labeled ${labelList} are arranged in one strict left-to-right order.`,
    closedWorld:
      "Every item appears exactly once. Positions increase from left to right, and no two items share a position.",
    target: `Determine the complete left-to-right order of all ${parsed.size} items.`,
    operations: [
      "before(a,b): item a is somewhere to the left of item b.",
      "immediatelyBefore(a,b): item b is immediately to the right of item a.",
      "at(a,position): item a is at the given 1-based position.",
      "notAt(a,position): item a is not at the given 1-based position.",
    ],
    conventions: [
      "Positions are 1-based from left to right.",
      `Options list the complete order from left to right using the fixed labels ${labelList}.`,
    ],
  };
}

function facts(spec: RankingSpec): readonly Fact[] {
  const parsed = RankingSpecSchema.parse(spec);
  return parsed.clues.map((clue, index) => ({
    factId: formatFactId("local", index),
    kind: "local" as const,
    text: clueText(clue),
  }));
}

function testMutations(_spec: RankingSpec): readonly TestMutation<RankingSpec>[] {
  return [
    {
      id: "impossible-cycle",
      description: "three before clues form a directed cycle",
      spec: RankingSpecSchema.parse({
        size: 4,
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 0 },
        ],
      }),
    },
    {
      id: "missing-essential-clue-ambiguity",
      description: "three clues leave several full orders possible",
      spec: RankingSpecSchema.parse({
        size: 4,
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "notAt", item: 3, position: 1 },
        ],
      }),
    },
    {
      id: "adjacency-direction",
      description: "an immediate-before chain fixes one left-to-right order",
      spec: RankingSpecSchema.parse({
        size: 4,
        clues: [
          { kind: "immediatelyBefore", before: 0, after: 1 },
          { kind: "immediatelyBefore", before: 1, after: 2 },
          { kind: "immediatelyBefore", before: 2, after: 3 },
        ],
      }),
    },
    {
      id: "positions",
      description: "four true position anchors fix one left-to-right order",
      spec: RankingSpecSchema.parse({
        size: 4,
        clues: [
          { kind: "at", item: 0, position: 1 },
          { kind: "at", item: 1, position: 2 },
          { kind: "at", item: 2, position: 3 },
          { kind: "at", item: 3, position: 4 },
        ],
      }),
    },
  ];
}

export function diagnoseRankingSolutions(
  spec: RankingSpec,
): FamilySolutionDiagnostics<RankingAnswer> {
  const parsed = RankingSpecSchema.parse(spec);
  const solved = solveRankingPermutations(parsed.size, parsed.clues);
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    witnesses: solved.solutions
      .slice(0, 2)
      .map((order) => itemOrderToAnswer(order, parsed.size)),
    complete: true,
    enumeratedStates: solved.enumeratedStates,
  };
}

export const rankingEngine: FamilyEngine<RankingSpec, RankingAnswer> = {
  family: "ranking",
  modality: "text",
  schema: RankingSpecSchema,
  generateSpec(seed, difficulty) {
    return constructRankingSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeRankingSpec(spec);
  },
  testMutations,
};
