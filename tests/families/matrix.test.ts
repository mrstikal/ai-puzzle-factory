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
import {
  MatrixConstructionError,
  constructMatrixSpec,
  matrixEngine,
  matrixSceneInput,
} from "../../src/families/matrix/engine.js";
import { canonicalizeMatrixSpec } from "../../src/families/matrix/canonical.js";
import {
  EMPTY_MASK_CONVENTION,
  MatrixSpecSchema,
  checkMatrixCompletion,
  maskGlyphs,
  maskPopcount,
  maskText,
  permuteMask,
  solveMatrix,
  visibleMatrixCells,
  type MatrixSpec,
} from "../../src/families/matrix/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

function makeSpec(
  cells: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, null],
  ],
): MatrixSpec {
  return MatrixSpecSchema.parse({ rule: "xor", cells });
}

const baseSpec = makeSpec([
  [1, 2, 3],
  [4, 3, 7],
  [5, 1, null],
]);
const emptySpec = makeSpec([
  [1, 2, 3],
  [4, 7, 3],
  [5, 5, null],
]);

function transposeSpec(spec: MatrixSpec): MatrixSpec {
  const cells = spec.cells;
  return makeSpec([
    [cells[0][0], cells[1][0], cells[2][0]],
    [cells[0][1], cells[1][1], cells[2][1]],
    [cells[0][2], cells[1][2], null],
  ]);
}

function permuteSpec(spec: MatrixSpec, permutation: readonly number[]): MatrixSpec {
  return makeSpec(
    spec.cells.map((row) =>
      row.map((mask) => (mask === null ? null : permuteMask(mask, permutation))) as [
        number,
        number,
        number,
      ],
    ) as [
      [number, number, number],
      [number, number, number],
      [number, number, null],
    ],
  );
}

describe("matrix DSL", () => {
  it("accepts the fixed xor 3x3 shape and rejects unknown rules, bad masks, and malformed missing cells", () => {
    expect(() => MatrixSpecSchema.parse(baseSpec)).not.toThrow();
    expect(() => MatrixSpecSchema.parse({ ...baseSpec, rule: "or" })).toThrow();
    expect(() =>
      MatrixSpecSchema.parse({
        rule: "xor",
        cells: [
          [16, 2, 3],
          [4, 3, 7],
          [5, 1, null],
        ],
      }),
    ).toThrow();
    expect(() =>
      MatrixSpecSchema.parse({
        rule: "xor",
        cells: [
          [1, 2, 3],
          [4, 3, 7],
          [5, null, 1],
        ],
      }),
    ).toThrow();
    expect(() =>
      MatrixSpecSchema.parse({
        rule: "xor",
        cells: [
          [null, 2, 3],
          [4, 3, 7],
          [5, 1, 0],
        ],
      }),
    ).toThrow();
    expect(() =>
      MatrixSpecSchema.parse({
        ...baseSpec,
        missingCell: { row: 0, column: 0 },
      }),
    ).toThrow();
  });

  it("encodes masks as four fixed glyph positions and the explicit empty convention", () => {
    expect(maskPopcount(0)).toBe(0);
    expect(maskPopcount(15)).toBe(4);
    expect(maskGlyphs(5)).toEqual([0, 2]);
    expect(maskText(0)).toBe("empty");
    expect(maskText(5)).toContain("1, 3");
    expect(EMPTY_MASK_CONVENTION).toContain("Mask 0");
  });
});

describe("matrix solver", () => {
  it("finds exactly one of 16 masks satisfying all six row/column equations", () => {
    const solutions = solveMatrix(baseSpec);
    expect(solutions).toEqual([4]);
    const candidates = Array.from({ length: 16 }, (_value, mask) =>
      checkMatrixCompletion(baseSpec, mask),
    );
    expect(candidates.filter(Boolean)).toHaveLength(1);
    expect(candidates[4]).toBe(true);

    const result = matrixEngine.enumerateSolutions(baseSpec);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.correctAnswer).toBe(4);
    expect(result.enumeratedStates).toBe(16);
    expect(result.checkerVersion).toBe("matrix-v1");
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(["s001"]);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(matrixEngine.verifyAnswer(baseSpec, 4)).toBe(true);
    expect(matrixEngine.verifyAnswer(baseSpec, 5)).toBe(false);
  });

  it("rejects inconsistent complete rows or columns and handles the empty mask", () => {
    const inconsistentRow = makeSpec([
      [1, 2, 0],
      [4, 3, 7],
      [5, 1, null],
    ]);
    expect(solveMatrix(inconsistentRow)).toEqual([]);
    const inconsistentColumn = makeSpec([
      [1, 2, 3],
      [4, 3, 7],
      [0, 1, null],
    ]);
    expect(solveMatrix(inconsistentColumn)).toEqual([]);

    expect(solveMatrix(emptySpec)).toEqual([0]);
    expect(matrixEngine.enumerateSolutions(emptySpec).correctAnswer).toBe(0);
  });
});

describe("matrix options", () => {
  it("builds four masks and prefers one-glyph toggles", () => {
    const result = matrixEngine.enumerateSolutions(baseSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique matrix mask");
    }
    const set = matrixEngine.makeOptions(baseSpec, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);
    for (const choice of set.choices) {
      expect(choice.value).toBeGreaterThanOrEqual(0);
      expect(choice.value).toBeLessThanOrEqual(15);
      expect(matrixEngine.verifyAnswer(baseSpec, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
    }
    for (const choice of set.choices) {
      if (choice.label !== set.correctLabel) {
        expect(maskPopcount(choice.value ^ correct)).toBe(1);
      }
    }
    expect(matrixEngine.makeOptions(baseSpec, correct, SEED_A)).toEqual(set);
    expect(() => matrixEngine.makeOptions(baseSpec, 5, SEED_A)).toThrow();
  });

  it("rejects ambiguous specs and uses the seed to change option order", () => {
    const ambiguous = makeSpec([
      [1, 2, 0],
      [4, 3, 7],
      [5, 1, null],
    ]);
    expect(() => matrixEngine.makeOptions(ambiguous, 4, SEED_A)).toThrow();
    const result = matrixEngine.enumerateSolutions(emptySpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique matrix mask");
    }
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, "2".repeat(64), "3".repeat(64)]) {
      const set = matrixEngine.makeOptions(emptySpec, correct, seed);
      orders.add(set.choices.map((choice) => choice.value).join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("matrix canonicalization and scene input", () => {
  it("canonicalizes glyph permutations and transpose while preserving the eight shown masks", () => {
    const baseline = canonicalizeMatrixSpec(baseSpec);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual(["glyphs=4", "grid=3x3", "missing=2,2"]);
    expect(baseline.queryTokens).toEqual(["column=xor", "row=xor"]);
    expect(baseline.geometryTokens).toHaveLength(8);
    expect(baseline.geometryTokens.some((token) => token.includes(":2:2:"))).toBe(false);

    const transposed = canonicalizeMatrixSpec(transposeSpec(baseSpec));
    const permuted = canonicalizeMatrixSpec(permuteSpec(baseSpec, [2, 0, 3, 1]));
    expect(canonicalStructuresEqual(transposed, baseline)).toBe(true);
    expect(canonicalStructuresEqual(permuted, baseline)).toBe(true);

    const different = canonicalizeMatrixSpec(
      makeSpec([
        [15, 2, 3],
        [4, 3, 7],
        [5, 1, null],
      ]),
    );
    expect(canonicalStructuresEqual(different, baseline)).toBe(false);
  });

  it("exposes typed scene input without rendering", () => {
    const result = matrixEngine.enumerateSolutions(baseSpec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique matrix mask");
    }
    const set = matrixEngine.makeOptions(baseSpec, correct, SEED_A);
    const sceneInput = matrixSceneInput(
      baseSpec,
      set.choices.map((choice) => ({ label: choice.label, mask: choice.value })),
    );
    expect(sceneInput.rule).toBe("xor");
    expect(sceneInput.cells).toHaveLength(9);
    expect(sceneInput.missingCell).toEqual({ row: 2, column: 2 });
    expect(sceneInput.cells.find((cell) => cell.row === 2 && cell.column === 2)?.mask).toBeNull();
    expect(sceneInput.glyphPositions).toHaveLength(4);
    expect(sceneInput.emptyMaskConvention).toBe(EMPTY_MASK_CONVENTION);
    expect(sceneInput.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    expect(productionRegistry.listRendererFamilies()).toEqual([]);
  });
});

describe("matrix construction", () => {
  it("is deterministic for one seed and varies across seeds", () => {
    const first = constructMatrixSpec(SEED_A, 2);
    const second = constructMatrixSpec(SEED_A, 2);
    expect(second).toEqual(first);
    const other = constructMatrixSpec(SEED_B, 2);
    expect(deepEqual(other.spec, first.spec)).toBe(false);
    expect(other.trace.drawsUsed).toBeLessThanOrEqual(64);
  });

  it("constructs at least 95 of 100 fixed seeds with required density and uniqueness", () => {
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
    const specs: MatrixSpec[] = [];

    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `matrix-fixture-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructMatrixSpec(seed, difficulty);
      } catch (error) {
        if (error instanceof MatrixConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      const [minimum, maximum] = difficulty === 1 ? [1, 2] : difficulty === 2 ? [1, 3] : [2, 3];
      expect(trace.difficulty).toBe(difficulty);
      expect(trace.attempts).toBeGreaterThanOrEqual(1);
      expect(trace.attempts).toBeLessThanOrEqual(16);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      expect(trace.seedPopulations).toHaveLength(4);
      for (const population of trace.seedPopulations) {
        expect(population).toBeGreaterThanOrEqual(minimum);
        expect(population).toBeLessThanOrEqual(maximum);
      }
      expect(trace.visibleDistinctMasks).toBeGreaterThanOrEqual(4);
      const cells = spec.cells;
      expect(cells[2][2]).toBeNull();
      expect(cells[0][0]).not.toBe(cells[0][1]);
      expect(cells[1][0]).not.toBe(cells[1][1]);
      expect(cells[0][0]).not.toBe(cells[1][0]);
      expect(cells[0][1]).not.toBe(cells[1][1]);
      expect(cells[2][0]).not.toBe(cells[2][1]);
      expect(cells[0][2]).not.toBe(cells[1][2]);
      expect(visibleMatrixCells(spec)).toHaveLength(8);
      const result = matrixEngine.enumerateSolutions(spec);
      expect(result.solutionCount).toBe(1);
      expect(result.correctAnswer).not.toBeNull();
      if (result.correctAnswer !== null) {
        expect(matrixEngine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
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

describe("matrix engine contract and registry", () => {
  it("keeps the hidden witness out of the generated spec and rejects malformed specs", () => {
    const generated = matrixEngine.generateSpec(SEED_A, 2);
    expect(Object.keys(generated).sort()).toEqual(["cells", "rule"]);
    expect(matrixEngine.generateSpec(SEED_A, 2)).toEqual(generated);
    expect(() => MatrixSpecSchema.parse({ ...generated, witness: 4 })).toThrow();
    expect(() => MatrixSpecSchema.parse({ ...generated, rule: "or" })).toThrow();
  });

  it("returns deterministic test mutations with known formal outcomes", () => {
    const mutations = matrixEngine.testMutations(baseSpec);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "inconsistent-visible-row",
      "empty-mask-completion",
    ]);
    expect(matrixEngine.testMutations(baseSpec)).toEqual(mutations);
    const byId = new Map(mutations.map((mutation) => [mutation.id, mutation.spec]));
    const inconsistent = byId.get("inconsistent-visible-row");
    const empty = byId.get("empty-mask-completion");
    if (inconsistent === undefined || empty === undefined) {
      throw new Error("expected matrix test mutations");
    }
    expect(matrixEngine.enumerateSolutions(inconsistent).solutionCount).toBe(0);
    expect(matrixEngine.enumerateSolutions(empty).correctAnswer).toBe(0);
  });

  it("exposes explicit xor rules, fixed facts, and the real matrix engine", () => {
    const rules = matrixEngine.visibleRules(baseSpec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.operations.join(" ")).toContain("exactly one");
    expect(rules.operations.join(" ")).toContain("XOR");
    expect(rules.conventions).toContain(EMPTY_MASK_CONVENTION);
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);
    const facts = matrixEngine.facts(baseSpec);
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
    expect(facts[0]?.text).toContain("Row 1, column 1");
    expect(productionRegistry.listEngineFamilies()).toContain("matrix");
    expect(productionRegistry.getEngine("matrix").modality).toBe("svg");
    expect(productionRegistry.hasRenderer("matrix")).toBe(false);
  });
});
