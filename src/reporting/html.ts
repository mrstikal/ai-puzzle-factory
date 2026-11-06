import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  FailureRecordSchema,
  WORKFLOW_STAGES,
  type FailureRecord,
  type WorkflowStage,
} from "../domain/candidate.js";
import { getArtifact } from "../storage/artifacts.js";
import { StorageError } from "../storage/database.js";
import {
  getRun,
  listStageResults,
  type RunRecord,
  type StageResultRecord,
} from "../storage/repository.js";
import {
  ExportError,
  buildCandidateRows,
  buildRequestRows,
  resolveRunDirectory,
  writeAtomicFile,
  type CandidateExportRow,
  type RequestExportRow,
} from "./export.js";
import { computeRunMetrics, type RunMetrics } from "./metrics.js";

const REPORT_STYLE = readFileSync(
  new URL("./assets/report.css", import.meta.url),
  "utf8",
);
const REPORT_SCRIPT = readFileSync(
  new URL("./assets/report.js", import.meta.url),
  "utf8",
);

export const HTML_REPORT_VERSION = 1;

export const CARD_STATUSES = [
  "approved",
  "rejected",
  "inconclusive",
  "generation_error",
  "terminal_without_verdict",
  "incomplete",
  "unstarted",
] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

export interface HtmlReportOptions {
  readonly outputRoot?: string;
}

export interface HtmlReportResult {
  readonly runId: string;
  readonly directory: string;
  readonly htmlPath: string;
  readonly imageFiles: readonly string[];
  readonly cardCount: number;
  readonly scriptHash: string;
  readonly styleHash: string;
}

interface PresentationClue {
  readonly factId: string;
  readonly text: string;
}

interface PresentationOption {
  readonly label: string;
  readonly text: string;
}

interface StageView {
  readonly stage: WorkflowStage;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly elapsedMs: number | null;
  readonly payloadHash: string;
}

interface RequestSummary {
  readonly role: string;
  readonly model: string;
  readonly provider: string;
  readonly state: string;
  readonly requestHash: string;
  readonly attempts: readonly string[];
}

interface CardAssets {
  readonly png: string | null;
  readonly svg: string | null;
}

export interface HtmlReportCard {
  readonly slotId: string;
  readonly slotOrdinal: number;
  readonly family: string;
  readonly modality: string;
  readonly lane: string;
  readonly difficulty: number;
  readonly stage: string;
  readonly verdict: string | null;
  readonly status: CardStatus;
  readonly disagreement: boolean;
  readonly alignment: string | null;
  readonly question: string | null;
  readonly rules: readonly string[];
  readonly clues: readonly PresentationClue[];
  readonly options: readonly PresentationOption[];
  readonly correctLabel: string | null;
  readonly correctValue: unknown;
  readonly hint: string | null;
  readonly explanation: readonly string[];
  readonly proof: unknown;
  readonly blindReview: unknown;
  readonly alignmentReview: unknown;
  readonly duplicateAssessment: unknown;
  readonly fingerprint: unknown;
  readonly terminalPayload: unknown;
  readonly failures: readonly FailureRecord[];
  readonly primaryFailure: string | null;
  readonly failureEvidence: string | null;
  readonly cost: CandidateExportRow["cost"];
  readonly assets: CardAssets;
  readonly provenance: {
    readonly checkpointVersion: number;
    readonly stages: readonly StageView[];
    readonly requests: readonly RequestSummary[];
  };
}

export interface HtmlReportDocument {
  readonly run: RunRecord;
  readonly metrics: RunMetrics;
  readonly cards: readonly HtmlReportCard[];
  readonly style: string;
  readonly script: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringList(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsonForHtml(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function cspHash(content: string): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("base64")}`;
}

function ruleLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return asStringList(value);
  }
  const rules = asRecord(value);
  const lines: string[] = [];
  const labels: ReadonlyArray<[string, string]> = [
    ["domain", "Domain"],
    ["closedWorld", "Closed world"],
    ["target", "Target"],
  ];
  for (const [key, label] of labels) {
    const text = asString(rules[key]);
    if (text !== null) {
      lines.push(`${label}: ${text}`);
    }
  }
  for (const text of asStringList(rules.operations)) {
    lines.push(`Operation: ${text}`);
  }
  for (const text of asStringList(rules.conventions)) {
    lines.push(`Convention: ${text}`);
  }
  return lines;
}

function presentationClues(value: unknown): PresentationClue[] {
  return asArray(value).flatMap((item) => {
    const clue = asRecord(item);
    const text = asString(clue.text);
    if (text === null) {
      return [];
    }
    return [{ factId: asString(clue.factId) ?? "", text }];
  });
}

function presentationOptions(value: unknown): PresentationOption[] {
  return asArray(value).flatMap((item) => {
    const option = asRecord(item);
    const label = asString(option.label);
    const text = asString(option.text);
    return label === null || text === null ? [] : [{ label, text }];
  });
}

function explanationLines(value: unknown): string[] {
  return asArray(value).flatMap((step) => {
    if (typeof step === "string") {
      return [step];
    }
    const text = asString(asRecord(step).text);
    return text === null ? [] : [text];
  });
}

function failureRecords(value: unknown): FailureRecord[] {
  const parsed = FailureRecordSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function presentationParts(
  presentation: unknown,
  fallbackQuestion: string | null,
  fallbackHint: string | null,
): {
  question: string | null;
  rules: string[];
  clues: PresentationClue[];
  options: PresentationOption[];
  correctLabel: string | null;
  correctValue: unknown;
  hint: string | null;
  explanation: string[];
  proof: unknown;
} {
  const root = asRecord(presentation);
  const visible = asRecord(root.visible);
  const reveal = asRecord(root.reveal);
  return {
    question: asString(visible.question) ?? fallbackQuestion,
    rules: ruleLines(visible.rules),
    clues: presentationClues(visible.clues),
    options: presentationOptions(visible.options),
    correctLabel: asString(reveal.correctLabel),
    correctValue: reveal.correctValue ?? null,
    hint: asString(reveal.hint) ?? fallbackHint,
    explanation: explanationLines(reveal.explanationSteps),
    proof: reveal.proof ?? null,
  };
}

function imageHashes(candidate: CandidateExportRow): {
  svgHash: string | null;
  pngHash: string | null;
} {
  const visible = asRecord(asRecord(candidate.presentation).visible);
  const visibleAssets = asRecord(visible.assets);
  const renderHashes = asRecord(asRecord(candidate.fingerprint).renderHashes);
  return {
    svgHash: asString(visibleAssets.svgHash) ?? asString(renderHashes.svg),
    pngHash: asString(visibleAssets.pngHash) ?? asString(renderHashes.png),
  };
}

function cardStatus(candidate: CandidateExportRow): CardStatus {
  if (
    candidate.verdict !== null &&
    (CARD_STATUSES as readonly string[]).includes(candidate.verdict)
  ) {
    return candidate.verdict as CardStatus;
  }
  if (candidate.terminal) {
    return "terminal_without_verdict";
  }
  return candidate.started ? "incomplete" : "unstarted";
}

function cardDisagreement(candidate: CandidateExportRow): boolean {
  const blind = asRecord(candidate.blindReview);
  const codes = failureRecords(candidate.failures).map((failure) => failure.code);
  return (
    blind.choiceAgreement === "disagreed" ||
    codes.includes("REVIEWER_DISAGREES")
  );
}

function stageViews(stages: readonly StageResultRecord[]): StageView[] {
  const order = new Map<string, number>(
    WORKFLOW_STAGES.map((stage, index) => [stage, index]),
  );
  return [...stages]
    .sort(
      (left, right) =>
        (order.get(left.stage) ?? 0) - (order.get(right.stage) ?? 0),
    )
    .map((stage) => ({
      stage: stage.stage,
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
      elapsedMs: stage.elapsedMs,
      payloadHash: stage.payloadHash,
    }));
}

function requestSummaries(
  requests: readonly RequestExportRow[],
): Map<string, RequestSummary[]> {
  const bySlot = new Map<string, RequestSummary[]>();
  for (const request of requests) {
    if (request.slotId === null) {
      continue;
    }
    const summary: RequestSummary = {
      role: request.role,
      model: request.model,
      provider: request.provider,
      state: request.state,
      requestHash: request.requestHash,
      attempts: request.attempts.map(
        (attempt) => `${attempt.attemptNumber}:${attempt.state}`,
      ),
    };
    const existing = bySlot.get(request.slotId) ?? [];
    existing.push(summary);
    bySlot.set(request.slotId, existing);
  }
  return bySlot;
}

function buildCard(
  candidate: CandidateExportRow,
  stages: readonly StageResultRecord[],
  requests: readonly RequestSummary[],
  assets: CardAssets,
): HtmlReportCard {
  const parts = presentationParts(
    candidate.presentation,
    candidate.question,
    candidate.hint,
  );
  return {
    slotId: candidate.slotId,
    slotOrdinal: candidate.slotOrdinal,
    family: candidate.family,
    modality: candidate.modality,
    lane: candidate.lane,
    difficulty: candidate.difficulty,
    stage: candidate.stage,
    verdict: candidate.verdict,
    status: cardStatus(candidate),
    disagreement: cardDisagreement(candidate),
    alignment: asString(asRecord(candidate.alignmentReview).derivedOverall),
    question: parts.question,
    rules: parts.rules,
    clues: parts.clues,
    options: parts.options,
    correctLabel: parts.correctLabel,
    correctValue: parts.correctValue,
    hint: parts.hint,
    explanation: parts.explanation,
    proof: parts.proof,
    blindReview: candidate.blindReview,
    alignmentReview: candidate.alignmentReview,
    duplicateAssessment: candidate.duplicateAssessment,
    fingerprint: candidate.fingerprint,
    terminalPayload: candidate.terminalPayload,
    failures: failureRecords(candidate.failures),
    primaryFailure: candidate.primaryFailure,
    failureEvidence: candidate.failureEvidence,
    cost: candidate.cost,
    assets,
    provenance: {
      checkpointVersion: candidate.checkpointVersion,
      stages: stageViews(stages),
      requests,
    },
  };
}

function renderJson(value: unknown): string {
  return `<pre class="json">${escapeHtml(
    JSON.stringify(value, null, 2) ?? "null",
  )}</pre>`;
}

function renderTextOrEmpty(value: string | null, empty: string): string {
  return value === null
    ? `<p class="reveal-note">${escapeHtml(empty)}</p>`
    : `<p>${escapeHtml(value)}</p>`;
}

function renderRules(rules: readonly string[]): string {
  if (rules.length === 0) {
    return `<p class="reveal-note">No visible rules were committed.</p>`;
  }
  return `<ul class="list">${rules
    .map((rule) => `<li>${escapeHtml(rule)}</li>`)
    .join("")}</ul>`;
}

function renderClues(clues: readonly PresentationClue[]): string {
  if (clues.length === 0) {
    return `<p class="reveal-note">No textual clues were committed.</p>`;
  }
  return `<ul class="list">${clues
    .map((clue) => `<li>${escapeHtml(clue.text)}</li>`)
    .join("")}</ul>`;
}

function renderOptions(options: readonly PresentationOption[]): string {
  if (options.length === 0) {
    return `<p class="reveal-note">No options were committed.</p>`;
  }
  return `<ol class="options">${options
    .map(
      (option) =>
        `<li class="option"><span class="option-label">${escapeHtml(
          option.label,
        )}</span><span>${escapeHtml(option.text)}</span></li>`,
    )
    .join("")}</ol>`;
}

function renderFailures(card: HtmlReportCard): string {
  if (card.failures.length === 0) {
    return `<p class="no-failures">No failure records.</p>`;
  }
  return `<section class="failures" aria-label="Failures for ${escapeHtml(
    card.slotId,
  )}"><h3>Failures</h3><ul class="failure-list">${card.failures
    .map(
      (failure) =>
        `<li><span class="failure-code">${escapeHtml(
          failure.code,
        )}</span> at <code>${escapeHtml(failure.stage)}</code> (${escapeHtml(
          failure.source,
        )}, ${escapeHtml(failure.severity)}): ${escapeHtml(
          failure.evidence ?? "no evidence text",
        )}</li>`,
    )
    .join("")}</ul></section>`;
}

function renderImage(card: HtmlReportCard): string {
  if (card.assets.png !== null) {
    const png = escapeHtml(card.assets.png);
    const svgLink =
      card.assets.svg === null
        ? ""
        : ` <a href="${escapeHtml(card.assets.svg)}">Source SVG</a>`;
    return `<figure class="image-figure"><img src="${png}" alt="Puzzle diagram for ${escapeHtml(
      card.slotId,
    )}" loading="lazy" decoding="async"><figcaption class="image-actions"><button type="button" class="secondary" data-zoom-target="slot-${escapeHtml(
      card.slotId,
    )}" aria-label="Zoom image for ${escapeHtml(
      card.slotId,
    )}">Zoom image</button>${svgLink}</figcaption></figure>`;
  }
  if (card.assets.svg !== null) {
    return `<p class="asset-missing">PNG unavailable. <a href="${escapeHtml(
      card.assets.svg,
    )}">Open the source SVG</a>.</p>`;
  }
  if (card.modality === "svg") {
    return `<p class="asset-missing">Image asset unavailable for this slot.</p>`;
  }
  return "";
}

function formatActualCost(
  costStatus: string,
  actualCostUsd: string | null,
): string {
  if (costStatus === "not_applicable") {
    return "not applicable";
  }
  return actualCostUsd === null ? "unknown" : `${actualCostUsd} USD`;
}

function renderCost(card: HtmlReportCard): string {
  const actual = formatActualCost(card.cost.costStatus, card.cost.actualCostUsd);
  return `<dl class="provenance-list"><dt>Cost status</dt><dd>${escapeHtml(
    card.cost.costStatus,
  )}</dd><dt>Known actual</dt><dd>${escapeHtml(
    card.cost.knownActualUsd,
  )} USD</dd><dt>Actual</dt><dd>${escapeHtml(
    actual,
  )}</dd><dt>Unknown attempts</dt><dd>${card.cost.unknownAttempts}</dd></dl>`;
}

function renderProvenance(card: HtmlReportCard): string {
  const stages =
    card.provenance.stages.length === 0
      ? `<p class="reveal-note">No stage records were committed.</p>`
      : `<ul class="list">${card.provenance.stages
          .map(
            (stage) =>
              `<li><code>${escapeHtml(stage.stage)}</code>: ${escapeHtml(
                stage.startedAt,
              )} to ${escapeHtml(
                stage.finishedAt ?? "unfinished",
              )} (${stage.elapsedMs === null ? "unknown" : stage.elapsedMs} ms), payload <code>${escapeHtml(
                stage.payloadHash,
              )}</code></li>`,
          )
          .join("")}</ul>`;
  const requests =
    card.provenance.requests.length === 0
      ? `<p class="reveal-note">No request records for this slot.</p>`
      : `<ul class="list">${card.provenance.requests
          .map(
            (request) =>
              `<li><code>${escapeHtml(request.role)}</code>: ${escapeHtml(
                request.model,
              )} via ${escapeHtml(request.provider)}; state ${escapeHtml(
                request.state,
              )}; attempts ${escapeHtml(
                request.attempts.join(", ") || "none",
              )}; request <code>${escapeHtml(request.requestHash)}</code></li>`,
          )
          .join("")}</ul>`;
  return `<dl class="provenance-list"><dt>Checkpoint</dt><dd>${card.provenance.checkpointVersion}</dd><dt>Stage</dt><dd>${escapeHtml(
    card.stage,
  )}</dd><dt>Primary failure</dt><dd>${escapeHtml(
    card.primaryFailure ?? "none",
  )}</dd></dl><h3>Stage records</h3>${stages}<h3>Requests</h3>${requests}`;
}

function renderRevealAnswer(card: HtmlReportCard): string {
  const key =
    card.correctLabel === null
      ? `<p class="reveal-note">No correct label was committed.</p>`
      : `<p class="reveal-key">Correct option: ${escapeHtml(
          card.correctLabel,
        )}</p>`;
  return `${key}<h3>Correct value</h3>${renderJson(
    card.correctValue,
  )}<h3>Hint</h3>${renderTextOrEmpty(
    card.hint,
    "No hint was committed.",
  )}<h3>Explanation</h3>${
    card.explanation.length === 0
      ? `<p class="reveal-note">No explanation was committed.</p>`
      : `<ol class="list">${card.explanation
          .map((step) => `<li>${escapeHtml(step)}</li>`)
          .join("")}</ol>`
  }`;
}

function renderCard(card: HtmlReportCard): string {
  const hasPresentation =
    card.question !== null ||
    card.rules.length > 0 ||
    card.clues.length > 0 ||
    card.options.length > 0 ||
    card.assets.png !== null ||
    card.assets.svg !== null;
  const publicSection = hasPresentation
    ? `<section class="card-section" aria-label="Public presentation"><h3>Question</h3>${renderTextOrEmpty(
        card.question,
        "No public question was committed.",
      )}<h3>Rules</h3>${renderRules(
        card.rules,
      )}<h3>Clues</h3>${renderClues(
        card.clues,
      )}${renderImage(card)}<h3>Options</h3>${renderOptions(card.options)}</section>`
    : `<p class="asset-missing">No public presentation was committed for this slot.</p>`;
  return `<article class="card" id="slot-${escapeHtml(
    card.slotId,
  )}" data-slot-id="${escapeHtml(card.slotId)}" data-modality="${escapeHtml(
    card.modality,
  )}" data-family="${escapeHtml(card.family)}" data-lane="${escapeHtml(
    card.lane,
  )}" data-status="${escapeHtml(card.status)}" data-difficulty="${
    card.difficulty
  }" data-disagreement="${card.disagreement ? "yes" : "no"}">
<header class="card-header"><h2 id="slot-title-${escapeHtml(
    card.slotId,
  )}">${card.slotOrdinal}. ${escapeHtml(card.slotId)}</h2><div class="badges"><span class="badge badge-${escapeHtml(
    card.status,
  )}">${escapeHtml(card.status)}</span><span class="badge">${escapeHtml(
    card.family,
  )}</span><span class="badge">${escapeHtml(
    card.modality,
  )}</span><span class="badge">${escapeHtml(
    card.lane,
  )}</span><span class="badge">difficulty ${card.difficulty}</span>${
    card.alignment === null
      ? ""
      : `<span class="badge">alignment ${escapeHtml(card.alignment)}</span>`
  }<span class="badge">stage ${escapeHtml(card.stage)}</span></div></header>
${publicSection}
${renderFailures(card)}
<details class="reveal" data-reveal="answer"><summary>Reveal key, hint, and explanation</summary><div class="reveal-body">${renderRevealAnswer(
    card,
  )}</div></details>
<details class="reveal" data-reveal="proof"><summary>Reveal solution proof and fingerprint</summary><div class="reveal-body"><h3>Proof</h3>${renderJson(
    card.proof,
  )}<h3>Fingerprint</h3>${renderJson(
    card.fingerprint,
  )}<h3>Terminal payload</h3>${renderJson(
    card.terminalPayload,
  )}</div></details>
<details class="reveal" data-reveal="reviews"><summary>Reveal blind, alignment, and duplicate reviews</summary><div class="reveal-body"><h3>Blind review</h3>${renderJson(
    card.blindReview,
  )}<h3>Alignment review</h3>${renderJson(
    card.alignmentReview,
  )}<h3>Duplicate assessment</h3>${renderJson(
    card.duplicateAssessment,
  )}</div></details>
<details class="reveal" data-reveal="provenance"><summary>Reveal cost, failure evidence, and provenance</summary><div class="reveal-body"><h3>Cost</h3>${renderCost(
    card,
  )}<h3>Failure evidence</h3>${renderTextOrEmpty(
    card.failureEvidence,
    "No failure evidence was committed.",
  )}<h3>Provenance</h3>${renderProvenance(
    card,
  )}</div></details>
</article>`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function filterOptions(
  values: readonly string[],
  labels?: ReadonlyMap<string, string>,
): string {
  return values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(
          labels?.get(value) ?? value,
        )}</option>`,
    )
    .join("");
}

function renderFilters(cards: readonly HtmlReportCard[]): string {
  const statuses = CARD_STATUSES.filter((status) =>
    cards.some((card) => card.status === status),
  );
  const difficulties = uniqueSorted(
    cards.map((card) => String(card.difficulty)),
  );
  return `<section class="filters" aria-label="Report filters">
<label for="filter-modality">Modality<select id="filter-modality" data-filter="modality"><option value="">All</option>${filterOptions(
    uniqueSorted(cards.map((card) => card.modality)),
  )}</select></label>
<label for="filter-family">Family<select id="filter-family" data-filter="family"><option value="">All</option>${filterOptions(
    uniqueSorted(cards.map((card) => card.family)),
  )}</select></label>
<label for="filter-lane">Lane<select id="filter-lane" data-filter="lane"><option value="">All</option>${filterOptions(
    uniqueSorted(cards.map((card) => card.lane)),
  )}</select></label>
<label for="filter-status-filter">Status<select id="filter-status-filter" data-filter="status"><option value="">All</option>${filterOptions(
    statuses,
  )}</select></label>
<label for="filter-difficulty">Difficulty<select id="filter-difficulty" data-filter="difficulty"><option value="">All</option>${filterOptions(
    difficulties,
  )}</select></label>
<label for="filter-disagreement">Disagreement<select id="filter-disagreement" data-filter="disagreement"><option value="">All</option><option value="yes">Disagreement</option><option value="no">No disagreement</option></select></label>
<div class="filter-actions"><button type="button" id="reset-filters" class="secondary">Reset filters</button><button type="button" id="reveal-all" class="secondary">Reveal all details</button><button type="button" id="hide-all" class="secondary">Hide all details</button><p id="filter-status" class="filter-status" role="status" aria-live="polite">Showing ${cards.length} of ${cards.length} cards.</p></div>
</section>`;
}

function summaryItem(label: string, value: string): string {
  return `<div class="summary-item"><dt>${escapeHtml(
    label,
  )}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function actualCostLabel(metrics: RunMetrics): string {
  return formatActualCost(
    metrics.cost.costStatus,
    metrics.cost.actualCostUsd,
  );
}

function renderHeader(
  run: RunRecord,
  metrics: RunMetrics,
  cardCount: number,
): string {
  const incomplete =
    run.controlState !== "completed" ||
    metrics.counts.terminal < metrics.counts.planned ||
    metrics.counts.terminalWithoutVerdict > 0;
  const banners: string[] = [];
  if (run.evidenceKind === "mock") {
    banners.push(
      `<p class="banner banner-mock" role="note">MOCK DATA - deterministic mock transport; this gallery is not live evidence.</p>`,
    );
  } else {
    banners.push(
      `<p class="banner banner-live" role="note">LIVE DATA - evidence kind is live.</p>`,
    );
  }
  if (incomplete) {
    banners.push(
      `<p class="banner banner-incomplete" role="note">INCOMPLETE RUN - control state ${escapeHtml(
        run.controlState,
      )}; ${metrics.counts.terminal} of ${metrics.counts.planned} planned slots are terminal; ${metrics.counts.unstarted} unstarted.</p>`,
    );
  }
  return `<header class="report-header"><h1>Puzzle Factory Run Report</h1><p class="report-meta"><span>Run <code>${escapeHtml(
    run.runId,
  )}</code></span><span>${escapeHtml(
    run.runKind,
  )} run</span><span>${escapeHtml(
    run.evidenceKind,
  )} evidence</span><span>protocol ${escapeHtml(
    run.protocolVersion,
  )}</span><span>seed <code>${escapeHtml(
    run.rootSeed,
  )}</code></span><span>created ${escapeHtml(
    run.createdAt,
  )}</span><span>manifest <code>${escapeHtml(
    run.manifestHash,
  )}</code></span></p><div class="banners">${banners.join(
    "",
  )}</div><dl class="summary-grid">${summaryItem(
    "Planned",
    String(metrics.counts.planned),
  )}${summaryItem("Started", String(metrics.counts.started))}${summaryItem(
    "Terminal",
    String(metrics.counts.terminal),
  )}${summaryItem("Approved", String(metrics.counts.approved))}${summaryItem(
    "Rejected",
    String(metrics.counts.rejected),
  )}${summaryItem(
    "Inconclusive",
    String(metrics.counts.inconclusive),
  )}${summaryItem(
    "Generation errors",
    String(metrics.counts.generationError),
  )}${summaryItem(
    "Unstarted",
    String(metrics.counts.unstarted),
  )}${summaryItem("Cards", String(cardCount)  )}${summaryItem(
    "Known cost (USD)",
    metrics.cost.knownActualUsd,
  )}${summaryItem(
    "Actual cost",
    actualCostLabel(metrics),
  )}${summaryItem(
    "Cost status",
    metrics.cost.costStatus,
  )}${summaryItem(
    "Unknown attempts",
    String(metrics.cost.unknownAttempts),
  )}</dl></header>`;
}

function embeddedReportData(
  run: RunRecord,
  metrics: RunMetrics,
  cards: readonly HtmlReportCard[],
): unknown {
  return {
    version: HTML_REPORT_VERSION,
    run: {
      runId: run.runId,
      runKind: run.runKind,
      evidenceKind: run.evidenceKind,
      protocolVersion: run.protocolVersion,
      rootSeed: run.rootSeed,
      manifestHash: run.manifestHash,
      controlState: run.controlState,
      createdAt: run.createdAt,
    },
    counts: metrics.counts,
    cost: {
      knownActualUsd: metrics.cost.knownActualUsd,
      actualCostUsd: metrics.cost.actualCostUsd,
      costStatus: metrics.cost.costStatus,
      unknownAttempts: metrics.cost.unknownAttempts,
    },
    cards: cards.map((card) => ({
      slotId: card.slotId,
      slotOrdinal: card.slotOrdinal,
      family: card.family,
      modality: card.modality,
      lane: card.lane,
      difficulty: card.difficulty,
      stage: card.stage,
      verdict: card.verdict,
      status: card.status,
      disagreement: card.disagreement,
      alignment: card.alignment,
      primaryFailure: card.primaryFailure,
      question: card.question,
      costStatus: card.cost.costStatus,
      assets: { png: card.assets.png, svg: card.assets.svg },
    })),
  };
}

export function renderHtmlReport(document: HtmlReportDocument): string {
  const styleHash = cspHash(document.style);
  const scriptHash = cspHash(document.script);
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "img-src 'self' data:",
    `style-src '${styleHash}'`,
    `script-src '${scriptHash}'`,
  ].join("; ");
  const embedded = escapeJsonForHtml(
    embeddedReportData(document.run, document.metrics, document.cards),
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">
<title>Puzzle Factory Run Report - ${escapeHtml(document.run.runId)}</title>
<style>${document.style}</style>
</head>
<body>
${renderHeader(document.run, document.metrics, document.cards.length)}
${renderFilters(document.cards)}
<main class="cards" aria-label="Planned slots">
${document.cards.map(renderCard).join("\n")}
</main>
<dialog id="zoom-dialog" class="zoom-dialog" aria-labelledby="zoom-title"><div class="zoom-actions"><button type="button" id="zoom-close" class="secondary">Close</button></div><h2 id="zoom-title" class="visually-hidden">Zoomed puzzle image</h2><img id="zoom-image" alt=""></dialog>
<script type="application/json" id="report-data">${embedded}</script>
<script>${document.script}</script>
</body>
</html>
`;
}

function copyArtifact(
  db: Database.Database,
  contentHash: string,
  kind: "svg" | "png",
  path: string,
): string | null {
  try {
    const artifact = getArtifact(db, contentHash, kind);
    writeAtomicFile(path, artifact.bytes);
    return path;
  } catch (error) {
    if (error instanceof StorageError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

export function writeHtmlReport(
  db: Database.Database,
  runId: string,
  options: HtmlReportOptions = {},
): HtmlReportResult {
  const directory = resolveRunDirectory(
    runId,
    options.outputRoot ?? join("data", "runs"),
  );
  let run: RunRecord;
  try {
    run = getRun(db, runId);
  } catch (error) {
    throw new ExportError("INVALID_RUN", `run not found: ${runId}`, {
      cause: error,
    });
  }
  const metrics = computeRunMetrics(db, runId);
  const candidates = buildCandidateRows(db, runId);
  const requests = buildRequestRows(db, runId);
  const stageRows = listStageResults(db, runId);
  const requestsBySlot = requestSummaries(requests);
  const stagesBySlot = new Map<string, StageResultRecord[]>();
  for (const stage of stageRows) {
    const existing = stagesBySlot.get(stage.slotId) ?? [];
    existing.push(stage);
    stagesBySlot.set(stage.slotId, existing);
  }
  mkdirSync(join(directory, "images"), { recursive: true });
  const imageFiles: string[] = [];
  const cards = candidates.map((candidate) => {
    const hashes = imageHashes(candidate);
    const pngPath =
      hashes.pngHash === null
        ? null
        : copyArtifact(
            db,
            hashes.pngHash,
            "png",
            join(directory, "images", `${candidate.slotId}.png`),
          );
    if (pngPath !== null) {
      imageFiles.push(pngPath);
    }
    const svgPath =
      hashes.svgHash === null
        ? null
        : copyArtifact(
            db,
            hashes.svgHash,
            "svg",
            join(directory, "images", `${candidate.slotId}.svg`),
          );
    if (svgPath !== null) {
      imageFiles.push(svgPath);
    }
    return buildCard(
      candidate,
      stagesBySlot.get(candidate.slotId) ?? [],
      requestsBySlot.get(candidate.slotId) ?? [],
      {
        png: pngPath === null ? null : `images/${candidate.slotId}.png`,
        svg: svgPath === null ? null : `images/${candidate.slotId}.svg`,
      },
    );
  });
  const document: HtmlReportDocument = {
    run,
    metrics,
    cards,
    style: REPORT_STYLE,
    script: REPORT_SCRIPT,
  };
  const html = renderHtmlReport(document);
  const htmlPath = join(directory, "report.html");
  writeAtomicFile(htmlPath, html);
  return {
    runId,
    directory,
    htmlPath,
    imageFiles,
    cardCount: cards.length,
    scriptHash: cspHash(REPORT_SCRIPT),
    styleHash: cspHash(REPORT_STYLE),
  };
}
