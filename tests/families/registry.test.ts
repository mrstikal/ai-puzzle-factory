import { describe, expect, it } from "vitest";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
  SVG_FAMILIES,
  type Difficulty,
  type Family,
  type SvgFamily,
} from "../../src/domain/experiment.js";
import {
  FAMILY_SPEC_SCHEMAS,
  FamilySpecEnvelopeSchema,
  familySpecSchemaFor,
  parseFamilySpec,
  parseFamilySpecEnvelope,
  safeParseFamilySpecEnvelope,
} from "../../src/domain/spec.js";
import {
  SolveResultSchema,
  VisibleRulesSchema,
  mergeFactInventory,
  ruleFacts,
} from "../../src/families/contracts.js";
import { productionRegistry } from "../../src/families/registry.js";
import { SCENE_SIZE, assertScene, type Scene } from "../../src/render/scene.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const FIXTURE_INDEX_BY_DIFFICULTY: Readonly<Record<Difficulty, number>> = {
  1: 1,
  2: 35,
  3: 68,
};

function fixtureSeed(family: Family, difficulty: Difficulty): string {
  return deriveStreamSeed({
    protocolVersion: "1.0.0",
    rootSeed: "puzzle-poc-v1",
    slotId: `${family}-fixture-${String(FIXTURE_INDEX_BY_DIFFICULTY[difficulty]).padStart(3, "0")}`,
    purpose: "spec",
  });
}

describe("complete family registry gate", () => {
  it("contains all ten formal engines and all five real SVG renderers", () => {
    expect(() => productionRegistry.assertComplete({ requireRenderers: true })).not.toThrow();
    expect(productionRegistry.listEngineFamilies()).toEqual([...FAMILIES]);
    expect(productionRegistry.listRendererFamilies()).toEqual([...SVG_FAMILIES]);
    for (const family of FAMILIES) {
      const engine = productionRegistry.getEngine(family);
      expect(engine.family).toBe(family);
      expect(engine.modality).toBe(MODALITY_BY_FAMILY[family]);
      expect(typeof engine.schema.parse).toBe("function");
      if (MODALITY_BY_FAMILY[family] === "text") {
        expect(productionRegistry.hasRenderer(family as SvgFamily)).toBe(false);
      }
    }
  });

  it("generates, solves, option-builds, fingerprints, and mutates every family at every difficulty", () => {
    const difficulties: readonly Difficulty[] = [1, 2, 3];
    for (const family of FAMILIES) {
      const engine = productionRegistry.getEngine(family);
      for (const difficulty of difficulties) {
        const seed = fixtureSeed(family, difficulty);
        const spec = engine.generateSpec(seed, difficulty);
        expect(engine.generateSpec(seed, difficulty)).toEqual(spec);
        expect(engine.schema.safeParse(spec).success).toBe(true);
        expect(parseFamilySpec(family, spec)).toEqual(spec);
        expect(
          FamilySpecEnvelopeSchema.parse({ family, spec }),
        ).toEqual({ family, spec });

        const rules = engine.visibleRules(spec);
        expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
        expect(rules.domain.trim().length).toBeGreaterThan(0);
        expect(rules.closedWorld.trim().length).toBeGreaterThan(0);
        expect(rules.target.trim().length).toBeGreaterThan(0);
        expect(rules.operations.length).toBeGreaterThan(0);

        const facts = engine.facts(spec);
        expect(facts.length).toBeGreaterThan(0);
        const inventory = mergeFactInventory(ruleFacts(rules), facts);
        expect(inventory).toHaveLength(facts.length + 5);

        const result = engine.enumerateSolutions(spec);
        expect(() => SolveResultSchema.parse(result)).not.toThrow();
        expect(result.solutionCount).toBe(1);
        expect(result.answerCount).toBe(1);
        expect(result.correctAnswer).not.toBeNull();
        expect(result.proof).not.toBeNull();
        expect(result.checkerVersion.trim().length).toBeGreaterThan(0);
        if (result.correctAnswer !== null) {
          expect(engine.verifyAnswer(spec, result.correctAnswer)).toBe(true);
        }

        const options = engine.makeOptions(spec, result.correctAnswer, seed);
        expect(options.choices).toHaveLength(4);
        expect(options.choices.map((choice) => choice.label)).toEqual([
          "A",
          "B",
          "C",
          "D",
        ]);
        expect(
          new Set(options.choices.map((choice) => JSON.stringify(choice.value))).size,
        ).toBe(4);
        expect(
          options.choices.filter((choice) => engine.verifyAnswer(spec, choice.value)),
        ).toHaveLength(1);

        const canonical = engine.canonicalData(spec);
        expect(canonical.family).toBe(family);
        expect(canonical.domainTokens.length).toBeGreaterThan(0);

        const mutations = engine.testMutations(spec);
        expect(mutations.length).toBeGreaterThan(0);
        for (const mutation of mutations) {
          expect(mutation.id.trim().length).toBeGreaterThan(0);
          expect(mutation.description.trim().length).toBeGreaterThan(0);
          expect(mutation.spec).not.toEqual(spec);
          expect(engine.schema.safeParse(mutation.spec).success).toBe(true);
        }
      }
    }
  });

  it("builds a valid 1024x1024 scene through every registered SVG renderer", () => {
    for (const family of SVG_FAMILIES) {
      const engine = productionRegistry.getEngine(family);
      const renderer = productionRegistry.getRenderer(family);
      expect(renderer.family).toBe(family);
      expect(renderer.version.trim().length).toBeGreaterThan(0);
      for (const difficulty of [1, 2, 3] as const) {
        const spec = engine.generateSpec(fixtureSeed(family, difficulty), difficulty);
        const scene = renderer.buildScene(spec) as Scene;
        expect(scene.width).toBe(SCENE_SIZE);
        expect(scene.height).toBe(SCENE_SIZE);
        expect(scene.title.trim().length).toBeGreaterThan(0);
        expect(scene.desc.trim().length).toBeGreaterThan(0);
        expect(() => assertScene(scene)).not.toThrow();
      }
    }
  });

  it("exposes one strict validated spec schema per family without accepting a foreign spec", () => {
    expect(Object.keys(FAMILY_SPEC_SCHEMAS).sort()).toEqual([...FAMILIES].sort());
    for (const family of FAMILIES) {
      const engine = productionRegistry.getEngine(family);
      const spec = engine.generateSpec(fixtureSeed(family, 1), 1);
      expect(() => familySpecSchemaFor(family).parse(spec)).not.toThrow();
      const envelope = parseFamilySpecEnvelope({ family, spec });
      expect(envelope.family).toBe(family);
      expect(envelope.spec).toEqual(spec);
    }
    const rankingSpec = productionRegistry
      .getEngine("ranking")
      .generateSpec(fixtureSeed("ranking", 1), 1);
    expect(() =>
      FamilySpecEnvelopeSchema.parse({ family: "matching", spec: rankingSpec }),
    ).toThrow();
    expect(() =>
      FamilySpecEnvelopeSchema.parse({ family: "unknown", spec: rankingSpec }),
    ).toThrow();
    expect(() =>
      FamilySpecEnvelopeSchema.parse({ family: "ranking", spec: rankingSpec, extra: true }),
    ).toThrow();
    expect(safeParseFamilySpecEnvelope(rankingSpec).success).toBe(false);
    expect(() => familySpecSchemaFor("unknown" as Family)).toThrow(RangeError);
  });
});
