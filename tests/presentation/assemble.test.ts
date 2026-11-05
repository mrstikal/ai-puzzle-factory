import { describe, expect, it } from "vitest";
import {
  type ChoiceLabel,
  type ChoiceSet,
} from "../../src/domain/answers.js";
import {
  FAMILIES,
  type Family,
} from "../../src/domain/experiment.js";
import {
  AssembledPresentationSchema,
  WordingBundleSchema,
  type WordingResponse,
} from "../../src/domain/presentation.js";
import { productionRegistry } from "../../src/families/registry.js";
import {
  assemblePresentation,
  fingerprintContentFor,
} from "../../src/presentation/assemble.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import { computeContentHash } from "../../src/validation/fingerprints.js";
import {
  PresentationError,
  assertAssembledPresentation,
  assertVisiblePresentation,
  type PresentationErrorCode,
} from "../../src/validation/presentation.js";
import { sha256Hex } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";

function fixture(family: Family) {
  const engine = productionRegistry.getEngine(family);
  const seed = deriveStreamSeed({
    protocolVersion: "1.0.0",
    rootSeed: "puzzle-poc-v1",
    slotId: `${family}-fixture-001`,
    purpose: "spec",
  });
  const spec = engine.generateSpec(seed, 1);
  const solveResult = engine.enumerateSolutions(spec);
  if (solveResult.correctAnswer === null) {
    throw new Error(`expected a unique ${family} answer`);
  }
  const choices = engine.makeOptions(spec, solveResult.correctAnswer, seed);
  const wording = makeFixtureWording(engine, spec);
  return { engine, seed, spec, solveResult, choices, wording };
}

function assetsFor(family: Family) {
  return {
    svgHash: sha256Hex(`stored-svg:${family}`),
    pngHash: sha256Hex(`stored-png:${family}`),
  };
}

function assemble(
  family: Family,
  overrides: {
    readonly wording?: unknown;
    readonly assets?: unknown;
    readonly slotId?: string;
    readonly choices?: ChoiceSet<unknown>;
  } = {},
) {
  const current = fixture(family);
  return assemblePresentation({
    slotId: overrides.slotId ?? `${current.engine.modality}-${family}-01`,
    engine: current.engine,
    spec: current.spec,
    solveResult: current.solveResult,
    choices: overrides.choices ?? (current.choices as ChoiceSet<unknown>),
    wording: overrides.wording ?? current.wording,
    assets:
      overrides.assets ??
      (current.engine.modality === "svg" ? assetsFor(family) : undefined),
  });
}

function wordingWith(
  base: WordingResponse,
  patch: Partial<WordingResponse>,
): WordingResponse {
  return { ...base, ...patch };
}

function expectPresentationError(
  action: () => unknown,
  code: PresentationErrorCode,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PresentationError);
  expect((caught as PresentationError).code).toBe(code);
}

describe("visible presentation assembly", () => {
  it("assembles every family with code-owned rules, options, and public/reveal separation", () => {
    for (const family of FAMILIES) {
      const current = fixture(family);
      const assembled = assemble(family);
      expect(() => assertAssembledPresentation(assembled)).not.toThrow();
      expect(assembled.visible.family).toBe(family);
      expect(assembled.visible.modality).toBe(current.engine.modality);
      expect(assembled.visible.question).toBe(current.wording.response.question);
      expect(assembled.visible.rules).toEqual(
        current.engine.visibleRules(current.spec),
      );
      expect(assembled.visible.options.map((option) => option.label).join("")).toBe(
        "ABCD",
      );
      expect(
        new Set(assembled.visible.options.map((option) => option.text)).size,
      ).toBe(4);
      expect(assembled.reveal.correctLabel).toBe(current.choices.correctLabel);
      expect(assembled.reveal.correctValue).toEqual(
        current.solveResult.correctAnswer,
      );
      expect(assembled.reveal.proof).not.toBeNull();
      expect(assembled.wordingSource).toBe("fixture");
      expect(assembled.checks.semanticAlignment).toBe(
        "semantic_alignment_pending",
      );
      for (const key of [
        "correctLabel",
        "correctValue",
        "hint",
        "explanationSteps",
        "proof",
        "reveal",
      ]) {
        expect(Object.keys(assembled.visible)).not.toContain(key);
      }
      if (current.engine.modality === "svg") {
        expect(assembled.visible.assets).toEqual(assetsFor(family));
        expect(assembled.visible.clues).toEqual([]);
        for (const option of assembled.visible.options) {
          if (family === "counting") {
            expect(option.text).toMatch(/^\d+$/);
          } else {
            expect(option.text).toBe(`See labeled tile ${option.label}`);
          }
        }
      } else {
        expect(assembled.visible.assets).toEqual({
          svgHash: null,
          pngHash: null,
        });
        expect(assembled.visible.clues.map((clue) => clue.factId)).toEqual(
          current.engine.facts(current.spec).map((fact) => fact.factId),
        );
      }
    }
  });

  it("rejects missing, extra, duplicate, and unknown fact references", () => {
    const current = fixture("ranking");
    const base = current.wording.response;
    const first = base.clueTexts[0];
    if (first === undefined) {
      throw new Error("expected a ranking clue");
    }
    expectPresentationError(
      () =>
        assemble("ranking", {
          wording: WordingBundleSchema.parse({
            source: "fixture",
            response: wordingWith(base, { clueTexts: base.clueTexts.slice(1) }),
          }),
        }),
      "FACT_COVERAGE_MISMATCH",
    );
    expectPresentationError(
      () =>
        assemble("ranking", {
          wording: WordingBundleSchema.parse({
            source: "fixture",
            response: wordingWith(base, {
              clueTexts: [
                ...base.clueTexts,
                { factId: "f999", text: "An extra clue." },
              ],
            }),
          }),
        }),
      "FACT_COVERAGE_MISMATCH",
    );
    expectPresentationError(
      () =>
        assemble("ranking", {
          wording: WordingBundleSchema.parse({
            source: "fixture",
            response: wordingWith(base, {
              clueTexts: [...base.clueTexts, first],
            }),
          }),
        }),
      "FACT_COVERAGE_MISMATCH",
    );
    expectPresentationError(
      () =>
        assemble("ranking", {
          wording: WordingBundleSchema.parse({
            source: "fixture",
            response: wordingWith(base, {
              explanationSteps: [
                { factIds: ["s999"], text: "An unknown proof reference." },
              ],
            }),
          }),
        }),
      "UNKNOWN_FACT_REFERENCE",
    );

    const matrix = fixture("matrix");
    expectPresentationError(
      () =>
        assemble("matrix", {
          wording: WordingBundleSchema.parse({
            source: "fixture",
            response: wordingWith(matrix.wording.response, {
              clueTexts: [{ factId: "f001", text: "A hidden clue." }],
            }),
          }),
        }),
      "UNEXPECTED_CLUE_TEXTS",
    );
  });

  it("enforces every wording length bound and nonblank field", () => {
    const current = fixture("ranking");
    const base = current.wording.response;
    const proofFact = current.solveResult.proof?.facts[0]?.factId ?? "s001";
    const invalid: readonly [string, WordingResponse][] = [
      [
        "question",
        wordingWith(base, { question: "x".repeat(401) }),
      ],
      [
        "clue",
        wordingWith(base, {
          clueTexts: base.clueTexts.map((clue, index) =>
            index === 0 ? { ...clue, text: "x".repeat(201) } : clue,
          ),
        }),
      ],
      ["hint", wordingWith(base, { hint: "x".repeat(301) })],
      [
        "explanation",
        wordingWith(base, {
          explanationSteps: [
            { factIds: [proofFact], text: "x".repeat(241) },
          ],
        }),
      ],
      [
        "clue count",
        wordingWith(base, {
          clueTexts: Array.from({ length: 13 }, (_, index) => ({
            factId: `f${String(index + 1).padStart(3, "0")}`,
            text: "clue",
          })),
        }),
      ],
      [
        "step count",
        wordingWith(base, {
          explanationSteps: Array.from({ length: 9 }, () => ({
            factIds: [proofFact],
            text: "step",
          })),
        }),
      ],
      ["blank", wordingWith(base, { question: "   " })],
    ];
    for (const [label, response] of invalid) {
      expect(
        () =>
          assemble("ranking", {
            wording: { source: "fixture", response },
          }),
        label,
      ).toThrow(PresentationError);
      expectPresentationError(
        () =>
          assemble("ranking", {
            wording: { source: "fixture", response },
          }),
        "INVALID_WORDING",
      );
    }
  });

  it("rejects wrong ordered choices and a wrong stored correct label", () => {
    const current = fixture("ranking");
    const reordered = {
      ...current.choices,
      choices: [
        current.choices.choices[1],
        current.choices.choices[0],
        current.choices.choices[2],
        current.choices.choices[3],
      ],
    } as ChoiceSet<unknown>;
    expectPresentationError(
      () => assemble("ranking", { choices: reordered }),
      "INVALID_OPTION_SET",
    );
    const wrongLabel: ChoiceLabel =
      current.choices.correctLabel === "A" ? "B" : "A";
    expectPresentationError(
      () =>
        assemble("ranking", {
          choices: {
            ...current.choices,
            correctLabel: wrongLabel,
          } as ChoiceSet<unknown>,
        }),
      "INVALID_OPTION_SET",
    );
    expectPresentationError(
      () =>
        assemble("ranking", {
          choices: { choices: [], correctLabel: "A" } as unknown as ChoiceSet<unknown>,
        }),
      "INVALID_OPTION_SET",
    );
    expectPresentationError(
      () =>
        assemblePresentation({
          slotId: "text-ranking-01",
          engine: current.engine,
          spec: current.spec,
          solveResult: current.solveResult,
          choices: null as unknown as ChoiceSet<unknown>,
          wording: current.wording,
        }),
      "INVALID_OPTION_SET",
    );
  });

  it("retains model HTML/script strings as plain text", () => {
    const current = fixture("ranking");
    const base = current.wording.response;
    const first = base.clueTexts[0];
    if (first === undefined) {
      throw new Error("expected a ranking clue");
    }
    const proofFact = current.solveResult.proof?.facts[0]?.factId ?? "s001";
    const question = '<script>alert("question")</script>';
    const clueText = '<img src=x onerror="alert(1)">';
    const hint = "<b>hint</b>";
    const explanationText = "<script>alert('explanation')</script>";
    const assembled = assemble("ranking", {
      wording: WordingBundleSchema.parse({
        source: "model",
        response: wordingWith(base, {
          question,
          clueTexts: base.clueTexts.map((clue, index) =>
            index === 0 ? { ...clue, text: clueText } : clue,
          ),
          hint,
          explanationSteps: [
            { factIds: [proofFact], text: explanationText },
          ],
        }),
      }),
    });
    expect(assembled.wordingSource).toBe("model");
    expect(assembled.visible.question).toBe(question);
    expect(assembled.visible.clues[0]?.text).toBe(clueText);
    expect(assembled.reveal.hint).toBe(hint);
    expect(assembled.reveal.explanationSteps[0]?.text).toBe(explanationText);
    expect(assembled.checks.semanticAlignment).toBe(
      "semantic_alignment_pending",
    );
  });

  it("keeps a same-ID semantic contradiction pending instead of passing it", () => {
    const current = fixture("ranking");
    const base = current.wording.response;
    const first = base.clueTexts[0];
    if (first === undefined) {
      throw new Error("expected a ranking clue");
    }
    const contradictory = assemble("ranking", {
      wording: WordingBundleSchema.parse({
        source: "model",
        response: wordingWith(base, {
          clueTexts: base.clueTexts.map((clue, index) =>
            index === 0
              ? {
                  ...clue,
                  text: "This deliberately contradicts the supplied clue.",
                }
              : clue,
          ),
        }),
      }),
    });
    expect(contradictory.checks.semanticAlignment).toBe(
      "semantic_alignment_pending",
    );
    expect(contradictory.checks).not.toHaveProperty("semanticPass");
    const correctContent = fingerprintContentFor(assemble("ranking"));
    const contradictoryContent = fingerprintContentFor(contradictory);
    expect(computeContentHash(correctContent)).not.toBe(
      computeContentHash(contradictoryContent),
    );
    expect(contradictoryContent.clues[0]?.text).toBe(
      "This deliberately contradicts the supplied clue.",
    );
  });

  it("requires stored SVG/PNG hashes for SVG and rejects hashes for text", () => {
    expectPresentationError(
      () =>
        assemble("matrix", {
          assets: { svgHash: null, pngHash: null },
        }),
      "MISSING_IMAGE_ASSET",
    );
    expectPresentationError(
      () =>
        assemble("matrix", {
          assets: {
            svgHash: assetsFor("matrix").svgHash,
            pngHash: null,
          },
        }),
      "MISSING_IMAGE_ASSET",
    );
    expectPresentationError(
      () =>
        assemble("ranking", {
          assets: assetsFor("ranking"),
        }),
      "UNEXPECTED_IMAGE_ASSET",
    );
  });

  it("accepts proof references and keeps fixture wording deterministic", () => {
    const current = fixture("ranking");
    const proofFact = current.solveResult.proof?.facts[0]?.factId;
    if (proofFact === undefined) {
      throw new Error("expected a ranking proof fact");
    }
    const first = makeFixtureWording(current.engine, current.spec);
    const second = makeFixtureWording(current.engine, current.spec);
    expect(first).toEqual(second);
    expect(first.source).toBe("fixture");
    const assembled = assemble("ranking", {
      wording: WordingBundleSchema.parse({
        source: "fixture",
        response: wordingWith(current.wording.response, {
          explanationSteps: [
            { factIds: [proofFact], text: "The proof fixes the order." },
          ],
        }),
      }),
    });
    expect(assembled.reveal.explanationSteps).toEqual([
      { factIds: [proofFact], text: "The proof fixes the order." },
    ]);
    expect(assembled.checks.semanticAlignment).toBe(
      "semantic_alignment_pending",
    );
  });

  it("rejects a spec that does not satisfy the family schema", () => {
    const current = fixture("ranking");
    expectPresentationError(
      () =>
        assemblePresentation({
          slotId: "text-ranking-01",
          engine: current.engine,
          spec: { size: 4, clues: [] },
          solveResult: current.solveResult,
          choices: current.choices as ChoiceSet<unknown>,
          wording: current.wording,
        }),
      "INVALID_SPEC",
    );
  });

  it("rejects a slot ID that disagrees with the engine family or modality", () => {
    expectPresentationError(
      () => assemble("ranking", { slotId: "text-matrix-01" }),
      "INVALID_SLOT",
    );
    expectPresentationError(
      () => assemble("matrix", { slotId: "text-matrix-01" }),
      "INVALID_SLOT",
    );
  });

  it("uses the typed presentation error taxonomy for re-validated stored data", () => {
    const matrix = assemble("matrix");
    expectPresentationError(
      () => assertVisiblePresentation({ ...matrix.visible, hint: "leak" }),
      "PUBLIC_REVEAL_LEAK",
    );
    expectPresentationError(
      () =>
        assertVisiblePresentation({
          ...matrix.visible,
          clues: [{ factId: "p001", text: "diagram transcription" }],
        }),
      "UNEXPECTED_CLUE_TEXTS",
    );
    expectPresentationError(
      () => assertVisiblePresentation({ version: 1 }),
      "INVALID_PRESENTATION",
    );
    expectPresentationError(
      () =>
        assertAssembledPresentation({
          ...matrix,
          checks: { ...matrix.checks, semanticAlignment: "pass" },
        }),
      "SEMANTIC_ALIGNMENT_CLAIMED",
    );
  });

  it("validates the assembled schema and keeps the public DTO reveal-free", () => {
    const assembled = assemble("counting");
    expect(AssembledPresentationSchema.safeParse(assembled).success).toBe(true);
    expect(
      AssembledPresentationSchema.safeParse({
        ...assembled,
        checks: { ...assembled.checks, semanticAlignment: "pass" },
      }).success,
    ).toBe(false);
    const publicJson = JSON.stringify(assembled.visible);
    expect(publicJson).not.toContain('"correctLabel"');
    expect(publicJson).not.toContain('"correctValue"');
    expect(publicJson).not.toContain('"hint"');
    expect(publicJson).not.toContain('"explanationSteps"');
    expect(publicJson).not.toContain('"proof"');
    expect(["A", "B", "C", "D"]).toContain(assembled.reveal.correctLabel);
  });
});
