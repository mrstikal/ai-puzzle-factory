import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
} from "../../src/domain/experiment.js";
import type { FamilySpecByFamily } from "../../src/domain/spec.js";
import {
  BASELINE_CONSTRUCTION_FAILURE_CODE,
  BASELINE_REFERENCE_VERSION,
  BaselineInfrastructureError,
  CohortReferenceDatasetSchema,
  FROZEN_DIFFICULTY_PATTERN,
  FrozenReferenceDatasetSchema,
  buildBaselineOutcome,
  buildCohortReference,
  buildFrozenReference,
  frozenFixtureSeed,
  readCohortReference,
  readFrozenReference,
  summarizeBaselineCoverage,
  writeReferenceArtifacts,
  type BaselineOutcome,
  type CohortReferenceDataset,
  type FrozenReferenceDataset,
} from "../../src/design/baseline.js";
import {
  NoveltyAnnotationResultSchema,
  NoveltyCandidateSchema,
  annotateBaselineOutcome,
  annotateNoveltyCandidate,
  annotateNoveltySpec,
  buildNoveltyCandidate,
  computeNoveltySummaryHash,
  summarizeAiCandidates,
  type NoveltyCandidate,
  type NoveltyReferenceView,
} from "../../src/design/novelty.js";
import {
  DesignNoveltyReportSchema,
  buildDesignNoveltyReport,
  renderDesignReferenceGallery,
} from "../../src/reporting/design-metrics.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import { productionRegistry } from "../../src/families/registry.js";
import { RankingConstructionError } from "../../src/families/ranking/engine.js";
import { deriveStreamSeed } from "../../src/util/random.js";
import { canonicalJson, sha256Hex } from "../../src/util/hash.js";

const SEED = "a".repeat(64);
const PRIMARY_PLAN = buildDesignerPlanManifest({ runKind: "design_primary" });

let frozen: FrozenReferenceDataset;
let cohort: CohortReferenceDataset;

beforeAll(() => {
  frozen = buildFrozenReference();
  cohort = buildCohortReference(PRIMARY_PLAN);
}, 180_000);

function assignmentId(family: keyof typeof MODALITY_BY_FAMILY): string {
  return `design-${MODALITY_BY_FAMILY[family]}-${family}-01`;
}

function rankingSpec(
  clues: FamilySpecByFamily["ranking"]["clues"],
): FamilySpecByFamily["ranking"] {
  return { size: 4, clues };
}

const RANKING_BASE = rankingSpec([
  { kind: "at", item: 1, position: 2 },
  { kind: "notAt", item: 1, position: 4 },
  { kind: "before", before: 0, after: 2 },
  { kind: "notAt", item: 0, position: 4 },
  { kind: "notAt", item: 0, position: 1 },
]);
const RANKING_ONE_EDIT = rankingSpec([
  { kind: "before", before: 3, after: 0 },
  { kind: "notAt", item: 3, position: 1 },
  { kind: "notAt", item: 1, position: 4 },
  { kind: "at", item: 2, position: 4 },
  { kind: "notAt", item: 2, position: 1 },
]);
const RANKING_TWO_EDIT = rankingSpec([
  { kind: "before", before: 0, after: 1 },
  { kind: "immediatelyBefore", before: 2, after: 3 },
  { kind: "at", item: 3, position: 4 },
  { kind: "before", before: 0, after: 3 },
]);

function outcomeFromSpec(input: {
  readonly family: keyof typeof MODALITY_BY_FAMILY;
  readonly difficulty: 1 | 2 | 3;
  readonly spec: unknown;
  readonly source?: "frozen_fixture" | "cohort";
  readonly sourceIndex?: number;
  readonly assignmentId?: string | null;
}): BaselineOutcome {
  return buildBaselineOutcome({
    source: input.source ?? "frozen_fixture",
    sourceIndex: input.sourceIndex ?? 1,
    assignmentId: input.assignmentId ?? null,
    family: input.family,
    difficulty: input.difficulty,
    seed: SEED,
    construct: () => ({
      spec: input.spec as FamilySpecByFamily[keyof FamilySpecByFamily],
      trace: { drawsUsed: 0 },
    }),
  });
}

function candidateFromSpec(input: {
  readonly id: string;
  readonly family: keyof typeof MODALITY_BY_FAMILY;
  readonly difficulty: 1 | 2 | 3;
  readonly spec: unknown;
  readonly accepted?: boolean;
  readonly arm?: "baseline" | "ai_one_shot" | "ai_feedback";
  readonly view?: "first" | "final" | "trajectory";
  readonly assignmentId?: string;
}): NoveltyCandidate {
  return buildNoveltyCandidate({
    candidateId: input.id,
    assignmentId: input.assignmentId ?? assignmentId(input.family),
    arm: input.arm ?? "ai_one_shot",
    view: input.view ?? "final",
    family: input.family,
    difficulty: input.difficulty,
    accepted: input.accepted ?? true,
    spec: input.spec,
  });
}

function referenceView(
  outcomes: readonly BaselineOutcome[],
  source: "frozen" | "cohort",
  options: {
    readonly complete?: boolean;
    readonly coverageSatisfied?: boolean;
  } = {},
): NoveltyReferenceView {
  const complete = options.complete ?? true;
  const coverageSatisfied = options.coverageSatisfied ?? true;
  const coverageByFamily = Object.fromEntries(
    FAMILIES.map((family) => {
      const familyOutcomes = outcomes.filter(
        (outcome) => outcome.family === family,
      );
      const constructed = familyOutcomes.filter(
        (outcome) => outcome.status === "constructed",
      );
      return [
        family,
        {
          outcomes: familyOutcomes.length,
          constructed: constructed.length,
          verified: constructed.filter(
            (outcome) => outcome.solver?.verified === true,
          ).length,
          coverageSatisfied,
        },
      ];
    }),
  ) as NoveltyReferenceView["coverageByFamily"];
  return {
    source,
    complete,
    coverageSatisfied,
    outcomes,
    coverageByFamily,
  };
}

const EMPTY_COHORT = referenceView([], "cohort");

function countingShape(
  indices: readonly number[],
): FamilySpecByFamily["counting"]["shapes"][number] {
  return {
    cells: indices.map((index) => ({
      row: Math.floor(index / 5),
      column: index % 5,
    })),
  };
}

const COUNTING_SHAPES = [
  countingShape([1, 6, 7, 8]),
  countingShape([2, 6, 7, 8]),
  countingShape([3, 6, 7, 8]),
];

function countingSpec(k: 2 | 3): FamilySpecByFamily["counting"] {
  return {
    shapes: COUNTING_SHAPES,
    query: { operation: "exactlyKShapes", k },
  };
}

describe("P48 baseline reference", () => {
  it("builds the 100 primary baseline assignments with zero AI calls and pending presentation", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const plan = buildDesignerPlanManifest({ runKind: "design_primary" });
    const reference = buildCohortReference(plan);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(reference.outcomes).toHaveLength(100);
    expect(CohortReferenceDatasetSchema.safeParse(reference).success).toBe(true);
    expect(
      reference.outcomes.filter((outcome) => outcome.status === "constructed")
        .length,
    ).toBeGreaterThanOrEqual(95);
    for (const outcome of reference.outcomes) {
      expect(outcome.presentation).toBe("pending");
      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.pendingChecks).toEqual(["presentation"]);
      if (outcome.status === "constructed") {
        expect(outcome.solver?.verified).toBe(true);
        expect(outcome.options?.distinct).toBe(true);
        expect(outcome.options?.labels.join("")).toBe("ABCD");
      }
    }
  });

  it("uses the exact frozen fixture seed tuples and 34/33/33 difficulty pattern", () => {
    expect(FROZEN_DIFFICULTY_PATTERN).toHaveLength(100);
    expect(FROZEN_DIFFICULTY_PATTERN.filter((value) => value === 1)).toHaveLength(34);
    expect(FROZEN_DIFFICULTY_PATTERN.filter((value) => value === 2)).toHaveLength(33);
    expect(FROZEN_DIFFICULTY_PATTERN.filter((value) => value === 3)).toHaveLength(33);
    expect(frozenFixtureSeed("ranking", 1)).toBe(
      deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: "ranking-fixture-001",
        purpose: "spec",
      }),
    );
  });

  it("builds and validates the 1,000-outcome frozen reference with explicit coverage", () => {
    expect(frozen.outcomes).toHaveLength(1_000);
    expect(FrozenReferenceDatasetSchema.safeParse(frozen).success).toBe(true);
    expect(frozen.referenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.coverage).toHaveLength(10);
    for (const coverage of frozen.coverage) {
      expect(coverage.outcomes).toBe(100);
      expect(coverage.verified).toBeGreaterThanOrEqual(95);
      expect(coverage.coverageSatisfied).toBe(true);
      expect(
        coverage.difficultyOutcomes[1] +
          coverage.difficultyOutcomes[2] +
          coverage.difficultyOutcomes[3],
      ).toBe(100);
    }
    const { referenceHash, ...base } = frozen;
    expect(referenceHash).toBe(sha256Hex(canonicalJson(base)));
  });

  it("records bounded construction failures and distinguishes infrastructure errors", () => {
    const failed = buildBaselineOutcome({
      source: "frozen_fixture",
      sourceIndex: 1,
      family: "ranking",
      difficulty: 1,
      seed: SEED,
      construct: () => {
        throw new RankingConstructionError("DRAW_LIMIT", "forced bounded failure");
      },
    });
    expect(failed.status).toBe("construction_failed");
    expect(failed.failureCode).toBe(BASELINE_CONSTRUCTION_FAILURE_CODE);
    expect(failed.verdict).toBe("inconclusive");
    expect(failed.pendingChecks).toEqual([]);
    expect(() =>
      buildBaselineOutcome({
        source: "frozen_fixture",
        sourceIndex: 1,
        family: "ranking",
        difficulty: 1,
        seed: SEED,
        construct: () => {
          throw new Error("unexpected infrastructure failure");
        },
      }),
    ).toThrow(BaselineInfrastructureError);
    const constructed = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const coverage = summarizeBaselineCoverage(
      [constructed, failed],
      () => 1,
    ).find((entry) => entry.family === "ranking");
    expect(coverage).toMatchObject({
      outcomes: 2,
      constructed: 1,
      verified: 1,
      failed: 1,
      coverageSatisfied: true,
    });
  });

  it("persists and re-reads strict reference artifacts and a static gallery", () => {
    const directory = mkdtempSync(join(tmpdir(), "p48-reference-"));
    try {
      const manifest = writeReferenceArtifacts({
        outputDirectory: directory,
        frozen,
        cohort,
        galleryHtml: renderDesignReferenceGallery(frozen, cohort),
      });
      expect(manifest.version).toBe(BASELINE_REFERENCE_VERSION);
      expect(manifest.frozenHash).toBe(frozen.referenceHash);
      expect(manifest.cohortHash).toBe(cohort.cohortHash);
      expect(existsSync(manifest.frozenPath)).toBe(true);
      expect(existsSync(manifest.cohortPath)).toBe(true);
      expect(existsSync(manifest.galleryPath)).toBe(true);
      expect(readFrozenReference(manifest.frozenPath).referenceHash).toBe(
        frozen.referenceHash,
      );
      expect(readCohortReference(manifest.cohortPath).cohortHash).toBe(
        cohort.cohortHash,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("P48 structural novelty", () => {
  it("classifies exact, one-edit, and two-edit candidates", () => {
    const baseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const frozenView = referenceView([baseline], "frozen");
    const exact = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "exact",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
      }),
      frozen: frozenView,
      cohort: EMPTY_COHORT,
    });
    expect(exact.annotation).toBe("baseline_duplicate");
    expect(exact.exactFrozen).toBe(true);
    const oneEdit = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "one-edit",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
      frozen: frozenView,
      cohort: EMPTY_COHORT,
    });
    expect(oneEdit.annotation).toBe("near_baseline");
    expect(oneEdit.matches[0]?.comparison?.editDistance).toBe(1);
    expect(oneEdit.matches[0]?.comparison?.jaccard).toBe(0.5);
    const twoEdit = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "two-edit",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
      }),
      frozen: frozenView,
      cohort: EMPTY_COHORT,
    });
    expect(twoEdit.annotation).toBe("novel");
    expect(twoEdit.nearMatchCount).toBe(0);
  });

  it("manual inspection: baseline and synthetic AI candidate", () => {
    const baseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const candidate = candidateFromSpec({
      id: "manual-ai",
      family: "ranking",
      difficulty: 1,
      spec: RANKING_ONE_EDIT,
    });
    const annotation = annotateNoveltyCandidate({
      candidate,
      frozen: referenceView([baseline], "frozen"),
      cohort: EMPTY_COHORT,
    });
    console.log(
      JSON.stringify(
        {
          kind: "p48_manual_inspection",
          baseline: {
            family: baseline.family,
            difficulty: baseline.difficulty,
            status: baseline.status,
            verdict: baseline.verdict,
            presentation: baseline.presentation,
            structuralFingerprint: baseline.structuralFingerprint,
            drawsUsed: baseline.drawsUsed,
          },
          candidate: {
            candidateId: candidate.candidateId,
            family: candidate.family,
            difficulty: candidate.difficulty,
            arm: candidate.arm,
            structuralFingerprint: candidate.structuralFingerprint,
          },
          annotation: {
            annotation: annotation.annotation,
            exactFrozen: annotation.exactFrozen,
            nearFrozen: annotation.nearFrozen,
            exactMatchCount: annotation.exactMatchCount,
            nearMatchCount: annotation.nearMatchCount,
            jaccardMin: annotation.jaccardMin,
            jaccardMax: annotation.jaccardMax,
            reason: annotation.reason,
          },
        },
        null,
        2,
      ),
    );
    expect(annotation.annotation).toBe("near_baseline");
    expect(annotation.matches[0]?.comparison?.editDistance).toBe(1);
  });

  it("keeps the mandatory counting positive at editDistance one and Jaccard 33/35", () => {
    const baseline = outcomeFromSpec({
      family: "counting",
      difficulty: 3,
      spec: countingSpec(2),
    });
    const candidate = candidateFromSpec({
      id: "counting-k3",
      family: "counting",
      difficulty: 3,
      spec: countingSpec(3),
    });
    expect(candidate.features.reduce((sum, feature) => sum + feature.count, 0)).toBe(34);
    const annotation = annotateNoveltyCandidate({
      candidate,
      frozen: referenceView([baseline], "frozen"),
      cohort: EMPTY_COHORT,
    });
    expect(annotation.annotation).toBe("near_baseline");
    expect(annotation.matches[0]?.comparison?.editDistance).toBe(1);
    expect(annotation.matches[0]?.comparison?.jaccard).toBeCloseTo(33 / 35, 12);
    expect(annotation.jaccardMin).toBeCloseTo(33 / 35, 12);
  });

  it("rejects empty features and unequal hashes with identical canonical data", () => {
    const candidate = candidateFromSpec({
      id: "empty",
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    expect(
      NoveltyCandidateSchema.safeParse({ ...candidate, features: [] }).success,
    ).toBe(false);
    expect(() =>
      NoveltyCandidateSchema.parse({
        ...candidate,
        structuralFingerprint: "b".repeat(64),
      }),
    ).toThrow();
  });

  it("isolates cross-family references and reports both memberships separately", () => {
    const rankingBaseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const matchingSpec = productionRegistry
      .getEngine("matching")
      .generateSpec(SEED, 1);
    const matchingBaseline = outcomeFromSpec({
      family: "matching",
      difficulty: 1,
      spec: matchingSpec,
    });
    const isolated = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "cross-family",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
      }),
      frozen: referenceView([rankingBaseline, matchingBaseline], "frozen"),
      cohort: EMPTY_COHORT,
    });
    expect(isolated.annotation).toBe("novel");
    expect(isolated.exactFrozen).toBe(false);
    expect(isolated.nearFrozen).toBe(false);

    const cohortBaseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
      source: "cohort",
      sourceIndex: 1,
      assignmentId: "design-text-ranking-01",
    });
    const both = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "both",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
      }),
      frozen: referenceView([rankingBaseline], "frozen"),
      cohort: referenceView([cohortBaseline], "cohort"),
    });
    expect(both.annotation).toBe("baseline_duplicate");
    expect(both.exactFrozen).toBe(true);
    expect(both.exactCohort).toBe(true);
  });

  it("degrades canonicalization and comparator failures to novelty_unknown", () => {
    const arithmeticBaselineSpec: FamilySpecByFamily["arithmetic"] = {
      allDifferent: false,
      constraints: [
        { coeffs: [1, 0, 0], op: "eq", constant: 1 },
        { coeffs: [0, 1, 0], op: "eq", constant: 2 },
        { coeffs: [0, 0, 1], op: "eq", constant: 3 },
      ],
    };
    const arithmeticBaseline = outcomeFromSpec({
      family: "arithmetic",
      difficulty: 1,
      spec: arithmeticBaselineSpec,
    });
    const arithmeticFrozen = referenceView([arithmeticBaseline], "frozen");
    const canonicalizationFailure = annotateNoveltySpec({
      candidateId: "nonintegral",
      assignmentId: "design-text-arithmetic-01",
      arm: "ai_one_shot",
      view: "final",
      family: "arithmetic",
      difficulty: 1,
      spec: {
        allDifferent: false,
        constraints: [
          { coeffs: [2, 0, 0], op: "eq", constant: 3 },
          { coeffs: [0, 1, 0], op: "eq", constant: 1 },
        ],
      },
      frozen: arithmeticFrozen,
      cohort: EMPTY_COHORT,
    });
    expect(canonicalizationFailure.annotation).toBe("novelty_unknown");
    expect(canonicalizationFailure.reason).toContain("canonicalization");

    const rankingBaseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const brokenReference = {
      ...rankingBaseline,
      features: [],
    } as unknown as BaselineOutcome;
    const comparatorFailure = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "comparator-failure",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
      frozen: referenceView([brokenReference], "frozen"),
      cohort: EMPTY_COHORT,
    });
    expect(comparatorFailure.annotation).toBe("novelty_unknown");
    expect(comparatorFailure.reason).toContain("comparator failure");

    const longFailure = annotateNoveltySpec({
      candidateId: "long-failure",
      assignmentId: "design-text-ranking-01",
      arm: "ai_one_shot",
      view: "final",
      family: "ranking",
      difficulty: 1,
      spec: {
        size: 4,
        clues: Array.from({ length: 20 }, () => ({ kind: "bogus" })),
      },
      frozen: referenceView([], "frozen"),
      cohort: EMPTY_COHORT,
    });
    expect(longFailure.annotation).toBe("novelty_unknown");
    expect(longFailure.reason.length).toBeLessThanOrEqual(1_000);
  });

  it("returns novelty_unknown for incomplete or insufficient reference evidence", () => {
    const candidate = candidateFromSpec({
      id: "unknown",
      family: "ranking",
      difficulty: 1,
      spec: RANKING_TWO_EDIT,
    });
    expect(
      annotateNoveltyCandidate({
        candidate,
        frozen: referenceView([], "frozen", { complete: false }),
        cohort: EMPTY_COHORT,
      }).annotation,
    ).toBe("novelty_unknown");
    expect(
      annotateNoveltyCandidate({
        candidate,
        frozen: referenceView([], "frozen", {
          complete: true,
          coverageSatisfied: false,
        }),
        cohort: EMPTY_COHORT,
      }).annotation,
    ).toBe("novelty_unknown");
    const failed = buildBaselineOutcome({
      source: "cohort",
      sourceIndex: 1,
      assignmentId: "design-text-ranking-01",
      family: "ranking",
      difficulty: 1,
      seed: SEED,
      construct: () => {
        throw new RankingConstructionError("DRAW_LIMIT", "forced");
      },
    });
    expect(
      annotateBaselineOutcome(
        failed,
        referenceView([], "frozen"),
        EMPTY_COHORT,
      ).annotation,
    ).toBe("novelty_unknown");
    const frozenOutcome = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const frozenAnnotation = annotateBaselineOutcome(
      frozenOutcome,
      referenceView([frozenOutcome], "frozen"),
      EMPTY_COHORT,
    );
    expect(frozenAnnotation.assignmentId).toBe(
      "reference:frozen_fixture:ranking:001",
    );
  });

  it("does not treat a partial cohort as unknown, but marks it provisional", () => {
    const baseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const annotation = annotateNoveltyCandidate({
      candidate: candidateFromSpec({
        id: "provisional",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
      frozen: referenceView([baseline], "frozen"),
      cohort: referenceView([], "cohort", { complete: false }),
    });
    expect(annotation.annotation).toBe("near_baseline");
    expect(annotation.provisional).toBe(true);
    expect(NoveltyAnnotationResultSchema.safeParse(annotation).success).toBe(true);
  });
});

describe("P48 AI-AI structural comparison", () => {
  it("builds non-transitive near clusters and distinguishes within/across arms", () => {
    const candidates = [
      candidateFromSpec({
        id: "A",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        arm: "ai_one_shot",
      }),
      candidateFromSpec({
        id: "B",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
        arm: "ai_feedback",
      }),
      candidateFromSpec({
        id: "C",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
        arm: "ai_feedback",
      }),
    ];
    const summary = summarizeAiCandidates(candidates);
    expect(summary.acceptedCandidateCount).toBe(3);
    expect(summary.distinctFingerprints).toBe(3);
    expect(summary.nearPairs).toHaveLength(2);
    expect(summary.nearPairs.some((pair) => pair.sameArm)).toBe(true);
    expect(summary.nearPairs.some((pair) => !pair.sameArm)).toBe(true);
    expect(summary.nearClusters).toHaveLength(1);
    expect(summary.nearClusters[0]?.candidateIds).toEqual(["A", "B", "C"]);
    expect(summary.nearClusters[0]?.pairCount).toBe(2);
    expect(summary.exactClusters).toEqual([]);
  });

  it("counts repeated novel outputs separately from distinct novel fingerprints", () => {
    const baseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const frozenView = referenceView([baseline], "frozen");
    const candidates = [
      candidateFromSpec({
        id: "novel-1",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
      }),
      candidateFromSpec({
        id: "novel-2",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
        assignmentId: "design-text-ranking-02",
      }),
    ];
    const annotations = candidates.map((candidate) =>
      annotateNoveltyCandidate({
        candidate,
        frozen: frozenView,
        cohort: EMPTY_COHORT,
      }),
    );
    const summary = summarizeAiCandidates(candidates, annotations);
    expect(summary.novelCandidateCount).toBe(2);
    expect(summary.distinctNovelFingerprints).toBe(1);
    expect(summary.repeatedNovelCount).toBe(1);
    expect(summary.exactClusters).toHaveLength(1);
  });

  it("de-duplicates the same accepted proposal across first and final views", () => {
    const candidates = [
      candidateFromSpec({
        id: "first",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        view: "first",
      }),
      candidateFromSpec({
        id: "final",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        view: "final",
      }),
    ];
    const summary = summarizeAiCandidates(candidates);
    expect(summary.acceptedCandidateCount).toBe(1);
    expect(summary.acceptedViewCount).toBe(2);
    expect(summary.distinctFingerprints).toBe(1);
    expect(summary.distinctAcrossViews).toBe(1);
    expect(summary.viewCounts).toEqual({ first: 1, final: 1, trajectory: 0 });
  });

  it("does not double-count a first/final duplicate in near-pair analysis", () => {
    const candidates = [
      candidateFromSpec({
        id: "first",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        view: "first",
      }),
      candidateFromSpec({
        id: "final",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        view: "final",
      }),
      candidateFromSpec({
        id: "neighbor",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
    ];
    const summary = summarizeAiCandidates(candidates);
    expect(summary.acceptedCandidateCount).toBe(2);
    expect(summary.acceptedViewCount).toBe(3);
    expect(summary.nearPairs).toHaveLength(1);
    expect(summary.exactClusters).toHaveLength(0);
    expect(summary.nearClusters).toHaveLength(1);
    expect(summary.nearClusters[0]?.candidateIds).toEqual(["first", "neighbor"]);
  });

  it("keeps different arms of one assignment as separate designs", () => {
    const candidates = [
      candidateFromSpec({
        id: "one-shot",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
        arm: "ai_one_shot",
      }),
      candidateFromSpec({
        id: "feedback",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
        arm: "ai_feedback",
      }),
    ];
    const summary = summarizeAiCandidates(candidates);
    expect(summary.acceptedCandidateCount).toBe(2);
    expect(summary.acceptedViewCount).toBe(2);
    expect(summary.distinctFingerprints).toBe(1);
    expect(summary.distinctAcrossViews).toBe(2);
    expect(summary.exactClusters).toHaveLength(1);
    expect(summary.exactClusters[0]?.candidateIds).toEqual([
      "feedback",
      "one-shot",
    ]);
  });

  it("is order-independent with multi-view duplicates", () => {
    const candidates = [
      candidateFromSpec({
        id: "first",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        view: "first",
      }),
      candidateFromSpec({
        id: "final",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
        view: "final",
      }),
      candidateFromSpec({
        id: "neighbor",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
    ];
    const forward = summarizeAiCandidates(candidates);
    const reversed = summarizeAiCandidates([...candidates].reverse());
    expect(reversed).toEqual(forward);
    expect(computeNoveltySummaryHash(reversed)).toBe(
      computeNoveltySummaryHash(forward),
    );
    expect(forward.nearClusters[0]?.candidateIds).toEqual(["first", "neighbor"]);
  });

  it("produces completion-order-independent summary hashes", () => {
    const candidates = [
      candidateFromSpec({
        id: "A",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
      }),
      candidateFromSpec({
        id: "B",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
      candidateFromSpec({
        id: "C",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
      }),
    ];
    const forward = computeNoveltySummaryHash(summarizeAiCandidates(candidates));
    const reversed = computeNoveltySummaryHash(
      summarizeAiCandidates([...candidates].reverse()),
    );
    expect(reversed).toBe(forward);
  });
});

describe("P48 design novelty report", () => {
  it("builds per-family/modality/difficulty tables and a deterministic report hash", () => {
    const baseline = outcomeFromSpec({
      family: "ranking",
      difficulty: 1,
      spec: RANKING_BASE,
    });
    const candidates = [
      candidateFromSpec({
        id: "A",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_BASE,
      }),
      candidateFromSpec({
        id: "B",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_ONE_EDIT,
      }),
      candidateFromSpec({
        id: "C",
        family: "ranking",
        difficulty: 1,
        spec: RANKING_TWO_EDIT,
      }),
    ];
    const forward = buildDesignNoveltyReport({
      frozen,
      cohort,
      aiCandidates: candidates,
      baselineOutcomes: [baseline],
    });
    const reversed = buildDesignNoveltyReport({
      frozen,
      cohort,
      aiCandidates: [...candidates].reverse(),
      baselineOutcomes: [baseline],
    });
    expect(DesignNoveltyReportSchema.safeParse(forward).success).toBe(true);
    expect(forward.reference).toHaveLength(20);
    expect(forward.reference[0]?.difficultyOutcomes).toEqual({
      1: 34,
      2: 33,
      3: 33,
    });
    expect(forward.reference[0]?.difficultyConstructed).toEqual({
      1: 34,
      2: 33,
      3: 33,
    });
    expect(forward.baseline).toHaveLength(30);
    expect(forward.ai).toHaveLength(30);
    expect(reversed.reportHash).toBe(forward.reportHash);
    expect(forward.aiSummary.acceptedCandidateCount).toBe(3);
    expect(forward.aiSummary.acceptedViewCount).toBe(3);
    expect(forward.aiSummary.nearClusters).toHaveLength(1);
  });
});
