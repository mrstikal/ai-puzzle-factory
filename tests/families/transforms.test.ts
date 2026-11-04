import { describe, expect, it } from "vitest";
import { deepEqual } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import {
  canonicalStructuresEqual,
} from "../../src/families/canonicalize.js";
import {
  CanonicalStructureSchema,
  D4_OPERATIONS,
  SolveResultSchema,
  VisibleRulesSchema,
  ruleFacts,
  type D4Operation,
} from "../../src/families/contracts.js";
import { canonicalizeTransformsSpec } from "../../src/families/transforms/canonical.js";
import {
  TransformsConstructionError,
  constructTransformsSpec,
  transformOrbit,
  transformsEngine,
} from "../../src/families/transforms/engine.js";
import {
  TRANSFORM_GRID_SIZE,
  TransformAnswerSchema,
  TransformsSpecSchema,
  applyD4Operation,
  checkTransformAnswer,
  composeD4Operations,
  composeD4Sequence,
  conjugateD4Operation,
  gridFromCells,
  inverseD4Operation,
  sameTransformMask,
  solveTransforms,
  sourceCellsFromGrid,
  transformCells,
  transformMaskKey,
  type TransformAnswer,
  type TransformCell,
  type TransformSource,
  type TransformsSpec,
} from "../../src/families/transforms/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

const SOURCE: readonly TransformCell[] = [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 1, column: 1 },
  { row: 2, column: 1 },
];

function makeSpec(
  cells: readonly TransformCell[],
  operations: readonly D4Operation[],
): TransformsSpec {
  return TransformsSpecSchema.parse({
    source: gridFromCells(cells),
    operations,
  });
}

function answerOf(spec: TransformsSpec): TransformAnswer {
  const result = transformsEngine.enumerateSolutions(spec);
  const answer = result.correctAnswer;
  if (answer === null) {
    throw new Error("expected a unique transform answer");
  }
  return answer;
}

function assertLevelOperations(
  operations: readonly D4Operation[],
  difficulty: Difficulty,
): void {
  const rotations: readonly D4Operation[] = [
    "rotate90",
    "rotate180",
    "rotate270",
  ];
  const levelThreeRotations: readonly D4Operation[] = ["rotate90", "rotate270"];
  const reflections: readonly D4Operation[] = [
    "reflectLeftRight",
    "reflectTopBottom",
    "reflectMainDiagonal",
    "reflectAntiDiagonal",
  ];
  if (difficulty === 1) {
    expect(operations).toHaveLength(1);
    expect(rotations).toContain(operations[0]);
    expect(operations[0]).not.toBe("identity");
    return;
  }
  if (difficulty === 2) {
    expect(operations).toHaveLength(1);
    expect(reflections).toContain(operations[0]);
    return;
  }
  expect(operations).toHaveLength(2);
  const first = operations[0];
  const second = operations[1];
  if (first === undefined || second === undefined) {
    throw new Error("level 3 requires two operations");
  }
  const rotationCount = [first, second].filter((operation) =>
    levelThreeRotations.includes(operation),
  ).length;
  const reflectionCount = [first, second].filter((operation) =>
    reflections.includes(operation),
  ).length;
  expect(rotationCount).toBe(1);
  expect(reflectionCount).toBe(1);
  expect(composeD4Operations(first, second)).not.toBe(
    composeD4Operations(second, first),
  );
}

describe("D4 coordinate algebra", () => {
  it("applies the exact zero-based maps with a top-left origin", () => {
    expect(applyD4Operation("identity", { row: 1, column: 2 })).toEqual({
      row: 1,
      column: 2,
    });
    expect(applyD4Operation("rotate90", { row: 0, column: 0 })).toEqual({
      row: 0,
      column: 4,
    });
    expect(applyD4Operation("rotate90", { row: 0, column: 4 })).toEqual({
      row: 4,
      column: 4,
    });
    expect(applyD4Operation("rotate90", { row: 4, column: 4 })).toEqual({
      row: 4,
      column: 0,
    });
    expect(applyD4Operation("rotate180", { row: 0, column: 0 })).toEqual({
      row: 4,
      column: 4,
    });
    expect(applyD4Operation("rotate270", { row: 0, column: 0 })).toEqual({
      row: 4,
      column: 0,
    });
    expect(applyD4Operation("reflectLeftRight", { row: 0, column: 0 })).toEqual({
      row: 0,
      column: 4,
    });
    expect(applyD4Operation("reflectTopBottom", { row: 0, column: 0 })).toEqual({
      row: 4,
      column: 0,
    });
    expect(applyD4Operation("reflectMainDiagonal", { row: 1, column: 2 })).toEqual({
      row: 2,
      column: 1,
    });
    expect(applyD4Operation("reflectAntiDiagonal", { row: 1, column: 2 })).toEqual({
      row: 2,
      column: 3,
    });
  });

  it("satisfies group identities, composition, inverses, and associativity", () => {
    expect(composeD4Operations("rotate90", "rotate90")).toBe("rotate180");
    expect(composeD4Operations("rotate90", "rotate180")).toBe("rotate270");
    expect(composeD4Operations("rotate90", "rotate270")).toBe("identity");
    expect(composeD4Operations("reflectLeftRight", "reflectLeftRight")).toBe(
      "identity",
    );
    expect(composeD4Operations("rotate90", "reflectLeftRight")).toBe(
      "reflectMainDiagonal",
    );
    expect(composeD4Operations("reflectLeftRight", "rotate90")).toBe(
      "reflectAntiDiagonal",
    );
    expect(composeD4Sequence(["rotate90", "rotate90", "rotate90", "rotate90"])).toBe(
      "identity",
    );
    for (const operation of D4_OPERATIONS) {
      expect(composeD4Operations(operation, "identity")).toBe(operation);
      expect(composeD4Operations("identity", operation)).toBe(operation);
      expect(composeD4Operations(operation, inverseD4Operation(operation))).toBe(
        "identity",
      );
      expect(composeD4Operations(inverseD4Operation(operation), operation)).toBe(
        "identity",
      );
      for (const other of D4_OPERATIONS) {
        expect(D4_OPERATIONS).toContain(composeD4Operations(operation, other));
        for (const third of D4_OPERATIONS) {
          expect(
            composeD4Operations(
              composeD4Operations(operation, other),
              third,
            ),
          ).toBe(
            composeD4Operations(
              operation,
              composeD4Operations(other, third),
            ),
          );
        }
      }
    }
  });

  it("keeps R90/R270 with a reflection noncommuting and R180 central", () => {
    const reflections: readonly D4Operation[] = [
      "reflectLeftRight",
      "reflectTopBottom",
      "reflectMainDiagonal",
      "reflectAntiDiagonal",
    ];
    for (const rotation of ["rotate90", "rotate270"] as const) {
      for (const reflection of reflections) {
        expect(composeD4Operations(rotation, reflection)).not.toBe(
          composeD4Operations(reflection, rotation),
        );
      }
    }
    for (const operation of D4_OPERATIONS) {
      expect(composeD4Operations("rotate180", operation)).toBe(
        composeD4Operations(operation, "rotate180"),
      );
    }
  });

  it("conjugates every operation under every frame change consistently", () => {
    for (const frame of D4_OPERATIONS) {
      for (const operation of D4_OPERATIONS) {
        const conjugated = conjugateD4Operation(frame, operation);
        for (const cell of SOURCE) {
          const framed = applyD4Operation(frame, cell);
          const conjugatedAfterFrame = applyD4Operation(conjugated, framed);
          const frameAfterOperation = applyD4Operation(
            frame,
            applyD4Operation(operation, cell),
          );
          expect(conjugatedAfterFrame).toEqual(frameAfterOperation);
        }
      }
    }
    expect(conjugateD4Operation("rotate90", "rotate90")).toBe("rotate90");
    expect(conjugateD4Operation("reflectLeftRight", "rotate90")).toBe("rotate270");
  });
});

describe("transform DSL", () => {
  it("accepts connected 4-8 cell sources and one or two declared D4 steps", () => {
    expect(() => TransformsSpecSchema.parse(makeSpec(SOURCE, ["rotate90"]))).not.toThrow();
    expect(() =>
      TransformsSpecSchema.parse(
        makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]),
      ),
    ).not.toThrow();
    const eightCells: readonly TransformCell[] = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
      { row: 1, column: 3 },
    ];
    expect(() =>
      TransformsSpecSchema.parse(makeSpec(eightCells, ["rotate270"])),
    ).not.toThrow();
  });

  it("rejects wrong occupancy, disconnected sources, bad grids, and bad operations", () => {
    const threeCells: readonly TransformCell[] = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 1 },
    ];
    const nineCells: TransformCell[] = [];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        nineCells.push({ row, column });
      }
    }
    const disconnected: readonly TransformCell[] = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 2, column: 2 },
      { row: 2, column: 3 },
    ];
    expect(() => makeSpec(threeCells, ["rotate90"])).toThrow();
    expect(() => makeSpec(nineCells, ["rotate90"])).toThrow();
    expect(() => makeSpec(disconnected, ["rotate90"])).toThrow();

    expect(() =>
      TransformsSpecSchema.parse({
        source: [
          [2, 0, 0, 0, 0],
          [0, 1, 0, 0, 0],
          [0, 0, 1, 0, 0],
          [0, 0, 0, 1, 0],
          [0, 0, 0, 0, 0],
        ],
        operations: ["rotate90"],
      }),
    ).toThrow();
    expect(() =>
      TransformsSpecSchema.parse({
        source: [
          [1, 0, 0, 0],
          [1, 0, 0, 0],
          [1, 0, 0, 0],
          [1, 0, 0, 0],
        ],
        operations: ["rotate90"],
      }),
    ).toThrow();
    expect(() => TransformsSpecSchema.parse(makeSpec(SOURCE, []))).toThrow();
    expect(() =>
      TransformsSpecSchema.parse(makeSpec(SOURCE, ["rotate90", "rotate180", "rotate270"])),
    ).toThrow();
    expect(() =>
      TransformsSpecSchema.parse({ ...makeSpec(SOURCE, ["rotate90"]), operations: ["rotate17"] }),
    ).toThrow();
    expect(() =>
      TransformsSpecSchema.parse({
        ...makeSpec(SOURCE, ["rotate90"]),
        witness: SOURCE,
      }),
    ).toThrow();
  });

  it("validates sorted unique complete answers and grid helpers", () => {
    const answer = answerOf(makeSpec(SOURCE, ["rotate90"]));
    expect(() => TransformAnswerSchema.parse(answer)).not.toThrow();
    expect(() =>
      TransformAnswerSchema.parse([...answer].reverse()),
    ).toThrow();
    expect(() =>
      TransformAnswerSchema.parse([answer[0], answer[0]]),
    ).toThrow();
    expect(() =>
      TransformAnswerSchema.parse([{ row: 5, column: 0 }]),
    ).toThrow();
    expect(() => gridFromCells([{ row: 0, column: 0 }, { row: 0, column: 0 }])).toThrow();
    expect(() => gridFromCells([{ row: 5, column: 0 }])).toThrow();
    const source: TransformSource = gridFromCells(SOURCE);
    expect(sourceCellsFromGrid(source)).toEqual(SOURCE);
  });
});

describe("transform solver", () => {
  it("produces the hand-checked R90 and left-right outputs", () => {
    const rotated = solveTransforms(makeSpec(SOURCE, ["rotate90"]));
    expect(rotated).toEqual([
      { row: 0, column: 4 },
      { row: 1, column: 2 },
      { row: 1, column: 3 },
      { row: 1, column: 4 },
    ]);
    const reflected = solveTransforms(makeSpec(SOURCE, ["reflectLeftRight"]));
    expect(reflected).toEqual([
      { row: 0, column: 3 },
      { row: 0, column: 4 },
      { row: 1, column: 3 },
      { row: 2, column: 3 },
    ]);
    expect(
      transformCells(SOURCE, ["rotate90"]),
    ).toEqual(rotated);
  });

  it("returns one complete output with a derived proof and independent checking", () => {
    const spec = makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]);
    const result = transformsEngine.enumerateSolutions(spec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ]);
    expect(result.enumeratedStates).toBe(TRANSFORM_GRID_SIZE * TRANSFORM_GRID_SIZE);
    expect(result.checkerVersion).toBe("transforms-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    const answer = result.correctAnswer;
    if (answer === null) {
      throw new Error("expected a unique transform answer");
    }
    expect(checkTransformAnswer(spec, answer)).toBe(true);
    expect(transformsEngine.verifyAnswer(spec, answer)).toBe(true);
    expect(
      transformsEngine.verifyAnswer(spec, [
        ...answer.slice(0, 3),
        { row: 4, column: 4 },
      ]),
    ).toBe(false);
    expect(
      transformsEngine.verifyAnswer(spec, [
        { row: 0, column: 0 },
        { row: 1, column: 0 },
        { row: 1, column: 1 },
      ]),
    ).toBe(false);
  });

  it("makes reversed step order detectably wrong", () => {
    const forward = makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]);
    const reversed = makeSpec(SOURCE, ["reflectLeftRight", "rotate90"]);
    const forwardAnswer = answerOf(forward);
    const reversedAnswer = answerOf(reversed);
    expect(forwardAnswer).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ]);
    expect(reversedAnswer).toEqual([
      { row: 3, column: 2 },
      { row: 3, column: 3 },
      { row: 3, column: 4 },
      { row: 4, column: 4 },
    ]);
    expect(sameTransformMask(forwardAnswer, reversedAnswer)).toBe(false);
    expect(transformsEngine.verifyAnswer(reversed, forwardAnswer)).toBe(false);
    expect(transformsEngine.verifyAnswer(forward, reversedAnswer)).toBe(false);
  });

  it("handles an identity net and rejects malformed answers safely", () => {
    const identityNet = makeSpec(SOURCE, ["rotate90", "rotate270"]);
    expect(composeD4Sequence(identityNet.operations)).toBe("identity");
    expect(answerOf(identityNet)).toEqual(SOURCE);
    expect(
      transformsEngine.verifyAnswer(identityNet, [{ row: 0, column: 0 }]),
    ).toBe(false);
    expect(
      transformsEngine.verifyAnswer(
        { ...identityNet, operations: [] } as unknown as TransformsSpec,
        [...SOURCE],
      ),
    ).toBe(false);
  });
});

describe("transform options", () => {
  it("builds four distinct complete orbit outputs with exactly one key", () => {
    const spec = makeSpec(SOURCE, ["rotate90"]);
    const correct = answerOf(spec);
    const set = transformsEngine.makeOptions(spec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    let trueChoices = 0;
    for (const choice of set.choices) {
      expect(choice.value).toHaveLength(SOURCE.length);
      if (transformsEngine.verifyAnswer(spec, choice.value)) {
        trueChoices += 1;
      }
      if (choice.label !== set.correctLabel) {
        expect(
          transformOrbit(SOURCE).some((orbit) =>
            sameTransformMask(orbit, choice.value),
          ),
        ).toBe(true);
      }
    }
    expect(trueChoices).toBe(1);
    expect(transformsEngine.makeOptions(spec, correct, SEED_A)).toEqual(set);
    expect(() => transformsEngine.makeOptions(spec, [...SOURCE], SEED_A)).toThrow();
  });

  it("uses the option seed to change order and rejects insufficient orbits", () => {
    const spec = makeSpec(SOURCE, ["reflectLeftRight"]);
    const correct = answerOf(spec);
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = transformsEngine.makeOptions(spec, correct, seed);
      orders.add(set.choices.map((choice) => transformMaskKey(choice.value)).join(";"));
    }
    expect(orders.size).toBeGreaterThan(1);

    const symmetricSource: readonly TransformCell[] = [
      { row: 1, column: 2 },
      { row: 2, column: 1 },
      { row: 2, column: 2 },
      { row: 2, column: 3 },
      { row: 3, column: 2 },
    ];
    const symmetric = makeSpec(symmetricSource, ["rotate90"]);
    expect(transformOrbit(symmetricSource)).toHaveLength(1);
    expect(answerOf(symmetric)).toEqual(symmetricSource);
    expect(() =>
      transformsEngine.makeOptions(symmetric, [...symmetricSource], SEED_A),
    ).toThrow();
  });
});

describe("transform canonicalization", () => {
  it("is invariant under conjugated D4 frame changes", () => {
    const spec = makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]);
    const baseline = canonicalizeTransformsSpec(spec);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["grid=5x5"]);
    expect(baseline.queryKind).toBe("apply_D4");
    expect(baseline.relationTokens).toEqual([]);
    expect(baseline.geometryTokens).toHaveLength(SOURCE.length);
    expect(new Set(baseline.geometryTokens).size).toBe(SOURCE.length);
    expect(baseline.queryTokens).toHaveLength(4);
    expect(baseline.queryTokens).toContain("steps=2");
    expect(baseline.queryTokens.some((token) => token.startsWith("op0="))).toBe(true);
    expect(baseline.queryTokens.some((token) => token.startsWith("op1="))).toBe(true);
    expect(baseline.queryTokens.some((token) => token.startsWith("net="))).toBe(true);

    for (const frame of D4_OPERATIONS) {
      const framedSource = transformCells(SOURCE, [frame]);
      const conjugated = spec.operations.map((operation) =>
        conjugateD4Operation(frame, operation),
      );
      const framedSpec = makeSpec(framedSource, conjugated);
      expect(
        canonicalStructuresEqual(
          baseline,
          canonicalizeTransformsSpec(framedSpec),
        ),
      ).toBe(true);
    }
  });

  it("retains step count and order instead of collapsing to the net effect", () => {
    const twoStep = makeSpec(SOURCE, ["rotate90", "rotate90"]);
    const oneStep = makeSpec(SOURCE, ["rotate180"]);
    expect(composeD4Sequence(twoStep.operations)).toBe("rotate180");
    expect(composeD4Sequence(oneStep.operations)).toBe("rotate180");
    const twoStepCanonical = canonicalizeTransformsSpec(twoStep);
    const oneStepCanonical = canonicalizeTransformsSpec(oneStep);
    expect(twoStepCanonical.queryTokens).toContain("steps=2");
    expect(oneStepCanonical.queryTokens).toContain("steps=1");
    expect(canonicalStructuresEqual(twoStepCanonical, oneStepCanonical)).toBe(
      false,
    );

    const twoStepReflection = makeSpec(SOURCE, [
      "rotate90",
      "reflectLeftRight",
    ]);
    const oneStepReflection = makeSpec(SOURCE, ["reflectMainDiagonal"]);
    expect(composeD4Sequence(twoStepReflection.operations)).toBe(
      composeD4Sequence(oneStepReflection.operations),
    );
    expect(
      canonicalStructuresEqual(
        canonicalizeTransformsSpec(twoStepReflection),
        canonicalizeTransformsSpec(oneStepReflection),
      ),
    ).toBe(false);

    const commutingForward = makeSpec(SOURCE, ["rotate90", "rotate180"]);
    const commutingReverse = makeSpec(SOURCE, ["rotate180", "rotate90"]);
    expect(composeD4Sequence(commutingForward.operations)).toBe(
      composeD4Sequence(commutingReverse.operations),
    );
    expect(
      canonicalStructuresEqual(
        canonicalizeTransformsSpec(commutingForward),
        canonicalizeTransformsSpec(commutingReverse),
      ),
    ).toBe(false);
  });

  it("separates genuinely different sources and operation sequences", () => {
    const baseline = canonicalizeTransformsSpec(
      makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]),
    );
    const otherSource: readonly TransformCell[] = [
      { row: 0, column: 2 },
      { row: 0, column: 3 },
      { row: 1, column: 3 },
      { row: 2, column: 3 },
    ];
    const differentSource = canonicalizeTransformsSpec(
      makeSpec(otherSource, ["rotate90", "reflectLeftRight"]),
    );
    const differentOperation = canonicalizeTransformsSpec(
      makeSpec(SOURCE, ["reflectLeftRight", "rotate90"]),
    );
    expect(canonicalStructuresEqual(baseline, differentSource)).toBe(false);
    expect(canonicalStructuresEqual(baseline, differentOperation)).toBe(false);
  });
});

describe("transform construction", () => {
  it("is deterministic and varies across seeds", () => {
    const first = constructTransformsSpec(SEED_A, 2);
    const second = constructTransformsSpec(SEED_A, 2);
    expect(second).toEqual(first);
    const other = constructTransformsSpec(SEED_B, 2);
    expect(deepEqual(other.spec, first.spec)).toBe(false);
    expect(other.trace.drawsUsed).toBeLessThanOrEqual(64);
  });

  it("constructs level-specific connected asymmetric sources with orbit choices", () => {
    for (const difficulty of [1, 2, 3] as const) {
      for (const seed of [SEED_A, SEED_B, "2".repeat(64)]) {
        const { spec, trace } = constructTransformsSpec(seed, difficulty);
        assertLevelOperations(spec.operations, difficulty);
        const source = sourceCellsFromGrid(spec.source);
        expect(source.length).toBeGreaterThanOrEqual(4);
        expect(source.length).toBeLessThanOrEqual(8);
        expect(trace.sourceSize).toBe(source.length);
        expect(trace.orbitSize).toBeGreaterThanOrEqual(4);
        expect(trace.attempts).toBeGreaterThanOrEqual(1);
        expect(trace.attempts).toBeLessThanOrEqual(16);
        expect(trace.drawsUsed).toBeLessThanOrEqual(64);
        expect(trace.net).toBe(composeD4Sequence(spec.operations));
        const answer = answerOf(spec);
        expect(sameTransformMask(answer, source)).toBe(false);
        const set = transformsEngine.makeOptions(spec, answer, SEED_A);
        expect(set.choices).toHaveLength(4);
      }
    }
  });

  it("constructs at least 95 of 100 fixed seeds with independently verified outputs", () => {
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
    const specs: TransformsSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const slotId = `transforms-fixture-${String(index + 1).padStart(3, "0")}`;
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructTransformsSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof TransformsConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      assertLevelOperations(spec.operations, difficulty);
      const source = sourceCellsFromGrid(spec.source);
      expect(source.length).toBeGreaterThanOrEqual(4);
      expect(source.length).toBeLessThanOrEqual(8);
      expect(trace.orbitSize).toBeGreaterThanOrEqual(4);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      const result = transformsEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      const answer = result.correctAnswer;
      if (answer === null) {
        throw new Error("expected a unique transform answer");
      }
      expect(sameTransformMask(answer, source)).toBe(false);
      expect(transformsEngine.verifyAnswer(spec, answer)).toBe(true);
      const optionsSeed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "options",
      });
      const set = transformsEngine.makeOptions(spec, answer, optionsSeed);
      expect(set.choices).toHaveLength(4);
      expect(
        set.choices.filter((choice) =>
          transformsEngine.verifyAnswer(spec, choice.value),
        ),
      ).toHaveLength(1);
      specs.push(spec);
    }

    expect(successes[1]).toBeGreaterThanOrEqual(30);
    expect(successes[2]).toBeGreaterThanOrEqual(30);
    expect(successes[3]).toBeGreaterThanOrEqual(30);
    expect(successes[1] + successes[2] + successes[3]).toBeGreaterThanOrEqual(95);
    expect(failures.length).toBeLessThanOrEqual(5);
    expect(new Set(specs.map((spec) => JSON.stringify(spec))).size).toBeGreaterThan(
      1,
    );
  });
});

describe("transform engine contract and registry", () => {
  it("keeps the hidden answer out of the generated spec", () => {
    const generated = transformsEngine.generateSpec(SEED_A, 3);
    expect(Object.keys(generated).sort()).toEqual(["operations", "source"]);
    expect(transformsEngine.generateSpec(SEED_A, 3)).toEqual(generated);
    expect(() =>
      TransformsSpecSchema.parse({ ...generated, witness: SOURCE }),
    ).toThrow();
  });

  it("returns deterministic mutations including a same-net step-count change", () => {
    const spec = makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]);
    const mutations = transformsEngine.testMutations(spec);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "reversed-operation-order",
      "same-net-different-step-count",
    ]);
    expect(transformsEngine.testMutations(spec)).toEqual(mutations);
    const reversed = mutations[0]?.spec;
    const sameNet = mutations[1]?.spec;
    if (reversed === undefined || sameNet === undefined) {
      throw new Error("expected transform mutations");
    }
    expect(composeD4Sequence(sameNet.operations)).toBe(
      composeD4Sequence(spec.operations),
    );
    expect(sameTransformMask(answerOf(spec), answerOf(reversed))).toBe(false);
    expect(
      canonicalStructuresEqual(
        canonicalizeTransformsSpec(spec),
        canonicalizeTransformsSpec(sameNet),
      ),
    ).toBe(false);

    const oneStep = makeSpec(SOURCE, ["rotate90"]);
    const oneStepMutations = transformsEngine.testMutations(oneStep);
    expect(oneStepMutations.map((mutation) => mutation.id)).toEqual([
      "alternate-single-operation",
      "same-net-different-step-count",
    ]);
    const alternate = oneStepMutations[0]?.spec;
    if (alternate === undefined) {
      throw new Error("expected an alternate one-step transform mutation");
    }
    expect(alternate.operations[0]).not.toBe(oneStep.operations[0]);
    expect(sameTransformMask(answerOf(oneStep), answerOf(alternate))).toBe(false);

    const symmetric180Source: readonly TransformCell[] = [
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 1, column: 2 },
      { row: 2, column: 2 },
      { row: 3, column: 2 },
      { row: 4, column: 2 },
      { row: 4, column: 3 },
    ];
    const symmetric180 = makeSpec(symmetric180Source, ["rotate270"]);
    const symmetricMutation = transformsEngine.testMutations(symmetric180)[0];
    if (symmetricMutation === undefined) {
      throw new Error("expected a symmetric-source mutation");
    }
    expect(symmetricMutation.id).toBe("alternate-single-operation");
    expect(symmetricMutation.spec.operations[0]).not.toBe("rotate270");
    expect(
      sameTransformMask(
        answerOf(symmetric180),
        answerOf(symmetricMutation.spec),
      ),
    ).toBe(false);

    const repeated = makeSpec(SOURCE, ["rotate90", "rotate90"]);
    const repeatedMutation = transformsEngine.testMutations(repeated)[0];
    if (repeatedMutation === undefined) {
      throw new Error("expected a repeated two-step mutation");
    }
    expect(repeatedMutation.id).toBe("alternate-two-step-operation");
    expect(deepEqual(repeatedMutation.spec, repeated)).toBe(false);
    expect(
      sameTransformMask(answerOf(repeated), answerOf(repeatedMutation.spec)),
    ).toBe(false);

    const rowSource: readonly TransformCell[] = [
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
      { row: 1, column: 3 },
      { row: 1, column: 4 },
    ];
    const repeatedReflection = makeSpec(rowSource, [
      "reflectMainDiagonal",
      "reflectMainDiagonal",
    ]);
    const reflectionMutation = transformsEngine.testMutations(repeatedReflection)[0];
    if (reflectionMutation === undefined) {
      throw new Error("expected a repeated-reflection mutation");
    }
    expect(reflectionMutation.id).toBe("alternate-two-step-operation");
    expect(
      sameTransformMask(
        answerOf(repeatedReflection),
        answerOf(reflectionMutation.spec),
      ),
    ).toBe(false);
  });

  it("exposes explicit viewer-relative rules, observation facts, and registration", () => {
    const spec = makeSpec(SOURCE, ["rotate90"]);
    const rules = transformsEngine.visibleRules(spec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.operations.join(" ")).toContain("listed order");
    expect(rules.operations.join(" ")).toContain("clockwise");
    expect(rules.operations.join(" ")).toContain("(c,4-r)");
    expect(rules.closedWorld).toContain("viewer");
    expect(rules.conventions.join(" ")).toContain("(2,2)");
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);

    const facts = transformsEngine.facts(spec);
    expect(facts.map((fact) => fact.factId)).toEqual([
      "p001",
      "p002",
      "p003",
      "p004",
    ]);
    expect(facts[0]?.text).toContain("row 1, column 1");
    expect(facts[3]?.text).toContain("row 3, column 2");
    expect(productionRegistry.listEngineFamilies()).toContain("transforms");
    expect(productionRegistry.getEngine("transforms").modality).toBe("svg");
    expect(productionRegistry.hasRenderer("transforms")).toBe(true);
    expect(productionRegistry.listRendererFamilies()).toContain("transforms");
  });
});
