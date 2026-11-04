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
import { canonicalizeSchedulingSpec } from "../../src/families/scheduling/canonical.js";
import {
  SchedulingConstructionError,
  constructSchedulingSpec,
  schedulingEngine,
} from "../../src/families/scheduling/engine.js";
import {
  ScheduleTableSchema,
  SchedulingSpecSchema,
  clueSatisfied,
  tableToAssignment,
  type ScheduleTable,
  type SchedulingClue,
  type SchedulingSpec,
} from "../../src/families/scheduling/schema.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

function at(event: number, slot: number): SchedulingClue {
  return { kind: "at", event, slot };
}

function notAt(event: number, slot: number): SchedulingClue {
  return { kind: "notAt", event, slot };
}

function before(first: number, second: number): SchedulingClue {
  return { kind: "before", before: first, after: second };
}

function immediatelyBefore(first: number, second: number): SchedulingClue {
  return { kind: "immediatelyBefore", before: first, after: second };
}

function usesResource(event: number, resource: number): SchedulingClue {
  return { kind: "usesResource", event, resource };
}

function notResource(event: number, resource: number): SchedulingClue {
  return { kind: "notResource", event, resource };
}

function makeSpec(clues: readonly SchedulingClue[]): SchedulingSpec {
  return SchedulingSpecSchema.parse({ clues });
}

function makeTable(
  rows: ReadonlyArray<readonly [number, number, number]>,
): ScheduleTable {
  return ScheduleTableSchema.parse(rows.map(([event, slot, resource]) => ({
    event,
    slot,
    resource,
  })));
}

const uniqueTable = makeTable([
  [0, 1, 0],
  [1, 2, 0],
  [2, 3, 1],
  [3, 4, 1],
]);

const uniqueSpec = makeSpec([
  before(0, 1),
  before(1, 2),
  before(2, 3),
  usesResource(0, 0),
  usesResource(1, 0),
  usesResource(2, 1),
]);

function permutationMap(permutation: readonly number[]): ReadonlyMap<number, number> {
  const mapping = new Map<number, number>();
  for (const [oldItem, newItem] of permutation.entries()) {
    mapping.set(oldItem, newItem);
  }
  return mapping;
}

function relabelSpec(
  spec: SchedulingSpec,
  eventPermutation: readonly number[],
  resourcePermutation: readonly number[],
): SchedulingSpec {
  const events = permutationMap(eventPermutation);
  const resources = permutationMap(resourcePermutation);
  const mapEvent = (event: number): number => {
    const mapped = events.get(event);
    if (mapped === undefined) {
      throw new Error("expected a complete event relabeling");
    }
    return mapped;
  };
  const mapResource = (resource: number): number => {
    const mapped = resources.get(resource);
    if (mapped === undefined) {
      throw new Error("expected a complete resource relabeling");
    }
    return mapped;
  };
  return makeSpec(
    spec.clues.map((clue) => {
      switch (clue.kind) {
        case "at":
          return { kind: "at", event: mapEvent(clue.event), slot: clue.slot };
        case "notAt":
          return { kind: "notAt", event: mapEvent(clue.event), slot: clue.slot };
        case "before":
          return {
            kind: "before",
            before: mapEvent(clue.before),
            after: mapEvent(clue.after),
          };
        case "immediatelyBefore":
          return {
            kind: "immediatelyBefore",
            before: mapEvent(clue.before),
            after: mapEvent(clue.after),
          };
        case "usesResource":
          return {
            kind: "usesResource",
            event: mapEvent(clue.event),
            resource: mapResource(clue.resource),
          };
        case "notResource":
          return {
            kind: "notResource",
            event: mapEvent(clue.event),
            resource: mapResource(clue.resource),
          };
      }
    }),
  );
}

describe("scheduling DSL", () => {
  it("accepts 4-12 typed clues and rejects invalid ranges, self-relations, and duplicates", () => {
    expect(() => makeSpec([
      at(0, 1),
      notAt(1, 1),
      before(0, 1),
      usesResource(2, 0),
    ])).not.toThrow();

    expect(() =>
      SchedulingSpecSchema.parse({
        clues: [at(0, 1), before(1, 2), usesResource(2, 0)],
      }),
    ).toThrow();
    expect(() =>
      SchedulingSpecSchema.parse({
        clues: Array.from({ length: 13 }, (_value, index) =>
          at(index % 4, (index % 4) + 1),
        ),
      }),
    ).toThrow();
    expect(() =>
      SchedulingSpecSchema.parse({
        clues: [at(4, 1), before(1, 2), usesResource(2, 0), notAt(3, 2)],
      }),
    ).toThrow();
    expect(() =>
      SchedulingSpecSchema.parse({
        clues: [at(0, 5), before(1, 2), usesResource(2, 0), notAt(3, 2)],
      }),
    ).toThrow();
    expect(() =>
      SchedulingSpecSchema.parse({
        clues: [before(1, 1), before(1, 2), usesResource(2, 0), notAt(3, 2)],
      }),
    ).toThrow();

    const duplicate = SchedulingSpecSchema.safeParse({
      clues: [at(0, 1), at(0, 1), before(1, 2), usesResource(2, 0)],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues.some((issue) => issue.message.includes("duplicate"))).toBe(
        true,
      );
    }

    const contradictory = SchedulingSpecSchema.safeParse({
      clues: [at(0, 1), notAt(0, 1), before(1, 2), usesResource(2, 0)],
    });
    expect(contradictory.success).toBe(false);
    if (!contradictory.success) {
      expect(
        contradictory.error.issues.some((issue) => issue.message.includes("contradictory")),
      ).toBe(true);
    }

    expect(() =>
      SchedulingSpecSchema.parse({
        clues: [at(0, 1), before(1, 2), usesResource(2, 0), notAt(3, 2)],
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects invalid schedule tables while accepting exact capacity-two tables", () => {
    expect(() => ScheduleTableSchema.parse(uniqueTable)).not.toThrow();
    expect(() =>
      ScheduleTableSchema.parse([
        { event: 0, slot: 1, resource: 0 },
        { event: 1, slot: 1, resource: 0 },
        { event: 2, slot: 3, resource: 1 },
        { event: 3, slot: 4, resource: 1 },
      ]),
    ).toThrow();
    expect(() =>
      ScheduleTableSchema.parse([
        { event: 0, slot: 1, resource: 0 },
        { event: 1, slot: 2, resource: 0 },
        { event: 2, slot: 3, resource: 0 },
        { event: 3, slot: 4, resource: 1 },
      ]),
    ).toThrow();
    expect(() =>
      ScheduleTableSchema.parse([
        { event: 1, slot: 2, resource: 0 },
        { event: 0, slot: 1, resource: 0 },
        { event: 2, slot: 3, resource: 1 },
        { event: 3, slot: 4, resource: 1 },
      ]),
    ).toThrow();
  });

  it("exposes capacity and the six operation names in code-owned rules", () => {
    const rules = schedulingEngine.visibleRules(uniqueSpec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("capacity");
    expect(rules.domain).toContain("R1");
    expect(rules.operations).toHaveLength(6);
    expect(rules.conventions.some((line) => line.includes("capacity"))).toBe(true);
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);

    const facts = schedulingEngine.facts(uniqueSpec);
    expect(facts.map((fact) => fact.factId)).toEqual([
      "f001",
      "f002",
      "f003",
      "f004",
      "f005",
      "f006",
    ]);
    expect(facts[0]?.text).toContain("E1");
    expect(facts[3]?.text).toContain("R1");
  });
});

describe("scheduling solver", () => {
  it("enumerates the 144-schedule domain and requires one full schedule", () => {
    const result = schedulingEngine.enumerateSolutions(uniqueSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual(uniqueTable);
    expect(result.enumeratedStates).toBe(144);
    expect(result.checkerVersion).toBe("scheduling-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(schedulingEngine.verifyAnswer(uniqueSpec, uniqueTable)).toBe(true);
    const wrongResource = makeTable([
      [0, 1, 1],
      [1, 2, 1],
      [2, 3, 0],
      [3, 4, 0],
    ]);
    expect(schedulingEngine.verifyAnswer(uniqueSpec, wrongResource)).toBe(false);
  });

  it("detects resource-only ambiguity and temporal contradiction", () => {
    const resourceAmbiguous = makeSpec([
      before(0, 1),
      before(1, 2),
      before(2, 3),
      usesResource(0, 0),
    ]);
    const ambiguous = schedulingEngine.enumerateSolutions(resourceAmbiguous);
    expect(ambiguous.solutionCount).toBe(3);
    expect(ambiguous.answerCount).toBe(3);
    expect(ambiguous.correctAnswer).toBeNull();
    expect(ambiguous.proof).toBeNull();
    expect(() => SolveResultSchema.parse(ambiguous)).not.toThrow();

    const contradiction = makeSpec([
      before(0, 1),
      before(1, 2),
      before(2, 0),
      usesResource(0, 0),
    ]);
    const unsat = schedulingEngine.enumerateSolutions(contradiction);
    expect(unsat.solutionCount).toBe(0);
    expect(unsat.answerCount).toBe(0);
    expect(unsat.correctAnswer).toBeNull();
    expect(unsat.proof).toBeNull();
  });

  it("detects a second complete schedule when a necessary resource fact is removed", () => {
    const withoutResourceAnchor = makeSpec(
      uniqueSpec.clues.filter((_clue, index) => index !== 3),
    );
    const result = schedulingEngine.enumerateSolutions(withoutResourceAnchor);
    expect(result.solutionCount).toBe(2);
    expect(result.answerCount).toBe(2);
    expect(result.correctAnswer).toBeNull();
    expect(result.proof).toBeNull();
  });

  it("checks immediatelyBefore, positions, and resource predicates independently", () => {
    const assignment = tableToAssignment(uniqueTable);
    expect(clueSatisfied(immediatelyBefore(0, 1), assignment)).toBe(true);
    expect(clueSatisfied(immediatelyBefore(1, 0), assignment)).toBe(false);
    expect(clueSatisfied(at(0, 1), assignment)).toBe(true);
    expect(clueSatisfied(at(0, 2), assignment)).toBe(false);
    expect(clueSatisfied(notAt(0, 2), assignment)).toBe(true);
    expect(clueSatisfied(usesResource(0, 0), assignment)).toBe(true);
    expect(clueSatisfied(notResource(0, 0), assignment)).toBe(false);

    const immediateSpec = makeSpec([
      immediatelyBefore(0, 1),
      immediatelyBefore(1, 2),
      immediatelyBefore(2, 3),
      usesResource(0, 0),
      usesResource(1, 0),
      usesResource(2, 1),
    ]);
    const result = schedulingEngine.enumerateSolutions(immediateSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.correctAnswer).toEqual(uniqueTable);
  });
});

describe("scheduling options", () => {
  it("builds four legal schedules, keeps capacity, and validates the key", () => {
    const result = schedulingEngine.enumerateSolutions(uniqueSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique scheduling answer");
    }
    const set = schedulingEngine.makeOptions(uniqueSpec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    for (const choice of set.choices) {
      expect(() => ScheduleTableSchema.parse(choice.value)).not.toThrow();
      expect(schedulingEngine.verifyAnswer(uniqueSpec, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
    }
    expect(schedulingEngine.makeOptions(uniqueSpec, correct, SEED_A)).toEqual(set);
    expect(() =>
      schedulingEngine.makeOptions(uniqueSpec, makeTable([
        [0, 1, 1],
        [1, 2, 1],
        [2, 3, 0],
        [3, 4, 0],
      ]), SEED_A),
    ).toThrow();
  });

  it("rejects ambiguous specs and uses the seed to change option order", () => {
    const ambiguous = makeSpec([
      before(0, 1),
      before(1, 2),
      before(2, 3),
      usesResource(0, 0),
    ]);
    expect(() => schedulingEngine.makeOptions(ambiguous, uniqueTable, SEED_A)).toThrow();

    const result = schedulingEngine.enumerateSolutions(uniqueSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique scheduling answer");
    }
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = schedulingEngine.makeOptions(uniqueSpec, correct, seed);
      orders.add(
        set.choices
          .map((choice) =>
            choice.value.map((row) => `${row.event}-${row.slot}-${row.resource}`).join(","),
          )
          .join("|"),
      );
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("scheduling canonicalization", () => {
  it("canonicalizes independent event and resource relabelings", () => {
    const baseline = canonicalizeSchedulingSpec(uniqueSpec);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["capacities=2,2", "events=4", "slots=4"]);
    expect(baseline.queryTokens).toEqual([]);
    expect(baseline.geometryTokens).toEqual([]);

    const relabeled = relabelSpec(uniqueSpec, [2, 0, 3, 1], [1, 0]);
    expect(canonicalStructuresEqual(canonicalizeSchedulingSpec(relabeled), baseline)).toBe(
      true,
    );
  });

  it("ignores an implied time fact and separates a different constraint graph", () => {
    const baseline = canonicalizeSchedulingSpec(uniqueSpec);
    const redundant = makeSpec([...uniqueSpec.clues, notAt(0, 2)]);
    expect(canonicalStructuresEqual(canonicalizeSchedulingSpec(redundant), baseline)).toBe(
      true,
    );

    const immediate = makeSpec([
      immediatelyBefore(0, 1),
      immediatelyBefore(1, 2),
      immediatelyBefore(2, 3),
      usesResource(0, 0),
      usesResource(1, 0),
      usesResource(2, 1),
    ]);
    expect(canonicalStructuresEqual(canonicalizeSchedulingSpec(immediate), baseline)).toBe(
      false,
    );
  });

  it("rejects canonicalization of ambiguous specs", () => {
    const ambiguous = makeSpec([
      before(0, 1),
      before(1, 2),
      before(2, 3),
      usesResource(0, 0),
    ]);
    expect(() => schedulingEngine.canonicalData(ambiguous)).toThrow();
  });
});

describe("scheduling construction", () => {
  it("is deterministic for one seed and varies across seeds", () => {
    const first = constructSchedulingSpec(SEED_A, 2);
    const second = constructSchedulingSpec(SEED_A, 2);
    expect(second).toEqual(first);
    const other = constructSchedulingSpec(SEED_B, 2);
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
    const specs: SchedulingSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `scheduling-fixture-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructSchedulingSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof SchedulingConstructionError) {
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
      expect(trace.temporalAdded).toBe(1);
      expect(trace.resourceAdded).toBe(1);
      expect(trace.additionalRequested).toBeGreaterThanOrEqual(4);
      expect(trace.additionalRequested).toBeLessThanOrEqual(6);
      expect(trace.additionalAdded).toBe(trace.additionalRequested);
      expect(trace.clueCountBeforePruning).toBe(6 + trace.additionalAdded);
      expect(trace.clueCountAfterPruning).toBe(spec.clues.length);
      expect(trace.prunedClues).toBe(
        trace.clueCountBeforePruning - trace.clueCountAfterPruning,
      );
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);

      const result = schedulingEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      expect(result.correctAnswer).not.toBeNull();
      if (result.correctAnswer !== null) {
        expect(() => ScheduleTableSchema.parse(result.correctAnswer)).not.toThrow();
        expect(schedulingEngine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
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

describe("scheduling engine contract and registry", () => {
  it("keeps the hidden witness out of the generated spec and re-solves tampered specs", () => {
    const generated = schedulingEngine.generateSpec(SEED_A, 2);
    expect(Object.keys(generated).sort()).toEqual(["clues"]);
    expect(schedulingEngine.generateSpec(SEED_A, 2)).toEqual(generated);
    expect(() => SchedulingSpecSchema.parse({ ...generated, witness: uniqueTable })).toThrow();

    const tampered = makeSpec([
      before(0, 1),
      before(1, 2),
      before(2, 0),
      usesResource(0, 0),
    ]);
    const result = schedulingEngine.enumerateSolutions(tampered);
    expect(result.solutionCount).toBe(0);
    expect(result.correctAnswer).toBeNull();
  });

  it("returns deterministic test mutations with known formal outcomes", () => {
    const mutations = schedulingEngine.testMutations(uniqueSpec);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "resource-only-ambiguity",
      "temporal-contradiction",
      "exact-capacity",
      "immediately-before",
    ]);
    expect(schedulingEngine.testMutations(uniqueSpec)).toEqual(mutations);
    const byId = new Map(mutations.map((mutation) => [mutation.id, mutation.spec]));
    const ambiguous = byId.get("resource-only-ambiguity");
    const contradiction = byId.get("temporal-contradiction");
    const exactCapacity = byId.get("exact-capacity");
    const immediate = byId.get("immediately-before");
    if (
      ambiguous === undefined ||
      contradiction === undefined ||
      exactCapacity === undefined ||
      immediate === undefined
    ) {
      throw new Error("expected all scheduling test mutations");
    }
    expect(schedulingEngine.enumerateSolutions(ambiguous).solutionCount).toBe(3);
    expect(schedulingEngine.enumerateSolutions(contradiction).solutionCount).toBe(0);
    expect(schedulingEngine.enumerateSolutions(exactCapacity).solutionCount).toBe(1);
    expect(schedulingEngine.enumerateSolutions(immediate).solutionCount).toBe(1);
  });

  it("registers ranking, matching, and scheduling as real text engines", () => {
    expect(productionRegistry.listEngineFamilies()).toEqual([
      "ranking",
      "matching",
      "scheduling",
    ]);
    expect(productionRegistry.getEngine("scheduling").family).toBe("scheduling");
    expect(productionRegistry.getEngine("scheduling").modality).toBe("text");
  });
});
