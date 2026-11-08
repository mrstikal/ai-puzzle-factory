import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getDesignerRun,
  listDesignAttempts,
  listDesignerSlots,
  listDesignerStageResults,
} from "../storage/repository.js";
import { getArtifactById } from "../storage/artifacts.js";
import { listAttempts } from "../ai/ledger.js";
import {
  buildCohortReference,
  buildFrozenReference,
} from "../design/baseline.js";
import { buildDesignerPlanManifest } from "../design/assignments.js";
import {
  annotateNoveltySpec,
  buildNoveltyReferenceView,
} from "../design/novelty.js";
import {
  loadDesignerCohortMetrics,
  type DesignerCohortMetrics,
} from "./design-metrics.js";
import type { DesignView } from "../presentation/design-view.js";
import type { DesignAttemptRecord } from "../design/attempts.js";
import { z } from "zod";

export interface DesignerExportRow {
  readonly slotId: string;
  readonly assignmentId: string;
  readonly arm: "baseline" | "ai_one_shot" | "ai_feedback";
  readonly family: string;
  readonly modality: "text" | "svg";
  readonly difficulty: 1 | 2 | 3;
  readonly stage: string;
  readonly verdict: string | null;
  readonly firstVerdict: string | null;
  readonly finalVerdict: string | null;
  readonly attemptCount: number;
  readonly firstAccepted: boolean;
  readonly finalAccepted: boolean;
  readonly repaired: boolean;
  readonly novelty: string | null;
  readonly question: string | null;
  readonly hint: string | null;
  readonly correctLabel: string | null;
  readonly correctValue: unknown;
  readonly explanationSteps: unknown;
  readonly svg: string | null;
  readonly svgHash: string | null;
  readonly pngHash: string | null;
  readonly pngArtifactId: number | null;
  readonly templateHash: string | null;
  readonly certificateHash: string | null;
  readonly firstCostUsd: string | null;
  readonly totalCostUsd: string | null;
  readonly unknownAttempts: number;
  readonly totalTokens: number | null;
  readonly latencyMs: number | null;
  readonly attempts: readonly {
    readonly attemptIndex: number;
    readonly role: string;
    readonly verdict: string;
    readonly errorCode: string | null;
    readonly costStatus: string;
    readonly costUsd: string | null;
    readonly elapsedMs: number;
    readonly diagnostic: unknown;
    readonly artifactHashes: readonly string[];
  }[];
}

const EvidenceSchema = z.looseObject({
  spec: z.unknown().nullable(),
});

function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function outputDirectory(runId: string, outputRoot: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      runId,
    )
  ) {
    throw new Error(`invalid run UUID: ${runId}`);
  }
  const root = resolve(outputRoot);
  const directory = resolve(root, runId);
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new Error("run directory escapes the export root");
  }
  return directory;
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
  const parsed = EvidenceSchema.safeParse(
    JSON.parse(bytes.bytes.toString("utf8")),
  );
  return parsed.success ? parsed.data.spec : null;
}

export function buildDesignerExportRows(
  db: Database.Database,
  runId: string,
): DesignerExportRow[] {
  const run = getDesignerRun(db, runId);
  const plan = run.manifest;
  const frozen = buildFrozenReference();
  const cohort = buildCohortReference(
    plan.runKind === "design_primary"
      ? plan
      : buildDesignerPlanManifest({ runKind: "design_primary" }),
  );
  const frozenView = buildNoveltyReferenceView(frozen);
  const cohortView = buildNoveltyReferenceView(cohort);
  const slots = listDesignerSlots(db, runId);
  return slots.map((slot) => {
    const attempts = listDesignAttempts(db, runId, slot.slotId);
    const stages = listDesignerStageResults(db, runId, slot.slotId);
    const presentation = stages.find((stage) => stage.stage === "presentation_ready");
    const payload = presentation?.payload as { view?: DesignView } | undefined;
    const view = payload?.view ?? null;
    const svgArtifact = presentation?.artifacts.find(
      (artifact) => artifact.kind === "svg",
    );
    const pngArtifact = presentation?.artifacts.find(
      (artifact) => artifact.kind === "png",
    );
    const svg =
      svgArtifact === undefined
        ? null
        : getArtifactById(db, svgArtifact.artifactId).bytes.toString("utf8");
    const finalAttempt = attempts[attempts.length - 1];
    const spec = finalAttempt === undefined ? null : specFromAttempt(db, finalAttempt);
    let novelty: string | null = null;
    if (
      spec !== null &&
      slot.verdict === "accepted" &&
      finalAttempt !== undefined
    ) {
      novelty = annotateNoveltySpec({
        candidateId: `${slot.slotId}:final`,
        assignmentId: slot.assignmentId,
        arm: slot.arm,
        view: "final",
        family: slot.family,
        difficulty: slot.difficulty,
        spec,
        frozen: frozenView,
        cohort: cohortView,
      }).annotation;
    }
    const knownCosts = attempts.filter(
      (attempt) => attempt.costStatus === "known" && attempt.costUsd !== null,
    );
    return {
      slotId: slot.slotId,
      assignmentId: slot.assignmentId,
      arm: slot.arm,
      family: slot.family,
      modality: slot.modality,
      difficulty: slot.difficulty,
      stage: slot.stage,
      verdict: slot.verdict,
      firstVerdict: attempts[0]?.verdict ?? null,
      finalVerdict: finalAttempt?.verdict ?? null,
      attemptCount: attempts.length,
      firstAccepted: attempts[0]?.verdict === "accepted",
      finalAccepted: slot.verdict === "accepted",
      repaired: attempts.length > 1,
      novelty,
      question: view?.visible.question ?? null,
      hint: view?.reveal.hint ?? null,
      correctLabel: view?.reveal.correctLabel ?? null,
      correctValue: view?.reveal.correctValue ?? null,
      explanationSteps: view?.reveal.explanationSteps ?? null,
      svg,
      svgHash: view?.certificate.svgHash ?? null,
      pngHash: view?.certificate.pngHash ?? null,
      pngArtifactId: pngArtifact?.artifactId ?? null,
      templateHash: view?.templateHash ?? null,
      certificateHash: view?.certificate.certificateHash ?? null,
      firstCostUsd: attempts[0]?.costUsd ?? null,
      totalCostUsd:
        knownCosts.length === attempts.length
          ? knownCosts
              .reduce((sum, attempt) => sum + Number(attempt.costUsd), 0)
              .toFixed(6)
          : null,
      unknownAttempts: attempts.filter(
        (attempt) => attempt.costStatus === "unknown",
      ).length,
      totalTokens: (() => {
        const rows = attempts.flatMap((attempt) =>
          attempt.logicalCallId === null
            ? []
            : listAttempts(db, attempt.logicalCallId),
        );
        if (rows.length === 0 || rows.some((row) => row.totalTokens === null)) {
          return null;
        }
        return rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
      })(),
      latencyMs:
        attempts.length === 0
          ? null
          : attempts.reduce((sum, attempt) => sum + (attempt.elapsedMs ?? 0), 0),
      attempts: attempts.map((attempt) => ({
        attemptIndex: attempt.attemptIndex,
        role: attempt.role,
        verdict: attempt.verdict,
        errorCode: attempt.diagnostic?.errorCode ?? null,
        costStatus: attempt.costStatus,
        costUsd: attempt.costUsd,
        elapsedMs: attempt.elapsedMs,
        diagnostic: attempt.diagnostic,
        artifactHashes: attempt.artifacts.map(
          (artifact) => artifact.artifact.contentHash,
        ),
      })),
    };
  });
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineSvg(svg: string): string {
  return svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
}

function assertSafeSvg(svg: string): void {
  const withoutNamespaces = svg.replace(
    /xmlns(?::xlink)?="http:\/\/www\.w3\.org\/[^"]*"/g,
    "",
  );
  const forbidden =
    /(?:https?:)?\/\/(?!www\.w3\.org\/)|@import|url\s*\(\s*['"]?(?!#)|on[a-z]+\s*=|javascript:/i;
  if (forbidden.test(withoutNamespaces)) {
    throw new Error("designer report SVG contains an external or active reference");
  }
}

export function renderDesignerReportHtml(input: {
  readonly runId: string;
  readonly evidenceKind: "mock" | "live";
  readonly rows: readonly DesignerExportRow[];
  readonly metrics: DesignerCohortMetrics;
}): string {
  const armLabel: Record<DesignerExportRow["arm"], string> = {
    baseline: "Baseline",
    ai_one_shot: "AI one-shot",
    ai_feedback: "AI feedback",
  };
  const renderCard = (row: DesignerExportRow): string => {
    if (row.svg !== null) {
      assertSafeSvg(row.svg);
    }
    const attempts = row.attempts
      .map(
        (attempt) =>
          `<li>attempt ${attempt.attemptIndex}: ${escapeHtml(attempt.verdict)}${attempt.errorCode === null ? "" : ` (${escapeHtml(attempt.errorCode)})`}; cost ${escapeHtml(attempt.costUsd ?? "unknown")}; ${attempt.elapsedMs}ms</li>`,
      )
      .join("");
    return `<article class="card" data-slot-id="${escapeHtml(row.slotId)}" data-arm="${escapeHtml(row.arm)}" data-status="${escapeHtml(row.verdict ?? "pending")}" aria-label="${escapeHtml(armLabel[row.arm])} ${escapeHtml(row.family)} ${escapeHtml(row.slotId)}">
  <header><h3>${escapeHtml(row.assignmentId)} · ${escapeHtml(armLabel[row.arm])}</h3><p class="badges"><span>${escapeHtml(row.family)}</span><span>${escapeHtml(row.modality)}</span><span>difficulty ${row.difficulty}</span><span>${escapeHtml(row.verdict ?? "pending")}</span><span>${escapeHtml(row.novelty ?? "no novelty")}</span></p></header>
  ${row.question === null ? "" : `<p class="question">${escapeHtml(row.question)}</p>`}
  ${row.hint === null ? "" : `<p><strong>Hint:</strong> ${escapeHtml(row.hint)}</p>`}
  ${row.correctLabel === null ? "" : `<p><strong>Answer:</strong> ${escapeHtml(row.correctLabel)}</p>`}
  ${row.svg === null ? "" : `<div class="asset" role="img" aria-label="${escapeHtml(row.slotId)} image">${inlineSvg(row.svg)}</div>`}
  <details><summary>Attempts and certificate</summary><ul>${attempts}</ul><p>first ${escapeHtml(row.firstVerdict ?? "none")}; final ${escapeHtml(row.finalVerdict ?? "none")}; repaired ${row.repaired}</p><p>certificate ${escapeHtml(row.certificateHash ?? "-")}</p><p>cost ${escapeHtml(row.totalCostUsd ?? "unknown")}</p></details>
</article>`;
  };
  const sections = (["ai_feedback", "ai_one_shot", "baseline"] as const)
    .map((arm) => {
      const rows = input.rows.filter((row) => row.arm === arm);
      return `<section id="arm-${arm}"><h2>${escapeHtml(armLabel[arm])} (${rows.length})</h2>${rows.map(renderCard).join("\n")}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:">
<title>Designer run ${escapeHtml(input.runId)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:#f7f7f5;color:#161616}.banner{background:#ffe9c7;border:1px solid #d99b28;padding:12px;border-radius:8px;font-weight:600}h1,h2,h3{line-height:1.2}.filters a{display:inline-block;margin:4px 6px 4px 0;padding:6px 10px;border:1px solid #999;border-radius:999px;text-decoration:none;color:#161616}.card{background:#fff;border:1px solid #d8d8d2;border-radius:12px;padding:14px;margin-block:14px}.badges span{display:inline-block;background:#eee;border-radius:999px;padding:2px 8px;margin:2px;font-size:.85em}.asset svg{max-width:100%;height:auto}summary{cursor:pointer}@media(max-width:600px){body{padding:10px}.card{padding:10px}}</style>
</head>
<body>
<header><h1>Designer run</h1>${input.evidenceKind === "mock" ? `<p class="banner">MOCK DATA — synthetic zero-cost evidence; not a live result.</p>` : ""}<p>Run ${escapeHtml(input.runId)} · ${escapeHtml(input.metrics.status)} · ${input.metrics.arms.ai_feedback.finalFormalAccepted}/100 feedback accepted · ${input.metrics.arms.ai_one_shot.firstAttemptFormalAccepted}/100 one-shot first accepted</p></header>
<nav class="filters" aria-label="Filters"><strong>Arm:</strong> <a href="#arm-ai_feedback">AI feedback</a><a href="#arm-ai_one_shot">AI one-shot</a><a href="#arm-baseline">Baseline</a> <label>Arm <select id="filter-arm"><option value="all">All</option><option value="ai_feedback">AI feedback</option><option value="ai_one_shot">AI one-shot</option><option value="baseline">Baseline</option></select></label> <label>Status <select id="filter-status"><option value="all">All</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="inconclusive">Inconclusive</option><option value="generation_error">Generation error</option></select></label></nav>
${sections}
<script>
(function(){
  var arm=document.getElementById('filter-arm');
  var status=document.getElementById('filter-status');
  function apply(){
    var a=arm.value, s=status.value;
    document.querySelectorAll('article.card').forEach(function(card){
      card.hidden = (a!=='all' && card.getAttribute('data-arm')!==a) || (s!=='all' && card.getAttribute('data-status')!==s);
    });
  }
  arm.addEventListener('change', apply);
  status.addEventListener('change', apply);
})();
</script>
</body>
</html>`;
}

export interface DesignerRequestRow {
  readonly logicalCallId: string;
  readonly slotId: string | null;
  readonly probeKey: string | null;
  readonly role: string;
  readonly runKind: string;
  readonly state: string;
  readonly model: string;
  readonly requestHash: string;
  readonly expectedSchemaHash: string;
  readonly outputCapField: string | null;
  readonly createdAt: string;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly state: string;
    readonly httpStatus: number | null;
    readonly observedModel: string | null;
    readonly observedProvider: string | null;
    readonly responseId: string | null;
    readonly finishReason: string | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly totalTokens: number | null;
    readonly cachedReadTokens: number | null;
    readonly cachedWriteTokens: number | null;
    readonly reasoningTokens: number | null;
    readonly actualCostUsd: string | null;
    readonly costStatus: string;
    readonly errorClassification: string | null;
    readonly elapsedMs: number | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly rawResponseArtifactId: number | null;
  }[];
}

export function buildDesignerRequestRows(
  db: Database.Database,
  runId: string,
): DesignerRequestRow[] {
  const calls = db
    .prepare(
      "SELECT logical_call_id, slot_id, probe_key, role, run_kind, state, model, request_hash, expected_schema_hash, output_cap_field, created_at FROM logical_calls WHERE run_id = ? ORDER BY created_at, logical_call_id",
    )
    .all(runId) as Array<{
    logical_call_id: string;
    slot_id: string | null;
    probe_key: string | null;
    role: string;
    run_kind: string;
    state: string;
    model: string;
    request_hash: string;
    expected_schema_hash: string;
    output_cap_field: string | null;
    created_at: string;
  }>;
  return calls.map((call) => {
    const attempts = db
      .prepare(
        "SELECT attempt_id, attempt_number, state, http_status, observed_model, observed_provider, response_id, finish_reason, prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, cached_write_tokens, reasoning_tokens, actual_cost_usd, cost_status, error_classification, elapsed_ms, started_at, finished_at, raw_response_artifact_id FROM request_attempts WHERE logical_call_id = ? ORDER BY attempt_number",
      )
      .all(call.logical_call_id) as Array<{
      attempt_id: string;
      attempt_number: number;
      state: string;
      http_status: number | null;
      observed_model: string | null;
      observed_provider: string | null;
      response_id: string | null;
      finish_reason: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      cached_read_tokens: number | null;
      cached_write_tokens: number | null;
      reasoning_tokens: number | null;
      actual_cost_usd: string | null;
      cost_status: string;
      error_classification: string | null;
      elapsed_ms: number | null;
      started_at: string | null;
      finished_at: string | null;
      raw_response_artifact_id: number | null;
    }>;
    return {
      logicalCallId: call.logical_call_id,
      slotId: call.slot_id,
      probeKey: call.probe_key,
      role: call.role,
      runKind: call.run_kind,
      state: call.state,
      model: call.model,
      requestHash: call.request_hash,
      expectedSchemaHash: call.expected_schema_hash,
      outputCapField: call.output_cap_field,
      createdAt: call.created_at,
      attempts: attempts.map((attempt) => ({
        attemptId: attempt.attempt_id,
        attemptNumber: attempt.attempt_number,
        state: attempt.state,
        httpStatus: attempt.http_status,
        observedModel: attempt.observed_model,
        observedProvider: attempt.observed_provider,
        responseId: attempt.response_id,
        finishReason: attempt.finish_reason,
        promptTokens: attempt.prompt_tokens,
        completionTokens: attempt.completion_tokens,
        totalTokens: attempt.total_tokens,
        cachedReadTokens: attempt.cached_read_tokens,
        cachedWriteTokens: attempt.cached_write_tokens,
        reasoningTokens: attempt.reasoning_tokens,
        actualCostUsd: attempt.actual_cost_usd,
        costStatus: attempt.cost_status,
        errorClassification: attempt.error_classification,
        elapsedMs: attempt.elapsed_ms,
        startedAt: attempt.started_at,
        finishedAt: attempt.finished_at,
        rawResponseArtifactId: attempt.raw_response_artifact_id,
      })),
    };
  });
}

export interface DesignerExportResult {
  readonly runId: string;
  readonly directory: string;
  readonly files: readonly string[];
  readonly metrics: DesignerCohortMetrics;
}

export function exportDesignerRun(
  db: Database.Database,
  runId: string,
  options: {
    readonly outputRoot?: string;
    readonly format?: "all" | "csv" | "jsonl";
  } = {},
): DesignerExportResult {
  const run = getDesignerRun(db, runId);
  const rows = buildDesignerExportRows(db, runId);
  const frozen = buildFrozenReference();
  const cohort = buildCohortReference(
    run.manifest.runKind === "design_primary"
      ? run.manifest
      : buildDesignerPlanManifest({ runKind: "design_primary" }),
  );
  const metrics = loadDesignerCohortMetrics(db, runId, { frozen, cohort });
  const directory = outputDirectory(runId, options.outputRoot ?? join("data", "runs"));
  mkdirSync(directory, { recursive: true });
  const format = options.format ?? "all";
  const files: string[] = [];
  const write = (name: string, data: string | Buffer): string => {
    const path = join(directory, name);
    writeAtomic(path, data);
    files.push(path);
    return path;
  };
  const attempts = rows.flatMap((row) =>
    row.attempts.map((attempt) => ({
      slotId: row.slotId,
      ...attempt,
    })),
  );
  if (format !== "csv") {
    write(
      "candidates.jsonl",
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    write(
      "design-attempts.jsonl",
      `${attempts.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    write(
      "requests.jsonl",
      `${buildDesignerRequestRows(db, runId)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
  }
  if (format === "all") {
    write(
      "summary.json",
      `${JSON.stringify({ run: { runId, evidenceKind: run.evidenceKind, runKind: run.runKind, planHash: run.manifest.planHash, status: run.controlState }, metrics }, null, 2)}\n`,
    );
    write(
      "manifest.json",
    `${JSON.stringify(
      {
        version: 1,
        kind: "designer_run_export",
        runId,
        evidenceKind: run.evidenceKind,
        runKind: run.runKind,
        planHash: run.manifest.planHash,
        metricsHash: `${frozen.referenceHash}:${cohort.cohortHash}`,
        files: [
          "candidates.jsonl",
          "design-attempts.jsonl",
          "requests.jsonl",
          "summary.json",
          "results.csv",
          "report.html",
          "puzzles",
          "images",
        ],
      },
      null,
      2,
    )}\n`,
    );
  }
  const resultsHeader = [
    "slot_id",
    "assignment_id",
    "arm",
    "family",
    "modality",
    "difficulty",
    "stage",
    "verdict",
    "first_verdict",
    "final_verdict",
    "attempt_count",
    "novelty",
    "first_cost_usd",
    "total_cost_usd",
    "unknown_attempts",
  ];
  const resultsRows = rows.map((row) =>
    [
      row.slotId,
      row.assignmentId,
      row.arm,
      row.family,
      row.modality,
      row.difficulty,
      row.stage,
      row.verdict,
      row.firstVerdict,
      row.finalVerdict,
      row.attemptCount,
      row.novelty,
      row.firstCostUsd,
      row.totalCostUsd,
      row.unknownAttempts,
    ]
      .map(csvEscape)
      .join(","),
  );
  if (format !== "jsonl") {
    write("results.csv", `${resultsHeader.join(",")}\n${resultsRows.join("\n")}\n`);
  }
  if (format === "all") {
    write(
      "report.html",
      renderDesignerReportHtml({
        runId,
        evidenceKind: run.evidenceKind,
        rows,
        metrics,
      }),
    );
  }
  if (format === "all") for (const row of rows) {
    write(
      join("puzzles", `${row.slotId}.json`),
      `${JSON.stringify(
        {
          slotId: row.slotId,
          assignmentId: row.assignmentId,
          arm: row.arm,
          family: row.family,
          difficulty: row.difficulty,
          question: row.question,
          hint: row.hint,
          correctLabel: row.correctLabel,
          correctValue: row.correctValue,
          explanationSteps: row.explanationSteps,
          certificateHash: row.certificateHash,
        },
        null,
        2,
      )}\n`,
    );
    if (row.svg !== null) {
      write(join("images", `${row.slotId}.svg`), row.svg);
    }
    if (row.pngArtifactId !== null) {
      const png = getArtifactById(db, row.pngArtifactId).bytes;
      write(join("images", `${row.slotId}.png`), png);
    }
  }
  return { runId, directory, files, metrics };
}

export function writeDesignerHtmlReport(
  db: Database.Database,
  runId: string,
  options: { readonly outputRoot?: string } = {},
): { readonly htmlPath: string; readonly metrics: DesignerCohortMetrics } {
  const run = getDesignerRun(db, runId);
  const rows = buildDesignerExportRows(db, runId);
  const frozen = buildFrozenReference();
  const cohort = buildCohortReference(
    run.manifest.runKind === "design_primary"
      ? run.manifest
      : buildDesignerPlanManifest({ runKind: "design_primary" }),
  );
  const metrics = loadDesignerCohortMetrics(db, runId, { frozen, cohort });
  const directory = outputDirectory(runId, options.outputRoot ?? join("data", "runs"));
  const htmlPath = join(directory, "report.html");
  writeAtomic(
    htmlPath,
    renderDesignerReportHtml({
      runId,
      evidenceKind: run.evidenceKind,
      rows,
      metrics,
    }),
  );
  return { htmlPath, metrics };
}
