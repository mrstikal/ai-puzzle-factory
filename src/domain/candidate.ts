import { z } from "zod";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { ChoiceLabelSchema } from "./answers.js";
import {
  FamilySchema,
  LaneSchema,
  ModalitySchema,
  MODALITY_BY_FAMILY,
  Sha256Schema,
  SLOT_ID_PATTERN,
  SlotPlanSchema,
} from "./experiment.js";
import { FeatureMultisetSchema } from "../families/canonicalize.js";
import {
  CanonicalStructureSchema,
  FactIdSchema,
  VisibleRulesSchema,
} from "../families/contracts.js";

export const WORKFLOW_STAGES = [
  "planned",
  "spec_ready",
  "formal_checked",
  "presentation_ready",
  "duplicate_checked",
  "blind_reviewed",
  "alignment_reviewed",
  "terminal",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const RUN_CONTROL_STATES = [
  "running",
  "paused_budget",
  "paused_operator",
  "interrupted",
  "completed",
  "failed",
] as const;

export type RunControlState = (typeof RUN_CONTROL_STATES)[number];

export const CANDIDATE_VERDICTS = [
  "approved",
  "rejected",
  "inconclusive",
  "generation_error",
] as const;

export type CandidateVerdict = (typeof CANDIDATE_VERDICTS)[number];

export const FAILURE_CODES = [
  "SCHEMA_INVALID",
  "UNSAT",
  "MULTIPLE_SOLUTIONS",
  "MULTIPLE_ANSWERS",
  "SOLVER_LIMIT",
  "DUPLICATE_OPTION",
  "EXACT_DUPLICATE",
  "STRUCTURAL_DUPLICATE",
  "NEAR_DUPLICATE_SUSPECTED",
  "TEXT_SPEC_MISMATCH",
  "EXPLANATION_MISMATCH",
  "REVIEWER_DISAGREES",
  "REVIEWER_CANNOT_SOLVE",
  "VISION_REVIEW_UNCERTAIN",
  "SVG_RENDER_INVALID",
  "VISUAL_AMBIGUITY",
  "COST_UNKNOWN",
  "API_ERROR",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export const EVIDENCE_SOURCES = ["deterministic", "model", "human", "infrastructure"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const FAILURE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type FailureSeverity = (typeof FAILURE_SEVERITIES)[number];

export const WorkflowStageSchema = z.enum(WORKFLOW_STAGES);
export const RunControlStateSchema = z.enum(RUN_CONTROL_STATES);
export const CandidateVerdictSchema = z.enum(CANDIDATE_VERDICTS);
export const FailureCodeSchema = z.enum(FAILURE_CODES);
export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export const FailureSeveritySchema = z.enum(FAILURE_SEVERITIES);

export const FailureRecordSchema = z.strictObject({
  code: FailureCodeSchema,
  stage: WorkflowStageSchema,
  severity: FailureSeveritySchema,
  source: EvidenceSourceSchema,
  evidence: z.string().max(2000).nullable(),
});

export type FailureRecord = z.infer<typeof FailureRecordSchema>;

export const CandidateEnvelopeSchema = z
  .strictObject({
    runId: z.uuid(),
    slotId: z.string().min(1),
    stage: WorkflowStageSchema,
    verdict: CandidateVerdictSchema.nullable(),
    failures: z.array(FailureRecordSchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((candidate, ctx) => {
    const isTerminal = candidate.stage === "terminal";
    if (isTerminal && candidate.verdict === null) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "a terminal candidate envelope requires a primary verdict",
      });
    }
    if (!isTerminal && candidate.verdict !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "a non-terminal candidate envelope cannot carry a primary verdict",
      });
    }
  });

export type CandidateEnvelope = z.infer<typeof CandidateEnvelopeSchema>;

export const StageResultEnvelopeSchema = z
  .strictObject({
    runId: z.uuid(),
    slotId: z.string().min(1),
    stage: WorkflowStageSchema,
    version: z.literal(1),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
    payloadHash: Sha256Schema,
    artifactHashes: z.array(Sha256Schema),
  })
  .superRefine((stage, ctx) => {
    if (stage.finishedAt === null && stage.elapsedMs !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["elapsedMs"],
        message: "elapsedMs must be null while finishedAt is null",
      });
    }
    if (stage.finishedAt !== null && stage.elapsedMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["elapsedMs"],
        message: "a finished stage requires a measured elapsedMs",
      });
    }
  });

export type StageResultEnvelope = z.infer<typeof StageResultEnvelopeSchema>;

export const FINGERPRINT_CONTENT_VERSION = 1 as const;

export const FingerprintClueSchema = z.strictObject({
  factId: FactIdSchema,
  text: z.string().min(1).max(200),
});

export type FingerprintClue = z.infer<typeof FingerprintClueSchema>;

export const FingerprintOptionSchema = z.strictObject({
  label: ChoiceLabelSchema,
  text: z.string().min(1).max(300),
});

export type FingerprintOption = z.infer<typeof FingerprintOptionSchema>;

export const FingerprintExplanationStepSchema = z.strictObject({
  factIds: z.array(FactIdSchema).min(1).max(32),
  text: z.string().min(1).max(240),
});

export type FingerprintExplanationStep = z.infer<
  typeof FingerprintExplanationStepSchema
>;

export const FingerprintContentSchema = z
  .strictObject({
    version: z.literal(FINGERPRINT_CONTENT_VERSION),
    question: z.string().min(1).max(400),
    rules: VisibleRulesSchema,
    clues: z.array(FingerprintClueSchema).max(12),
    options: z.array(FingerprintOptionSchema).length(4),
    hint: z.string().min(1).max(300),
    explanation: z.array(FingerprintExplanationStepSchema).max(8),
  })
  .superRefine((content, ctx) => {
    const labels = content.options.map((option) => option.label);
    if (labels.join("") !== "ABCD") {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "fingerprint content options must be labeled A-D in order",
      });
    }
    const clueIds = content.clues.map((clue) => clue.factId);
    if (new Set(clueIds).size !== clueIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["clues"],
        message: "fingerprint content clue fact IDs must be unique",
      });
    }
  });

export type FingerprintContent = z.infer<typeof FingerprintContentSchema>;

export const RenderHashesSchema = z.strictObject({
  svg: Sha256Schema.nullable(),
  png: Sha256Schema.nullable(),
});

export type RenderHashes = z.infer<typeof RenderHashesSchema>;

export const CandidateFingerprintSchema = z
  .strictObject({
    version: z.literal(1),
    family: FamilySchema,
    modality: ModalitySchema,
    specHash: Sha256Schema.nullable(),
    structureHash: Sha256Schema.nullable(),
    contentHash: Sha256Schema.nullable(),
    renderHashes: RenderHashesSchema,
    canonicalStructure: CanonicalStructureSchema.nullable(),
    features: FeatureMultisetSchema,
  })
  .superRefine((fingerprint, ctx) => {
    if (fingerprint.canonicalStructure === null) {
      if (fingerprint.structureHash !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["structureHash"],
          message: "structureHash requires canonicalStructure",
        });
      }
      if (fingerprint.features.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["features"],
          message: "features require canonicalStructure",
        });
      }
      return;
    }
    if (fingerprint.canonicalStructure.family !== fingerprint.family) {
      ctx.addIssue({
        code: "custom",
        path: ["canonicalStructure", "family"],
        message: "canonicalStructure family must match the fingerprint family",
      });
    }
    if (fingerprint.specHash === null) {
      ctx.addIssue({
        code: "custom",
        path: ["specHash"],
        message: "canonicalStructure requires a canonical spec hash",
      });
    }
    if (fingerprint.structureHash === null) {
      ctx.addIssue({
        code: "custom",
        path: ["structureHash"],
        message: "canonicalStructure requires a structure hash",
      });
    }
    if (fingerprint.features.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["features"],
        message: "canonicalStructure requires at least one structural feature",
      });
    }
    if (fingerprint.modality === "text") {
      if (fingerprint.renderHashes.svg !== null || fingerprint.renderHashes.png !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["renderHashes"],
          message: "text candidates cannot carry render hashes",
        });
      }
    }
  });

export type CandidateFingerprint = z.infer<typeof CandidateFingerprintSchema>;

export const PREPARATION_STATUSES = ["ready", "early_failure", "incomplete"] as const;
export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];
export const PreparationStatusSchema = z.enum(PREPARATION_STATUSES);

export const CandidateBarrierInputSchema = z
  .strictObject({
    slotId: z.string().regex(SLOT_ID_PATTERN),
    slotOrdinal: z.number().int().min(1).max(200),
    family: FamilySchema,
    modality: ModalitySchema,
    lane: LaneSchema,
    preparationStatus: PreparationStatusSchema,
    presentationCheckPassed: z.boolean(),
    formalPassed: z.boolean(),
    terminalVerdict: CandidateVerdictSchema.nullable(),
    fingerprint: CandidateFingerprintSchema.nullable(),
  })
  .superRefine((candidate, ctx) => {
    const [slotModality, slotFamily] = candidate.slotId.split("-");
    if (slotModality !== candidate.modality || slotFamily !== candidate.family) {
      ctx.addIssue({
        code: "custom",
        path: ["slotId"],
        message: "candidate slot ID must match its modality and family",
      });
    }
    if (candidate.modality !== MODALITY_BY_FAMILY[candidate.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["modality"],
        message: "candidate modality must match its family",
      });
    }
    if (candidate.fingerprint !== null) {
      if (candidate.fingerprint.family !== candidate.family) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint", "family"],
          message: "candidate fingerprint family must match the candidate family",
        });
      }
      if (candidate.fingerprint.modality !== candidate.modality) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint", "modality"],
          message: "candidate fingerprint modality must match the candidate modality",
        });
      }
    }
    if (candidate.preparationStatus === "ready") {
      if (!candidate.formalPassed) {
        ctx.addIssue({
          code: "custom",
          path: ["formalPassed"],
          message: "a ready candidate must have passed formal checks",
        });
      }
      if (!candidate.presentationCheckPassed) {
        ctx.addIssue({
          code: "custom",
          path: ["presentationCheckPassed"],
          message: "a ready candidate must have passed presentation checks",
        });
      }
      if (candidate.terminalVerdict !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["terminalVerdict"],
          message: "a ready candidate cannot already have a terminal verdict",
        });
      }
      if (candidate.fingerprint === null) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint"],
          message: "a ready candidate requires a fingerprint",
        });
        return;
      }
      if (candidate.fingerprint.contentHash === null) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint", "contentHash"],
          message: "a ready candidate requires a content hash",
        });
      }
      if (candidate.fingerprint.canonicalStructure === null) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint", "canonicalStructure"],
          message: "a ready candidate requires a canonical structure",
        });
      }
      if (candidate.modality === "svg") {
        if (
          candidate.fingerprint.renderHashes.svg === null ||
          candidate.fingerprint.renderHashes.png === null
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["fingerprint", "renderHashes"],
            message: "a ready SVG candidate requires both SVG and PNG render hashes",
          });
        }
      }
      return;
    }
    if (candidate.preparationStatus === "early_failure") {
      if (candidate.presentationCheckPassed) {
        ctx.addIssue({
          code: "custom",
          path: ["presentationCheckPassed"],
          message: "an early failure cannot have passed presentation checks",
        });
      }
      if (candidate.terminalVerdict === null) {
        ctx.addIssue({
          code: "custom",
          path: ["terminalVerdict"],
          message: "an early failure must preserve a terminal verdict",
        });
      }
      if (candidate.formalPassed && candidate.fingerprint === null) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint"],
          message: "a formal-passed early failure requires a diagnostic fingerprint",
        });
      }
      if (
        candidate.formalPassed &&
        candidate.fingerprint !== null &&
        candidate.fingerprint.canonicalStructure === null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint", "canonicalStructure"],
          message: "a formal-passed early failure requires a canonical structure",
        });
      }
      if (!candidate.formalPassed && candidate.fingerprint !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprint"],
          message: "a formally failed candidate cannot carry a fingerprint",
        });
      }
      return;
    }
    if (candidate.presentationCheckPassed) {
      ctx.addIssue({
        code: "custom",
        path: ["presentationCheckPassed"],
        message: "an incomplete candidate cannot have passed presentation checks",
      });
    }
    if (candidate.terminalVerdict !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["terminalVerdict"],
        message: "an incomplete candidate cannot have a terminal verdict",
      });
    }
  });

export type CandidateBarrierInput = z.infer<typeof CandidateBarrierInputSchema>;

export const DUPLICATE_PAIR_KINDS = [
  "exact_content",
  "canonical_spec",
  "structural",
  "near",
  "visual_exact",
] as const;
export type DuplicatePairKind = (typeof DUPLICATE_PAIR_KINDS)[number];
export const DuplicatePairKindSchema = z.enum(DUPLICATE_PAIR_KINDS);

export const FeatureComparisonSchema = z.strictObject({
  removed: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  editDistance: z.number().int().nonnegative(),
  intersection: z.number().int().nonnegative(),
  union: z.number().int().nonnegative(),
  jaccard: z.number().min(0).max(1),
  commonFeatureCount: z.number().int().nonnegative(),
});

export type FeatureComparison = z.infer<typeof FeatureComparisonSchema>;

export const DuplicatePairSchema = z
  .strictObject({
    kind: DuplicatePairKindSchema,
    leftSlotId: z.string().regex(SLOT_ID_PATTERN),
    rightSlotId: z.string().regex(SLOT_ID_PATTERN),
    leftSlotOrdinal: z.number().int().min(1).max(200),
    rightSlotOrdinal: z.number().int().min(1).max(200),
    family: FamilySchema.nullable(),
    eligible: z.boolean(),
    diagnostic: z.boolean(),
    comparison: FeatureComparisonSchema.nullable(),
    evidence: z.string().min(1).max(500),
  })
  .superRefine((pair, ctx) => {
    if (pair.leftSlotOrdinal >= pair.rightSlotOrdinal) {
      ctx.addIssue({
        code: "custom",
        path: ["rightSlotOrdinal"],
        message: "duplicate pairs must be ordered by slot ordinal",
      });
    }
    if (pair.leftSlotId === pair.rightSlotId) {
      ctx.addIssue({
        code: "custom",
        path: ["rightSlotId"],
        message: "duplicate pairs require two distinct slots",
      });
    }
    if (pair.kind === "near") {
      if (pair.comparison === null) {
        ctx.addIssue({
          code: "custom",
          path: ["comparison"],
          message: "near pairs require feature comparison evidence",
        });
      }
    } else if (pair.comparison !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["comparison"],
        message: "only near pairs carry feature comparison evidence",
      });
    }
    if (pair.kind === "visual_exact") {
      if (pair.family !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["family"],
          message: "visual exact diagnostics cross family boundaries",
        });
      }
      if (!pair.diagnostic) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostic"],
          message: "visual exact pairs are diagnostic only",
        });
      }
    } else if (pair.family === null) {
      ctx.addIssue({
        code: "custom",
        path: ["family"],
        message: "family-scoped duplicate pairs require a family",
      });
    }
    if (!pair.diagnostic && !pair.eligible) {
      ctx.addIssue({
        code: "custom",
        path: ["eligible"],
        message: "non-diagnostic pairs require two eligible candidates",
      });
    }
  });

export type DuplicatePair = z.infer<typeof DuplicatePairSchema>;

export const DUPLICATE_OUTCOMES = [
  "owner",
  "unique",
  "exact_duplicate",
  "spec_duplicate",
  "structural_duplicate",
  "near_suspected",
  "ineligible",
] as const;
export type DuplicateOutcome = (typeof DUPLICATE_OUTCOMES)[number];
export const DuplicateOutcomeSchema = z.enum(DUPLICATE_OUTCOMES);

export const DUPLICATE_KINDS = ["exact_content", "canonical_spec", "structural"] as const;
export type DuplicateKind = (typeof DUPLICATE_KINDS)[number];
export const DuplicateKindSchema = z.enum(DUPLICATE_KINDS);

export const CandidateDuplicateAssessmentSchema = z
  .strictObject({
    slotId: z.string().regex(SLOT_ID_PATTERN),
    slotOrdinal: z.number().int().min(1).max(200),
    family: FamilySchema,
    modality: ModalitySchema,
    lane: LaneSchema,
    eligible: z.boolean(),
    fingerprintable: z.boolean(),
    groupOwner: z.boolean(),
    outcome: DuplicateOutcomeSchema,
    ownerSlotId: z.string().regex(SLOT_ID_PATTERN).nullable(),
    duplicateKind: DuplicateKindSchema.nullable(),
    nearPairSlotIds: z.array(z.string().regex(SLOT_ID_PATTERN)),
    failureCodes: z.array(FailureCodeSchema),
    terminalVerdict: CandidateVerdictSchema.nullable(),
    specHash: Sha256Schema.nullable(),
    structureHash: Sha256Schema.nullable(),
    contentHash: Sha256Schema.nullable(),
    renderHashes: RenderHashesSchema,
    canonicalStructure: CanonicalStructureSchema.nullable(),
    features: FeatureMultisetSchema,
  })
  .superRefine((assessment, ctx) => {
    if (assessment.canonicalStructure === null) {
      if (assessment.structureHash !== null || assessment.features.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["structureHash"],
          message: "assessment structure data requires canonicalStructure",
        });
      }
    } else {
      if (assessment.canonicalStructure.family !== assessment.family) {
        ctx.addIssue({
          code: "custom",
          path: ["canonicalStructure", "family"],
          message: "assessment canonical structure family must match",
        });
      }
      if (assessment.structureHash === null || assessment.features.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["structureHash"],
          message: "assessment canonical structure requires a hash and features",
        });
      }
      if (assessment.specHash === null) {
        ctx.addIssue({
          code: "custom",
          path: ["specHash"],
          message: "assessment canonical structure requires a canonical spec hash",
        });
      }
    }
    if (
      assessment.modality === "text" &&
      (assessment.renderHashes.svg !== null || assessment.renderHashes.png !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["renderHashes"],
        message: "text assessments cannot carry render hashes",
      });
    }
    if (assessment.fingerprintable && assessment.structureHash === null) {
      ctx.addIssue({
        code: "custom",
        path: ["structureHash"],
        message: "a fingerprintable assessment requires a structure hash",
      });
    }
    if (assessment.eligible) {
      if (assessment.contentHash === null) {
        ctx.addIssue({
          code: "custom",
          path: ["contentHash"],
          message: "an eligible assessment requires a content hash",
        });
      }
      if (
        assessment.modality === "svg" &&
        (assessment.renderHashes.svg === null || assessment.renderHashes.png === null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["renderHashes"],
          message: "an eligible SVG assessment requires both render hashes",
        });
      }
    }
    if (assessment.outcome === "exact_duplicate" || assessment.outcome === "spec_duplicate" || assessment.outcome === "structural_duplicate") {
      if (assessment.ownerSlotId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["ownerSlotId"],
          message: "a duplicate must name its owner",
        });
      }
      if (assessment.duplicateKind === null) {
        ctx.addIssue({
          code: "custom",
          path: ["duplicateKind"],
          message: "a duplicate must record its duplicate kind",
        });
      }
      if (assessment.nearPairSlotIds.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["nearPairSlotIds"],
          message: "a confirmed duplicate cannot also carry near-pair flags",
        });
      }
      if (!assessment.eligible) {
        ctx.addIssue({
          code: "custom",
          path: ["eligible"],
          message: "a duplicate decision requires eligibility",
        });
      }
      if (
        assessment.outcome === "exact_duplicate" &&
        assessment.duplicateKind !== "exact_content"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["duplicateKind"],
          message: "exact_duplicate requires exact_content",
        });
      }
      if (
        assessment.outcome === "spec_duplicate" &&
        assessment.duplicateKind !== "canonical_spec"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["duplicateKind"],
          message: "spec_duplicate requires canonical_spec",
        });
      }
      if (
        assessment.outcome === "structural_duplicate" &&
        assessment.duplicateKind !== "structural"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["duplicateKind"],
          message: "structural_duplicate requires structural",
        });
      }
      const expectedFailure =
        assessment.outcome === "structural_duplicate"
          ? "STRUCTURAL_DUPLICATE"
          : "EXACT_DUPLICATE";
      if (!assessment.failureCodes.includes(expectedFailure)) {
        ctx.addIssue({
          code: "custom",
          path: ["failureCodes"],
          message: `a duplicate must record ${expectedFailure}`,
        });
      }
      return;
    }
    if (assessment.outcome === "near_suspected") {
      if (assessment.nearPairSlotIds.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["nearPairSlotIds"],
          message: "a near-suspected candidate must name at least one near pair",
        });
      }
      if (assessment.ownerSlotId !== null || assessment.duplicateKind !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["ownerSlotId"],
          message: "a near-suspected candidate is not a duplicate",
        });
      }
      if (!assessment.failureCodes.includes("NEAR_DUPLICATE_SUSPECTED")) {
        ctx.addIssue({
          code: "custom",
          path: ["failureCodes"],
          message: "a near-suspected candidate must record NEAR_DUPLICATE_SUSPECTED",
        });
      }
      if (!assessment.eligible) {
        ctx.addIssue({
          code: "custom",
          path: ["eligible"],
          message: "a near-suspected candidate must be eligible",
        });
      }
      return;
    }
    if (assessment.outcome === "ineligible") {
      if (assessment.eligible) {
        ctx.addIssue({
          code: "custom",
          path: ["eligible"],
          message: "an ineligible outcome requires eligible false",
        });
      }
      if (assessment.terminalVerdict === null) {
        ctx.addIssue({
          code: "custom",
          path: ["terminalVerdict"],
          message: "an ineligible candidate must preserve its terminal verdict",
        });
      }
      if (
        assessment.ownerSlotId !== null ||
        assessment.duplicateKind !== null ||
        assessment.nearPairSlotIds.length > 0 ||
        assessment.failureCodes.length > 0 ||
        assessment.groupOwner
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "an ineligible candidate carries no duplicate or near decision",
        });
      }
      return;
    }
    if (!assessment.eligible) {
      ctx.addIssue({
        code: "custom",
        path: ["eligible"],
        message: "owner and unique outcomes require eligibility",
      });
    }
    if (assessment.terminalVerdict !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["terminalVerdict"],
        message: "eligible owners and unique candidates have no terminal verdict",
      });
    }
    if (
      assessment.ownerSlotId !== null ||
      assessment.duplicateKind !== null ||
      assessment.nearPairSlotIds.length > 0 ||
      assessment.failureCodes.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "owner and unique candidates carry no duplicate or near decision",
      });
    }
    if (assessment.outcome === "owner" && !assessment.groupOwner) {
      ctx.addIssue({
        code: "custom",
        path: ["groupOwner"],
        message: "an owner outcome requires groupOwner true",
      });
    }
    if (assessment.outcome === "unique" && assessment.groupOwner) {
      ctx.addIssue({
        code: "custom",
        path: ["groupOwner"],
        message: "a unique outcome requires groupOwner false",
      });
    }
  });

export type CandidateDuplicateAssessment = z.infer<
  typeof CandidateDuplicateAssessmentSchema
>;

export const DuplicateBarrierSummarySchema = z.strictObject({
  plannedSlots: z.number().int().nonnegative(),
  preparedSlots: z.number().int().nonnegative(),
  readyCandidates: z.number().int().nonnegative(),
  earlyFailures: z.number().int().nonnegative(),
  eligibleCandidates: z.number().int().nonnegative(),
  fingerprintableCandidates: z.number().int().nonnegative(),
  ineligibleCandidates: z.number().int().nonnegative(),
  owners: z.number().int().nonnegative(),
  uniqueCandidates: z.number().int().nonnegative(),
  exactGroups: z.number().int().nonnegative(),
  specGroups: z.number().int().nonnegative(),
  structuralGroups: z.number().int().nonnegative(),
  exactDuplicates: z.number().int().nonnegative(),
  specDuplicates: z.number().int().nonnegative(),
  structuralDuplicates: z.number().int().nonnegative(),
  nearPairs: z.number().int().nonnegative(),
  nearSuspectedCandidates: z.number().int().nonnegative(),
  diagnosticPairs: z.number().int().nonnegative(),
  visualExactDiagnosticPairs: z.number().int().nonnegative(),
  replacements: z.literal(0),
  terminalFailuresRewritten: z.literal(0),
});

export type DuplicateBarrierSummary = z.infer<typeof DuplicateBarrierSummarySchema>;

export const DuplicateBarrierResultSchema = z
  .strictObject({
    version: z.literal(1),
    assessments: z.array(CandidateDuplicateAssessmentSchema).max(200),
    pairs: z.array(DuplicatePairSchema),
    summary: DuplicateBarrierSummarySchema,
    resultHash: Sha256Schema,
  })
  .superRefine((result, ctx) => {
    const { resultHash, ...base } = result;
    if (resultHash !== sha256Hex(canonicalJson(base))) {
      ctx.addIssue({
        code: "custom",
        path: ["resultHash"],
        message: "resultHash does not match the canonical barrier result",
      });
    }
  });

export type DuplicateBarrierResult = z.infer<typeof DuplicateBarrierResultSchema>;

export const DuplicateBarrierInputSchema = z
  .strictObject({
    plannedSlots: z.array(SlotPlanSchema).min(1).max(200),
    candidates: z.array(CandidateBarrierInputSchema).max(200),
  })
  .superRefine((input, ctx) => {
    const plannedIds = new Set<string>();
    const plannedOrdinals = new Set<number>();
    for (const [index, slot] of input.plannedSlots.entries()) {
      const [slotModality, slotFamily] = slot.slotId.split("-");
      if (slotModality !== slot.modality || slotFamily !== slot.family) {
        ctx.addIssue({
          code: "custom",
          path: ["plannedSlots", index, "slotId"],
          message: "planned slot ID must match its modality and family",
        });
      }
      if (plannedIds.has(slot.slotId)) {
        ctx.addIssue({
          code: "custom",
          path: ["plannedSlots", index, "slotId"],
          message: `duplicate planned slot ID ${slot.slotId}`,
        });
      }
      if (plannedOrdinals.has(slot.slotOrdinal)) {
        ctx.addIssue({
          code: "custom",
          path: ["plannedSlots", index, "slotOrdinal"],
          message: `duplicate planned slot ordinal ${slot.slotOrdinal}`,
        });
      }
      if (slot.modality !== MODALITY_BY_FAMILY[slot.family]) {
        ctx.addIssue({
          code: "custom",
          path: ["plannedSlots", index, "modality"],
          message: "planned slot modality must match its family",
        });
      }
      plannedIds.add(slot.slotId);
      plannedOrdinals.add(slot.slotOrdinal);
    }
    const candidateIds = new Set<string>();
    const candidateOrdinals = new Set<number>();
    const plannedById = new Map(input.plannedSlots.map((slot) => [slot.slotId, slot]));
    for (const [index, candidate] of input.candidates.entries()) {
      if (candidateIds.has(candidate.slotId)) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "slotId"],
          message: `duplicate candidate slot ID ${candidate.slotId}`,
        });
      }
      if (candidateOrdinals.has(candidate.slotOrdinal)) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "slotOrdinal"],
          message: `duplicate candidate slot ordinal ${candidate.slotOrdinal}`,
        });
      }
      const planned = plannedById.get(candidate.slotId);
      if (planned === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "slotId"],
          message: `candidate slot ${candidate.slotId} is not in the planned cohort`,
        });
      } else if (
        planned.slotOrdinal !== candidate.slotOrdinal ||
        planned.family !== candidate.family ||
        planned.modality !== candidate.modality ||
        planned.lane !== candidate.lane
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index],
          message: `candidate ${candidate.slotId} does not match its planned slot`,
        });
      }
      candidateIds.add(candidate.slotId);
      candidateOrdinals.add(candidate.slotOrdinal);
    }
  });

export type DuplicateBarrierInput = z.infer<typeof DuplicateBarrierInputSchema>;
