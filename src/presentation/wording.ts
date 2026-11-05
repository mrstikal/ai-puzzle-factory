import type { Family, Modality } from "../domain/experiment.js";
import {
  WordingBundleSchema,
  WordingResponseSchema,
  type WordingBundle,
  type WordingExplanationStep,
  type WordingResponse,
} from "../domain/presentation.js";
import type { Fact, VisibleRules } from "../families/contracts.js";

export {
  WordingBundleSchema,
  WordingClueSchema,
  WordingExplanationStepSchema,
  WordingResponseSchema,
  WordingSourceSchema,
  WORDING_SOURCES,
} from "../domain/presentation.js";
export type {
  WordingBundle,
  WordingClue,
  WordingExplanationStep,
  WordingResponse,
  WordingSource,
} from "../domain/presentation.js";

export interface WordingEngine<S> {
  readonly family: Family;
  readonly modality: Modality;
  visibleRules(spec: S): VisibleRules;
  facts(spec: S): readonly Fact[];
}

export interface FixtureWordingOverrides {
  readonly question?: string;
  readonly hint?: string;
  readonly explanationSteps?: readonly WordingExplanationStep[];
}

export function makeFixtureWording<S>(
  engine: WordingEngine<S>,
  spec: S,
  overrides: FixtureWordingOverrides = {},
): WordingBundle {
  const rules = engine.visibleRules(spec);
  const facts = engine.facts(spec);
  const response: WordingResponse = WordingResponseSchema.parse({
    question: overrides.question ?? rules.target,
    clueTexts:
      engine.modality === "text"
        ? facts.map((fact) => ({ factId: fact.factId, text: fact.text }))
        : [],
    hint: overrides.hint ?? "Use the stated rules.",
    explanationSteps: overrides.explanationSteps ?? [],
  });
  return WordingBundleSchema.parse({ source: "fixture", response });
}
