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
import {
  ArithmeticConstructionError,
  arithmeticEngine,
  constructArithmeticSpec,
} from "../../src/families/arithmetic/engine.js";
import { canonicalizeArithmeticSpec } from "../../src/families/arithmetic/canonical.js";
import {
  ArithmeticNormalizationError,
  ArithmeticSpecSchema,
  ArithmeticTupleSchema,
  constraintText,
  normalizeConstraint,
  normalizedConstraintKey,
  type ArithmeticAnswer,
  type ArithmeticConstraint,
  type ArithmeticSpec,
} from "../../src/families/arithmetic/schema.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

function eq(coeffs: [number, number, number], constant: number): ArithmeticConstraint {
  return { coeffs, op: "eq", constant };
}

function lt(coeffs: [number, number, number], constant: number): ArithmeticConstraint {
  return { coeffs, op: "lt", constant };
}

function le(coeffs: [number, number, number], constant: number): ArithmeticConstraint {
  return { coeffs, op: "le", constant };
}

function makeSpec(
  allDifferent: boolean,
  constraints: readonly ArithmeticConstraint[],
): ArithmeticSpec {
  return ArithmeticSpecSchema.parse({ allDifferent, constraints });
}

const uniqueSpec = makeSpec(false, [
  eq([1, 0, 0], 3),
  eq([0, 1, 0], 4),
  eq([0, 0, 1], 5),
]);
const uniqueTuple: ArithmeticAnswer = [3, 4, 5];

function relabelSpec(spec: ArithmeticSpec, permutation: readonly number[]): ArithmeticSpec {
  return makeSpec(
    spec.allDifferent,
    spec.constraints.map((constraint) => {
      const mapped: [number, number, number] = [0, 0, 0];
      for (let oldVariable = 0; oldVariable < 3; oldVariable += 1) {
        const newVariable = permutation[oldVariable];
        const coefficient = constraint.coeffs[oldVariable];
        if (newVariable === undefined || coefficient === undefined) {
          throw new Error("expected a complete arithmetic relabeling");
        }
        mapped[newVariable] = coefficient;
      }
      return { coeffs: mapped, op: constraint.op, constant: constraint.constant };
    }),
  );
}

describe("arithmetic DSL", () => {
  it("accepts 2-5 linear constraints and rejects malformed rows and tuples", () => {
    expect(() => makeSpec(false, [eq([1, 0, 0], 3), eq([0, 1, 0], 4)])).not.toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: true,
        constraints: [
          eq([1, 0, 0], 0),
          eq([0, 1, 0], 1),
          eq([0, 0, 1], 2),
          le([1, 1, 1], 10),
          lt([-1, 0, 0], 0),
        ],
      }),
    ).not.toThrow();

    expect(() =>
      ArithmeticSpecSchema.parse({ allDifferent: false, constraints: [eq([1, 0, 0], 0)] }),
    ).toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: Array.from({ length: 6 }, () => eq([1, 0, 0], 0)),
      }),
    ).toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [eq([4, 0, 0], 0), eq([0, 1, 0], 0)],
      }),
    ).toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [eq([0, 0, 0], 0), eq([0, 1, 0], 0)],
      }),
    ).toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [eq([1, 0, 0], 109), eq([0, 1, 0], 0)],
      }),
    ).toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [
          { coeffs: [1, 0, 0], op: "ne", constant: 0 },
          eq([0, 1, 0], 0),
        ],
      }),
    ).toThrow();
    expect(() =>
      ArithmeticSpecSchema.parse({
        allDifferent: false,
        constraints: [eq([1, 0, 0], 0), eq([0, 1, 0], 0)],
        extra: true,
      }),
    ).toThrow();
    expect(() => ArithmeticTupleSchema.parse([0, 12, 13])).toThrow();
    expect(() => ArithmeticTupleSchema.parse([-1, 0, 0])).toThrow();
  });

  it("displays negative coefficients and bounds unambiguously", () => {
    const text = constraintText(le([-1, 2, 0], -5));
    expect(text).toContain("(-1)*x");
    expect(text).toContain("(2)*y");
    expect(text).toContain("(-5)");
  });
});

describe("arithmetic solver", () => {
  it("enumerates all 2,197 tuples and requires one exact integer tuple", () => {
    const result = arithmeticEngine.enumerateSolutions(uniqueSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual(uniqueTuple);
    expect(result.enumeratedStates).toBe(2197);
    expect(result.checkerVersion).toBe("arithmetic-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(arithmeticEngine.verifyAnswer(uniqueSpec, uniqueTuple)).toBe(true);
    expect(arithmeticEngine.verifyAnswer(uniqueSpec, [3, 4, 6])).toBe(false);
    expect(arithmeticEngine.verifyAnswer(uniqueSpec, [3.5, 4, 5])).toBe(false);
  });

  it("detects no-integer, rank-deficient, strict-boundary, and allDifferent cases", () => {
    const noInteger = makeSpec(false, [
      eq([2, 0, 0], 3),
      eq([0, 1, 0], 0),
      eq([0, 0, 1], 0),
    ]);
    expect(arithmeticEngine.enumerateSolutions(noInteger).solutionCount).toBe(0);

    const rankDeficient = makeSpec(false, [
      eq([1, 1, 0], 5),
      eq([2, 2, 0], 10),
    ]);
    const multiple = arithmeticEngine.enumerateSolutions(rankDeficient);
    expect(multiple.solutionCount).toBeGreaterThan(1);
    expect(multiple.correctAnswer).toBeNull();

    const strict = makeSpec(false, [
      lt([1, 0, 0], 1),
      eq([0, 1, 0], 0),
      eq([0, 0, 1], 0),
    ]);
    expect(arithmeticEngine.enumerateSolutions(strict).correctAnswer).toEqual([0, 0, 0]);

    const nonstrict = makeSpec(false, [
      le([1, 0, 0], 1),
      eq([0, 1, 0], 0),
      eq([0, 0, 1], 0),
    ]);
    expect(arithmeticEngine.enumerateSolutions(nonstrict).solutionCount).toBe(2);

    const repeated = makeSpec(true, [
      eq([1, 0, 0], 0),
      eq([0, 1, 0], 1),
      eq([0, 0, 1], 1),
    ]);
    expect(arithmeticEngine.enumerateSolutions(repeated).solutionCount).toBe(0);

    const distinct = makeSpec(true, [
      eq([1, 0, 0], 0),
      eq([0, 1, 0], 1),
      eq([0, 0, 1], 2),
    ]);
    expect(arithmeticEngine.enumerateSolutions(distinct).correctAnswer).toEqual([0, 1, 2]);
  });
});

describe("arithmetic options", () => {
  it("builds four tuples, prefers one-step perturbations, and validates the key", () => {
    const result = arithmeticEngine.enumerateSolutions(uniqueSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique arithmetic tuple");
    }
    const set = arithmeticEngine.makeOptions(uniqueSpec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    for (const choice of set.choices) {
      expect(() => ArithmeticTupleSchema.parse(choice.value)).not.toThrow();
      expect(arithmeticEngine.verifyAnswer(uniqueSpec, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
    }
    const distractors = set.choices.filter((choice) => choice.label !== set.correctLabel);
    const oneStep = distractors.every((choice) => {
      const differences = choice.value
        .map((value, index) => Math.abs(value - (correct[index] ?? 0)))
        .filter((difference) => difference !== 0);
      return differences.length === 1 && differences[0] === 1;
    });
    expect(oneStep).toBe(true);
    expect(arithmeticEngine.makeOptions(uniqueSpec, correct, SEED_A)).toEqual(set);
    expect(() => arithmeticEngine.makeOptions(uniqueSpec, [3, 4, 6], SEED_A)).toThrow();
  });

  it("rejects ambiguous specs and uses the seed to change option order", () => {
    const ambiguous = makeSpec(false, [
      eq([1, 1, 0], 5),
      eq([2, 2, 0], 10),
    ]);
    expect(() => arithmeticEngine.makeOptions(ambiguous, [0, 5, 0], SEED_A)).toThrow();

    const result = arithmeticEngine.enumerateSolutions(uniqueSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique arithmetic tuple");
    }
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = arithmeticEngine.makeOptions(uniqueSpec, correct, seed);
      orders.add(set.choices.map((choice) => choice.value.join(",")).join("|"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("arithmetic canonicalization", () => {
  it("normalizes strict/nonstrict inequalities and negative bounds without flipping direction", () => {
    const strictKey = normalizedConstraintKey(lt([2, 0, 0], 11));
    const nonstrictKey = normalizedConstraintKey(le([2, 0, 0], 11));
    const reducedKey = normalizedConstraintKey(le([1, 0, 0], 5));
    expect(strictKey).toBe("le:1,0,0:5");
    expect(nonstrictKey).toBe("le:1,0,0:5");
    expect(reducedKey).toBe("le:1,0,0:5");

    expect(normalizedConstraintKey(le([-2, 0, 0], -11))).toBe("le:-1,0,0:-6");
    expect(normalizedConstraintKey(eq([-2, 0, 0], -4))).toBe("eq:1,0,0:2");
    expect(() => normalizeConstraint(eq([2, 0, 0], 3))).toThrow(
      ArithmeticNormalizationError,
    );
  });

  it("canonicalizes equivalent inequality fingerprints and variable relabelings", () => {
    const strictSpec = makeSpec(false, [
      lt([2, 0, 0], 11),
      le([-1, 0, 0], -5),
      eq([0, 1, 0], 3),
      eq([0, 0, 1], 4),
    ]);
    const nonstrictSpec = makeSpec(false, [
      le([1, 0, 0], 5),
      le([-1, 0, 0], -5),
      eq([0, 1, 0], 3),
      eq([0, 0, 1], 4),
    ]);
    const strictStructure = canonicalizeArithmeticSpec(strictSpec);
    expect(() => CanonicalStructureSchema.parse(strictStructure)).not.toThrow();
    expect(canonicalStructuresEqual(canonicalizeArithmeticSpec(nonstrictSpec), strictStructure)).toBe(
      true,
    );

    const relabeled = relabelSpec(uniqueSpec, [1, 0, 2]);
    expect(canonicalStructuresEqual(canonicalizeArithmeticSpec(relabeled), canonicalizeArithmeticSpec(uniqueSpec))).toBe(
      true,
    );

    const allDifferent = makeSpec(true, [
      eq([1, 0, 0], 0),
      eq([0, 1, 0], 1),
      eq([0, 0, 1], 2),
    ]);
    expect(canonicalStructuresEqual(canonicalizeArithmeticSpec(allDifferent), canonicalizeArithmeticSpec(uniqueSpec))).toBe(
      false,
    );
  });

  it("rejects canonicalization of ambiguous and nonintegral systems", () => {
    const ambiguous = makeSpec(false, [
      eq([1, 1, 0], 5),
      eq([2, 2, 0], 10),
    ]);
    expect(() => arithmeticEngine.canonicalData(ambiguous)).toThrow();

    const nonintegral = makeSpec(false, [
      eq([2, 0, 0], 3),
      eq([0, 1, 0], 0),
      eq([0, 0, 1], 0),
    ]);
    expect(() => arithmeticEngine.canonicalData(nonintegral)).toThrow();
  });
});

describe("arithmetic construction", () => {
  it("is deterministic for one seed and varies across seeds", () => {
    const first = constructArithmeticSpec(SEED_A, 3);
    const second = constructArithmeticSpec(SEED_A, 3);
    expect(second).toEqual(first);
    const other = constructArithmeticSpec(SEED_B, 3);
    expect(deepEqual(other.spec, first.spec)).toBe(false);
    expect(other.trace.drawsUsed).toBeLessThanOrEqual(64);
  });

  it("constructs at least 95 of 100 fixed seeds with independent uniqueness", () => {
    const difficulties: Difficulty[] = [
      ...Array.from({ length: 34 }, () => 1 as Difficulty),
      ...Array.from({ length: 33 }, () => 2 as Difficulty),
      ...Array.from({ length: 33 }, () => 3 as Difficulty),
    ];
    const successes: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
    const failures: Array<{
      readonly seed: string;
      readonly difficulty: Difficulty;
      readonly code: string;
    }> = [];
    const specs: ArithmeticSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `arithmetic-fixture-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructArithmeticSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof ArithmeticConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      const expectedLimit = difficulty === 1 ? 1 : difficulty === 2 ? 2 : 3;
      expect(trace.difficulty).toBe(difficulty);
      expect(trace.coefficientLimit).toBe(expectedLimit);
      expect(spec.constraints.length).toBeGreaterThanOrEqual(2);
      expect(spec.constraints.length).toBeLessThanOrEqual(5);
      expect(trace.operators).toEqual(spec.constraints.map((constraint) => constraint.op));
      expect(trace.anchorCount).toBe(difficulty === 3 ? 4 : 3);
      expect(trace.additionalRequested).toBe(difficulty === 3 ? 0 : 2);
      expect(trace.additionalAdded).toBe(trace.additionalRequested);
      expect(trace.additionalAdded).toBeLessThanOrEqual(2);
      expect(trace.constraintCountBeforePruning).toBeGreaterThanOrEqual(spec.constraints.length);
      expect(trace.constraintCountAfterPruning).toBe(spec.constraints.length);
      expect(trace.prunedConstraints).toBe(
        trace.constraintCountBeforePruning - trace.constraintCountAfterPruning,
      );
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      expect(trace.nonredundantInequalities).toBeGreaterThanOrEqual(1);
      if (difficulty === 3) {
        expect(trace.replacedVariable).not.toBeNull();
      } else {
        expect(trace.replacedVariable).toBeNull();
      }

      const result = arithmeticEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      expect(result.correctAnswer).not.toBeNull();
      if (result.correctAnswer !== null) {
        expect(arithmeticEngine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
        if (spec.allDifferent) {
          expect(new Set(result.correctAnswer).size).toBe(3);
        }
      }
      specs.push(spec);
    }

    expect(successes[1]).toBeGreaterThanOrEqual(30);
    expect(successes[2]).toBeGreaterThanOrEqual(30);
    expect(successes[3]).toBeGreaterThanOrEqual(30);
    expect(successes[1] + successes[2] + successes[3]).toBeGreaterThanOrEqual(95);
    expect(failures.length).toBeLessThanOrEqual(5);
    expect(new Set(specs.map((spec) => JSON.stringify(spec))).size).toBeGreaterThan(1);
  });
});

describe("arithmetic engine contract and registry", () => {
  it("keeps the hidden witness out of the generated spec and re-solves tampered specs", () => {
    const generated = arithmeticEngine.generateSpec(SEED_A, 3);
    expect(Object.keys(generated).sort()).toEqual(["allDifferent", "constraints"]);
    expect(arithmeticEngine.generateSpec(SEED_A, 3)).toEqual(generated);
    expect(() =>
      ArithmeticSpecSchema.parse({ ...generated, witness: uniqueTuple }),
    ).toThrow();

    const tampered = makeSpec(false, [
      eq([2, 0, 0], 3),
      eq([0, 1, 0], 0),
      eq([0, 0, 1], 0),
    ]);
    const result = arithmeticEngine.enumerateSolutions(tampered);
    expect(result.solutionCount).toBe(0);
    expect(result.correctAnswer).toBeNull();
  });

  it("returns deterministic test mutations with known formal outcomes", () => {
    const mutations = arithmeticEngine.testMutations(uniqueSpec);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "no-integer-solution",
      "rank-deficient-multiple-solution",
      "strict-boundary",
      "all-different",
    ]);
    expect(arithmeticEngine.testMutations(uniqueSpec)).toEqual(mutations);
    const byId = new Map(mutations.map((mutation) => [mutation.id, mutation.spec]));
    const noInteger = byId.get("no-integer-solution");
    const rankDeficient = byId.get("rank-deficient-multiple-solution");
    const strict = byId.get("strict-boundary");
    const allDifferent = byId.get("all-different");
    if (
      noInteger === undefined ||
      rankDeficient === undefined ||
      strict === undefined ||
      allDifferent === undefined
    ) {
      throw new Error("expected all arithmetic test mutations");
    }
    expect(arithmeticEngine.enumerateSolutions(noInteger).solutionCount).toBe(0);
    expect(arithmeticEngine.enumerateSolutions(rankDeficient).solutionCount).toBeGreaterThan(1);
    expect(arithmeticEngine.enumerateSolutions(strict).correctAnswer).toEqual([0, 0, 0]);
    expect(arithmeticEngine.enumerateSolutions(allDifferent).correctAnswer).toEqual([0, 1, 2]);
  });

  it("exposes domain, distinctness, operators, and facts", () => {
    const rules = arithmeticEngine.visibleRules(uniqueSpec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("0..12");
    expect(rules.closedWorld).toContain("allDifferent is false");
    expect(rules.operations).toHaveLength(5);
    expect(rules.conventions.some((line) => line.includes("parentheses"))).toBe(true);
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);

    const facts = arithmeticEngine.facts(uniqueSpec);
    expect(facts.map((fact) => fact.factId)).toEqual(["f001", "f002", "f003"]);
    expect(facts[0]?.text).toContain("(1)*x");
  });

  it("registers all five text engines and the real matrix renderer", () => {
    const families = productionRegistry.listEngineFamilies();
    expect(families).toEqual(
      expect.arrayContaining(["ranking", "matching", "scheduling", "truth", "arithmetic"]),
    );
    expect(productionRegistry.listRendererFamilies()).toContain("matrix");
    expect(productionRegistry.getEngine("arithmetic").family).toBe("arithmetic");
    expect(productionRegistry.getEngine("arithmetic").modality).toBe("text");
  });
});
