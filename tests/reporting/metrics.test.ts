import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import {
  classifyNearDuplicateCategory,
  computeRunMetrics,
  mean,
  median,
  nearestRankP95,
  wilson95,
} from "../../src/reporting/metrics.js";
import type { FailureRecord } from "../../src/domain/candidate.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { createRun } from "../../src/storage/repository.js";
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_CREATED_AT,
  FIXTURE_RUN_ID,
  createPartialReviewFailureRun,
  createSyntheticRun,
  createUnbilledOnlyRun,
} from "./fixtures.js";

let tempDirectory: string;
let db: Database.Database;

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p37-metrics-"));
  db = openDatabase(join(tempDirectory, "metrics.sqlite"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("exact metrics", () => {
  it("computes planned-denominator, review, cost, usage, latency, failure, near, and table metrics", () => {
    createSyntheticRun(db);
    const metrics = computeRunMetrics(db, FIXTURE_RUN_ID);

    expect(metrics.version).toBe(1);
    expect(metrics.run.runId).toBe(FIXTURE_RUN_ID);
    expect(metrics.planned.total).toBe(20);
    expect(metrics.planned.byModality).toEqual({ text: 10, svg: 10 });
    expect(metrics.planned.byLane).toEqual({ spec_first: 10, ai_spec: 10 });
    expect(metrics.planned.byFamily.ranking).toBe(2);
    expect(metrics.planned.byDifficulty[1]).toBe(7);

    expect(metrics.counts).toMatchObject({
      planned: 20,
      started: 5,
      terminal: 5,
      fingerprintable: 5,
      formalPassed: 5,
      presentationCheckPassed: 3,
      reviewed: 3,
      blindReviewed: 3,
      alignmentReviewed: 2,
      approved: 1,
      rejected: 1,
      inconclusive: 2,
      generationError: 1,
      paused: 0,
      unstarted: 15,
      infrastructureOnlyTerminal: 2,
      terminalWithoutVerdict: 0,
    });

    expect(metrics.rates.formalPassRate).toBe(0.25);
    expect(metrics.rates.preReviewPassRate).toBe(0.15);
    expect(metrics.rates.firstAttemptApprovalRate).toBe(0.05);
    expect(metrics.rates.postReviewApprovalRate).toBe(0.05);
    expect(metrics.rates.firstPassApprovalRate).toBe(0.05);
    expect(metrics.rates.firstAttemptApprovalWilson95?.lower).toBeCloseTo(
      0.0089,
      3,
    );
    expect(metrics.rates.firstAttemptApprovalWilson95?.upper).toBeCloseTo(
      0.2361,
      3,
    );
    expect(metrics.rates.secondaryDenominator).toBe(18);
    expect(metrics.rates.infrastructureOnlyExcluded).toBe(2);
    expect(metrics.rates.secondaryApprovalRate).toBeCloseTo(1 / 18, 6);
    expect(metrics.rates.secondaryProvisional).toBe(true);
    expect(metrics.rates.conditionalReviewDenominator).toBe(2);
    expect(metrics.rates.conditionalReviewAgreement).toBe(1);
    expect(metrics.rates.reviewCoverage).toBeCloseTo(2 / 3, 6);
    expect(metrics.rates.blindAmbiguityDenominator).toBe(2);
    expect(metrics.rates.blindAmbiguityRate).toBe(0);
    expect(metrics.rates.blindAmbiguityPlannedCount).toBe(0);
    expect(metrics.rates.structuralUniqueness).toBe(1);
    expect(metrics.rates.fingerprintCoverage).toBe(0.25);

    expect(metrics.review.eligibleForReview).toBe(3);
    expect(metrics.review.blind).toMatchObject({
      total: 3,
      parsed: 2,
      agreed: 2,
      disagreed: 0,
      notApplicable: 0,
      ambiguous: 0,
      incomplete: 1,
    });
    expect(metrics.review.blind.byRole.blind_text).toMatchObject({
      total: 3,
      parsed: 2,
      agreed: 2,
      incomplete: 1,
    });
    expect(metrics.review.alignment).toMatchObject({
      total: 2,
      parsed: 2,
      pass: 2,
      fail: 0,
      uncertain: 0,
      incomplete: 0,
    });
    expect(metrics.review.alignment.byRole.alignment_text.pass).toBe(2);

    expect(metrics.uniqueness).toEqual({
      fingerprintable: 5,
      distinctStructures: 5,
      structuralUniqueness: 1,
      fingerprintCoverage: 0.25,
    });

    expect(metrics.cost.calls).toBe(9);
    expect(metrics.cost.attempts).toBe(9);
    expect(metrics.cost.startedCandidates).toBe(5);
    expect(metrics.cost.knownActualUsd).toBe("0.013");
    expect(metrics.cost.actualCostUsd).toBeNull();
    expect(metrics.cost.costStatus).toBe("unknown");
    expect(metrics.cost.unknownAttempts).toBe(2);
    expect(metrics.cost.averageCostPerAttemptUsd).toBeNull();
    expect(metrics.cost.averageCostPerApprovedUsd).toBeNull();
    expect(metrics.cost.knownCostPerApprovedUsd).toBe("0.013000");
    expect(metrics.cost.reservedExposureUsd).toBe("0.02");
    expect(metrics.cost.unknownExposureUsd).toBe("0");
    expect(metrics.cost.exposurePerApprovedUsd).toBe("0.020000");
    expect(metrics.cost.byRole.wording).toMatchObject({
      calls: 3,
      attempts: 3,
      knownActualUsd: "0.003",
      actualCostUsd: "0.003",
      averageActualCostUsd: "0.001000",
      unknownAttempts: 0,
    });
    expect(metrics.cost.byRole.blind_text).toMatchObject({
      calls: 3,
      attempts: 3,
      knownActualUsd: "0.004",
      actualCostUsd: null,
      unknownAttempts: 1,
    });
    expect(metrics.cost.byRole.alignment_text).toMatchObject({
      calls: 2,
      attempts: 2,
      knownActualUsd: "0.006",
      actualCostUsd: "0.006",
      averageActualCostUsd: "0.003000",
    });
    expect(metrics.cost.byRole.blind_vision).toMatchObject({
      calls: 0,
      attempts: 0,
      knownActualUsd: "0",
      actualCostUsd: null,
    });
    expect(metrics.cost.generator).toMatchObject({
      calls: 4,
      attempts: 4,
      knownActualUsd: "0.003",
      actualCostUsd: null,
      unknownAttempts: 1,
    });
    expect(metrics.cost.textReview.knownActualUsd).toBe("0.01");
    expect(metrics.cost.visionReview.attempts).toBe(0);
    expect(metrics.cost.endToEnd.primaryMarginalKnownLowerBoundUsd).toBe(
      "0.013",
    );
    expect(metrics.cost.endToEnd.primaryMarginalUsd).toBeNull();
    expect(metrics.cost.endToEnd.byRunKind.smoke).toMatchObject({
      knownActualUsd: "0.013",
      reservedUsd: "0.02",
      unknownExposureUsd: "0",
      actualCostUsd: null,
    });
    expect(metrics.cost.endToEnd.byRunKind.preflight.actualCostUsd).toBeNull();
    expect(metrics.cost.endToEnd.endToEndKnownLowerBoundUsd).toBe("0.013");
    expect(metrics.cost.endToEnd.endToEndActualCostUsd).toBeNull();

    expect(metrics.usage.byRole.wording).toMatchObject({
      calls: 3,
      attempts: 3,
      promptTokens: 28,
      completionTokens: 48,
      totalTokens: 76,
      missingPromptTokens: 0,
    });
    expect(metrics.usage.byRole.spec).toMatchObject({
      calls: 1,
      attempts: 1,
      promptTokens: null,
      missingPromptTokens: 1,
    });
    expect(metrics.usage.byRole.blind_text).toMatchObject({
      calls: 3,
      attempts: 3,
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      missingPromptTokens: 1,
    });
    expect(metrics.usage.generator.promptTokens).toBe(28);
    expect(metrics.usage.generator.missingPromptTokens).toBe(1);
    expect(metrics.usage.textReview.promptTokens).toBe(22);
    expect(metrics.usage.textReview.missingPromptTokens).toBe(1);
    expect(metrics.usage.visionReview.promptTokens).toBeNull();

    expect(metrics.latency.attemptsByRole.wording).toMatchObject({
      count: 3,
      meanMs: 120,
      medianMs: 120,
      p95Ms: 140,
      missing: 0,
    });
    expect(metrics.latency.attemptsByRole.blind_text).toMatchObject({
      count: 2,
      meanMs: 210,
      medianMs: 210,
      p95Ms: 220,
      missing: 1,
    });
    expect(metrics.latency.attemptsByRole.alignment_text).toMatchObject({
      count: 2,
      meanMs: 310,
      medianMs: 310,
      p95Ms: 320,
    });
    expect(metrics.latency.attemptsByRole.spec.count).toBe(0);
    expect(metrics.latency.attemptsByRole.spec.missing).toBe(1);
    expect(metrics.latency.logicalCallsByRole.wording.meanMs).toBe(420);
    expect(metrics.latency.logicalCallsByRole.wording.medianMs).toBe(140);
    expect(metrics.latency.logicalCallsByRole.wording.p95Ms).toBe(1000);
    expect(metrics.latency.logicalCallsByRole.blind_text.meanMs).toBeCloseTo(
      373.333,
      2,
    );
    expect(metrics.latency.candidatePreparation).toMatchObject({
      count: 3,
      meanMs: 60,
      medianMs: 60,
      p95Ms: 60,
      missing: 2,
    });
    expect(metrics.latency.candidateReview).toMatchObject({
      count: 2,
      meanMs: 100,
      medianMs: 100,
      p95Ms: 100,
      missing: 3,
    });
    expect(metrics.latency.candidateWall).toMatchObject({
      count: 5,
      meanMs: 139,
      medianMs: 155,
      p95Ms: 215,
      missing: 0,
    });

    expect(metrics.failures.codes).toEqual({
      API_ERROR: 2,
      MISSING_REVIEW: 1,
      NEAR_DUPLICATE_SUSPECTED: 1,
      UNSAT: 1,
    });
    expect(metrics.failures.totalFailureRecords).toBe(5);
    expect(metrics.failures.multipleFailureCandidates).toBe(1);
    expect(metrics.failures.terminalWithoutFailure).toBe(1);
    expect(metrics.failures.verdictHistogram).toEqual({
      approved: 1,
      rejected: 1,
      inconclusive: 2,
      generation_error: 1,
    });
    expect(metrics.failures.note).toContain("may sum above");
    expect(metrics.notes.join(" ")).toContain("exploratory");
    expect(metrics.notes.join(" ")).toContain("not validated human difficulty");
    expect(metrics.notes.join(" ")).toContain("Unknown money is null");

    expect(metrics.nearDuplicateBlocked).toMatchObject({
      total: 1,
      onlyNear: 1,
      additionalQuality: 0,
      incompleteOrFailedReview: 0,
    });
    expect(metrics.nearDuplicateBlocked.byFamily.matching.total).toBe(1);
    expect(metrics.nearDuplicateBlocked.byLane.spec_first.onlyNear).toBe(1);
    expect(
      metrics.nearDuplicateBlocked.familyByLane["matching/spec_first"]?.onlyNear,
    ).toBe(1);

    expect(metrics.tables.byModality.text).toMatchObject({
      planned: 10,
      started: 5,
      terminal: 5,
      approved: 1,
      rejected: 1,
      inconclusive: 2,
      generationError: 1,
      formalPassed: 5,
      presentationCheckPassed: 3,
      reviewed: 3,
      formalPassRate: 0.5,
      preReviewPassRate: 0.3,
      approvalRate: 0.1,
    });
    expect(metrics.tables.byModality.svg).toMatchObject({
      planned: 10,
      started: 0,
      terminal: 0,
      approved: 0,
      formalPassRate: 0,
      preReviewPassRate: 0,
      approvalRate: 0,
      structuralUniqueness: null,
      fingerprintCoverage: 0,
    });
    expect(metrics.tables.byFamily.ranking).toMatchObject({
      planned: 2,
      started: 2,
      terminal: 2,
      approved: 1,
      generationError: 1,
      formalPassRate: 1,
      preReviewPassRate: 0.5,
      approvalRate: 0.5,
    });
    expect(metrics.tables.byLane.spec_first).toMatchObject({
      planned: 10,
      started: 4,
      terminal: 4,
      approved: 1,
      rejected: 1,
      inconclusive: 2,
      generationError: 0,
      approvalRate: 0.1,
    });
    expect(metrics.tables.byLane.ai_spec).toMatchObject({
      planned: 10,
      started: 1,
      terminal: 1,
      approved: 0,
      generationError: 1,
      approvalRate: 0,
    });
    expect(metrics.tables.byDifficulty[1]).toMatchObject({
      planned: 7,
      started: 2,
      terminal: 2,
      approved: 1,
      rejected: 1,
      generationError: 0,
      formalPassed: 2,
      presentationCheckPassed: 1,
      reviewed: 1,
      formalPassRate: 2 / 7,
      preReviewPassRate: 1 / 7,
      approvalRate: 1 / 7,
    });
    expect(metrics.tables.familyByLane["ranking/spec_first"]).toMatchObject({
      planned: 1,
      started: 1,
      terminal: 1,
      approved: 1,
      approvalRate: 1,
    });
    expect(
      metrics.tables.familyByLane["ranking/ai_spec"],
    ).toMatchObject({
      planned: 1,
      started: 1,
      terminal: 1,
      approved: 0,
      generationError: 1,
    });
    expect(metrics.tables.modalityByDifficulty["text/1"]).toMatchObject({
      planned: 3,
      started: 2,
      terminal: 2,
      approved: 1,
      rejected: 1,
      approvalRate: 1 / 3,
    });
    expect(metrics.tables.familyByDifficulty["ranking/1"]).toMatchObject({
      planned: 1,
      started: 1,
      terminal: 1,
      approved: 1,
      approvalRate: 1,
    });
    expect(metrics.tables.familyByDifficulty["ranking/2"]).toMatchObject({
      planned: 1,
      started: 1,
      terminal: 1,
      approved: 0,
      generationError: 1,
      approvalRate: 0,
    });

    expect(metrics.missing.usage).toEqual({
      totalAttempts: 9,
      promptTokens: 2,
      completionTokens: 2,
      totalTokens: 2,
      cachedReadTokens: 9,
      cachedWriteTokens: 9,
      reasoningTokens: 9,
      actualCost: 2,
    });
    expect(metrics.missing.latency).toMatchObject({
      attemptEndTimes: 2,
      callEndTimes: 0,
      preparationTimes: 2,
      reviewTimes: 3,
      wallTimes: 0,
    });
    expect(metrics.missing.stages).toEqual({
      formal: 15,
      presentation: 17,
      blind: 17,
      alignment: 18,
      terminal: 15,
    });
  });

  it("returns null or finite values for a run with zero starts and approvals", () => {
    const runId = "123e4567-e89b-42d3-a456-426614174101";
    const accountId = "p37-zero-account";
    const plan = buildPlanManifest({ runKind: "smoke" });
    createRun(db, {
      runId,
      plan,
      evidenceKind: "mock",
      createdAt: FIXTURE_CREATED_AT,
    });
    createBudgetAccount(db, {
      accountId,
      runId,
      runKind: "smoke",
      maxCostUsd: "0",
      createdAt: FIXTURE_CREATED_AT,
    });
    const metrics = computeRunMetrics(db, runId);
    expect(metrics.counts).toMatchObject({
      planned: 20,
      started: 0,
      terminal: 0,
      approved: 0,
      unstarted: 20,
      paused: 0,
    });
    expect(metrics.rates.formalPassRate).toBe(0);
    expect(metrics.rates.preReviewPassRate).toBe(0);
    expect(metrics.rates.firstAttemptApprovalRate).toBe(0);
    expect(metrics.rates.secondaryDenominator).toBe(20);
    expect(metrics.rates.secondaryApprovalRate).toBe(0);
    expect(metrics.rates.secondaryProvisional).toBe(true);
    expect(metrics.rates.conditionalReviewAgreement).toBeNull();
    expect(metrics.rates.reviewCoverage).toBeNull();
    expect(metrics.rates.blindAmbiguityRate).toBeNull();
    expect(metrics.rates.structuralUniqueness).toBeNull();
    expect(metrics.rates.fingerprintCoverage).toBe(0);
    expect(metrics.cost.calls).toBe(0);
    expect(metrics.cost.attempts).toBe(0);
    expect(metrics.cost.actualCostUsd).toBeNull();
    expect(metrics.cost.costStatus).toBe("not_applicable");
    expect(metrics.cost.averageCostPerAttemptUsd).toBeNull();
    expect(metrics.cost.averageCostPerApprovedUsd).toBeNull();
    expect(metrics.cost.knownCostPerApprovedUsd).toBeNull();
    expect(metrics.cost.exposurePerApprovedUsd).toBeNull();
    expect(metrics.latency.attemptsByRole.spec.count).toBe(0);
    expect(metrics.latency.candidatePreparation.count).toBe(0);
    expect(metrics.latency.candidateReview.count).toBe(0);
    expect(metrics.latency.candidateWall.count).toBe(0);
    expect(metrics.failures.verdictHistogram).toEqual({
      approved: 0,
      rejected: 0,
      inconclusive: 0,
      generation_error: 0,
    });
    expect(metrics.nearDuplicateBlocked.total).toBe(0);
    expect(metrics.tables.byModality.text.planned).toBe(10);
    expect(metrics.tables.byModality.text.approvalRate).toBe(0);
    expect(metrics.tables.byModality.svg.approvalRate).toBe(0);
    for (const value of [
      metrics.rates.formalPassRate,
      metrics.rates.preReviewPassRate,
      metrics.rates.firstAttemptApprovalRate,
      metrics.rates.secondaryApprovalRate,
      metrics.rates.fingerprintCoverage,
    ]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it("computes Wilson intervals and quantiles with the documented rules", () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(1, 20)?.lower).toBeCloseTo(0.0089, 3);
    expect(wilson95(1, 20)?.upper).toBeCloseTo(0.2361, 3);
    expect(wilson95(0, 20)?.lower).toBe(0);
    expect(wilson95(0, 20)?.upper).toBeCloseTo(0.1611, 3);
    expect(wilson95(20, 20)?.lower).toBeCloseTo(0.8389, 3);
    expect(wilson95(20, 20)?.upper).toBe(1);
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 2, 3])).toBe(2);
    expect(nearestRankP95([1, 2, 3, 4, 5])).toBe(5);
    expect(
      nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1)),
    ).toBe(19);
  });

  it("keeps the fixture account available for export tests", () => {
    createSyntheticRun(db);
    expect(FIXTURE_ACCOUNT_ID).toBe("p37-metrics-account");
  });
});

describe("exact metrics edge cases", () => {
  it("classifies near-duplicate evidence without hiding completed-review quality findings", () => {
    const failure = (
      code: FailureRecord["code"],
      stage: FailureRecord["stage"],
      source: FailureRecord["source"] = "deterministic",
    ): FailureRecord => ({
      code,
      stage,
      severity: "high",
      source,
      evidence: "fixture",
    });
    const near = failure("NEAR_DUPLICATE_SUSPECTED", "duplicate_checked");
    expect(classifyNearDuplicateCategory([near])).toBe("onlyNear");
    expect(
      classifyNearDuplicateCategory([
        near,
        failure("REVIEWER_DISAGREES", "blind_reviewed"),
      ]),
    ).toBe("additionalQuality");
    expect(
      classifyNearDuplicateCategory([
        near,
        failure("TEXT_SPEC_MISMATCH", "alignment_reviewed"),
      ]),
    ).toBe("additionalQuality");
    expect(
      classifyNearDuplicateCategory([
        near,
        failure("MISSING_REVIEW", "blind_reviewed"),
      ]),
    ).toBe("incompleteOrFailedReview");
    expect(
      classifyNearDuplicateCategory([
        near,
        failure("API_ERROR", "blind_reviewed", "infrastructure"),
      ]),
    ).toBe("incompleteOrFailedReview");
    expect(
      classifyNearDuplicateCategory([
        near,
        failure("SCHEMA_INVALID", "alignment_reviewed", "model"),
      ]),
    ).toBe("incompleteOrFailedReview");
  });

  it("does not treat provably unbilled attempts as unknown money", () => {
    const { runId } = createUnbilledOnlyRun(db);
    const metrics = computeRunMetrics(db, runId);
    expect(metrics.counts).toMatchObject({
      planned: 20,
      started: 2,
      terminal: 0,
      paused: 2,
      unstarted: 18,
    });
    expect(metrics.cost).toMatchObject({
      calls: 2,
      attempts: 2,
      knownActualUsd: "0",
      actualCostUsd: "0",
      costStatus: "known",
      unknownAttempts: 0,
      missingCostAttempts: 0,
      averageCostPerAttemptUsd: "0.000000",
      averageCostPerApprovedUsd: null,
      reservedExposureUsd: "0.01",
      unknownExposureUsd: "0",
    });
    expect(metrics.cost.endToEnd.byRunKind.smoke).toMatchObject({
      knownActualUsd: "0",
      reservedUsd: "0.01",
      unknownExposureUsd: "0",
      actualCostUsd: "0",
    });
    expect(metrics.cost.endToEnd.endToEndActualCostUsd).toBe("0");
    expect(metrics.usage.byRole.spec.missingActualCost).toBe(0);
    expect(metrics.missing.usage.actualCost).toBe(0);
    expect(metrics.missing.latency).toMatchObject({
      preparationTimes: 2,
      reviewTimes: 2,
      wallTimes: 2,
      callEndTimes: 1,
    });
    expect(metrics.latency.candidatePreparation.count).toBe(0);
    expect(metrics.latency.candidateReview.count).toBe(0);
    expect(metrics.latency.candidateWall.count).toBe(0);
  });

  it("includes non-terminal review-stage failures in aggregates", () => {
    const { runId } = createPartialReviewFailureRun(db);
    const metrics = computeRunMetrics(db, runId);
    expect(metrics.counts).toMatchObject({
      planned: 20,
      started: 1,
      terminal: 0,
      paused: 1,
      unstarted: 19,
    });
    expect(metrics.failures.codes).toEqual({ API_ERROR: 1 });
    expect(metrics.failures.totalFailureRecords).toBe(1);
    expect(metrics.failures.terminalWithoutFailure).toBe(0);
    expect(metrics.failures.verdictHistogram).toEqual({
      approved: 0,
      rejected: 0,
      inconclusive: 0,
      generation_error: 0,
    });
    expect(metrics.latency.candidatePreparation).toMatchObject({
      count: 1,
      meanMs: 60,
      missing: 0,
    });
    expect(metrics.latency.candidateReview).toMatchObject({
      count: 0,
      missing: 1,
    });
    expect(metrics.latency.candidateWall).toMatchObject({
      count: 0,
      missing: 1,
    });
    expect(metrics.missing.latency).toMatchObject({
      preparationTimes: 0,
      reviewTimes: 1,
      wallTimes: 1,
    });
    expect(metrics.review.blind).toMatchObject({
      total: 1,
      parsed: 0,
      incomplete: 1,
    });
    expect(metrics.review.eligibleForReview).toBe(1);
    expect(metrics.rates.reviewCoverage).toBe(0);
    expect(metrics.nearDuplicateBlocked.total).toBe(0);
    expect(metrics.cost.costStatus).toBe("not_applicable");
    expect(metrics.cost.actualCostUsd).toBeNull();
  });
});


describe("provider identity diagnostics", () => {
  it("reports observed provider/model mix and missing identity coverage", () => {
    createSyntheticRun(db);
    const missing = computeRunMetrics(db, FIXTURE_RUN_ID);
    expect(missing.providerMix.totalAttempts).toBe(missing.cost.attempts);
    expect(missing.providerMix.totalAttempts).toBeGreaterThan(0);
    expect(missing.providerMix.identityAttempts).toBe(0);
    expect(missing.providerMix.missingIdentityAttempts).toBe(
      missing.providerMix.totalAttempts,
    );
    expect(missing.providerMix.identityCoverage).toBe(0);
    expect(
      missing.providerMix.byRole.spec.observedProviders.unknown,
    ).toBeGreaterThan(0);

    const attempt = db
      .prepare(
        "SELECT attempt_id FROM request_attempts ORDER BY attempt_id LIMIT 1",
      )
      .get() as { attempt_id: string };
    db.prepare(
      "UPDATE request_attempts SET observed_model = ?, observed_provider = ? WHERE attempt_id = ?",
    ).run("observed/model", "observed-provider", attempt.attempt_id);
    const observed = computeRunMetrics(db, FIXTURE_RUN_ID);
    expect(observed.providerMix.identityAttempts).toBe(1);
    expect(observed.providerMix.missingIdentityAttempts).toBe(
      observed.providerMix.totalAttempts - 1,
    );
    expect(observed.providerMix.identityCoverage).toBeCloseTo(
      1 / observed.providerMix.totalAttempts,
      6,
    );
    const byRole = Object.values(observed.providerMix.byRole).find(
      (role) => role.observedProviders["observed-provider"] === 1,
    );
    expect(byRole?.observedModels["observed/model"]).toBe(1);
  });
});
