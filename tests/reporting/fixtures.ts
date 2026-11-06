import type Database from "better-sqlite3";
import {
  admitRequest,
  createBudgetAccount,
  releaseReservation,
  settleReservation,
} from "../../src/ai/budget.js";
import {
  createAttempt,
  createLogicalCall,
  markAttemptDispatching,
  markAttemptRefusedUnprocessed,
  markAttemptUncertain,
  markAttemptValidated,
  saveAttemptResponse,
} from "../../src/ai/ledger.js";
import type { FailureRecord, WorkflowStage } from "../../src/domain/candidate.js";
import type { PlanManifest, SlotPlan } from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { insertStageResult, createRun } from "../../src/storage/repository.js";
import { storeArtifact } from "../../src/storage/artifacts.js";

export const FIXTURE_RUN_ID = "123e4567-e89b-42d3-a456-426614174100";
export const FIXTURE_ACCOUNT_ID = "p37-metrics-account";
export const FIXTURE_CREATED_AT = "2026-11-05T00:00:00.000Z";
const BASE = Date.parse(FIXTURE_CREATED_AT);

export interface SyntheticFixture {
  readonly runId: string;
  readonly accountId: string;
  readonly plan: PlanManifest;
}

function iso(offset: number): string {
  return new Date(BASE + offset).toISOString();
}

function slot(plan: PlanManifest, slotId: string): SlotPlan {
  const value = plan.slots.find((candidate) => candidate.slotId === slotId);
  if (value === undefined) {
    throw new Error(`fixture slot missing: ${slotId}`);
  }
  return value;
}

function formalPayload(
  planSlot: SlotPlan,
  structureHash: string,
  render: { svgHash: string | null; pngHash: string | null } = {
    svgHash: null,
    pngHash: null,
  },
): unknown {
  return {
    fingerprint: {
      version: 1,
      family: planSlot.family,
      modality: planSlot.modality,
      specHash: "1".repeat(64),
      structureHash,
      contentHash: null,
      renderHashes: { svg: render.svgHash, png: render.pngHash },
      canonicalStructure: null,
      features: [],
    },
    render: {
      rendererVersion: render.svgHash === null ? null : "test-renderer-v1",
      svgHash: render.svgHash,
      pngHash: render.pngHash,
      previewPngHash: null,
    },
    solveResult: {
      solutionCount: 1,
      answerCount: 1,
      enumeratedStates: 1,
      correctAnswer: { answer: "A" },
      proof: { facts: [] },
    },
    choices: {
      choices: [
        { label: "A", value: { answer: "A" } },
        { label: "B", value: { answer: "B" } },
        { label: "C", value: { answer: "C" } },
        { label: "D", value: { answer: "D" } },
      ],
      correctLabel: "A",
    },
  };
}

function presentationPayload(
  planSlot: SlotPlan,
  question: string,
  hint: string,
  render: { svgHash: string | null; pngHash: string | null } = {
    svgHash: null,
    pngHash: null,
  },
  hostile = false,
): unknown {
  return {
    presentation: {
      visible: {
        slotId: planSlot.slotId,
        family: planSlot.family,
        modality: planSlot.modality,
        question,
        rules: [
          hostile
            ? `</style><script>alert("rule")</script>`
            : "Fixture rule",
        ],
        options: [
          {
            label: "A",
            text: hostile
              ? `Option A "><img src=x onerror=alert(1)>`
              : "Option A",
          },
          { label: "B", text: "Option B" },
          { label: "C", text: "Option C" },
          { label: "D", text: "Option D" },
        ],
        assets: { svgHash: render.svgHash, pngHash: render.pngHash },
      },
      reveal: {
        correctLabel: "A",
        hint,
        explanationSteps: [
          hostile
            ? `</script><script>alert("explanation")</script>`
            : "Fixture explanation.",
        ],
        proof: hostile
          ? `</script>proof<script>alert(1)</script>`
          : "Fixture proof.",
      },
    },
  };
}

function duplicatePayload(planSlot: SlotPlan, outcome: "unique" | "near_suspected"): unknown {
  return {
    assessment: {
      slotId: planSlot.slotId,
      slotOrdinal: planSlot.slotOrdinal,
      family: planSlot.family,
      modality: planSlot.modality,
      lane: planSlot.lane,
      eligible: true,
      fingerprintable: true,
      groupOwner: false,
      outcome,
      ownerSlotId: null,
      duplicateKind: null,
      nearPairSlotIds:
        outcome === "near_suspected" ? ["text-matching-02"] : [],
      failureCodes:
        outcome === "near_suspected" ? ["NEAR_DUPLICATE_SUSPECTED"] : [],
      terminalVerdict: null,
      specHash: "1".repeat(64),
      structureHash: "fixture-structure",
      contentHash: "2".repeat(64),
      renderHashes: { svg: null, png: null },
      canonicalStructure: null,
      features: [],
    },
  };
}

function blindPayload(
  completed: boolean,
  agreement: "agreed" | "disagreed" | "not_applicable",
  ambiguity: "none" | "present" | "uncertain",
): unknown {
  return {
    version: 1,
    role: "blind_text",
    completed,
    choiceAgreement: agreement,
    review: completed
      ? {
          answerStatus: "selected",
          chosenOption: "A",
          clarity: "clear",
          ambiguity,
          issues: [],
          visualLegibility: "not_applicable",
        }
      : null,
  };
}

function alignmentPayload(completed: boolean, derivedOverall: "pass" | "fail" | "uncertain"): unknown {
  return {
    version: 1,
    role: "alignment_text",
    completed,
    derivedOverall,
  };
}

function failure(
  code: FailureRecord["code"],
  stage: WorkflowStage,
  source: FailureRecord["source"] = "deterministic",
): FailureRecord {
  return {
    code,
    stage,
    severity: "high",
    source,
    evidence: `fixture ${code}`,
  };
}

function terminalPayload(
  verdict: "approved" | "rejected" | "inconclusive" | "generation_error",
  failures: readonly FailureRecord[],
): unknown {
  return {
    version: 1,
    verdict,
    completion: "complete",
    proceed: verdict === "approved",
    primaryFailure: failures[0]?.code ?? null,
    businessBlockers: [],
    failures,
    rationale: "fixture",
    duplicateOutcome: "unique",
    duplicateOwnerSlotId: null,
  };
}

function insertStage(
  db: Database.Database,
  runId: string,
  slotId: string,
  stage: WorkflowStage,
  payload: unknown,
  startedOffset: number,
  elapsedMs: number,
  verdict?: "approved" | "rejected" | "inconclusive" | "generation_error",
  artifacts?: readonly {
    readonly kind: "svg" | "png";
    readonly mediaType: string;
    readonly bytes: Buffer;
    readonly role: string;
  }[],
): void {
  const startedAt = iso(startedOffset);
  const finishedAt = iso(startedOffset + elapsedMs);
  insertStageResult(db, {
    runId,
    slotId,
    stage,
    startedAt,
    finishedAt,
    elapsedMs,
    ...(verdict === undefined ? {} : { verdict }),
    payload,
    ...(artifacts === undefined ? {} : { artifacts }),
    createdAt: finishedAt,
  });
}

interface Usage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
  readonly cachedRead?: number;
  readonly cachedWrite?: number;
  readonly reasoning?: number;
}

function addCall(
  db: Database.Database,
  input: {
    readonly runId: string;
    readonly accountId: string;
    readonly slotId: string;
    readonly role: "spec" | "wording" | "blind_text" | "alignment_text";
    readonly state: "validated" | "uncertain";
    readonly createdOffset: number;
    readonly finishedOffset: number;
    readonly elapsedMs: number;
    readonly costUsd?: string;
    readonly usage?: Usage;
  },
): void {
  const call = createLogicalCall(db, {
    runId: input.runId,
    slotId: input.slotId,
    role: input.role,
    runKind: "smoke",
    requestBody: {
      model: "mock/model",
      role: input.role,
      messages: [{ role: "user", content: "=cmd fixture request" }],
    },
    expectedSchemaHash: "a".repeat(64),
    model: "mock/model",
    provider: "mock",
    createdAt: iso(input.createdOffset),
  });
  const attempt = createAttempt(db, {
    logicalCallId: call.logicalCallId,
    createdAt: iso(input.createdOffset),
  });
  const admission = admitRequest(db, {
    accountId: input.accountId,
    logicalCallId: call.logicalCallId,
    attemptId: attempt.attemptId,
    kind: "attempt",
    amountUsd: "0.01",
    nonBilling: false,
    createdAt: iso(input.createdOffset),
  });
  if (!admission.admitted) {
    throw new Error(`fixture admission failed: ${admission.reason}`);
  }
  markAttemptDispatching(db, attempt.attemptId, iso(input.createdOffset));
  if (input.state === "uncertain") {
    markAttemptUncertain(db, attempt.attemptId, "timeout", iso(input.finishedOffset));
    return;
  }
  const artifact = storeArtifact(
    db,
    {
      kind: "raw_response",
      mediaType: "application/json",
      bytes: Buffer.from(
        JSON.stringify({
          id: "fixture-response",
          role: input.role,
          content: "=cmd raw response",
        }),
      ),
      role: "raw_response",
    },
    iso(input.finishedOffset),
  );
  saveAttemptResponse(db, {
    attemptId: attempt.attemptId,
    finishedAt: iso(input.finishedOffset),
    elapsedMs: input.elapsedMs,
    httpStatus: 200,
    generationId: null,
    rawResponseArtifactId: artifact.artifactId,
    finishReason: "stop",
    promptTokens: input.usage?.prompt ?? null,
    completionTokens: input.usage?.completion ?? null,
    totalTokens: input.usage?.total ?? null,
    cachedReadTokens: input.usage?.cachedRead ?? null,
    cachedWriteTokens: input.usage?.cachedWrite ?? null,
    reasoningTokens: input.usage?.reasoning ?? null,
    actualCostUsd: input.costUsd ?? "0",
    errorClassification: null,
    partialCompletion: false,
    updatedAt: iso(input.finishedOffset),
  });
  settleReservation(db, {
    reservationId: admission.reservation.reservationId,
    actualCostUsd: input.costUsd ?? "0",
    createdAt: iso(input.finishedOffset),
  });
  markAttemptValidated(db, attempt.attemptId, iso(input.finishedOffset));
}

export function createSyntheticRun(
  db: Database.Database,
  options: {
    readonly includeVisual?: boolean;
    readonly hostileHtml?: boolean;
    readonly blindDisagreement?: boolean;
    readonly alignmentOutcome?: "pass" | "fail" | "uncertain";
    readonly evidenceKind?: "mock" | "live";
  } = {},
): SyntheticFixture {
  const plan = buildPlanManifest({ runKind: "smoke" });
  const runId = FIXTURE_RUN_ID;
  const accountId = FIXTURE_ACCOUNT_ID;
  createRun(db, {
    runId,
    plan,
    evidenceKind: options.evidenceKind ?? "mock",
    createdAt: FIXTURE_CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId,
    runId,
    runKind: "smoke",
    maxCostUsd: "10",
    createdAt: FIXTURE_CREATED_AT,
  });

  const a = slot(plan, "text-ranking-01");
  insertStage(db, runId, a.slotId, "spec_ready", { version: 1, spec: {} }, 0, 10);
  insertStage(
    db,
    runId,
    a.slotId,
    "formal_checked",
    formalPayload(a, "structure-a"),
    20,
    20,
  );
  insertStage(
    db,
    runId,
    a.slotId,
    "presentation_ready",
    presentationPayload(
      a,
      options.hostileHtml === true
        ? `</script><script>alert("question")</script><img src=x onerror="alert(1)">`
        : "=cmd|' /C calc'!A0",
      options.hostileHtml === true
        ? `" onmouseover="alert(1)" <svg onload=alert(1)>`
        : "  +SUM(1,1)",
      { svgHash: null, pngHash: null },
      options.hostileHtml === true,
    ),
    50,
    30,
  );
  insertStage(db, runId, a.slotId, "duplicate_checked", duplicatePayload(a, "unique"), 90, 5);
  insertStage(
    db,
    runId,
    a.slotId,
    "blind_reviewed",
    blindPayload(
      true,
      options.blindDisagreement === true ? "disagreed" : "agreed",
      "none",
    ),
    100,
    40,
  );
  insertStage(
    db,
    runId,
    a.slotId,
    "alignment_reviewed",
    alignmentPayload(true, options.alignmentOutcome ?? "pass"),
    150,
    50,
  );
  insertStage(db, runId, a.slotId, "terminal", terminalPayload("approved", []), 210, 5, "approved");
  addCall(db, {
    runId,
    accountId,
    slotId: a.slotId,
    role: "wording",
    state: "validated",
    createdOffset: 0,
    finishedOffset: 1000,
    elapsedMs: 100,
    costUsd: "0.001",
    usage: { prompt: 10, completion: 20, total: 30 },
  });
  addCall(db, {
    runId,
    accountId,
    slotId: a.slotId,
    role: "blind_text",
    state: "validated",
    createdOffset: 2000,
    finishedOffset: 2500,
    elapsedMs: 200,
    costUsd: "0.002",
    usage: { prompt: 5, completion: 5, total: 10 },
  });
  addCall(db, {
    runId,
    accountId,
    slotId: a.slotId,
    role: "alignment_text",
    state: "validated",
    createdOffset: 3000,
    finishedOffset: 3600,
    elapsedMs: 300,
    costUsd: "0.003",
    usage: { prompt: 6, completion: 6, total: 12 },
  });

  const b = slot(plan, "text-ranking-02");
  insertStage(db, runId, b.slotId, "spec_ready", { version: 1, spec: {} }, 1000, 10);
  insertStage(db, runId, b.slotId, "formal_checked", formalPayload(b, "structure-b"), 1020, 20);
  insertStage(
    db,
    runId,
    b.slotId,
    "terminal",
    terminalPayload("generation_error", [failure("API_ERROR", "spec_ready", "infrastructure")]),
    1050,
    5,
    "generation_error",
  );
  addCall(db, {
    runId,
    accountId,
    slotId: b.slotId,
    role: "spec",
    state: "uncertain",
    createdOffset: 6000,
    finishedOffset: 6500,
    elapsedMs: 500,
  });

  const c = slot(plan, "text-matching-01");
  insertStage(db, runId, c.slotId, "spec_ready", { version: 1, spec: {} }, 2000, 10);
  insertStage(db, runId, c.slotId, "formal_checked", formalPayload(c, "structure-c"), 2020, 20);
  insertStage(db, runId, c.slotId, "presentation_ready", presentationPayload(c, "Question C", "Hint C"), 2050, 30);
  insertStage(db, runId, c.slotId, "duplicate_checked", duplicatePayload(c, "near_suspected"), 2090, 5);
  insertStage(db, runId, c.slotId, "blind_reviewed", blindPayload(true, "agreed", "none"), 2100, 40);
  insertStage(db, runId, c.slotId, "alignment_reviewed", alignmentPayload(true, "pass"), 2150, 50);
  insertStage(
    db,
    runId,
    c.slotId,
    "terminal",
    terminalPayload("inconclusive", [failure("NEAR_DUPLICATE_SUSPECTED", "duplicate_checked")]),
    2210,
    5,
    "inconclusive",
  );
  addCall(db, {
    runId,
    accountId,
    slotId: c.slotId,
    role: "wording",
    state: "validated",
    createdOffset: 4000,
    finishedOffset: 4120,
    elapsedMs: 120,
    costUsd: "0.001",
    usage: { prompt: 10, completion: 20, total: 30 },
  });
  addCall(db, {
    runId,
    accountId,
    slotId: c.slotId,
    role: "blind_text",
    state: "validated",
    createdOffset: 4200,
    finishedOffset: 4420,
    elapsedMs: 220,
    costUsd: "0.002",
    usage: { prompt: 5, completion: 5, total: 10 },
  });
  addCall(db, {
    runId,
    accountId,
    slotId: c.slotId,
    role: "alignment_text",
    state: "validated",
    createdOffset: 4500,
    finishedOffset: 4820,
    elapsedMs: 320,
    costUsd: "0.003",
    usage: { prompt: 6, completion: 6, total: 12 },
  });

  const d = slot(plan, "text-scheduling-01");
  insertStage(db, runId, d.slotId, "spec_ready", { version: 1, spec: {} }, 3000, 10);
  insertStage(db, runId, d.slotId, "formal_checked", formalPayload(d, "structure-d"), 3020, 20);
  insertStage(db, runId, d.slotId, "presentation_ready", presentationPayload(d, "Question D", "Hint D"), 3050, 30);
  insertStage(db, runId, d.slotId, "duplicate_checked", duplicatePayload(d, "unique"), 3090, 5);
  insertStage(db, runId, d.slotId, "blind_reviewed", blindPayload(false, "not_applicable", "uncertain"), 3100, 40);
  insertStage(
    db,
    runId,
    d.slotId,
    "terminal",
    terminalPayload("inconclusive", [
      failure("API_ERROR", "blind_reviewed", "infrastructure"),
      failure("MISSING_REVIEW", "blind_reviewed"),
    ]),
    3150,
    5,
    "inconclusive",
  );
  addCall(db, {
    runId,
    accountId,
    slotId: d.slotId,
    role: "wording",
    state: "validated",
    createdOffset: 5000,
    finishedOffset: 5140,
    elapsedMs: 140,
    costUsd: "0.001",
    usage: { prompt: 8, completion: 8, total: 16 },
  });
  addCall(db, {
    runId,
    accountId,
    slotId: d.slotId,
    role: "blind_text",
    state: "uncertain",
    createdOffset: 5200,
    finishedOffset: 5600,
    elapsedMs: 400,
  });

  const e = slot(plan, "text-truth-01");
  insertStage(db, runId, e.slotId, "spec_ready", { version: 1, spec: {} }, 4000, 10);
  insertStage(db, runId, e.slotId, "formal_checked", formalPayload(e, "structure-e"), 4020, 20);
  insertStage(
    db,
    runId,
    e.slotId,
    "terminal",
    terminalPayload("rejected", [failure("UNSAT", "formal_checked")]),
    4050,
    5,
    "rejected",
  );

  if (options.includeVisual === true) {
    const f = slot(plan, "svg-matrix-01");
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg>',
      "utf8",
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const svgArtifact = storeArtifact(db, {
      kind: "svg",
      mediaType: "image/svg+xml",
      bytes: svg,
      role: "source_svg",
    });
    const pngArtifact = storeArtifact(db, {
      kind: "png",
      mediaType: "image/png",
      bytes: png,
      role: "full_png",
    });
    insertStage(db, runId, f.slotId, "spec_ready", { version: 1, spec: {} }, 7000, 10);
    insertStage(
      db,
      runId,
      f.slotId,
      "formal_checked",
      formalPayload(f, "structure-f", {
        svgHash: svgArtifact.contentHash,
        pngHash: pngArtifact.contentHash,
      }),
      7020,
      20,
      undefined,
      [
        {
          kind: "svg",
          mediaType: "image/svg+xml",
          bytes: svg,
          role: "source_svg",
        },
        {
          kind: "png",
          mediaType: "image/png",
          bytes: png,
          role: "full_png",
        },
      ],
    );
    insertStage(
      db,
      runId,
      f.slotId,
      "presentation_ready",
      presentationPayload(f, "Visual question", "Visual hint", {
        svgHash: svgArtifact.contentHash,
        pngHash: pngArtifact.contentHash,
      }),
      7050,
      30,
    );
    insertStage(db, runId, f.slotId, "duplicate_checked", duplicatePayload(f, "unique"), 7090, 5);
    insertStage(db, runId, f.slotId, "blind_reviewed", blindPayload(true, "agreed", "none"), 7100, 40);
    insertStage(db, runId, f.slotId, "alignment_reviewed", alignmentPayload(true, "pass"), 7150, 50);
    insertStage(
      db,
      runId,
      f.slotId,
      "terminal",
      terminalPayload("approved", []),
      7210,
      5,
      "approved",
    );
  }

  return { runId, accountId, plan };
}

export interface PartialFixture {
  readonly runId: string;
  readonly accountId: string;
}

export function createUnbilledOnlyRun(db: Database.Database): PartialFixture {
  const plan = buildPlanManifest({ runKind: "smoke" });
  const runId = "123e4567-e89b-42d3-a456-426614174102";
  const accountId = "p37-unbilled-account";
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
    maxCostUsd: "10",
    createdAt: FIXTURE_CREATED_AT,
  });
  const preparedSlot = slot(plan, "text-ranking-01");
  const preparedCall = createLogicalCall(db, {
    runId,
    slotId: preparedSlot.slotId,
    role: "spec",
    runKind: "smoke",
    requestBody: { model: "mock/model", messages: [] },
    expectedSchemaHash: "a".repeat(64),
    model: "mock/model",
    provider: "mock",
    createdAt: iso(0),
  });
  const preparedAttempt = createAttempt(db, {
    logicalCallId: preparedCall.logicalCallId,
    createdAt: iso(0),
  });
  admitRequest(db, {
    accountId,
    logicalCallId: preparedCall.logicalCallId,
    attemptId: preparedAttempt.attemptId,
    kind: "attempt",
    amountUsd: "0.01",
    nonBilling: false,
    createdAt: iso(0),
  });

  const refusedSlot = slot(plan, "text-ranking-02");
  const refusedCall = createLogicalCall(db, {
    runId,
    slotId: refusedSlot.slotId,
    role: "spec",
    runKind: "smoke",
    requestBody: { model: "mock/model", messages: [] },
    expectedSchemaHash: "a".repeat(64),
    model: "mock/model",
    provider: "mock",
    createdAt: iso(1000),
  });
  const refusedAttempt = createAttempt(db, {
    logicalCallId: refusedCall.logicalCallId,
    createdAt: iso(1000),
  });
  const admission = admitRequest(db, {
    accountId,
    logicalCallId: refusedCall.logicalCallId,
    attemptId: refusedAttempt.attemptId,
    kind: "attempt",
    amountUsd: "0.01",
    nonBilling: false,
    createdAt: iso(1000),
  });
  if (!admission.admitted) {
    throw new Error(`fixture refusal admission failed: ${admission.reason}`);
  }
  markAttemptDispatching(db, refusedAttempt.attemptId, iso(1000));
  const artifact = storeArtifact(
    db,
    {
      kind: "raw_response",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify({ error: { code: 429 } })),
      role: "raw_response",
    },
    iso(1100),
  );
  saveAttemptResponse(db, {
    attemptId: refusedAttempt.attemptId,
    finishedAt: iso(1100),
    elapsedMs: 100,
    httpStatus: 429,
    generationId: null,
    rawResponseArtifactId: artifact.artifactId,
    finishReason: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    reasoningTokens: null,
    actualCostUsd: null,
    errorClassification: "rate_limited",
    partialCompletion: false,
    updatedAt: iso(1100),
  });
  markAttemptRefusedUnprocessed(db, refusedAttempt.attemptId, iso(1100));
  releaseReservation(db, {
    reservationId: admission.reservation.reservationId,
    createdAt: iso(1100),
  });
  return { runId, accountId };
}

export function createPartialReviewFailureRun(
  db: Database.Database,
): PartialFixture {
  const plan = buildPlanManifest({ runKind: "smoke" });
  const runId = "123e4567-e89b-42d3-a456-426614174103";
  const accountId = "p37-partial-review-account";
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
    maxCostUsd: "10",
    createdAt: FIXTURE_CREATED_AT,
  });
  const planSlot = slot(plan, "text-ranking-01");
  insertStage(db, runId, planSlot.slotId, "spec_ready", { version: 1, spec: {} }, 0, 10);
  insertStage(
    db,
    runId,
    planSlot.slotId,
    "formal_checked",
    formalPayload(planSlot, "partial-structure"),
    20,
    20,
  );
  insertStage(
    db,
    runId,
    planSlot.slotId,
    "presentation_ready",
    presentationPayload(planSlot, "Partial question", "Partial hint"),
    50,
    30,
  );
  insertStage(
    db,
    runId,
    planSlot.slotId,
    "duplicate_checked",
    duplicatePayload(planSlot, "unique"),
    90,
    5,
  );
  insertStage(
    db,
    runId,
    planSlot.slotId,
    "blind_reviewed",
    {
      version: 1,
      role: "blind_text",
      completed: false,
      choiceAgreement: null,
      review: null,
      failure: {
        code: "API_ERROR",
        stage: "blind_reviewed",
        severity: "high",
        source: "infrastructure",
        evidence: "partial blind transport failure",
      },
    },
    100,
    40,
  );
  return { runId, accountId };
}
