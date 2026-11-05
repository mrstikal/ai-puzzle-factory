import { z } from "zod";
import { ChoiceLabelSchema } from "./answers.js";
import {
  FamilySchema,
  ModalitySchema,
  Sha256Schema,
  SLOT_ID_PATTERN,
} from "./experiment.js";
import {
  FactIdSchema,
  SolveProofSchema,
  VisibleRulesSchema,
} from "../families/contracts.js";

function nonBlankString(max: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "string must not be blank");
}

export const WordingClueSchema = z.strictObject({
  factId: FactIdSchema,
  text: nonBlankString(200),
});

export type WordingClue = z.infer<typeof WordingClueSchema>;

export const WordingExplanationStepSchema = z.strictObject({
  factIds: z.array(FactIdSchema).min(1).max(32),
  text: nonBlankString(240),
});

export type WordingExplanationStep = z.infer<typeof WordingExplanationStepSchema>;

export const WordingResponseSchema = z.strictObject({
  question: nonBlankString(400),
  clueTexts: z.array(WordingClueSchema).max(12),
  hint: nonBlankString(300),
  explanationSteps: z.array(WordingExplanationStepSchema).max(8),
});

export type WordingResponse = z.infer<typeof WordingResponseSchema>;

export const WORDING_SOURCES = ["fixture", "model"] as const;
export type WordingSource = (typeof WORDING_SOURCES)[number];
export const WordingSourceSchema = z.enum(WORDING_SOURCES);

export const WordingBundleSchema = z.strictObject({
  source: WordingSourceSchema,
  response: WordingResponseSchema,
});

export type WordingBundle = z.infer<typeof WordingBundleSchema>;

export const PresentationClueSchema = z.strictObject({
  factId: FactIdSchema,
  text: nonBlankString(200),
});

export type PresentationClue = z.infer<typeof PresentationClueSchema>;

export const PresentationOptionSchema = z.strictObject({
  label: ChoiceLabelSchema,
  text: nonBlankString(300),
});

export type PresentationOption = z.infer<typeof PresentationOptionSchema>;

export const PresentationAssetsSchema = z.strictObject({
  svgHash: Sha256Schema.nullable(),
  pngHash: Sha256Schema.nullable(),
});

export type PresentationAssets = z.infer<typeof PresentationAssetsSchema>;

export const VisiblePresentationSchema = z.strictObject({
  version: z.literal(1),
  slotId: z.string().regex(SLOT_ID_PATTERN),
  family: FamilySchema,
  modality: ModalitySchema,
  question: nonBlankString(400),
  rules: VisibleRulesSchema,
  clues: z.array(PresentationClueSchema).max(12),
  options: z.array(PresentationOptionSchema).length(4),
  assets: PresentationAssetsSchema,
});

export type VisiblePresentation = z.infer<typeof VisiblePresentationSchema>;

export const RevealDataSchema = z.strictObject({
  correctLabel: ChoiceLabelSchema,
  correctValue: z
    .unknown()
    .refine((value) => value !== undefined, "correctValue is required"),
  hint: nonBlankString(300),
  explanationSteps: z.array(WordingExplanationStepSchema).max(8),
  proof: SolveProofSchema,
});

export type RevealData = z.infer<typeof RevealDataSchema>;

export const SEMANTIC_ALIGNMENT_STATUSES = ["semantic_alignment_pending"] as const;
export type SemanticAlignmentStatus =
  (typeof SEMANTIC_ALIGNMENT_STATUSES)[number];
export const SemanticAlignmentStatusSchema = z.enum(SEMANTIC_ALIGNMENT_STATUSES);

export const MechanicalChecksSchema = z.strictObject({
  wordingSchema: z.literal("pass"),
  clueFactCoverage: z.literal("pass"),
  explanationReferences: z.literal("pass"),
  optionOrder: z.literal("pass"),
  optionTextDistinctness: z.literal("pass"),
  assets: z.enum(["pass", "not_applicable"]),
  semanticAlignment: SemanticAlignmentStatusSchema,
});

export type MechanicalChecks = z.infer<typeof MechanicalChecksSchema>;

export const AssembledPresentationSchema = z.strictObject({
  version: z.literal(1),
  visible: VisiblePresentationSchema,
  reveal: RevealDataSchema,
  wordingSource: WordingSourceSchema,
  checks: MechanicalChecksSchema,
});

export type AssembledPresentation = z.infer<typeof AssembledPresentationSchema>;
