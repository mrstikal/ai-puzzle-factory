import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import {
  formatFactId,
  type Fact,
  type FamilyEngine,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizeCountingSpec } from "./canonical.js";
import {
  COUNTING_GRID_SIZE,
  CountingAnswerSchema,
  CountingSpecSchema,
  countQueryByMembership,
  countQueryBySets,
  inclusionExclusionUnion,
  membershipMaskGrid,
  queryKey,
  shapeKey,
  shapeMembershipCounts,
  sortCountingCells,
  summaryCounts,
  type CountingAnswer,
  type CountingCell,
  type CountingOperation,
  type CountingQuery,
  type CountingShape,
  type CountingSpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_CONSTRUCTION_ATTEMPTS = 16;

interface ShapeRange {
  readonly count: 2 | 3;
  readonly min: number;
  readonly max: number;
}

const SHAPE_RANGE_BY_DIFFICULTY: Readonly<Record<Difficulty, ShapeRange>> = {
  1: { count: 2, min: 3, max: 5 },
  2: { count: 2, min: 6, max: 8 },
  3: { count: 3, min: 4, max: 8 },
};

export type CountingConstructionErrorCode =
  | "DRAW_LIMIT"
  | "CONSTRAINTS_FAILED"
  | "INVALID_DIFFICULTY";

export class CountingConstructionError extends Error {
  readonly code: CountingConstructionErrorCode;

  constructor(
    code: CountingConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CountingConstructionError";
    this.code = code;
  }
}

export type CountingEngineErrorCode =
  | "INVALID_ANSWER"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET"
  | "INCONSISTENT_COUNTS";

export class CountingEngineError extends Error {
  readonly code: CountingEngineErrorCode;

  constructor(code: CountingEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CountingEngineError";
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
      throw new CountingConstructionError(
        "DRAW_LIMIT",
        `counting construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }
}

function pick<T>(draw: DrawBudget, items: readonly T[], description: string): T {
  const selected = items[draw.nextInt(items.length)];
  if (selected === undefined) {
    throw new CountingConstructionError(
      "CONSTRAINTS_FAILED",
      `counting construction could not draw ${description}`,
    );
  }
  return selected;
}

function drawConnectedShape(
  draw: DrawBudget,
  anchor: CountingCell,
  targetSize: number,
): readonly CountingCell[] {
  const cells = new Map<string, CountingCell>();
  cells.set(`${anchor.row}:${anchor.column}`, anchor);
  while (cells.size < targetSize) {
    const frontier = new Map<string, CountingCell>();
    for (const cell of cells.values()) {
      for (const neighbor of [
        { row: cell.row - 1, column: cell.column },
        { row: cell.row + 1, column: cell.column },
        { row: cell.row, column: cell.column - 1 },
        { row: cell.row, column: cell.column + 1 },
      ]) {
        if (
          neighbor.row < 0 ||
          neighbor.row >= COUNTING_GRID_SIZE ||
          neighbor.column < 0 ||
          neighbor.column >= COUNTING_GRID_SIZE
        ) {
          continue;
        }
        const key = `${neighbor.row}:${neighbor.column}`;
        if (!cells.has(key)) {
          frontier.set(key, neighbor);
        }
      }
    }
    const candidates = [...frontier.values()].sort(
      (left, right) =>
        left.row - right.row || left.column - right.column,
    );
    if (candidates.length === 0) {
      throw new CountingConstructionError(
        "CONSTRAINTS_FAILED",
        "connected counting-shape growth has no available neighbor",
      );
    }
    const next = candidates[draw.nextInt(candidates.length)];
    if (next === undefined) {
      throw new CountingConstructionError(
        "CONSTRAINTS_FAILED",
        "connected counting-shape growth failed to select a neighbor",
      );
    }
    cells.set(`${next.row}:${next.column}`, next);
  }
  return sortCountingCells([...cells.values()]);
}

function drawQuery(
  draw: DrawBudget,
  difficulty: Difficulty,
): CountingQuery {
  if (difficulty === 1) {
    return { operation: "unionCount" };
  }
  if (difficulty === 2) {
    return {
      operation: pick(
        draw,
        ["intersectionAll", "exactlyOneShape"] as const,
        "a level-2 counting query",
      ),
    };
  }
  const operation = pick(
    draw,
    ["intersectionAll", "exactlyKShapes"] as const,
    "a level-3 counting query",
  );
  if (operation === "intersectionAll") {
    return { operation };
  }
  return {
    operation,
    k: pick(draw, [2, 3] as const, "a membership count k"),
  };
}

export interface CountingConstructionTrace {
  readonly difficulty: Difficulty;
  readonly attempts: number;
  readonly shapeCount: 2 | 3;
  readonly shapeSizes: readonly number[];
  readonly query: CountingQuery;
  readonly answer: CountingAnswer;
  readonly overlapCount: number;
  readonly exclusiveCount: number;
  readonly drawsUsed: number;
}

export interface CountingConstructionResult {
  readonly spec: CountingSpec;
  readonly trace: CountingConstructionTrace;
}

export function tryBuildCountingSpec(
  shapes: readonly CountingShape[],
  query: CountingQuery,
): CountingSpec | undefined {
  const parsed = CountingSpecSchema.safeParse({
    shapes: shapes.map((shape) => ({ cells: [...shape.cells] })),
    query,
  });
  return parsed.success ? parsed.data : undefined;
}

export function constructCountingSpec(
  seed: string,
  difficulty: Difficulty,
): CountingConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new CountingConstructionError(
      "INVALID_DIFFICULTY",
      `counting difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const range = SHAPE_RANGE_BY_DIFFICULTY[difficulty];
  let attempts = 0;
  while (attempts < MAX_CONSTRUCTION_ATTEMPTS) {
    attempts += 1;
    const anchorIndex = draw.nextInt(COUNTING_GRID_SIZE * COUNTING_GRID_SIZE);
    const anchor = {
      row: Math.floor(anchorIndex / COUNTING_GRID_SIZE),
      column: anchorIndex % COUNTING_GRID_SIZE,
    };
    const shapes: Array<{ cells: CountingCell[] }> = [];
    for (let index = 0; index < range.count; index += 1) {
      const targetSize =
        range.min + draw.nextInt(range.max - range.min + 1);
      shapes.push({
        cells: [...drawConnectedShape(draw, anchor, targetSize)],
      });
    }
    if (new Set(shapes.map((shape) => shapeKey(shape))).size !== shapes.length) {
      continue;
    }
    const query = drawQuery(draw, difficulty);
    const spec = tryBuildCountingSpec(shapes, query);
    if (spec === undefined) {
      continue;
    }
    const answer = solveCounting(spec);
    const counts = shapeMembershipCounts(spec);
    let overlapCount = 0;
    let exclusiveCount = 0;
    for (const row of counts) {
      for (const count of row) {
        if (count >= 2) {
          overlapCount += 1;
        }
        if (count === 1) {
          exclusiveCount += 1;
        }
      }
    }
    return {
      spec,
      trace: {
        difficulty,
        attempts,
        shapeCount: range.count,
        shapeSizes: shapes.map((shape) => shape.cells.length),
        query,
        answer,
        overlapCount,
        exclusiveCount,
        drawsUsed: draw.used,
      },
    };
  }
  throw new CountingConstructionError(
    "CONSTRAINTS_FAILED",
    `counting construction failed after ${attempts} bounded attempts`,
  );
}

function queryDescription(query: CountingQuery): string {
  switch (query.operation) {
    case "unionCount":
      return "cells that belong to at least one shape";
    case "intersectionAll":
      return "cells that belong to all shapes";
    case "exactlyOneShape":
      return "cells that belong to exactly one shape";
    case "exactlyKShapes":
      return `cells that belong to exactly ${query.k} shapes`;
    default:
      return String(query.operation);
  }
}

function solveCounting(spec: CountingSpec): CountingAnswer {
  const parsed = CountingSpecSchema.parse(spec);
  const byMembership = countQueryByMembership(parsed);
  const bySets = countQueryBySets(parsed);
  if (byMembership !== bySets) {
    throw new CountingEngineError(
      "INCONSISTENT_COUNTS",
      `counting methods disagree: membership ${byMembership}, sets ${bySets}`,
    );
  }
  return byMembership;
}

function enumerateSolutions(spec: CountingSpec): SolveResult<CountingAnswer> {
  const parsed = CountingSpecSchema.parse(spec);
  const answer = solveCounting(parsed);
  const summary = summaryCounts(parsed);
  const facts: Fact[] = [
    {
      factId: "s001",
      kind: "derived",
      text: `The query ${parsed.query.operation} counts ${queryDescription(parsed.query)}: ${answer}.`,
    },
    {
      factId: "s002",
      kind: "derived",
      text:
        `Union=${summary.union}; intersectionAll=${summary.intersectionAll}; ` +
        `exactlyOne=${summary.exactlyOne}; exactlyK2=${summary.exactlyK2}` +
        (summary.exactlyK3 === undefined ? "" : `; exactlyK3=${summary.exactlyK3}`) +
        ".",
    },
  ];
  return {
    solutionCount: 1,
    answerCount: 1,
    correctAnswer: answer,
    proof: {
      facts,
      witness: answer,
    },
    enumeratedStates: COUNTING_GRID_SIZE * COUNTING_GRID_SIZE,
    checkerVersion: "counting-v1",
  };
}

function verifyAnswer(spec: CountingSpec, answer: CountingAnswer): boolean {
  const parsed = CountingSpecSchema.safeParse(spec);
  const parsedAnswer = CountingAnswerSchema.safeParse(answer);
  if (!parsed.success || !parsedAnswer.success) {
    return false;
  }
  const byMembership = countQueryByMembership(parsed.data);
  const bySets = countQueryBySets(parsed.data);
  return byMembership === bySets && parsedAnswer.data === byMembership;
}

function makeOptions(
  spec: CountingSpec,
  answer: CountingAnswer,
  seed: string,
): ChoiceSet<CountingAnswer> {
  const parsed = CountingSpecSchema.parse(spec);
  const correct = solveCounting(parsed);
  if (!deepEqual(correct, answer)) {
    throw new CountingEngineError(
      "INVALID_ANSWER",
      "counting options require the independently computed query answer",
    );
  }
  const summary = summaryCounts(parsed);
  const candidates = new Set<number>();
  for (const value of [
    summary.union,
    summary.intersectionAll,
    summary.exactlyOne,
    summary.exactlyK2,
    summary.exactlyK3,
  ]) {
    if (value !== undefined && value !== correct && value >= 0 && value <= 25) {
      candidates.add(value);
    }
  }
  for (const delta of [-1, 1]) {
    const value = correct + delta;
    if (value >= 0 && value <= 25) {
      candidates.add(value);
    }
  }
  const prng = new HashCounterPrng(seed);
  const shuffled = prng.shuffle([...candidates].sort((left, right) => left - right));
  const distractors: number[] = [];
  for (const value of shuffled) {
    if (distractors.length >= 3) {
      break;
    }
    if (value !== correct && !distractors.includes(value)) {
      distractors.push(value);
    }
  }
  if (distractors.length < 3) {
    const domain = Array.from({ length: 26 }, (_, value) => value);
    for (const value of prng.shuffle(domain)) {
      if (distractors.length >= 3) {
        break;
      }
      if (value !== correct && !distractors.includes(value)) {
        distractors.push(value);
      }
    }
  }
  if (distractors.length < 3) {
    throw new CountingEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "counting option construction could not find three distinct integers",
    );
  }
  const first = distractors[0];
  const second = distractors[1];
  const third = distractors[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new CountingEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "counting option construction lost a distinct integer",
    );
  }
  const choices = makeChoiceSet({
    correct,
    distractors: [first, second, third],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    if (choice.value === correct) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new CountingEngineError(
      "INVALID_OPTION_SET",
      `counting option set contains ${trueChoices} satisfying integers`,
    );
  }
  return choices;
}

function visibleRules(spec: CountingSpec): VisibleRules {
  const parsed = CountingSpecSchema.parse(spec);
  return {
    domain:
      "A fixed 5x5 universe contains two or three named shapes A/B/C. Each shape is 3 to 8 unique orthogonally connected cells. Shapes are distinct and include at least one overlapping cell and one exclusive cell.",
    closedWorld:
      "Count whole cells only. Boundaries, outlines, glyphs, subcell areas, and individual shape memberships do not count separately. A cell contributes once when its membership count matches the query.",
    target: `Count the ${queryDescription(parsed.query)}.`,
    operations: [
      "unionCount: count cells belonging to at least one shape.",
      "intersectionAll: count cells belonging to every shape.",
      "exactlyOneShape: count cells belonging to exactly one shape.",
      "exactlyKShapes(k): count cells belonging to exactly k shapes; k is 2 or 3 and cannot exceed the number of shapes.",
    ],
    conventions: [
      "Shapes are labeled A, B, and C in that order.",
      "Overlapping cells belong to multiple shapes; union counts an overlap once, while membership counts count it once per shape.",
      "The answer is an integer from 0 to 25.",
    ],
  };
}

function facts(spec: CountingSpec): readonly Fact[] {
  const parsed = CountingSpecSchema.parse(spec);
  const observations: string[] = [];
  const labels = ["A", "B", "C"] as const;
  for (const [index, shape] of parsed.shapes.entries()) {
    const label = labels[index] ?? String(index + 1);
    for (const cell of shape.cells) {
      observations.push(
        `Shape ${label} contains cell row ${cell.row + 1}, column ${cell.column + 1}.`,
      );
    }
  }
  return observations.map((text, index) => ({
    factId: formatFactId("observation", index),
    kind: "observation" as const,
    text,
  }));
}

function validQueries(shapeCount: 2 | 3): readonly CountingQuery[] {
  const queries: CountingQuery[] = [
    { operation: "unionCount" },
    { operation: "intersectionAll" },
    { operation: "exactlyOneShape" },
    { operation: "exactlyKShapes", k: 2 },
  ];
  if (shapeCount === 3) {
    queries.push({ operation: "exactlyKShapes", k: 3 });
  }
  return queries;
}

function testMutations(spec: CountingSpec): readonly TestMutation<CountingSpec>[] {
  const parsed = CountingSpecSchema.parse(spec);
  const currentKey = queryKey(parsed.query);
  const alternatives = validQueries(parsed.shapes.length as 2 | 3).filter(
    (query) => queryKey(query) !== currentKey,
  );
  const first = alternatives[0];
  const second = alternatives[1];
  if (first === undefined || second === undefined) {
    throw new CountingEngineError(
      "INVALID_OPTION_SET",
      "counting mutation construction needs two alternative queries",
    );
  }
  return [
    {
      id: "alternate-query",
      description: "the counting query operation changes",
      spec: CountingSpecSchema.parse({ shapes: parsed.shapes, query: first }),
    },
    {
      id: "alternate-query-mode",
      description: "the counting query changes to a second alternative",
      spec: CountingSpecSchema.parse({ shapes: parsed.shapes, query: second }),
    },
  ];
}

export const countingEngine: FamilyEngine<CountingSpec, CountingAnswer> = {
  family: "counting",
  modality: "svg",
  schema: CountingSpecSchema,
  generateSpec(seed, difficulty) {
    return constructCountingSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeCountingSpec(spec);
  },
  testMutations,
};

export {
  countQueryByMembership,
  countQueryBySets,
  inclusionExclusionUnion,
  membershipMaskGrid,
  shapeMembershipCounts,
  summaryCounts,
  type CountingAnswer,
  type CountingCell,
  type CountingOperation,
  type CountingQuery,
  type CountingSpec,
};
