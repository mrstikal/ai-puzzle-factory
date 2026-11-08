import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DIFFICULTIES,
  FAMILIES,
  MODALITY_BY_FAMILY,
  type Difficulty,
  type Family,
} from "../domain/experiment.js";
import {
  parseFamilySpec,
  safeParseFamilySpec,
  type FamilySpec,
} from "../domain/spec.js";
import type { DesignerPlanManifest } from "../domain/design.js";
import { CanonicalStructureSchema } from "../families/contracts.js";
import {
  FeatureMultisetSchema,
  SolverLimitError,
  canonicalStructureHash,
  extractStructureFeatures,
} from "../families/canonicalize.js";
import { productionRegistry } from "../families/registry.js";
import { serializeScene } from "../render/svg.js";
import { deriveStreamSeed } from "../util/random.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import {
  ArithmeticConstructionError,
  constructArithmeticSpec,
} from "../families/arithmetic/engine.js";
import {
  CountingConstructionError,
  constructCountingSpec,
} from "../families/counting/engine.js";
import {
  MatchingConstructionError,
  constructMatchingSpec,
} from "../families/matching/engine.js";
import {
  MatrixConstructionError,
  constructMatrixSpec,
} from "../families/matrix/engine.js";
import {
  PathsConstructionError,
  constructPathsSpec,
} from "../families/paths/engine.js";
import {
  RankingConstructionError,
  constructRankingSpec,
} from "../families/ranking/engine.js";
import {
  SchedulingConstructionError,
  constructSchedulingSpec,
} from "../families/scheduling/engine.js";
import {
  SymmetryConstructionError,
  constructSymmetrySpec,
} from "../families/symmetry/engine.js";
import {
  TransformsConstructionError,
  constructTransformsSpec,
} from "../families/transforms/engine.js";
import {
  TruthConstructionError,
  constructTruthSpec,
} from "../families/truth/engine.js";

export const BASELINE_REFERENCE_VERSION = "p48-reference-v1" as const;
export const FROZEN_FIXTURE_PROTOCOL_VERSION = "1.0.0" as const;
export const FROZEN_FIXTURE_ROOT_SEED = "puzzle-poc-v1" as const;
export const FROZEN_OUTCOMES_PER_FAMILY = 100 as const;
export const FROZEN_MIN_VERIFIED_PER_FAMILY = 95 as const;
export const BASELINE_CONSTRUCTION_FAILURE_CODE =
  "BASELINE_CONSTRUCTION_FAILED" as const;

export const FROZEN_DIFFICULTY_PATTERN = [
  ...Array.from({ length: 34 }, () => 1 as Difficulty),
  ...Array.from({ length: 33 }, () => 2 as Difficulty),
  ...Array.from({ length: 33 }, () => 3 as Difficulty),
] as const;

export type BaselineSource = "frozen_fixture" | "cohort";
export const BaselineSourceSchema = z.enum(["frozen_fixture", "cohort"]);

export type BaselineStatus =
  | "constructed"
  | "construction_failed"
  | "infrastructure_error";
export const BaselineStatusSchema = z.enum([
  "constructed",
  "construction_failed",
  "infrastructure_error",
]);

export const BaselineSolverEvidenceSchema = z.strictObject({
  solutionCount: z.number().int().nonnegative(),
  answerCount: z.number().int().nonnegative(),
  verified: z.boolean(),
});
export type BaselineSolverEvidence = z.infer<
  typeof BaselineSolverEvidenceSchema
>;

export const BaselineOptionsEvidenceSchema = z.strictObject({
  labels: z.array(z.string().min(1).max(1)).length(4),
  distinct: z.boolean(),
  verifiedKeyLabel: z.string().min(1).max(1),
  optionsHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BaselineOptionsEvidence = z.infer<
  typeof BaselineOptionsEvidenceSchema
>;

export const BaselineRendererEvidenceSchema = z.strictObject({
  version: z.string().min(1).max(100),
  sceneHash: z.string().regex(/^[0-9a-f]{64}$/),
  svgHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BaselineRendererEvidence = z.infer<
  typeof BaselineRendererEvidenceSchema
>;

export const BaselineOutcomeSchema = z
  .strictObject({
    kind: z.literal("baseline_outcome"),
    source: BaselineSourceSchema,
    sourceIndex: z.number().int().positive().max(100),
    assignmentId: z
      .string()
      .regex(/^design-(text|svg)-[a-z]+-\d{2}$/)
      .nullable(),
    family: z.enum(FAMILIES),
    modality: z.enum(["text", "svg"]),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    seed: z.string().regex(/^[0-9a-f]{64}$/),
    status: BaselineStatusSchema,
    failureCode: z
      .enum([BASELINE_CONSTRUCTION_FAILURE_CODE, "INFRASTRUCTURE_ERROR"])
      .nullable(),
    failureMessage: z.string().min(1).max(2_000).nullable(),
    spec: z.unknown().nullable(),
    specHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    canonicalStructure: CanonicalStructureSchema.nullable(),
    structuralFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    features: FeatureMultisetSchema.nullable(),
    trace: z.record(z.string(), z.unknown()).nullable(),
    drawsUsed: z.number().int().nonnegative().nullable(),
    solver: BaselineSolverEvidenceSchema.nullable(),
    options: BaselineOptionsEvidenceSchema.nullable(),
    renderer: BaselineRendererEvidenceSchema.nullable(),
    presentation: z.literal("pending"),
    verdict: z.literal("inconclusive"),
    pendingChecks: z.array(z.literal("presentation")).max(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .superRefine((outcome, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (outcome.modality !== MODALITY_BY_FAMILY[outcome.family]) {
      issue(["modality"], "baseline modality must match its family");
    }
    if (outcome.source === "cohort" && outcome.assignmentId === null) {
      issue(["assignmentId"], "cohort baseline outcomes require an assignment ID");
    }
    if (outcome.source === "frozen_fixture" && outcome.assignmentId !== null) {
      issue(["assignmentId"], "frozen fixture outcomes have no assignment ID");
    }
    if (outcome.status === "constructed") {
      if (
        outcome.failureCode !== null ||
        outcome.failureMessage !== null ||
        outcome.spec === null ||
        outcome.specHash === null ||
        outcome.canonicalStructure === null ||
        outcome.structuralFingerprint === null ||
        outcome.features === null ||
        outcome.features.length === 0 ||
        outcome.solver === null ||
        outcome.options === null ||
        outcome.contentHash === null
      ) {
        issue(["status"], "constructed outcomes require complete verified evidence");
        return;
      }
      if (outcome.solver.solutionCount !== 1 || outcome.solver.answerCount !== 1) {
        issue(["solver"], "constructed baseline outcomes require one complete solution");
      }
      if (!outcome.solver.verified) {
        issue(["solver", "verified"], "constructed baseline outcomes must be independently verified");
      }
      if (!outcome.options.distinct) {
        issue(["options", "distinct"], "constructed baseline options must be distinct");
      }
      if (outcome.options.labels.join("") !== "ABCD") {
        issue(["options", "labels"], "baseline options must be labeled A-D in order");
      }
      if (outcome.pendingChecks.join(",") !== "presentation") {
        issue(["pendingChecks"], "constructed baseline outcomes wait for presentation");
      }
      if (outcome.modality === "svg" && outcome.renderer === null) {
        issue(["renderer"], "SVG baseline outcomes require renderer evidence");
      }
      if (outcome.modality === "text" && outcome.renderer !== null) {
        issue(["renderer"], "text baseline outcomes cannot carry renderer evidence");
      }
      const parsed = safeParseFamilySpec(outcome.family, outcome.spec);
      if (!parsed.success) {
        issue(["spec"], `baseline spec does not satisfy the ${outcome.family} schema`);
        return;
      }
      if (outcome.canonicalStructure.family !== outcome.family) {
        issue(["canonicalStructure", "family"], "canonical structure family mismatch");
      }
      if (outcome.structuralFingerprint !== canonicalStructureHash(outcome.canonicalStructure)) {
        issue(["structuralFingerprint"], "structural fingerprint does not match canonical structure");
      }
      const features = extractStructureFeatures(outcome.canonicalStructure);
      if (canonicalJson(features) !== canonicalJson(outcome.features)) {
        issue(["features"], "features do not match canonical structure");
      }
      if (outcome.specHash !== sha256Hex(canonicalJson(parsed.data))) {
        issue(["specHash"], "spec hash does not match the parsed spec");
      }
      if (outcome.trace !== null) {
        const draws = outcome.trace.drawsUsed;
        if (typeof draws === "number" && outcome.drawsUsed !== draws) {
          issue(["drawsUsed"], "drawsUsed must match the construction trace");
        }
      }
    } else {
      if (
        outcome.failureCode === null ||
        outcome.failureMessage === null ||
        outcome.spec !== null ||
        outcome.specHash !== null ||
        outcome.canonicalStructure !== null ||
        outcome.structuralFingerprint !== null ||
        outcome.features !== null ||
        outcome.trace !== null ||
        outcome.drawsUsed !== null ||
        outcome.solver !== null ||
        outcome.options !== null ||
        outcome.renderer !== null ||
        outcome.contentHash !== null
      ) {
        issue(["status"], "failed outcomes cannot carry constructed evidence");
      }
      if (outcome.pendingChecks.length !== 0) {
        issue(["pendingChecks"], "failed baseline outcomes are not pending presentation");
      }
    }
    if (outcome.status === "construction_failed" && outcome.failureCode !== BASELINE_CONSTRUCTION_FAILURE_CODE) {
      issue(["failureCode"], "bounded baseline failure must use BASELINE_CONSTRUCTION_FAILED");
    }
    if (outcome.status === "infrastructure_error" && outcome.failureCode !== "INFRASTRUCTURE_ERROR") {
      issue(["failureCode"], "infrastructure failures must use INFRASTRUCTURE_ERROR");
    }
  });

export type BaselineOutcome = z.infer<typeof BaselineOutcomeSchema>;

export const BaselineFamilyCoverageSchema = z.strictObject({
  family: z.enum(FAMILIES),
  outcomes: z.number().int().nonnegative(),
  constructed: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  infrastructureErrors: z.number().int().nonnegative(),
  distinctFingerprints: z.number().int().nonnegative(),
  difficultyOutcomes: z.strictObject({
    1: z.number().int().nonnegative(),
    2: z.number().int().nonnegative(),
    3: z.number().int().nonnegative(),
  }),
  difficultyConstructed: z.strictObject({
    1: z.number().int().nonnegative(),
    2: z.number().int().nonnegative(),
    3: z.number().int().nonnegative(),
  }),
  coverageSatisfied: z.boolean(),
});
export type BaselineFamilyCoverage = z.infer<
  typeof BaselineFamilyCoverageSchema
>;

export const FrozenReferenceDatasetSchema = z
  .strictObject({
    kind: z.literal("design_frozen_reference"),
    version: z.literal(BASELINE_REFERENCE_VERSION),
    fixtureProtocolVersion: z.literal(FROZEN_FIXTURE_PROTOCOL_VERSION),
    rootSeed: z.literal(FROZEN_FIXTURE_ROOT_SEED),
    families: z.array(z.enum(FAMILIES)).length(FAMILIES.length),
    outcomesPerFamily: z.literal(FROZEN_OUTCOMES_PER_FAMILY),
    outcomes: z.array(BaselineOutcomeSchema).length(
      FAMILIES.length * FROZEN_OUTCOMES_PER_FAMILY,
    ),
    coverage: z.array(BaselineFamilyCoverageSchema).length(FAMILIES.length),
    referenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((dataset, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (dataset.families.join(",") !== FAMILIES.join(",")) {
      issue(["families"], "frozen reference must use the stable family order");
    }
    for (const [index, outcome] of dataset.outcomes.entries()) {
      const familyIndex = Math.floor(index / FROZEN_OUTCOMES_PER_FAMILY);
      const within = index % FROZEN_OUTCOMES_PER_FAMILY;
      const family = FAMILIES[familyIndex];
      if (family === undefined) {
        issue(["outcomes", index], "outcome index exceeds the family list");
        continue;
      }
      if (outcome.source !== "frozen_fixture") {
        issue(["outcomes", index, "source"], "frozen outcomes use source=frozen_fixture");
      }
      if (outcome.sourceIndex !== within + 1) {
        issue(["outcomes", index, "sourceIndex"], `expected ${within + 1}`);
      }
      if (outcome.family !== family) {
        issue(["outcomes", index, "family"], `expected ${family}`);
      }
      if (outcome.difficulty !== FROZEN_DIFFICULTY_PATTERN[within]) {
        issue(
          ["outcomes", index, "difficulty"],
          `expected ${FROZEN_DIFFICULTY_PATTERN[within]}`,
        );
      }
    }
    for (const [index, coverage] of dataset.coverage.entries()) {
      const family = FAMILIES[index];
      if (family === undefined || coverage.family !== family) {
        issue(["coverage", index, "family"], "coverage must follow family order");
        continue;
      }
      const familyOutcomes = dataset.outcomes.filter(
        (outcome) => outcome.family === family,
      );
      const constructed = familyOutcomes.filter(
        (outcome) => outcome.status === "constructed",
      );
      const expected = {
        outcomes: familyOutcomes.length,
        constructed: constructed.length,
        verified: constructed.filter((outcome) => outcome.solver?.verified === true).length,
        failed: familyOutcomes.filter(
          (outcome) => outcome.status === "construction_failed",
        ).length,
        infrastructureErrors: familyOutcomes.filter(
          (outcome) => outcome.status === "infrastructure_error",
        ).length,
        distinctFingerprints: new Set(
          constructed
            .map((outcome) => outcome.structuralFingerprint)
            .filter((hash): hash is string => hash !== null),
        ).size,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (coverage[key as keyof typeof expected] !== value) {
          issue(
            ["coverage", index, key],
            `expected ${value}, received ${String(coverage[key as keyof typeof expected])}`,
          );
        }
      }
      for (const difficulty of DIFFICULTIES) {
        const expectedOutcomes = FROZEN_DIFFICULTY_PATTERN.filter(
          (value) => value === difficulty,
        ).length;
        if (coverage.difficultyOutcomes[difficulty] !== expectedOutcomes) {
          issue(
            ["coverage", index, "difficultyOutcomes", difficulty],
            `expected ${expectedOutcomes}`,
          );
        }
        const expectedConstructed = constructed.filter(
          (outcome) => outcome.difficulty === difficulty,
        ).length;
        if (coverage.difficultyConstructed[difficulty] !== expectedConstructed) {
          issue(
            ["coverage", index, "difficultyConstructed", difficulty],
            `expected ${expectedConstructed}`,
          );
        }
      }
      if (coverage.coverageSatisfied !== (expected.verified >= FROZEN_MIN_VERIFIED_PER_FAMILY)) {
        issue(["coverage", index, "coverageSatisfied"], "coverage flag mismatch");
      }
    }
    if (dataset.referenceHash !== computeFrozenReferenceHash(dataset)) {
      issue(["referenceHash"], "reference hash does not match the dataset");
    }
  });

export type FrozenReferenceDataset = z.infer<
  typeof FrozenReferenceDatasetSchema
>;

export const CohortReferenceDatasetSchema = z
  .strictObject({
    kind: z.literal("design_cohort_reference"),
    version: z.literal(BASELINE_REFERENCE_VERSION),
    rootSeed: z.string().min(1).max(128),
    outcomes: z.array(BaselineOutcomeSchema).length(100),
    coverage: z.array(BaselineFamilyCoverageSchema).length(FAMILIES.length),
    cohortHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((dataset, ctx) => {
    for (const [index, outcome] of dataset.outcomes.entries()) {
      if (outcome.source !== "cohort") {
        ctx.addIssue({
          code: "custom",
          path: ["outcomes", index, "source"],
          message: "cohort reference outcomes use source=cohort",
        });
      }
      if (outcome.assignmentId === null) {
        ctx.addIssue({
          code: "custom",
          path: ["outcomes", index, "assignmentId"],
          message: "cohort reference outcomes require an assignment ID",
        });
      }
    }
    if (dataset.cohortHash !== computeCohortReferenceHash(dataset)) {
      ctx.addIssue({
        code: "custom",
        path: ["cohortHash"],
        message: "cohort hash does not match the dataset",
      });
    }
  });

export type CohortReferenceDataset = z.infer<
  typeof CohortReferenceDatasetSchema
>;

export const ReferenceManifestSchema = z.strictObject({
  kind: z.literal("design_reference_manifest"),
  version: z.literal(BASELINE_REFERENCE_VERSION),
  frozenPath: z.string().min(1).max(500),
  cohortPath: z.string().min(1).max(500),
  galleryPath: z.string().min(1).max(500),
  frozenHash: z.string().regex(/^[0-9a-f]{64}$/),
  cohortHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReferenceManifest = z.infer<typeof ReferenceManifestSchema>;

export class BaselineInfrastructureError extends Error {
  readonly code = "BASELINE_INFRASTRUCTURE_ERROR" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BaselineInfrastructureError";
  }
}

type Construction = {
  readonly spec: FamilySpec;
  readonly trace: unknown;
};

type ConstructionFunction = (
  family: Family,
  seed: string,
  difficulty: Difficulty,
) => Construction;

function isConstructionError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof RankingConstructionError ||
    error instanceof MatchingConstructionError ||
    error instanceof SchedulingConstructionError ||
    error instanceof TruthConstructionError ||
    error instanceof ArithmeticConstructionError ||
    error instanceof MatrixConstructionError ||
    error instanceof TransformsConstructionError ||
    error instanceof PathsConstructionError ||
    error instanceof SymmetryConstructionError ||
    error instanceof CountingConstructionError
  );
}

function constructBaselineSpec(
  family: Family,
  seed: string,
  difficulty: Difficulty,
): Construction {
  switch (family) {
    case "ranking":
      return constructRankingSpec(seed, difficulty);
    case "matching":
      return constructMatchingSpec(seed, difficulty);
    case "scheduling":
      return constructSchedulingSpec(seed, difficulty);
    case "truth":
      return constructTruthSpec(seed, difficulty);
    case "arithmetic":
      return constructArithmeticSpec(seed, difficulty);
    case "matrix":
      return constructMatrixSpec(seed, difficulty);
    case "transforms":
      return constructTransformsSpec(seed, difficulty);
    case "paths":
      return constructPathsSpec(seed, difficulty);
    case "symmetry":
      return constructSymmetrySpec(seed, difficulty);
    case "counting":
      return constructCountingSpec(seed, difficulty);
  }
}

function failedOutcome(input: {
  readonly source: BaselineSource;
  readonly sourceIndex: number;
  readonly assignmentId: string | null;
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly seed: string;
  readonly failureCode: typeof BASELINE_CONSTRUCTION_FAILURE_CODE;
  readonly failureMessage: string;
}): BaselineOutcome {
  return BaselineOutcomeSchema.parse({
    kind: "baseline_outcome",
    source: input.source,
    sourceIndex: input.sourceIndex,
    assignmentId: input.assignmentId,
    family: input.family,
    modality: MODALITY_BY_FAMILY[input.family],
    difficulty: input.difficulty,
    seed: input.seed,
    status: "construction_failed",
    failureCode: input.failureCode,
    failureMessage: input.failureMessage,
    spec: null,
    specHash: null,
    canonicalStructure: null,
    structuralFingerprint: null,
    features: null,
    trace: null,
    drawsUsed: null,
    solver: null,
    options: null,
    renderer: null,
    presentation: "pending",
    verdict: "inconclusive",
    pendingChecks: [],
    contentHash: null,
  });
}

export interface BuildBaselineOutcomeInput {
  readonly source: BaselineSource;
  readonly sourceIndex: number;
  readonly assignmentId?: string | null;
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly seed: string;
  readonly construct?: ConstructionFunction;
}

export function buildBaselineOutcome(
  input: BuildBaselineOutcomeInput,
): BaselineOutcome {
  const construct = input.construct ?? constructBaselineSpec;
  let construction: Construction;
  try {
    construction = construct(input.family, input.seed, input.difficulty);
  } catch (error) {
    if (isConstructionError(error)) {
      return failedOutcome({
        source: input.source,
        sourceIndex: input.sourceIndex,
        assignmentId: input.assignmentId ?? null,
        family: input.family,
        difficulty: input.difficulty,
        seed: input.seed,
        failureCode: BASELINE_CONSTRUCTION_FAILURE_CODE,
        failureMessage: `${error.name}: ${error.message}`,
      });
    }
    throw new BaselineInfrastructureError(
      `baseline construction infrastructure failure for ${input.family}`,
      { cause: error },
    );
  }

  try {
    const spec = parseFamilySpec(input.family, construction.spec);
    const engine = productionRegistry.getEngine(input.family);
    let solved;
    try {
      solved = engine.enumerateSolutions(spec);
    } catch (error) {
      if (error instanceof SolverLimitError) {
        return failedOutcome({
          source: input.source,
          sourceIndex: input.sourceIndex,
          assignmentId: input.assignmentId ?? null,
          family: input.family,
          difficulty: input.difficulty,
          seed: input.seed,
          failureCode: BASELINE_CONSTRUCTION_FAILURE_CODE,
          failureMessage: `solver limit during baseline verification: ${error.message}`,
        });
      }
      throw error;
    }
    if (
      solved.solutionCount !== 1 ||
      solved.answerCount !== 1 ||
      solved.correctAnswer === null ||
      !engine.verifyAnswer(spec, solved.correctAnswer)
    ) {
      return failedOutcome({
        source: input.source,
        sourceIndex: input.sourceIndex,
        assignmentId: input.assignmentId ?? null,
        family: input.family,
        difficulty: input.difficulty,
        seed: input.seed,
        failureCode: BASELINE_CONSTRUCTION_FAILURE_CODE,
        failureMessage: "baseline construction did not produce one independently verified answer",
      });
    }
    const options = engine.makeOptions(spec, solved.correctAnswer, input.seed);
    const labels = options.choices.map((choice) => choice.label);
    const distinctValues = new Set(
      options.choices.map((choice) => canonicalJson(choice.value)),
    ).size;
    const correctChoices = options.choices.filter((choice) =>
      engine.verifyAnswer(spec, choice.value),
    );
    if (
      options.choices.length !== 4 ||
      labels.join("") !== "ABCD" ||
      distinctValues !== 4 ||
      correctChoices.length !== 1
    ) {
      return failedOutcome({
        source: input.source,
        sourceIndex: input.sourceIndex,
        assignmentId: input.assignmentId ?? null,
        family: input.family,
        difficulty: input.difficulty,
        seed: input.seed,
        failureCode: BASELINE_CONSTRUCTION_FAILURE_CODE,
        failureMessage: "baseline construction did not produce four distinct options with one key",
      });
    }
    const canonicalStructure = engine.canonicalData(spec);
    const features = extractStructureFeatures(canonicalStructure);
    if (features.length === 0) {
      throw new BaselineInfrastructureError(
        `baseline ${input.family} produced empty structural features`,
      );
    }
    const structuralFingerprint = canonicalStructureHash(canonicalStructure);
    const specHash = sha256Hex(canonicalJson(spec));
    const optionsHash = sha256Hex(canonicalJson(options.choices));
    const contentHash = sha256Hex(
      canonicalJson({ spec, options: options.choices }),
    );
    let renderer: BaselineRendererEvidence | null = null;
    if (MODALITY_BY_FAMILY[input.family] === "svg") {
      const rendererContract = productionRegistry.getRenderer(
        input.family as Parameters<typeof productionRegistry.getRenderer>[0],
      );
      const scene = rendererContract.buildScene(spec, input.seed);
      rendererContract.assertScene(scene, spec, options);
      renderer = {
        version: rendererContract.version,
        sceneHash: sha256Hex(canonicalJson(scene)),
        svgHash: sha256Hex(serializeScene(scene as Parameters<typeof serializeScene>[0])),
      };
    }
    return BaselineOutcomeSchema.parse({
      kind: "baseline_outcome",
      source: input.source,
      sourceIndex: input.sourceIndex,
      assignmentId: input.assignmentId ?? null,
      family: input.family,
      modality: MODALITY_BY_FAMILY[input.family],
      difficulty: input.difficulty,
      seed: input.seed,
      status: "constructed",
      failureCode: null,
      failureMessage: null,
      spec,
      specHash,
      canonicalStructure,
      structuralFingerprint,
      features,
      trace:
        construction.trace !== null &&
        typeof construction.trace === "object" &&
        !Array.isArray(construction.trace)
          ? (construction.trace as Record<string, unknown>)
          : {},
      drawsUsed:
        construction.trace !== null &&
        typeof construction.trace === "object" &&
        !Array.isArray(construction.trace) &&
        typeof (construction.trace as Record<string, unknown>).drawsUsed === "number"
          ? ((construction.trace as Record<string, unknown>).drawsUsed as number)
          : null,
      solver: {
        solutionCount: solved.solutionCount,
        answerCount: solved.answerCount,
        verified: true,
      },
      options: {
        labels,
        distinct: true,
        verifiedKeyLabel: correctChoices[0]?.label ?? "",
        optionsHash,
      },
      renderer,
      presentation: "pending",
      verdict: "inconclusive",
      pendingChecks: ["presentation"],
      contentHash,
    });
  } catch (error) {
    if (error instanceof BaselineInfrastructureError) {
      throw error;
    }
    if (error instanceof z.ZodError) {
      throw new BaselineInfrastructureError(
        `baseline ${input.family} produced an invalid spec or evidence`,
        { cause: error },
      );
    }
    throw new BaselineInfrastructureError(
      `baseline ${input.family} evidence construction failed`,
      { cause: error },
    );
  }
}

export function summarizeBaselineCoverage(
  outcomes: readonly BaselineOutcome[],
  minimumVerified: (familyOutcomes: readonly BaselineOutcome[]) => number,
): BaselineFamilyCoverage[] {
  return FAMILIES.map((family) => {
    const familyOutcomes = outcomes.filter(
      (outcome) => outcome.family === family,
    );
    const constructed = familyOutcomes.filter(
      (outcome) => outcome.status === "constructed",
    );
    const difficultyOutcomes = {
      1: familyOutcomes.filter((outcome) => outcome.difficulty === 1).length,
      2: familyOutcomes.filter((outcome) => outcome.difficulty === 2).length,
      3: familyOutcomes.filter((outcome) => outcome.difficulty === 3).length,
    };
    const difficultyConstructed = {
      1: constructed.filter((outcome) => outcome.difficulty === 1).length,
      2: constructed.filter((outcome) => outcome.difficulty === 2).length,
      3: constructed.filter((outcome) => outcome.difficulty === 3).length,
    };
    const verified = constructed.filter(
      (outcome) => outcome.solver?.verified === true,
    ).length;
    return {
      family,
      outcomes: familyOutcomes.length,
      constructed: constructed.length,
      verified,
      failed: familyOutcomes.filter(
        (outcome) => outcome.status === "construction_failed",
      ).length,
      infrastructureErrors: familyOutcomes.filter(
        (outcome) => outcome.status === "infrastructure_error",
      ).length,
      distinctFingerprints: new Set(
        constructed
          .map((outcome) => outcome.structuralFingerprint)
          .filter((hash): hash is string => hash !== null),
      ).size,
      difficultyOutcomes,
      difficultyConstructed,
      coverageSatisfied: verified >= minimumVerified(familyOutcomes),
    };
  });
}

function computeFrozenReferenceHash(
  dataset: Omit<FrozenReferenceDataset, "referenceHash"> | FrozenReferenceDataset,
): string {
  const base = { ...dataset } as Record<string, unknown>;
  delete base.referenceHash;
  return sha256Hex(canonicalJson(base));
}

function computeCohortReferenceHash(
  dataset: Omit<CohortReferenceDataset, "cohortHash"> | CohortReferenceDataset,
): string {
  const base = { ...dataset } as Record<string, unknown>;
  delete base.cohortHash;
  return sha256Hex(canonicalJson(base));
}

export function frozenFixtureSeed(
  family: Family,
  index: number,
): string {
  if (!Number.isInteger(index) || index < 1 || index > FROZEN_OUTCOMES_PER_FAMILY) {
    throw new RangeError(`frozen fixture index must be 1..100, received ${index}`);
  }
  return deriveStreamSeed({
    protocolVersion: FROZEN_FIXTURE_PROTOCOL_VERSION,
    rootSeed: FROZEN_FIXTURE_ROOT_SEED,
    slotId: `${family}-fixture-${String(index).padStart(3, "0")}`,
    purpose: "spec",
  });
}

export function buildFrozenReference(): FrozenReferenceDataset {
  const outcomes: BaselineOutcome[] = [];
  for (const family of FAMILIES) {
    for (let index = 0; index < FROZEN_OUTCOMES_PER_FAMILY; index += 1) {
      const sourceIndex = index + 1;
      const difficulty = FROZEN_DIFFICULTY_PATTERN[index];
      if (difficulty === undefined) {
        throw new Error(`missing frozen difficulty for ${family} index ${sourceIndex}`);
      }
      outcomes.push(
        buildBaselineOutcome({
          source: "frozen_fixture",
          sourceIndex,
          family,
          difficulty,
          seed: frozenFixtureSeed(family, sourceIndex),
        }),
      );
    }
  }
  const coverage = summarizeBaselineCoverage(
    outcomes,
    () => FROZEN_MIN_VERIFIED_PER_FAMILY,
  );
  const base = {
    kind: "design_frozen_reference" as const,
    version: BASELINE_REFERENCE_VERSION,
    fixtureProtocolVersion: FROZEN_FIXTURE_PROTOCOL_VERSION,
    rootSeed: FROZEN_FIXTURE_ROOT_SEED,
    families: [...FAMILIES],
    outcomesPerFamily: FROZEN_OUTCOMES_PER_FAMILY,
    outcomes,
    coverage,
  };
  return FrozenReferenceDatasetSchema.parse({
    ...base,
    referenceHash: computeFrozenReferenceHash(base),
  });
}

export function buildCohortReference(
  plan: DesignerPlanManifest,
): CohortReferenceDataset {
  const outcomes: BaselineOutcome[] = [];
  for (const assignment of plan.assignments) {
    outcomes.push(
      buildBaselineOutcome({
        source: "cohort",
        sourceIndex: assignment.assignmentOrdinal,
        assignmentId: assignment.assignmentId,
        family: assignment.family,
        difficulty: assignment.difficulty,
        seed: assignment.assignmentSeed,
      }),
    );
  }
  const coverage = summarizeBaselineCoverage(
    outcomes,
    (familyOutcomes) => familyOutcomes.length,
  );
  const base = {
    kind: "design_cohort_reference" as const,
    version: BASELINE_REFERENCE_VERSION,
    rootSeed: plan.rootSeed,
    outcomes,
    coverage,
  };
  return CohortReferenceDatasetSchema.parse({
    ...base,
    cohortHash: computeCohortReferenceHash(base),
  });
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, "utf8");
  renameSync(temporary, path);
}

export interface WriteReferenceArtifactsInput {
  readonly outputDirectory: string;
  readonly frozen: FrozenReferenceDataset;
  readonly cohort: CohortReferenceDataset;
  readonly galleryHtml: string;
}

export function writeReferenceArtifacts(
  input: WriteReferenceArtifactsInput,
): ReferenceManifest {
  const frozenPath = join(input.outputDirectory, "frozen-reference.json");
  const cohortPath = join(input.outputDirectory, "cohort-reference.json");
  const galleryPath = join(input.outputDirectory, "reference-gallery.html");
  writeJsonAtomic(frozenPath, input.frozen);
  writeJsonAtomic(cohortPath, input.cohort);
  mkdirSync(dirname(galleryPath), { recursive: true });
  const temporaryGallery = `${galleryPath}.tmp-${process.pid}`;
  writeFileSync(temporaryGallery, input.galleryHtml, "utf8");
  renameSync(temporaryGallery, galleryPath);
  const manifest = ReferenceManifestSchema.parse({
    kind: "design_reference_manifest",
    version: BASELINE_REFERENCE_VERSION,
    frozenPath,
    cohortPath,
    galleryPath,
    frozenHash: input.frozen.referenceHash,
    cohortHash: input.cohort.cohortHash,
  });
  writeJsonAtomic(join(input.outputDirectory, "reference-manifest.json"), manifest);
  return manifest;
}

export function readFrozenReference(path: string): FrozenReferenceDataset {
  return FrozenReferenceDatasetSchema.parse(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
}

export function readCohortReference(path: string): CohortReferenceDataset {
  return CohortReferenceDatasetSchema.parse(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
}
