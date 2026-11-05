import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import { addUsd } from "../ai/budget.js";
import {
  getLogicalCall,
  listAttempts,
  type LogicalCall,
  type RequestAttempt,
} from "../ai/ledger.js";
import {
  FailureRecordSchema,
  type CandidateVerdict,
  type DuplicateOutcome,
  type FailureCode,
  type FailureRecord,
  type WorkflowStage,
} from "../domain/candidate.js";
import {
  type Difficulty,
  type Family,
  type Lane,
  type Modality,
  type PlanManifest,
  type RequestRole,
  type SlotPlan,
} from "../domain/experiment.js";
import {
  getRun,
  listSlots,
  listStageResults,
  type SlotRecord,
  type StageResultRecord,
} from "../storage/repository.js";

export const METRICS_VERSION = 1 as const;

export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
}

export interface LatencyStats {
  readonly count: number;
  readonly meanMs: number | null;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly missing: number;
}

export interface RoleCost {
  readonly calls: number;
  readonly attempts: number;
  readonly knownActualUsd: string;
  readonly actualCostUsd: string | null;
  readonly averageActualCostUsd: string | null;
  readonly unknownAttempts: number;
  readonly missingCostAttempts: number;
}

export interface UsageRole {
  readonly calls: number;
  readonly attempts: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly cachedReadTokens: number | null;
  readonly cachedWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly missingPromptTokens: number;
  readonly missingCompletionTokens: number;
  readonly missingTotalTokens: number;
  readonly missingCachedReadTokens: number;
  readonly missingCachedWriteTokens: number;
  readonly missingReasoningTokens: number;
  readonly missingActualCost: number;
}

export interface StratumMetrics {
  readonly planned: number;
  readonly started: number;
  readonly terminal: number;
  readonly formalPassed: number;
  readonly presentationCheckPassed: number;
  readonly reviewed: number;
  readonly approved: number;
  readonly rejected: number;
  readonly inconclusive: number;
  readonly generationError: number;
  readonly formalPassRate: number | null;
  readonly preReviewPassRate: number | null;
  readonly approvalRate: number | null;
  readonly approvalWilson95: WilsonInterval | null;
  readonly structuralUniqueness: number | null;
  readonly fingerprintCoverage: number | null;
}

export interface RunMetrics {
  readonly version: typeof METRICS_VERSION;
  readonly run: {
    readonly runId: string;
    readonly runKind: string;
    readonly evidenceKind: string;
    readonly protocolVersion: string;
    readonly rootSeed: string;
    readonly manifestHash: string;
    readonly controlState: string;
    readonly createdAt: string;
    readonly manifest: PlanManifest;
  };
  readonly planned: {
    readonly total: number;
    readonly byModality: Readonly<Record<Modality, number>>;
    readonly byFamily: Readonly<Record<Family, number>>;
    readonly byLane: Readonly<Record<Lane, number>>;
    readonly byDifficulty: Readonly<Record<Difficulty, number>>;
    readonly familyByLane: Readonly<Record<string, number>>;
    readonly modalityByDifficulty: Readonly<Record<string, number>>;
    readonly familyByDifficulty: Readonly<Record<string, number>>;
  };
  readonly counts: {
    readonly planned: number;
    readonly started: number;
    readonly terminal: number;
    readonly fingerprintable: number;
    readonly formalPassed: number;
    readonly presentationCheckPassed: number;
    readonly reviewed: number;
    readonly blindReviewed: number;
    readonly alignmentReviewed: number;
    readonly approved: number;
    readonly rejected: number;
    readonly inconclusive: number;
    readonly generationError: number;
    readonly paused: number;
    readonly unstarted: number;
    readonly infrastructureOnlyTerminal: number;
    readonly terminalWithoutVerdict: number;
  };
  readonly rates: {
    readonly formalPassRate: number | null;
    readonly preReviewPassRate: number | null;
    readonly firstAttemptApprovalRate: number | null;
    readonly postReviewApprovalRate: number | null;
    readonly firstPassApprovalRate: number | null;
    readonly firstAttemptApprovalWilson95: WilsonInterval | null;
    readonly secondaryApprovalRate: number | null;
    readonly secondaryDenominator: number;
    readonly secondaryProvisional: boolean;
    readonly infrastructureOnlyExcluded: number;
    readonly conditionalReviewAgreement: number | null;
    readonly conditionalReviewDenominator: number;
    readonly reviewCoverage: number | null;
    readonly blindAmbiguityRate: number | null;
    readonly blindAmbiguityDenominator: number;
    readonly blindAmbiguityPlannedCount: number;
    readonly structuralUniqueness: number | null;
    readonly fingerprintCoverage: number | null;
  };
  readonly review: {
    readonly eligibleForReview: number;
    readonly blind: {
      readonly total: number;
      readonly parsed: number;
      readonly agreed: number;
      readonly disagreed: number;
      readonly notApplicable: number;
      readonly ambiguous: number;
      readonly incomplete: number;
      readonly byRole: Readonly<Record<"blind_text" | "blind_vision", ReviewRoleCounts>>;
    };
    readonly alignment: {
      readonly total: number;
      readonly parsed: number;
      readonly pass: number;
      readonly fail: number;
      readonly uncertain: number;
      readonly incomplete: number;
      readonly byRole: Readonly<
        Record<"alignment_text" | "alignment_vision", AlignmentRoleCounts>
      >;
    };
  };
  readonly uniqueness: {
    readonly fingerprintable: number;
    readonly distinctStructures: number;
    readonly structuralUniqueness: number | null;
    readonly fingerprintCoverage: number | null;
  };
  readonly cost: {
    readonly currency: "USD";
    readonly calls: number;
    readonly attempts: number;
    readonly startedCandidates: number;
    readonly approved: number;
    readonly knownActualUsd: string;
    readonly actualCostUsd: string | null;
    readonly costStatus: "known" | "unknown" | "not_applicable";
    readonly unknownAttempts: number;
    readonly missingCostAttempts: number;
    readonly averageCostPerAttemptUsd: string | null;
    readonly averageCostPerApprovedUsd: string | null;
    readonly knownCostPerApprovedUsd: string | null;
    readonly reservedExposureUsd: string;
    readonly unknownExposureUsd: string;
    readonly exposurePerApprovedUsd: string | null;
    readonly byRole: Readonly<Record<RequestRole, RoleCost>>;
    readonly generator: RoleCost;
    readonly textReview: RoleCost;
    readonly visionReview: RoleCost;
    readonly endToEnd: {
      readonly primaryMarginalUsd: string | null;
      readonly primaryMarginalKnownLowerBoundUsd: string;
      readonly byRunKind: Readonly<
        Record<
          "preflight" | "calibration" | "smoke" | "full",
          {
            readonly knownActualUsd: string;
            readonly reservedUsd: string;
            readonly unknownExposureUsd: string;
            readonly actualCostUsd: string | null;
          }
        >
      >;
      readonly endToEndKnownLowerBoundUsd: string;
      readonly endToEndActualCostUsd: string | null;
    };
  };
  readonly usage: {
    readonly byRole: Readonly<Record<RequestRole, UsageRole>>;
    readonly generator: UsageRole;
    readonly textReview: UsageRole;
    readonly visionReview: UsageRole;
  };
  readonly latency: {
    readonly attemptsByRole: Readonly<Record<RequestRole, LatencyStats>>;
    readonly logicalCallsByRole: Readonly<Record<RequestRole, LatencyStats>>;
    readonly candidatePreparation: LatencyStats;
    readonly candidateReview: LatencyStats;
    readonly candidateWall: LatencyStats;
  };
  readonly failures: {
    readonly codes: Readonly<Partial<Record<FailureCode, number>>>;
    readonly totalFailureRecords: number;
    readonly multipleFailureCandidates: number;
    readonly terminalWithoutFailure: number;
    readonly note: string;
    readonly verdictHistogram: Readonly<Record<CandidateVerdict, number>>;
  };
  readonly nearDuplicateBlocked: {
    readonly total: number;
    readonly onlyNear: number;
    readonly additionalQuality: number;
    readonly incompleteOrFailedReview: number;
    readonly byFamily: Readonly<Record<Family, NearCategoryCounts>>;
    readonly byLane: Readonly<Record<Lane, NearCategoryCounts>>;
    readonly familyByLane: Readonly<Record<string, NearCategoryCounts>>;
  };
  readonly tables: {
    readonly byModality: Readonly<Record<Modality, StratumMetrics>>;
    readonly byFamily: Readonly<Record<Family, StratumMetrics>>;
    readonly byLane: Readonly<Record<Lane, StratumMetrics>>;
    readonly byDifficulty: Readonly<Record<Difficulty, StratumMetrics>>;
    readonly familyByLane: Readonly<Record<string, StratumMetrics>>;
    readonly modalityByDifficulty: Readonly<Record<string, StratumMetrics>>;
    readonly familyByDifficulty: Readonly<Record<string, StratumMetrics>>;
  };
  readonly notes: readonly string[];
  readonly missing: {
    readonly usage: {
      readonly totalAttempts: number;
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
      readonly cachedReadTokens: number;
      readonly cachedWriteTokens: number;
      readonly reasoningTokens: number;
      readonly actualCost: number;
    };
    readonly latency: {
      readonly attemptEndTimes: number;
      readonly callEndTimes: number;
      readonly preparationTimes: number;
      readonly reviewTimes: number;
      readonly wallTimes: number;
    };
    readonly stages: {
      readonly formal: number;
      readonly presentation: number;
      readonly blind: number;
      readonly alignment: number;
      readonly terminal: number;
    };
  };
}

export interface ReviewRoleCounts {
  total: number;
  parsed: number;
  agreed: number;
  disagreed: number;
  notApplicable: number;
  ambiguous: number;
  incomplete: number;
}

export interface AlignmentRoleCounts {
  total: number;
  parsed: number;
  pass: number;
  fail: number;
  uncertain: number;
  incomplete: number;
}

export interface NearCategoryCounts {
  total: number;
  onlyNear: number;
  additionalQuality: number;
  incompleteOrFailedReview: number;
}

interface BlindView {
  readonly role: "blind_text" | "blind_vision" | null;
  readonly completed: boolean;
  readonly parsed: boolean;
  readonly agreement: "agreed" | "disagreed" | "not_applicable" | null;
  readonly ambiguity: "none" | "present" | "uncertain" | null;
}

interface AlignmentView {
  readonly role: "alignment_text" | "alignment_vision" | null;
  readonly completed: boolean;
  readonly derivedOverall: "pass" | "fail" | "uncertain" | null;
}

interface AssessmentView {
  readonly eligible: boolean;
  readonly outcome: DuplicateOutcome | null;
}

interface SlotView {
  readonly plan: SlotPlan;
  readonly slot: SlotRecord;
  readonly stages: ReadonlyMap<WorkflowStage, StageResultRecord>;
  readonly calls: readonly LogicalCall[];
  readonly attempts: readonly {
    readonly call: LogicalCall;
    readonly attempt: RequestAttempt;
  }[];
  readonly failures: readonly FailureRecord[];
  readonly assessment: AssessmentView | null;
  readonly structureHash: string | null;
  readonly blind: BlindView | null;
  readonly alignment: AlignmentView | null;
  readonly formalRender: { readonly svgHash: string | null; readonly pngHash: string | null };
}

interface AttemptEntry {
  readonly call: LogicalCall;
  readonly attempt: RequestAttempt;
}

const ZERO = "0";

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function failuresFrom(payload: unknown): FailureRecord[] {
  const parsed = FailureRecordSchema.array().safeParse(objectValue(payload).failures);
  return parsed.success ? parsed.data : [];
}

function stageFailureFrom(payload: unknown): FailureRecord | null {
  const parsed = FailureRecordSchema.safeParse(objectValue(payload).failure);
  return parsed.success ? parsed.data : null;
}

function assessmentFrom(payload: unknown): AssessmentView | null {
  const raw = objectValue(objectValue(payload).assessment);
  if (Object.keys(raw).length === 0) {
    return null;
  }
  const outcome =
    raw.outcome === "owner" ||
    raw.outcome === "unique" ||
    raw.outcome === "near_suspected" ||
    raw.outcome === "exact_duplicate" ||
    raw.outcome === "spec_duplicate" ||
    raw.outcome === "structural_duplicate"
      ? raw.outcome
      : null;
  return { eligible: raw.eligible === true, outcome };
}

function structureHashFrom(payload: unknown): string | null {
  const fingerprint = objectValue(objectValue(payload).fingerprint);
  return stringOrNull(fingerprint.structureHash);
}

function renderFrom(payload: unknown): {
  readonly svgHash: string | null;
  readonly pngHash: string | null;
} {
  const render = objectValue(objectValue(payload).render);
  return {
    svgHash: stringOrNull(render.svgHash),
    pngHash: stringOrNull(render.pngHash),
  };
}

function blindFrom(payload: unknown): BlindView | null {
  const value = objectValue(payload);
  if (Object.keys(value).length === 0) {
    return null;
  }
  const review = objectValue(value.review);
  const role =
    value.role === "blind_text" || value.role === "blind_vision"
      ? value.role
      : null;
  const agreement =
    value.choiceAgreement === "agreed" ||
    value.choiceAgreement === "disagreed" ||
    value.choiceAgreement === "not_applicable"
      ? value.choiceAgreement
      : null;
  const ambiguity =
    review.ambiguity === "none" ||
    review.ambiguity === "present" ||
    review.ambiguity === "uncertain"
      ? review.ambiguity
      : null;
  const completed = booleanValue(value.completed);
  return {
    role,
    completed,
    parsed: completed && Object.keys(review).length > 0,
    agreement,
    ambiguity,
  };
}

function alignmentFrom(payload: unknown): AlignmentView | null {
  const value = objectValue(payload);
  if (Object.keys(value).length === 0) {
    return null;
  }
  const role =
    value.role === "alignment_text" || value.role === "alignment_vision"
      ? value.role
      : null;
  const derivedOverall =
    value.derivedOverall === "pass" ||
    value.derivedOverall === "fail" ||
    value.derivedOverall === "uncertain"
      ? value.derivedOverall
      : null;
  return {
    role,
    completed: booleanValue(value.completed),
    derivedOverall,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)] as number;
}

export function wilson95(
  successes: number,
  trials: number,
  z = 1.96,
): WilsonInterval | null {
  if (trials <= 0) {
    return null;
  }
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const half =
    (z *
      Math.sqrt(
        (p * (1 - p)) / trials + (z * z) / (4 * trials * trials),
      )) /
    denominator;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

function latencyStats(values: readonly number[], missing: number): LatencyStats {
  return {
    count: values.length,
    meanMs: mean(values),
    medianMs: median(values),
    p95Ms: nearestRankP95(values),
    missing,
  };
}

function emptyUsageRole(calls: number, attempts: number): UsageRole {
  return {
    calls,
    attempts,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    reasoningTokens: null,
    missingPromptTokens: attempts,
    missingCompletionTokens: attempts,
    missingTotalTokens: attempts,
    missingCachedReadTokens: attempts,
    missingCachedWriteTokens: attempts,
    missingReasoningTokens: attempts,
    missingActualCost: attempts,
  };
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, value) => sum + value, 0);
}

function usageFor(entries: readonly AttemptEntry[], calls: number): UsageRole {
  const attempts = entries.map((entry) => entry.attempt);
  const promptTokens = sumNullable(attempts.map((attempt) => attempt.promptTokens));
  const completionTokens = sumNullable(
    attempts.map((attempt) => attempt.completionTokens),
  );
  const totalTokens = sumNullable(attempts.map((attempt) => attempt.totalTokens));
  const cachedReadTokens = sumNullable(
    attempts.map((attempt) => attempt.cachedReadTokens),
  );
  const cachedWriteTokens = sumNullable(
    attempts.map((attempt) => attempt.cachedWriteTokens),
  );
  const reasoningTokens = sumNullable(
    attempts.map((attempt) => attempt.reasoningTokens),
  );
  return {
    calls,
    attempts: attempts.length,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedReadTokens,
    cachedWriteTokens,
    reasoningTokens,
    missingPromptTokens: attempts.filter((attempt) => attempt.promptTokens === null)
      .length,
    missingCompletionTokens: attempts.filter(
      (attempt) => attempt.completionTokens === null,
    ).length,
    missingTotalTokens: attempts.filter((attempt) => attempt.totalTokens === null)
      .length,
    missingCachedReadTokens: attempts.filter(
      (attempt) => attempt.cachedReadTokens === null,
    ).length,
    missingCachedWriteTokens: attempts.filter(
      (attempt) => attempt.cachedWriteTokens === null,
    ).length,
    missingReasoningTokens: attempts.filter(
      (attempt) => attempt.reasoningTokens === null,
    ).length,
    missingActualCost: attempts.filter(
      (attempt) => attempt.costStatus === "unknown" && !isProvablyUnbilledAttempt(attempt),
    ).length,
  };
}

function combineUsage(
  roles: readonly UsageRole[],
): UsageRole {
  const present = roles.filter((role) => role.attempts > 0);
  if (present.length === 0) {
    return emptyUsageRole(0, 0);
  }
  return {
    calls: present.reduce((sum, role) => sum + role.calls, 0),
    attempts: present.reduce((sum, role) => sum + role.attempts, 0),
    promptTokens: sumNullable(present.map((role) => role.promptTokens)),
    completionTokens: sumNullable(present.map((role) => role.completionTokens)),
    totalTokens: sumNullable(present.map((role) => role.totalTokens)),
    cachedReadTokens: sumNullable(present.map((role) => role.cachedReadTokens)),
    cachedWriteTokens: sumNullable(present.map((role) => role.cachedWriteTokens)),
    reasoningTokens: sumNullable(present.map((role) => role.reasoningTokens)),
    missingPromptTokens: present.reduce(
      (sum, role) => sum + role.missingPromptTokens,
      0,
    ),
    missingCompletionTokens: present.reduce(
      (sum, role) => sum + role.missingCompletionTokens,
      0,
    ),
    missingTotalTokens: present.reduce(
      (sum, role) => sum + role.missingTotalTokens,
      0,
    ),
    missingCachedReadTokens: present.reduce(
      (sum, role) => sum + role.missingCachedReadTokens,
      0,
    ),
    missingCachedWriteTokens: present.reduce(
      (sum, role) => sum + role.missingCachedWriteTokens,
      0,
    ),
    missingReasoningTokens: present.reduce(
      (sum, role) => sum + role.missingReasoningTokens,
      0,
    ),
    missingActualCost: present.reduce(
      (sum, role) => sum + role.missingActualCost,
      0,
    ),
  };
}

export function isProvablyUnbilledAttempt(
  attempt: Pick<RequestAttempt, "state">,
): boolean {
  return attempt.state === "prepared" || attempt.state === "refused_unprocessed";
}

function costFor(entries: readonly AttemptEntry[], calls: number): RoleCost {
  const attempts = entries.map((entry) => entry.attempt);
  const known = attempts.flatMap((attempt) =>
    attempt.costStatus === "known" && attempt.actualCostUsd !== null
      ? [attempt.actualCostUsd]
      : [],
  );
  const unknownAttempts = attempts.filter(
    (attempt) => attempt.costStatus === "unknown" && !isProvablyUnbilledAttempt(attempt),
  ).length;
  const knownActualUsd = addUsd(...known);
  const actualCostUsd =
    attempts.length === 0
      ? null
      : unknownAttempts > 0
        ? null
        : knownActualUsd;
  return {
    calls,
    attempts: attempts.length,
    knownActualUsd,
    actualCostUsd,
    averageActualCostUsd:
      actualCostUsd === null || attempts.length === 0
        ? null
        : new Decimal(actualCostUsd).div(attempts.length).toFixed(6),
    unknownAttempts,
    missingCostAttempts: attempts.filter(
      (attempt) => attempt.actualCostUsd === null && !isProvablyUnbilledAttempt(attempt),
    ).length,
  };
}

function combineCost(roles: readonly RoleCost[]): RoleCost {
  const present = roles.filter((role) => role.attempts > 0);
  const attempts = present.reduce((sum, role) => sum + role.attempts, 0);
  const knownActualUsd = addUsd(...present.map((role) => role.knownActualUsd));
  const unknownAttempts = present.reduce(
    (sum, role) => sum + role.unknownAttempts,
    0,
  );
  return {
    calls: present.reduce((sum, role) => sum + role.calls, 0),
    attempts,
    knownActualUsd,
    actualCostUsd: attempts === 0 || unknownAttempts > 0 ? null : knownActualUsd,
    averageActualCostUsd:
      attempts === 0 || unknownAttempts > 0
        ? null
        : new Decimal(knownActualUsd).div(attempts).toFixed(6),
    unknownAttempts,
    missingCostAttempts: present.reduce(
      (sum, role) => sum + role.missingCostAttempts,
      0,
    ),
  };
}

function isInfrastructureOnly(failures: readonly FailureRecord[]): boolean {
  if (failures.length === 0) {
    return false;
  }
  const codes = new Set(failures.map((failure) => failure.code));
  const infrastructure = new Set(["API_ERROR", "MISSING_REVIEW", "COST_UNKNOWN"]);
  if (![...codes].every((code) => infrastructure.has(code))) {
    return false;
  }
  return codes.has("API_ERROR") || codes.has("MISSING_REVIEW");
}

export function classifyNearDuplicateCategory(
  failures: readonly FailureRecord[],
): Exclude<keyof NearCategoryCounts, "total"> {
  const reviewEvidenceFailed = failures.some(
    (failure) =>
      failure.code === "MISSING_REVIEW" ||
      ((failure.stage === "blind_reviewed" ||
        failure.stage === "alignment_reviewed") &&
        (failure.code === "API_ERROR" || failure.code === "SCHEMA_INVALID")),
  );
  if (reviewEvidenceFailed) {
    return "incompleteOrFailedReview";
  }
  const quality = failures.some(
    (failure) =>
      failure.code !== "NEAR_DUPLICATE_SUSPECTED" &&
      failure.code !== "COST_UNKNOWN",
  );
  return quality ? "additionalQuality" : "onlyNear";
}

function emptyNear(): NearCategoryCounts {
  return {
    total: 0,
    onlyNear: 0,
    additionalQuality: 0,
    incompleteOrFailedReview: 0,
  };
}

function addNear(
  target: NearCategoryCounts,
  category: Exclude<keyof NearCategoryCounts, "total">,
): NearCategoryCounts {
  return {
    total: target.total + 1,
    onlyNear: target.onlyNear + (category === "onlyNear" ? 1 : 0),
    additionalQuality:
      target.additionalQuality + (category === "additionalQuality" ? 1 : 0),
    incompleteOrFailedReview:
      target.incompleteOrFailedReview +
      (category === "incompleteOrFailedReview" ? 1 : 0),
  };
}

function stratumMetrics(views: readonly SlotView[]): StratumMetrics {
  const planned = views.length;
  let started = 0;
  let terminal = 0;
  let formalPassed = 0;
  let presentationCheckPassed = 0;
  let reviewed = 0;
  let approved = 0;
  let rejected = 0;
  let inconclusive = 0;
  let generationError = 0;
  let fingerprintable = 0;
  const structures = new Set<string>();
  for (const view of views) {
    const isStarted = view.stages.size > 0 || view.calls.length > 0;
    const isTerminal = view.stages.has("terminal");
    if (isStarted) started += 1;
    if (isTerminal) terminal += 1;
    if (view.stages.has("formal_checked")) formalPassed += 1;
    if (view.stages.has("presentation_ready")) presentationCheckPassed += 1;
    if (view.stages.has("blind_reviewed")) reviewed += 1;
    if (view.slot.verdict === "approved") approved += 1;
    if (view.slot.verdict === "rejected") rejected += 1;
    if (view.slot.verdict === "inconclusive") inconclusive += 1;
    if (view.slot.verdict === "generation_error") generationError += 1;
    if (view.structureHash !== null) {
      fingerprintable += 1;
      structures.add(view.structureHash);
    }
  }
  return {
    planned,
    started,
    terminal,
    formalPassed,
    presentationCheckPassed,
    reviewed,
    approved,
    rejected,
    inconclusive,
    generationError,
    formalPassRate: ratio(formalPassed, planned),
    preReviewPassRate: ratio(presentationCheckPassed, planned),
    approvalRate: ratio(approved, planned),
    approvalWilson95: wilson95(approved, planned),
    structuralUniqueness: ratio(structures.size, fingerprintable),
    fingerprintCoverage: ratio(fingerprintable, planned),
  };
}

function groupViews(
  views: readonly SlotView[],
  key: (view: SlotView) => string,
): Map<string, SlotView[]> {
  const groups = new Map<string, SlotView[]>();
  for (const view of views) {
    const groupKey = key(view);
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, [view]);
    } else {
      group.push(view);
    }
  }
  return groups;
}

function tableFrom(
  views: readonly SlotView[],
  keys: readonly string[],
  key: (view: SlotView) => string,
): Record<string, StratumMetrics> {
  const groups = groupViews(views, key);
  const table: Record<string, StratumMetrics> = {};
  for (const groupKey of keys) {
    table[groupKey] = stratumMetrics(groups.get(groupKey) ?? []);
  }
  return table;
}

function buildSlotViews(
  db: Database.Database,
  runId: string,
  plan: PlanManifest,
): SlotView[] {
  const slots = new Map(listSlots(db, runId).map((slot) => [slot.slotId, slot]));
  const stages = new Map<string, Map<WorkflowStage, StageResultRecord>>();
  for (const stage of listStageResults(db, runId)) {
    const slotStages = stages.get(stage.slotId) ?? new Map();
    slotStages.set(stage.stage, stage);
    stages.set(stage.slotId, slotStages);
  }
  const callsBySlot = new Map<string, LogicalCall[]>();
  const callRows = db
    .prepare(
      "SELECT logical_call_id FROM logical_calls WHERE run_id = ? ORDER BY role, created_at, logical_call_id",
    )
    .all(runId) as Array<{ logical_call_id: string }>;
  const attemptsByCall = new Map<string, RequestAttempt[]>();
  for (const row of callRows) {
    const call = getLogicalCall(db, row.logical_call_id);
    if (call.slotId === null) {
      continue;
    }
    const calls = callsBySlot.get(call.slotId) ?? [];
    calls.push(call);
    callsBySlot.set(call.slotId, calls);
    attemptsByCall.set(call.logicalCallId, listAttempts(db, call.logicalCallId));
  }
  return plan.slots.map((planSlot) => {
    const slot =
      slots.get(planSlot.slotId) ??
      ({
        runId,
        slotId: planSlot.slotId,
        slotOrdinal: planSlot.slotOrdinal,
        family: planSlot.family,
        modality: planSlot.modality,
        lane: planSlot.lane,
        difficulty: planSlot.difficulty,
        stage: "planned",
        verdict: null,
        checkpointVersion: 0,
        createdAt: "",
        updatedAt: "",
      } satisfies SlotRecord);
    const slotStages = stages.get(planSlot.slotId) ?? new Map();
    const calls = callsBySlot.get(planSlot.slotId) ?? [];
    const attempts = calls.flatMap((call) =>
      (attemptsByCall.get(call.logicalCallId) ?? []).map((attempt) => ({
        call,
        attempt,
      })),
    );
    const terminalPayload = slotStages.get("terminal")?.payload;
    const formalPayload = slotStages.get("formal_checked")?.payload;
    const terminalFailures =
      terminalPayload === undefined ? [] : failuresFrom(terminalPayload);
    const stageFailures =
      terminalPayload !== undefined
        ? []
        : [
            stageFailureFrom(slotStages.get("spec_ready")?.payload),
            stageFailureFrom(formalPayload),
            stageFailureFrom(slotStages.get("presentation_ready")?.payload),
            stageFailureFrom(slotStages.get("blind_reviewed")?.payload),
            stageFailureFrom(slotStages.get("alignment_reviewed")?.payload),
          ].filter((failure): failure is FailureRecord => failure !== null);
    return {
      plan: planSlot,
      slot,
      stages: slotStages,
      calls,
      attempts,
      failures: [...terminalFailures, ...stageFailures],
      assessment:
        slotStages.get("duplicate_checked") === undefined
          ? null
          : assessmentFrom(slotStages.get("duplicate_checked")?.payload),
      structureHash:
        structureHashFrom(formalPayload) ??
        (terminalPayload === undefined ? null : structureHashFrom(terminalPayload)),
      blind:
        slotStages.get("blind_reviewed") === undefined
          ? null
          : blindFrom(slotStages.get("blind_reviewed")?.payload),
      alignment:
        slotStages.get("alignment_reviewed") === undefined
          ? null
          : alignmentFrom(slotStages.get("alignment_reviewed")?.payload),
      formalRender:
        formalPayload === undefined
          ? { svgHash: null, pngHash: null }
          : renderFrom(formalPayload),
    };
  });
}

export function computeRunMetrics(
  db: Database.Database,
  runId: string,
): RunMetrics {
  const run = getRun(db, runId);
  const plan = run.manifest as PlanManifest;
  const views = buildSlotViews(db, runId, plan);
  const entries: AttemptEntry[] = views.flatMap((view) => [...view.attempts]);
  const uniqueCalls = new Map(
    views
      .flatMap((view) => [...view.calls])
      .map((call) => [call.logicalCallId, call]),
  );

  const plannedByModality: Record<Modality, number> = { text: 0, svg: 0 };
  const plannedByFamily = Object.fromEntries(
    [...new Set(plan.slots.map((slot) => slot.family))].map((family) => [family, 0]),
  ) as Record<Family, number>;
  const plannedByLane: Record<Lane, number> = { spec_first: 0, ai_spec: 0 };
  const plannedByDifficulty = Object.fromEntries(
    [1, 2, 3, 4, 5].map((difficulty) => [difficulty, 0]),
  ) as Record<Difficulty, number>;
  const familyByLane: Record<string, number> = {};
  const modalityByDifficulty: Record<string, number> = {};
  const familyByDifficulty: Record<string, number> = {};
  for (const slot of plan.slots) {
    plannedByModality[slot.modality] += 1;
    plannedByFamily[slot.family] += 1;
    plannedByLane[slot.lane] += 1;
    plannedByDifficulty[slot.difficulty] += 1;
    const familyLane = `${slot.family}/${slot.lane}`;
    familyByLane[familyLane] = (familyByLane[familyLane] ?? 0) + 1;
    const modalityDifficulty = `${slot.modality}/${slot.difficulty}`;
    modalityByDifficulty[modalityDifficulty] =
      (modalityByDifficulty[modalityDifficulty] ?? 0) + 1;
    const familyDifficulty = `${slot.family}/${slot.difficulty}`;
    familyByDifficulty[familyDifficulty] =
      (familyByDifficulty[familyDifficulty] ?? 0) + 1;
  }

  let started = 0;
  let terminal = 0;
  let fingerprintable = 0;
  let formalPassed = 0;
  let presentationCheckPassed = 0;
  let blindReviewed = 0;
  let alignmentReviewed = 0;
  let approved = 0;
  let rejected = 0;
  let inconclusive = 0;
  let generationError = 0;
  let infrastructureOnlyTerminal = 0;
  let terminalWithoutVerdict = 0;
  const structures = new Set<string>();
  let eligibleForReview = 0;
  let parsedBlind = 0;
  let agreedBlind = 0;
  let ambiguousBlind = 0;
  let parsedAlignment = 0;
  const blindByRole: Record<"blind_text" | "blind_vision", ReviewRoleCounts> = {
    blind_text: {
      total: 0,
      parsed: 0,
      agreed: 0,
      disagreed: 0,
      notApplicable: 0,
      ambiguous: 0,
      incomplete: 0,
    },
    blind_vision: {
      total: 0,
      parsed: 0,
      agreed: 0,
      disagreed: 0,
      notApplicable: 0,
      ambiguous: 0,
      incomplete: 0,
    },
  };
  const alignmentByRole: Record<
    "alignment_text" | "alignment_vision",
    AlignmentRoleCounts
  > = {
    alignment_text: {
      total: 0,
      parsed: 0,
      pass: 0,
      fail: 0,
      uncertain: 0,
      incomplete: 0,
    },
    alignment_vision: {
      total: 0,
      parsed: 0,
      pass: 0,
      fail: 0,
      uncertain: 0,
      incomplete: 0,
    },
  };
  const failureCounts: Partial<Record<FailureCode, number>> = {};
  let totalFailureRecords = 0;
  let multipleFailureCandidates = 0;
  let terminalWithoutFailure = 0;
  const verdictHistogram: Record<CandidateVerdict, number> = {
    approved: 0,
    rejected: 0,
    inconclusive: 0,
    generation_error: 0,
  };
  const nearOverall: NearCategoryCounts = emptyNear();
  const nearByFamily: Record<Family, NearCategoryCounts> = Object.fromEntries(
    [...new Set(plan.slots.map((slot) => slot.family))].map((family) => [
      family,
      emptyNear(),
    ]),
  ) as Record<Family, NearCategoryCounts>;
  const nearByLane: Record<Lane, NearCategoryCounts> = {
    spec_first: emptyNear(),
    ai_spec: emptyNear(),
  };
  const nearFamilyByLane: Record<string, NearCategoryCounts> = {};

  for (const view of views) {
    const isStarted = view.stages.size > 0 || view.calls.length > 0;
    const isTerminal = view.stages.has("terminal");
    if (isStarted) started += 1;
    if (isTerminal) terminal += 1;
    if (view.stages.has("formal_checked")) formalPassed += 1;
    if (view.stages.has("presentation_ready")) presentationCheckPassed += 1;
    if (view.stages.has("blind_reviewed")) blindReviewed += 1;
    if (view.stages.has("alignment_reviewed")) alignmentReviewed += 1;
    if (view.structureHash !== null) {
      fingerprintable += 1;
      structures.add(view.structureHash);
    }
    if (view.slot.verdict === "approved") approved += 1;
    if (view.slot.verdict === "rejected") rejected += 1;
    if (view.slot.verdict === "inconclusive") inconclusive += 1;
    if (view.slot.verdict === "generation_error") generationError += 1;
    if (view.slot.verdict !== null) verdictHistogram[view.slot.verdict] += 1;
    if (isTerminal && view.slot.verdict === null) terminalWithoutVerdict += 1;
    if (isTerminal && isInfrastructureOnly(view.failures)) {
      infrastructureOnlyTerminal += 1;
    }
    totalFailureRecords += view.failures.length;
    if (view.failures.length > 1) {
      multipleFailureCandidates += 1;
    }
    for (const failure of view.failures) {
      failureCounts[failure.code] = (failureCounts[failure.code] ?? 0) + 1;
    }
    if (isTerminal && view.failures.length === 0) {
      terminalWithoutFailure += 1;
    }
    if (
      view.assessment?.eligible === true &&
      (view.assessment.outcome === "owner" ||
        view.assessment.outcome === "unique" ||
        view.assessment.outcome === "near_suspected")
    ) {
      eligibleForReview += 1;
    }
    const blindRole =
      view.blind?.role ??
      (view.slot.modality === "text" ? "blind_text" : "blind_vision");
    if (view.blind !== null) {
      const counts = blindByRole[blindRole];
      counts.total += 1;
      if (view.blind.parsed) {
        parsedBlind += 1;
        counts.parsed += 1;
        if (view.blind.agreement === "agreed") {
          agreedBlind += 1;
          counts.agreed += 1;
        } else if (view.blind.agreement === "disagreed") {
          counts.disagreed += 1;
        } else if (view.blind.agreement === "not_applicable") {
          counts.notApplicable += 1;
        }
        if (
          view.blind.ambiguity === "present" ||
          view.blind.ambiguity === "uncertain"
        ) {
          ambiguousBlind += 1;
          counts.ambiguous += 1;
        }
      } else {
        counts.incomplete += 1;
      }
    }
    const alignmentRole =
      view.alignment?.role ??
      (view.slot.modality === "text" ? "alignment_text" : "alignment_vision");
    if (view.alignment !== null) {
      const counts = alignmentByRole[alignmentRole];
      counts.total += 1;
      if (view.alignment.completed && view.alignment.derivedOverall !== null) {
        parsedAlignment += 1;
        counts.parsed += 1;
        if (view.alignment.derivedOverall === "pass") {
          counts.pass += 1;
        } else if (view.alignment.derivedOverall === "fail") {
          counts.fail += 1;
        } else {
          counts.uncertain += 1;
        }
      } else {
        counts.incomplete += 1;
      }
    }
    const near =
      view.assessment?.outcome === "near_suspected" ||
      view.failures.some((failure) => failure.code === "NEAR_DUPLICATE_SUSPECTED");
    if (near) {
      const category = isTerminal
        ? classifyNearDuplicateCategory(view.failures)
        : "incompleteOrFailedReview";
      const familyLane = `${view.slot.family}/${view.slot.lane}`;
      const currentFamily = nearByFamily[view.slot.family] ?? emptyNear();
      const currentLane = nearByLane[view.slot.lane];
      const currentFamilyLane = nearFamilyByLane[familyLane] ?? emptyNear();
      const updatedFamily = addNear(currentFamily, category);
      const updatedLane = addNear(currentLane, category);
      const updatedFamilyLane = addNear(currentFamilyLane, category);
      nearByFamily[view.slot.family] = updatedFamily;
      nearByLane[view.slot.lane] = updatedLane;
      nearFamilyByLane[familyLane] = updatedFamilyLane;
      nearOverall.total += 1;
      nearOverall[category] += 1;
    }
  }

  const roleEntries = new Map<RequestRole, AttemptEntry[]>();
  for (const entry of entries) {
    const role = entry.call.role as RequestRole;
    const list = roleEntries.get(role) ?? [];
    list.push(entry);
    roleEntries.set(role, list);
  }
  const roles: RequestRole[] = [
    "spec",
    "wording",
    "blind_text",
    "blind_vision",
    "alignment_text",
    "alignment_vision",
  ];
  const allCallsByRole = new Map<RequestRole, number>();
  for (const call of uniqueCalls.values()) {
    const role = call.role as RequestRole;
    allCallsByRole.set(role, (allCallsByRole.get(role) ?? 0) + 1);
  }
  const costByRole = Object.fromEntries(
    roles.map((role) => [
      role,
      costFor(roleEntries.get(role) ?? [], allCallsByRole.get(role) ?? 0),
    ]),
  ) as Record<RequestRole, RoleCost>;
  const usageByRole = Object.fromEntries(
    roles.map((role) => [
      role,
      usageFor(roleEntries.get(role) ?? [], allCallsByRole.get(role) ?? 0),
    ]),
  ) as Record<RequestRole, UsageRole>;
  const generator = combineCost([costByRole.spec, costByRole.wording]);
  const textReview = combineCost([
    costByRole.blind_text,
    costByRole.alignment_text,
  ]);
  const visionReview = combineCost([
    costByRole.blind_vision,
    costByRole.alignment_vision,
  ]);
  const generatorUsage = combineUsage([usageByRole.spec, usageByRole.wording]);
  const textReviewUsage = combineUsage([
    usageByRole.blind_text,
    usageByRole.alignment_text,
  ]);
  const visionReviewUsage = combineUsage([
    usageByRole.blind_vision,
    usageByRole.alignment_vision,
  ]);
  const totalCost = combineCost(Object.values(costByRole));
  const totalUsage = combineUsage(Object.values(usageByRole));

  const accountRow = db
    .prepare(
      "SELECT account_id FROM budget_accounts WHERE run_id = ? AND run_kind = ? LIMIT 1",
    )
    .get(runId, run.runKind) as { account_id: string } | undefined;
  const account =
    accountRow === undefined
      ? null
      : (db
          .prepare(
            "SELECT known_actual_usd, reserved_usd, unknown_exposure_usd FROM budget_accounts WHERE account_id = ?",
          )
          .get(accountRow.account_id) as {
          known_actual_usd: string;
          reserved_usd: string;
          unknown_exposure_usd: string;
        });
  const reservedExposureUsd = account?.reserved_usd ?? ZERO;
  const unknownExposureUsd = account?.unknown_exposure_usd ?? ZERO;
  const exposureUsd = addUsd(reservedExposureUsd, unknownExposureUsd);
  const averageCostPerAttemptUsd =
    totalCost.actualCostUsd === null || started === 0
      ? null
      : new Decimal(totalCost.actualCostUsd).div(started).toFixed(6);
  const averageCostPerApprovedUsd =
    totalCost.actualCostUsd === null || approved === 0
      ? null
      : new Decimal(totalCost.actualCostUsd).div(approved).toFixed(6);
  const knownCostPerApprovedUsd =
    approved === 0
      ? null
      : new Decimal(totalCost.knownActualUsd).div(approved).toFixed(6);
  const exposurePerApprovedUsd =
    approved === 0
      ? null
      : new Decimal(exposureUsd).div(approved).toFixed(6);

  const accountRows = db
    .prepare(
      "SELECT run_kind, known_actual_usd, reserved_usd, unknown_exposure_usd FROM budget_accounts",
    )
    .all() as Array<{
    run_kind: "preflight" | "calibration" | "smoke" | "full";
    known_actual_usd: string;
    reserved_usd: string;
    unknown_exposure_usd: string;
  }>;
  const byRunKind: Record<
    "preflight" | "calibration" | "smoke" | "full",
    {
      knownActualUsd: string;
      reservedUsd: string;
      unknownExposureUsd: string;
      actualCostUsd: string | null;
    }
  > = {
    preflight: {
      knownActualUsd: ZERO,
      reservedUsd: ZERO,
      unknownExposureUsd: ZERO,
      actualCostUsd: null,
    },
    calibration: {
      knownActualUsd: ZERO,
      reservedUsd: ZERO,
      unknownExposureUsd: ZERO,
      actualCostUsd: null,
    },
    smoke: {
      knownActualUsd: ZERO,
      reservedUsd: ZERO,
      unknownExposureUsd: ZERO,
      actualCostUsd: null,
    },
    full: {
      knownActualUsd: ZERO,
      reservedUsd: ZERO,
      unknownExposureUsd: ZERO,
      actualCostUsd: null,
    },
  };
  const kindsWithAccounts = new Set<string>();
  const unknownAttemptKinds = new Set<string>();
  const attemptRows = db
    .prepare(
      "SELECT lc.run_kind, ra.state, ra.cost_status FROM request_attempts ra JOIN logical_calls lc ON lc.logical_call_id = ra.logical_call_id",
    )
    .all() as Array<{
    run_kind: string;
    state: string;
    cost_status: string;
  }>;
  for (const row of attemptRows) {
    if (
      row.cost_status === "unknown" &&
      row.state !== "prepared" &&
      row.state !== "refused_unprocessed"
    ) {
      unknownAttemptKinds.add(row.run_kind);
    }
  }
  for (const row of accountRows) {
    kindsWithAccounts.add(row.run_kind);
    const current = byRunKind[row.run_kind];
    byRunKind[row.run_kind] = {
      knownActualUsd: addUsd(current.knownActualUsd, row.known_actual_usd),
      reservedUsd: addUsd(current.reservedUsd, row.reserved_usd),
      unknownExposureUsd: addUsd(
        current.unknownExposureUsd,
        row.unknown_exposure_usd,
      ),
      actualCostUsd: null,
    };
  }
  for (const kind of Object.keys(byRunKind) as Array<
    "preflight" | "calibration" | "smoke" | "full"
  >) {
    const current = byRunKind[kind];
    byRunKind[kind] = {
      ...current,
      actualCostUsd:
        kindsWithAccounts.has(kind) &&
        !unknownAttemptKinds.has(kind) &&
        current.unknownExposureUsd === ZERO
          ? current.knownActualUsd
          : null,
    };
  }
  const endToEndKnownLowerBoundUsd = addUsd(
    ...Object.values(byRunKind).map((entry) => entry.knownActualUsd),
  );
  const endToEndActualCostUsd =
    unknownAttemptKinds.size > 0 ||
    accountRows.some((row) => row.unknown_exposure_usd !== ZERO)
      ? null
      : endToEndKnownLowerBoundUsd;

  const attemptLatencyByRole = Object.fromEntries(
    roles.map((role) => {
      const entriesForRole = roleEntries.get(role) ?? [];
      const values = entriesForRole.flatMap((entry) =>
        entry.attempt.elapsedMs === null ? [] : [entry.attempt.elapsedMs],
      );
      return [
        role,
        latencyStats(values, entriesForRole.length - values.length),
      ];
    }),
  ) as Record<RequestRole, LatencyStats>;
  const callLatencyByRole = Object.fromEntries(
    roles.map((role) => {
      const roleCalls = [...uniqueCalls.values()].filter(
        (call) => call.role === role,
      );
      const values: number[] = [];
      let missing = 0;
      for (const call of roleCalls) {
        if (
          call.state === "validated" ||
          call.state === "failed_known" ||
          call.state === "uncertain" ||
          call.state === "refused_unprocessed"
        ) {
          const elapsed =
            Date.parse(call.updatedAt) - Date.parse(call.createdAt);
          values.push(Math.max(0, elapsed));
        } else {
          missing += 1;
        }
      }
      return [role, latencyStats(values, missing)];
    }),
  ) as Record<RequestRole, LatencyStats>;

  const preparationTimes: number[] = [];
  const reviewTimes: number[] = [];
  const wallTimes: number[] = [];
  let missingPreparation = 0;
  let missingReview = 0;
  let missingWall = 0;
  for (const view of views) {
    const isStarted = view.stages.size > 0 || view.calls.length > 0;
    if (!isStarted) {
      continue;
    }
    const isTerminal = view.stages.has("terminal");
    const preparationStages: WorkflowStage[] = [
      "spec_ready",
      "formal_checked",
      "presentation_ready",
    ];
    if (
      preparationStages.every((stage) => view.stages.has(stage)) &&
      preparationStages.every(
        (stage) => view.stages.get(stage)?.elapsedMs !== null,
      )
    ) {
      preparationTimes.push(
        preparationStages.reduce(
          (sum, stage) => sum + (view.stages.get(stage)?.elapsedMs ?? 0),
          0,
        ),
      );
    } else {
      missingPreparation += 1;
    }
    const reviewStages: WorkflowStage[] = [
      "duplicate_checked",
      "blind_reviewed",
      "alignment_reviewed",
      "terminal",
    ];
    if (
      isTerminal &&
      reviewStages.every((stage) => view.stages.has(stage)) &&
      reviewStages.every(
        (stage) => view.stages.get(stage)?.elapsedMs !== null,
      )
    ) {
      reviewTimes.push(
        reviewStages.reduce(
          (sum, stage) => sum + (view.stages.get(stage)?.elapsedMs ?? 0),
          0,
        ),
      );
    } else {
      missingReview += 1;
    }
    const terminal = view.stages.get("terminal");
    const start = [...view.stages.values()]
      .map((stage) => Date.parse(stage.startedAt))
      .sort((left, right) => left - right)[0];
    if (
      isTerminal &&
      terminal?.finishedAt !== null &&
      terminal?.finishedAt !== undefined &&
      start !== undefined &&
      Number.isFinite(start)
    ) {
      wallTimes.push(Math.max(0, Date.parse(terminal.finishedAt) - start));
    } else {
      missingWall += 1;
    }
  }

  const byModality = tableFrom(
    views,
    ["text", "svg"],
    (view) => view.slot.modality,
  ) as Record<Modality, StratumMetrics>;
  const familyKeys = [...new Set(plan.slots.map((slot) => slot.family))].sort();
  const byFamily = tableFrom(
    views,
    familyKeys,
    (view) => view.slot.family,
  ) as Record<Family, StratumMetrics>;
  const byLane = tableFrom(
    views,
    ["spec_first", "ai_spec"],
    (view) => view.slot.lane,
  ) as Record<Lane, StratumMetrics>;
  const difficultyGroups = groupViews(views, (view) => String(view.slot.difficulty));
  const byDifficulty = Object.fromEntries(
    ([1, 2, 3, 4, 5] as const).map((difficulty) => [
      difficulty,
      stratumMetrics(difficultyGroups.get(String(difficulty)) ?? []),
    ]),
  ) as Record<Difficulty, StratumMetrics>;
  const familyByLaneTable = tableFrom(
    views,
    Object.keys(familyByLane),
    (view) => `${view.slot.family}/${view.slot.lane}`,
  );
  const modalityByDifficultyTable = tableFrom(
    views,
    Object.keys(modalityByDifficulty),
    (view) => `${view.slot.modality}/${view.slot.difficulty}`,
  );
  const familyByDifficultyTable = tableFrom(
    views,
    Object.keys(familyByDifficulty),
    (view) => `${view.slot.family}/${view.slot.difficulty}`,
  );

  const missingUsage = {
    totalAttempts: totalUsage.attempts,
    promptTokens: totalUsage.missingPromptTokens,
    completionTokens: totalUsage.missingCompletionTokens,
    totalTokens: totalUsage.missingTotalTokens,
    cachedReadTokens: totalUsage.missingCachedReadTokens,
    cachedWriteTokens: totalUsage.missingCachedWriteTokens,
    reasoningTokens: totalUsage.missingReasoningTokens,
    actualCost: totalUsage.missingActualCost,
  };

  return {
    version: METRICS_VERSION,
    run: {
      runId: run.runId,
      runKind: run.runKind,
      evidenceKind: run.evidenceKind,
      protocolVersion: run.protocolVersion,
      rootSeed: run.rootSeed,
      manifestHash: run.manifestHash,
      controlState: run.controlState,
      createdAt: run.createdAt,
      manifest: plan,
    },
    planned: {
      total: plan.slots.length,
      byModality: plannedByModality,
      byFamily: plannedByFamily,
      byLane: plannedByLane,
      byDifficulty: plannedByDifficulty,
      familyByLane,
      modalityByDifficulty,
      familyByDifficulty,
    },
    counts: {
      planned: plan.slots.length,
      started,
      terminal,
      fingerprintable,
      formalPassed,
      presentationCheckPassed,
      reviewed: blindReviewed,
      blindReviewed,
      alignmentReviewed,
      approved,
      rejected,
      inconclusive,
      generationError,
      paused: Math.max(0, started - terminal),
      unstarted: Math.max(0, plan.slots.length - started),
      infrastructureOnlyTerminal,
      terminalWithoutVerdict,
    },
    rates: {
      formalPassRate: ratio(formalPassed, plan.slots.length),
      preReviewPassRate: ratio(presentationCheckPassed, plan.slots.length),
      firstAttemptApprovalRate: ratio(approved, plan.slots.length),
      postReviewApprovalRate: ratio(approved, plan.slots.length),
      firstPassApprovalRate: ratio(approved, plan.slots.length),
      firstAttemptApprovalWilson95: wilson95(approved, plan.slots.length),
      secondaryApprovalRate: ratio(
        approved,
        plan.slots.length - infrastructureOnlyTerminal,
      ),
      secondaryDenominator: Math.max(
        0,
        plan.slots.length - infrastructureOnlyTerminal,
      ),
      secondaryProvisional: terminal < plan.slots.length,
      infrastructureOnlyExcluded: infrastructureOnlyTerminal,
      conditionalReviewAgreement: ratio(agreedBlind, parsedBlind),
      conditionalReviewDenominator: parsedBlind,
      reviewCoverage: ratio(parsedBlind, eligibleForReview),
      blindAmbiguityRate: ratio(ambiguousBlind, parsedBlind),
      blindAmbiguityDenominator: parsedBlind,
      blindAmbiguityPlannedCount: ambiguousBlind,
      structuralUniqueness: ratio(structures.size, fingerprintable),
      fingerprintCoverage: ratio(fingerprintable, plan.slots.length),
    },
    review: {
      eligibleForReview,
      blind: {
        total: blindReviewed,
        parsed: parsedBlind,
        agreed: agreedBlind,
        disagreed: blindByRole.blind_text.disagreed + blindByRole.blind_vision.disagreed,
        notApplicable:
          blindByRole.blind_text.notApplicable +
          blindByRole.blind_vision.notApplicable,
        ambiguous: ambiguousBlind,
        incomplete:
          blindByRole.blind_text.incomplete +
          blindByRole.blind_vision.incomplete,
        byRole: blindByRole,
      },
      alignment: {
        total: alignmentReviewed,
        parsed: parsedAlignment,
        pass: alignmentByRole.alignment_text.pass + alignmentByRole.alignment_vision.pass,
        fail: alignmentByRole.alignment_text.fail + alignmentByRole.alignment_vision.fail,
        uncertain:
          alignmentByRole.alignment_text.uncertain +
          alignmentByRole.alignment_vision.uncertain,
        incomplete:
          alignmentByRole.alignment_text.incomplete +
          alignmentByRole.alignment_vision.incomplete,
        byRole: alignmentByRole,
      },
    },
    uniqueness: {
      fingerprintable,
      distinctStructures: structures.size,
      structuralUniqueness: ratio(structures.size, fingerprintable),
      fingerprintCoverage: ratio(fingerprintable, plan.slots.length),
    },
    cost: {
      currency: "USD",
      calls: uniqueCalls.size,
      attempts: totalCost.attempts,
      startedCandidates: started,
      approved,
      knownActualUsd: totalCost.knownActualUsd,
      actualCostUsd: totalCost.actualCostUsd,
      costStatus:
        totalCost.attempts === 0
          ? "not_applicable"
          : totalCost.unknownAttempts > 0
            ? "unknown"
            : "known",
      unknownAttempts: totalCost.unknownAttempts,
      missingCostAttempts: totalCost.missingCostAttempts,
      averageCostPerAttemptUsd,
      averageCostPerApprovedUsd,
      knownCostPerApprovedUsd,
      reservedExposureUsd,
      unknownExposureUsd,
      exposurePerApprovedUsd,
      byRole: costByRole,
      generator,
      textReview,
      visionReview,
      endToEnd: {
        primaryMarginalUsd: totalCost.actualCostUsd,
        primaryMarginalKnownLowerBoundUsd: totalCost.knownActualUsd,
        byRunKind,
        endToEndKnownLowerBoundUsd,
        endToEndActualCostUsd,
      },
    },
    usage: {
      byRole: usageByRole,
      generator: generatorUsage,
      textReview: textReviewUsage,
      visionReview: visionReviewUsage,
    },
    latency: {
      attemptsByRole: attemptLatencyByRole,
      logicalCallsByRole: callLatencyByRole,
      candidatePreparation: latencyStats(preparationTimes, missingPreparation),
      candidateReview: latencyStats(reviewTimes, missingReview),
      candidateWall: latencyStats(wallTimes, missingWall),
    },
    failures: {
      codes: failureCounts,
      totalFailureRecords,
      multipleFailureCandidates,
      terminalWithoutFailure,
      note: "Failure-code frequencies aggregate terminal payload failures and non-terminal stage failure records; they may sum above the candidate count because one candidate can have multiple failures, and verdictHistogram is exclusive.",
      verdictHistogram,
    },
    nearDuplicateBlocked: {
      total: nearOverall.total,
      onlyNear: nearOverall.onlyNear,
      additionalQuality: nearOverall.additionalQuality,
      incompleteOrFailedReview: nearOverall.incompleteOrFailedReview,
      byFamily: nearByFamily,
      byLane: nearByLane,
      familyByLane: nearFamilyByLane,
    },
    tables: {
      byModality,
      byFamily,
      byLane,
      byDifficulty,
      familyByLane: familyByLaneTable,
      modalityByDifficulty: modalityByDifficultyTable,
      familyByDifficulty: familyByDifficultyTable,
    },
    notes: [
      "Planned denominators are fixed by the run manifest; failures and unstarted slots remain in the denominator.",
      "Difficulty is the requested generation setting, not validated human difficulty.",
      "The SVG ai_spec cells contain 6 planned slots in the full plan and are exploratory; do not claim causal model/lane superiority from unpaired small samples.",
      "Failure-code frequencies may sum above the candidate count because one candidate can have multiple failures; verdictHistogram is exclusive.",
      "Unknown money is null, never zero; known lower bounds and reserved exposure are reported separately.",
    ],
    missing: {
      usage: missingUsage,
      latency: {
        attemptEndTimes: entries.filter(
          (entry) => entry.attempt.finishedAt === null,
        ).length,
        callEndTimes: [...uniqueCalls.values()].filter(
          (call) =>
            call.state === "prepared" ||
            call.state === "dispatching" ||
            call.state === "response_saved",
        ).length,
        preparationTimes: missingPreparation,
        reviewTimes: missingReview,
        wallTimes: missingWall,
      },
      stages: {
        formal: plan.slots.length - formalPassed,
        presentation: plan.slots.length - presentationCheckPassed,
        blind: plan.slots.length - blindReviewed,
        alignment: plan.slots.length - alignmentReviewed,
        terminal: plan.slots.length - terminal,
      },
    },
  };
}
