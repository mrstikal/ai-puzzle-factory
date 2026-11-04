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
import { canonicalizeMatchingSpec } from "../../src/families/matching/canonical.js";
import {
  MatchingConstructionError,
  constructMatchingSpec,
  matchingEngine,
} from "../../src/families/matching/engine.js";
import {
  MatchingSpecSchema,
  MatchingTableSchema,
  matchingSwapDistance,
  tableToAssignment,
  type MatchingCategory,
  type MatchingClue,
  type MatchingSpec,
  type MatchingTable,
} from "../../src/families/matching/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

function same(
  leftCategory: MatchingCategory,
  leftItem: number,
  rightCategory: MatchingCategory,
  rightItem: number,
): MatchingClue {
  return {
    kind: "same",
    left: { category: leftCategory, item: leftItem },
    right: { category: rightCategory, item: rightItem },
  };
}

function different(
  leftCategory: MatchingCategory,
  leftItem: number,
  rightCategory: MatchingCategory,
  rightItem: number,
): MatchingClue {
  return {
    kind: "different",
    left: { category: leftCategory, item: leftItem },
    right: { category: rightCategory, item: rightItem },
  };
}

function makeSpec(clues: readonly MatchingClue[]): MatchingSpec {
  return MatchingSpecSchema.parse({ clues });
}

function makeTable(
  rows: ReadonlyArray<readonly [number, number, number]>,
): MatchingTable {
  return MatchingTableSchema.parse(rows.map(([a, b, c]) => ({ a, b, c })));
}

const identityTable = makeTable([
  [0, 0, 0],
  [1, 1, 1],
  [2, 2, 2],
  [3, 3, 3],
]);

function anchorsForTable(table: MatchingTable): MatchingSpec {
  const clues: MatchingClue[] = [];
  for (let item = 0; item < 3; item += 1) {
    const row = table[item];
    if (row === undefined) {
      throw new Error("expected a complete matching table");
    }
    clues.push(same("A", item, "B", row.b));
    clues.push(same("A", item, "C", row.c));
  }
  return makeSpec(clues);
}

function permutationMap(permutation: readonly number[]): ReadonlyMap<number, number> {
  const mapping = new Map<number, number>();
  for (const [oldItem, newItem] of permutation.entries()) {
    mapping.set(oldItem, newItem);
  }
  return mapping;
}

function relabelSpec(
  spec: MatchingSpec,
  aPermutation: readonly number[],
  bPermutation: readonly number[],
  cPermutation: readonly number[],
): MatchingSpec {
  const mappings: Record<MatchingCategory, ReadonlyMap<number, number>> = {
    A: permutationMap(aPermutation),
    B: permutationMap(bPermutation),
    C: permutationMap(cPermutation),
  };
  const mapEndpoint = (endpoint: MatchingClue["left"]) => {
    const item = mappings[endpoint.category].get(endpoint.item);
    if (item === undefined) {
      throw new Error("expected a complete relabeling");
    }
    return { category: endpoint.category, item };
  };
  return makeSpec(
    spec.clues.map((clue) => ({
      kind: clue.kind,
      left: mapEndpoint(clue.left),
      right: mapEndpoint(clue.right),
    })),
  );
}

describe("matching DSL", () => {
  it("accepts 4-12 cross-category clues and rejects duplicates, contradictions, and same-category clues", () => {
    const valid = makeSpec([
      same("A", 0, "B", 0),
      same("A", 1, "B", 1),
      different("A", 2, "B", 2),
      same("B", 0, "C", 0),
    ]);
    expect(valid.clues).toHaveLength(4);

    expect(() =>
      MatchingSpecSchema.parse({
        clues: [same("A", 0, "B", 0), same("A", 1, "B", 1), same("A", 2, "B", 2)],
      }),
    ).toThrow();
    expect(() =>
      MatchingSpecSchema.parse({
        clues: Array.from({ length: 13 }, (_value, index) =>
          same("A", index % 4, "B", index % 4),
        ),
      }),
    ).toThrow();
    expect(() =>
      MatchingSpecSchema.parse({
        clues: [same("A", 0, "A", 1), same("A", 1, "B", 1), same("A", 2, "B", 2), same("A", 3, "B", 3)],
      }),
    ).toThrow();

    const duplicate = MatchingSpecSchema.safeParse({
      clues: [
        same("A", 0, "B", 0),
        same("B", 0, "A", 0),
        different("A", 1, "B", 1),
        same("A", 2, "B", 2),
      ],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues.some((issue) => issue.message.includes("duplicate"))).toBe(
        true,
      );
    }

    const contradictory = MatchingSpecSchema.safeParse({
      clues: [
        same("A", 0, "B", 0),
        different("A", 0, "B", 0),
        same("A", 1, "B", 1),
        same("A", 2, "B", 2),
      ],
    });
    expect(contradictory.success).toBe(false);
    if (!contradictory.success) {
      expect(
        contradictory.error.issues.some((issue) => issue.message.includes("contradictory")),
      ).toBe(true);
    }

    expect(() =>
      MatchingSpecSchema.parse({
        clues: [same("A", 0, "B", 0), same("A", 1, "B", 1), same("A", 2, "B", 2), same("A", 3, "B", 3)],
        factId: "arbitrary",
      }),
    ).toThrow();
  });

  it("rejects incomplete tables, repeated category values, and noncanonical row order", () => {
    expect(() => MatchingTableSchema.parse(identityTable)).not.toThrow();
    expect(() =>
      MatchingTableSchema.parse([
        { a: 0, b: 0, c: 0 },
        { a: 1, b: 0, c: 1 },
        { a: 2, b: 2, c: 2 },
        { a: 3, b: 3, c: 3 },
      ]),
    ).toThrow();
    expect(() =>
      MatchingTableSchema.parse([
        { a: 1, b: 1, c: 1 },
        { a: 0, b: 0, c: 0 },
        { a: 2, b: 2, c: 2 },
        { a: 3, b: 3, c: 3 },
      ]),
    ).toThrow();
    expect(() =>
      MatchingTableSchema.parse([
        { a: 0, b: 0, c: 0 },
        { a: 1, b: 1, c: 1 },
        { a: 2, b: 2, c: 2 },
      ]),
    ).toThrow();
  });

  it("exposes code-owned rules and clue facts", () => {
    const spec = anchorsForTable(identityTable);
    const rules = matchingEngine.visibleRules(spec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("A1-A4");
    expect(rules.operations).toHaveLength(2);
    expect(rules.conventions.length).toBeGreaterThan(0);
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);

    const facts = matchingEngine.facts(spec);
    expect(facts.map((fact) => fact.factId)).toEqual([
      "f001",
      "f002",
      "f003",
      "f004",
      "f005",
      "f006",
    ]);
    expect(facts[0]?.text).toContain("A1");
    expect(facts[0]?.text).toContain("B1");
  });
});

describe("matching solver", () => {
  const uniqueSpec = anchorsForTable(identityTable);

  it("enumerates the 576-table domain and requires one complete table", () => {
    const result = matchingEngine.enumerateSolutions(uniqueSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual(identityTable);
    expect(result.enumeratedStates).toBe(576);
    expect(result.checkerVersion).toBe("matching-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(matchingEngine.verifyAnswer(uniqueSpec, identityTable)).toBe(true);
    const swappedB = makeTable([
      [0, 1, 0],
      [1, 0, 1],
      [2, 2, 2],
      [3, 3, 3],
    ]);
    expect(matchingEngine.verifyAnswer(uniqueSpec, swappedB)).toBe(false);
    const repeatedB = [
      { a: 0, b: 0, c: 0 },
      { a: 1, b: 0, c: 1 },
      { a: 2, b: 2, c: 2 },
      { a: 3, b: 3, c: 3 },
    ] as unknown as MatchingTable;
    expect(matchingEngine.verifyAnswer(uniqueSpec, repeatedB)).toBe(false);
  });

  it("returns unsatisfiable and ambiguous full-table results", () => {
    const impossible = makeSpec([
      different("A", 0, "B", 0),
      different("A", 0, "B", 1),
      different("A", 0, "B", 2),
      different("A", 0, "B", 3),
    ]);
    const unsat = matchingEngine.enumerateSolutions(impossible);
    expect(unsat.solutionCount).toBe(0);
    expect(unsat.answerCount).toBe(0);
    expect(unsat.correctAnswer).toBeNull();
    expect(unsat.proof).toBeNull();
    expect(() => SolveResultSchema.parse(unsat)).not.toThrow();

    const ambiguous = makeSpec([
      same("A", 0, "B", 0),
      same("A", 1, "B", 1),
      same("A", 2, "B", 2),
      same("A", 3, "B", 3),
    ]);
    const multiple = matchingEngine.enumerateSolutions(ambiguous);
    expect(multiple.solutionCount).toBe(24);
    expect(multiple.answerCount).toBe(24);
    expect(multiple.correctAnswer).toBeNull();
    expect(multiple.proof).toBeNull();
    expect(() => matchingEngine.canonicalData(ambiguous)).toThrow();
  });

  it("uses signed cross-category B-C facts in the solver", () => {
    const spec = makeSpec([
      ...anchorsForTable(identityTable).clues,
      different("B", 0, "C", 1),
    ]);
    const result = matchingEngine.enumerateSolutions(spec);
    expect(result.solutionCount).toBe(1);
    expect(result.correctAnswer).toEqual(identityTable);
    expect(matchingEngine.verifyAnswer(spec, identityTable)).toBe(true);
    const wrong = makeTable([
      [0, 0, 1],
      [1, 1, 0],
      [2, 2, 2],
      [3, 3, 3],
    ]);
    expect(matchingEngine.verifyAnswer(spec, wrong)).toBe(false);
  });
});

describe("matching options", () => {
  const spec = makeSpec([
    ...anchorsForTable(identityTable).clues,
    different("B", 0, "C", 1),
  ]);

  it("builds four complete tables, prefers one/two swaps, and validates the key", () => {
    const result = matchingEngine.enumerateSolutions(spec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique matching table");
    }
    const set = matchingEngine.makeOptions(spec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    for (const choice of set.choices) {
      expect(() => MatchingTableSchema.parse(choice.value)).not.toThrow();
      expect(matchingEngine.verifyAnswer(spec, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
    }
    const correctAssignment = tableToAssignment(correct);
    const distances = set.choices
      .filter((choice) => choice.label !== set.correctLabel)
      .map((choice) =>
        matchingSwapDistance(correctAssignment, tableToAssignment(choice.value)),
      );
    expect(distances.every((distance) => distance === 1 || distance === 2)).toBe(true);

    expect(matchingEngine.makeOptions(spec, correct, SEED_A)).toEqual(set);
    expect(() => matchingEngine.makeOptions(spec, makeTable([
      [0, 1, 0],
      [1, 0, 1],
      [2, 2, 2],
      [3, 3, 3],
    ]), SEED_A)).toThrow();
  });

  it("rejects ambiguous specs and uses the seed to change option order", () => {
    const ambiguous = makeSpec([
      same("A", 0, "B", 0),
      same("A", 1, "B", 1),
      same("A", 2, "B", 2),
      same("A", 3, "B", 3),
    ]);
    expect(() => matchingEngine.makeOptions(ambiguous, identityTable, SEED_A)).toThrow();

    const result = matchingEngine.enumerateSolutions(spec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique matching table");
    }
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = matchingEngine.makeOptions(spec, correct, seed);
      orders.add(
        set.choices
          .map((choice) => choice.value.map((row) => `${row.a}-${row.b}-${row.c}`).join(","))
          .join("|"),
      );
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("matching canonicalization", () => {
  const base = anchorsForTable(identityTable);

  it("canonicalizes independent relabelings across all three categories", () => {
    const baseline = canonicalizeMatchingSpec(base);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["categories=3", "size=4"]);
    expect(baseline.queryTokens).toEqual([]);
    expect(baseline.geometryTokens).toEqual([]);

    const relabeled = relabelSpec(base, [2, 0, 3, 1], [1, 2, 0, 3], [3, 0, 2, 1]);
    expect(canonicalStructuresEqual(canonicalizeMatchingSpec(relabeled), baseline)).toBe(
      true,
    );
  });

  it("ignores an implied redundant fact and separates a different table", () => {
    const baseline = canonicalizeMatchingSpec(base);
    const redundant = makeSpec([...base.clues, same("A", 3, "B", 3)]);
    expect(canonicalStructuresEqual(canonicalizeMatchingSpec(redundant), baseline)).toBe(
      true,
    );

    const swapped = makeSpec([
      ...base.clues,
      different("B", 0, "C", 3),
    ]);
    const differentStructure = canonicalizeMatchingSpec(swapped);
    expect(canonicalStructuresEqual(differentStructure, baseline)).toBe(false);
  });
});

describe("matching construction", () => {
  it("is deterministic for one seed and varies across seeds", () => {
    const first = constructMatchingSpec(SEED_A, 2);
    const second = constructMatchingSpec(SEED_A, 2);
    expect(second).toEqual(first);
    const other = constructMatchingSpec(SEED_B, 2);
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
    const specs: MatchingSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `matching-fixture-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructMatchingSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof MatchingConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      const floor = difficulty === 1 ? 8 : difficulty === 2 ? 6 : 4;
      expect(spec.clues.length).toBeGreaterThanOrEqual(floor);
      expect(spec.clues.length).toBeLessThanOrEqual(12);
      expect(trace.anchorCount).toBe(6);
      expect(trace.crossCategoryAdded).toBe(2);
      expect(trace.additionalRequested).toBeGreaterThanOrEqual(4);
      expect(trace.additionalRequested).toBeLessThanOrEqual(6);
      expect(trace.additionalAdded).toBe(trace.additionalRequested);
      expect(trace.clueCountBeforePruning).toBe(6 + trace.additionalAdded);
      expect(trace.clueCountAfterPruning).toBe(spec.clues.length);
      expect(trace.prunedClues).toBe(
        trace.clueCountBeforePruning - trace.clueCountAfterPruning,
      );
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);

      const result = matchingEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      expect(result.correctAnswer).not.toBeNull();
      if (result.correctAnswer !== null) {
        expect(() => MatchingTableSchema.parse(result.correctAnswer)).not.toThrow();
        expect(matchingEngine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
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

describe("matching engine contract and registry", () => {
  it("keeps the hidden witness out of the generated spec and re-solves tampered specs", () => {
    const generated = matchingEngine.generateSpec(SEED_A, 2);
    expect(Object.keys(generated).sort()).toEqual(["clues"]);
    expect(matchingEngine.generateSpec(SEED_A, 2)).toEqual(generated);
    expect(() => MatchingSpecSchema.parse({ ...generated, witness: identityTable })).toThrow();

    const tampered = makeSpec([
      different("A", 0, "B", 0),
      different("A", 0, "B", 1),
      different("A", 0, "B", 2),
      different("A", 0, "B", 3),
    ]);
    const result = matchingEngine.enumerateSolutions(tampered);
    expect(result.solutionCount).toBe(0);
    expect(result.correctAnswer).toBeNull();
  });

  it("returns deterministic test mutations with known formal outcomes", () => {
    const mutations = matchingEngine.testMutations(anchorsForTable(identityTable));
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "impossible-a-to-b",
      "ambiguous-c-unconstrained",
      "cross-category-negative",
      "redundant-implied",
    ]);
    expect(matchingEngine.testMutations(anchorsForTable(identityTable))).toEqual(
      mutations,
    );
    const byId = new Map(mutations.map((mutation) => [mutation.id, mutation.spec]));
    const impossible = byId.get("impossible-a-to-b");
    const ambiguous = byId.get("ambiguous-c-unconstrained");
    const crossCategory = byId.get("cross-category-negative");
    const redundant = byId.get("redundant-implied");
    if (
      impossible === undefined ||
      ambiguous === undefined ||
      crossCategory === undefined ||
      redundant === undefined
    ) {
      throw new Error("expected all matching test mutations");
    }
    expect(matchingEngine.enumerateSolutions(impossible).solutionCount).toBe(0);
    expect(matchingEngine.enumerateSolutions(ambiguous).solutionCount).toBeGreaterThan(1);
    expect(matchingEngine.enumerateSolutions(crossCategory).solutionCount).toBe(1);
    expect(matchingEngine.enumerateSolutions(redundant).solutionCount).toBe(1);
  });

  it("registers ranking and matching as real text engines", () => {
    expect(productionRegistry.listEngineFamilies()).toEqual(["ranking", "matching"]);
    expect(productionRegistry.getEngine("matching").family).toBe("matching");
    expect(productionRegistry.getEngine("matching").modality).toBe("text");
  });
});
