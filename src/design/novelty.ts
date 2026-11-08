import { z } from "zod";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
  type Difficulty,
  type Family,
  type Modality,
} from "../domain/experiment.js";
import {
  CandidateFingerprintSchema,
  FeatureComparisonSchema,
  type CandidateFingerprint,
  type FeatureComparison,
} from "../domain/candidate.js";
import { CanonicalStructureSchema } from "../families/contracts.js";
import {
  FeatureMultisetSchema,
  canonicalStructureHash,
  canonicalStructuresEqual,
  extractStructureFeatures,
} from "../families/canonicalize.js";
import { evaluateNearPair } from "../validation/duplicates.js";
import { productionRegistry } from "../families/registry.js";
import { parseFamilySpec } from "../domain/spec.js";
import type { DesignerArm } from "../domain/design.js";
import { DesignerArmSchema } from "../domain/design.js";
import { sha256Hex, canonicalJson } from "../util/hash.js";
import {
  type BaselineOutcome,
  type CohortReferenceDataset,
  type FrozenReferenceDataset,
} from "./baseline.js";

export const NOVELTY_ANNOTATIONS = [
  "baseline_duplicate",
  "near_baseline",
  "novel",
  "novelty_unknown",
] as const;
export type NoveltyAnnotation = (typeof NOVELTY_ANNOTATIONS)[number];
export const NoveltyAnnotationSchema = z.enum(NOVELTY_ANNOTATIONS);

export const NOVELTY_VIEWS = ["first", "final", "trajectory"] as const;
export type NoveltyView = (typeof NOVELTY_VIEWS)[number];
export const NoveltyViewSchema = z.enum(NOVELTY_VIEWS);

export type NoveltyErrorCode =
  | "INVALID_CANDIDATE"
  | "EMPTY_FEATURES"
  | "IDENTICAL_STRUCTURE_DIFFERENT_HASH"
  | "INVALID_REFERENCE"
  | "CROSS_FAMILY_REFERENCE";

export class NoveltyError extends Error {
  readonly code: NoveltyErrorCode;

  constructor(code: NoveltyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NoveltyError";
    this.code = code;
  }
}

export const NoveltyCandidateSchema = z
  .strictObject({
    candidateId: z.string().min(1).max(200),
    assignmentId: z.string().regex(/^design-(text|svg)-[a-z]+-\d{2}$/),
    arm: DesignerArmSchema,
    view: NoveltyViewSchema,
    family: z.enum(FAMILIES),
    modality: z.enum(["text", "svg"]),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    accepted: z.boolean(),
    spec: z.unknown(),
    specHash: z.string().regex(/^[0-9a-f]{64}$/),
    canonicalStructure: CanonicalStructureSchema,
    structuralFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    features: FeatureMultisetSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .superRefine((candidate, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (candidate.modality !== MODALITY_BY_FAMILY[candidate.family]) {
      issue(["modality"], "candidate modality must match its family");
    }
    if (candidate.canonicalStructure.family !== candidate.family) {
      issue(["canonicalStructure", "family"], "canonical structure family mismatch");
    }
    if (candidate.structuralFingerprint !== canonicalStructureHash(candidate.canonicalStructure)) {
      issue(["structuralFingerprint"], "structural fingerprint mismatch");
    }
    const features = extractStructureFeatures(candidate.canonicalStructure);
    if (features.length === 0) {
      issue(["features"], "candidate features cannot be empty");
    }
    if (canonicalJson(features) !== canonicalJson(candidate.features)) {
      issue(["features"], "features do not match canonical structure");
    }
  });
export type NoveltyCandidate = z.infer<typeof NoveltyCandidateSchema>;

export interface BuildNoveltyCandidateInput {
  readonly candidateId: string;
  readonly assignmentId: string;
  readonly arm: DesignerArm;
  readonly view: NoveltyView;
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly accepted: boolean;
  readonly spec: unknown;
  readonly contentHash?: string | null;
}

export function buildNoveltyCandidate(
  input: BuildNoveltyCandidateInput,
): NoveltyCandidate {
  const spec = parseFamilySpec(input.family, input.spec);
  const engine = productionRegistry.getEngine(input.family);
  const canonicalStructure = engine.canonicalData(spec);
  const features = extractStructureFeatures(canonicalStructure);
  if (features.length === 0) {
    throw new NoveltyError(
      "EMPTY_FEATURES",
      `candidate ${input.candidateId} produced no structural features`,
    );
  }
  return NoveltyCandidateSchema.parse({
    candidateId: input.candidateId,
    assignmentId: input.assignmentId,
    arm: input.arm,
    view: input.view,
    family: input.family,
    modality: MODALITY_BY_FAMILY[input.family],
    difficulty: input.difficulty,
    accepted: input.accepted,
    spec,
    specHash: sha256Hex(canonicalJson(spec)),
    canonicalStructure,
    structuralFingerprint: canonicalStructureHash(canonicalStructure),
    features,
    contentHash: input.contentHash ?? null,
  });
}

export const NoveltyMatchSchema = z.strictObject({
  source: z.enum(["frozen", "cohort"]),
  sourceIndex: z.number().int().positive().max(100),
  assignmentId: z.string().nullable(),
  kind: z.enum(["exact", "near"]),
  structureHash: z.string().regex(/^[0-9a-f]{64}$/),
  comparison: FeatureComparisonSchema.nullable(),
});
export type NoveltyMatch = z.infer<typeof NoveltyMatchSchema>;

export const NoveltyAnnotationResultSchema = z.strictObject({
  candidateId: z.string().min(1).max(200),
  assignmentId: z.string().min(1).max(200),
  arm: DesignerArmSchema,
  view: NoveltyViewSchema,
  family: z.enum(FAMILIES),
  modality: z.enum(["text", "svg"]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  annotation: NoveltyAnnotationSchema,
  exactFrozen: z.boolean(),
  exactCohort: z.boolean(),
  nearFrozen: z.boolean(),
  nearCohort: z.boolean(),
  exactMatchCount: z.number().int().nonnegative(),
  nearMatchCount: z.number().int().nonnegative(),
  matches: z.array(NoveltyMatchSchema).max(16),
  jaccardMin: z.number().min(0).max(1).nullable(),
  jaccardMax: z.number().min(0).max(1).nullable(),
  frozenComplete: z.boolean(),
  frozenCoverageSatisfied: z.boolean(),
  cohortComplete: z.boolean(),
  provisional: z.boolean(),
  reason: z.string().min(1).max(1_000),
});
export type NoveltyAnnotationResult = z.infer<
  typeof NoveltyAnnotationResultSchema
>;

export interface NoveltyReferenceFamilyCoverage {
  readonly outcomes: number;
  readonly constructed: number;
  readonly verified: number;
  readonly coverageSatisfied: boolean;
}

export interface NoveltyReferenceView {
  readonly source: "frozen" | "cohort";
  readonly complete: boolean;
  readonly coverageSatisfied: boolean;
  readonly outcomes: readonly BaselineOutcome[];
  readonly coverageByFamily: Readonly<Record<Family, NoveltyReferenceFamilyCoverage>>;
}

function coverageByFamily(
  coverage: readonly {
    readonly family: Family;
    readonly outcomes: number;
    readonly constructed: number;
    readonly verified: number;
    readonly coverageSatisfied: boolean;
  }[],
): Record<Family, NoveltyReferenceFamilyCoverage> {
  const result = {} as Record<Family, NoveltyReferenceFamilyCoverage>;
  for (const family of FAMILIES) {
    const entry = coverage.find((candidate) => candidate.family === family);
    result[family] = {
      outcomes: entry?.outcomes ?? 0,
      constructed: entry?.constructed ?? 0,
      verified: entry?.verified ?? 0,
      coverageSatisfied: entry?.coverageSatisfied ?? false,
    };
  }
  return result;
}

export function buildNoveltyReferenceView(
  dataset: FrozenReferenceDataset | CohortReferenceDataset,
): NoveltyReferenceView {
  const isFrozen = dataset.kind === "design_frozen_reference";
  const expected = isFrozen ? 1_000 : 100;
  const coverage = coverageByFamily(dataset.coverage);
  return {
    source: isFrozen ? "frozen" : "cohort",
    complete: dataset.outcomes.length === expected,
    coverageSatisfied: FAMILIES.every(
      (family) => coverage[family].coverageSatisfied,
    ),
    outcomes: dataset.outcomes,
    coverageByFamily: coverage,
  };
}

function fingerprintForCandidate(candidate: NoveltyCandidate): CandidateFingerprint {
  return CandidateFingerprintSchema.parse({
    version: 1,
    family: candidate.family,
    modality: candidate.modality,
    specHash: candidate.specHash,
    structureHash: candidate.structuralFingerprint,
    contentHash: candidate.contentHash,
    renderHashes: { svg: null, png: null },
    canonicalStructure: candidate.canonicalStructure,
    features: candidate.features,
  });
}

function fingerprintForOutcome(outcome: BaselineOutcome): CandidateFingerprint {
  if (
    outcome.canonicalStructure === null ||
    outcome.structuralFingerprint === null ||
    outcome.features === null ||
    outcome.specHash === null
  ) {
    throw new NoveltyError(
      "INVALID_REFERENCE",
      `constructed baseline outcome ${outcome.family}/${outcome.sourceIndex} lacks fingerprint data`,
    );
  }
  return CandidateFingerprintSchema.parse({
    version: 1,
    family: outcome.family,
    modality: outcome.modality,
    specHash: outcome.specHash,
    structureHash: outcome.structuralFingerprint,
    contentHash: outcome.contentHash,
    renderHashes: {
      svg: outcome.renderer?.svgHash ?? null,
      png: null,
    },
    canonicalStructure: outcome.canonicalStructure,
    features: outcome.features,
  });
}

function exactMatch(
  candidate: NoveltyCandidate,
  outcome: BaselineOutcome,
): boolean {
  if (
    outcome.structuralFingerprint === null ||
    outcome.canonicalStructure === null
  ) {
    return false;
  }
  if (candidate.structuralFingerprint !== outcome.structuralFingerprint) {
    return false;
  }
  if (
    !canonicalStructuresEqual(
      candidate.canonicalStructure,
      outcome.canonicalStructure,
    )
  ) {
    throw new NoveltyError(
      "IDENTICAL_STRUCTURE_DIFFERENT_HASH",
      `candidate ${candidate.candidateId} has an unequal structure with the same fingerprint`,
    );
  }
  return true;
}

function nearComparison(
  candidate: NoveltyCandidate,
  outcome: BaselineOutcome,
): FeatureComparison | null {
  if (outcome.status !== "constructed") {
    return null;
  }
  const reference = fingerprintForOutcome(outcome);
  const evaluation = evaluateNearPair(fingerprintForCandidate(candidate), reference);
  return evaluation.near ? evaluation.comparison : null;
}

export interface NoveltyCandidateIdentity {
  readonly candidateId: string;
  readonly assignmentId: string;
  readonly arm: DesignerArm;
  readonly view: NoveltyView;
  readonly family: Family;
  readonly difficulty: Difficulty;
}

function unknownAnnotation(
  identity: NoveltyCandidateIdentity,
  reason: string,
  frozen: NoveltyReferenceView,
  cohort: NoveltyReferenceView,
): NoveltyAnnotationResult {
  const familyCoverage = frozen.coverageByFamily[identity.family];
  return NoveltyAnnotationResultSchema.parse({
    candidateId: identity.candidateId,
    assignmentId: identity.assignmentId,
    arm: identity.arm,
    view: identity.view,
    family: identity.family,
    modality: MODALITY_BY_FAMILY[identity.family],
    difficulty: identity.difficulty,
    annotation: "novelty_unknown",
    exactFrozen: false,
    exactCohort: false,
    nearFrozen: false,
    nearCohort: false,
    exactMatchCount: 0,
    nearMatchCount: 0,
    matches: [],
    jaccardMin: null,
    jaccardMax: null,
    frozenComplete: frozen.complete,
    frozenCoverageSatisfied: familyCoverage.coverageSatisfied,
    cohortComplete: cohort.complete,
    provisional: !cohort.complete,
    reason: boundNoveltyReason(reason),
  });
}

function boundNoveltyReason(reason: string): string {
  return reason.length > 1_000 ? `${reason.slice(0, 997)}...` : reason;
}

function emptyAnnotation(
  candidate: NoveltyCandidate,
  reason: string,
  frozen: NoveltyReferenceView,
  cohort: NoveltyReferenceView,
): NoveltyAnnotationResult {
  return unknownAnnotation(candidate, reason, frozen, cohort);
}

function isImplementationNoveltyError(error: unknown): boolean {
  const code =
    error instanceof Error && "code" in error
      ? (error as { readonly code?: string }).code
      : undefined;
  return (
    code === "EMPTY_FEATURES" ||
    code === "IDENTICAL_STRUCTURE_DIFFERENT_HASH"
  );
}

export interface AnnotateNoveltyInput {
  readonly candidate: NoveltyCandidate;
  readonly frozen: NoveltyReferenceView;
  readonly cohort: NoveltyReferenceView;
}

export function annotateNoveltyCandidate(
  input: AnnotateNoveltyInput,
): NoveltyAnnotationResult {
  const { candidate, frozen, cohort } = input;
  if (candidate.features.length === 0) {
    throw new NoveltyError(
      "EMPTY_FEATURES",
      `candidate ${candidate.candidateId} has empty features`,
    );
  }
  const familyCoverage = frozen.coverageByFamily[candidate.family];
  if (
    !frozen.complete ||
    !familyCoverage.coverageSatisfied ||
    familyCoverage.constructed === 0
  ) {
    return emptyAnnotation(
      candidate,
      !frozen.complete
        ? "frozen reference is incomplete"
        : familyCoverage.constructed === 0
          ? `frozen reference has no constructed ${candidate.family} specimens`
          : `frozen reference coverage for ${candidate.family} is below 95 verified specimens`,
      frozen,
      cohort,
    );
  }

  const matches: NoveltyMatch[] = [];
  let exactFrozen = false;
  let exactCohort = false;
  let nearFrozen = false;
  let nearCohort = false;
  let exactMatchCount = 0;
  let nearMatchCount = 0;
  const jaccards: number[] = [];

  const consider = (
    source: "frozen" | "cohort",
    outcome: BaselineOutcome,
  ): void => {
    if (outcome.family !== candidate.family || outcome.status !== "constructed") {
      return;
    }
    if (exactMatch(candidate, outcome)) {
      exactMatchCount += 1;
      if (source === "frozen") {
        exactFrozen = true;
      } else {
        exactCohort = true;
      }
      if (matches.length < 16) {
        matches.push({
          source,
          sourceIndex: outcome.sourceIndex,
          assignmentId: outcome.assignmentId,
          kind: "exact",
          structureHash: outcome.structuralFingerprint ?? candidate.structuralFingerprint,
          comparison: null,
        });
      }
      return;
    }
    const comparison = nearComparison(candidate, outcome);
    if (comparison !== null) {
      nearMatchCount += 1;
      jaccards.push(comparison.jaccard);
      if (source === "frozen") {
        nearFrozen = true;
      } else {
        nearCohort = true;
      }
      if (matches.length < 16) {
        matches.push({
          source,
          sourceIndex: outcome.sourceIndex,
          assignmentId: outcome.assignmentId,
          kind: "near",
          structureHash: outcome.structuralFingerprint ?? candidate.structuralFingerprint,
          comparison,
        });
      }
    }
  };

  try {
    for (const outcome of frozen.outcomes) {
      consider("frozen", outcome);
    }
    for (const outcome of cohort.outcomes) {
      consider("cohort", outcome);
    }
  } catch (error) {
    if (isImplementationNoveltyError(error)) {
      throw error;
    }
    return emptyAnnotation(
      candidate,
      `comparator failure: ${error instanceof Error ? error.message : String(error)}`,
      frozen,
      cohort,
    );
  }

  const annotation: NoveltyAnnotation =
    exactMatchCount > 0
      ? "baseline_duplicate"
      : nearMatchCount > 0
        ? "near_baseline"
        : "novel";
  return NoveltyAnnotationResultSchema.parse({
    candidateId: candidate.candidateId,
    assignmentId: candidate.assignmentId,
    arm: candidate.arm,
    view: candidate.view,
    family: candidate.family,
    modality: candidate.modality,
    difficulty: candidate.difficulty,
    annotation,
    exactFrozen,
    exactCohort,
    nearFrozen,
    nearCohort,
    exactMatchCount,
    nearMatchCount,
    matches,
    jaccardMin: jaccards.length === 0 ? null : Math.min(...jaccards),
    jaccardMax: jaccards.length === 0 ? null : Math.max(...jaccards),
    frozenComplete: frozen.complete,
    frozenCoverageSatisfied: familyCoverage.coverageSatisfied,
    cohortComplete: cohort.complete,
    provisional: !cohort.complete,
    reason:
      annotation === "baseline_duplicate"
        ? "exact canonical structure matches the frozen or cohort baseline reference"
        : annotation === "near_baseline"
          ? "one structural feature edit from a baseline reference"
          : "no exact or one-edit baseline match in the available reference",
  });
}

export interface AnnotateNoveltySpecInput {
  readonly candidateId: string;
  readonly assignmentId: string;
  readonly arm: DesignerArm;
  readonly view: NoveltyView;
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly accepted?: boolean;
  readonly spec: unknown;
  readonly contentHash?: string | null;
  readonly frozen: NoveltyReferenceView;
  readonly cohort: NoveltyReferenceView;
}

export function annotateNoveltySpec(
  input: AnnotateNoveltySpecInput,
): NoveltyAnnotationResult {
  const identity: NoveltyCandidateIdentity = {
    candidateId: input.candidateId,
    assignmentId: input.assignmentId,
    arm: input.arm,
    view: input.view,
    family: input.family,
    difficulty: input.difficulty,
  };
  try {
    const candidate = buildNoveltyCandidate({
      candidateId: input.candidateId,
      assignmentId: input.assignmentId,
      arm: input.arm,
      view: input.view,
      family: input.family,
      difficulty: input.difficulty,
      accepted: input.accepted ?? true,
      spec: input.spec,
      contentHash: input.contentHash ?? null,
    });
    return annotateNoveltyCandidate({
      candidate,
      frozen: input.frozen,
      cohort: input.cohort,
    });
  } catch (error) {
    if (isImplementationNoveltyError(error)) {
      throw error;
    }
    return unknownAnnotation(
      identity,
      `candidate canonicalization or comparator failure: ${error instanceof Error ? error.message : String(error)}`,
      input.frozen,
      input.cohort,
    );
  }
}

function baselineReferenceId(outcome: BaselineOutcome): string {
  return (
    outcome.assignmentId ??
    `reference:${outcome.source}:${outcome.family}:${String(outcome.sourceIndex).padStart(3, "0")}`
  );
}

export function annotateBaselineOutcome(
  outcome: BaselineOutcome,
  frozen: NoveltyReferenceView,
  cohort: NoveltyReferenceView,
): NoveltyAnnotationResult {
  const referenceId = baselineReferenceId(outcome);
  if (outcome.status !== "constructed" || outcome.spec === null) {
    return NoveltyAnnotationResultSchema.parse({
      candidateId: `baseline:${outcome.source}:${outcome.sourceIndex}`,
      assignmentId: referenceId,
      arm: "baseline",
      view: "final",
      family: outcome.family,
      modality: outcome.modality,
      difficulty: outcome.difficulty,
      annotation: "novelty_unknown",
      exactFrozen: false,
      exactCohort: false,
      nearFrozen: false,
      nearCohort: false,
      exactMatchCount: 0,
      nearMatchCount: 0,
      matches: [],
      jaccardMin: null,
      jaccardMax: null,
      frozenComplete: frozen.complete,
      frozenCoverageSatisfied:
        frozen.coverageByFamily[outcome.family].coverageSatisfied,
      cohortComplete: cohort.complete,
      provisional: !cohort.complete,
      reason: `baseline outcome is ${outcome.status}`,
    });
  }
  const candidate = buildNoveltyCandidate({
    candidateId: `baseline:${outcome.source}:${outcome.sourceIndex}`,
    assignmentId:
      outcome.assignmentId ??
      `design-${outcome.modality}-${outcome.family}-01`,
    arm: "baseline",
    view: "final",
    family: outcome.family,
    difficulty: outcome.difficulty,
    accepted: false,
    spec: outcome.spec,
    contentHash: outcome.contentHash,
  });
  const cohortWithoutSelf: NoveltyReferenceView = {
    ...cohort,
    outcomes: cohort.outcomes.filter(
      (reference) =>
        reference.sourceIndex !== outcome.sourceIndex ||
        reference.assignmentId !== outcome.assignmentId,
    ),
  };
  const annotation = annotateNoveltyCandidate({
    candidate,
    frozen,
    cohort: cohortWithoutSelf,
  });
  return NoveltyAnnotationResultSchema.parse({
    ...annotation,
    assignmentId: referenceId,
  });
}

export const NoveltyExactClusterSchema = z.strictObject({
  family: z.enum(FAMILIES),
  structuralFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  candidateIds: z.array(z.string().min(1).max(200)).min(2),
});
export type NoveltyExactCluster = z.infer<typeof NoveltyExactClusterSchema>;

export const NoveltyNearPairSchema = z.strictObject({
  family: z.enum(FAMILIES),
  leftCandidateId: z.string().min(1).max(200),
  rightCandidateId: z.string().min(1).max(200),
  sameArm: z.boolean(),
  comparison: FeatureComparisonSchema,
});
export type NoveltyNearPair = z.infer<typeof NoveltyNearPairSchema>;

export const NoveltyNearClusterSchema = z.strictObject({
  family: z.enum(FAMILIES),
  candidateIds: z.array(z.string().min(1).max(200)).min(2),
  pairCount: z.number().int().positive(),
});
export type NoveltyNearCluster = z.infer<typeof NoveltyNearClusterSchema>;

export const NoveltyAiSummarySchema = z.strictObject({
  acceptedCandidateCount: z.number().int().nonnegative(),
  acceptedViewCount: z.number().int().nonnegative(),
  distinctFingerprints: z.number().int().nonnegative(),
  distinctAcrossViews: z.number().int().nonnegative(),
  exactClusters: z.array(NoveltyExactClusterSchema),
  nearPairs: z.array(NoveltyNearPairSchema),
  nearClusters: z.array(NoveltyNearClusterSchema),
  novelCandidateCount: z.number().int().nonnegative(),
  distinctNovelFingerprints: z.number().int().nonnegative(),
  repeatedNovelCount: z.number().int().nonnegative(),
  viewCounts: z.strictObject({
    first: z.number().int().nonnegative(),
    final: z.number().int().nonnegative(),
    trajectory: z.number().int().nonnegative(),
  }),
});
export type NoveltyAiSummary = z.infer<typeof NoveltyAiSummarySchema>;

function connectedComponents(
  candidateIds: readonly string[],
  pairs: readonly NoveltyNearPair[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const id of candidateIds) {
    adjacency.set(id, new Set());
  }
  for (const pair of pairs) {
    adjacency.get(pair.leftCandidateId)?.add(pair.rightCandidateId);
    adjacency.get(pair.rightCandidateId)?.add(pair.leftCandidateId);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of [...candidateIds].sort()) {
    if (visited.has(id)) {
      continue;
    }
    const queue = [id];
    const component: string[] = [];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      component.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (component.length > 1) {
      components.push(component.sort());
    }
  }
  return components;
}

const NOVELTY_VIEW_PRECEDENCE: Readonly<Record<NoveltyView, number>> = {
  first: 0,
  final: 1,
  trajectory: 2,
};

export function selectAcceptedDesignRepresentatives(
  candidates: readonly NoveltyCandidate[],
): NoveltyCandidate[] {
  const sorted = candidates
    .filter((candidate) => candidate.accepted)
    .sort((left, right) => {
      if (left.assignmentId !== right.assignmentId) {
        return left.assignmentId < right.assignmentId ? -1 : 1;
      }
      if (left.arm !== right.arm) {
        return left.arm < right.arm ? -1 : 1;
      }
      if (left.structuralFingerprint !== right.structuralFingerprint) {
        return left.structuralFingerprint < right.structuralFingerprint ? -1 : 1;
      }
      const viewOrder =
        NOVELTY_VIEW_PRECEDENCE[left.view] - NOVELTY_VIEW_PRECEDENCE[right.view];
      if (viewOrder !== 0) {
        return viewOrder;
      }
      return left.candidateId < right.candidateId ? -1 : 1;
    });
  const representatives = new Map<string, NoveltyCandidate>();
  for (const candidate of sorted) {
    const key = `${candidate.assignmentId}\u0000${candidate.arm}\u0000${candidate.structuralFingerprint}`;
    if (!representatives.has(key)) {
      representatives.set(key, candidate);
    }
  }
  return [...representatives.values()].sort((left, right) =>
    left.candidateId < right.candidateId ? -1 : 1,
  );
}

export function summarizeAiCandidates(
  candidates: readonly NoveltyCandidate[],
  annotations: readonly NoveltyAnnotationResult[] = [],
): NoveltyAiSummary {
  const acceptedViews = candidates.filter((candidate) => candidate.accepted);
  const accepted = selectAcceptedDesignRepresentatives(candidates);
  const acceptedIds = new Set(accepted.map((candidate) => candidate.candidateId));
  const exactGroups = new Map<string, string[]>();
  for (const candidate of accepted) {
    const key = `${candidate.family}\u0000${candidate.structuralFingerprint}`;
    const group = exactGroups.get(key);
    if (group === undefined) {
      exactGroups.set(key, [candidate.candidateId]);
    } else {
      group.push(candidate.candidateId);
    }
  }
  const exactClusters: NoveltyExactCluster[] = [];
  for (const [key, ids] of exactGroups) {
    if (ids.length > 1) {
      const [family, fingerprint] = key.split("\u0000");
      exactClusters.push({
        family: family as Family,
        structuralFingerprint: fingerprint ?? "",
        candidateIds: [...ids].sort(),
      });
    }
  }
  exactClusters.sort((left, right) =>
    `${left.family}\u0000${left.structuralFingerprint}` <
    `${right.family}\u0000${right.structuralFingerprint}`
      ? -1
      : 1,
  );

  const nearPairs: NoveltyNearPair[] = [];
  for (let leftIndex = 0; leftIndex < accepted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < accepted.length; rightIndex += 1) {
      const left = accepted[leftIndex];
      const right = accepted[rightIndex];
      if (left === undefined || right === undefined || left.family !== right.family) {
        continue;
      }
      const evaluation = evaluateNearPair(
        fingerprintForCandidate(left),
        fingerprintForCandidate(right),
      );
      if (evaluation.near && evaluation.comparison !== null) {
        const [first, second] =
          left.candidateId < right.candidateId
            ? [left, right]
            : [right, left];
        nearPairs.push({
          family: left.family,
          leftCandidateId: first.candidateId,
          rightCandidateId: second.candidateId,
          sameArm: first.arm === second.arm,
          comparison: evaluation.comparison,
        });
      }
    }
  }
  nearPairs.sort((left, right) =>
    `${left.family}\u0000${left.leftCandidateId}\u0000${left.rightCandidateId}` <
    `${right.family}\u0000${right.leftCandidateId}\u0000${right.rightCandidateId}`
      ? -1
      : 1,
  );
  const nearClusters: NoveltyNearCluster[] = [];
  for (const family of FAMILIES) {
    const familyIds = accepted
      .filter((candidate) => candidate.family === family)
      .map((candidate) => candidate.candidateId);
    const familyPairs = nearPairs.filter((pair) => pair.family === family);
    for (const component of connectedComponents(familyIds, familyPairs)) {
      nearClusters.push({
        family,
        candidateIds: component,
        pairCount: familyPairs.filter(
          (pair) =>
            component.includes(pair.leftCandidateId) &&
            component.includes(pair.rightCandidateId),
        ).length,
      });
    }
  }

  const distinctFingerprints = new Set(
    accepted.map((candidate) => candidate.structuralFingerprint),
  ).size;
  const distinctAcrossViews = accepted.length;
  const novelAnnotations = annotations.filter(
    (annotation) =>
      annotation.annotation === "novel" && acceptedIds.has(annotation.candidateId),
  );
  const distinctNovelFingerprints = new Set(
    novelAnnotations.map((annotation) => {
      const candidate = accepted.find(
        (entry) => entry.candidateId === annotation.candidateId,
      );
      return candidate?.structuralFingerprint ?? annotation.candidateId;
    }),
  ).size;
  const viewCounts = {
    first: acceptedViews.filter((candidate) => candidate.view === "first").length,
    final: acceptedViews.filter((candidate) => candidate.view === "final").length,
    trajectory: acceptedViews.filter((candidate) => candidate.view === "trajectory").length,
  };
  return NoveltyAiSummarySchema.parse({
    acceptedCandidateCount: accepted.length,
    acceptedViewCount: acceptedViews.length,
    distinctFingerprints,
    distinctAcrossViews,
    exactClusters,
    nearPairs,
    nearClusters,
    novelCandidateCount: novelAnnotations.length,
    distinctNovelFingerprints,
    repeatedNovelCount: novelAnnotations.length - distinctNovelFingerprints,
    viewCounts,
  });
}

export function computeNoveltySummaryHash(
  summary: NoveltyAiSummary,
): string {
  return sha256Hex(canonicalJson(summary));
}

export function noveltyScopeKey(candidate: NoveltyCandidate): string {
  return `${candidate.family}\u0000${candidate.canonicalStructure.queryKind}\u0000${candidate.canonicalStructure.domainTokens.join("\u0000")}`;
}

export function assertSameNoveltyScope(
  left: NoveltyCandidate,
  right: NoveltyCandidate,
): void {
  if (noveltyScopeKey(left) !== noveltyScopeKey(right)) {
    throw new NoveltyError(
      "CROSS_FAMILY_REFERENCE",
      `novelty comparison requires the same family/domain/query kind`,
    );
  }
}

export function baselineOutcomeIsComparable(
  outcome: BaselineOutcome,
): boolean {
  return (
    outcome.status === "constructed" &&
    outcome.canonicalStructure !== null &&
    outcome.structuralFingerprint !== null &&
    outcome.features !== null
  );
}

export function difficultyNoveltyKey(
  family: Family,
  modality: Modality,
  difficulty: Difficulty,
): string {
  return `${family}\u0000${modality}\u0000${difficulty}`;
}

export function noveltyFeatureCount(candidate: NoveltyCandidate): number {
  return candidate.features.reduce((sum, feature) => sum + feature.count, 0);
}
