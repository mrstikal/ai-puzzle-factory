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
  buildNoveltyReferenceView,
  selectAcceptedDesignRepresentatives,
  summarizeAiCandidates,
  type NoveltyAnnotationResult,
  type NoveltyCandidate,
} from "../design/novelty.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

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
