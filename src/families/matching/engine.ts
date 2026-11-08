import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import { SolverLimitError, collectPermutations } from "../canonicalize.js";
import {
  formatFactId,
  type Fact,
  type FamilyEngine,
  type FamilySolutionDiagnostics,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizeMatchingSpec } from "./canonical.js";
import {
  MATCHING_ITEM_IDS,
  MatchingSpecSchema,
  MatchingTableSchema,
  assignmentToTable,
  clueKey,
  clueSatisfied,
  clueText,
  matchingItemLabel,
  matchingPairSame,
  matchingSwapDistance,
  matchingViolationCount,
  solveMatchingPermutations,
  tableToAssignment,
  type MatchingAnswer,
  type MatchingAssignment,
  type MatchingCategory,
  type MatchingClue,
  type MatchingEndpoint,
  type MatchingSpec,
  type MatchingTable,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const ANCHOR_COUNT = 6;
const MIN_CLUES = 4;
const MAX_CLUES = 12;

export type MatchingConstructionErrorCode =
  | "DRAW_LIMIT"
  | "UNIQUENESS_FAILED"
  | "INVALID_DIFFICULTY";

export class MatchingConstructionError extends Error {
  readonly code: MatchingConstructionErrorCode;

  constructor(
    code: MatchingConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MatchingConstructionError";
    this.code = code;
  }
}

export type MatchingEngineErrorCode =
  | "INVALID_ANSWER"
  | "NOT_UNIQUE"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class MatchingEngineError extends Error {
  readonly code: MatchingEngineErrorCode;

  constructor(code: MatchingEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatchingEngineError";
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
      throw new MatchingConstructionError(
        "DRAW_LIMIT",
        `matching construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
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
        throw new Error("matching shuffle encountered an invalid index");
      }
      copy[index] = replacement;
      copy[swapIndex] = current;
    }
    return copy;
  }

  sampleDistinct<T>(items: readonly T[], count: number): T[] {
    if (!Number.isInteger(count) || count < 0 || count > items.length) {
      throw new RangeError(`matching sample count ${count} is outside 0..${items.length}`);
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
        throw new Error("matching sample encountered an invalid index");
      }
      selected.push(chosen);
      pool[pick] = last;
      pool[lastIndex] = chosen;
    }
    return selected;
  }
}

function endpoint(category: MatchingCategory, item: number): MatchingEndpoint {
  return { category, item };
}

function sameClue(left: MatchingEndpoint, right: MatchingEndpoint): MatchingClue {
  return { kind: "same", left, right };
}

function differentClue(left: MatchingEndpoint, right: MatchingEndpoint): MatchingClue {
  return { kind: "different", left, right };
}

function isCrossCategory(clue: MatchingClue): boolean {
  return (
    (clue.left.category === "B" && clue.right.category === "C") ||
    (clue.left.category === "C" && clue.right.category === "B")
  );
}

function buildTruePool(assignment: MatchingAssignment): MatchingClue[] {
  const pairs: ReadonlyArray<readonly [MatchingCategory, MatchingCategory]> = [
    ["A", "B"],
    ["A", "C"],
    ["B", "C"],
  ];
  const pool: MatchingClue[] = [];
  for (const [leftCategory, rightCategory] of pairs) {
    for (const leftItem of MATCHING_ITEM_IDS) {
      for (const rightItem of MATCHING_ITEM_IDS) {
        const left = endpoint(leftCategory, leftItem);
        const right = endpoint(rightCategory, rightItem);
        pool.push(
          matchingPairSame(assignment, left, right)
            ? sameClue(left, right)
            : differentClue(left, right),
        );
      }
    }
  }
  return pool;
}

function anchorClues(assignment: MatchingAssignment): MatchingClue[] {
  const anchors: MatchingClue[] = [];
  for (let item = 0; item < 3; item += 1) {
    const bItem = assignment.bByA[item];
    const cItem = assignment.cByA[item];
    if (bItem === undefined || cItem === undefined) {
      throw new RangeError("matching witness assignment is incomplete");
    }
    anchors.push(sameClue(endpoint("A", item), endpoint("B", bItem)));
    anchors.push(sameClue(endpoint("A", item), endpoint("C", cItem)));
  }
  return anchors;
}

function sameAssignment(
  left: MatchingAssignment,
  right: MatchingAssignment,
): boolean {
  return deepEqual(left.bByA, right.bByA) && deepEqual(left.cByA, right.cByA);
}

export interface MatchingConstructionTrace {
  readonly anchorCount: number;
  readonly crossCategoryAdded: number;
  readonly additionalRequested: number;
  readonly additionalAdded: number;
  readonly prunedClues: number;
  readonly clueCountBeforePruning: number;
  readonly clueCountAfterPruning: number;
  readonly drawsUsed: number;
}

export interface MatchingConstructionResult {
  readonly spec: MatchingSpec;
  readonly trace: MatchingConstructionTrace;
}

export function constructMatchingSpec(
  seed: string,
  difficulty: Difficulty,
): MatchingConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new MatchingConstructionError(
      "INVALID_DIFFICULTY",
      `matching difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const bByA = draw.shuffle(MATCHING_ITEM_IDS);
  const cByA = draw.shuffle(MATCHING_ITEM_IDS);
  const witness: MatchingAssignment = { bByA, cByA };
  const truePool = buildTruePool(witness);
  const anchors = anchorClues(witness);
  const anchorKeys = new Set(anchors.map(clueKey));

  const bCSamePool = truePool.filter(
    (clue) => isCrossCategory(clue) && clue.kind === "same",
  );
  const bCDifferentPool = truePool.filter(
    (clue) => isCrossCategory(clue) && clue.kind === "different",
  );
  const otherPool = truePool.filter(
    (clue) => !isCrossCategory(clue) && !anchorKeys.has(clueKey(clue)),
  );

  const additionalRequested = 4 + draw.nextInt(3);
  const bCSame = draw.sampleDistinct(bCSamePool, 1);
  const bCDifferent = draw.sampleDistinct(bCDifferentPool, 1);
  const otherCount = additionalRequested - 2;
  const otherSelected = draw.sampleDistinct(otherPool, otherCount);
  let clues: MatchingClue[] = [
    ...anchors,
    ...bCSame,
    ...bCDifferent,
    ...otherSelected,
  ];
  const clueCountBeforePruning = clues.length;
  const floor = difficulty === 1 ? 8 : difficulty === 2 ? 6 : 4;

  const pruneOrder = draw.shuffle(clues.map((_clue, index) => index));
  const retained = new Set<number>(clues.map((_clue, index) => index));
  const removalOrder: number[] = [];
  for (const index of pruneOrder) {
    if (retained.size <= floor) {
      break;
    }
    if (!retained.has(index)) {
      continue;
    }
    const candidate = [...retained]
      .filter((candidateIndex) => candidateIndex !== index)
      .sort((left, right) => left - right)
      .map((candidateIndex) => clues[candidateIndex] as MatchingClue);
    const solved = solveMatchingPermutations(candidate);
    const solution = solved.solutions[0];
    if (
      solved.solutions.length === 1 &&
      solution !== undefined &&
      sameAssignment(solution, witness)
    ) {
      retained.delete(index);
      removalOrder.push(index);
    }
  }
  clues = [...retained]
    .sort((left, right) => left - right)
    .map((index) => clues[index] as MatchingClue);

  const finalSolved = solveMatchingPermutations(clues);
  const finalSolution = finalSolved.solutions[0];
  if (
    finalSolved.solutions.length !== 1 ||
    finalSolution === undefined ||
    !sameAssignment(finalSolution, witness)
  ) {
    throw new MatchingConstructionError(
      "UNIQUENESS_FAILED",
      "matching construction did not retain the intended unique table",
    );
  }
  if (clues.length < MIN_CLUES || clues.length > MAX_CLUES) {
    throw new MatchingConstructionError(
      "UNIQUENESS_FAILED",
      `matching construction produced ${clues.length} clues outside ${MIN_CLUES}..${MAX_CLUES}`,
    );
  }

  const spec = MatchingSpecSchema.parse({ clues });
  return {
    spec,
    trace: {
      anchorCount: ANCHOR_COUNT,
      crossCategoryAdded: bCSame.length + bCDifferent.length,
      additionalRequested,
      additionalAdded: bCSame.length + bCDifferent.length + otherSelected.length,
      prunedClues: removalOrder.length,
      clueCountBeforePruning,
      clueCountAfterPruning: spec.clues.length,
      drawsUsed: draw.used,
    },
  };
}

function tableText(table: MatchingTable): string {
  return table
    .map(
      (row) =>
        `${matchingItemLabel("A", row.a)}-${matchingItemLabel("B", row.b)}-${matchingItemLabel("C", row.c)}`,
    )
    .join("; ");
}

function enumerateSolutions(spec: MatchingSpec): SolveResult<MatchingAnswer> {
  const parsed = MatchingSpecSchema.parse(spec);
  const solved = solveMatchingPermutations(parsed.clues);
  const solution = solved.solutions.length === 1 ? solved.solutions[0] : undefined;
  const table = solution === undefined ? null : assignmentToTable(solution);
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    correctAnswer: table,
    proof:
      table === null
        ? null
        : {
            facts: [
              {
                factId: "s001",
                kind: "derived",
                text: `The unique table is ${tableText(table)}.`,
              },
            ],
            witness: table,
          },
    enumeratedStates: solved.enumeratedStates,
    checkerVersion: "matching-v1",
  };
}

function verifyAnswer(spec: MatchingSpec, answer: MatchingAnswer): boolean {
  const parsed = MatchingSpecSchema.parse(spec);
  const table = MatchingTableSchema.safeParse(answer);
  if (!table.success) {
    return false;
  }
  const assignment = tableToAssignment(table.data);
  return parsed.clues.every((clue) => clueSatisfied(clue, assignment));
}

function makeOptions(
  spec: MatchingSpec,
  answer: MatchingAnswer,
  seed: string,
): ChoiceSet<MatchingAnswer> {
  const parsed = MatchingSpecSchema.parse(spec);
  const solvedSpec = solveMatchingPermutations(parsed.clues);
  const uniqueAssignment =
    solvedSpec.solutions.length === 1 ? solvedSpec.solutions[0] : undefined;
  if (uniqueAssignment === undefined) {
    throw new MatchingEngineError(
      "NOT_UNIQUE",
      `matching options require one full table, received ${solvedSpec.solutions.length}`,
    );
  }
  const correctTable = assignmentToTable(uniqueAssignment);
  const suppliedTable = MatchingTableSchema.safeParse(answer);
  if (!suppliedTable.success || !deepEqual(suppliedTable.data, correctTable)) {
    throw new MatchingEngineError(
      "INVALID_ANSWER",
      "matching options require the unique satisfying table",
    );
  }

  const perms = collectPermutations(MATCHING_ITEM_IDS, { maxResults: 24 });
  if (!perms.complete || perms.visited !== 24) {
    throw new SolverLimitError(24, perms.visited + 1);
  }
  const preferred: MatchingTable[] = [];
  const fallback: MatchingTable[] = [];
  for (const bByA of perms.items) {
    for (const cByA of perms.items) {
      const assignment: MatchingAssignment = { bByA, cByA };
      if (matchingViolationCount(parsed.clues, assignment) === 0) {
        continue;
      }
      const table = assignmentToTable(assignment);
      const distance = matchingSwapDistance(uniqueAssignment, assignment);
      if (distance === 1 || distance === 2) {
        preferred.push(table);
      } else {
        fallback.push(table);
      }
    }
  }

  const prng = new HashCounterPrng(seed);
  const ordered = [...prng.shuffle(preferred), ...prng.shuffle(fallback)];
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new MatchingEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "matching spec has fewer than three false complete tables",
    );
  }
  const choices = makeChoiceSet({
    correct: correctTable,
    distractors: [first, second, third] as [
      MatchingAnswer,
      MatchingAnswer,
      MatchingAnswer,
    ],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    const table = MatchingTableSchema.safeParse(choice.value);
    if (table.success && verifyAnswer(parsed, table.data)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new MatchingEngineError(
      "INVALID_OPTION_SET",
      `matching option set contains ${trueChoices} satisfying tables`,
    );
  }
  return choices;
}

function visibleRules(spec: MatchingSpec): VisibleRules {
  MatchingSpecSchema.parse(spec);
  return {
    domain:
      "Three typed categories A, B, and C each contain four items labeled A1-A4, B1-B4, and C1-C4.",
    closedWorld:
      "Every A, B, and C item is used exactly once. Each row contains one item from each category, and every B and C item is paired with exactly one A item.",
    target:
      "Determine the complete four-row table pairing each A item with its B and C items.",
    operations: [
      "same(x,y): the two items appear in the same row.",
      "different(x,y): the two items do not appear in the same row.",
    ],
    conventions: [
      "Rows are ordered by A1..A4.",
      "A table is complete only when every category item appears exactly once.",
    ],
  };
}

function facts(spec: MatchingSpec): readonly Fact[] {
  const parsed = MatchingSpecSchema.parse(spec);
  return parsed.clues.map((clue, index) => ({
    factId: formatFactId("local", index),
    kind: "local" as const,
    text: clueText(clue),
  }));
}

function testMutations(_spec: MatchingSpec): readonly TestMutation<MatchingSpec>[] {
  return [
    {
      id: "impossible-a-to-b",
      description: "one A item is different from every B item",
      spec: MatchingSpecSchema.parse({
        clues: [
          differentClue(endpoint("A", 0), endpoint("B", 0)),
          differentClue(endpoint("A", 0), endpoint("B", 1)),
          differentClue(endpoint("A", 0), endpoint("B", 2)),
          differentClue(endpoint("A", 0), endpoint("B", 3)),
        ],
      }),
    },
    {
      id: "ambiguous-c-unconstrained",
      description: "the A-to-B bijection is fixed but C is free",
      spec: MatchingSpecSchema.parse({
        clues: [
          sameClue(endpoint("A", 0), endpoint("B", 0)),
          sameClue(endpoint("A", 1), endpoint("B", 1)),
          sameClue(endpoint("A", 2), endpoint("B", 2)),
          sameClue(endpoint("A", 3), endpoint("B", 3)),
        ],
      }),
    },
    {
      id: "cross-category-negative",
      description: "a true B-C negative clue refines a six-anchor table",
      spec: MatchingSpecSchema.parse({
        clues: [
          sameClue(endpoint("A", 0), endpoint("B", 0)),
          sameClue(endpoint("A", 1), endpoint("B", 1)),
          sameClue(endpoint("A", 2), endpoint("B", 2)),
          sameClue(endpoint("A", 0), endpoint("C", 0)),
          sameClue(endpoint("A", 1), endpoint("C", 1)),
          sameClue(endpoint("A", 2), endpoint("C", 2)),
          differentClue(endpoint("B", 0), endpoint("C", 1)),
        ],
      }),
    },
    {
      id: "redundant-implied",
      description: "an implied A3-B3 clue is redundant with the six anchors",
      spec: MatchingSpecSchema.parse({
        clues: [
          sameClue(endpoint("A", 0), endpoint("B", 0)),
          sameClue(endpoint("A", 1), endpoint("B", 1)),
          sameClue(endpoint("A", 2), endpoint("B", 2)),
          sameClue(endpoint("A", 0), endpoint("C", 0)),
          sameClue(endpoint("A", 1), endpoint("C", 1)),
          sameClue(endpoint("A", 2), endpoint("C", 2)),
          sameClue(endpoint("A", 3), endpoint("B", 3)),
        ],
      }),
    },
  ];
}

export function diagnoseMatchingSolutions(
  spec: MatchingSpec,
): FamilySolutionDiagnostics<MatchingAnswer> {
  const parsed = MatchingSpecSchema.parse(spec);
  const solved = solveMatchingPermutations(parsed.clues);
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    witnesses: solved.solutions.slice(0, 2).map(assignmentToTable),
    complete: true,
    enumeratedStates: solved.enumeratedStates,
  };
}

export const matchingEngine: FamilyEngine<MatchingSpec, MatchingAnswer> = {
  family: "matching",
  modality: "text",
  schema: MatchingSpecSchema,
  generateSpec(seed, difficulty) {
    return constructMatchingSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeMatchingSpec(spec);
  },
  testMutations,
};
