import { describe, expect, it, vi } from "vitest";
import { deepEqual, makeChoiceSet } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import {
  CanonicalStructureSchema,
  D4_OPERATIONS,
  SolveResultSchema,
  VisibleRulesSchema,
  ruleFacts,
  type D4Operation,
} from "../../src/families/contracts.js";
import { canonicalizeCountingSpec } from "../../src/families/counting/canonical.js";
import {
  CountingConstructionError,
  constructCountingSpec,
  countingEngine,
  countQueryByMembership,
  countQueryBySets,
  inclusionExclusionUnion,
  membershipMaskGrid,
  summaryCounts,
  tryBuildCountingSpec,
} from "../../src/families/counting/engine.js";
import {
  CountingAnswerSchema,
  CountingSpecSchema,
  checkCountingAnswer,
  queryKey,
  shapeMembershipCounts,
  sortCountingCells,
  type CountingCell,
  type CountingOperation,
  type CountingShape,
  type CountingSpec,
} from "../../src/families/counting/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

function cells(...values: readonly [number, number][]): CountingCell[] {
  return sortCountingCells(values.map(([row, column]) => ({ row, column })));
}

const TWO_SHAPES: readonly CountingShape[] = [
  { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
  { cells: cells([1, 1], [1, 2], [2, 1], [2, 2]) },
];

const THREE_SHAPES: readonly CountingShape[] = [
  { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
  { cells: cells([1, 1], [1, 2], [2, 1], [2, 2]) },
  { cells: cells([1, 1], [2, 1], [2, 2], [3, 2]) },
];

function makeSpec(
  shapes: readonly CountingShape[],
  operation: CountingOperation,
  k?: 2 | 3,
): CountingSpec {
  return CountingSpecSchema.parse({
    shapes,
    query: k === undefined ? { operation } : { operation, k },
  });
}

const unionTwo = makeSpec(TWO_SHAPES, "unionCount");
const intersectionTwo = makeSpec(TWO_SHAPES, "intersectionAll");
const exactlyOneTwo = makeSpec(TWO_SHAPES, "exactlyOneShape");
const exactlyKTwo = makeSpec(TWO_SHAPES, "exactlyKShapes", 2);

const unionThree = makeSpec(THREE_SHAPES, "unionCount");
const intersectionThree = makeSpec(THREE_SHAPES, "intersectionAll");
const exactlyOneThree = makeSpec(THREE_SHAPES, "exactlyOneShape");
const exactlyK2Three = makeSpec(THREE_SHAPES, "exactlyKShapes", 2);
const exactlyK3Three = makeSpec(THREE_SHAPES, "exactlyKShapes", 3);

function answerOf(spec: CountingSpec): number {
  const result = countingEngine.enumerateSolutions(spec);
  const answer = result.correctAnswer;
  if (answer === null) {
    throw new Error("expected a counting answer");
  }
  return answer;
}

function transformCell(operation: D4Operation, cell: CountingCell): CountingCell {
  const last = 4;
  switch (operation) {
    case "identity":
      return cell;
    case "rotate90":
      return { row: cell.column, column: last - cell.row };
    case "rotate180":
      return { row: last - cell.row, column: last - cell.column };
    case "rotate270":
      return { row: last - cell.column, column: cell.row };
    case "reflectLeftRight":
      return { row: cell.row, column: last - cell.column };
    case "reflectTopBottom":
      return { row: last - cell.row, column: cell.column };
    case "reflectMainDiagonal":
      return { row: cell.column, column: cell.row };
    case "reflectAntiDiagonal":
      return { row: last - cell.column, column: last - cell.row };
    default:
      throw new Error(`unknown D4 operation ${String(operation)}`);
  }
}

function transformedSpec(
  spec: CountingSpec,
  operation: D4Operation,
  swapShapes = false,
): CountingSpec {
  const shapes = spec.shapes.map((shape) => ({
    cells: sortCountingCells(shape.cells.map((cell) => transformCell(operation, cell))),
  }));
  return CountingSpecSchema.parse({
    shapes: swapShapes ? [...shapes].reverse() : shapes,
    query: spec.query,
  });
}

describe("counting DSL", () => {
  it("accepts two and three connected shapes with overlap and exclusive cells", () => {
    expect(() => CountingSpecSchema.parse(unionTwo)).not.toThrow();
    expect(() => CountingSpecSchema.parse(unionThree)).not.toThrow();
    expect(unionTwo.shapes).toHaveLength(2);
    expect(unionThree.shapes).toHaveLength(3);
    expect(summaryCounts(unionTwo)).toEqual({
      union: 7,
      intersectionAll: 1,
      exactlyOne: 6,
      exactlyK2: 1,
    });
    expect(summaryCounts(unionThree)).toEqual({
      union: 8,
      intersectionAll: 1,
      exactlyOne: 5,
      exactlyK2: 2,
      exactlyK3: 1,
    });
  });

  it("rejects bad shape counts, sizes, disconnected/duplicate shapes, and missing overlap/exclusive cells", () => {
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [TWO_SHAPES[0]],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [
          { cells: cells([0, 0], [0, 1]) },
          TWO_SHAPES[1],
        ],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [
          {
            cells: cells(
              [0, 0],
              [0, 1],
              [0, 2],
              [0, 3],
              [0, 4],
              [1, 0],
              [2, 0],
              [3, 0],
              [4, 0],
            ),
          },
          TWO_SHAPES[1],
        ],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [
          { cells: cells([0, 0], [0, 1], [2, 2]) },
          TWO_SHAPES[1],
        ],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [TWO_SHAPES[0], TWO_SHAPES[0]],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    const disjoint = [
      { cells: cells([0, 0], [0, 1], [1, 0]) },
      { cells: cells([3, 3], [3, 4], [4, 3]) },
    ];
    expect(() =>
      CountingSpecSchema.parse({ shapes: disjoint, query: { operation: "unionCount" } }),
    ).toThrow();
    const noExclusive = [
      { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
      { cells: cells([0, 1], [1, 0], [1, 1]) },
      { cells: cells([0, 0], [1, 0], [1, 1]) },
    ];
    expect(() =>
      CountingSpecSchema.parse({
        shapes: noExclusive,
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [
          {
            cells: [
              { row: 0, column: 1 },
              { row: 0, column: 0 },
              { row: 1, column: 0 },
            ],
          },
          TWO_SHAPES[1],
        ],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: [
          { cells: cells([0, 0], [0, 0], [1, 0]) },
          TWO_SHAPES[1],
        ],
        query: { operation: "unionCount" },
      }),
    ).toThrow();
  });

  it("rejects invalid query operations, k usage, k>shapes, and malformed answers", () => {
    expect(() =>
      CountingSpecSchema.parse({
        shapes: TWO_SHAPES,
        query: { operation: "unknown" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: TWO_SHAPES,
        query: { operation: "exactlyKShapes" },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: TWO_SHAPES,
        query: { operation: "exactlyKShapes", k: 3 },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: TWO_SHAPES,
        query: { operation: "unionCount", k: 2 },
      }),
    ).toThrow();
    expect(() =>
      CountingSpecSchema.parse({
        shapes: THREE_SHAPES,
        query: { operation: "exactlyKShapes", k: 4 },
      }),
    ).toThrow();
    expect(() => CountingAnswerSchema.parse(-1)).toThrow();
    expect(() => CountingAnswerSchema.parse(26)).toThrow();
    expect(CountingAnswerSchema.parse(0)).toBe(0);
  });
});

describe("counting membership and solver", () => {
  it("computes masks, membership counts, set counts, and inclusion-exclusion independently", () => {
    const masks = membershipMaskGrid(unionTwo);
    expect(masks[1]?.[1]).toBe(3);
    expect(masks[0]?.[0]).toBe(1);
    expect(masks[2]?.[2]).toBe(2);
    const counts = shapeMembershipCounts(unionTwo);
    expect(counts[1]?.[1]).toBe(2);
    expect(counts[0]?.[0]).toBe(1);
    for (const spec of [
      unionTwo,
      intersectionTwo,
      exactlyOneTwo,
      exactlyKTwo,
      unionThree,
      intersectionThree,
      exactlyOneThree,
      exactlyK2Three,
      exactlyK3Three,
    ]) {
      expect(countQueryByMembership(spec)).toBe(countQueryBySets(spec));
    }
    expect(inclusionExclusionUnion(unionTwo)).toBe(7);
    expect(inclusionExclusionUnion(unionThree)).toBe(8);
  });

  it("returns all query answers with derived summary facts", () => {
    expect(answerOf(unionTwo)).toBe(7);
    expect(answerOf(intersectionTwo)).toBe(1);
    expect(answerOf(exactlyOneTwo)).toBe(6);
    expect(answerOf(exactlyKTwo)).toBe(1);
    expect(answerOf(unionThree)).toBe(8);
    expect(answerOf(intersectionThree)).toBe(1);
    expect(answerOf(exactlyOneThree)).toBe(5);
    expect(answerOf(exactlyK2Three)).toBe(2);
    expect(answerOf(exactlyK3Three)).toBe(1);
    const result = countingEngine.enumerateSolutions(unionThree);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.enumeratedStates).toBe(25);
    expect(result.checkerVersion).toBe("counting-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001", "s002"]);
    expect(result.proof?.facts[1]?.text).toContain("Union=8");
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
  });

  it("rejects wrong, out-of-domain, and boundary-count answers", () => {
    expect(checkCountingAnswer(unionTwo, 7)).toBe(true);
    expect(checkCountingAnswer(unionTwo, 6)).toBe(false);
    expect(checkCountingAnswer(unionTwo, 26)).toBe(false);
    expect(countingEngine.verifyAnswer(unionTwo, 6)).toBe(false);
    expect(countingEngine.verifyAnswer(unionTwo, 7)).toBe(true);
    expect(countingEngine.verifyAnswer(unionTwo, 26 as unknown as number)).toBe(
      false,
    );
    expect(
      countingEngine.verifyAnswer(
        { ...unionTwo, query: { operation: "exactlyKShapes", k: 3 } } as unknown as CountingSpec,
        1,
      ),
    ).toBe(false);
  });

  it("keeps query differences meaningful on the same geometry", () => {
    expect(answerOf(unionTwo)).not.toBe(answerOf(intersectionTwo));
    expect(answerOf(unionTwo)).not.toBe(answerOf(exactlyOneTwo));
    expect(answerOf(exactlyKTwo)).toBe(answerOf(intersectionTwo));
    expect(answerOf(exactlyK2Three)).not.toBe(answerOf(exactlyK3Three));
  });
});

describe("counting options", () => {
  it("builds four distinct numeric choices with exactly one correct value", () => {
    for (const spec of [unionTwo, intersectionTwo, exactlyOneTwo, exactlyKTwo, unionThree, intersectionThree, exactlyK2Three, exactlyK3Three]) {
      const correct = answerOf(spec);
      const set = countingEngine.makeOptions(spec, correct, SEED_A);
      expect(set.choices).toHaveLength(4);
      expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
      const values = set.choices.map((choice) => choice.value);
      expect(new Set(values).size).toBe(4);
      expect(values.filter((value) => value === correct)).toHaveLength(1);
      for (const value of values) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(25);
      }
      expect(countingEngine.makeOptions(spec, correct, SEED_A)).toEqual(set);
    }
    expect(() =>
      countingEngine.makeOptions(unionTwo, answerOf(unionTwo), SEED_B),
    ).not.toThrow();
    expect(() =>
      countingEngine.makeOptions(unionTwo, answerOf(unionTwo) + 1, SEED_A),
    ).toThrow();
  });

  it("rejects duplicate rendered numbers and supports a correct zero answer", () => {
    const noTriple = [
      { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
      { cells: cells([1, 1], [1, 2], [2, 1], [2, 2]) },
      { cells: cells([2, 2], [2, 3], [3, 2], [3, 3]) },
    ];
    const spec = CountingSpecSchema.parse({
      shapes: noTriple,
      query: { operation: "intersectionAll" },
    });
    expect(answerOf(spec)).toBe(0);
    const set = countingEngine.makeOptions(spec, 0, SEED_A);
    expect(set.choices.map((choice) => choice.value).filter((value) => value === 0)).toHaveLength(1);
    expect(new Set(set.choices.map((choice) => choice.value)).size).toBe(4);
    expect(() =>
      makeChoiceSet({
        correct: 0,
        distractors: [0, 0, 0],
        seed: SEED_A,
      }),
    ).toThrow();
  });
});

describe("counting canonicalization", () => {
  it("normalizes D4 and shape-ID permutations and emits full membership grids", () => {
    const baseline = canonicalizeCountingSpec(unionTwo);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["grid=5x5", "shapes=2"]);
    expect(baseline.queryKind).toBe("membership_count");
    expect(baseline.queryTokens).toEqual(["operation=unionCount"]);
    expect(baseline.geometryTokens).toHaveLength(25);
    expect(baseline.relationTokens).toHaveLength(3);
    for (const operation of D4_OPERATIONS) {
      expect(canonicalizeCountingSpec(transformedSpec(unionTwo, operation))).toEqual(
        baseline,
      );
      expect(
        canonicalizeCountingSpec(transformedSpec(unionTwo, operation, true)),
      ).toEqual(baseline);
    }
    expect(canonicalizeCountingSpec(unionThree).geometryTokens).toHaveLength(25);
    expect(canonicalizeCountingSpec(unionThree).relationTokens).toHaveLength(7);
  });

  it("keeps query differences and geometry-vs-count layouts distinct", () => {
    const unionCanonical = canonicalizeCountingSpec(unionTwo);
    const intersectionCanonical = canonicalizeCountingSpec(intersectionTwo);
    expect(intersectionCanonical.queryTokens).toEqual(["operation=intersectionAll"]);
    expect(intersectionCanonical).not.toEqual(unionCanonical);
    const sameCountsDifferentLayout = CountingSpecSchema.parse({
      shapes: [
        { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
        { cells: cells([0, 1], [0, 2], [1, 2], [2, 2]) },
      ],
      query: { operation: "unionCount" },
    });
    expect(summaryCounts(sameCountsDifferentLayout)).toEqual(summaryCounts(unionTwo));
    expect(canonicalizeCountingSpec(sameCountsDifferentLayout)).not.toEqual(
      unionCanonical,
    );
  });
});

describe("counting construction", () => {
  it("skips invalid attempts instead of leaking a ZodError", () => {
    const noExclusive: readonly CountingShape[] = [
      { cells: cells([1, 2], [1, 3], [2, 2], [2, 3]) },
      { cells: cells([1, 2], [2, 2], [2, 3], [3, 2]) },
      { cells: cells([1, 3], [2, 2], [2, 3], [3, 2]) },
    ];
    expect(
      tryBuildCountingSpec(noExclusive, { operation: "intersectionAll" }),
    ).toBeUndefined();
    expect(
      tryBuildCountingSpec(TWO_SHAPES, { operation: "unionCount" }),
    ).toBeDefined();
  });

  it("retries after an invalid attempt at the construction call site", () => {
    const failure = CountingSpecSchema.safeParse({});
    const spy = vi
      .spyOn(CountingSpecSchema, "safeParse")
      .mockImplementationOnce(() => failure as never);
    try {
      const result = constructCountingSpec(SEED_A, 1);
      expect(result.spec.shapes).toHaveLength(2);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("is deterministic and respects level shape/query rules", () => {
    const first = constructCountingSpec(SEED_A, 3);
    expect(constructCountingSpec(SEED_A, 3)).toEqual(first);
    expect(deepEqual(constructCountingSpec(SEED_B, 3).spec, first.spec)).toBe(false);
    for (const difficulty of [1, 2, 3] as const) {
      const { spec, trace } = constructCountingSpec(SEED_A, difficulty);
      expect(trace.difficulty).toBe(difficulty);
      expect(trace.shapeCount).toBe(difficulty === 3 ? 3 : 2);
      expect(spec.shapes).toHaveLength(trace.shapeCount);
      expect(trace.shapeSizes.every((size) => size >= 3 && size <= 8)).toBe(true);
      expect(trace.overlapCount).toBeGreaterThanOrEqual(1);
      expect(trace.exclusiveCount).toBeGreaterThanOrEqual(1);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      if (difficulty === 1) {
        expect(trace.query.operation).toBe("unionCount");
        expect(trace.shapeSizes.every((size) => size >= 3 && size <= 5)).toBe(true);
      } else if (difficulty === 2) {
        expect(["intersectionAll", "exactlyOneShape"]).toContain(
          trace.query.operation,
        );
        expect(trace.shapeSizes.every((size) => size >= 6 && size <= 8)).toBe(true);
      } else {
        expect(["intersectionAll", "exactlyKShapes"]).toContain(
          trace.query.operation,
        );
        expect(trace.shapeSizes.every((size) => size >= 4 && size <= 8)).toBe(true);
      }
      expect(trace.answer).toBe(answerOf(spec));
      expect(inclusionExclusionUnion(spec)).toBe(summaryCounts(spec).union);
    }
  });

  it("constructs at least 95 of 100 fixed seeds with independently verified options", () => {
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
    const specs: CountingSpec[] = [];
    for (const [index, difficulty] of difficulties.entries()) {
      const slotId = `counting-fixture-${String(index + 1).padStart(3, "0")}`;
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructCountingSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof CountingConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      expect(trace.shapeCount).toBe(difficulty === 3 ? 3 : 2);
      expect(trace.overlapCount).toBeGreaterThanOrEqual(1);
      expect(trace.exclusiveCount).toBeGreaterThanOrEqual(1);
      const answer = answerOf(spec);
      expect(trace.answer).toBe(answer);
      expect(countingEngine.verifyAnswer(spec, answer)).toBe(true);
      const optionsSeed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "options",
      });
      const set = countingEngine.makeOptions(spec, answer, optionsSeed);
      expect(set.choices).toHaveLength(4);
      expect(
        set.choices.filter((choice) => countingEngine.verifyAnswer(spec, choice.value)),
      ).toHaveLength(1);
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

describe("counting engine contract and registry", () => {
  it("keeps the answer out of the generated spec", () => {
    const generated = countingEngine.generateSpec(SEED_A, 3);
    expect(Object.keys(generated).sort()).toEqual(["query", "shapes"]);
    expect(countingEngine.generateSpec(SEED_A, 3)).toEqual(generated);
    expect(() =>
      CountingSpecSchema.parse({ ...generated, answer: answerOf(generated) }),
    ).toThrow();
  });

  it("returns deterministic valid query mutations", () => {
    const mutations = countingEngine.testMutations(unionTwo);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "alternate-query",
      "alternate-query-mode",
    ]);
    expect(countingEngine.testMutations(unionTwo)).toEqual(mutations);
    const first = mutations[0]?.spec;
    const second = mutations[1]?.spec;
    if (first === undefined || second === undefined) {
      throw new Error("expected counting mutations");
    }
    expect(() => CountingSpecSchema.parse(first)).not.toThrow();
    expect(() => CountingSpecSchema.parse(second)).not.toThrow();
    expect(queryKey(first.query)).not.toBe(queryKey(unionTwo.query));
    expect(queryKey(second.query)).not.toBe(queryKey(unionTwo.query));
    expect(queryKey(first.query)).not.toBe(queryKey(second.query));
  });

  it("exposes explicit rules, observation facts, and registry registration", () => {
    const rules = countingEngine.visibleRules(unionTwo);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("two or three");
    expect(rules.closedWorld).toContain("whole cells");
    expect(rules.target).toContain("at least one shape");
    expect(rules.operations.join(" ")).toContain("unionCount");
    expect(rules.operations.join(" ")).toContain("exactlyKShapes");
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);
    const facts = countingEngine.facts(unionTwo);
    expect(facts.map((fact) => fact.factId)).toEqual([
      "p001",
      "p002",
      "p003",
      "p004",
      "p005",
      "p006",
      "p007",
      "p008",
    ]);
    expect(facts[0]?.text).toContain("Shape A");
    expect(facts[4]?.text).toContain("Shape B");
    expect(productionRegistry.listEngineFamilies()).toContain("counting");
    expect(productionRegistry.getEngine("counting").modality).toBe("svg");
    expect(productionRegistry.hasRenderer("counting")).toBe(true);
    expect(productionRegistry.listRendererFamilies()).toContain("counting");
  });
});
