import { describe, expect, it } from "vitest";
import { deepEqual } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import {
  canonicalStructuresEqual,
} from "../../src/families/canonicalize.js";
import {
  CanonicalStructureSchema,
  SolveResultSchema,
  VisibleRulesSchema,
  ruleFacts,
} from "../../src/families/contracts.js";
import { productionRegistry } from "../../src/families/registry.js";
import { canonicalizeRankingSpec } from "../../src/families/ranking/canonical.js";
import {
  RankingConstructionError,
  constructRankingSpec,
  rankingEngine,
} from "../../src/families/ranking/engine.js";
import {
  RankingSpecSchema,
  answerToItemOrder,
  clueKey,
  clueSatisfied,
  labelsForSize,
  positionsOf,
  rankingViolationCount,
  type RankingClue,
  type RankingSpec,
} from "../../src/families/ranking/schema.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

const before = (first: number, second: number): RankingClue => ({
  kind: "before",
  before: first,
  after: second,
});

const immediatelyBefore = (first: number, second: number): RankingClue => ({
  kind: "immediatelyBefore",
  before: first,
  after: second,
});

const at = (item: number, position: number): RankingClue => ({
  kind: "at",
  item,
  position,
});

const notAt = (item: number, position: number): RankingClue => ({
  kind: "notAt",
  item,
  position,
});

function makeSpec(size: 4 | 5, clues: readonly RankingClue[]): RankingSpec {
  return RankingSpecSchema.parse({ size, clues });
}

describe("ranking DSL", () => {
  it("accepts size 4 and 5 and rejects invalid sizes, ranges, self-relations, and clue counts", () => {
    expect(() =>
      makeSpec(4, [before(0, 1), at(2, 3), notAt(3, 1)]),
    ).not.toThrow();
    expect(() =>
      makeSpec(5, [immediatelyBefore(0, 1), at(2, 3), notAt(4, 5)]),
    ).not.toThrow();

    expect(() =>
      RankingSpecSchema.parse({ size: 3, clues: [before(0, 1), before(1, 2), at(2, 3)] }),
    ).toThrow();
    expect(() =>
      RankingSpecSchema.parse({ size: 6, clues: [before(0, 1), before(1, 2), at(2, 3)] }),
    ).toThrow();
    expect(() => RankingSpecSchema.parse({ size: 4, clues: [before(0, 1), before(1, 2)] })).toThrow();
    expect(() =>
      RankingSpecSchema.parse({
        size: 4,
        clues: Array.from({ length: 13 }, (_value, index) => at(index % 4, (index % 4) + 1)),
      }),
    ).toThrow();
    expect(() => RankingSpecSchema.parse({ size: 4, clues: [before(0, 4), before(1, 2), at(2, 3)] })).toThrow();
    expect(() => RankingSpecSchema.parse({ size: 4, clues: [at(0, 0), before(1, 2), at(2, 3)] })).toThrow();
    expect(() => RankingSpecSchema.parse({ size: 4, clues: [at(0, 5), before(1, 2), at(2, 3)] })).toThrow();
    expect(() => RankingSpecSchema.parse({ size: 4, clues: [before(1, 1), before(1, 2), at(2, 3)] })).toThrow();
    expect(() =>
      RankingSpecSchema.parse({
        size: 4,
        clues: [before(0, 1), before(1, 2), at(2, 3)],
        factId: "arbitrary",
      }),
    ).toThrow();
  });

  it("derives local fact IDs from clue order and exposes code-owned English rules", () => {
    const spec = makeSpec(4, [before(0, 1), at(2, 3), notAt(3, 1)]);
    const facts = rankingEngine.facts(spec);
    expect(facts.map((fact) => fact.factId)).toEqual(["f001", "f002", "f003"]);
    expect(facts.every((fact) => fact.kind === "local")).toBe(true);
    expect(facts[0]?.text).toContain("A");
    expect(facts[1]?.text).toContain("position 3");
    expect(facts[2]?.text).toContain("not at position 1");

    const rules = rankingEngine.visibleRules(spec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("A, B, C, D");
    expect(rules.operations).toHaveLength(4);
    expect(rules.conventions.length).toBeGreaterThan(0);
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);

    const five = rankingEngine.visibleRules(
      makeSpec(5, [
        immediatelyBefore(0, 1),
        immediatelyBefore(1, 2),
        immediatelyBefore(2, 3),
      ]),
    );
    expect(five.domain).toContain("A, B, C, D, E");
    expect(labelsForSize(5)).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("ranking solver", () => {
  const chain = makeSpec(4, [
    immediatelyBefore(0, 1),
    immediatelyBefore(1, 2),
    immediatelyBefore(2, 3),
  ]);

  it("solves an explicit unique order with one full answer and a derived proof", () => {
    const result = rankingEngine.enumerateSolutions(chain);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual(["A", "B", "C", "D"]);
    expect(result.enumeratedStates).toBe(24);
    expect(result.checkerVersion).toBe("ranking-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(rankingEngine.verifyAnswer(chain, ["A", "B", "C", "D"])).toBe(true);
    expect(rankingEngine.verifyAnswer(chain, ["A", "B", "D", "C"])).toBe(false);
    expect(rankingEngine.verifyAnswer(chain, ["A", "B", "C", "C"])).toBe(false);
    expect(rankingEngine.verifyAnswer(chain, ["A", "B", "C", "E"])).toBe(false);
  });

  it("returns an unsatisfiable result for an impossible cycle", () => {
    const cycle = makeSpec(4, [before(0, 1), before(1, 2), before(2, 0)]);
    const result = rankingEngine.enumerateSolutions(cycle);
    expect(result.solutionCount).toBe(0);
    expect(result.answerCount).toBe(0);
    expect(result.correctAnswer).toBeNull();
    expect(result.proof).toBeNull();
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(rankingEngine.verifyAnswer(cycle, ["A", "B", "C", "D"])).toBe(false);
  });

  it("reports ambiguity when an essential clue is missing", () => {
    const ambiguous = makeSpec(4, [before(0, 1), before(1, 2), notAt(3, 1)]);
    const result = rankingEngine.enumerateSolutions(ambiguous);
    expect(result.solutionCount).toBeGreaterThan(1);
    expect(result.answerCount).toBeGreaterThan(1);
    expect(result.correctAnswer).toBeNull();
    expect(result.proof).toBeNull();
    expect(() => rankingEngine.canonicalData(ambiguous)).toThrow();
  });

  it("treats immediatelyBefore as the next position and positions as 1-based", () => {
    const order = [0, 1, 2, 3] as const;
    const positions = positionsOf(order);
    expect(clueSatisfied(immediatelyBefore(0, 1), positions)).toBe(true);
    expect(clueSatisfied(immediatelyBefore(1, 0), positions)).toBe(false);
    expect(clueSatisfied(at(0, 1), positions)).toBe(true);
    expect(clueSatisfied(at(0, 2), positions)).toBe(false);
    expect(clueSatisfied(notAt(0, 2), positions)).toBe(true);
    expect(clueSatisfied(notAt(0, 1), positions)).toBe(false);

    const anchors = makeSpec(4, [at(0, 1), at(1, 2), at(2, 3), at(3, 4)]);
    expect(rankingEngine.enumerateSolutions(anchors).correctAnswer).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(rankingEngine.verifyAnswer(anchors, ["B", "A", "C", "D"])).toBe(false);
  });

  it("enumerates the full 120-permutation domain for size 5", () => {
    const five = makeSpec(5, [
      immediatelyBefore(0, 1),
      immediatelyBefore(1, 2),
      immediatelyBefore(2, 3),
      immediatelyBefore(3, 4),
    ]);
    const result = rankingEngine.enumerateSolutions(five);
    expect(result.solutionCount).toBe(1);
    expect(result.enumeratedStates).toBe(120);
    expect(result.correctAnswer).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("ranking options", () => {
  const chain = makeSpec(4, [
    immediatelyBefore(0, 1),
    immediatelyBefore(1, 2),
    immediatelyBefore(2, 3),
  ]);

  it("builds four full-order choices, favors one/two-clue violations, and validates the key", () => {
    const result = rankingEngine.enumerateSolutions(chain);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique ranking answer");
    }
    const set = rankingEngine.makeOptions(chain, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    for (const choice of set.choices) {
      expect(rankingEngine.verifyAnswer(chain, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
      expect(choice.value).toHaveLength(4);
    }
    const distractorViolations = set.choices
      .filter((choice) => choice.label !== set.correctLabel)
      .map((choice) => {
        const order = answerToItemOrder(choice.value, 4);
        if (order === null) {
          throw new Error("expected a full ranking order");
        }
        return rankingViolationCount(chain.clues, order);
      });
    expect(distractorViolations.every((count) => count === 1 || count === 2)).toBe(true);

    const repeated = rankingEngine.makeOptions(chain, correct, SEED_A);
    expect(repeated).toEqual(set);
    expect(() =>
      rankingEngine.makeOptions(chain, ["A", "B", "D", "C"], SEED_A),
    ).toThrow();
    const ambiguous = makeSpec(4, [before(0, 1), before(1, 2), notAt(3, 1)]);
    expect(() =>
      rankingEngine.makeOptions(ambiguous, ["A", "B", "C", "D"], SEED_A),
    ).toThrow();
  });

  it("uses the seed to change the stored option order", () => {
    const result = rankingEngine.enumerateSolutions(chain);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique ranking answer");
    }
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = rankingEngine.makeOptions(chain, correct, seed);
      orders.add(set.choices.map((choice) => choice.value.join("")).join("|"));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("ranking canonicalization", () => {
  const chain = makeSpec(4, [
    immediatelyBefore(0, 1),
    immediatelyBefore(1, 2),
    immediatelyBefore(2, 3),
  ]);

  it("canonicalizes item relabelings and ignores duplicate/redundant clues", () => {
    const baseline = canonicalizeRankingSpec(chain);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["size=4"]);
    expect(baseline.queryTokens).toEqual([]);
    expect(baseline.geometryTokens).toEqual([]);
    expect(baseline.relationTokens).toEqual(chain.clues.map(clueKey).sort());

    const relabeled = makeSpec(4, [
      immediatelyBefore(2, 0),
      immediatelyBefore(0, 3),
      immediatelyBefore(3, 1),
    ]);
    expect(canonicalStructuresEqual(canonicalizeRankingSpec(relabeled), baseline)).toBe(true);

    const duplicated = makeSpec(4, [...chain.clues, chain.clues[0] as RankingClue]);
    expect(canonicalStructuresEqual(canonicalizeRankingSpec(duplicated), baseline)).toBe(true);

    const anchored = makeSpec(4, [at(0, 1), at(1, 2), at(2, 3), at(3, 4)]);
    expect(canonicalStructuresEqual(canonicalizeRankingSpec(anchored), baseline)).toBe(false);
  });
});

describe("ranking construction", () => {
  it("is deterministic for one seed and varies across seeds", () => {
    const first = constructRankingSpec(SEED_A, 2);
    const second = constructRankingSpec(SEED_A, 2);
    expect(second).toEqual(first);
    const other = constructRankingSpec(SEED_B, 2);
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
    const failures: Array<{ readonly seed: string; readonly difficulty: Difficulty; readonly code: string }> = [];
    const specs: RankingSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `ranking-fixture-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructRankingSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof RankingConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      expect(spec.size).toBe(difficulty === 1 ? 4 : 5);
      expect(spec.clues.length).toBeGreaterThanOrEqual(3);
      expect(spec.clues.length).toBeLessThanOrEqual(12);
      expect(trace.nonAnchorAdded).toBe(trace.nonAnchorRequested);
      expect(trace.nonAnchorAdded).toBeGreaterThanOrEqual(3);
      expect(trace.nonAnchorAdded).toBeLessThanOrEqual(7);
      expect(trace.anchorsAdded).toBeLessThanOrEqual(5);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      expect(trace.clueCountBeforePruning).toBeGreaterThanOrEqual(spec.clues.length);
      expect(trace.clueCountAfterPruning).toBe(spec.clues.length);
      expect(trace.prunedClues).toBeGreaterThanOrEqual(0);

      const result = rankingEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      expect(result.correctAnswer).not.toBeNull();
      if (result.correctAnswer !== null) {
        expect(rankingEngine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
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

describe("ranking engine contract and registry", () => {
  it("keeps the hidden witness out of the generated spec and re-solves a tampered spec", () => {
    const generated = rankingEngine.generateSpec(SEED_A, 2);
    expect(Object.keys(generated).sort()).toEqual(["clues", "size"]);
    expect(rankingEngine.generateSpec(SEED_A, 2)).toEqual(generated);

    const tampered = RankingSpecSchema.parse({
      size: 5,
      clues: [before(0, 1), before(1, 0), before(2, 3)],
    });
    const result = rankingEngine.enumerateSolutions(tampered);
    expect(result.solutionCount).toBe(0);
    expect(result.correctAnswer).toBeNull();
  });

  it("returns deterministic test mutations with known formal outcomes", () => {
    const chain = makeSpec(4, [
      immediatelyBefore(0, 1),
      immediatelyBefore(1, 2),
      immediatelyBefore(2, 3),
    ]);
    const mutations = rankingEngine.testMutations(chain);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "impossible-cycle",
      "missing-essential-clue-ambiguity",
      "adjacency-direction",
      "positions",
    ]);
    expect(rankingEngine.testMutations(chain)).toEqual(mutations);

    const byId = new Map(mutations.map((mutation) => [mutation.id, mutation.spec]));
    const cycle = byId.get("impossible-cycle");
    const ambiguous = byId.get("missing-essential-clue-ambiguity");
    const adjacency = byId.get("adjacency-direction");
    const positions = byId.get("positions");
    if (
      cycle === undefined ||
      ambiguous === undefined ||
      adjacency === undefined ||
      positions === undefined
    ) {
      throw new Error("expected all ranking test mutations");
    }
    expect(rankingEngine.enumerateSolutions(cycle).solutionCount).toBe(0);
    expect(rankingEngine.enumerateSolutions(ambiguous).solutionCount).toBeGreaterThan(1);
    expect(rankingEngine.enumerateSolutions(adjacency).correctAnswer).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(rankingEngine.enumerateSolutions(positions).correctAnswer).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("registers exactly the real ranking engine in the production registry", () => {
    expect(productionRegistry.listEngineFamilies()).toContain("ranking");
    expect(productionRegistry.getEngine("ranking").family).toBe("ranking");
    expect(productionRegistry.getEngine("ranking").modality).toBe("text");
  });
});
