import { describe, expect, it } from "vitest";
import { deepEqual } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import { canonicalStructuresEqual } from "../../src/families/canonicalize.js";
import {
  CanonicalStructureSchema,
  SolveResultSchema,
  VisibleRulesSchema,
  ruleFacts,
} from "../../src/families/contracts.js";
import { productionRegistry } from "../../src/families/registry.js";
import { canonicalizeTruthSpec } from "../../src/families/truth/canonical.js";
import {
  TruthConstructionError,
  constructTruthSpec,
  truthEngine,
} from "../../src/families/truth/engine.js";
import {
  TruthRpnParseError,
  TruthSpecSchema,
  TruthVectorSchema,
  astKey,
  astStats,
  canonicalizeAst,
  containsBinary,
  containsXor,
  evaluateAst,
  generateTruthAstPool,
  truthAstToRpn,
  truthRpnSpecToCanonical,
  truthSpecToRpn,
  type TruthAst,
  type TruthPeople,
  type TruthSpec,
} from "../../src/families/truth/schema.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

const leaf = (person: number): TruthAst => ({ kind: "truthful", person });
const not = (operand: TruthAst): TruthAst => ({ kind: "not", operand });
const and = (left: TruthAst, right: TruthAst): TruthAst => ({
  kind: "and",
  left,
  right,
});
const or = (left: TruthAst, right: TruthAst): TruthAst => ({
  kind: "or",
  left,
  right,
});
const xor = (left: TruthAst, right: TruthAst): TruthAst => ({
  kind: "xor",
  left,
  right,
});

function makeSpec(
  people: TruthPeople,
  exactTruthful: number,
  statements: readonly TruthAst[],
): TruthSpec {
  return TruthSpecSchema.parse({ people, exactTruthful, statements });
}

const uniqueSpec = makeSpec(3, 1, [not(leaf(1)), leaf(2), not(leaf(0))]);
const uniqueVector = [true, false, false] as const;

function permutationMap(permutation: readonly number[]): ReadonlyMap<number, number> {
  const mapping = new Map<number, number>();
  for (const [oldPerson, newPerson] of permutation.entries()) {
    mapping.set(oldPerson, newPerson);
  }
  return mapping;
}

function relabelTruthSpec(
  spec: TruthSpec,
  permutation: readonly number[],
): TruthSpec {
  const mapping = permutationMap(permutation);
  const statements = new Array<TruthAst | undefined>(spec.people);
  for (const [speaker, statement] of spec.statements.entries()) {
    const newSpeaker = mapping.get(speaker);
    if (newSpeaker === undefined) {
      throw new Error("expected a complete truth relabeling");
    }
    statements[newSpeaker] = canonicalizeAst(statement, mapping);
  }
  return makeSpec(
    spec.people,
    spec.exactTruthful,
    statements.map((statement) => {
      if (statement === undefined) {
        throw new Error("expected a complete truth statement set");
      }
      return statement;
    }),
  );
}

describe("truth DSL", () => {
  it("accepts bounded ASTs and rejects wrong population, count, statement count, and oversized ASTs", () => {
    expect(() => TruthSpecSchema.parse(uniqueSpec)).not.toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 4,
        exactTruthful: 2,
        statements: [leaf(0), not(leaf(1)), or(leaf(2), leaf(3)), xor(leaf(0), leaf(1))],
      }),
    ).not.toThrow();

    expect(() =>
      TruthSpecSchema.parse({
        people: 2,
        exactTruthful: 1,
        statements: [leaf(0), leaf(1)],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 3,
        exactTruthful: 3,
        statements: [leaf(0), leaf(1), leaf(2)],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 3,
        exactTruthful: 1,
        statements: [leaf(0), leaf(1)],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 3,
        exactTruthful: 1,
        statements: [not(not(not(leaf(0)))), leaf(1), leaf(2)],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 4,
        exactTruthful: 2,
        statements: [
          and(leaf(0), and(leaf(1), and(leaf(2), leaf(3)))),
          leaf(0),
          leaf(1),
          leaf(2),
        ],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 3,
        exactTruthful: 1,
        statements: [leaf(3), leaf(1), leaf(2)],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        people: 3,
        exactTruthful: 1,
        statements: [{ kind: "english", text: "P1 lies" }, leaf(1), leaf(2)],
      }),
    ).toThrow();
    expect(() =>
      TruthSpecSchema.parse({
        ...uniqueSpec,
        extra: true,
      }),
    ).toThrow();
  });

  it("evaluates not/and/or/xor recursively and enforces AST limits", () => {
    expect(evaluateAst(leaf(0), [true, false])).toBe(true);
    expect(evaluateAst(not(leaf(0)), [true, false])).toBe(false);
    expect(evaluateAst(and(leaf(0), leaf(1)), [true, false])).toBe(false);
    expect(evaluateAst(or(leaf(0), leaf(1)), [true, false])).toBe(true);
    expect(evaluateAst(xor(leaf(0), leaf(1)), [true, false])).toBe(true);
    expect(evaluateAst(xor(leaf(0), leaf(1)), [true, true])).toBe(false);
    expect(evaluateAst(xor(leaf(0), leaf(1)), [false, false])).toBe(false);

    const legal = and(not(leaf(0)), and(leaf(1), leaf(2)));
    expect(astStats(legal)).toEqual({ nodes: 6, leaves: 3, depth: 2 });
    expect(containsBinary(legal)).toBe(true);
    expect(containsXor(legal)).toBe(false);
    expect(astKey(and(leaf(0), leaf(1)))).toBe(astKey(and(leaf(1), leaf(0))));
    expect(TruthVectorSchema.safeParse([true, false]).success).toBe(false);
  });

  it("generates a finite pool without xor at levels below 3", () => {
    const levelTwo = generateTruthAstPool(4, false);
    const levelThree = generateTruthAstPool(4, true);
    expect(levelTwo.length).toBeGreaterThan(0);
    expect(levelTwo.every((ast) => !containsXor(ast))).toBe(true);
    expect(levelThree.some((ast) => containsXor(ast))).toBe(true);
  });
});

describe("truth solver", () => {
  it("finds one full truth vector from self-referential statements", () => {
    const result = truthEngine.enumerateSolutions(uniqueSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual([...uniqueVector]);
    expect(result.enumeratedStates).toBe(8);
    expect(result.checkerVersion).toBe("truth-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(truthEngine.verifyAnswer(uniqueSpec, [...uniqueVector])).toBe(true);
    expect(truthEngine.verifyAnswer(uniqueSpec, [false, false, true])).toBe(false);
  });

  it("detects zero and multiple fixed points and exact-count contradictions", () => {
    const noFixedPoint = makeSpec(3, 1, [
      not(leaf(0)),
      not(leaf(1)),
      not(leaf(2)),
    ]);
    const none = truthEngine.enumerateSolutions(noFixedPoint);
    expect(none.solutionCount).toBe(0);
    expect(none.answerCount).toBe(0);
    expect(none.correctAnswer).toBeNull();
    expect(none.proof).toBeNull();

    const multiple = makeSpec(3, 1, [leaf(0), leaf(1), leaf(2)]);
    const many = truthEngine.enumerateSolutions(multiple);
    expect(many.solutionCount).toBe(3);
    expect(many.correctAnswer).toBeNull();

    const countContradiction = makeSpec(3, 1, [leaf(1), leaf(2), leaf(0)]);
    expect(truthEngine.enumerateSolutions(countContradiction).solutionCount).toBe(0);
  });

  it("evaluates exactly-one XOR in a unique vector", () => {
    const xorSpec = makeSpec(3, 1, [xor(leaf(0), leaf(1)), leaf(0), leaf(2)]);
    const result = truthEngine.enumerateSolutions(xorSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.correctAnswer).toEqual([false, false, true]);
    expect(truthEngine.verifyAnswer(xorSpec, [false, false, true])).toBe(true);
    expect(truthEngine.verifyAnswer(xorSpec, [true, true, false])).toBe(false);
  });

  it("rejects vectors with the wrong length or truthful count", () => {
    expect(truthEngine.verifyAnswer(uniqueSpec, [true, false])).toBe(false);
    expect(truthEngine.verifyAnswer(uniqueSpec, [true, true, true])).toBe(false);
  });
});

describe("truth options", () => {
  it("builds four complete T/F vectors and validates the key", () => {
    const result = truthEngine.enumerateSolutions(uniqueSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique truth vector");
    }
    const set = truthEngine.makeOptions(uniqueSpec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    for (const choice of set.choices) {
      expect(choice.value).toHaveLength(3);
      expect(truthEngine.verifyAnswer(uniqueSpec, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
    }
    expect(truthEngine.makeOptions(uniqueSpec, correct, SEED_A)).toEqual(set);
    expect(() => truthEngine.makeOptions(uniqueSpec, [false, false, true], SEED_A)).toThrow();
  });

  it("rejects ambiguous specs and uses the seed to change option order", () => {
    const ambiguous = makeSpec(3, 1, [leaf(0), leaf(1), leaf(2)]);
    expect(() => truthEngine.makeOptions(ambiguous, [true, false, false], SEED_A)).toThrow();

    const result = truthEngine.enumerateSolutions(uniqueSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique truth vector");
    }
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = truthEngine.makeOptions(uniqueSpec, correct, seed);
      orders.add(set.choices.map((choice) => choice.value.join("")).join("|"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("truth canonicalization", () => {
  it("canonicalizes person relabelings and commutative operands", () => {
    const baseline = canonicalizeTruthSpec(uniqueSpec);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["exactTruthful=1", "people=3"]);
    expect(baseline.queryTokens).toEqual([]);
    expect(baseline.geometryTokens).toEqual([]);

    const relabeled = relabelTruthSpec(uniqueSpec, [2, 0, 1]);
    expect(canonicalStructuresEqual(canonicalizeTruthSpec(relabeled), baseline)).toBe(true);
    expect(astKey(and(leaf(0), leaf(1)))).toBe(astKey(and(leaf(1), leaf(0))));

    const xorSpec = makeSpec(3, 1, [xor(leaf(0), leaf(1)), leaf(0), leaf(2)]);
    expect(canonicalStructuresEqual(canonicalizeTruthSpec(xorSpec), baseline)).toBe(false);
  });

  it("reduces a tautological statement to an internal subset while facts keep all statements", () => {
    const redundant = makeSpec(3, 1, [leaf(0), leaf(2), not(leaf(0))]);
    const solved = truthEngine.enumerateSolutions(redundant);
    expect(solved.solutionCount).toBe(1);
    expect(solved.correctAnswer).toEqual([true, false, false]);

    const structure = canonicalizeTruthSpec(redundant);
    expect(structure.relationTokens.length).toBeLessThan(3);
    expect(structure.relationTokens.length).toBeGreaterThanOrEqual(1);
    expect(truthEngine.facts(redundant)).toHaveLength(3);
  });

  it("rejects canonicalization of ambiguous specs", () => {
    const ambiguous = makeSpec(3, 1, [leaf(0), leaf(1), leaf(2)]);
    expect(() => truthEngine.canonicalData(ambiguous)).toThrow();
  });
});

describe("truth construction", () => {
  it("is deterministic for one seed and varies across seeds", () => {
    const first = constructTruthSpec(SEED_A, 2);
    const second = constructTruthSpec(SEED_A, 2);
    expect(second).toEqual(first);
    const other = constructTruthSpec(SEED_B, 2);
    expect(deepEqual(other.spec, first.spec)).toBe(false);
    expect(other.trace.drawsUsed).toBeLessThanOrEqual(64);
  });

  it("constructs at least 95 of 100 fixed seeds across both populations", () => {
    const difficulties: Difficulty[] = [
      ...Array.from({ length: 34 }, () => 1 as Difficulty),
      ...Array.from({ length: 33 }, () => 2 as Difficulty),
      ...Array.from({ length: 33 }, () => 3 as Difficulty),
    ];
    const successes: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
    const populationSuccesses: Record<3 | 4, number> = { 3: 0, 4: 0 };
    const failures: Array<{
      readonly seed: string;
      readonly difficulty: Difficulty;
      readonly code: string;
    }> = [];
    const specs: TruthSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `truth-fixture-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructTruthSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof TruthConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      const expectedPeople: TruthPeople = difficulty === 1 ? 3 : 4;
      expect(spec.people).toBe(expectedPeople);
      expect(spec.statements).toHaveLength(expectedPeople);
      expect(spec.exactTruthful).toBeGreaterThanOrEqual(1);
      expect(spec.exactTruthful).toBeLessThan(expectedPeople);
      expect(trace.people).toBe(expectedPeople);
      expect(trace.poolSize).toBeGreaterThan(0);
      expect(trace.attempts).toBeLessThanOrEqual(64);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      expect(trace.binaryStatements).toBeGreaterThanOrEqual(0);
      expect(trace.xorStatements).toBeGreaterThanOrEqual(0);
      if (difficulty === 1) {
        expect(trace.binaryStatements).toBeLessThanOrEqual(1);
      }
      if (difficulty === 2) {
        expect(trace.xorStatements).toBe(0);
      }
      for (const statement of spec.statements) {
        const stats = astStats(statement);
        expect(stats.depth).toBeLessThanOrEqual(2);
        expect(stats.leaves).toBeLessThanOrEqual(3);
        expect(stats.nodes).toBeLessThanOrEqual(7);
      }

      const result = truthEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      expect(result.correctAnswer).not.toBeNull();
      if (result.correctAnswer !== null) {
        expect(truthEngine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
      }
      populationSuccesses[expectedPeople] += 1;
      specs.push(spec);
    }

    expect(successes[1]).toBeGreaterThanOrEqual(30);
    expect(successes[2]).toBeGreaterThanOrEqual(30);
    expect(successes[3]).toBeGreaterThanOrEqual(30);
    expect(successes[1] + successes[2] + successes[3]).toBeGreaterThanOrEqual(95);
    expect(populationSuccesses[3]).toBeGreaterThanOrEqual(30);
    expect(populationSuccesses[4]).toBeGreaterThanOrEqual(60);
    expect(failures.length).toBeLessThanOrEqual(5);
    expect(new Set(specs.map((spec) => JSON.stringify(spec))).size).toBeGreaterThan(1);
  });
});

describe("truth engine contract and registry", () => {
  it("keeps the hidden witness out of the generated spec and rejects oversized ASTs before evaluation", () => {
    const generated = truthEngine.generateSpec(SEED_A, 2);
    expect(Object.keys(generated).sort()).toEqual([
      "exactTruthful",
      "people",
      "statements",
    ]);
    expect(truthEngine.generateSpec(SEED_A, 2)).toEqual(generated);
    expect(() =>
      TruthSpecSchema.parse({ ...generated, witness: uniqueVector }),
    ).toThrow();

    const oversized = {
      people: 3,
      exactTruthful: 1,
      statements: [not(not(not(leaf(0)))), leaf(1), leaf(2)],
    };
    expect(() => TruthSpecSchema.parse(oversized)).toThrow();
  });

  it("returns deterministic test mutations with known formal outcomes", () => {
    const mutations = truthEngine.testMutations(uniqueSpec);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "self-reference-no-fixed-point",
      "self-reference-multiple-fixed-points",
      "truthful-count-contradiction",
    ]);
    expect(truthEngine.testMutations(uniqueSpec)).toEqual(mutations);
    const byId = new Map(mutations.map((mutation) => [mutation.id, mutation.spec]));
    const none = byId.get("self-reference-no-fixed-point");
    const many = byId.get("self-reference-multiple-fixed-points");
    const contradiction = byId.get("truthful-count-contradiction");
    if (none === undefined || many === undefined || contradiction === undefined) {
      throw new Error("expected all truth test mutations");
    }
    expect(truthEngine.enumerateSolutions(none).solutionCount).toBe(0);
    expect(truthEngine.enumerateSolutions(many).solutionCount).toBe(3);
    expect(truthEngine.enumerateSolutions(contradiction).solutionCount).toBe(0);
  });

  it("exposes the truthful count and all operation names in code-owned rules", () => {
    const rules = truthEngine.visibleRules(uniqueSpec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.closedWorld).toContain("Exactly 1");
    expect(rules.operations).toHaveLength(6);
    expect(rules.conventions.some((line) => line.includes("T means"))).toBe(true);
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);

    const facts = truthEngine.facts(uniqueSpec);
    expect(facts.map((fact) => fact.factId)).toEqual(["f001", "f002", "f003"]);
    expect(facts[0]?.text).toContain("P1 says");
    expect(facts[0]?.text).toContain("not");
  });

  it("parses postfix RPN expressions into the canonical AST", () => {
    const statements = [
      leaf(0),
      not(leaf(1)),
      and(leaf(1), leaf(2)),
    ];
    const spec = makeSpec(3, 1, statements);
    const rpn = truthSpecToRpn(spec);
    expect(rpn.statements.map((statement) => statement.rpn)).toEqual([
      [{ kind: "truthful", person: 0 }],
      [{ kind: "truthful", person: 1 }, { kind: "not" }],
      [
        { kind: "truthful", person: 1 },
        { kind: "truthful", person: 2 },
        { kind: "and" },
      ],
    ]);
    expect(truthRpnSpecToCanonical(rpn)).toEqual(spec);
  });

  it("parses NOT, AND, OR, XOR, and nested RPN expressions", () => {
    const nested = and(not(leaf(0)), or(leaf(1), leaf(2)));
    const spec = makeSpec(4, 2, [
      nested,
      xor(leaf(2), leaf(3)),
      leaf(0),
      leaf(1),
    ]);
    const parsed = truthRpnSpecToCanonical(truthSpecToRpn(spec));
    expect(parsed).toEqual(spec);
    expect(astKey(parsed.statements[0] as TruthAst)).toBe(astKey(nested));
  });

  it("round-trips AST -> RPN -> AST for generated legal expressions", () => {
    const pool = generateTruthAstPool(3, false);
    for (const ast of pool) {
      const rpn = truthAstToRpn(ast);
      const parsed = truthRpnSpecToCanonical({
        people: 3,
        exactTruthful: 1,
        statements: [
          { rpn },
          { rpn: truthAstToRpn(leaf(1)) },
          { rpn: truthAstToRpn(leaf(2)) },
        ],
      });
      expect(astKey(parsed.statements[0] as TruthAst)).toBe(astKey(ast));
      expect(astStats(parsed.statements[0] as TruthAst)).toEqual(astStats(ast));
    }
  });

  it("rejects malformed RPN explicitly instead of repairing it", () => {
    const valid = (rpn: unknown[], people = 3) => ({
      people,
      exactTruthful: 1,
      statements: [
        { rpn },
        { rpn: [{ kind: "truthful", person: 1 }] },
        { rpn: [{ kind: "truthful", person: 2 }] },
      ],
    });
    const expectCode = (input: unknown, code: string): void => {
      try {
        truthRpnSpecToCanonical(input);
        throw new Error("expected RPN parse failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TruthRpnParseError);
        expect((error as TruthRpnParseError).code).toBe(code);
      }
    };
    expectCode(valid([{ kind: "and" }]), "STACK_UNDERFLOW");
    expectCode(valid([{ kind: "not" }]), "STACK_UNDERFLOW");
    expectCode(
      valid([
        { kind: "truthful", person: 0 },
        { kind: "truthful", person: 1 },
      ]),
      "EXCESS_OPERANDS",
    );
    expectCode(
      valid([{ kind: "truthful", person: 3 }]),
      "PERSON_OUT_OF_RANGE",
    );
    expectCode(
      valid([{ kind: "truthful", person: 0 }, { kind: "not" }, { kind: "not" }, { kind: "not" }]),
      "DEPTH_EXCEEDED",
    );
    expectCode(
      {
        people: 4,
        exactTruthful: 2,
        statements: [
          {
            rpn: [
              { kind: "truthful", person: 0 },
              { kind: "truthful", person: 1 },
              { kind: "and" },
              { kind: "truthful", person: 2 },
              { kind: "truthful", person: 3 },
              { kind: "and" },
              { kind: "and" },
            ],
          },
          { rpn: [{ kind: "truthful", person: 0 }] },
          { rpn: [{ kind: "truthful", person: 1 }] },
          { rpn: [{ kind: "truthful", person: 2 }] },
        ],
      },
      "LEAVES_EXCEEDED",
    );
    expectCode(
      {
        people: 3,
        exactTruthful: 1,
        statements: [
          { rpn: [{ kind: "truthful", person: 0 }] },
          { rpn: [{ kind: "truthful", person: 1 }] },
          { rpn: [{ kind: "truthful", person: 2 }] },
          { rpn: [{ kind: "truthful", person: 0 }] },
        ],
      },
      "STATEMENT_COUNT",
    );
    expectCode(
      {
        people: 3,
        exactTruthful: 3,
        statements: [
          { rpn: [{ kind: "truthful", person: 0 }] },
          { rpn: [{ kind: "truthful", person: 1 }] },
          { rpn: [{ kind: "truthful", person: 2 }] },
        ],
      },
      "EXACT_TRUTHFUL",
    );
    expectCode(
      {
        people: 3,
        exactTruthful: 1,
        statements: [
          { rpn: [{ kind: "truthful", person: 0 }], extra: true },
          { rpn: [{ kind: "truthful", person: 1 }] },
          { rpn: [{ kind: "truthful", person: 2 }] },
        ],
      },
      "INVALID_STRUCTURE",
    );
  });

  it("registers truth among the real text engines", () => {
    expect(productionRegistry.listEngineFamilies()).toContain("truth");
    expect(productionRegistry.getEngine("truth").family).toBe("truth");
    expect(productionRegistry.getEngine("truth").modality).toBe("text");
  });
});
