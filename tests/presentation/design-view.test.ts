import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
} from "../../src/domain/experiment.js";
import {
  DESIGNER_SKIN_THEME_LABELS,
  designerSkinEntityIdsForSpec,
  type PresentationSkin,
} from "../../src/domain/design.js";
import type { FamilySpec, FamilySpecByFamily } from "../../src/domain/spec.js";
import {
  ruleFacts,
  type Fact,
} from "../../src/families/contracts.js";
import { productionRegistry } from "../../src/families/registry.js";
import {
  DESIGN_TEMPLATE_VERSION,
  FAMILY_TITLES,
  buildDesignWording,
} from "../../src/presentation/templates.js";
import {
  FORCED_OUTPUT_OPERATIONS,
  ProofTraceError,
  assertHintNonSpoiling,
  assertProofTrace,
} from "../../src/presentation/explain.js";
import {
  DesignViewError,
  DesignViewSchema,
  assertDesignView,
  buildDesignView,
  renderDesignViewGallery,
  toPublicDesignView,
} from "../../src/presentation/design-view.js";

const SEED = "a".repeat(64);
const CHOICES_SEED = "b".repeat(64);

function buildInput(
  family: keyof typeof MODALITY_BY_FAMILY,
  difficulty: 1 | 2 | 3 = 1,
  specOverride?: unknown,
) {
  const engine = productionRegistry.getEngine(family);
  const spec = specOverride ?? engine.generateSpec(SEED, difficulty);
  const solveResult = engine.enumerateSolutions(spec);
  if (solveResult.correctAnswer === null) {
    throw new Error(`no answer for ${family}`);
  }
  const choices = engine.makeOptions(spec, solveResult.correctAnswer, CHOICES_SEED);
  return {
    viewId: `design-${MODALITY_BY_FAMILY[family]}-${family}-01-ai_one_shot`,
    engine,
    spec,
    solveResult,
    choices,
    difficulty,
    choicesSeed: CHOICES_SEED,
  };
}

function viewFor(
  family: keyof typeof MODALITY_BY_FAMILY,
  difficulty: 1 | 2 | 3 = 1,
  specOverride?: unknown,
) {
  const input = buildInput(family, difficulty, specOverride);
  return { ...input, built: buildDesignView(input) };
}

function expectProofError(
  operation: () => unknown,
  code: ProofTraceError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ProofTraceError);
    expect((error as ProofTraceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProofTraceError ${code}`);
}

function expectDesignError(
  operation: () => unknown,
  code: DesignViewError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DesignViewError);
    expect((error as DesignViewError).code).toBe(code);
    return;
  }
  throw new Error(`expected DesignViewError ${code}`);
}

function allFactIds(facts: readonly Fact[]): string[] {
  return facts.map((fact) => fact.factId);
}

describe("P49 deterministic design view", () => {
  it("builds deterministic code-owned views for all ten families", () => {
    for (const family of FAMILIES) {
      const first = viewFor(family);
      const second = viewFor(family);
      expect(second.built.view).toEqual(first.built.view);
      expect(second.built.view.certificate.certificateHash).toBe(
        first.built.view.certificate.certificateHash,
      );
      expect(first.built.view.visible.title).toContain(FAMILY_TITLES[family]);
      expect(first.built.view.visible.question).toBe(
        first.engine.visibleRules(first.spec).target,
      );
      expect(first.built.view.visible.options).toHaveLength(4);
      expect(
        new Set(first.built.view.visible.options.map((option) => option.text))
          .size,
      ).toBe(4);
      expect(first.built.view.reveal.proofTrace.steps).toHaveLength(2);
      expect(first.built.view.reveal.proofTrace.hintKind).toBe("strategy");
      expect(first.built.view.templateVersion).toBe(DESIGN_TEMPLATE_VERSION);
      expect(first.built.view.wordingSource).toBe("fixture");
      expect(first.built.view.neutralLabels.length).toBeGreaterThan(0);
      if (family === "ranking") {
        expect(
          first.built.view.neutralLabels.map((entry) => entry.entityId),
        ).not.toContain("item-4");
      }
      if (family === "truth") {
        expect(
          first.built.view.neutralLabels.map((entry) => entry.entityId),
        ).not.toContain("person-3");
      }
      if (family === "matching") {
        expect(
          first.built.view.neutralLabels.map((entry) => entry.label),
        ).toEqual([
          "A1",
          "A2",
          "A3",
          "A4",
          "B1",
          "B2",
          "B3",
          "B4",
          "C1",
          "C2",
          "C3",
          "C4",
        ]);
      }
      if (family === "counting") {
        expect(
          first.built.view.neutralLabels.map((entry) => entry.label),
        ).toEqual(["A", "B"]);
      }
      if (family === "transforms") {
        expect(
          first.built.view.neutralLabels.map((entry) => entry.label),
        ).toEqual(["Tile", "op0"]);
      }
      if (family === "paths") {
        expect(
          first.built.view.neutralLabels.map((entry) => entry.label),
        ).toEqual(["S", "G"]);
      }
      expect(first.built.view.checks.semanticAlignment).toBe(
        "semantic_alignment_pending",
      );
      if (MODALITY_BY_FAMILY[family] === "text") {
        expect(first.built.view.visible.clues.length).toBe(
          first.engine.facts(first.spec).length,
        );
        expect(first.built.svg).toBeNull();
        expect(first.built.view.reveal.proofTrace.steps[0]?.deduction.kind).toBe(
          "domain_survivors",
        );
      } else {
        expect(first.built.view.visible.clues).toEqual([]);
        expect(first.built.svg).not.toBeNull();
        expect(first.built.view.reveal.proofTrace.steps[0]?.deduction.kind).toBe(
          "forced_output",
        );
        expect(first.built.view.certificate.previewPngHash).not.toBeNull();
      }
      assertDesignView({
        view: first.built.view,
        engine: first.engine,
        spec: first.spec,
        solveResult: first.solveResult,
        choices: first.choices,
        difficulty: first.difficulty,
      });
    }
  });

  it("covers every operator, polarity, and nesting through code-owned facts", () => {
    const rankingSpec: FamilySpecByFamily["ranking"] = {
      size: 4,
      clues: [
        { kind: "before", before: 0, after: 1 },
        { kind: "immediatelyBefore", before: 1, after: 2 },
        { kind: "at", item: 2, position: 3 },
        { kind: "notAt", item: 3, position: 3 },
      ],
    };
    const rankingWording = buildDesignWording({
      engine: productionRegistry.getEngine("ranking"),
      spec: rankingSpec,
      difficulty: 1,
      explanationSteps: [],
    });
    const rankingText = rankingWording.wording.response.clueTexts
      .map((clue) => clue.text)
      .join(" ");
    expect(rankingText).toContain("left of");
    expect(rankingText).toContain("immediately");
    expect(rankingText).toContain("position");
    expect(rankingText).toContain("not");

    const matchingSpec: FamilySpecByFamily["matching"] = {
      clues: [
        { kind: "same", left: { category: "A", item: 0 }, right: { category: "B", item: 0 } },
        { kind: "different", left: { category: "A", item: 1 }, right: { category: "B", item: 1 } },
        { kind: "same", left: { category: "A", item: 2 }, right: { category: "C", item: 2 } },
        { kind: "different", left: { category: "B", item: 3 }, right: { category: "C", item: 3 } },
      ],
    };
    const matchingText = buildDesignWording({
      engine: productionRegistry.getEngine("matching"),
      spec: matchingSpec,
      difficulty: 1,
      explanationSteps: [],
    }).wording.response.clueTexts.map((clue) => clue.text).join(" ");
    expect(matchingText).toContain("same");
    expect(matchingText).toContain("not in the same row");

    const schedulingSpec: FamilySpecByFamily["scheduling"] = {
      clues: [
        { kind: "at", event: 0, slot: 1 },
        { kind: "notAt", event: 1, slot: 1 },
        { kind: "before", before: 0, after: 2 },
        { kind: "immediatelyBefore", before: 1, after: 3 },
        { kind: "usesResource", event: 0, resource: 0 },
        { kind: "notResource", event: 2, resource: 0 },
      ],
    };
    const schedulingText = buildDesignWording({
      engine: productionRegistry.getEngine("scheduling"),
      spec: schedulingSpec,
      difficulty: 1,
      explanationSteps: [],
    }).wording.response.clueTexts.map((clue) => clue.text).join(" ");
    expect(schedulingText).toContain("slot");
    expect(schedulingText).toContain("before");
    expect(schedulingText).toContain("immediately");
    expect(schedulingText).toContain("uses R1");
    expect(schedulingText).toContain("does not use R1");

    const truthSpec: FamilySpecByFamily["truth"] = {
      people: 4,
      exactTruthful: 2,
      statements: [
        {
          kind: "xor",
          left: { kind: "not", operand: { kind: "truthful", person: 0 } },
          right: {
            kind: "or",
            left: { kind: "truthful", person: 1 },
            right: { kind: "truthful", person: 2 },
          },
        },
        {
          kind: "and",
          left: { kind: "truthful", person: 0 },
          right: { kind: "not", operand: { kind: "truthful", person: 3 } },
        },
        { kind: "truthful", person: 1 },
        { kind: "not", operand: { kind: "truthful", person: 2 } },
      ],
    };
    const truthText = buildDesignWording({
      engine: productionRegistry.getEngine("truth"),
      spec: truthSpec,
      difficulty: 1,
      explanationSteps: [],
    }).wording.response.clueTexts.map((clue) => clue.text).join(" ");
    expect(truthText).toContain("xor(");
    expect(truthText).toContain("not(");
    expect(truthText).toContain("and(");
    expect(truthText).toContain("or(");

    const arithmeticSpec: FamilySpecByFamily["arithmetic"] = {
      allDifferent: false,
      constraints: [
        { coeffs: [-1, 2, 0], op: "eq", constant: -3 },
        { coeffs: [0, 0, 1], op: "le", constant: 5 },
      ],
    };
    const arithmeticText = buildDesignWording({
      engine: productionRegistry.getEngine("arithmetic"),
      spec: arithmeticSpec,
      difficulty: 1,
      explanationSteps: [],
    }).wording.response.clueTexts.map((clue) => clue.text).join(" ");
    expect(arithmeticText).toContain("(-1)*x");
    expect(arithmeticText).toContain("(2)*y");
    expect(arithmeticText).toContain("= (-3)");
    expect(arithmeticText).toContain("<=");

    const arithmeticLt: FamilySpecByFamily["arithmetic"] = {
      allDifferent: true,
      constraints: [
        { coeffs: [1, 0, 0], op: "lt", constant: 3 },
        { coeffs: [0, 1, 0], op: "eq", constant: 2 },
      ],
    };
    const arithmeticLtWording = buildDesignWording({
      engine: productionRegistry.getEngine("arithmetic"),
      spec: arithmeticLt,
      difficulty: 1,
      explanationSteps: [],
    });
    const arithmeticLtText = arithmeticLtWording.wording.response.clueTexts
      .map((clue) => clue.text)
      .join(" ");
    expect(arithmeticLtText).toContain(" < ");
    expect(arithmeticLtWording.wording.response.question).toContain(
      "unique integer tuple",
    );
    expect(
      arithmeticLtWording.wording.response.explanationSteps,
    ).toHaveLength(0);
    const arithmeticLtRules = productionRegistry
      .getEngine("arithmetic")
      .visibleRules(arithmeticLt);
    expect(arithmeticLtRules.closedWorld).toContain("pairwise distinct");
    expect(arithmeticLtRules.conventions.join(" ")).toContain(
      "allDifferent is true",
    );
  });

  it("keeps exact fact coverage and leaks no answer before reveal", () => {
    const truth = viewFor("truth");
    const localFacts = truth.engine.facts(truth.spec);
    expect(allFactIds(localFacts)).toEqual(
      truth.built.view.visible.clues.map((clue) => clue.factId),
    );
    const inventory = [
      ...ruleFacts(truth.engine.visibleRules(truth.spec)),
      ...localFacts,
    ].map((fact) => fact.factId);
    for (const step of truth.built.view.reveal.explanationSteps) {
      for (const factId of step.factIds) {
        expect(inventory).toContain(factId);
      }
    }
    const publicView = toPublicDesignView(truth.built.view);
    expect(publicView).not.toHaveProperty("reveal");
    expect(publicView).not.toHaveProperty("correctLabel");
    expect(publicView).not.toHaveProperty("correctValue");
    expect(publicView).not.toHaveProperty("hint");
    expect(publicView).not.toHaveProperty("explanationSteps");
    expect(publicView).not.toHaveProperty("proofTrace");
    const publicText = JSON.stringify(publicView);
    expect(publicText).not.toContain("correctValue");
    expect(publicText).not.toContain("proofTrace");
  });

  it("verifies proof entailment, references, fallback, and unique final answer", () => {
    const ranking = viewFor("ranking");
    const trace = ranking.built.view.reveal.proofTrace;
    expect(
      assertProofTrace({
        trace,
        engine: ranking.engine,
        spec: ranking.spec,
        solveResult: ranking.solveResult,
      }),
    ).toEqual(trace);
    expect(trace.steps[0]?.deduction.kind).toBe("domain_survivors");
    expect(trace.steps[1]?.deduction.kind).toBe("complete_answer");
    expect(trace.finalAnswerHash).toBe(
      trace.steps[1]?.deduction.kind === "complete_answer"
        ? trace.steps[1].deduction.answerHash
        : "",
    );
    expect(trace.hintKind).toBe("strategy");
    expect(() =>
      assertHintNonSpoiling(
        trace,
        ranking.built.view.visible.options.map((option) => option.text),
        ranking.built.view.reveal.correctLabel,
      ),
    ).not.toThrow();

    const subset = structuredClone(trace) as unknown as {
      steps: Array<{ premiseFactIds: string[] }>;
    };
    subset.steps[0]!.premiseFactIds = [subset.steps[0]!.premiseFactIds[0]!];
    expectProofError(
      () =>
        assertProofTrace({
          trace: subset,
          engine: ranking.engine,
          spec: ranking.spec,
          solveResult: ranking.solveResult,
        }),
      "MISSING_PREMISE",
    );

    const circular = structuredClone(trace) as unknown as {
      steps: Array<{ priorStepIds: string[] }>;
    };
    circular.steps[1]!.priorStepIds = ["s002"];
    expectProofError(
      () =>
        assertProofTrace({
          trace: circular,
          engine: ranking.engine,
          spec: ranking.spec,
          solveResult: ranking.solveResult,
        }),
      "CIRCULAR_REFERENCE",
    );

    const forward = structuredClone(trace) as unknown as {
      steps: Array<{ priorStepIds: string[] }>;
    };
    forward.steps[1]!.priorStepIds = ["s003"];
    expectProofError(
      () =>
        assertProofTrace({
          trace: forward,
          engine: ranking.engine,
          spec: ranking.spec,
          solveResult: ranking.solveResult,
        }),
      "FORWARD_REFERENCE",
    );

    const wrongAnswer = structuredClone(trace) as unknown as {
      steps: Array<{ deduction: { answerHash?: string } }>;
    };
    wrongAnswer.steps[0]!.deduction.answerHash = "c".repeat(64);
    expectProofError(
      () =>
        assertProofTrace({
          trace: wrongAnswer,
          engine: ranking.engine,
          spec: ranking.spec,
          solveResult: ranking.solveResult,
        }),
      "WRONG_ANSWER",
    );

    const spoiling = structuredClone(trace) as unknown as {
      hint: string;
    };
    spoiling.hint = ranking.built.view.visible.options[0]?.text ?? "A";
    expectProofError(
      () =>
        assertHintNonSpoiling(
          spoiling as never,
          ranking.built.view.visible.options.map((option) => option.text),
          ranking.built.view.reveal.correctLabel,
        ),
      "SPOILING_HINT",
    );

    const matrix = viewFor("matrix");
    const matrixTrace = matrix.built.view.reveal.proofTrace;
    expect(matrixTrace.steps[0]?.deduction.kind).toBe("forced_output");
    expect(
      matrixTrace.steps[0]?.deduction.kind === "forced_output"
        ? matrixTrace.steps[0].deduction.operation
        : null,
    ).toBe(FORCED_OUTPUT_OPERATIONS.matrix);
  });

  it("binds spec, template, proof trace, choices, and assets in the certificate", () => {
    const ranking = viewFor("ranking");
    const view = ranking.built.view;
    expect(assertDesignView({ view })).toEqual(view);
    const templateTamper = structuredClone(view) as unknown as {
      certificate: { templateHash: string };
    };
    templateTamper.certificate.templateHash = "c".repeat(64);
    expect(DesignViewSchema.safeParse(templateTamper).success).toBe(false);
    const proofTamper = structuredClone(view) as unknown as {
      reveal: { proofTrace: { steps: Array<{ text: string }> } };
    };
    proofTamper.reveal.proofTrace.steps[0]!.text = "tampered step text";
    expect(DesignViewSchema.safeParse(proofTamper).success).toBe(false);
    const labelTamper = structuredClone(view) as unknown as {
      certificate: { correctLabel: string };
    };
    labelTamper.certificate.correctLabel =
      view.reveal.correctLabel === "A" ? "B" : "A";
    expect(DesignViewSchema.safeParse(labelTamper).success).toBe(false);
    const revealTextTamper = structuredClone(view) as unknown as {
      reveal: { explanationSteps: Array<{ text: string }> };
    };
    revealTextTamper.reveal.explanationSteps[0]!.text = "tampered explanation";
    expect(DesignViewSchema.safeParse(revealTextTamper).success).toBe(false);
    const revealValueTamper = structuredClone(view) as unknown as {
      reveal: { correctValue: unknown };
    };
    revealValueTamper.reveal.correctValue = "tampered answer";
    expect(DesignViewSchema.safeParse(revealValueTamper).success).toBe(false);
    const revealHintTamper = structuredClone(view) as unknown as {
      reveal: { hint: string };
    };
    revealHintTamper.reveal.hint = "tampered hint";
    expect(DesignViewSchema.safeParse(revealHintTamper).success).toBe(false);
    const clueTamper = structuredClone(view) as unknown as {
      visible: { clues: Array<{ text: string }> };
    };
    clueTamper.visible.clues[0]!.text = "tampered clue";
    expect(DesignViewSchema.safeParse(clueTamper).success).toBe(false);
    const optionTamper = structuredClone(view) as unknown as {
      visible: { options: Array<{ text: string }> };
    };
    optionTamper.visible.options[0]!.text = "tampered option";
    expect(DesignViewSchema.safeParse(optionTamper).success).toBe(false);
    const labelSetTamper = structuredClone(view) as unknown as {
      neutralLabels: Array<{ label: string }>;
    };
    labelSetTamper.neutralLabels[0]!.label = "tampered";
    expect(DesignViewSchema.safeParse(labelSetTamper).success).toBe(false);

    const matrix = viewFor("matrix");
    const assetTamper = structuredClone(matrix.built.view) as unknown as {
      visible: { assets: { svgHash: string } };
    };
    assetTamper.visible.assets.svgHash = "d".repeat(64);
    expect(DesignViewSchema.safeParse(assetTamper).success).toBe(false);
  });

  it("keeps neutral skin stability and rejects invalid skins", () => {
    const ranking = buildInput("ranking");
    const neutral = buildDesignView(ranking);
    const entityIds = designerSkinEntityIdsForSpec(
      "ranking",
      ranking.spec as FamilySpec,
    );
    const labels = DESIGNER_SKIN_THEME_LABELS.garden;
    const skin: PresentationSkin = {
      theme: "garden",
      labels: entityIds.map((entityId, index) => {
        const label = labels[index];
        if (label === undefined) {
          throw new Error("missing neutral skin label");
        }
        return { entityId, label };
      }),
    };
    const skinned = buildDesignView({ ...ranking, skin });
    expect(skinned.view.visible).toEqual(neutral.view.visible);
    expect(skinned.view.reveal).toEqual(neutral.view.reveal);
    expect(skinned.view.certificate).toEqual(neutral.view.certificate);
    expect(skinned.view.skin).toEqual(skin);
    expect(neutral.view.checks.skin).toBe("not_applicable");
    expect(skinned.view.checks.skin).toBe("pass");
    expect(skinned.view.reveal.correctValue).toEqual(
      neutral.view.reveal.correctValue,
    );
    expect(skinned.view.visible.options).toEqual(neutral.view.visible.options);

    const missing = {
      ...skin,
      labels: skin.labels.slice(0, -1),
    };
    expectDesignError(
      () => buildDesignView({ ...ranking, skin: missing }),
      "INVALID_SKIN",
    );
    const extra = {
      ...skin,
      extra: "not allowed",
    } as unknown as PresentationSkin;
    expectDesignError(
      () => buildDesignView({ ...ranking, skin: extra }),
      "INVALID_SKIN",
    );
  });

  it("escapes hostile labels and renders a text/SVG gallery", () => {
    const text = viewFor("ranking");
    const svg = viewFor("matrix");
    const gallery = renderDesignViewGallery([text.built, svg.built]);
    expect(gallery).toContain("Order the Items");
    expect(gallery).toContain("Complete the XOR Matrix");
    expect(gallery).toContain("<svg");
    expect(gallery).toContain("Reveal (gallery only)");
    expect(gallery).toContain("Operations");
    expect(gallery).toContain("Conventions");
    expect(gallery).toContain("Positions are 1-based");
    const hostile = structuredClone(text.built) as unknown as {
      view: { visible: { title: string } };
    };
    hostile.view.visible.title = "<script>alert(1)</script>";
    const hostileGallery = renderDesignViewGallery([hostile as never]);
    expect(hostileGallery).not.toContain("<script>alert(1)</script>");
    expect(hostileGallery).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("manual inspection: text and SVG design view gallery", () => {
    const text = viewFor("ranking");
    const svg = viewFor("matrix");
    const gallery = renderDesignViewGallery([text.built, svg.built]);
    const galleryPath = join(tmpdir(), "p49-design-view-gallery.html");
    writeFileSync(galleryPath, gallery, "utf8");
    console.log(
      JSON.stringify(
        {
          kind: "p49_manual_inspection",
          galleryPath,
          text: {
            title: text.built.view.visible.title,
            question: text.built.view.visible.question,
            clues: text.built.view.visible.clues.map((clue) => clue.text),
            options: text.built.view.visible.options.map(
              (option) => `${option.label}: ${option.text}`,
            ),
            hint: text.built.view.reveal.hint,
            steps: text.built.view.reveal.explanationSteps.map(
              (step) => step.text,
            ),
          },
          svg: {
            title: svg.built.view.visible.title,
            question: svg.built.view.visible.question,
            options: svg.built.view.visible.options.map(
              (option) => `${option.label}: ${option.text}`,
            ),
            hint: svg.built.view.reveal.hint,
            steps: svg.built.view.reveal.explanationSteps.map(
              (step) => step.text,
            ),
            svgLength: svg.built.svg?.length ?? 0,
          },
        },
        null,
        2,
      ),
    );
    expect(gallery).toContain("<svg");
    expect(text.built.view.wordingSource).toBe("fixture");
    expect(svg.built.view.wordingSource).toBe("fixture");
  });

  it("builds non-baseline specs and makes no AI wording or reviewer call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rankingSpec: FamilySpecByFamily["ranking"] = {
      size: 4,
      clues: [
        { kind: "at", item: 1, position: 2 },
        { kind: "notAt", item: 1, position: 4 },
        { kind: "before", before: 0, after: 2 },
        { kind: "notAt", item: 0, position: 4 },
        { kind: "notAt", item: 0, position: 1 },
      ],
    };
    const countingShape = (
      indices: readonly number[],
    ): FamilySpecByFamily["counting"]["shapes"][number] => ({
      cells: indices.map((index) => ({
        row: Math.floor(index / 5),
        column: index % 5,
      })),
    });
    const countingSpec: FamilySpecByFamily["counting"] = {
      shapes: [
        countingShape([1, 6, 7, 8]),
        countingShape([2, 6, 7, 8]),
        countingShape([3, 6, 7, 8]),
      ],
      query: { operation: "exactlyKShapes", k: 3 },
    };
    const nonBaselineText = viewFor("ranking", 1, rankingSpec);
    const nonBaselineSvg = viewFor("counting", 3, countingSpec);
    expect(nonBaselineText.built.view.visible.clues.length).toBe(5);
    expect(nonBaselineSvg.built.view.visible.clues).toEqual([]);
    expect(nonBaselineSvg.built.svg).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
