import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import {
  D4_OPERATIONS,
  formatFactId,
  type D4Operation,
  type Fact,
  type FamilyEngine,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizeTransformsSpec } from "./canonical.js";
import {
  MAX_TRANSFORM_CELLS,
  MIN_TRANSFORM_CELLS,
  TRANSFORM_GRID_SIZE,
  TransformsSpecSchema,
  checkTransformAnswer,
  composeD4Sequence,
  gridFromCells,
  sameTransformMask,
  solveTransforms,
  sortTransformCells,
  sourceCellsFromGrid,
  transformCells,
  transformMaskKey,
  type TransformAnswer,
  type TransformCell,
  type TransformsSpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_CONSTRUCTION_ATTEMPTS = 16;

const LEVEL_ONE_ROTATIONS: readonly D4Operation[] = [
  "rotate90",
  "rotate180",
  "rotate270",
];
const LEVEL_THREE_ROTATIONS: readonly D4Operation[] = ["rotate90", "rotate270"];
const REFLECTIONS: readonly D4Operation[] = [
  "reflectLeftRight",
  "reflectTopBottom",
  "reflectMainDiagonal",
  "reflectAntiDiagonal",
];

export type TransformsConstructionErrorCode =
  | "DRAW_LIMIT"
  | "CONSTRAINTS_FAILED"
  | "INVALID_DIFFICULTY";

export class TransformsConstructionError extends Error {
  readonly code: TransformsConstructionErrorCode;

  constructor(
    code: TransformsConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransformsConstructionError";
    this.code = code;
  }
}

export type TransformsEngineErrorCode =
  | "INVALID_ANSWER"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class TransformsEngineError extends Error {
  readonly code: TransformsEngineErrorCode;

  constructor(code: TransformsEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransformsEngineError";
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
      throw new TransformsConstructionError(
        "DRAW_LIMIT",
        `transform construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }
}

function pick<T>(
  draw: DrawBudget,
  items: readonly T[],
  description: string,
): T {
  const selected = items[draw.nextInt(items.length)];
  if (selected === undefined) {
    throw new TransformsConstructionError(
      "CONSTRAINTS_FAILED",
      `transform construction could not draw ${description}`,
    );
  }
  return selected;
}

function drawConnectedSource(draw: DrawBudget): TransformCell[] {
  const targetSize =
    MIN_TRANSFORM_CELLS +
    draw.nextInt(MAX_TRANSFORM_CELLS - MIN_TRANSFORM_CELLS + 1);
  const startIndex = draw.nextInt(TRANSFORM_GRID_SIZE * TRANSFORM_GRID_SIZE);
  const occupied = new Set<number>([startIndex]);
  while (occupied.size < targetSize) {
    const frontier = new Set<number>();
    for (const index of occupied) {
      const row = Math.floor(index / TRANSFORM_GRID_SIZE);
      const column = index % TRANSFORM_GRID_SIZE;
      for (const neighbor of [
        { row: row - 1, column },
        { row: row + 1, column },
        { row, column: column - 1 },
        { row, column: column + 1 },
      ]) {
        if (
          neighbor.row < 0 ||
          neighbor.row >= TRANSFORM_GRID_SIZE ||
          neighbor.column < 0 ||
          neighbor.column >= TRANSFORM_GRID_SIZE
        ) {
          continue;
        }
        const neighborIndex = neighbor.row * TRANSFORM_GRID_SIZE + neighbor.column;
        if (!occupied.has(neighborIndex)) {
          frontier.add(neighborIndex);
        }
      }
    }
    const candidates = [...frontier].sort((left, right) => left - right);
    if (candidates.length === 0) {
      throw new TransformsConstructionError(
        "CONSTRAINTS_FAILED",
        "connected transform growth has no available neighbor",
      );
    }
    const selected = candidates[draw.nextInt(candidates.length)];
    if (selected === undefined) {
      throw new TransformsConstructionError(
        "CONSTRAINTS_FAILED",
        "connected transform growth failed to select a neighbor",
      );
    }
    occupied.add(selected);
  }
  return sortTransformCells(
    [...occupied].map((index) => ({
      row: Math.floor(index / TRANSFORM_GRID_SIZE),
      column: index % TRANSFORM_GRID_SIZE,
    })),
  );
}

function drawOperations(
  draw: DrawBudget,
  difficulty: Difficulty,
): readonly D4Operation[] {
  if (difficulty === 1) {
    return [pick(draw, LEVEL_ONE_ROTATIONS, "a nonidentity rotation")];
  }
  if (difficulty === 2) {
    return [pick(draw, REFLECTIONS, "a reflection")];
  }
  const rotation = pick(draw, LEVEL_THREE_ROTATIONS, "a quarter-turn rotation");
  const reflection = pick(draw, REFLECTIONS, "a reflection");
  const rotationFirst = draw.nextInt(2) === 0;
  const operations: readonly D4Operation[] = rotationFirst
    ? [rotation, reflection]
    : [reflection, rotation];
  const first = operations[0];
  const second = operations[1];
  if (first === undefined || second === undefined) {
    throw new Error("level 3 transform sequence is incomplete");
  }
  const forward = composeD4Sequence([first, second]);
  const reversed = composeD4Sequence([second, first]);
  if (forward === reversed) {
    throw new Error("level 3 transform pair unexpectedly commutes");
  }
  return operations;
}

export function transformOrbit(
  sourceCells: readonly TransformCell[],
): readonly TransformAnswer[] {
  const byKey = new Map<string, TransformAnswer>();
  for (const operation of D4_OPERATIONS) {
    const transformed = transformCells(sourceCells, [operation]);
    byKey.set(transformMaskKey(transformed), transformed);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, cells]) => cells);
}

export interface TransformsConstructionTrace {
  readonly difficulty: Difficulty;
  readonly attempts: number;
  readonly sourceSize: number;
  readonly orbitSize: number;
  readonly operations: readonly D4Operation[];
  readonly net: D4Operation;
  readonly drawsUsed: number;
}

export interface TransformsConstructionResult {
  readonly spec: TransformsSpec;
  readonly trace: TransformsConstructionTrace;
}

export function constructTransformsSpec(
  seed: string,
  difficulty: Difficulty,
): TransformsConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new TransformsConstructionError(
      "INVALID_DIFFICULTY",
      `transform difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  let attempts = 0;
  while (attempts < MAX_CONSTRUCTION_ATTEMPTS) {
    attempts += 1;
    const operations = drawOperations(draw, difficulty);
    const source = drawConnectedSource(draw);
    const spec = TransformsSpecSchema.parse({
      source: gridFromCells(source),
      operations,
    });
    const orbit = transformOrbit(source);
    if (orbit.length < 4) {
      continue;
    }
    const correct = transformCells(source, operations);
    if (sameTransformMask(correct, source)) {
      continue;
    }
    const correctKey = transformMaskKey(correct);
    const distractors = orbit.filter(
      (cells) => transformMaskKey(cells) !== correctKey,
    );
    if (distractors.length < 3) {
      continue;
    }
    return {
      spec,
      trace: {
        difficulty,
        attempts,
        sourceSize: source.length,
        orbitSize: orbit.length,
        operations,
        net: composeD4Sequence(operations),
        drawsUsed: draw.used,
      },
    };
  }
  throw new TransformsConstructionError(
    "CONSTRAINTS_FAILED",
    `transform construction failed after ${attempts} bounded attempts`,
  );
}

function operationLabel(operation: D4Operation): string {
  switch (operation) {
    case "identity":
      return "identity";
    case "rotate90":
      return "R90";
    case "rotate180":
      return "R180";
    case "rotate270":
      return "R270";
    case "reflectLeftRight":
      return "left-right reflection";
    case "reflectTopBottom":
      return "top-bottom reflection";
    case "reflectMainDiagonal":
      return "main-diagonal reflection";
    case "reflectAntiDiagonal":
      return "anti-diagonal reflection";
    default:
      return String(operation);
  }
}

function describeCells(cells: readonly TransformCell[]): string {
  return cells.map((cell) => `(${cell.row},${cell.column})`).join(", ");
}

function enumerateSolutions(spec: TransformsSpec): SolveResult<TransformAnswer> {
  const parsed = TransformsSpecSchema.parse(spec);
  const answer = solveTransforms(parsed);
  const net = composeD4Sequence(parsed.operations);
  return {
    solutionCount: 1,
    answerCount: 1,
    correctAnswer: answer,
    proof: {
      facts: [
        {
          factId: "s001",
          kind: "derived",
          text: `The net transform is ${operationLabel(net)}; the occupied cells are ${describeCells(answer)}.`,
        },
      ],
      witness: answer,
    },
    enumeratedStates: TRANSFORM_GRID_SIZE * TRANSFORM_GRID_SIZE,
    checkerVersion: "transforms-v1",
  };
}

function verifyAnswer(spec: TransformsSpec, answer: TransformAnswer): boolean {
  return checkTransformAnswer(spec, answer);
}

function makeOptions(
  spec: TransformsSpec,
  answer: TransformAnswer,
  seed: string,
): ChoiceSet<TransformAnswer> {
  const parsed = TransformsSpecSchema.parse(spec);
  const correct = solveTransforms(parsed);
  if (!deepEqual(correct, answer)) {
    throw new TransformsEngineError(
      "INVALID_ANSWER",
      "transform options require the unique sequence output",
    );
  }
  const source = sourceCellsFromGrid(parsed.source);
  const orbit = transformOrbit(source);
  const correctKey = transformMaskKey(correct);
  const distractors = orbit.filter(
    (cells) => transformMaskKey(cells) !== correctKey,
  );
  if (distractors.length < 3) {
    throw new TransformsEngineError(
      "INSUFFICIENT_DISTRACTORS",
      `transform source orbit has only ${distractors.length} distinct false outputs`,
    );
  }
  const ordered = new HashCounterPrng(seed).shuffle(distractors);
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new TransformsEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "transform option construction lost a distractor",
    );
  }
  const choices = makeChoiceSet({
    correct,
    distractors: [first, second, third],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    if (verifyAnswer(parsed, choice.value)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new TransformsEngineError(
      "INVALID_OPTION_SET",
      `transform option set contains ${trueChoices} satisfying outputs`,
    );
  }
  return choices;
}

function visibleRules(spec: TransformsSpec): VisibleRules {
  TransformsSpecSchema.parse(spec);
  return {
    domain:
      "A 5x5 grid contains 4 to 8 occupied cells forming one orthogonally connected source shape.",
    closedWorld:
      "Coordinates are zero-based (row, column). Row 0 is the top row and column 0 is the left column from the viewer's perspective. Unlisted cells are empty.",
    target:
      "Apply the listed operations in order and select the complete resulting 5x5 occupied-cell pattern.",
    operations: [
      "A sequence contains one or two operations applied in the listed order: op0 first, then op1 if present.",
      "Identity leaves the shape unchanged.",
      "R90 rotates 90 degrees clockwise: (r,c) becomes (c,4-r).",
      "R180 rotates 180 degrees: (r,c) becomes (4-r,4-c).",
      "R270 rotates 270 degrees clockwise: (r,c) becomes (4-c,r).",
      "Left-right reflection mirrors across the vertical center line: (r,c) becomes (r,4-c).",
      "Top-bottom reflection mirrors across the horizontal center line: (r,c) becomes (4-r,c).",
      "Main-diagonal reflection mirrors across the top-left to bottom-right diagonal: (r,c) becomes (c,r).",
      "Anti-diagonal reflection mirrors across the top-right to bottom-left diagonal: (r,c) becomes (4-c,4-r).",
    ],
    conventions: [
      "All operations act about the tile center at (2,2) in the 5x5 grid.",
      "The source and every choice use the same 5x5 grid, scale, and orientation; only occupied cells are drawn.",
      "Each choice is a complete resulting pattern, not an intermediate step.",
    ],
  };
}

function facts(spec: TransformsSpec): readonly Fact[] {
  const parsed = TransformsSpecSchema.parse(spec);
  return sourceCellsFromGrid(parsed.source).map((cell, index) => ({
    factId: formatFactId("observation", index),
    kind: "observation" as const,
    text: `Source cell (row ${cell.row + 1}, column ${cell.column + 1}) is occupied.`,
  }));
}

function chooseAlternateOperation(
  inputCells: readonly TransformCell[],
  operation: D4Operation,
): D4Operation {
  const originalOutput = transformCells(inputCells, [operation]);
  const candidates = [
    ...D4_OPERATIONS.filter(
      (candidate) => candidate !== "identity" && candidate !== operation,
    ),
    ...D4_OPERATIONS.filter((candidate) => candidate === "identity" && candidate !== operation),
  ];
  for (const candidate of candidates) {
    if (!sameTransformMask(transformCells(inputCells, [candidate]), originalOutput)) {
      return candidate;
    }
  }
  const fallback = candidates[0];
  if (fallback === undefined) {
    throw new Error(`no alternative D4 operation exists for ${operation}`);
  }
  return fallback;
}

function testMutations(spec: TransformsSpec): readonly TestMutation<TransformsSpec>[] {
  const parsed = TransformsSpecSchema.parse(spec);
  const net = composeD4Sequence(parsed.operations);
  const source = sourceCellsFromGrid(parsed.source);
  const first = parsed.operations[0];
  if (first === undefined) {
    throw new Error("a transform mutation source requires one operation");
  }
  const second = parsed.operations[1];
  let instructionMutation: TestMutation<TransformsSpec>;
  if (second === undefined) {
    instructionMutation = {
      id: "alternate-single-operation",
      description: "the single operation is replaced with a different D4 operation",
      spec: TransformsSpecSchema.parse({
        source: parsed.source,
        operations: [chooseAlternateOperation(source, first)],
      }),
    };
  } else if (first === second) {
    const intermediate = transformCells(source, [first]);
    instructionMutation = {
      id: "alternate-two-step-operation",
      description: "the repeated two-step sequence replaces its second operation",
      spec: TransformsSpecSchema.parse({
        source: parsed.source,
        operations: [first, chooseAlternateOperation(intermediate, second)],
      }),
    };
  } else {
    instructionMutation = {
      id: "reversed-operation-order",
      description: "the same operations are listed in reverse order",
      spec: TransformsSpecSchema.parse({
        source: parsed.source,
        operations: [second, first],
      }),
    };
  }
  const sameNet: readonly D4Operation[] =
    second === undefined ? [net, "identity"] : [net];
  return [
    instructionMutation,
    {
      id: "same-net-different-step-count",
      description: "the same net transform is expressed with a different step count",
      spec: TransformsSpecSchema.parse({
        source: parsed.source,
        operations: sameNet,
      }),
    },
  ];
}

export const transformsEngine: FamilyEngine<TransformsSpec, TransformAnswer> = {
  family: "transforms",
  modality: "svg",
  schema: TransformsSpecSchema,
  generateSpec(seed, difficulty) {
    return constructTransformsSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeTransformsSpec(spec);
  },
  testMutations,
};
