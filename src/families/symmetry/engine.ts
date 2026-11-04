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
import { canonicalizeSymmetrySpec } from "./canonical.js";
import {
  MAX_KNOWN_OCCUPIED,
  SYMMETRY_GRID_SIZE,
  SYMMETRY_HALF_SIZE,
  SymmetrySpecSchema,
  checkSymmetryAnswer,
  cloneSymmetryAnswer,
  completeSymmetry,
  knownEmptyCells,
  knownOccupiedCells,
  knownSymmetryCells,
  mirrorSymmetryCell,
  missingSymmetryCells,
  isKnownSymmetryCell,
  symmetryCellKey,
  symmetryKnownComponents,
  symmetryStateAt,
  type SymmetryAnswer,
  type SymmetryAxis,
  type SymmetryCell,
  type SymmetryCellState,
  type SymmetrySpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_CONSTRUCTION_ATTEMPTS = 16;

interface OccupiedRange {
  readonly min: number;
  readonly max: number;
}

const OCCUPIED_RANGE_BY_DIFFICULTY: Readonly<Record<Difficulty, OccupiedRange>> = {
  1: { min: 4, max: 5 },
  2: { min: 6, max: 7 },
  3: { min: 8, max: 10 },
};

export type SymmetryConstructionErrorCode =
  | "DRAW_LIMIT"
  | "CONSTRAINTS_FAILED"
  | "INVALID_DIFFICULTY";

export class SymmetryConstructionError extends Error {
  readonly code: SymmetryConstructionErrorCode;

  constructor(
    code: SymmetryConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SymmetryConstructionError";
    this.code = code;
  }
}

export type SymmetryEngineErrorCode =
  | "INVALID_ANSWER"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class SymmetryEngineError extends Error {
  readonly code: SymmetryEngineErrorCode;

  constructor(code: SymmetryEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SymmetryEngineError";
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
      throw new SymmetryConstructionError(
        "DRAW_LIMIT",
        `symmetry construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }
}

function pick<T>(draw: DrawBudget, items: readonly T[], description: string): T {
  const selected = items[draw.nextInt(items.length)];
  if (selected === undefined) {
    throw new SymmetryConstructionError(
      "CONSTRAINTS_FAILED",
      `symmetry construction could not draw ${description}`,
    );
  }
  return selected;
}

function drawAxis(draw: DrawBudget, difficulty: Difficulty): SymmetryAxis {
  if (difficulty === 1) {
    return "vertical";
  }
  if (difficulty === 2) {
    return "horizontal";
  }
  return pick(draw, ["vertical", "horizontal"] as const, "a symmetry axis");
}

function drawOccupiedCells(
  draw: DrawBudget,
  axis: SymmetryAxis,
  count: number,
): readonly SymmetryCell[] {
  const known = knownSymmetryCells(axis);
  const selected = new Set<number>();
  while (selected.size < count) {
    selected.add(draw.nextInt(known.length));
  }
  return known.filter((_, index) => selected.has(index));
}

function buildStateGrid(
  axis: SymmetryAxis,
  occupied: readonly SymmetryCell[],
): readonly (readonly SymmetryCellState[])[] {
  const occupiedKeys = new Set(
    occupied.map((cell) => `${cell.row}:${cell.column}`),
  );
  const grid: SymmetryCellState[][] = Array.from(
    { length: SYMMETRY_GRID_SIZE },
    () =>
      Array.from(
        { length: SYMMETRY_GRID_SIZE },
        () => "unknown" as const,
      ),
  );
  for (const cell of knownSymmetryCells(axis)) {
    const row = grid[cell.row];
    if (row === undefined) {
      throw new SymmetryConstructionError(
        "CONSTRAINTS_FAILED",
        `symmetry row ${cell.row} is outside the grid`,
      );
    }
    row[cell.column] = occupiedKeys.has(`${cell.row}:${cell.column}`)
      ? "occupied"
      : "empty";
  }
  return grid;
}

export interface SymmetryConstructionTrace {
  readonly difficulty: Difficulty;
  readonly axis: SymmetryAxis;
  readonly occupiedCount: number;
  readonly componentCount: number;
  readonly attempts: number;
  readonly drawsUsed: number;
}

export interface SymmetryConstructionResult {
  readonly spec: SymmetrySpec;
  readonly trace: SymmetryConstructionTrace;
}

export function constructSymmetrySpec(
  seed: string,
  difficulty: Difficulty,
): SymmetryConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new SymmetryConstructionError(
      "INVALID_DIFFICULTY",
      `symmetry difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const range = OCCUPIED_RANGE_BY_DIFFICULTY[difficulty];
  let attempts = 0;
  while (attempts < MAX_CONSTRUCTION_ATTEMPTS) {
    attempts += 1;
    const axis = drawAxis(draw, difficulty);
    const occupiedCount = range.min + draw.nextInt(range.max - range.min + 1);
    const occupied = drawOccupiedCells(draw, axis, occupiedCount);
    const componentCount = symmetryKnownComponents(axis, occupied);
    if (difficulty === 3 && componentCount < 2) {
      continue;
    }
    if (occupiedCount === 0 || occupiedCount === SYMMETRY_GRID_SIZE * SYMMETRY_GRID_SIZE) {
      continue;
    }
    const spec = SymmetrySpecSchema.parse({
      axis,
      cells: buildStateGrid(axis, occupied),
    });
    return {
      spec,
      trace: {
        difficulty,
        axis,
        occupiedCount,
        componentCount,
        attempts,
        drawsUsed: draw.used,
      },
    };
  }
  throw new SymmetryConstructionError(
    "CONSTRAINTS_FAILED",
    `symmetry construction failed after ${attempts} bounded attempts`,
  );
}

function enumerateSolutions(spec: SymmetrySpec): SolveResult<SymmetryAnswer> {
  const parsed = SymmetrySpecSchema.parse(spec);
  const answer = completeSymmetry(parsed);
  const facts: Fact[] = missingSymmetryCells(parsed.axis).map((cell, index) => {
    const mirror = mirrorSymmetryCell(parsed.axis, cell);
    const state = symmetryStateAt(parsed, mirror);
    return {
      factId: formatFactId("derived", index),
      kind: "derived",
      text: `Missing cell (row ${cell.row + 1}, column ${cell.column + 1}) is forced ${
        state === "occupied" ? "occupied" : "empty"
      } by known cell (row ${mirror.row + 1}, column ${mirror.column + 1}).`,
    };
  });
  return {
    solutionCount: 1,
    answerCount: 1,
    correctAnswer: answer,
    proof: {
      facts,
      witness: answer,
    },
    enumeratedStates: SYMMETRY_GRID_SIZE * SYMMETRY_GRID_SIZE,
    checkerVersion: "symmetry-v1",
  };
}

function verifyAnswer(spec: SymmetrySpec, answer: SymmetryAnswer): boolean {
  return checkSymmetryAnswer(spec, answer);
}

function makeOptions(
  spec: SymmetrySpec,
  answer: SymmetryAnswer,
  seed: string,
): ChoiceSet<SymmetryAnswer> {
  const parsed = SymmetrySpecSchema.parse(spec);
  const correct = completeSymmetry(parsed);
  if (!deepEqual(correct, answer)) {
    throw new SymmetryEngineError(
      "INVALID_ANSWER",
      "symmetry options require the forced full completion",
    );
  }
  const requiredMissing = missingSymmetryCells(parsed.axis).filter(
    (cell) =>
      symmetryStateAt(parsed, mirrorSymmetryCell(parsed.axis, cell)) === "occupied",
  );
  const forbiddenMissing = missingSymmetryCells(parsed.axis).filter(
    (cell) =>
      symmetryStateAt(parsed, mirrorSymmetryCell(parsed.axis, cell)) === "empty",
  );
  if (requiredMissing.length === 0 || forbiddenMissing.length === 0) {
    throw new SymmetryEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "symmetry completion lacks both required and forbidden missing cells",
    );
  }
  const prng = new HashCounterPrng(seed);
  const required = prng.shuffle(requiredMissing)[0];
  const forbidden = prng.shuffle(forbiddenMissing)[0];
  if (required === undefined || forbidden === undefined) {
    throw new SymmetryEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "symmetry option construction lost a missing-cell candidate",
    );
  }
  const forbiddenKeys = new Set(
    forbiddenMissing.map((cell) => symmetryCellKey(cell)),
  );
  const shiftCandidates: Array<{ readonly from: SymmetryCell; readonly to: SymmetryCell }> = [];
  for (const from of requiredMissing) {
    for (const to of [
      { row: from.row - 1, column: from.column },
      { row: from.row + 1, column: from.column },
      { row: from.row, column: from.column - 1 },
      { row: from.row, column: from.column + 1 },
    ]) {
      if (
        to.row < 0 ||
        to.row >= SYMMETRY_GRID_SIZE ||
        to.column < 0 ||
        to.column >= SYMMETRY_GRID_SIZE ||
        isKnownSymmetryCell(parsed.axis, to) ||
        !forbiddenKeys.has(symmetryCellKey(to))
      ) {
        continue;
      }
      shiftCandidates.push({ from, to });
    }
  }
  const shift = prng.shuffle(shiftCandidates)[0];
  if (shift === undefined) {
    throw new SymmetryEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "symmetry completion has no adjacent reflected-cell shift",
    );
  }
  const removed = cloneSymmetryAnswer(correct);
  const removedRow = removed[required.row];
  if (removedRow === undefined) {
    throw new SymmetryEngineError("INVALID_OPTION_SET", "symmetry row is missing");
  }
  removedRow[required.column] = 0;
  const added = cloneSymmetryAnswer(correct);
  const addedRow = added[forbidden.row];
  if (addedRow === undefined) {
    throw new SymmetryEngineError("INVALID_OPTION_SET", "symmetry row is missing");
  }
  addedRow[forbidden.column] = 1;
  const shifted = cloneSymmetryAnswer(correct);
  const shiftedSourceRow = shifted[shift.from.row];
  const shiftedTargetRow = shifted[shift.to.row];
  if (shiftedSourceRow === undefined || shiftedTargetRow === undefined) {
    throw new SymmetryEngineError("INVALID_OPTION_SET", "symmetry row is missing");
  }
  shiftedSourceRow[shift.from.column] = 0;
  shiftedTargetRow[shift.to.column] = 1;
  const choices = makeChoiceSet({
    correct,
    distractors: [removed, added, shifted],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    if (verifyAnswer(parsed, choice.value)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new SymmetryEngineError(
      "INVALID_OPTION_SET",
      `symmetry option set contains ${trueChoices} satisfying completions`,
    );
  }
  return choices;
}

function visibleRules(spec: SymmetrySpec): VisibleRules {
  SymmetrySpecSchema.parse(spec);
  return {
    domain:
      "An 8x8 tile has a marked vertical axis between the central columns or a horizontal axis between the central rows. One half is known and contains 4 to 10 occupied cells; the opposite half is unknown.",
    closedWorld:
      "The known half is fixed. The missing half is determined only by reflection across the marked axis; unknown cells are not the same as explicitly empty cells. No cell lies on the axis.",
    target:
      "Choose the full 8x8 completion that reflects every known cell across the axis exactly once and leaves the known half unchanged.",
    operations: [
      "A vertical axis lies between columns 4 and 5; the left half is known and the right half is unknown.",
      "A horizontal axis lies between rows 4 and 5; the top half is known and the bottom half is unknown.",
      "Each missing cell equals the reflection of its known counterpart across the marked axis.",
      "Every known cell is reflected exactly once; every other missing cell is empty.",
      "All choices use the same known half and the same marked axis.",
    ],
    conventions: [
      "Rows and columns in the text are 1-based from the top-left.",
      "Unknown gray areas are not empty or filled cells until completed.",
      "The axis is dashed and labeled, and is not a cell boundary membership mark.",
    ],
  };
}

function facts(spec: SymmetrySpec): readonly Fact[] {
  const parsed = SymmetrySpecSchema.parse(spec);
  const observations: string[] = [];
  for (const cell of knownOccupiedCells(parsed)) {
    observations.push(
      `Known cell row ${cell.row + 1}, column ${cell.column + 1} is occupied.`,
    );
  }
  observations.push(
    parsed.axis === "vertical"
      ? `The symmetry axis is vertical between columns ${SYMMETRY_HALF_SIZE} and ${
          SYMMETRY_HALF_SIZE + 1
        }; the left half is known and the right half is unknown.`
      : `The symmetry axis is horizontal between rows ${SYMMETRY_HALF_SIZE} and ${
          SYMMETRY_HALF_SIZE + 1
        }; the top half is known and the bottom half is unknown.`,
  );
  observations.push(
    parsed.axis === "vertical"
      ? "The right half is unknown and must be completed by reflection."
      : "The bottom half is unknown and must be completed by reflection.",
  );
  return observations.map((text, index) => ({
    factId: formatFactId("observation", index),
    kind: "observation" as const,
    text,
  }));
}

function transposeSpec(spec: SymmetrySpec): SymmetrySpec {
  const cells: SymmetryCellState[][] = Array.from(
    { length: SYMMETRY_GRID_SIZE },
    () =>
      Array.from(
        { length: SYMMETRY_GRID_SIZE },
        () => "unknown" as const,
      ),
  );
  for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
    for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
      const state = spec.cells[row]?.[column];
      const targetRow = cells[column];
      if (state !== undefined && targetRow !== undefined) {
        targetRow[row] = state;
      }
    }
  }
  return SymmetrySpecSchema.parse({
    axis: spec.axis === "vertical" ? "horizontal" : "vertical",
    cells,
  });
}

function alteredKnownHalf(spec: SymmetrySpec): SymmetrySpec {
  const occupied = knownOccupiedCells(spec);
  const cells = spec.cells.map((row) => [...row]);
  if (occupied.length >= MAX_KNOWN_OCCUPIED) {
    const cell = occupied[0];
    if (cell === undefined) {
      throw new SymmetryEngineError("INVALID_ANSWER", "symmetry has no occupied cell");
    }
    const row = cells[cell.row];
    if (row !== undefined) {
      row[cell.column] = "empty";
    }
  } else {
    const empty = knownEmptyCells(spec)[0];
    if (empty === undefined) {
      throw new SymmetryEngineError("INVALID_ANSWER", "symmetry has no empty known cell");
    }
    const row = cells[empty.row];
    if (row !== undefined) {
      row[empty.column] = "occupied";
    }
  }
  return SymmetrySpecSchema.parse({ axis: spec.axis, cells });
}

function testMutations(spec: SymmetrySpec): readonly TestMutation<SymmetrySpec>[] {
  const parsed = SymmetrySpecSchema.parse(spec);
  return [
    {
      id: "transposed-axis",
      description: "the known half is transposed and the axis orientation is exchanged",
      spec: transposeSpec(parsed),
    },
    {
      id: "altered-known-half",
      description: "one known-half cell changes between occupied and empty",
      spec: alteredKnownHalf(parsed),
    },
  ];
}

export const symmetryEngine: FamilyEngine<SymmetrySpec, SymmetryAnswer> = {
  family: "symmetry",
  modality: "svg",
  schema: SymmetrySpecSchema,
  generateSpec(seed, difficulty) {
    return constructSymmetrySpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeSymmetrySpec(spec);
  },
  testMutations,
};

export {
  completeSymmetry,
  knownOccupiedCells,
  mirrorSymmetryCell,
  missingSymmetryCells,
  symmetryKnownComponents,
  type SymmetryAnswer,
  type SymmetryAxis,
  type SymmetryCell,
  type SymmetrySpec,
};
