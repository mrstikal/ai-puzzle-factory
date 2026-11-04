import { describe, expect, it } from "vitest";
import { deepEqual, makeChoiceSet } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import {
  CanonicalStructureSchema,
  SolveResultSchema,
  VisibleRulesSchema,
  ruleFacts,
} from "../../src/families/contracts.js";
import { canonicalizeSymmetrySpec } from "../../src/families/symmetry/canonical.js";
import {
  SymmetryConstructionError,
  constructSymmetrySpec,
  symmetryEngine,
} from "../../src/families/symmetry/engine.js";
import {
  SymmetryAnswerSchema,
  SymmetrySpecSchema,
  checkSymmetryAnswer,
  completeSymmetry,
  knownOccupiedCells,
  mirrorSymmetryCell,
  missingSymmetryCells,
  symmetryKnownComponents,
  type SymmetryAnswer,
  type SymmetryAxis,
  type SymmetryCell,
  type SymmetryCellState,
  type SymmetrySpec,
} from "../../src/families/symmetry/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);

const VERTICAL_OCCUPIED: readonly SymmetryCell[] = [
  { row: 0, column: 0 },
  { row: 1, column: 0 },
  { row: 1, column: 1 },
  { row: 2, column: 2 },
];

const HORIZONTAL_OCCUPIED: readonly SymmetryCell[] = VERTICAL_OCCUPIED.map((cell) => ({
  row: cell.column,
  column: cell.row,
}));

function makeSpec(
  axis: SymmetryAxis,
  occupied: readonly SymmetryCell[],
): SymmetrySpec {
  const occupiedKeys = new Set(
    occupied.map((cell) => `${cell.row}:${cell.column}`),
  );
  const cells: SymmetryCellState[][] = Array.from(
    { length: 8 },
    () => Array.from({ length: 8 }, () => "unknown" as const),
  );
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const known = axis === "vertical" ? column < 4 : row < 4;
      if (known) {
        const state = occupiedKeys.has(`${row}:${column}`)
          ? "occupied"
          : "empty";
        const targetRow = cells[row];
        if (targetRow !== undefined) {
          targetRow[column] = state;
        }
      }
    }
  }
  return SymmetrySpecSchema.parse({ axis, cells });
}

function answerOf(spec: SymmetrySpec): SymmetryAnswer {
  const result = symmetryEngine.enumerateSolutions(spec);
  const answer = result.correctAnswer;
  if (answer === null) {
    throw new Error("expected a unique symmetry answer");
  }
  return answer;
}

function occupiedFromAnswer(answer: readonly (readonly number[])[]): readonly SymmetryCell[] {
  const cells: SymmetryCell[] = [];
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (answer[row]?.[column] === 1) {
        cells.push({ row, column });
      }
    }
  }
  return cells;
}

function reverseRows(cells: readonly SymmetryCell[]): readonly SymmetryCell[] {
  return cells.map((cell) => ({ row: 7 - cell.row, column: cell.column }));
}

function reverseColumns(cells: readonly SymmetryCell[]): readonly SymmetryCell[] {
  return cells.map((cell) => ({ row: cell.row, column: 7 - cell.column }));
}

describe("symmetry DSL", () => {
  it("accepts vertical/left and horizontal/top known halves with 4-10 occupied cells", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const horizontal = makeSpec("horizontal", HORIZONTAL_OCCUPIED);
    expect(() => SymmetrySpecSchema.parse(vertical)).not.toThrow();
    expect(() => SymmetrySpecSchema.parse(horizontal)).not.toThrow();
    expect(knownOccupiedCells(vertical)).toHaveLength(4);
    expect(knownOccupiedCells(horizontal)).toHaveLength(4);
    expect(missingSymmetryCells(vertical.axis)).toHaveLength(32);
    expect(missingSymmetryCells(horizontal.axis)).toHaveLength(32);
  });

  it("rejects unknown known cells, known missing cells, bad counts, axes, sizes, and extra keys", () => {
    const base = makeSpec("vertical", VERTICAL_OCCUPIED);
    const unknownKnown = base.cells.map((row) => [...row]);
    const firstRow = unknownKnown[0];
    if (firstRow !== undefined) {
      firstRow[0] = "unknown";
    }
    expect(() =>
      SymmetrySpecSchema.parse({ axis: "vertical", cells: unknownKnown }),
    ).toThrow();

    const knownMissing = base.cells.map((row) => [...row]);
    const missingRow = knownMissing[0];
    if (missingRow !== undefined) {
      missingRow[4] = "occupied";
    }
    expect(() =>
      SymmetrySpecSchema.parse({ axis: "vertical", cells: knownMissing }),
    ).toThrow();

    expect(() =>
      makeSpec("vertical", [
        { row: 0, column: 0 },
        { row: 1, column: 0 },
        { row: 1, column: 1 },
      ]),
    ).toThrow();
    expect(() =>
      makeSpec(
        "vertical",
        Array.from({ length: 11 }, (_, index) => ({
          row: index % 8,
          column: Math.floor(index / 8),
        })),
      ),
    ).toThrow();
    expect(() =>
      SymmetrySpecSchema.parse({ axis: "diagonal", cells: base.cells }),
    ).toThrow();
    expect(() =>
      SymmetrySpecSchema.parse({ axis: "vertical", cells: base.cells.slice(0, 7) }),
    ).toThrow();
    expect(() =>
      SymmetrySpecSchema.parse({ ...base, knownSide: "left" }),
    ).toThrow();
    expect(() =>
      makeSpec("vertical", []),
    ).toThrow();
  });
});

describe("symmetry completion and checker", () => {
  it("forces the vertical and horizontal reflected completions directly", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const horizontal = makeSpec("horizontal", HORIZONTAL_OCCUPIED);
    const verticalAnswer = answerOf(vertical);
    const horizontalAnswer = answerOf(horizontal);
    expect(occupiedFromAnswer(verticalAnswer)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 7 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 6 },
      { row: 1, column: 7 },
      { row: 2, column: 2 },
      { row: 2, column: 5 },
    ]);
    expect(occupiedFromAnswer(horizontalAnswer)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 1 },
      { row: 2, column: 2 },
      { row: 5, column: 2 },
      { row: 6, column: 1 },
      { row: 7, column: 0 },
      { row: 7, column: 1 },
    ]);
    expect(checkSymmetryAnswer(vertical, verticalAnswer)).toBe(true);
    expect(checkSymmetryAnswer(horizontal, horizontalAnswer)).toBe(true);
    expect(completeSymmetry(vertical)).toEqual(verticalAnswer);
  });

  it("records one forced fact for every missing cell and never enumerates 2^32 images", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const result = symmetryEngine.enumerateSolutions(vertical);
    expect(result.solutionCount).toBe(1);
    expect(result.answerCount).toBe(1);
    expect(result.enumeratedStates).toBe(64);
    expect(result.enumeratedStates).not.toBe(2 ** 32);
    expect(result.checkerVersion).toBe("symmetry-v1");
    expect(result.proof?.facts).toHaveLength(32);
    expect(result.proof?.facts.map((fact) => fact.factId)).toEqual(
      Array.from({ length: 32 }, (_, index) => `s${String(index + 1).padStart(3, "0")}`),
    );
    const missing = missingSymmetryCells(vertical.axis);
    for (const [index, cell] of missing.entries()) {
      const fact = result.proof?.facts[index];
      expect(fact?.text).toContain(`row ${cell.row + 1}, column ${cell.column + 1}`);
      const mirror = mirrorSymmetryCell(vertical.axis, cell);
      expect(fact?.text).toContain(`row ${mirror.row + 1}, column ${mirror.column + 1}`);
    }
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
  });

  it("rejects altered known cells, omitted/extra reflected cells, and malformed answers", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const correct = answerOf(vertical);
    const alteredKnown = correct.map((row) => [...row]);
    const alteredRow = alteredKnown[0];
    if (alteredRow !== undefined) {
      alteredRow[0] = 0;
    }
    expect(checkSymmetryAnswer(vertical, alteredKnown)).toBe(false);
    const omittedMirror = correct.map((row) => [...row]);
    const omittedRow = omittedMirror[0];
    if (omittedRow !== undefined) {
      omittedRow[7] = 0;
    }
    expect(checkSymmetryAnswer(vertical, omittedMirror)).toBe(false);
    const extraMirror = correct.map((row) => [...row]);
    const extraRow = extraMirror[0];
    if (extraRow !== undefined) {
      extraRow[4] = 1;
    }
    expect(checkSymmetryAnswer(vertical, extraMirror)).toBe(false);
    expect(
      checkSymmetryAnswer(vertical, correct.slice(0, 7)),
    ).toBe(false);
    expect(
      symmetryEngine.verifyAnswer(vertical, alteredKnown as SymmetryAnswer),
    ).toBe(false);
  });
});

describe("symmetry options", () => {
  it("builds four full completions with the same known half and one valid answer", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const correct = answerOf(vertical);
    const set = symmetryEngine.makeOptions(vertical, correct, SEED_A);
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    let trueChoices = 0;
    const keys = new Set<string>();
    for (const choice of set.choices) {
      expect(() => SymmetryAnswerSchema.parse(choice.value)).not.toThrow();
      keys.add(choice.value.map((row) => row.join("")).join("|"));
      for (const cell of knownOccupiedCells(vertical)) {
        expect(choice.value[cell.row]?.[cell.column]).toBe(1);
      }
      if (symmetryEngine.verifyAnswer(vertical, choice.value)) {
        trueChoices += 1;
      }
    }
    expect(trueChoices).toBe(1);
    expect(keys.size).toBe(4);
    const falseChoices = set.choices.filter(
      (choice) => !symmetryEngine.verifyAnswer(vertical, choice.value),
    );
    const shifted = falseChoices.find((choice) => {
      const diffs = missingDiffs(vertical, correct, choice.value);
      return (
        diffs.length === 2 &&
        diffs[0] !== undefined &&
        diffs[1] !== undefined &&
        orthogonallyAdjacent(diffs[0], diffs[1])
      );
    });
    expect(shifted).toBeDefined();
    if (shifted !== undefined) {
      const diffs = missingDiffs(vertical, correct, shifted.value);
      const values = diffs.map(
        (cell) => correct[cell.row]?.[cell.column],
      );
      expect(values.sort()).toEqual([0, 1]);
    }
    expect(
      deepEqual(
        set.choices.find((choice) => choice.label === set.correctLabel)?.value,
        correct,
      ),
    ).toBe(true);
    expect(symmetryEngine.makeOptions(vertical, correct, SEED_A)).toEqual(set);
    expect(() =>
      symmetryEngine.makeOptions(vertical, correct, SEED_B),
    ).not.toThrow();
    expect(() =>
      symmetryEngine.makeOptions(vertical, alteredAnswer(correct), SEED_A),
    ).toThrow();
    expect(() =>
      makeChoiceSet({
        correct,
        distractors: [correct, correct, correct],
        seed: SEED_A,
      }),
    ).toThrow();
  });
});

function alteredAnswer(answer: SymmetryAnswer): SymmetryAnswer {
  const altered = answer.map((row) => [...row]);
  const row = altered[0];
  if (row !== undefined) {
    row[0] = row[0] === 1 ? 0 : 1;
  }
  return SymmetryAnswerSchema.parse(altered);
}

function missingDiffs(
  spec: SymmetrySpec,
  correct: SymmetryAnswer,
  choice: SymmetryAnswer,
): readonly SymmetryCell[] {
  return missingSymmetryCells(spec.axis).filter(
    (cell) =>
      correct[cell.row]?.[cell.column] !== choice[cell.row]?.[cell.column],
  );
}

function orthogonallyAdjacent(left: SymmetryCell, right: SymmetryCell): boolean {
  return (
    Math.abs(left.row - right.row) + Math.abs(left.column - right.column) === 1
  );
}

describe("symmetry canonicalization", () => {
  it("normalizes horizontal axes and minimizes over reversal along the axis", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const horizontal = makeSpec("horizontal", HORIZONTAL_OCCUPIED);
    const baseline = canonicalizeSymmetrySpec(vertical);
    expect(() => CanonicalStructureSchema.parse(baseline)).not.toThrow();
    expect(baseline.domainTokens).toEqual([
      "axis=vertical",
      "grid=8x8",
      "knownSide=left",
    ]);
    expect(baseline.queryKind).toBe("reflect_half");
    expect(baseline.queryTokens).toEqual([]);
    expect(baseline.relationTokens).toEqual([]);
    expect(baseline.geometryTokens).toHaveLength(4);
    expect(canonicalizeSymmetrySpec(horizontal)).toEqual(baseline);
    expect(
      canonicalizeSymmetrySpec(makeSpec("vertical", reverseRows(VERTICAL_OCCUPIED))),
    ).toEqual(baseline);
    expect(
      canonicalizeSymmetrySpec(makeSpec("horizontal", reverseColumns(HORIZONTAL_OCCUPIED))),
    ).toEqual(baseline);
  });

  it("separates a genuinely different known half", () => {
    const baseline = canonicalizeSymmetrySpec(
      makeSpec("vertical", VERTICAL_OCCUPIED),
    );
    const different = canonicalizeSymmetrySpec(
      makeSpec("vertical", [
        { row: 0, column: 3 },
        { row: 1, column: 3 },
        { row: 2, column: 3 },
        { row: 3, column: 3 },
      ]),
    );
    expect(different).not.toEqual(baseline);
  });
});

describe("symmetry construction", () => {
  it("is deterministic and respects level axis/count/component rules", () => {
    const first = constructSymmetrySpec(SEED_A, 3);
    expect(constructSymmetrySpec(SEED_A, 3)).toEqual(first);
    expect(deepEqual(constructSymmetrySpec(SEED_B, 3).spec, first.spec)).toBe(false);
    for (const difficulty of [1, 2, 3] as const) {
      const { spec, trace } = constructSymmetrySpec(SEED_A, difficulty);
      expect(trace.difficulty).toBe(difficulty);
      expect(trace.drawsUsed).toBeLessThanOrEqual(64);
      expect(trace.occupiedCount).toBeGreaterThanOrEqual(
        difficulty === 1 ? 4 : difficulty === 2 ? 6 : 8,
      );
      expect(trace.occupiedCount).toBeLessThanOrEqual(
        difficulty === 1 ? 5 : difficulty === 2 ? 7 : 10,
      );
      if (difficulty === 1) {
        expect(trace.axis).toBe("vertical");
      } else if (difficulty === 2) {
        expect(trace.axis).toBe("horizontal");
      } else {
        expect(trace.componentCount).toBeGreaterThanOrEqual(2);
      }
      expect(trace.componentCount).toBe(
        symmetryKnownComponents(trace.axis, knownOccupiedCells(spec)),
      );
      expect(answerOf(spec)).toBeDefined();
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
    const specs: SymmetrySpec[] = [];
    for (const [index, difficulty] of difficulties.entries()) {
      const slotId = `symmetry-fixture-${String(index + 1).padStart(3, "0")}`;
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "spec",
      });
      let construction;
      try {
        construction = constructSymmetrySpec(seed, difficulty);
      } catch (error) {
        if (error instanceof SymmetryConstructionError) {
          failures.push({ seed, difficulty, code: error.code });
          continue;
        }
        throw error;
      }
      successes[difficulty] += 1;
      const { spec, trace } = construction;
      if (difficulty === 3) {
        expect(trace.componentCount).toBeGreaterThanOrEqual(2);
      }
      const answer = answerOf(spec);
      expect(symmetryEngine.verifyAnswer(spec, answer)).toBe(true);
      const result = symmetryEngine.enumerateSolutions(spec);
      expect(result.proof?.facts).toHaveLength(32);
      const optionsSeed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId,
        purpose: "options",
      });
      const set = symmetryEngine.makeOptions(spec, answer, optionsSeed);
      expect(set.choices).toHaveLength(4);
      expect(
        set.choices.filter((choice) =>
          symmetryEngine.verifyAnswer(spec, choice.value),
        ),
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

describe("symmetry engine contract and registry", () => {
  it("keeps the answer out of the generated spec", () => {
    const generated = symmetryEngine.generateSpec(SEED_A, 3);
    expect(Object.keys(generated).sort()).toEqual(["axis", "cells"]);
    expect(symmetryEngine.generateSpec(SEED_A, 3)).toEqual(generated);
    expect(() =>
      SymmetrySpecSchema.parse({ ...generated, answer: answerOf(generated) }),
    ).toThrow();
  });

  it("returns deterministic valid mutations", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const mutations = symmetryEngine.testMutations(vertical);
    expect(mutations.map((mutation) => mutation.id)).toEqual([
      "transposed-axis",
      "altered-known-half",
    ]);
    expect(symmetryEngine.testMutations(vertical)).toEqual(mutations);
    const transposed = mutations[0]?.spec;
    const altered = mutations[1]?.spec;
    if (transposed === undefined || altered === undefined) {
      throw new Error("expected symmetry mutations");
    }
    expect(() => SymmetrySpecSchema.parse(transposed)).not.toThrow();
    expect(() => SymmetrySpecSchema.parse(altered)).not.toThrow();
    expect(transposed.axis).toBe("horizontal");
    expect(deepEqual(transposed, vertical)).toBe(false);
    expect(deepEqual(altered, vertical)).toBe(false);
  });

  it("exposes explicit rules, observation facts, and registry registration", () => {
    const vertical = makeSpec("vertical", VERTICAL_OCCUPIED);
    const rules = symmetryEngine.visibleRules(vertical);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain).toContain("4 to 10");
    expect(rules.closedWorld).toContain("reflection");
    expect(rules.operations.join(" ")).toContain("left half");
    expect(rules.conventions.join(" ")).toContain("Unknown gray");
    expect(ruleFacts(rules).map((fact) => fact.factId)).toEqual([
      "r-domain",
      "r-closed",
      "r-target",
      "r-operations",
      "r-conventions",
    ]);
    const facts = symmetryEngine.facts(vertical);
    expect(facts.map((fact) => fact.factId)).toEqual([
      "p001",
      "p002",
      "p003",
      "p004",
      "p005",
      "p006",
    ]);
    expect(facts[0]?.text).toContain("row 1, column 1");
    expect(facts[4]?.text).toContain("axis is vertical");
    expect(facts[5]?.text).toContain("right half is unknown");
    expect(productionRegistry.listEngineFamilies()).toContain("symmetry");
    expect(productionRegistry.getEngine("symmetry").modality).toBe("svg");
    expect(productionRegistry.hasRenderer("symmetry")).toBe(false);
    expect(productionRegistry.listRendererFamilies()).not.toContain("symmetry");
  });
});
