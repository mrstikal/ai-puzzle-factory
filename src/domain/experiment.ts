import { z } from "zod";
import { hashObjectExcluding } from "../util/hash.js";

export const PROTOCOL_VERSION = "1.0.0" as const;

export const TEXT_FAMILIES = [
  "ranking",
  "matching",
  "scheduling",
  "truth",
  "arithmetic",
] as const;

export const SVG_FAMILIES = [
  "matrix",
  "transforms",
  "paths",
  "symmetry",
  "counting",
] as const;

export const FAMILIES = [...TEXT_FAMILIES, ...SVG_FAMILIES] as const;

export type TextFamily = (typeof TEXT_FAMILIES)[number];
export type SvgFamily = (typeof SVG_FAMILIES)[number];
export type Family = (typeof FAMILIES)[number];

export const MODALITIES = ["text", "svg"] as const;
export type Modality = (typeof MODALITIES)[number];

export const LANES = ["spec_first", "ai_spec"] as const;
export type Lane = (typeof LANES)[number];

export const DIFFICULTIES = [1, 2, 3] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const RUN_KINDS = ["full", "smoke"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const ROOT_SEEDS: Readonly<Record<RunKind, string>> = {
  full: "puzzle-poc-v1",
  smoke: "puzzle-smoke-v1",
};

export const CALIBRATION_ROOT_SEED = "puzzle-calibration-v1";

export const REQUEST_ROLES = [
  "spec",
  "wording",
  "blind_text",
  "blind_vision",
  "alignment_text",
  "alignment_vision",
] as const;
export type RequestRole = (typeof REQUEST_ROLES)[number];

export const MAX_TRANSPORT_ATTEMPTS_PER_CALL = 3;

export const MODALITY_BY_FAMILY: Readonly<Record<Family, Modality>> = {
  ranking: "text",
  matching: "text",
  scheduling: "text",
  truth: "text",
  arithmetic: "text",
  matrix: "svg",
  transforms: "svg",
  paths: "svg",
  symmetry: "svg",
  counting: "svg",
};

export const FULL_DIFFICULTY_COUNTS: Readonly<
  Record<Modality, Readonly<Record<Lane, readonly [number, number, number]>>>
> = {
  text: {
    spec_first: [4, 3, 3],
    ai_spec: [3, 4, 3],
  },
  svg: {
    spec_first: [5, 5, 4],
    ai_spec: [2, 2, 2],
  },
};

export interface SmokeDifficulties {
  readonly specFirst: Difficulty;
  readonly aiSpec: Difficulty;
}

export function smokeDifficultyForFamily(familyIndex: number): SmokeDifficulties {
  const specFirst = DIFFICULTIES[familyIndex % DIFFICULTIES.length];
  if (specFirst === undefined) {
    throw new Error(`Invalid family index for smoke difficulty: ${familyIndex}`);
  }
  const aiSpec = DIFFICULTIES[specFirst % DIFFICULTIES.length];
  if (aiSpec === undefined) {
    throw new Error(`Invalid derived smoke difficulty for family index: ${familyIndex}`);
  }
  return { specFirst, aiSpec };
}

export const FamilySchema = z.enum(FAMILIES);
export const ModalitySchema = z.enum(MODALITIES);
export const LaneSchema = z.enum(LANES);
export const DifficultySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const RunKindSchema = z.enum(RUN_KINDS);
export const RequestRoleSchema = z.enum(REQUEST_ROLES);

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const Sha256Schema = z.string().regex(SHA256_PATTERN);
export const UsdSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

export const SLOT_ID_PATTERN =
  /^(text|svg)-(ranking|matching|scheduling|truth|arithmetic|matrix|transforms|paths|symmetry|counting)-\d{2}$/;

export const SlotPlanSchema = z.strictObject({
  slotId: z.string().regex(SLOT_ID_PATTERN),
  slotOrdinal: z.number().int().min(1).max(200),
  family: FamilySchema,
  modality: ModalitySchema,
  lane: LaneSchema,
  difficulty: DifficultySchema,
});

export type SlotPlan = z.infer<typeof SlotPlanSchema>;

export const QuotasSchema = z.strictObject({
  totalSlots: z.number().int().nonnegative(),
  textSlots: z.number().int().nonnegative(),
  svgSlots: z.number().int().nonnegative(),
  specFirstSlots: z.number().int().nonnegative(),
  aiSpecSlots: z.number().int().nonnegative(),
  slotsPerFamily: z.number().int().nonnegative(),
  textSpecFirstPerFamily: z.number().int().nonnegative(),
  textAiSpecPerFamily: z.number().int().nonnegative(),
  svgSpecFirstPerFamily: z.number().int().nonnegative(),
  svgAiSpecPerFamily: z.number().int().nonnegative(),
});

export type Quotas = z.infer<typeof QuotasSchema>;

export const DifficultyCountSchema = z.strictObject({
  family: FamilySchema,
  lane: LaneSchema,
  difficulty: DifficultySchema,
  count: z.number().int().nonnegative(),
});

export type DifficultyCount = z.infer<typeof DifficultyCountSchema>;

export const RequestEstimateSchema = z.strictObject({
  byRole: z.strictObject({
    spec: z.number().int().nonnegative(),
    wording: z.number().int().nonnegative(),
    blind_text: z.number().int().nonnegative(),
    blind_vision: z.number().int().nonnegative(),
    alignment_text: z.number().int().nonnegative(),
    alignment_vision: z.number().int().nonnegative(),
  }),
  totalLogicalCalls: z.number().int().nonnegative(),
  maxTransportAttempts: z.number().int().nonnegative(),
});

export type RequestEstimate = z.infer<typeof RequestEstimateSchema>;

export const PlanManifestSchema = z
  .strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runKind: RunKindSchema,
    rootSeed: z.string().min(1).max(128),
    slots: z.array(SlotPlanSchema).min(1).max(200),
    quotas: QuotasSchema,
    difficultyCounts: z.array(DifficultyCountSchema),
    requestEstimate: RequestEstimateSchema,
    planHash: Sha256Schema,
  })
  .superRefine((plan, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };

    const fixedSeed = ROOT_SEEDS[plan.runKind];
    if (plan.rootSeed !== fixedSeed) {
      issue(["rootSeed"], `expected ${fixedSeed} for ${plan.runKind} plans`);
    }

    const expected =
      plan.runKind === "full"
        ? {
            totalSlots: 200,
            textSlots: 100,
            svgSlots: 100,
            specFirstSlots: 120,
            aiSpecSlots: 80,
            slotsPerFamily: 20,
            textSpecFirstPerFamily: 10,
            textAiSpecPerFamily: 10,
            svgSpecFirstPerFamily: 14,
            svgAiSpecPerFamily: 6,
          }
        : {
            totalSlots: 20,
            textSlots: 10,
            svgSlots: 10,
            specFirstSlots: 10,
            aiSpecSlots: 10,
            slotsPerFamily: 2,
            textSpecFirstPerFamily: 1,
            textAiSpecPerFamily: 1,
            svgSpecFirstPerFamily: 1,
            svgAiSpecPerFamily: 1,
          };

    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (plan.quotas[key] !== expected[key]) {
        issue(["quotas", key], `expected ${expected[key]}, received ${plan.quotas[key]}`);
      }
    }

    if (plan.slots.length !== expected.totalSlots) {
      issue(["slots"], `expected ${expected.totalSlots} slots, received ${plan.slots.length}`);
    }

    const actual = {
      totalSlots: plan.slots.length,
      textSlots: plan.slots.filter((slot) => slot.modality === "text").length,
      svgSlots: plan.slots.filter((slot) => slot.modality === "svg").length,
      specFirstSlots: plan.slots.filter((slot) => slot.lane === "spec_first").length,
      aiSpecSlots: plan.slots.filter((slot) => slot.lane === "ai_spec").length,
    };
    for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
      if (plan.quotas[key] !== actual[key]) {
        issue(["quotas", key], `quota ${plan.quotas[key]} does not match slots ${actual[key]}`);
      }
    }

    const ids = new Set<string>();
    for (let index = 0; index < plan.slots.length; index += 1) {
      const slot = plan.slots[index];
      if (slot === undefined) {
        continue;
      }
      if (slot.slotOrdinal !== index + 1) {
        issue(["slots", index, "slotOrdinal"], `expected ${index + 1}`);
      }
      if (ids.has(slot.slotId)) {
        issue(["slots", index, "slotId"], `duplicate slot ID ${slot.slotId}`);
      }
      ids.add(slot.slotId);

      const expectedFamily = FAMILIES[Math.floor(index / expected.slotsPerFamily)];
      if (slot.family !== expectedFamily) {
        issue(["slots", index, "family"], `expected ${String(expectedFamily)}`);
      }
      const expectedModality = MODALITY_BY_FAMILY[slot.family];
      if (slot.modality !== expectedModality) {
        issue(["slots", index, "modality"], `expected ${expectedModality} for ${slot.family}`);
      }
      const suffix = String((index % expected.slotsPerFamily) + 1).padStart(2, "0");
      const expectedId = `${slot.modality}-${slot.family}-${suffix}`;
      if (slot.slotId !== expectedId) {
        issue(["slots", index, "slotId"], `expected ${expectedId}`);
      }
    }

    if (plan.runKind === "full") {
      for (const family of FAMILIES) {
        const modality = MODALITY_BY_FAMILY[family];
        for (const lane of LANES) {
          const counts = DIFFICULTIES.map(
            (difficulty) =>
              plan.slots.filter(
                (slot) =>
                  slot.family === family && slot.lane === lane && slot.difficulty === difficulty,
              ).length,
          );
          const expectedCounts = FULL_DIFFICULTY_COUNTS[modality][lane];
          if (
            counts[0] !== expectedCounts[0] ||
            counts[1] !== expectedCounts[1] ||
            counts[2] !== expectedCounts[2]
          ) {
            issue(
              ["slots"],
              `${family}/${lane} difficulty counts ${counts.join(",")} expected ${expectedCounts.join(",")}`,
            );
          }
        }
        const familyTotals = DIFFICULTIES.map(
          (difficulty) =>
            plan.slots.filter((slot) => slot.family === family && slot.difficulty === difficulty)
              .length,
        );
        if (
          familyTotals[0] !== 7 ||
          familyTotals[1] !== 7 ||
          familyTotals[2] !== 6
        ) {
          issue(
            ["slots"],
            `${family} difficulty totals ${familyTotals.join(",")} expected 7,7,6`,
          );
        }
      }
    } else {
      for (const [familyIndex, family] of FAMILIES.entries()) {
        const specSlots = plan.slots.filter(
          (slot) => slot.family === family && slot.lane === "spec_first",
        );
        const aiSlots = plan.slots.filter(
          (slot) => slot.family === family && slot.lane === "ai_spec",
        );
        if (specSlots.length !== 1 || aiSlots.length !== 1) {
          issue(["slots"], `${family} must have exactly one slot per lane in a smoke plan`);
          continue;
        }
        const expected = smokeDifficultyForFamily(familyIndex);
        if (specSlots[0]?.difficulty !== expected.specFirst) {
          issue(["slots"], `${family} spec_first difficulty must be ${expected.specFirst}`);
        }
        if (aiSlots[0]?.difficulty !== expected.aiSpec) {
          issue(["slots"], `${family} ai_spec difficulty must be ${expected.aiSpec}`);
        }
      }
    }

    let entryIndex = 0;
    for (const family of FAMILIES) {
      for (const lane of LANES) {
        for (const difficulty of DIFFICULTIES) {
          const entry = plan.difficultyCounts[entryIndex];
          const expectedCount = plan.slots.filter(
            (slot) =>
              slot.family === family && slot.lane === lane && slot.difficulty === difficulty,
          ).length;
          if (
            entry === undefined ||
            entry.family !== family ||
            entry.lane !== lane ||
            entry.difficulty !== difficulty
          ) {
            issue(
              ["difficultyCounts", entryIndex],
              `expected ${family}/${lane}/${difficulty}`,
            );
          } else if (entry.count !== expectedCount) {
            issue(
              ["difficultyCounts", entryIndex, "count"],
              `expected ${expectedCount}, received ${entry.count}`,
            );
          }
          entryIndex += 1;
        }
      }
    }
    if (plan.difficultyCounts.length !== entryIndex) {
      issue(
        ["difficultyCounts"],
        `expected ${entryIndex} entries, received ${plan.difficultyCounts.length}`,
      );
    }

    const derivedRoles = {
      spec: plan.slots.filter((slot) => slot.lane === "ai_spec").length,
      wording: plan.slots.length,
      blind_text: plan.slots.filter((slot) => slot.modality === "text").length,
      blind_vision: plan.slots.filter((slot) => slot.modality === "svg").length,
      alignment_text: plan.slots.filter((slot) => slot.modality === "text").length,
      alignment_vision: plan.slots.filter((slot) => slot.modality === "svg").length,
    };
    for (const role of REQUEST_ROLES) {
      if (plan.requestEstimate.byRole[role] !== derivedRoles[role]) {
        issue(
          ["requestEstimate", "byRole", role],
          `expected ${derivedRoles[role]}, received ${plan.requestEstimate.byRole[role]}`,
        );
      }
    }
    const totalLogicalCalls = REQUEST_ROLES.reduce(
      (total, role) => total + derivedRoles[role],
      0,
    );
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

    const recomputedPlanHash = hashObjectExcluding(plan, "planHash");
    if (plan.planHash !== recomputedPlanHash) {
      issue(["planHash"], "plan hash does not match the manifest content");
    }
  });

export type PlanManifest = z.infer<typeof PlanManifestSchema>;

export const THRESHOLDS = {
  textApprovalMin: 80,
  svgApprovalMin: 80,
  familyApprovalMin: 10,
  structuralUniquenessMin: 0.95,
  fingerprintCoverageMin: 0.8,
  costPerApprovedMaxUsd: "0.10",
  calibrationSensitivityMin: 0.9,
  calibrationSpecificityMin: 0.8,
  auditCoreSlotsMin: 32,
  auditApprovedCoreSlotsMin: 20,
  auditApprovedPerFamilyMin: 2,
  auditClearAndSolvedWithin180sMin: 0.8,
  rejectModalityApprovalBelow: 0.5,
  rejectCalibrationBelow: 0.5,
} as const;

export const ThresholdsSchema = z.strictObject({
  textApprovalMin: z.literal(THRESHOLDS.textApprovalMin),
  svgApprovalMin: z.literal(THRESHOLDS.svgApprovalMin),
  familyApprovalMin: z.literal(THRESHOLDS.familyApprovalMin),
  structuralUniquenessMin: z.literal(THRESHOLDS.structuralUniquenessMin),
  fingerprintCoverageMin: z.literal(THRESHOLDS.fingerprintCoverageMin),
  costPerApprovedMaxUsd: z.literal(THRESHOLDS.costPerApprovedMaxUsd),
  calibrationSensitivityMin: z.literal(THRESHOLDS.calibrationSensitivityMin),
  calibrationSpecificityMin: z.literal(THRESHOLDS.calibrationSpecificityMin),
  auditCoreSlotsMin: z.literal(THRESHOLDS.auditCoreSlotsMin),
  auditApprovedCoreSlotsMin: z.literal(THRESHOLDS.auditApprovedCoreSlotsMin),
  auditApprovedPerFamilyMin: z.literal(THRESHOLDS.auditApprovedPerFamilyMin),
  auditClearAndSolvedWithin180sMin: z.literal(THRESHOLDS.auditClearAndSolvedWithin180sMin),
  rejectModalityApprovalBelow: z.literal(THRESHOLDS.rejectModalityApprovalBelow),
  rejectCalibrationBelow: z.literal(THRESHOLDS.rejectCalibrationBelow),
});

export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const RoleConfigSchema = z.strictObject({
  model: z.string().min(1),
  provider: z.string().min(1),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const OutputLimitsSchema = z.strictObject({
  spec: z.literal(8192),
  wording: z.literal(8192),
  review: z.literal(4096),
});

export const RunManifestSchema = z
  .strictObject({
    plan: PlanManifestSchema,
    evidenceKind: z.enum(["mock", "live"]),
    runId: z.uuid(),
    roles: z.strictObject({
      generator: RoleConfigSchema,
      textReviewer: RoleConfigSchema,
      visionReviewer: RoleConfigSchema,
    }),
    outputLimits: OutputLimitsSchema,
    concurrency: z.union([z.literal(1), z.literal(2)]),
    budget: z.strictObject({
      maxCostUsd: UsdSchema,
      reservationMethod: z.string().min(1),
      priceSnapshotHash: Sha256Schema,
    }),
    hashes: z.strictObject({
      prompts: Sha256Schema,
      schema: Sha256Schema,
      source: Sha256Schema,
      font: Sha256Schema,
      dependencyLock: Sha256Schema,
    }),
    runtime: z.strictObject({
      node: z.string().min(1),
      npm: z.string().min(1),
      os: z.string().min(1),
      arch: z.string().min(1),
    }),
    thresholds: ThresholdsSchema,
    calibrationReference: z.string().min(1).nullable(),
    mockConfiguration: z
      .strictObject({
        synthetic: z.literal(true),
        description: z.string().min(1),
      })
      .nullable(),
    redacted: z.literal(true),
    createdAt: z.iso.datetime(),
    manifestHash: Sha256Schema,
  })
  .superRefine((manifest, ctx) => {
    if (manifest.roles.generator.model === manifest.roles.textReviewer.model) {
      ctx.addIssue({
        code: "custom",
        path: ["roles", "textReviewer", "model"],
        message: "the text reviewer model must differ from the generator model",
      });
    }
    if (manifest.roles.generator.model === manifest.roles.visionReviewer.model) {
      ctx.addIssue({
        code: "custom",
        path: ["roles", "visionReviewer", "model"],
        message: "the vision reviewer model must differ from the generator model",
      });
    }
    if (manifest.evidenceKind === "mock" && manifest.mockConfiguration === null) {
      ctx.addIssue({
        code: "custom",
        path: ["mockConfiguration"],
        message: "mock evidence requires an explicit synthetic mock configuration",
      });
    }
    if (manifest.evidenceKind === "live" && manifest.mockConfiguration !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["mockConfiguration"],
        message: "live evidence cannot carry a synthetic mock configuration",
      });
    }
    const recomputedManifestHash = computeRunManifestHash(manifest);
    if (manifest.manifestHash !== recomputedManifestHash) {
      ctx.addIssue({
        code: "custom",
        path: ["manifestHash"],
        message: "manifest hash does not match the redacted manifest content",
      });
    }
  });

export type RunManifest = z.infer<typeof RunManifestSchema>;

export function computeRunManifestHash(manifest: object): string {
  return hashObjectExcluding(manifest, "manifestHash");
}
