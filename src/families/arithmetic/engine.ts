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
import { canonicalizeArithmeticSpec } from "./canonical.js";
import {
  ARITHMETIC_DOMAIN_SIZE,
  ArithmeticSpecSchema,
  ArithmeticTupleSchema,
  allDifferentSatisfied,
  constraintSatisfied,
  constraintText,
  solveArithmetic,
  tupleText,
  type ArithmeticAnswer,
  type ArithmeticConstraint,
  type ArithmeticOp,
  type ArithmeticSpec,
  type ArithmeticTuple,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MIN_CONSTRAINTS = 2;
const MAX_CONSTRAINTS = 5;

export type ArithmeticConstructionErrorCode =
  | "DRAW_LIMIT"
  | "NO_UNIQUE_SYSTEM"
  | "NO_NONREDUNDANT_INEQUALITY"
  | "INVALID_DIFFICULTY";

export class ArithmeticConstructionError extends Error {
  readonly code: ArithmeticConstructionErrorCode;

  constructor(
    code: ArithmeticConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArithmeticConstructionError";
    this.code = code;
  }
}

export type ArithmeticEngineErrorCode =
  | "INVALID_ANSWER"
  | "NOT_UNIQUE"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class ArithmeticEngineError extends Error {
  readonly code: ArithmeticEngineErrorCode;

  constructor(code: ArithmeticEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArithmeticEngineError";
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
      throw new ArithmeticConstructionError(
        "DRAW_LIMIT",
        `arithmetic construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
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
        throw new Error("arithmetic shuffle encountered an invalid index");
      }
      copy[index] = replacement;
      copy[swapIndex] = current;
    }
    return copy;
  }

  sampleDistinct<T>(items: readonly T[], count: number): T[] {
    if (!Number.isInteger(count) || count < 0 || count > items.length) {
      throw new RangeError(`arithmetic sample count ${count} is outside 0..${items.length}`);
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
        throw new Error("arithmetic sample encountered an invalid index");
      }
      selected.push(chosen);
      pool[pick] = last;
      pool[lastIndex] = chosen;
    }
    return selected;
  }
}

function scaledUnitConstraint(
  variable: number,
  value: number,
  op: ArithmeticOp,
  scale: number,
): ArithmeticConstraint {
  const coeffs: [number, number, number] = [0, 0, 0];
  coeffs[variable] = scale;
  return { coeffs, op, constant: scale * value };
}

interface AnchorBuild {
  readonly constraints: ArithmeticConstraint[];
  readonly pinVariable: number;
  readonly pinEquationIndex: number | null;
  readonly replacedVariable: number | null;
}

function anchorConstraints(
  draw: DrawBudget,
  witness: readonly number[],
  difficulty: Difficulty,
  coefficientLimit: number,
): AnchorBuild {
  const pinVariable = draw.shuffle([0, 1, 2])[0];
  if (pinVariable === undefined) {
    throw new ArithmeticConstructionError(
      "NO_UNIQUE_SYSTEM",
      "arithmetic anchor could not choose a pin variable",
    );
  }
  const others = [0, 1, 2].filter((variable) => variable !== pinVariable);
  const first = others[0];
  const second = others[1];
  if (first === undefined || second === undefined) {
    throw new ArithmeticConstructionError(
      "NO_UNIQUE_SYSTEM",
      "arithmetic anchor could not choose the two free variables",
    );
  }
  const rows = draw.shuffle([
    [coefficientLimit, 1],
    [1, -coefficientLimit],
  ]);
  const equations: ArithmeticConstraint[] = [];
  for (const row of rows) {
    const firstCoefficient = row[0];
    const secondCoefficient = row[1];
    if (firstCoefficient === undefined || secondCoefficient === undefined) {
      throw new ArithmeticConstructionError(
        "NO_UNIQUE_SYSTEM",
        "arithmetic anchor row is incomplete",
      );
    }
    const sign = draw.nextInt(2) === 0 ? 1 : -1;
    const coeffs: [number, number, number] = [0, 0, 0];
    coeffs[first] = firstCoefficient * sign;
    coeffs[second] = secondCoefficient * sign;
    equations.push({
      coeffs,
      op: "eq",
      constant:
        (coeffs[first] ?? 0) * (witness[first] ?? 0) +
        (coeffs[second] ?? 0) * (witness[second] ?? 0),
    });
  }
  const pinValue = witness[pinVariable] ?? 0;
  if (difficulty === 3) {
    return {
      constraints: [
        ...equations,
        scaledUnitConstraint(pinVariable, pinValue, "le", 1),
        scaledUnitConstraint(pinVariable, pinValue, "le", -1),
      ],
      pinVariable,
      pinEquationIndex: null,
      replacedVariable: pinVariable,
    };
  }
  const pinEquation = scaledUnitConstraint(pinVariable, pinValue, "eq", 1);
  const shuffled = draw.shuffle([...equations, pinEquation]);
  const pinEquationIndex = shuffled.indexOf(pinEquation);
  return {
    constraints: shuffled,
    pinVariable,
    pinEquationIndex,
    replacedVariable: null,
  };
}

function sameTuple(left: readonly number[], right: readonly number[]): boolean {
  return deepEqual(left, right);
}

export interface ArithmeticConstructionTrace {
  readonly difficulty: Difficulty;
  readonly coefficientLimit: number;
  readonly allDifferent: boolean;
  readonly anchorCount: number;
  readonly replacedVariable: number | null;
  readonly additionalRequested: number;
  readonly additionalAdded: number;
  readonly prunedConstraints: number;
  readonly constraintCountBeforePruning: number;
  readonly constraintCountAfterPruning: number;
  readonly operators: readonly ArithmeticOp[];
  readonly nonredundantInequalities: number;
  readonly drawsUsed: number;
}

export interface ArithmeticConstructionResult {
  readonly spec: ArithmeticSpec;
  readonly trace: ArithmeticConstructionTrace;
}

export function constructArithmeticSpec(
  seed: string,
  difficulty: Difficulty,
): ArithmeticConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new ArithmeticConstructionError(
      "INVALID_DIFFICULTY",
      `arithmetic difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const allDifferent = draw.nextInt(2) === 0;
  const witnessValues = allDifferent
    ? draw.sampleDistinct(
        Array.from({ length: ARITHMETIC_DOMAIN_SIZE }, (_value, index) => index),
        3,
      )
    : [draw.nextInt(ARITHMETIC_DOMAIN_SIZE), draw.nextInt(ARITHMETIC_DOMAIN_SIZE), draw.nextInt(ARITHMETIC_DOMAIN_SIZE)];
  const witness: ArithmeticTuple = [
    witnessValues[0] ?? 0,
    witnessValues[1] ?? 0,
    witnessValues[2] ?? 0,
  ];
  const coefficientLimit = difficulty === 1 ? 1 : difficulty === 2 ? 2 : 3;
  const anchor = anchorConstraints(draw, witness, difficulty, coefficientLimit);
  const additionalRequested = difficulty === 3 ? 0 : 2;
  const constraintsBeforePruning = [...anchor.constraints];
  if (difficulty !== 3) {
    const pinValue = witness[anchor.pinVariable] ?? 0;
    constraintsBeforePruning.push(
      scaledUnitConstraint(anchor.pinVariable, pinValue, "le", coefficientLimit),
      scaledUnitConstraint(anchor.pinVariable, pinValue, "le", -coefficientLimit),
    );
  }
  let constraints = constraintsBeforePruning;
  const constraintCountBeforePruning = constraints.length;

  const indices = constraints.map((_constraint, index) => index);
  const pruneOrder =
    anchor.pinEquationIndex === null
      ? draw.shuffle(indices)
      : [
          anchor.pinEquationIndex,
          ...draw.shuffle(indices.filter((index) => index !== anchor.pinEquationIndex)),
        ];
  const retained = new Set<number>(constraints.map((_constraint, index) => index));
  const removalOrder: number[] = [];
  for (const index of pruneOrder) {
    if (retained.size <= MIN_CONSTRAINTS) {
      break;
    }
    if (!retained.has(index)) {
      continue;
    }
    const candidate = [...retained]
      .filter((candidateIndex) => candidateIndex !== index)
      .sort((left, right) => left - right)
      .map((candidateIndex) => constraints[candidateIndex] as ArithmeticConstraint);
    const solved = solveArithmetic({ allDifferent, constraints: candidate });
    const solution = solved.solutions[0];
    if (
      solved.solutions.length === 1 &&
      solution !== undefined &&
      sameTuple(solution, witness)
    ) {
      retained.delete(index);
      removalOrder.push(index);
    }
  }
  constraints = [...retained]
    .sort((left, right) => left - right)
    .map((index) => constraints[index] as ArithmeticConstraint);

  const finalSolved = solveArithmetic({ allDifferent, constraints });
  const finalSolution = finalSolved.solutions[0];
  if (
    finalSolved.solutions.length !== 1 ||
    finalSolution === undefined ||
    !sameTuple(finalSolution, witness)
  ) {
    throw new ArithmeticConstructionError(
      "NO_UNIQUE_SYSTEM",
      "arithmetic construction did not retain the intended unique tuple",
    );
  }
  if (
    constraints.length < MIN_CONSTRAINTS ||
    constraints.length > MAX_CONSTRAINTS
  ) {
    throw new ArithmeticConstructionError(
      "NO_UNIQUE_SYSTEM",
      `arithmetic construction produced ${constraints.length} constraints outside 2..5`,
    );
  }

  let nonredundantInequalities = 0;
  for (const [index, constraint] of constraints.entries()) {
    if (constraint.op === "eq") {
      continue;
    }
    const candidate = constraints.filter((_candidate, candidateIndex) => candidateIndex !== index);
    const solved = solveArithmetic({ allDifferent, constraints: candidate });
    if (
      solved.solutions.length !== 1 ||
      !sameTuple(solved.solutions[0] ?? [], witness)
    ) {
      nonredundantInequalities += 1;
    }
  }
  if (difficulty === 3 && nonredundantInequalities === 0) {
    throw new ArithmeticConstructionError(
      "NO_NONREDUNDANT_INEQUALITY",
      "level-3 arithmetic construction retained no nonredundant inequality",
    );
  }

  const spec = ArithmeticSpecSchema.parse({ allDifferent, constraints });
  return {
    spec,
    trace: {
      difficulty,
      coefficientLimit,
      allDifferent,
      anchorCount: anchor.constraints.length,
      replacedVariable: anchor.replacedVariable,
      additionalRequested,
      additionalAdded: difficulty === 3 ? 0 : 2,
      prunedConstraints: removalOrder.length,
      constraintCountBeforePruning,
      constraintCountAfterPruning: spec.constraints.length,
      operators: spec.constraints.map((constraint) => constraint.op),
      nonredundantInequalities,
      drawsUsed: draw.used,
    },
  };
}

function enumerateSolutions(spec: ArithmeticSpec): SolveResult<ArithmeticAnswer> {
  const parsed = ArithmeticSpecSchema.parse(spec);
  const solved = solveArithmetic(parsed);
  const solution = solved.solutions.length === 1 ? solved.solutions[0] : undefined;
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    correctAnswer: solution === undefined ? null : [...solution] as ArithmeticAnswer,
    proof:
      solution === undefined
        ? null
        : {
            facts: [
              {
                factId: "s001",
                kind: "derived",
                text: `The unique tuple is ${tupleText(solution)}.`,
              },
            ],
            witness: [...solution] as ArithmeticAnswer,
          },
    enumeratedStates: solved.enumeratedStates,
    checkerVersion: "arithmetic-v1",
  };
}

function verifyAnswer(spec: ArithmeticSpec, answer: ArithmeticAnswer): boolean {
  const parsed = ArithmeticSpecSchema.parse(spec);
  const tuple = ArithmeticTupleSchema.safeParse(answer);
  if (!tuple.success) {
    return false;
  }
  if (parsed.allDifferent && !allDifferentSatisfied(tuple.data)) {
    return false;
  }
  return parsed.constraints.every((constraint) =>
    constraintSatisfied(constraint, tuple.data),
  );
}

function allTuples(): readonly ArithmeticTuple[] {
  const tuples: ArithmeticTuple[] = [];
  for (let x = 0; x < ARITHMETIC_DOMAIN_SIZE; x += 1) {
    for (let y = 0; y < ARITHMETIC_DOMAIN_SIZE; y += 1) {
      for (let z = 0; z < ARITHMETIC_DOMAIN_SIZE; z += 1) {
        tuples.push([x, y, z]);
      }
    }
  }
  return tuples;
}

function makeOptions(
  spec: ArithmeticSpec,
  answer: ArithmeticAnswer,
  seed: string,
): ChoiceSet<ArithmeticAnswer> {
  const parsed = ArithmeticSpecSchema.parse(spec);
  const solvedSpec = solveArithmetic(parsed);
  const unique = solvedSpec.solutions.length === 1 ? solvedSpec.solutions[0] : undefined;
  if (unique === undefined) {
    throw new ArithmeticEngineError(
      "NOT_UNIQUE",
      `arithmetic options require one full tuple, received ${solvedSpec.solutions.length}`,
    );
  }
  const supplied = ArithmeticTupleSchema.safeParse(answer);
  if (!supplied.success || !deepEqual(supplied.data, unique)) {
    throw new ArithmeticEngineError(
      "INVALID_ANSWER",
      "arithmetic options require the unique satisfying tuple",
    );
  }

  const preferred: ArithmeticAnswer[] = [];
  const preferredKeys = new Set<string>();
  for (let variable = 0; variable < 3; variable += 1) {
    for (const delta of [-1, 1]) {
      const candidate: ArithmeticTuple = [
        unique[0] ?? 0,
        unique[1] ?? 0,
        unique[2] ?? 0,
      ];
      const current = candidate[variable];
      if (current === undefined) {
        continue;
      }
      const next = current + delta;
      if (next < 0 || next > 12) {
        continue;
      }
      candidate[variable] = next;
      if (verifyAnswer(parsed, candidate)) {
        continue;
      }
      const key = candidate.join(",");
      if (!preferredKeys.has(key)) {
        preferredKeys.add(key);
        preferred.push(candidate);
      }
    }
  }

  const fallback: ArithmeticAnswer[] = [];
  for (const tuple of allTuples()) {
    if (verifyAnswer(parsed, tuple)) {
      continue;
    }
    const key = tuple.join(",");
    if (!preferredKeys.has(key)) {
      fallback.push(tuple);
    }
  }

  const prng = new HashCounterPrng(seed);
  const ordered = [...prng.shuffle(preferred), ...prng.shuffle(fallback)];
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new ArithmeticEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "arithmetic spec has fewer than three false tuples",
    );
  }
  const choices = makeChoiceSet({
    correct: [...unique] as ArithmeticAnswer,
    distractors: [first, second, third] as [
      ArithmeticAnswer,
      ArithmeticAnswer,
      ArithmeticAnswer,
    ],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    if (verifyAnswer(parsed, choice.value)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new ArithmeticEngineError(
      "INVALID_OPTION_SET",
      `arithmetic option set contains ${trueChoices} satisfying tuples`,
    );
  }
  return choices;
}

function visibleRules(spec: ArithmeticSpec): VisibleRules {
  const parsed = ArithmeticSpecSchema.parse(spec);
  return {
    domain:
      "Three integer variables x, y, and z each range over 0..12 inclusive.",
    closedWorld: `Every linear comparison is evaluated exactly with integer arithmetic. allDifferent is ${parsed.allDifferent ? "true: x, y, and z must be pairwise distinct" : "false: no distinctness restriction applies"}. No other constraints or approximation rules apply.`,
    target: "Determine the unique integer tuple (x, y, z).",
    operations: [
      "eq: the linear sum equals the constant.",
      "lt: the linear sum is strictly less than the constant.",
      "le: the linear sum is less than or equal to the constant.",
      "allDifferent: when true, all three variable values must differ.",
      "Comparisons use exact integers; no rounding or real-valued solutions are allowed.",
    ],
    conventions: [
      "The domain is 0..12 for each variable.",
      `allDifferent is ${parsed.allDifferent ? "true" : "false"}.`,
      "Negative coefficients and negative constants are shown in parentheses.",
    ],
  };
}

function facts(spec: ArithmeticSpec): readonly Fact[] {
  const parsed = ArithmeticSpecSchema.parse(spec);
  return parsed.constraints.map((constraint, index) => ({
    factId: formatFactId("local", index),
    kind: "local" as const,
    text: constraintText(constraint),
  }));
}

function testMutations(_spec: ArithmeticSpec): readonly TestMutation<ArithmeticSpec>[] {
  return [
    {
      id: "no-integer-solution",
      description: "2*x=3 has no integer solution",
      spec: ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [
          { coeffs: [2, 0, 0], op: "eq", constant: 3 },
          { coeffs: [0, 1, 0], op: "eq", constant: 0 },
          { coeffs: [0, 0, 1], op: "eq", constant: 0 },
        ],
      }),
    },
    {
      id: "rank-deficient-multiple-solution",
      description: "two dependent rows leave multiple integer tuples",
      spec: ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [
          { coeffs: [1, 1, 0], op: "eq", constant: 5 },
          { coeffs: [2, 2, 0], op: "eq", constant: 10 },
        ],
      }),
    },
    {
      id: "strict-boundary",
      description: "x<1 fixes x=0 while x<=1 would allow two values",
      spec: ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [
          { coeffs: [1, 0, 0], op: "lt", constant: 1 },
          { coeffs: [0, 1, 0], op: "eq", constant: 0 },
          { coeffs: [0, 0, 1], op: "eq", constant: 0 },
        ],
      }),
    },
    {
      id: "all-different",
      description: "pairwise distinctness removes the repeated-coordinate tuple",
      spec: ArithmeticSpecSchema.parse({
        allDifferent: true,
        constraints: [
          { coeffs: [1, 0, 0], op: "eq", constant: 0 },
          { coeffs: [0, 1, 0], op: "eq", constant: 1 },
          { coeffs: [0, 0, 1], op: "eq", constant: 2 },
        ],
      }),
    },
  ];
}

export const arithmeticEngine: FamilyEngine<ArithmeticSpec, ArithmeticAnswer> = {
  family: "arithmetic",
  modality: "text",
  schema: ArithmeticSpecSchema,
  generateSpec(seed, difficulty) {
    return constructArithmeticSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeArithmeticSpec(spec);
  },
  testMutations,
};
