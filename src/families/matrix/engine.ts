import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import {
  formatFactId,
  type Fact,
  type FamilyEngine,
  type FamilySolutionDiagnostics,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizeMatrixSpec } from "./canonical.js";
import {
  EMPTY_MASK_CONVENTION,
  MatrixSpecSchema,
  buildMatrixSceneInput,
  checkMatrixCompletion,
  maskPopcount,
  maskText,
  solveMatrix,
  visibleMatrixCells,
  xorMask,
  type MatrixAnswer,
  type MatrixChoiceInput,
  type MatrixSceneInput,
  type MatrixSpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_CONSTRUCTION_ATTEMPTS = 16;
const GLYPH_IDS = [0, 1, 2, 3] as const;

export type MatrixConstructionErrorCode =
  | "DRAW_LIMIT"
  | "CONSTRAINTS_FAILED"
  | "INVALID_DIFFICULTY";

export class MatrixConstructionError extends Error {
  readonly code: MatrixConstructionErrorCode;

  constructor(code: MatrixConstructionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatrixConstructionError";
    this.code = code;
  }
}

export type MatrixEngineErrorCode =
  | "INVALID_ANSWER"
  | "NOT_UNIQUE"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class MatrixEngineError extends Error {
  readonly code: MatrixEngineErrorCode;

  constructor(code: MatrixEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatrixEngineError";
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
      throw new MatrixConstructionError(
        "DRAW_LIMIT",
        `matrix construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }

}

function populationRange(difficulty: Difficulty): readonly [number, number] {
  if (difficulty === 1) {
    return [1, 2];
  }
  if (difficulty === 2) {
    return [1, 3];
  }
  return [2, 3];
}

function drawSeedMask(
  draw: DrawBudget,
  minimum: number,
  maximum: number,
): number {
  const allowed = Array.from({ length: 16 }, (_value, mask) => mask).filter(
    (mask) => {
      const population = maskPopcount(mask);
      return population >= minimum && population <= maximum;
    },
  );
  const selected = allowed[draw.nextInt(allowed.length)];
  if (selected === undefined) {
    throw new MatrixConstructionError(
      "CONSTRAINTS_FAILED",
      "matrix seed mask population set is empty",
    );
  }
  return selected;
}

export interface MatrixConstructionTrace {
  readonly difficulty: Difficulty;
  readonly attempts: number;
  readonly seedPopulations: readonly number[];
  readonly visibleDistinctMasks: number;
  readonly drawsUsed: number;
}

export interface MatrixConstructionResult {
  readonly spec: MatrixSpec;
  readonly trace: MatrixConstructionTrace;
}

export function constructMatrixSpec(
  seed: string,
  difficulty: Difficulty,
): MatrixConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new MatrixConstructionError(
      "INVALID_DIFFICULTY",
      `matrix difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const [minimum, maximum] = populationRange(difficulty);
  let attempts = 0;
  while (attempts < MAX_CONSTRUCTION_ATTEMPTS) {
    attempts += 1;
    const c00 = drawSeedMask(draw, minimum, maximum);
    const c01 = drawSeedMask(draw, minimum, maximum);
    const c10 = drawSeedMask(draw, minimum, maximum);
    const c11 = drawSeedMask(draw, minimum, maximum);
    const c02 = xorMask(c00, c01);
    const c12 = xorMask(c10, c11);
    const c20 = xorMask(c00, c10);
    const c21 = xorMask(c01, c11);
    const visible = [c00, c01, c02, c10, c11, c12, c20, c21];
    const distinct = new Set(visible).size;
    if (
      distinct < 4 ||
      c00 === c01 ||
      c10 === c11 ||
      c00 === c10 ||
      c01 === c11 ||
      c20 === c21 ||
      c02 === c12
    ) {
      continue;
    }
    const spec = MatrixSpecSchema.parse({
      rule: "xor",
      cells: [
        [c00, c01, c02],
        [c10, c11, c12],
        [c20, c21, null],
      ],
    });
    const solutions = solveMatrix(spec);
    if (solutions.length !== 1) {
      continue;
    }
    return {
      spec,
      trace: {
        difficulty,
        attempts,
        seedPopulations: [c00, c01, c10, c11].map(maskPopcount),
        visibleDistinctMasks: distinct,
        drawsUsed: draw.used,
      },
    };
  }
  throw new MatrixConstructionError(
    "CONSTRAINTS_FAILED",
    `matrix construction failed after ${attempts} bounded attempts`,
  );
}

function enumerateSolutions(spec: MatrixSpec): SolveResult<MatrixAnswer> {
  const parsed = MatrixSpecSchema.parse(spec);
  const solutions = solveMatrix(parsed);
  const solution = solutions.length === 1 ? solutions[0] : undefined;
  return {
    solutionCount: solutions.length,
    answerCount: solutions.length,
    correctAnswer: solution === undefined ? null : solution,
    proof:
      solution === undefined
        ? null
        : {
            facts: [
              {
                factId: "s001",
                kind: "derived",
                text: `The missing mask is ${solution} (${maskText(solution)}).`,
              },
            ],
            witness: solution,
          },
    enumeratedStates: 16,
    checkerVersion: "matrix-v1",
  };
}

function verifyAnswer(spec: MatrixSpec, answer: MatrixAnswer): boolean {
  const parsed = MatrixSpecSchema.parse(spec);
  return checkMatrixCompletion(parsed, answer);
}

function makeOptions(
  spec: MatrixSpec,
  answer: MatrixAnswer,
  seed: string,
): ChoiceSet<MatrixAnswer> {
  const parsed = MatrixSpecSchema.parse(spec);
  const solutions = solveMatrix(parsed);
  if (solutions.length !== 1) {
    throw new MatrixEngineError(
      "NOT_UNIQUE",
      `matrix options require one completion, received ${solutions.length}`,
    );
  }
  const correct = solutions[0];
  if (correct === undefined || !deepEqual(correct, answer)) {
    throw new MatrixEngineError(
      "INVALID_ANSWER",
      "matrix options require the unique satisfying mask",
    );
  }
  const toggles = GLYPH_IDS.map((glyph) => correct ^ (1 << glyph));
  const prng = new HashCounterPrng(seed);
  const ordered = prng.shuffle(toggles);
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new MatrixEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "matrix spec has fewer than three one-glyph distractors",
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
    throw new MatrixEngineError(
      "INVALID_OPTION_SET",
      `matrix option set contains ${trueChoices} satisfying masks`,
    );
  }
  return choices;
}

function visibleRules(spec: MatrixSpec): VisibleRules {
  MatrixSpecSchema.parse(spec);
  return {
    domain:
      "A 3x3 matrix uses four fixed glyph positions in every cell. Only the bottom-right cell is missing.",
    closedWorld:
      "Each cell is a four-bit mask; set membership is binary and color is never an identity cue. The missing cell is at row 3, column 3.",
    target: "Determine the missing bottom-right mask.",
    operations: [
      "xor: a glyph is present in the result exactly when it is present in exactly one input mask.",
      "Row rule: the third cell equals the first XOR second.",
      "Column rule: the bottom cell equals the top XOR middle.",
      "The rule is explicitly xor; no other pattern is allowed.",
    ],
    conventions: [
      EMPTY_MASK_CONVENTION,
      "Every option uses the same four fixed glyph positions.",
      "Row and column directions are both explicit; transpose preserves the law.",
    ],
  };
}

function facts(spec: MatrixSpec): readonly Fact[] {
  const parsed = MatrixSpecSchema.parse(spec);
  return visibleMatrixCells(parsed).map((cell, index) => ({
    factId: formatFactId("observation", index),
    kind: "observation" as const,
    text: `Row ${cell.row + 1}, column ${cell.column + 1}: mask ${cell.mask} (${maskText(cell.mask)}).`,
  }));
}

export function matrixSceneInput(
  spec: MatrixSpec,
  choices: readonly MatrixChoiceInput[],
): MatrixSceneInput {
  return buildMatrixSceneInput(spec, choices);
}

function testMutations(_spec: MatrixSpec): readonly TestMutation<MatrixSpec>[] {
  const inconsistent = MatrixSpecSchema.parse({
    rule: "xor",
    cells: [
      [1, 2, 4],
      [4, 7, 3],
      [5, 5, null],
    ],
  });
  const emptyMissing = MatrixSpecSchema.parse({
    rule: "xor",
    cells: [
      [1, 2, 3],
      [4, 7, 3],
      [5, 5, null],
    ],
  });
  return [
    {
      id: "inconsistent-visible-row",
      description: "the top row does not satisfy XOR",
      spec: inconsistent,
    },
    {
      id: "empty-mask-completion",
      description: "the missing mask is the all-empty mask",
      spec: emptyMissing,
    },
  ];
}

export function diagnoseMatrixSolutions(
  spec: MatrixSpec,
): FamilySolutionDiagnostics<MatrixAnswer> {
  const parsed = MatrixSpecSchema.parse(spec);
  const solutions = solveMatrix(parsed);
  return {
    solutionCount: solutions.length,
    answerCount: solutions.length,
    witnesses: solutions.slice(0, 2),
    complete: true,
    enumeratedStates: 16,
  };
}

export const matrixEngine: FamilyEngine<MatrixSpec, MatrixAnswer> = {
  family: "matrix",
  modality: "svg",
  schema: MatrixSpecSchema,
  generateSpec(seed, difficulty) {
    return constructMatrixSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeMatrixSpec(spec);
  },
  testMutations,
};
