import { z } from "zod";
import {
  DIFFICULTIES,
  FAMILIES,
  MODALITY_BY_FAMILY,
  MAX_TRANSPORT_ATTEMPTS_PER_CALL,
  RoleConfigSchema,
  RoutingConfirmationSchema,
  RoutingPolicySchema,
  Sha256Schema,
  UsdSchema,
  DifficultySchema,
  FamilySchema,
  ModalitySchema,
  type Difficulty,
  type Family,
} from "./experiment.js";
import {
  FAMILY_SPEC_SCHEMAS,
  type FamilySpec,
  type FamilySpecByFamily,
} from "./spec.js";
import { RunControlStateSchema } from "./candidate.js";
import { hashObjectExcluding } from "../util/hash.js";

export const DESIGNER_PROTOCOL_VERSION = "2.0.0" as const;

export const DESIGNER_ARMS = [
  "baseline",
  "ai_one_shot",
  "ai_feedback",
] as const;
export type DesignerArm = (typeof DESIGNER_ARMS)[number];
export const DesignerArmSchema = z.enum(DESIGNER_ARMS);

export const DESIGNER_RUN_KINDS = [
  "design_primary",
  "design_pilot",
  "design_mock",
] as const;
export type DesignerRunKind = (typeof DESIGNER_RUN_KINDS)[number];
export const DesignerRunKindSchema = z.enum(DESIGNER_RUN_KINDS);

export const DESIGNER_ROOT_SEEDS: Readonly<Record<DesignerRunKind, string>> = {
  design_primary: "puzzle-designer-v1",
  design_pilot: "puzzle-designer-pilot-v1",
  design_mock: "puzzle-designer-mock-v1",
};

export const DESIGNER_REQUEST_ROLES = [
  "design",
  "design_repair_1",
  "design_repair_2",
] as const;
export type DesignerRequestRole = (typeof DESIGNER_REQUEST_ROLES)[number];
export const DesignerRequestRoleSchema = z.enum(DESIGNER_REQUEST_ROLES);

export const DESIGNER_CANDIDATE_VERDICTS = [
  "accepted",
  "rejected",
  "inconclusive",
  "generation_error",
] as const;
export type DesignerCandidateVerdict =
  (typeof DESIGNER_CANDIDATE_VERDICTS)[number];
export const DesignerCandidateVerdictSchema = z.enum(
  DESIGNER_CANDIDATE_VERDICTS,
);

export const DESIGNER_WORKFLOW_STAGES = [
  "planned",
  "design_proposed",
  "formal_checked",
  "presentation_ready",
  "terminal",
] as const;
export type DesignerWorkflowStage =
  (typeof DESIGNER_WORKFLOW_STAGES)[number];
export const DesignerWorkflowStageSchema = z.enum(DESIGNER_WORKFLOW_STAGES);

export const DESIGNER_ASSIGNMENT_ID_PATTERN =
  /^design-(text|svg)-(ranking|matching|scheduling|truth|arithmetic|matrix|transforms|paths|symmetry|counting)-\d{2}$/;
export const DESIGNER_CANDIDATE_SLOT_ID_PATTERN =
  /^design-(text|svg)-(ranking|matching|scheduling|truth|arithmetic|matrix|transforms|paths|symmetry|counting)-\d{2}-(baseline|ai_one_shot|ai_feedback)$/;

export function primaryDifficultyForWithinFamily(within: number): Difficulty {
  const pattern = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3] as const;
  const difficulty = pattern[within];
  if (difficulty === undefined) {
    throw new RangeError(
      `primary assignment index must be 0..9, received ${within}`,
    );
  }
  return difficulty;
}

export function pilotDifficultyForFamily(
  familyIndex: number,
): readonly [Difficulty, Difficulty] {
  const first = DIFFICULTIES[familyIndex % DIFFICULTIES.length];
  if (first === undefined) {
    throw new RangeError(
      `family index must be a non-negative integer, received ${familyIndex}`,
    );
  }
  const second = DIFFICULTIES[first % DIFFICULTIES.length];
  if (second === undefined) {
    throw new RangeError(`pilot difficulty lookup failed for ${familyIndex}`);
  }
  return [first, second];
}

export const DesignerAssignmentSchema = z.strictObject({
  assignmentId: z.string().regex(DESIGNER_ASSIGNMENT_ID_PATTERN),
  assignmentOrdinal: z.number().int().min(1).max(100),
  family: FamilySchema,
  modality: ModalitySchema,
  difficulty: DifficultySchema,
  assignmentSeed: Sha256Schema,
});
export type DesignerAssignment = z.infer<typeof DesignerAssignmentSchema>;

export const DesignerCandidateSlotSchema = z.strictObject({
  candidateSlotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  candidateOrdinal: z.number().int().min(1).max(300),
  assignmentId: z.string().regex(DESIGNER_ASSIGNMENT_ID_PATTERN),
  assignmentOrdinal: z.number().int().min(1).max(100),
  arm: DesignerArmSchema,
  family: FamilySchema,
  modality: ModalitySchema,
  difficulty: DifficultySchema,
  slotKind: z.literal("designer"),
  lane: z.null(),
  assignmentSeed: Sha256Schema,
});
export type DesignerCandidateSlot = z.infer<
  typeof DesignerCandidateSlotSchema
>;

export const DesignerQuotasSchema = z.strictObject({
  totalAssignments: z.number().int().nonnegative(),
  textAssignments: z.number().int().nonnegative(),
  svgAssignments: z.number().int().nonnegative(),
  assignmentsPerFamily: z.number().int().nonnegative(),
  totalCandidates: z.number().int().nonnegative(),
  baselineCandidates: z.number().int().nonnegative(),
  oneShotCandidates: z.number().int().nonnegative(),
  feedbackCandidates: z.number().int().nonnegative(),
  textCandidates: z.number().int().nonnegative(),
  svgCandidates: z.number().int().nonnegative(),
  candidatesPerFamily: z.number().int().nonnegative(),
});
export type DesignerQuotas = z.infer<typeof DesignerQuotasSchema>;

export const DesignerDifficultyCountSchema = z.strictObject({
  family: FamilySchema,
  arm: DesignerArmSchema,
  difficulty: DifficultySchema,
  count: z.number().int().nonnegative(),
});
export type DesignerDifficultyCount = z.infer<
  typeof DesignerDifficultyCountSchema
>;

export const DesignerRequestEstimateSchema = z.strictObject({
  byRole: z.strictObject({
    design: z.number().int().nonnegative(),
    design_repair_1: z.number().int().nonnegative(),
    design_repair_2: z.number().int().nonnegative(),
  }),
  totalContentLogicalCalls: z.number().int().nonnegative(),
  probeLogicalCalls: z.number().int().nonnegative(),
  totalLogicalCalls: z.number().int().nonnegative(),
  baselineAiCalls: z.literal(0),
  maxTransportAttempts: z.number().int().nonnegative(),
});
export type DesignerRequestEstimate = z.infer<
  typeof DesignerRequestEstimateSchema
>;

export function computeDesignerPlanHash(
  plan: Omit<DesignerPlanManifest, "planHash"> | DesignerPlanManifest,
): string {
  return hashObjectExcluding(plan, "planHash");
}

export const DesignerPlanManifestSchema = z
  .strictObject({
    protocolVersion: z.literal(DESIGNER_PROTOCOL_VERSION),
    runKind: DesignerRunKindSchema,
    rootSeed: z.string().min(1).max(128),
    assignments: z.array(DesignerAssignmentSchema).min(1).max(100),
    candidates: z.array(DesignerCandidateSlotSchema).min(1).max(300),
    quotas: DesignerQuotasSchema,
    difficultyCounts: z.array(DesignerDifficultyCountSchema),
    requestEstimate: DesignerRequestEstimateSchema,
    planHash: Sha256Schema,
  })
  .superRefine((plan, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    const expectedAssignments = plan.runKind === "design_pilot" ? 20 : 100;
    const expectedCandidates = expectedAssignments * 3;
    const perFamily = expectedAssignments / FAMILIES.length;
    if (plan.rootSeed !== DESIGNER_ROOT_SEEDS[plan.runKind]) {
      issue(
        ["rootSeed"],
        `root seed for ${plan.runKind} must be ${DESIGNER_ROOT_SEEDS[plan.runKind]}`,
      );
    }
    if (plan.assignments.length !== expectedAssignments) {
      issue(
        ["assignments"],
        `expected ${expectedAssignments} assignments, received ${plan.assignments.length}`,
      );
    }
    if (plan.candidates.length !== expectedCandidates) {
      issue(
        ["candidates"],
        `expected ${expectedCandidates} candidates, received ${plan.candidates.length}`,
      );
    }
    for (const [index, assignment] of plan.assignments.entries()) {
      const family = FAMILIES[Math.floor(index / perFamily)];
      if (family === undefined) {
        issue(["assignments", index], "assignment index exceeds the family list");
        continue;
      }
      const within = index % perFamily;
      const modality = MODALITY_BY_FAMILY[family];
      const expectedId = `design-${modality}-${family}-${String(within + 1).padStart(2, "0")}`;
      if (assignment.assignmentOrdinal !== index + 1) {
        issue(
          ["assignments", index, "assignmentOrdinal"],
          `expected ${index + 1}, received ${assignment.assignmentOrdinal}`,
        );
      }
      if (assignment.assignmentId !== expectedId) {
        issue(
          ["assignments", index, "assignmentId"],
          `expected ${expectedId}, received ${assignment.assignmentId}`,
        );
      }
      if (assignment.family !== family) {
        issue(
          ["assignments", index, "family"],
          `expected ${family}, received ${assignment.family}`,
        );
      }
      if (assignment.modality !== modality) {
        issue(
          ["assignments", index, "modality"],
          `expected ${modality}, received ${assignment.modality}`,
        );
      }
      const expectedDifficulty =
        plan.runKind === "design_pilot"
          ? pilotDifficultyForFamily(FAMILIES.indexOf(family))[within]
          : primaryDifficultyForWithinFamily(within);
      if (assignment.difficulty !== expectedDifficulty) {
        issue(
          ["assignments", index, "difficulty"],
          `expected ${expectedDifficulty}, received ${assignment.difficulty}`,
        );
      }
    }
    for (const [index, candidate] of plan.candidates.entries()) {
      const assignment = plan.assignments[Math.floor(index / DESIGNER_ARMS.length)];
      const arm = DESIGNER_ARMS[index % DESIGNER_ARMS.length];
      if (assignment === undefined || arm === undefined) {
        issue(["candidates", index], "candidate index exceeds the assignment list");
        continue;
      }
      const expectedId = `${assignment.assignmentId}-${arm}`;
      if (candidate.candidateOrdinal !== index + 1) {
        issue(
          ["candidates", index, "candidateOrdinal"],
          `expected ${index + 1}, received ${candidate.candidateOrdinal}`,
        );
      }
      if (candidate.candidateSlotId !== expectedId) {
        issue(
          ["candidates", index, "candidateSlotId"],
          `expected ${expectedId}, received ${candidate.candidateSlotId}`,
        );
      }
      if (candidate.assignmentId !== assignment.assignmentId) {
        issue(
          ["candidates", index, "assignmentId"],
          `expected ${assignment.assignmentId}, received ${candidate.assignmentId}`,
        );
      }
      if (candidate.assignmentOrdinal !== assignment.assignmentOrdinal) {
        issue(
          ["candidates", index, "assignmentOrdinal"],
          `expected ${assignment.assignmentOrdinal}, received ${candidate.assignmentOrdinal}`,
        );
      }
      if (candidate.arm !== arm) {
        issue(
          ["candidates", index, "arm"],
          `expected ${arm}, received ${candidate.arm}`,
        );
      }
      if (candidate.family !== assignment.family) {
        issue(
          ["candidates", index, "family"],
          `expected ${assignment.family}, received ${candidate.family}`,
        );
      }
      if (candidate.modality !== assignment.modality) {
        issue(
          ["candidates", index, "modality"],
          `expected ${assignment.modality}, received ${candidate.modality}`,
        );
      }
      if (candidate.difficulty !== assignment.difficulty) {
        issue(
          ["candidates", index, "difficulty"],
          `expected ${assignment.difficulty}, received ${candidate.difficulty}`,
        );
      }
      if (candidate.assignmentSeed !== assignment.assignmentSeed) {
        issue(
          ["candidates", index, "assignmentSeed"],
          "candidate seed must match its assignment seed",
        );
      }
    }
    const textAssignments = plan.assignments.filter(
      (assignment) => assignment.modality === "text",
    ).length;
    const textCandidates = plan.candidates.filter(
      (candidate) => candidate.modality === "text",
    ).length;
    const expectedQuotas = {
      totalAssignments: expectedAssignments,
      textAssignments,
      svgAssignments: expectedAssignments - textAssignments,
      assignmentsPerFamily: perFamily,
      totalCandidates: expectedCandidates,
      baselineCandidates: expectedAssignments,
      oneShotCandidates: expectedAssignments,
      feedbackCandidates: expectedAssignments,
      textCandidates,
      svgCandidates: expectedCandidates - textCandidates,
      candidatesPerFamily: perFamily * DESIGNER_ARMS.length,
    };
    for (const [key, expected] of Object.entries(expectedQuotas)) {
      if (plan.quotas[key as keyof DesignerQuotas] !== expected) {
        issue(
          ["quotas", key],
          `expected ${expected}, received ${String(plan.quotas[key as keyof DesignerQuotas])}`,
        );
      }
    }
    const expectedDifficultyCounts = FAMILIES.length * DESIGNER_ARMS.length * DIFFICULTIES.length;
    if (plan.difficultyCounts.length !== expectedDifficultyCounts) {
      issue(
        ["difficultyCounts"],
        `expected ${expectedDifficultyCounts} entries, received ${plan.difficultyCounts.length}`,
      );
    }
    let countIndex = 0;
    for (const family of FAMILIES) {
      for (const arm of DESIGNER_ARMS) {
        for (const difficulty of DIFFICULTIES) {
          const entry = plan.difficultyCounts[countIndex];
          const expectedCount = plan.candidates.filter(
            (candidate) =>
              candidate.family === family &&
              candidate.arm === arm &&
              candidate.difficulty === difficulty,
          ).length;
          if (
            entry === undefined ||
            entry.family !== family ||
            entry.arm !== arm ||
            entry.difficulty !== difficulty
          ) {
            issue(
              ["difficultyCounts", countIndex],
              `expected ${family}/${arm}/${difficulty}`,
            );
          } else if (entry.count !== expectedCount) {
            issue(
              ["difficultyCounts", countIndex, "count"],
              `expected ${expectedCount}, received ${entry.count}`,
            );
          }
          countIndex += 1;
        }
      }
    }
    const expectedByRole = {
      design: expectedAssignments * 2,
      design_repair_1: expectedAssignments,
      design_repair_2: expectedAssignments,
    };
    for (const [role, expected] of Object.entries(expectedByRole)) {
      if (plan.requestEstimate.byRole[role as keyof typeof expectedByRole] !== expected) {
        issue(
          ["requestEstimate", "byRole", role],
          `expected ${expected}, received ${String(plan.requestEstimate.byRole[role as keyof typeof expectedByRole])}`,
        );
      }
    }
    const totalContentLogicalCalls =
      expectedByRole.design +
      expectedByRole.design_repair_1 +
      expectedByRole.design_repair_2;
    const probeLogicalCalls = plan.runKind === "design_pilot" ? 2 : 0;
    const totalLogicalCalls = totalContentLogicalCalls + probeLogicalCalls;
    if (plan.requestEstimate.totalContentLogicalCalls !== totalContentLogicalCalls) {
      issue(
        ["requestEstimate", "totalContentLogicalCalls"],
        `expected ${totalContentLogicalCalls}, received ${plan.requestEstimate.totalContentLogicalCalls}`,
      );
    }
    if (plan.requestEstimate.probeLogicalCalls !== probeLogicalCalls) {
      issue(
        ["requestEstimate", "probeLogicalCalls"],
        `expected ${probeLogicalCalls}, received ${plan.requestEstimate.probeLogicalCalls}`,
      );
    }
    if (plan.requestEstimate.totalLogicalCalls !== totalLogicalCalls) {
      issue(
        ["requestEstimate", "totalLogicalCalls"],
        `expected ${totalLogicalCalls}, received ${plan.requestEstimate.totalLogicalCalls}`,
      );
    }
    if (
      plan.requestEstimate.maxTransportAttempts !==
      totalLogicalCalls * MAX_TRANSPORT_ATTEMPTS_PER_CALL
    ) {
      issue(
        ["requestEstimate", "maxTransportAttempts"],
        `expected ${totalLogicalCalls * MAX_TRANSPORT_ATTEMPTS_PER_CALL}`,
      );
    }
    if (plan.planHash !== computeDesignerPlanHash(plan)) {
      issue(["planHash"], "plan hash does not match the manifest content");
    }
  });

export type DesignerPlanManifest = z.infer<typeof DesignerPlanManifestSchema>;

export const DesignerSlotRecordSchema = z
  .strictObject({
    kind: z.literal("designer"),
    runId: z.uuid(),
    slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
    slotOrdinal: z.number().int().min(1).max(300),
    family: FamilySchema,
    modality: ModalitySchema,
    slotKind: z.literal("designer"),
    assignmentId: z.string().regex(DESIGNER_ASSIGNMENT_ID_PATTERN),
    arm: DesignerArmSchema,
    lane: z.null(),
    difficulty: DifficultySchema,
    stage: DesignerWorkflowStageSchema,
    verdict: DesignerCandidateVerdictSchema.nullable(),
    checkpointVersion: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((slot, ctx) => {
    if (slot.slotId !== `${slot.assignmentId}-${slot.arm}`) {
      ctx.addIssue({
        code: "custom",
        path: ["slotId"],
        message: "designer slot ID must append its assignment ID and arm",
      });
    }
    if (slot.modality !== MODALITY_BY_FAMILY[slot.family]) {
      ctx.addIssue({
        code: "custom",
        path: ["modality"],
        message: "designer slot modality must match its family",
      });
    }
    if ((slot.stage === "terminal") !== (slot.verdict !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "only terminal designer slots carry a verdict",
      });
    }
  });

export type DesignerSlotRecord = z.infer<typeof DesignerSlotRecordSchema>;

export const DesignerRunRecordSchema = z
  .strictObject({
    kind: z.literal("designer"),
    runId: z.uuid(),
    protocolVersion: z.literal(DESIGNER_PROTOCOL_VERSION),
    runKind: DesignerRunKindSchema,
    rootSeed: z.string().min(1).max(128),
    evidenceKind: z.enum(["mock", "live"]),
    manifest: DesignerPlanManifestSchema,
    manifestHash: Sha256Schema,
    controlState: RunControlStateSchema,
    createdAt: z.iso.datetime(),
  })
  .superRefine((run, ctx) => {
    if (
      run.manifest.planHash !== run.manifestHash ||
      run.manifest.protocolVersion !== run.protocolVersion ||
      run.manifest.runKind !== run.runKind ||
      run.manifest.rootSeed !== run.rootSeed
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["manifest"],
        message: "designer run manifest does not match its stored columns",
      });
    }
  });

export type DesignerRunRecord = z.infer<typeof DesignerRunRecordSchema>;

export const DesignerHashesSchema = z.strictObject({
  prompts: Sha256Schema,
  schema: Sha256Schema,
  source: Sha256Schema,
  font: Sha256Schema,
  reference: Sha256Schema,
  dependencyLock: Sha256Schema,
  presentationTemplates: Sha256Schema,
  structuralComparator: Sha256Schema,
  metrics: Sha256Schema,
  decisionEvaluator: Sha256Schema,
  humanRubric: Sha256Schema,
});
export type DesignerHashes = z.infer<typeof DesignerHashesSchema>;

export const DesignerCapabilitySnapshotSchema = z.strictObject({
  capturedAt: z.iso.datetime(),
  catalogHash: Sha256Schema,
  priceSnapshotHash: Sha256Schema,
  reservationMethod: z.string().min(1).max(200),
});
export type DesignerCapabilitySnapshot = z.infer<
  typeof DesignerCapabilitySnapshotSchema
>;

export const DesignerVersionsSchema = z.strictObject({
  baselineGenerator: z.string().min(1).max(100),
  structuralComparator: z.string().min(1).max(100),
  presentationTemplates: z.string().min(1).max(100),
  metrics: z.string().min(1).max(100),
  decisionEvaluator: z.string().min(1).max(100),
  humanSampler: z.string().min(1).max(100),
  humanOrder: z.string().min(1).max(100),
  humanRubric: z.string().min(1).max(100),
});
export type DesignerVersions = z.infer<typeof DesignerVersionsSchema>;

export function computeDesignerRunManifestHash(
  manifest: Omit<DesignerRunManifest, "manifestHash"> | DesignerRunManifest,
): string {
  return hashObjectExcluding(manifest, "manifestHash");
}

export const DesignerRunManifestSchema = z
  .strictObject({
    plan: DesignerPlanManifestSchema,
    evidenceKind: z.enum(["mock", "live"]),
    runId: z.uuid(),
    roles: z.strictObject({
      designer: RoleConfigSchema,
    }),
    routingPolicy: RoutingPolicySchema,
    routingConfirmation: RoutingConfirmationSchema,
    outputLimits: z.strictObject({
      design: z.literal(8192),
      design_repair_1: z.literal(8192),
      design_repair_2: z.literal(8192),
    }),
    concurrency: z.union([z.literal(1), z.literal(2)]),
    budget: z.strictObject({
      maxCostUsd: UsdSchema,
      reservationMethod: z.string().min(1).max(200),
      priceSnapshotHash: Sha256Schema,
    }),
    capabilitySnapshot: DesignerCapabilitySnapshotSchema,
    versions: DesignerVersionsSchema,
    baseline: z.strictObject({
      generatorVersion: z.string().min(1).max(100),
      referenceCorpusHash: Sha256Schema.nullable(),
    }),
    hashes: DesignerHashesSchema,
    runtime: z.strictObject({
      node: z.string().min(1).max(100),
      npm: z.string().min(1).max(100),
      os: z.string().min(1).max(100),
      arch: z.string().min(1).max(100),
    }),
    mockConfiguration: z
      .strictObject({
        synthetic: z.literal(true),
        description: z.string().min(1).max(500),
      })
      .nullable(),
    redacted: z.literal(true),
    createdAt: z.iso.datetime(),
    manifestHash: Sha256Schema,
  })
  .superRefine((manifest, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (manifest.evidenceKind === "mock" && manifest.mockConfiguration === null) {
      issue(
        ["mockConfiguration"],
        "mock evidence requires an explicit synthetic mock configuration",
      );
    }
    if (manifest.evidenceKind === "live" && manifest.mockConfiguration !== null) {
      issue(
        ["mockConfiguration"],
        "live evidence cannot carry a synthetic mock configuration",
      );
    }
    if (manifest.budget.priceSnapshotHash !== manifest.capabilitySnapshot.priceSnapshotHash) {
      issue(
        ["budget", "priceSnapshotHash"],
        "budget and capability snapshot must use the same price snapshot",
      );
    }
    if (manifest.manifestHash !== computeDesignerRunManifestHash(manifest)) {
      issue(["manifestHash"], "run manifest hash does not match the manifest content");
    }
  });

export type DesignerRunManifest = z.infer<typeof DesignerRunManifestSchema>;

export const DesignCandidateSchema = z.strictObject({
  candidateSlotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  assignmentId: z.string().regex(DESIGNER_ASSIGNMENT_ID_PATTERN),
  arm: DesignerArmSchema,
  family: FamilySchema,
  modality: ModalitySchema,
  difficulty: DifficultySchema,
  firstAttemptVerdict: DesignerCandidateVerdictSchema.nullable(),
  finalVerdict: DesignerCandidateVerdictSchema.nullable(),
  missingReason: z.string().min(1).max(500).nullable(),
});
export type DesignCandidate = z.infer<typeof DesignCandidateSchema>;

export const DESIGNER_SKIN_THEMES = [
  "garden",
  "space",
  "ocean",
  "kitchen",
] as const;
export type DesignerSkinTheme = (typeof DESIGNER_SKIN_THEMES)[number];
export const DesignerSkinThemeSchema = z.enum(DESIGNER_SKIN_THEMES);

export const DESIGNER_SKIN_LABELS = [
  "Rose",
  "Tulip",
  "Daisy",
  "Lily",
  "Fern",
  "Ivy",
  "Moss",
  "Sage",
  "Clover",
  "Orchid",
  "Willow",
  "Cedar",
  "Mars",
  "Venus",
  "Earth",
  "Luna",
  "Orbit",
  "Comet",
  "Nebula",
  "Nova",
  "Pulsar",
  "Cosmos",
  "Meteor",
  "Saturn",
  "Coral",
  "Reef",
  "Tide",
  "Wave",
  "Shell",
  "Kelp",
  "Pearl",
  "Lagoon",
  "Current",
  "Anemone",
  "Marlin",
  "Abyss",
  "Basil",
  "Thyme",
  "Cocoa",
  "Honey",
  "Lemon",
  "Olive",
  "Pepper",
  "Saffron",
  "Vanilla",
  "Ginger",
  "Mint",
  "Nutmeg",
] as const;
export type DesignerSkinLabel = (typeof DESIGNER_SKIN_LABELS)[number];
export const DesignerSkinLabelSchema = z.enum(DESIGNER_SKIN_LABELS);

export const DESIGNER_SKIN_THEME_LABELS: Readonly<
  Record<DesignerSkinTheme, readonly DesignerSkinLabel[]>
> = {
  garden: DESIGNER_SKIN_LABELS.slice(0, 12),
  space: DESIGNER_SKIN_LABELS.slice(12, 24),
  ocean: DESIGNER_SKIN_LABELS.slice(24, 36),
  kitchen: DESIGNER_SKIN_LABELS.slice(36, 48),
};

export const DESIGNER_SKIN_ENTITY_IDS = {
  ranking: ["item-0", "item-1", "item-2", "item-3", "item-4"],
  matching: [
    "person-0",
    "person-1",
    "person-2",
    "person-3",
    "pet-0",
    "pet-1",
    "pet-2",
    "pet-3",
    "color-0",
    "color-1",
    "color-2",
    "color-3",
  ],
  scheduling: [
    "event-0",
    "event-1",
    "event-2",
    "event-3",
    "resource-0",
    "resource-1",
  ],
  truth: ["person-0", "person-1", "person-2", "person-3"],
  arithmetic: ["var-x", "var-y", "var-z"],
  matrix: ["glyph-0", "glyph-1", "glyph-2", "glyph-3"],
  transforms: ["tile", "operation-0", "operation-1"],
  paths: ["start", "goal"],
  symmetry: ["tile", "axis"],
  counting: ["shape-0", "shape-1", "shape-2"],
} as const satisfies Readonly<Record<Family, readonly [string, ...string[]]>>;

export const PresentationSkinSchema = z.strictObject({
  theme: DesignerSkinThemeSchema,
  labels: z
    .array(
      z.strictObject({
        entityId: z.string().min(1).max(64),
        label: DesignerSkinLabelSchema,
      }),
    )
    .min(1)
    .max(12),
});
export type PresentationSkin = z.infer<typeof PresentationSkinSchema>;

export interface DesignProposalSchemaOptions {
  readonly skinEnabled: boolean;
}

export type DesignProposal = {
  readonly [F in Family]: {
    readonly family: F;
    readonly difficulty: Difficulty;
    readonly spec: FamilySpecByFamily[F];
    readonly designIntent: string | null;
    readonly presentationSkin: PresentationSkin | null;
  };
}[Family];

export function designerSkinEntityIdsForDifficulty(
  family: Family,
  difficulty: Difficulty,
): readonly string[] {
  switch (family) {
    case "ranking":
      return DESIGNER_SKIN_ENTITY_IDS.ranking.slice(
        0,
        difficulty === 1 ? 4 : 5,
      );
    case "truth":
      return DESIGNER_SKIN_ENTITY_IDS.truth.slice(
        0,
        difficulty === 1 ? 3 : 4,
      );
    case "transforms":
      return difficulty === 3
        ? DESIGNER_SKIN_ENTITY_IDS.transforms
        : ["tile", "operation-0"];
    case "counting":
      return DESIGNER_SKIN_ENTITY_IDS.counting.slice(
        0,
        difficulty === 3 ? 3 : 2,
      );
    default:
      return DESIGNER_SKIN_ENTITY_IDS[family];
  }
}

export function presentationSkinSchemaFor(
  family: Family,
  difficulty: Difficulty,
): z.ZodType<PresentationSkin> {
  const entityIds = designerSkinEntityIdsForDifficulty(family, difficulty);
  return z.strictObject({
    theme: DesignerSkinThemeSchema,
    labels: z
      .array(
        z.strictObject({
          entityId: z.enum([...entityIds]),
          label: DesignerSkinLabelSchema,
        }),
      )
      .length(entityIds.length),
  });
}

export function designProposalSchemaFor(
  family: Family,
  difficulty: Difficulty,
  options: DesignProposalSchemaOptions,
): z.ZodType<DesignProposal> {
  const schema = z.strictObject({
    family: z.literal(family),
    difficulty: z.literal(difficulty),
    spec: FAMILY_SPEC_SCHEMAS[family],
    designIntent: z.string().max(400).nullable(),
    presentationSkin: options.skinEnabled
      ? presentationSkinSchemaFor(family, difficulty).nullable()
      : z.null(),
  });
  return schema as unknown as z.ZodType<DesignProposal>;
}

export function designProposalSchemaName(
  family: Family,
  difficulty: Difficulty,
  options: DesignProposalSchemaOptions,
): string {
  return `puzzle_design_${family}_d${difficulty}${options.skinEnabled ? "_skin" : ""}`;
}

export type DesignerSkinIssue = {
  readonly entityId: string;
  readonly message: string;
};

export class DesignerSkinError extends Error {
  readonly code = "SKIN_INVALID" as const;
  readonly issues: readonly DesignerSkinIssue[];

  constructor(issues: readonly DesignerSkinIssue[]) {
    super(
      issues.length === 0
        ? "presentation skin is invalid"
        : `presentation skin is invalid: ${issues.map((issue) => issue.message).join("; ")}`,
    );
    this.name = "DesignerSkinError";
    this.issues = issues;
  }
}

export function designerSkinEntityIdsForSpec(
  family: Family,
  spec: FamilySpec,
): readonly string[] {
  switch (family) {
    case "ranking": {
      const ranking = spec as FamilySpecByFamily["ranking"];
      return Array.from(
        { length: ranking.size },
        (_value, index) => `item-${index}`,
      );
    }
    case "matching":
      return DESIGNER_SKIN_ENTITY_IDS.matching;
    case "scheduling":
      return DESIGNER_SKIN_ENTITY_IDS.scheduling;
    case "truth": {
      const truth = spec as FamilySpecByFamily["truth"];
      return Array.from(
        { length: truth.people },
        (_value, index) => `person-${index}`,
      );
    }
    case "arithmetic":
      return DESIGNER_SKIN_ENTITY_IDS.arithmetic;
    case "matrix":
      return DESIGNER_SKIN_ENTITY_IDS.matrix;
    case "transforms": {
      const transforms = spec as FamilySpecByFamily["transforms"];
      return transforms.operations.length > 1
        ? DESIGNER_SKIN_ENTITY_IDS.transforms
        : ["tile", "operation-0"];
    }
    case "paths":
      return DESIGNER_SKIN_ENTITY_IDS.paths;
    case "symmetry":
      return DESIGNER_SKIN_ENTITY_IDS.symmetry;
    case "counting": {
      const counting = spec as FamilySpecByFamily["counting"];
      return Array.from(
        { length: counting.shapes.length },
        (_value, index) => `shape-${index}`,
      );
    }
  }
}

export function validatePresentationSkin(
  family: Family,
  spec: FamilySpec,
  skin: PresentationSkin | null,
): void {
  if (skin === null) {
    return;
  }
  const required = designerSkinEntityIdsForSpec(family, spec);
  const requiredSet = new Set(required);
  const themeLabels = new Set<string>(DESIGNER_SKIN_THEME_LABELS[skin.theme]);
  const issues: DesignerSkinIssue[] = [];
  const seen = new Set<string>();
  if (skin.labels.length !== required.length) {
    issues.push({
      entityId: "*",
      message: `skin must label exactly ${required.length} entities, received ${skin.labels.length}`,
    });
  }
  for (const entry of skin.labels) {
    if (!requiredSet.has(entry.entityId)) {
      issues.push({
        entityId: entry.entityId,
        message: `entity ${entry.entityId} is not required by the ${family} spec`,
      });
      continue;
    }
    if (seen.has(entry.entityId)) {
      issues.push({
        entityId: entry.entityId,
        message: `entity ${entry.entityId} is labeled more than once`,
      });
      continue;
    }
    seen.add(entry.entityId);
    if (!themeLabels.has(entry.label)) {
      issues.push({
        entityId: entry.entityId,
        message: `label ${entry.label} is not in the ${skin.theme} catalog`,
      });
    }
  }
  for (const entityId of required) {
    if (!seen.has(entityId)) {
      issues.push({
        entityId,
        message: `entity ${entityId} has no catalog label`,
      });
    }
  }
  if (new Set(skin.labels.map((entry) => entry.label)).size !== skin.labels.length) {
    issues.push({
      entityId: "*",
      message: "skin labels must be distinct",
    });
  }
  if (issues.length > 0) {
    throw new DesignerSkinError(issues);
  }
}
