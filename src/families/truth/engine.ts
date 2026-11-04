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
import { canonicalizeTruthSpec } from "./canonical.js";
import {
  TruthSpecSchema,
  TruthVectorSchema,
  astText,
  containsBinary,
  containsXor,
  evaluateAst,
  generateTruthAstPool,
  solveTruthAssignments,
  truthVectorText,
  type TruthAnswer,
  type TruthAst,
  type TruthPeople,
  type TruthSpec,
  type TruthVector,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_CONSTRUCTION_ATTEMPTS = 64;
const RANDOM_ATTEMPTS = 8;

export type TruthConstructionErrorCode =
  | "DRAW_LIMIT"
  | "NO_UNIQUE_SYSTEM"
  | "INVALID_DIFFICULTY";

export class TruthConstructionError extends Error {
  readonly code: TruthConstructionErrorCode;

  constructor(code: TruthConstructionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TruthConstructionError";
    this.code = code;
  }
}

export type TruthEngineErrorCode =
  | "INVALID_ANSWER"
  | "NOT_UNIQUE"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class TruthEngineError extends Error {
  readonly code: TruthEngineErrorCode;

  constructor(code: TruthEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TruthEngineError";
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
      throw new TruthConstructionError(
        "DRAW_LIMIT",
        `truth construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }

  sampleDistinct<T>(items: readonly T[], count: number): T[] {
    if (!Number.isInteger(count) || count < 0 || count > items.length) {
      throw new RangeError(`truth sample count ${count} is outside 0..${items.length}`);
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
        throw new Error("truth sample encountered an invalid index");
      }
      selected.push(chosen);
      pool[pick] = last;
      pool[lastIndex] = chosen;
    }
    return selected;
  }
}

function peopleIds(people: TruthPeople): readonly number[] {
  return Array.from({ length: people }, (_value, index) => index);
}

function allTruthVectors(people: TruthPeople): readonly TruthVector[] {
  const vectors: TruthVector[] = [];
  for (let mask = 0; mask < 1 << people; mask += 1) {
    const vector: boolean[] = [];
    for (let person = 0; person < people; person += 1) {
      vector.push((mask & (1 << person)) !== 0);
    }
    vectors.push(vector);
  }
  return vectors;
}

function anchorStatements(
  people: TruthPeople,
  witness: readonly boolean[],
): TruthAst[] {
  return Array.from({ length: people }, (_value, person) => {
    const nextPerson = (person + 1) % people;
    const nextValue = witness[nextPerson];
    if (nextValue === undefined) {
      throw new RangeError("truth witness is incomplete");
    }
    return witness[person] === nextValue
      ? { kind: "truthful", person: nextPerson }
      : { kind: "not", operand: { kind: "truthful", person: nextPerson } };
  });
}

function statementsAgree(
  statements: readonly TruthAst[],
  witness: readonly boolean[],
): boolean {
  return statements.every(
    (statement, person) => evaluateAst(statement, witness) === witness[person],
  );
}

export interface TruthConstructionTrace {
  readonly people: TruthPeople;
  readonly exactTruthful: number;
  readonly poolSize: number;
  readonly attempts: number;
  readonly fallbackUsed: boolean;
  readonly binaryStatements: number;
  readonly xorStatements: number;
  readonly drawsUsed: number;
}

export interface TruthConstructionResult {
  readonly spec: TruthSpec;
  readonly trace: TruthConstructionTrace;
}

export function constructTruthSpec(
  seed: string,
  difficulty: Difficulty,
): TruthConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new TruthConstructionError(
      "INVALID_DIFFICULTY",
      `truth difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const people: TruthPeople = difficulty === 1 ? 3 : 4;
  const countOptions = people === 3 ? [1, 2] : [1, 3];
  const countIndex = draw.nextInt(countOptions.length);
  const exactTruthful = countOptions[countIndex];
  if (exactTruthful === undefined) {
    throw new TruthConstructionError(
      "NO_UNIQUE_SYSTEM",
      "truth construction could not choose an exact truthful count",
    );
  }
  const truthfulPeople = draw.sampleDistinct(peopleIds(people), exactTruthful);
  const truthfulSet = new Set(truthfulPeople);
  const witness = peopleIds(people).map((person) => truthfulSet.has(person));
  const anchor = anchorStatements(people, witness);
  const anchorSpec = TruthSpecSchema.parse({
    people,
    exactTruthful,
    statements: anchor,
  });
  const anchorSolved = solveTruthAssignments(anchorSpec);
  if (
    anchorSolved.solutions.length !== 1 ||
    !deepEqual(anchorSolved.solutions[0], witness)
  ) {
    throw new TruthConstructionError(
      "NO_UNIQUE_SYSTEM",
      "truth anchor did not produce the intended unique vector",
    );
  }

  const pool = generateTruthAstPool(people, difficulty === 3);
  const candidates = peopleIds(people).map((person) =>
    pool.filter((ast) => evaluateAst(ast, witness) === witness[person]),
  );
  const binaryCandidates = candidates.map((list) =>
    list.filter((ast) => containsBinary(ast)),
  );
  const xorCandidates = candidates.map((list) =>
    list.filter((ast) => containsXor(ast)),
  );

  let attempts = 0;
  const trySpec = (statements: readonly TruthAst[]): TruthSpec | undefined => {
    if (attempts >= MAX_CONSTRUCTION_ATTEMPTS) {
      return undefined;
    }
    attempts += 1;
    const spec = TruthSpecSchema.parse({ people, exactTruthful, statements });
    const solved = solveTruthAssignments(spec);
    if (solved.solutions.length === 1 && deepEqual(solved.solutions[0], witness)) {
      return spec;
    }
    return undefined;
  };

  const oneSlotEnriched = (
    source: readonly (readonly TruthAst[])[],
  ): TruthSpec | undefined => {
    for (let slot = 0; slot < people; slot += 1) {
      const options = source[slot];
      if (options === undefined || options.length === 0) {
        continue;
      }
      const picked = options[draw.nextInt(options.length)];
      if (picked === undefined) {
        continue;
      }
      const statements = anchor.map((statement, person) =>
        person === slot ? picked : statement,
      );
      if (!statementsAgree(statements, witness)) {
        continue;
      }
      const spec = trySpec(statements);
      if (spec !== undefined) {
        return spec;
      }
    }
    return undefined;
  };

  const fullRandom = (): TruthSpec | undefined => {
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
      const statements: TruthAst[] = [];
      for (let person = 0; person < people; person += 1) {
        const options = candidates[person];
        if (options === undefined || options.length === 0) {
          break;
        }
        const picked = options[draw.nextInt(options.length)];
        if (picked === undefined) {
          break;
        }
        statements.push(picked);
      }
      if (statements.length !== people || !statementsAgree(statements, witness)) {
        continue;
      }
      const spec = trySpec(statements);
      if (spec !== undefined) {
        return spec;
      }
    }
    return undefined;
  };

  let selected = oneSlotEnriched(binaryCandidates);
  if (selected === undefined && difficulty === 3) {
    selected = oneSlotEnriched(xorCandidates);
  }
  if (selected === undefined && difficulty >= 2) {
    selected = fullRandom();
  }

  const fallbackUsed = selected === undefined;
  const spec = selected ?? anchorSpec;
  const binaryStatements = spec.statements.filter((statement) =>
    containsBinary(statement),
  ).length;
  const xorStatements = spec.statements.filter((statement) =>
    containsXor(statement),
  ).length;
  return {
    spec,
    trace: {
      people,
      exactTruthful,
      poolSize: pool.length,
      attempts,
      fallbackUsed,
      binaryStatements,
      xorStatements,
      drawsUsed: draw.used,
    },
  };
}

function enumerateSolutions(spec: TruthSpec): SolveResult<TruthAnswer> {
  const parsed = TruthSpecSchema.parse(spec);
  const solved = solveTruthAssignments(parsed);
  const solution = solved.solutions.length === 1 ? solved.solutions[0] : undefined;
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    correctAnswer: solution === undefined ? null : [...solution],
    proof:
      solution === undefined
        ? null
        : {
            facts: [
              {
                factId: "s001",
                kind: "derived",
                text: `The unique truth vector is ${truthVectorText(solution)}.`,
              },
            ],
            witness: [...solution],
          },
    enumeratedStates: solved.enumeratedStates,
    checkerVersion: "truth-v1",
  };
}

function verifyAnswer(spec: TruthSpec, answer: TruthAnswer): boolean {
  const parsed = TruthSpecSchema.parse(spec);
  const vector = TruthVectorSchema.safeParse(answer);
  if (!vector.success || vector.data.length !== parsed.people) {
    return false;
  }
  const truth = vector.data;
  if (truth.filter(Boolean).length !== parsed.exactTruthful) {
    return false;
  }
  return parsed.statements.every(
    (statement, speaker) => truth[speaker] === evaluateAst(statement, truth),
  );
}

function makeOptions(
  spec: TruthSpec,
  answer: TruthAnswer,
  seed: string,
): ChoiceSet<TruthAnswer> {
  const parsed = TruthSpecSchema.parse(spec);
  const solvedSpec = solveTruthAssignments(parsed);
  const unique = solvedSpec.solutions.length === 1 ? solvedSpec.solutions[0] : undefined;
  if (unique === undefined) {
    throw new TruthEngineError(
      "NOT_UNIQUE",
      `truth options require one full vector, received ${solvedSpec.solutions.length}`,
    );
  }
  const supplied = TruthVectorSchema.safeParse(answer);
  if (!supplied.success || !deepEqual(supplied.data, unique)) {
    throw new TruthEngineError(
      "INVALID_ANSWER",
      "truth options require the unique satisfying vector",
    );
  }

  const falseVectors: TruthAnswer[] = [];
  for (const vector of allTruthVectors(parsed.people)) {
    if (!verifyAnswer(parsed, vector)) {
      falseVectors.push(vector);
    }
  }
  const prng = new HashCounterPrng(seed);
  const ordered = prng.shuffle(falseVectors);
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new TruthEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "truth spec has fewer than three false truth vectors",
    );
  }
  const choices = makeChoiceSet({
    correct: [...unique],
    distractors: [first, second, third] as [
      TruthAnswer,
      TruthAnswer,
      TruthAnswer,
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
    throw new TruthEngineError(
      "INVALID_OPTION_SET",
      `truth option set contains ${trueChoices} satisfying vectors`,
    );
  }
  return choices;
}

function visibleRules(spec: TruthSpec): VisibleRules {
  const parsed = TruthSpecSchema.parse(spec);
  return {
    domain: `${parsed.people} people P1-P${parsed.people} each make exactly one statement about who is truthful.`,
    closedWorld: `A truth teller's statement is true and a liar's statement is false. Exactly ${parsed.exactTruthful} of the ${parsed.people} people are truthful. No other role types exist.`,
    target: `Determine the complete truthful/liar status of all ${parsed.people} people.`,
    operations: [
      "truthful(person): the person is a truth teller.",
      "not(x): the operand is false.",
      "and(x,y): both operands are true.",
      "or(x,y): at least one operand is true.",
      "xor(x,y): exactly one operand is true.",
      "Statements use at most depth 2, three leaves, and seven nodes; self-reference is allowed only through this finite Boolean semantics.",
    ],
    conventions: [
      "T means truth teller and F means liar.",
      `The exact truthful count is ${parsed.exactTruthful}.`,
      "The answer lists every person in P1-PN order.",
    ],
  };
}

function facts(spec: TruthSpec): readonly Fact[] {
  const parsed = TruthSpecSchema.parse(spec);
  return parsed.statements.map((statement, speaker) => ({
    factId: formatFactId("local", speaker),
    kind: "local" as const,
    text: `P${speaker + 1} says: ${astText(statement)}.`,
  }));
}

function testMutations(_spec: TruthSpec): readonly TestMutation<TruthSpec>[] {
  const noFixedPoint: TruthSpec = TruthSpecSchema.parse({
    people: 3,
    exactTruthful: 1,
    statements: [
      { kind: "not", operand: { kind: "truthful", person: 0 } },
      { kind: "not", operand: { kind: "truthful", person: 1 } },
      { kind: "not", operand: { kind: "truthful", person: 2 } },
    ],
  });
  const multipleFixedPoints: TruthSpec = TruthSpecSchema.parse({
    people: 3,
    exactTruthful: 1,
    statements: [
      { kind: "truthful", person: 0 },
      { kind: "truthful", person: 1 },
      { kind: "truthful", person: 2 },
    ],
  });
  const countContradiction: TruthSpec = TruthSpecSchema.parse({
    people: 3,
    exactTruthful: 1,
    statements: [
      { kind: "truthful", person: 1 },
      { kind: "truthful", person: 2 },
      { kind: "truthful", person: 0 },
    ],
  });
  return [
    {
      id: "self-reference-no-fixed-point",
      description: "each person denies their own truthfulness",
      spec: noFixedPoint,
    },
    {
      id: "self-reference-multiple-fixed-points",
      description: "tautological statements leave several one-truthful vectors",
      spec: multipleFixedPoints,
    },
    {
      id: "truthful-count-contradiction",
      description: "the statements force all truth values equal but the count is one",
      spec: countContradiction,
    },
  ];
}

export const truthEngine: FamilyEngine<TruthSpec, TruthAnswer> = {
  family: "truth",
  modality: "text",
  schema: TruthSpecSchema,
  generateSpec(seed, difficulty) {
    return constructTruthSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeTruthSpec(spec);
  },
  testMutations,
};
