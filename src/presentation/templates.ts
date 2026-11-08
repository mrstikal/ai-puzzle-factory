import { z } from "zod";
import type { Family, Modality } from "../domain/experiment.js";
import {
  WordingBundleSchema,
  type WordingBundle,
  type WordingExplanationStep,
} from "../domain/presentation.js";
import type { WordingEngine } from "./wording.js";
import { designerSkinEntityIdsForSpec } from "../domain/design.js";
import type { FamilySpec } from "../domain/spec.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const DESIGN_TEMPLATE_VERSION = "p49-templates-v1" as const;

export const NeutralLabelSchema = z.strictObject({
  entityId: z.string().min(1).max(64),
  label: z.string().min(1).max(32),
});
export type NeutralLabel = z.infer<typeof NeutralLabelSchema>;

export const NeutralLabelSetSchema = z
  .array(NeutralLabelSchema)
  .min(1)
  .max(32)
  .superRefine((labels, ctx) => {
    if (new Set(labels.map((entry) => entry.entityId)).size !== labels.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entityId"],
        message: "neutral entity IDs must be distinct",
      });
    }
    if (new Set(labels.map((entry) => entry.label)).size !== labels.length) {
      ctx.addIssue({
        code: "custom",
        path: ["label"],
        message: "neutral labels must be distinct",
      });
    }
  });

export const FAMILY_TITLES: Readonly<Record<Family, string>> = {
  ranking: "Order the Items",
  matching: "Match the Categories",
  scheduling: "Schedule the Events",
  truth: "Find the Truthful Speakers",
  arithmetic: "Solve the Number Puzzle",
  matrix: "Complete the XOR Matrix",
  transforms: "Apply the Transformations",
  paths: "Trace the Route",
  symmetry: "Complete the Symmetric Tile",
  counting: "Count the Shape Overlap",
};

export const STRATEGY_HINTS: Readonly<Record<Family, string>> = {
  ranking: "Use the order and position clues to eliminate impossible arrangements.",
  matching: "Use the same and different clues to eliminate impossible pairings.",
  scheduling: "Use the slot, order, and resource clues to eliminate impossible schedules.",
  truth: "Test each speaker statement against the exact truthful count.",
  arithmetic: "Use the equations and inequalities to narrow the three values.",
  matrix: "Apply the XOR rule to each row and column.",
  transforms: "Follow the ordered transformations from the source tile.",
  paths: "Follow the open edges from start to goal.",
  symmetry: "Reflect the known half across the stated axis.",
  counting: "Compare the shapes region by region.",
};

export const NEUTRAL_LABELS: Readonly<Record<Family, readonly NeutralLabel[]>> = {
  ranking: [
    { entityId: "item-0", label: "A" },
    { entityId: "item-1", label: "B" },
    { entityId: "item-2", label: "C" },
    { entityId: "item-3", label: "D" },
    { entityId: "item-4", label: "E" },
  ],
  matching: [
    { entityId: "person-0", label: "A1" },
    { entityId: "person-1", label: "A2" },
    { entityId: "person-2", label: "A3" },
    { entityId: "person-3", label: "A4" },
    { entityId: "pet-0", label: "B1" },
    { entityId: "pet-1", label: "B2" },
    { entityId: "pet-2", label: "B3" },
    { entityId: "pet-3", label: "B4" },
    { entityId: "color-0", label: "C1" },
    { entityId: "color-1", label: "C2" },
    { entityId: "color-2", label: "C3" },
    { entityId: "color-3", label: "C4" },
  ],
  scheduling: [
    { entityId: "event-0", label: "E1" },
    { entityId: "event-1", label: "E2" },
    { entityId: "event-2", label: "E3" },
    { entityId: "event-3", label: "E4" },
    { entityId: "resource-0", label: "R1" },
    { entityId: "resource-1", label: "R2" },
  ],
  truth: [
    { entityId: "person-0", label: "P1" },
    { entityId: "person-1", label: "P2" },
    { entityId: "person-2", label: "P3" },
    { entityId: "person-3", label: "P4" },
  ],
  arithmetic: [
    { entityId: "var-x", label: "x" },
    { entityId: "var-y", label: "y" },
    { entityId: "var-z", label: "z" },
  ],
  matrix: [
    { entityId: "glyph-0", label: "G1" },
    { entityId: "glyph-1", label: "G2" },
    { entityId: "glyph-2", label: "G3" },
    { entityId: "glyph-3", label: "G4" },
  ],
  transforms: [
    { entityId: "tile", label: "Tile" },
    { entityId: "operation-0", label: "op0" },
    { entityId: "operation-1", label: "op1" },
  ],
  paths: [
    { entityId: "start", label: "S" },
    { entityId: "goal", label: "G" },
  ],
  symmetry: [
    { entityId: "tile", label: "Tile" },
    { entityId: "axis", label: "Axis" },
  ],
  counting: [
    { entityId: "shape-0", label: "A" },
    { entityId: "shape-1", label: "B" },
    { entityId: "shape-2", label: "C" },
  ],
};

export interface DesignWording {
  readonly wording: WordingBundle;
  readonly title: string;
  readonly neutralLabels: readonly NeutralLabel[];
}

export interface DesignTemplateHashInput {
  readonly family: Family;
  readonly modality: Modality;
  readonly title: string;
  readonly question: string;
  readonly rules: unknown;
  readonly clues: unknown;
  readonly options: unknown;
  readonly neutralLabels: readonly NeutralLabel[];
  readonly hint: string;
}

export function computeDesignTemplateHash(
  input: DesignTemplateHashInput,
): string {
  return sha256Hex(
    canonicalJson({
      version: DESIGN_TEMPLATE_VERSION,
      family: input.family,
      modality: input.modality,
      title: input.title,
      question: input.question,
      rules: input.rules,
      clues: input.clues,
      options: input.options,
      neutralLabels: input.neutralLabels,
      hint: input.hint,
    }),
  );
}

export interface BuildDesignWordingInput<S> {
  readonly engine: WordingEngine<S>;
  readonly spec: S;
  readonly difficulty: 1 | 2 | 3;
  readonly explanationSteps: readonly WordingExplanationStep[];
}

export function buildDesignWording<S>(
  input: BuildDesignWordingInput<S>,
): DesignWording {
  const rules = input.engine.visibleRules(input.spec);
  const facts = input.engine.facts(input.spec);
  const title = `${FAMILY_TITLES[input.engine.family]} - Level ${input.difficulty}`;
  const hint = STRATEGY_HINTS[input.engine.family];
  const wording = WordingBundleSchema.parse({
    source: "fixture",
    response: {
      question: rules.target,
      clueTexts:
        input.engine.modality === "text"
          ? facts.map((fact) => ({ factId: fact.factId, text: fact.text }))
          : [],
      hint,
      explanationSteps: input.explanationSteps,
    },
  });
  const neutralLabels = neutralLabelsForSpec(
    input.engine.family,
    input.spec as FamilySpec,
  );
  return { wording, title, neutralLabels };
}

export function neutralLabelsForSpec(
  family: Family,
  spec: FamilySpec,
): readonly NeutralLabel[] {
  const required = designerSkinEntityIdsForSpec(family, spec);
  const labels = NEUTRAL_LABELS[family];
  return NeutralLabelSetSchema.parse(
    required.map((entityId) => {
      const label = labels.find((entry) => entry.entityId === entityId);
      if (label === undefined) {
        throw new Error(
          `neutral label catalog for ${family} is missing entity ${entityId}`,
        );
      }
      return label;
    }),
  );
}

export function familyTitle(family: Family, modality: Modality): string {
  return `${FAMILY_TITLES[family]} (${modality})`;
}
