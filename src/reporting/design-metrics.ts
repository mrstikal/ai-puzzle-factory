import { z } from "zod";
import {
  DIFFICULTIES,
  FAMILIES,
  MODALITY_BY_FAMILY,
} from "../domain/experiment.js";
import {
  type CohortReferenceDataset,
  type FrozenReferenceDataset,
  type BaselineOutcome,
} from "../design/baseline.js";
import {
  NoveltyAiSummarySchema,
  NoveltyAnnotationResultSchema,
  annotateBaselineOutcome,
  annotateNoveltyCandidate,
  buildNoveltyCandidate,
  buildNoveltyReferenceView,
  selectAcceptedDesignRepresentatives,
  summarizeAiCandidates,
  type NoveltyAnnotationResult,
  type NoveltyCandidate,
} from "../design/novelty.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { getArtifactById } from "../storage/artifacts.js";
import {
  getDesignerRun,
  listDesignAttempts,
  listDesignerSlots,
  listDesignerStageResults,
} from "../storage/repository.js";
import { listAttempts } from "../ai/ledger.js";
import type Database from "better-sqlite3";
import type { DesignAttemptRecord } from "../design/attempts.js";

export const DESIGN_NOVELTY_REPORT_VERSION = "p48-report-v1" as const;

export const DesignReferenceRowSchema = z.strictObject({
  source: z.enum(["frozen", "cohort"]),
  family: z.enum(FAMILIES),
  modality: z.enum(["text", "svg"]),
  outcomes: z.number().int().nonnegative(),
  constructed: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
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
export type DesignReferenceRow = z.infer<typeof DesignReferenceRowSchema>;

export const DesignBaselineRowSchema = z.strictObject({
  family: z.enum(FAMILIES),
  modality: z.enum(["text", "svg"]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  outcomes: z.number().int().nonnegative(),
  constructed: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  near: z.number().int().nonnegative(),
  novel: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  distinctFingerprints: z.number().int().nonnegative(),
});
export type DesignBaselineRow = z.infer<typeof DesignBaselineRowSchema>;

export const DesignAiRowSchema = z.strictObject({
  family: z.enum(FAMILIES),
  modality: z.enum(["text", "svg"]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  accepted: z.number().int().nonnegative(),
  acceptedViews: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  near: z.number().int().nonnegative(),
  novel: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  distinctFingerprints: z.number().int().nonnegative(),
  distinctNovelFingerprints: z.number().int().nonnegative(),
  novelCandidateCount: z.number().int().nonnegative(),
  repeatedNovelCount: z.number().int().nonnegative(),
  exactClusterCount: z.number().int().nonnegative(),
  nearPairCount: z.number().int().nonnegative(),
  nearClusterCount: z.number().int().nonnegative(),
});
export type DesignAiRow = z.infer<typeof DesignAiRowSchema>;

export const DesignNoveltyReportSchema = z
  .strictObject({
    kind: z.literal("design_novelty_report"),
    version: z.literal(DESIGN_NOVELTY_REPORT_VERSION),
    frozenHash: z.string().regex(/^[0-9a-f]{64}$/),
    cohortHash: z.string().regex(/^[0-9a-f]{64}$/),
    reference: z.array(DesignReferenceRowSchema),
    baseline: z.array(DesignBaselineRowSchema),
    ai: z.array(DesignAiRowSchema),
    aiSummary: NoveltyAiSummarySchema,
    annotations: z.array(NoveltyAnnotationResultSchema),
    baselineAnnotations: z.array(NoveltyAnnotationResultSchema),
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((report, ctx) => {
    if (report.reportHash !== computeDesignNoveltyReportHash(report)) {
      ctx.addIssue({
        code: "custom",
        path: ["reportHash"],
        message: "design novelty report hash does not match the report",
      });
    }
  });
export type DesignNoveltyReport = z.infer<typeof DesignNoveltyReportSchema>;

export interface BuildDesignNoveltyReportInput {
  readonly frozen: FrozenReferenceDataset;
  readonly cohort: CohortReferenceDataset;
  readonly aiCandidates: readonly NoveltyCandidate[];
  readonly baselineOutcomes?: readonly BaselineOutcome[];
}

function referenceRows(
  source: "frozen" | "cohort",
  dataset: FrozenReferenceDataset | CohortReferenceDataset,
): DesignReferenceRow[] {
  return dataset.coverage.map((coverage) => ({
    source,
    family: coverage.family,
    modality: MODALITY_BY_FAMILY[coverage.family],
    outcomes: coverage.outcomes,
    constructed: coverage.constructed,
    verified: coverage.verified,
    failed: coverage.failed,
    distinctFingerprints: coverage.distinctFingerprints,
    difficultyOutcomes: coverage.difficultyOutcomes,
    difficultyConstructed: coverage.difficultyConstructed,
    coverageSatisfied: coverage.coverageSatisfied,
  }));
}

function annotationCounts(
  annotations: readonly NoveltyAnnotationResult[],
): { duplicate: number; near: number; novel: number; unknown: number } {
  return {
    duplicate: annotations.filter((entry) => entry.annotation === "baseline_duplicate").length,
    near: annotations.filter((entry) => entry.annotation === "near_baseline").length,
    novel: annotations.filter((entry) => entry.annotation === "novel").length,
    unknown: annotations.filter((entry) => entry.annotation === "novelty_unknown").length,
  };
}

export function buildDesignNoveltyReport(
  input: BuildDesignNoveltyReportInput,
): DesignNoveltyReport {
  const frozenView = buildNoveltyReferenceView(input.frozen);
  const cohortView = buildNoveltyReferenceView(input.cohort);
  const baselineOutcomes = input.baselineOutcomes ?? input.cohort.outcomes;
  const annotations = input.aiCandidates.map((candidate) =>
    annotateNoveltyCandidate({
      candidate,
      frozen: frozenView,
      cohort: cohortView,
    }),
  );
  const baselineAnnotations = baselineOutcomes.map((outcome) =>
    annotateBaselineOutcome(outcome, frozenView, cohortView),
  );
  const aiSummary = summarizeAiCandidates(input.aiCandidates, annotations);

  const baselineRows: DesignBaselineRow[] = [];
  const aiRows: DesignAiRow[] = [];
  for (const family of FAMILIES) {
    const modality = MODALITY_BY_FAMILY[family];
    for (const difficulty of DIFFICULTIES) {
      const cellOutcomes = baselineOutcomes.filter(
        (outcome) =>
          outcome.family === family && outcome.difficulty === difficulty,
      );
      const cellBaselineAnnotations = baselineAnnotations.filter(
        (annotation) =>
          annotation.family === family && annotation.difficulty === difficulty,
      );
      const counts = annotationCounts(cellBaselineAnnotations);
      baselineRows.push({
        family,
        modality,
        difficulty,
        outcomes: cellOutcomes.length,
        constructed: cellOutcomes.filter(
          (outcome) => outcome.status === "constructed",
        ).length,
        ...counts,
        distinctFingerprints: new Set(
          cellOutcomes
            .map((outcome) => outcome.structuralFingerprint)
            .filter((hash): hash is string => hash !== null),
        ).size,
      });

      const cellViews = input.aiCandidates.filter(
        (candidate) =>
          candidate.accepted &&
          candidate.family === family &&
          candidate.difficulty === difficulty,
      );
      const cellCandidates = selectAcceptedDesignRepresentatives(cellViews);
      const cellCandidateIds = new Set(
        cellCandidates.map((candidate) => candidate.candidateId),
      );
      const cellAnnotations = annotations.filter((annotation) =>
        cellCandidateIds.has(annotation.candidateId),
      );
      const cellCounts = annotationCounts(cellAnnotations);
      const novelAnnotations = cellAnnotations.filter(
        (annotation) => annotation.annotation === "novel",
      );
      const novelFingerprints = new Set(
        novelAnnotations.map((annotation) => {
          const candidate = cellCandidates.find(
            (entry) => entry.candidateId === annotation.candidateId,
          );
          return candidate?.structuralFingerprint ?? annotation.candidateId;
        }),
      );
      aiRows.push({
        family,
        modality,
        difficulty,
        accepted: cellCandidates.length,
        acceptedViews: cellViews.length,
        ...cellCounts,
        distinctFingerprints: new Set(
          cellCandidates.map((candidate) => candidate.structuralFingerprint),
        ).size,
        distinctNovelFingerprints: novelFingerprints.size,
        novelCandidateCount: novelAnnotations.length,
        repeatedNovelCount: novelAnnotations.length - novelFingerprints.size,
        exactClusterCount: aiSummary.exactClusters.filter((cluster) =>
          cluster.candidateIds.some((id) => cellCandidateIds.has(id)),
        ).length,
        nearPairCount: aiSummary.nearPairs.filter(
          (pair) =>
            cellCandidateIds.has(pair.leftCandidateId) &&
            cellCandidateIds.has(pair.rightCandidateId),
        ).length,
        nearClusterCount: aiSummary.nearClusters.filter((cluster) =>
          cluster.candidateIds.some((id) => cellCandidateIds.has(id)),
        ).length,
      });
    }
  }

  const base = {
    kind: "design_novelty_report" as const,
    version: DESIGN_NOVELTY_REPORT_VERSION,
    frozenHash: input.frozen.referenceHash,
    cohortHash: input.cohort.cohortHash,
    reference: [
      ...referenceRows("frozen", input.frozen),
      ...referenceRows("cohort", input.cohort),
    ],
    baseline: baselineRows,
    ai: aiRows,
    aiSummary,
    annotations: [...annotations].sort((left, right) =>
      left.candidateId < right.candidateId ? -1 : 1,
    ),
    baselineAnnotations: [...baselineAnnotations].sort((left, right) =>
      left.candidateId < right.candidateId ? -1 : 1,
    ),
  };
  return DesignNoveltyReportSchema.parse({
    ...base,
    reportHash: sha256Hex(canonicalJson(base)),
  });
}

function computeDesignNoveltyReportHash(
  report: DesignNoveltyReport | Omit<DesignNoveltyReport, "reportHash">,
): string {
  const base = { ...report } as Record<string, unknown>;
  delete base.reportHash;
  return sha256Hex(canonicalJson(base));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function galleryShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;color:#17202a;background:#fbfcfd}
h1{font-size:1.5rem}table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid #d5dbe1;padding:.35rem .5rem;text-align:left;font-size:.85rem}
th{background:#eef2f6}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.75rem}
.card{border:1px solid #d5dbe1;border-radius:.5rem;padding:.75rem;background:#fff}
.muted{color:#5b6773;font-size:.8rem}.bad{color:#a61b1b}.ok{color:#176b2c}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function renderDesignReferenceGallery(
  frozen: FrozenReferenceDataset,
  cohort: CohortReferenceDataset,
): string {
  const summaryRows = [
    ...referenceRows("frozen", frozen),
    ...referenceRows("cohort", cohort),
  ]
    .map(
      (row) =>
        `<tr><td>${row.source}</td><td>${row.family}</td><td>${row.modality}</td><td>${row.outcomes}</td><td>${row.constructed}</td><td>${row.verified}</td><td>${row.failed}</td><td>${row.distinctFingerprints}</td><td>${row.difficultyConstructed[1]}/${row.difficultyOutcomes[1]}</td><td>${row.difficultyConstructed[2]}/${row.difficultyOutcomes[2]}</td><td>${row.difficultyConstructed[3]}/${row.difficultyOutcomes[3]}</td><td class="${row.coverageSatisfied ? "ok" : "bad"}">${String(row.coverageSatisfied)}</td></tr>`,
    )
    .join("\n");
  const cards = [...frozen.outcomes, ...cohort.outcomes]
    .map((outcome) => {
      const statusClass = outcome.status === "constructed" ? "ok" : "bad";
      return `<article class="card">
<h2>${escapeHtml(outcome.family)} / D${outcome.difficulty}</h2>
<p class="muted">${outcome.source} #${outcome.sourceIndex}${outcome.assignmentId === null ? "" : ` / ${escapeHtml(outcome.assignmentId)}`}</p>
<p class="${statusClass}">${outcome.status}${outcome.failureCode === null ? "" : ` / ${escapeHtml(outcome.failureCode)}`}</p>
<p class="muted">fingerprint ${escapeHtml(outcome.structuralFingerprint ?? "-")}</p>
<p class="muted">draws ${outcome.drawsUsed ?? "-"} / options ${escapeHtml(outcome.options?.optionsHash ?? "-")}</p>
<p class="muted">renderer ${escapeHtml(outcome.renderer?.version ?? "-")}</p>
</article>`;
    })
    .join("\n");
  return galleryShell(
    "P48 baseline reference gallery",
    `<h1>P48 baseline reference gallery</h1>
<p>Frozen reference: ${frozen.outcomes.length} outcomes, hash <code>${frozen.referenceHash}</code>.</p>
<p>Cohort reference: ${cohort.outcomes.length} outcomes, hash <code>${cohort.cohortHash}</code>.</p>
<table><thead><tr><th>source</th><th>family</th><th>modality</th><th>outcomes</th><th>constructed</th><th>verified</th><th>failed</th><th>distinct</th><th>D1 c/o</th><th>D2 c/o</th><th>D3 c/o</th><th>coverage</th></tr></thead><tbody>${summaryRows}</tbody></table>
<p class="muted">Presentation is pending in P48. Solver-verified baseline specs are not marked accepted.</p>
<div class="cards">${cards}</div>`,
  );
}

export function renderDesignNoveltyGallery(
  report: DesignNoveltyReport,
): string {
  const rows = report.ai
    .map(
      (row) =>
        `<tr><td>${row.family}</td><td>${row.modality}</td><td>D${row.difficulty}</td><td>${row.accepted}</td><td>${row.duplicate}</td><td>${row.near}</td><td>${row.novel}</td><td>${row.unknown}</td><td>${row.distinctFingerprints}</td><td>${row.distinctNovelFingerprints}</td><td>${row.repeatedNovelCount}</td></tr>`,
    )
    .join("\n");
  const cards = report.annotations
    .map(
      (annotation) => `<article class="card">
<h2>${escapeHtml(annotation.candidateId)}</h2>
<p class="muted">${annotation.family} / D${annotation.difficulty} / ${annotation.arm} / ${annotation.view}</p>
<p class="${annotation.annotation === "novel" ? "ok" : annotation.annotation === "novelty_unknown" ? "bad" : ""}">${annotation.annotation}</p>
<p class="muted">exact ${annotation.exactMatchCount} / near ${annotation.nearMatchCount} / Jaccard ${annotation.jaccardMin ?? "-"}..${annotation.jaccardMax ?? "-"}</p>
<p class="muted">${escapeHtml(annotation.reason)}</p>
</article>`,
    )
    .join("\n");
  return galleryShell(
    "P48 structural novelty gallery",
    `<h1>P48 structural novelty gallery</h1>
<p>Report hash <code>${report.reportHash}</code>. Novelty is a finite-corpus structural measurement, not semantic novelty or human quality.</p>
<table><thead><tr><th>family</th><th>modality</th><th>difficulty</th><th>accepted</th><th>duplicate</th><th>near</th><th>novel</th><th>unknown</th><th>distinct</th><th>distinct novel</th><th>repeated novel</th></tr></thead><tbody>${rows}</tbody></table>
<div class="cards">${cards}</div>`,
  );
}

export { renderDesignViewGallery } from "../presentation/design-view.js";
export type { BuiltDesignView, DesignView } from "../presentation/design-view.js";

export const DESIGNER_COHORT_METRICS_VERSION = "p50.1-metrics-v1" as const;

const DesignerMetricValueSchema = z.strictObject({
  numerator: z.number().int().nonnegative().nullable(),
  denominator: z.number().int().nonnegative().nullable(),
  value: z.number().min(0).max(1).nullable(),
  interval: z
    .strictObject({
      lower: z.number().min(0).max(1),
      upper: z.number().min(0).max(1),
      method: z.literal("wilson95"),
    })
    .nullable(),
  status: z.enum(["ok", "not_applicable", "incomplete"]),
});
export type DesignerMetricValue = z.infer<typeof DesignerMetricValueSchema>;

export const DesignerCandidateMetricsRowSchema = z.strictObject({
  slotId: z.string().min(1),
  assignmentId: z.string().min(1),
  arm: z.enum(["baseline", "ai_one_shot", "ai_feedback"]),
  family: z.enum(FAMILIES),
  modality: z.enum(["text", "svg"]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  stage: z.string().min(1),
  verdict: z.enum(["accepted", "rejected", "inconclusive", "generation_error"]).nullable(),
  firstAttemptVerdict: z
    .enum(["accepted", "rejected", "inconclusive", "generation_error"])
    .nullable(),
  finalVerdict: z
    .enum(["accepted", "rejected", "inconclusive", "generation_error"])
    .nullable(),
  attemptCount: z.number().int().nonnegative(),
  attemptVerdicts: z.array(
    z.enum(["accepted", "rejected", "inconclusive", "generation_error"]),
  ),
  firstDiagnosticCode: z.string().nullable(),
  finalDiagnosticCode: z.string().nullable(),
  firstStructuralFingerprint: z.string().nullable(),
  finalStructuralFingerprint: z.string().nullable(),
  firstNovelty: z.enum([
    "baseline_duplicate",
    "near_baseline",
    "novel",
    "novelty_unknown",
  ]).nullable(),
  finalNovelty: z.enum([
    "baseline_duplicate",
    "near_baseline",
    "novel",
    "novelty_unknown",
  ]).nullable(),
  firstCostStatus: z.enum(["none", "known", "unknown"]),
  firstCostUsd: z.string().nullable(),
  totalCostStatus: z.enum(["none", "known", "unknown"]),
  totalCostUsd: z.string().nullable(),
  unknownAttempts: z.number().int().nonnegative(),
  knownAttempts: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cachedReadTokens: z.number().int().nonnegative().nullable(),
  cachedWriteTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  httpLatencyMs: z.array(z.number().int().nonnegative()),
  logicalLatencyMs: z.array(z.number().int().nonnegative()),
  activeStageMs: z.number().int().nonnegative().nullable(),
  firstStartedAt: z.iso.datetime().nullable(),
  terminalFinishedAt: z.iso.datetime().nullable(),
  observedProviders: z.array(z.string()),
  observedModels: z.array(z.string()),
  missingProviderIdentity: z.number().int().nonnegative(),
  missingModelIdentity: z.number().int().nonnegative(),
  errorCodes: z.array(z.string()),
});
export type DesignerCandidateMetricsRow = z.infer<
  typeof DesignerCandidateMetricsRowSchema
>;

export const DesignerHumanSummarySchema = z.strictObject({
  synthetic: z.boolean(),
  sampleHash: z.string().nullable(),
  corePlanned: z.number().int().nonnegative(),
  coreInspected: z.number().int().nonnegative(),
  aiCorePlanned: z.number().int().nonnegative(),
  aiCoreClearSolved: z.number().int().nonnegative(),
  correctnessDefects: z.number().int().nonnegative(),
  pairedInterest: z.strictObject({
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
  }),
  pairedClarity: z.strictObject({
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
  }),
});
export type DesignerHumanSummary = z.infer<typeof DesignerHumanSummarySchema>;

const DesignerArmMetricsSchema = z.strictObject({
  planned: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  unstarted: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  firstAttempts: z.number().int().nonnegative(),
  firstAttemptFormalAccepted: z.number().int().nonnegative(),
  finalFormalAccepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  generationErrors: z.number().int().nonnegative(),
  repaired: z.number().int().nonnegative(),
  repairedAccepted: z.number().int().nonnegative(),
  repairableFirstFailures: z.number().int().nonnegative(),
  oneRepairAccepted: z.number().int().nonnegative(),
  twoRepairAccepted: z.number().int().nonnegative(),
  repairPending: z.number().int().nonnegative(),
  baselineDuplicate: z.number().int().nonnegative(),
  nearBaseline: z.number().int().nonnegative(),
  novel: z.number().int().nonnegative(),
  noveltyUnknown: z.number().int().nonnegative(),
  distinctFinalFingerprints: z.number().int().nonnegative(),
  baselineOverlapAccepted: z.number().int().nonnegative(),
  firstAttemptFormalAcceptance: DesignerMetricValueSchema,
  finalFormalAcceptance: DesignerMetricValueSchema,
  repairSuccessRate: DesignerMetricValueSchema,
  repairLift: DesignerMetricValueSchema,
  novelAcceptance: DesignerMetricValueSchema,
  novelShare: DesignerMetricValueSchema,
  structuralDiversity: DesignerMetricValueSchema,
  baselineOverlap: DesignerMetricValueSchema,
  cost: z.strictObject({
    firstShotKnownUsd: z.string().nullable(),
    finalKnownUsd: z.string().nullable(),
    unknownAttempts: z.number().int().nonnegative(),
    knownAttempts: z.number().int().nonnegative(),
    averageFirstAttemptAcceptedUsd: z.string().nullable(),
    averageFinalAcceptedUsd: z.string().nullable(),
    averageNovelAcceptedUsd: z.string().nullable(),
    callsPerFinalAccepted: z.number().nullable(),
  }),
  usage: z.strictObject({
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cachedReadTokens: z.number().int().nonnegative().nullable(),
    cachedWriteTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    missingTokenRows: z.number().int().nonnegative(),
  }),
  errorCodeDistribution: z.record(z.string(), z.number().int().nonnegative()),
  firstErrorCodeDistribution: z.record(
    z.string(),
    z.number().int().nonnegative(),
  ),
  repairErrorCodeDistribution: z.record(
    z.string(),
    z.number().int().nonnegative(),
  ),
  latency: z.strictObject({
    httpMeanMs: z.number().nullable(),
    httpMedianMs: z.number().nullable(),
    httpP95Ms: z.number().nullable(),
    httpSamples: z.number().int().nonnegative(),
    logicalMeanMs: z.number().nullable(),
    logicalMedianMs: z.number().nullable(),
    logicalP95Ms: z.number().nullable(),
    logicalSamples: z.number().int().nonnegative(),
    activeMeanMs: z.number().nullable(),
    activeSamples: z.number().int().nonnegative(),
  }),
  providerMix: z.record(z.string(), z.number().int().nonnegative()),
  modelMix: z.record(z.string(), z.number().int().nonnegative()),
  missingProviderIdentity: z.number().int().nonnegative(),
  missingModelIdentity: z.number().int().nonnegative(),
});
export type DesignerArmMetrics = z.infer<typeof DesignerArmMetricsSchema>;

const DesignerStratumSchema = z.strictObject({
  key: z.string(),
  planned: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  firstAccepted: z.number().int().nonnegative(),
  finalAccepted: z.number().int().nonnegative(),
  novelAccepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  generationErrors: z.number().int().nonnegative(),
  finalAcceptance: DesignerMetricValueSchema,
  novelAcceptance: DesignerMetricValueSchema,
});
export type DesignerStratum = z.infer<typeof DesignerStratumSchema>;

export const DesignerCohortMetricsSchema = z.strictObject({
  version: z.literal(DESIGNER_COHORT_METRICS_VERSION),
  runId: z.string().min(1),
  planHash: z.string().min(1),
  runKind: z.enum(["design_primary", "design_pilot", "design_mock"]),
  evidenceKind: z.enum(["mock", "live"]),
  status: z.string().min(1),
  complete: z.boolean(),
  planned: z.strictObject({
    assignments: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    perArm: z.number().int().nonnegative(),
    textAssignments: z.number().int().nonnegative(),
    svgAssignments: z.number().int().nonnegative(),
    perFamilyAssignments: z.number().int().nonnegative(),
    difficultyAssignments: z.strictObject({
      1: z.number().int().nonnegative(),
      2: z.number().int().nonnegative(),
      3: z.number().int().nonnegative(),
    }),
  }),
  arms: z.strictObject({
    baseline: DesignerArmMetricsSchema,
    ai_one_shot: DesignerArmMetricsSchema,
    ai_feedback: DesignerArmMetricsSchema,
  }),
  strata: z.strictObject({
    byModality: z.array(DesignerStratumSchema),
    byFamily: z.array(DesignerStratumSchema),
    byDifficulty: z.array(DesignerStratumSchema),
    byFamilyArm: z.array(DesignerStratumSchema),
    byModalityDifficulty: z.array(DesignerStratumSchema),
  }),
  novelty: z.strictObject({
    frozenComplete: z.boolean(),
    frozenCoverageSatisfied: z.boolean(),
    cohortComplete: z.boolean(),
    coverageByFamily: z.record(z.string(), z.boolean()),
  }),
  human: DesignerHumanSummarySchema.nullable(),
  wallTime: z.strictObject({
    firstStartedAt: z.iso.datetime().nullable(),
    lastFinishedAt: z.iso.datetime().nullable(),
    wallMs: z.number().int().nonnegative().nullable(),
  }),
  failureCodeNote: z.literal(
    "Failure-code frequencies may sum above the candidate count; use the exclusive verdict histogram for candidate totals.",
  ),
});
export type DesignerCohortMetrics = z.infer<typeof DesignerCohortMetricsSchema>;

function wilsonInterval(
  successes: number,
  total: number,
): { lower: number; upper: number; method: "wilson95" } | null {
  if (total === 0) {
    return null;
  }
  const zScore = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (zScore * zScore) / total;
  const centre = (p + (zScore * zScore) / (2 * total)) / denominator;
  const margin =
    (zScore *
      Math.sqrt((p * (1 - p)) / total + (zScore * zScore) / (4 * total * total))) /
    denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
    method: "wilson95",
  };
}

function metric(
  numerator: number | null,
  denominator: number | null,
  options: { readonly incomplete?: boolean } = {},
): DesignerMetricValue {
  if (numerator === null || denominator === null || denominator === 0) {
    return {
      numerator,
      denominator,
      value: null,
      interval: null,
      status: "not_applicable",
    };
  }
  return {
    numerator,
    denominator,
    value: numerator / denominator,
    interval: wilsonInterval(numerator, denominator),
    status: options.incomplete === true ? "incomplete" : "ok",
  };
}

function nearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundUsd(value: number): string {
  return value.toFixed(6);
}

function sumKnownCosts(
  rows: readonly DesignerCandidateMetricsRow[],
  selector: (row: DesignerCandidateMetricsRow) => {
    readonly status: "none" | "known" | "unknown";
    readonly usd: string | null;
  },
): { readonly known: number; readonly unknown: number } {
  let known = 0;
  let unknown = 0;
  for (const row of rows) {
    const cost = selector(row);
    if (cost.status === "known" && cost.usd !== null) {
      known += Number(cost.usd);
    } else if (cost.status === "unknown") {
      unknown += 1;
    }
  }
  return { known, unknown };
}

function addDistribution(
  target: Record<string, number>,
  values: readonly string[],
): void {
  for (const value of values) {
    target[value] = (target[value] ?? 0) + 1;
  }
}

function computeArmMetrics(
  rows: readonly DesignerCandidateMetricsRow[],
  planned: number,
): DesignerArmMetrics {
  const attempted = rows.filter((row) => row.stage !== "planned").length;
  const paused = rows.filter(
    (row) => row.stage !== "terminal" && row.stage !== "planned",
  ).length;
  const unstarted = rows.filter((row) => row.stage === "planned").length;
  const firstAccepted = rows.filter(
    (row) => row.firstAttemptVerdict === "accepted",
  ).length;
  const finalAccepted = rows.filter(
    (row) => row.finalVerdict === "accepted",
  ).length;
  const rejected = rows.filter((row) => row.finalVerdict === "rejected").length;
  const inconclusive = rows.filter(
    (row) => row.finalVerdict === "inconclusive",
  ).length;
  const generationErrors = rows.filter(
    (row) => row.finalVerdict === "generation_error",
  ).length;
  const repaired = rows.filter((row) => row.attemptCount > 1).length;
  const repairableFirstFailures = rows.filter(
    (row) =>
      row.firstAttemptVerdict === "rejected" ||
      (row.firstAttemptVerdict === "inconclusive" &&
        row.firstDiagnosticCode === "SOLVER_LIMIT"),
  ).length;
  const repairedAccepted = rows.filter(
    (row) => row.attemptCount > 1 && row.finalVerdict === "accepted",
  ).length;
  const oneRepairAccepted = rows.filter(
    (row) => row.attemptVerdicts[1] === "accepted",
  ).length;
  const twoRepairAccepted = rows.filter(
    (row) => row.attemptVerdicts[2] === "accepted",
  ).length;
  const repairPending = rows.filter(
    (row) =>
      row.attemptCount < 3 &&
      row.stage !== "terminal" &&
      row.finalVerdict !== "accepted" &&
      row.firstDiagnosticCode !== "GENERATION_ERROR",
  ).length;
  const baselineDuplicate = rows.filter(
    (row) => row.finalNovelty === "baseline_duplicate",
  ).length;
  const nearBaseline = rows.filter(
    (row) => row.finalNovelty === "near_baseline",
  ).length;
  const novel = rows.filter((row) => row.finalNovelty === "novel").length;
  const noveltyUnknown = rows.filter(
    (row) => row.finalNovelty === "novelty_unknown",
  ).length;
  const finalFingerprints = new Set(
    rows
      .filter((row) => row.finalVerdict === "accepted")
      .map((row) => row.finalStructuralFingerprint)
      .filter((value): value is string => value !== null),
  );
  const baselineOverlapAccepted = rows.filter(
    (row) =>
      row.finalVerdict === "accepted" &&
      (row.finalNovelty === "baseline_duplicate" ||
        row.finalNovelty === "near_baseline"),
  ).length;
  const firstCost = sumKnownCosts(rows, (row) => ({
    status: row.firstCostStatus,
    usd: row.firstCostUsd,
  }));
  const totalCost = sumKnownCosts(rows, (row) => ({
    status: row.totalCostStatus,
    usd: row.totalCostUsd,
  }));
  const unknownAttempts = rows.reduce(
    (sum, row) => sum + row.unknownAttempts,
    0,
  );
  const knownAttempts = rows.reduce((sum, row) => sum + row.knownAttempts, 0);
  const firstShotKnown = firstCost.unknown > 0 ? null : firstCost.known;
  const finalKnown = totalCost.unknown > 0 ? null : totalCost.known;
  const novelAcceptedRows = rows.filter(
    (row) => row.finalVerdict === "accepted" && row.finalNovelty === "novel",
  );
  const firstAcceptedCost =
    firstShotKnown === null || firstAccepted === 0
      ? null
      : firstShotKnown / firstAccepted;
  const finalAcceptedCost =
    finalKnown === null || finalAccepted === 0
      ? null
      : finalKnown / finalAccepted;
  const novelAcceptedCost =
    finalKnown === null || novelAcceptedRows.length === 0
      ? null
      : finalKnown / novelAcceptedRows.length;
  const errorDistribution: Record<string, number> = {};
  const firstErrorDistribution: Record<string, number> = {};
  const repairErrorDistribution: Record<string, number> = {};
  for (const row of rows) {
    addDistribution(errorDistribution, row.errorCodes);
    if (row.firstDiagnosticCode !== null) {
      addDistribution(firstErrorDistribution, [row.firstDiagnosticCode]);
    }
    if (row.attemptVerdicts.length > 1 && row.finalDiagnosticCode !== null) {
      addDistribution(repairErrorDistribution, [row.finalDiagnosticCode]);
    }
  }
  const httpLatency = rows.flatMap((row) => row.httpLatencyMs);
  const logicalLatency = rows.flatMap((row) => row.logicalLatencyMs);
  const activeLatency = rows
    .map((row) => row.activeStageMs)
    .filter((value): value is number => value !== null);
  const providerMix: Record<string, number> = {};
  const modelMix: Record<string, number> = {};
  for (const row of rows) {
    addDistribution(providerMix, row.observedProviders);
    addDistribution(modelMix, row.observedModels);
  }
  const tokenRows = rows.filter(
    (row) => row.totalTokens !== null || row.promptTokens !== null,
  );
  const sumNullable = (
    values: readonly (number | null)[],
  ): number | null =>
    values.some((value) => value === null)
      ? null
      : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    planned,
    attempted,
    unstarted,
    paused,
    firstAttempts: rows.filter((row) => row.firstAttemptVerdict !== null).length,
    firstAttemptFormalAccepted: firstAccepted,
    finalFormalAccepted: finalAccepted,
    rejected,
    inconclusive,
    generationErrors,
    repaired,
    repairedAccepted,
    repairableFirstFailures,
    oneRepairAccepted,
    twoRepairAccepted,
    repairPending,
    baselineDuplicate,
    nearBaseline,
    novel,
    noveltyUnknown,
    distinctFinalFingerprints: finalFingerprints.size,
    baselineOverlapAccepted,
    firstAttemptFormalAcceptance: metric(firstAccepted, planned),
    finalFormalAcceptance: metric(finalAccepted, planned),
    repairSuccessRate: metric(repairedAccepted, repairableFirstFailures),
    repairLift: metric(repairedAccepted, planned),
    novelAcceptance: metric(novel, planned),
    novelShare: metric(novel, finalAccepted),
    structuralDiversity: metric(finalFingerprints.size, finalAccepted),
    baselineOverlap: metric(baselineOverlapAccepted, finalAccepted),
    cost: {
      firstShotKnownUsd: firstShotKnown === null ? null : roundUsd(firstShotKnown),
      finalKnownUsd: finalKnown === null ? null : roundUsd(finalKnown),
      unknownAttempts,
      knownAttempts,
      averageFirstAttemptAcceptedUsd:
        firstAcceptedCost === null ? null : roundUsd(firstAcceptedCost),
      averageFinalAcceptedUsd:
        finalAcceptedCost === null ? null : roundUsd(finalAcceptedCost),
      averageNovelAcceptedUsd:
        novelAcceptedCost === null ? null : roundUsd(novelAcceptedCost),
      callsPerFinalAccepted:
        finalAccepted === 0
          ? null
          : rows.reduce((sum, row) => sum + row.attemptCount, 0) / finalAccepted,
    },
    usage: {
      promptTokens: sumNullable(tokenRows.map((row) => row.promptTokens)),
      completionTokens: sumNullable(
        tokenRows.map((row) => row.completionTokens),
      ),
      totalTokens: sumNullable(tokenRows.map((row) => row.totalTokens)),
      cachedReadTokens: sumNullable(
        tokenRows.map((row) => row.cachedReadTokens),
      ),
      cachedWriteTokens: sumNullable(
        tokenRows.map((row) => row.cachedWriteTokens),
      ),
      reasoningTokens: sumNullable(
        tokenRows.map((row) => row.reasoningTokens),
      ),
      missingTokenRows: rows.filter(
        (row) => row.attemptCount > 0 && row.totalTokens === null,
      ).length,
    },
    errorCodeDistribution: errorDistribution,
    firstErrorCodeDistribution: firstErrorDistribution,
    repairErrorCodeDistribution: repairErrorDistribution,
    latency: {
      httpMeanMs: mean(httpLatency),
      httpMedianMs: median(httpLatency),
      httpP95Ms: nearestRank(httpLatency, 0.95),
      httpSamples: httpLatency.length,
      logicalMeanMs: mean(logicalLatency),
      logicalMedianMs: median(logicalLatency),
      logicalP95Ms: nearestRank(logicalLatency, 0.95),
      logicalSamples: logicalLatency.length,
      activeMeanMs: mean(activeLatency),
      activeSamples: activeLatency.length,
    },
    providerMix,
    modelMix,
    missingProviderIdentity: rows.reduce(
      (sum, row) => sum + row.missingProviderIdentity,
      0,
    ),
    missingModelIdentity: rows.reduce(
      (sum, row) => sum + row.missingModelIdentity,
      0,
    ),
  };
}

function stratum(
  key: string,
  rows: readonly DesignerCandidateMetricsRow[],
): DesignerStratum {
  const planned = rows.length;
  const attempted = rows.filter((row) => row.stage !== "planned").length;
  const firstAccepted = rows.filter(
    (row) => row.firstAttemptVerdict === "accepted",
  ).length;
  const finalAccepted = rows.filter(
    (row) => row.finalVerdict === "accepted",
  ).length;
  const novelAccepted = rows.filter(
    (row) => row.finalVerdict === "accepted" && row.finalNovelty === "novel",
  ).length;
  return {
    key,
    planned,
    attempted,
    firstAccepted,
    finalAccepted,
    novelAccepted,
    rejected: rows.filter((row) => row.finalVerdict === "rejected").length,
    inconclusive: rows.filter((row) => row.finalVerdict === "inconclusive")
      .length,
    generationErrors: rows.filter(
      (row) => row.finalVerdict === "generation_error",
    ).length,
    finalAcceptance: metric(finalAccepted, planned),
    novelAcceptance: metric(novelAccepted, planned),
  };
}

export interface ComputeDesignerCohortMetricsInput {
  readonly runId: string;
  readonly planHash: string;
  readonly runKind: DesignerCohortMetrics["runKind"];
  readonly evidenceKind: DesignerCohortMetrics["evidenceKind"];
  readonly status: string;
  readonly plannedAssignments: number;
  readonly plannedCandidates: number;
  readonly plannedTextAssignments: number;
  readonly plannedSvgAssignments: number;
  readonly plannedPerFamilyAssignments: number;
  readonly plannedDifficultyAssignments: {
    readonly 1: number;
    readonly 2: number;
    readonly 3: number;
  };
  readonly rows: readonly DesignerCandidateMetricsRow[];
  readonly novelty: DesignerCohortMetrics["novelty"];
  readonly human: DesignerHumanSummary | null;
}

export function computeDesignerCohortMetrics(
  input: ComputeDesignerCohortMetricsInput,
): DesignerCohortMetrics {
  const rows = input.rows.map((row) => DesignerCandidateMetricsRowSchema.parse(row));
  const byArm = (arm: DesignerCandidateMetricsRow["arm"]) =>
    rows.filter((row) => row.arm === arm);
  const plannedPerArm =
    input.plannedCandidates === 0
      ? 0
      : input.plannedCandidates / 3;
  const arms = {
    baseline: computeArmMetrics(byArm("baseline"), plannedPerArm),
    ai_one_shot: computeArmMetrics(byArm("ai_one_shot"), plannedPerArm),
    ai_feedback: computeArmMetrics(byArm("ai_feedback"), plannedPerArm),
  };
  const group = (
    keys: readonly string[],
    keyFor: (row: DesignerCandidateMetricsRow) => string,
  ): DesignerStratum[] =>
    keys.map((key) =>
      stratum(
        key,
        rows.filter((row) => keyFor(row) === key),
      ),
    );
  const families = [...FAMILIES];
  const difficulties = [...DIFFICULTIES];
  const modalities = ["text", "svg"] as const;
  const started = rows
    .map((row) => row.firstStartedAt)
    .filter((value): value is string => value !== null)
    .sort();
  const finished = rows
    .map((row) => row.terminalFinishedAt)
    .filter((value): value is string => value !== null)
    .sort();
  const firstStartedAt = started[0] ?? null;
  const lastFinishedAt = finished[finished.length - 1] ?? null;
  return DesignerCohortMetricsSchema.parse({
    version: DESIGNER_COHORT_METRICS_VERSION,
    runId: input.runId,
    planHash: input.planHash,
    runKind: input.runKind,
    evidenceKind: input.evidenceKind,
    status: input.status,
    complete:
      input.status === "completed" &&
      rows.length === input.plannedCandidates &&
      rows.every((row) => row.stage === "terminal" && row.finalVerdict !== null),
    planned: {
      assignments: input.plannedAssignments,
      candidates: input.plannedCandidates,
      perArm: plannedPerArm,
      textAssignments: input.plannedTextAssignments,
      svgAssignments: input.plannedSvgAssignments,
      perFamilyAssignments: input.plannedPerFamilyAssignments,
      difficultyAssignments: input.plannedDifficultyAssignments,
    },
    arms,
    strata: {
      byModality: group(modalities, (row) => row.modality),
      byFamily: group(families, (row) => row.family),
      byDifficulty: group(difficulties.map(String), (row) =>
        String(row.difficulty),
      ),
      byFamilyArm: families.flatMap((family) =>
        (["baseline", "ai_one_shot", "ai_feedback"] as const).map((arm) =>
          stratum(
            `${family}:${arm}`,
            rows.filter((row) => row.family === family && row.arm === arm),
          ),
        ),
      ),
      byModalityDifficulty: modalities.flatMap((modality) =>
        difficulties.map((difficulty) =>
          stratum(
            `${modality}:${difficulty}`,
            rows.filter(
              (row) =>
                row.modality === modality && row.difficulty === difficulty,
            ),
          ),
        ),
      ),
    },
    novelty: input.novelty,
    human: input.human,
    wallTime: {
      firstStartedAt,
      lastFinishedAt,
      wallMs:
        firstStartedAt === null || lastFinishedAt === null
          ? null
          : Math.max(
              0,
              Date.parse(lastFinishedAt) - Date.parse(firstStartedAt),
            ),
    },
    failureCodeNote:
      "Failure-code frequencies may sum above the candidate count; use the exclusive verdict histogram for candidate totals.",
  });
}

const DesignerEvidenceArtifactSchema = z.looseObject({
  version: z.literal(1),
  spec: z.unknown().nullable(),
  solve: z.unknown().nullable(),
});

export interface LoadDesignerCohortMetricsOptions {
  readonly frozen?: FrozenReferenceDataset;
  readonly cohort?: CohortReferenceDataset;
  readonly human?: DesignerHumanSummary | null;
}

function specFromAttempt(
  db: Database.Database,
  attempt: DesignAttemptRecord,
): unknown | null {
  const artifact = attempt.artifacts.find(
    (entry) => entry.role === "solver_result",
  );
  if (artifact === undefined) {
    return null;
  }
  const bytes = getArtifactById(db, artifact.artifact.artifactId);
  try {
    const parsed = DesignerEvidenceArtifactSchema.safeParse(
      JSON.parse(bytes.bytes.toString("utf8")),
    );
    return parsed.success ? parsed.data.spec : null;
  } catch {
    return null;
  }
}

function noveltyForAttempt(input: {
  readonly attempt: DesignAttemptRecord;
  readonly spec: unknown | null;
  readonly view: "first" | "final";
  readonly assignmentId: string;
  readonly arm: DesignerCandidateMetricsRow["arm"];
  readonly family: DesignerCandidateMetricsRow["family"];
  readonly difficulty: 1 | 2 | 3;
  readonly frozen?: FrozenReferenceDataset;
  readonly cohort?: CohortReferenceDataset;
}): {
  readonly fingerprint: string | null;
  readonly annotation: DesignerCandidateMetricsRow["finalNovelty"];
} {
  if (input.spec === null) {
    return { fingerprint: null, annotation: null };
  }
  try {
    const candidate = buildNoveltyCandidate({
      candidateId: `${input.attempt.slotId}:${input.view}`,
      assignmentId: input.assignmentId,
      arm: input.arm,
      view: input.view,
      family: input.family,
      difficulty: input.difficulty,
      accepted: input.attempt.verdict === "accepted",
      spec: input.spec,
    });
    if (input.frozen === undefined || input.cohort === undefined) {
      return {
        fingerprint: candidate.structuralFingerprint,
        annotation: "novelty_unknown",
      };
    }
    const annotation = annotateNoveltyCandidate({
      candidate,
      frozen: buildNoveltyReferenceView(input.frozen),
      cohort: buildNoveltyReferenceView(input.cohort),
    });
    return {
      fingerprint: candidate.structuralFingerprint,
      annotation: annotation.annotation,
    };
  } catch {
    return { fingerprint: null, annotation: "novelty_unknown" };
  }
}

function nullableSum(values: readonly (number | null)[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function loadDesignerCohortMetrics(
  db: Database.Database,
  runId: string,
  options: LoadDesignerCohortMetricsOptions = {},
): DesignerCohortMetrics {
  const run = getDesignerRun(db, runId);
  const plan = run.manifest;
  const slots = listDesignerSlots(db, runId);
  const rows: DesignerCandidateMetricsRow[] = [];
  for (const slot of slots) {
    const attempts = listDesignAttempts(db, runId, slot.slotId);
    const stages = listDesignerStageResults(db, runId, slot.slotId);
    const first = attempts[0];
    const final = attempts[attempts.length - 1];
    const firstSpec = first === undefined ? null : specFromAttempt(db, first);
    const finalSpec = final === undefined ? null : specFromAttempt(db, final);
    const firstNovelty =
      first === undefined
        ? { fingerprint: null, annotation: null }
        : noveltyForAttempt({
            attempt: first,
            spec: firstSpec,
            view: "first",
            assignmentId: slot.assignmentId,
            arm: slot.arm,
            family: slot.family,
            difficulty: slot.difficulty,
            ...(options.frozen === undefined ? {} : { frozen: options.frozen }),
            ...(options.cohort === undefined ? {} : { cohort: options.cohort }),
          });
    const finalNovelty =
      final === undefined
        ? { fingerprint: null, annotation: null }
        : noveltyForAttempt({
            attempt: final,
            spec: finalSpec,
            view: "final",
            assignmentId: slot.assignmentId,
            arm: slot.arm,
            family: slot.family,
            difficulty: slot.difficulty,
            ...(options.frozen === undefined ? {} : { frozen: options.frozen }),
            ...(options.cohort === undefined ? {} : { cohort: options.cohort }),
          });
    const logicalRows = attempts.flatMap((attempt) =>
      attempt.logicalCallId === null ? [] : listAttempts(db, attempt.logicalCallId),
    );
    const httpLatencyMs = logicalRows
      .map((attempt) => attempt.elapsedMs)
      .filter((value): value is number => value !== null);
    const logicalLatencyMs = attempts
      .filter((attempt) => attempt.logicalCallId !== null)
      .map((attempt) => {
        const callAttempts = listAttempts(db, attempt.logicalCallId as string);
        const starts = callAttempts
          .map((entry) => entry.startedAt)
          .filter((value): value is string => value !== null)
          .sort();
        const ends = callAttempts
          .map((entry) => entry.finishedAt)
          .filter((value): value is string => value !== null)
          .sort();
        if (starts.length === 0 || ends.length === 0) {
          return attempt.elapsedMs;
        }
        return Math.max(
          0,
          Date.parse(ends[ends.length - 1] as string) -
            Date.parse(starts[0] as string),
        );
      })
      .filter((value): value is number => value !== null);
    const totalCostKnown = attempts.every(
      (attempt) =>
        attempt.costStatus === "none" ||
        (attempt.costStatus === "known" && attempt.costUsd !== null),
    );
    const firstCostKnown =
      first === undefined ||
      first.costStatus === "none" ||
      (first.costStatus === "known" && first.costUsd !== null);
    const totalKnown = attempts.reduce(
      (sum, attempt) =>
        attempt.costStatus === "known" && attempt.costUsd !== null
          ? sum + Number(attempt.costUsd)
          : sum,
      0,
    );
    const firstKnown = first?.costUsd === null || first?.costUsd === undefined
      ? 0
      : Number(first.costUsd);
    const observedProviders = logicalRows
      .map((attempt) => attempt.observedProvider)
      .filter((value): value is string => value !== null);
    const observedModels = logicalRows
      .map((attempt) => attempt.observedModel)
      .filter((value): value is string => value !== null);
    const errorCodes = attempts.flatMap((attempt) =>
      attempt.diagnostic === null ? [] : [attempt.diagnostic.errorCode],
    );
    const activeStageMs = stages
      .map((stage) => stage.elapsedMs)
      .filter((value): value is number => value !== null);
    const terminal = stages.find((stage) => stage.stage === "terminal");
    rows.push(
      DesignerCandidateMetricsRowSchema.parse({
        slotId: slot.slotId,
        assignmentId: slot.assignmentId,
        arm: slot.arm,
        family: slot.family,
        modality: slot.modality,
        difficulty: slot.difficulty,
        stage: slot.stage,
        verdict: slot.verdict,
        firstAttemptVerdict: first?.verdict ?? null,
        finalVerdict: final?.verdict ?? null,
        attemptCount: attempts.length,
        attemptVerdicts: attempts.map((attempt) => attempt.verdict),
        firstDiagnosticCode: first?.diagnostic?.errorCode ?? null,
        finalDiagnosticCode: final?.diagnostic?.errorCode ?? null,
        firstStructuralFingerprint: firstNovelty.fingerprint,
        finalStructuralFingerprint: finalNovelty.fingerprint,
        firstNovelty: firstNovelty.annotation,
        finalNovelty: finalNovelty.annotation,
        firstCostStatus:
          first === undefined
            ? "none"
            : first.costStatus === "none"
              ? "none"
              : firstCostKnown
                ? "known"
                : "unknown",
        firstCostUsd:
          first === undefined || first.costStatus === "none"
            ? "0"
            : firstCostKnown
              ? String(firstKnown)
              : null,
        totalCostStatus: attempts.length === 0
          ? "none"
          : totalCostKnown
            ? "known"
            : "unknown",
        totalCostUsd:
          attempts.length === 0
            ? "0"
            : totalCostKnown
              ? String(totalKnown)
              : null,
        unknownAttempts: attempts.filter(
          (attempt) => attempt.costStatus === "unknown",
        ).length,
        knownAttempts: attempts.filter(
          (attempt) => attempt.costStatus === "known",
        ).length,
        promptTokens: nullableSum(logicalRows.map((attempt) => attempt.promptTokens)),
        completionTokens: nullableSum(
          logicalRows.map((attempt) => attempt.completionTokens),
        ),
        totalTokens: nullableSum(logicalRows.map((attempt) => attempt.totalTokens)),
        cachedReadTokens: nullableSum(
          logicalRows.map((attempt) => attempt.cachedReadTokens),
        ),
        cachedWriteTokens: nullableSum(
          logicalRows.map((attempt) => attempt.cachedWriteTokens),
        ),
        reasoningTokens: nullableSum(
          logicalRows.map((attempt) => attempt.reasoningTokens),
        ),
        httpLatencyMs,
        logicalLatencyMs,
        activeStageMs:
          activeStageMs.length === 0
            ? null
            : activeStageMs.reduce((sum, value) => sum + value, 0),
        firstStartedAt: first?.startedAt ?? null,
        terminalFinishedAt: terminal?.finishedAt ?? null,
        observedProviders,
        observedModels,
        missingProviderIdentity: logicalRows.filter(
          (attempt) => attempt.observedProvider === null,
        ).length,
        missingModelIdentity: logicalRows.filter(
          (attempt) => attempt.observedModel === null,
        ).length,
        errorCodes,
      }),
    );
  }
  const modalityCounts = {
    text: plan.assignments.filter((assignment) => assignment.modality === "text")
      .length,
    svg: plan.assignments.filter((assignment) => assignment.modality === "svg")
      .length,
  };
  const difficultyAssignments = {
    1: plan.assignments.filter((assignment) => assignment.difficulty === 1).length,
    2: plan.assignments.filter((assignment) => assignment.difficulty === 2).length,
    3: plan.assignments.filter((assignment) => assignment.difficulty === 3).length,
  };
  const coverageByFamily: Record<string, boolean> = {};
  if (options.frozen !== undefined) {
    for (const [index, family] of FAMILIES.entries()) {
      coverageByFamily[family] =
        options.frozen.coverage[index]?.coverageSatisfied ?? false;
    }
  }
  return computeDesignerCohortMetrics({
    runId,
    planHash: plan.planHash,
    runKind: plan.runKind,
    evidenceKind: run.evidenceKind,
    status: run.controlState,
    plannedAssignments: plan.assignments.length,
    plannedCandidates: plan.candidates.length,
    plannedTextAssignments: modalityCounts.text,
    plannedSvgAssignments: modalityCounts.svg,
    plannedPerFamilyAssignments: plan.assignments.length / FAMILIES.length,
    plannedDifficultyAssignments: difficultyAssignments,
    rows,
    novelty: {
      frozenComplete: options.frozen?.outcomes.length === 1_000,
      frozenCoverageSatisfied:
        options.frozen === undefined
          ? false
          : FAMILIES.every(
              (_family, index) =>
                options.frozen?.coverage[index]?.coverageSatisfied ?? false,
            ),
      cohortComplete: options.cohort?.outcomes.length === 100,
      coverageByFamily,
    },
    human: options.human ?? null,
  });
}
