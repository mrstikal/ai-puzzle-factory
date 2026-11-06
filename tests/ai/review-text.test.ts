import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import {
  getLogicalCall,
  listAttempts,
  listRequestEvents,
} from "../../src/ai/ledger.js";
import { createOpenRouterTransport } from "../../src/ai/openrouter.js";
import type { ResolvedRoute } from "../../src/ai/preflight.js";
import {
  BLIND_REVIEW_JSON_SCHEMA,
  strictSchemaHash,
} from "../../src/ai/schemas.js";
import {
  ReviewTextError,
  blindTextPromptMetadata,
  buildBlindTextMessages,
  reviewText,
  type BlindTextPublicPayload,
} from "../../src/ai/review-text.js";
import type { AssembledPresentation } from "../../src/domain/presentation.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { assemblePresentation } from "../../src/presentation/assemble.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getSlot,
  insertStageResult,
} from "../../src/storage/repository.js";
import {
  createFakeOpenRouter,
  type FakeOpenRouter,
} from "../helpers/fake-openrouter.js";
import { allowLocalFake } from "../setup.js";
import { hashCanonicalJson, sha256Hex } from "../../src/util/hash.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174002";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p28-test-secret-do-not-persist";
const TEXT_SLOTS = SMOKE_PLAN.slots.filter((slot) => slot.modality === "text");

let tempDirectory: string;
let db: Database.Database;
let fake: FakeOpenRouter;
let transport: ReturnType<typeof createOpenRouterTransport>;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function testSeed(label: string): string {
  return sha256Hex(`p28-test:${label}`);
}

function blindTextRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    role: "blind_text",
    model: "test/model",
    routingPolicy: "balanced",
    compatibleEndpointTags: ["test-provider"],
    compatibleProviderNames: ["Test Provider"],
    outputCapField: "max_tokens",
    maxOutputTokens: 4096,
    minPromptTokens: 16_384,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: { prompt: "0.000001", completion: "0.000002" },
    requiresImage: false,
    imageInputDeclared: false,
    visionProbeRequired: false,
    responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    schemaHash: strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA),
    settings: {},
    ...overrides,
  };
}

interface PresentationFixture {
  readonly slot: (typeof SMOKE_PLAN.slots)[number];
  readonly assembled: AssembledPresentation;
  readonly correctLabel: string;
}

function insertPresentationReady(
  slot: (typeof SMOKE_PLAN.slots)[number],
  presentation?: unknown,
): PresentationFixture {
  const engine = productionRegistry.getEngine(slot.family);
  const seed = testSeed(`slot:${slot.slotId}`);
  const spec = engine.generateSpec(seed, slot.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`expected a unique ${slot.family} answer`);
  }
  const choices = engine.makeOptions(spec, solve.correctAnswer, seed);
  const wording = makeFixtureWording(engine, spec);
  const assets =
    engine.modality === "svg"
      ? {
          svgHash: sha256Hex(`p28-svg:${slot.slotId}`),
          pngHash: sha256Hex(`p28-png:${slot.slotId}`),
        }
      : undefined;
  const assembled = assemblePresentation({
    slotId: slot.slotId,
    engine,
    spec,
    solveResult: solve,
    choices,
    wording,
    ...(assets === undefined ? {} : { assets }),
  });
  insertStageResult(db, {
    runId: RUN_ID,
    slotId: slot.slotId,
    stage: "presentation_ready",
    startedAt: CREATED_AT,
    finishedAt: CREATED_AT,
    elapsedMs: 0,
    payload: {
      family: slot.family,
      modality: slot.modality,
      difficulty: slot.difficulty,
      wording,
      presentation: presentation ?? assembled,
      proposal: {},
    },
  });
  return { slot, assembled, correctLabel: choices.correctLabel };
}

function validReview(): Record<string, unknown> {
  return {
    answerStatus: "selected",
    chosenOption: "A",
    reasoning: "The public clues force option A.",
    clarity: "clear",
    ambiguity: "none",
    confidence: 0.8,
    visualLegibility: "not_applicable",
    issues: [],
  };
}

function callReview(
  fixture: PresentationFixture,
  overrides: Partial<Parameters<typeof reviewText>[0]> = {},
) {
  return reviewText({
    db,
    accountId: "test-account",
    apiKey: API_KEY,
    transport,
    runId: RUN_ID,
    slotId: fixture.slot.slotId,
    route: blindTextRoute(),
    reservationUsd: "0.01",
    clock,
    ...overrides,
  });
}

function successBody(content: unknown): Record<string, unknown> {
  return {
    id: "gen-p28",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
    },
  };
}

function failureBody(
  finishReason: string,
  content: string | null,
  refusal: string | null = null,
): Record<string, unknown> {
  return {
    id: "gen-p28-failure",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      cost: 0.001,
    },
  };
}

function expectedPayload(assembled: AssembledPresentation): BlindTextPublicPayload {
  return {
    question: assembled.visible.question,
    rules: assembled.visible.rules,
    clues: assembled.visible.clues.map((clue) => clue.text),
    options: assembled.visible.options.map((option) => ({
      label: option.label,
      text: option.text,
    })),
  };
}

function capturedPayload(
  requestBody: Record<string, unknown>,
): BlindTextPublicPayload {
  const messages = requestBody.messages as Array<{ content: string }>;
  const content = messages[1]?.content ?? "";
  const marker = "Public puzzle:\n";
  const start = content.indexOf(marker);
  const end = content.indexOf("\n\nReturn exactly");
  if (start < 0 || end < 0) {
    throw new Error("captured request has no public puzzle payload");
  }
  return JSON.parse(content.slice(start + marker.length, end)) as BlindTextPublicPayload;
}

async function expectReviewError(
  action: Promise<unknown>,
  code: string,
): Promise<ReviewTextError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewTextError);
    const reviewError = error as ReviewTextError;
    expect(reviewError.code).toBe(code);
    return reviewError;
  }
  throw new Error(`expected ReviewTextError ${code}`);
}

function asRequestBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("logical call has no request body");
  }
  return value as Record<string, unknown>;
}

function rawArtifactBytes(artifactId: number): Buffer {
  const row = db
    .prepare("SELECT bytes FROM artifacts WHERE artifact_id = ?")
    .get(artifactId) as { bytes: Buffer } | undefined;
  if (row === undefined) {
    throw new Error(`missing raw artifact ${artifactId}`);
  }
  return row.bytes;
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p28-"));
  db = openDatabase(join(tempDirectory, "experiment.sqlite"));
  migrate(db);
  createRun(db, {
    runId: RUN_ID,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId: "test-account",
    runId: RUN_ID,
    runKind: "smoke",
    maxCostUsd: "10",
    createdAt: CREATED_AT,
  });
  fake = await createFakeOpenRouter();
  allowLocalFake(fake.baseUrl);
  transport = createOpenRouterTransport({
    baseUrl: fake.baseUrl,
    clock,
    random: () => 0,
  });
});

afterEach(async () => {
  await fake.close();
  try {
    db.close();
  } catch {
    // The test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("blind text reviewer", () => {
  it("reviews every text family and lane with only the public allowlist", async () => {
    for (const slot of TEXT_SLOTS) {
      const fixture = insertPresentationReady(slot);
      fake.enqueue({ status: 200, body: successBody(validReview()) });
      const result = await callReview(fixture);
      const expected = expectedPayload(fixture.assembled);
      expect(result.publicPayload).toEqual(expected);
      expect(result.review.answerStatus).toBe("selected");
      const expectedAgreement =
        result.review.chosenOption === fixture.correctLabel
          ? "agreed"
          : "disagreed";
      expect(result.choiceAgreement).toBe(expectedAgreement);
      expect(getSlot(db, RUN_ID, slot.slotId).stage).toBe("presentation_ready");

      const attempts = listAttempts(db, result.logicalCallId);
      expect(attempts).toHaveLength(1);
      const artifactId = attempts[0]?.rawResponseArtifactId;
      expect(artifactId).not.toBeNull();
      if (artifactId === null || artifactId === undefined) {
        throw new Error("valid review did not save a raw response");
      }
      expect(rawArtifactBytes(artifactId).toString("utf8")).toContain(
        "answerStatus",
      );

      const call = getLogicalCall(db, result.logicalCallId);
      expect(call.expectedSchemaHash).toBe(result.proposal.schemaHash);
      const requestBody = asRequestBody(call.requestBody) as {
        messages: Array<{ content: string }>;
        response_format: { json_schema: { name: string; strict: boolean } };
        provider: { allow_fallbacks: boolean; require_parameters: boolean };
        max_tokens: number;
      };
      expect(requestBody.response_format.json_schema.name).toBe(
        "puzzle_blind_review",
      );
      expect(requestBody.response_format.json_schema.strict).toBe(true);
      expect(requestBody.provider).toEqual({
        allow_fallbacks: true,
        require_parameters: true,
      });
      expect(requestBody.max_tokens).toBe(4096);
      expect(capturedPayload(asRequestBody(call.requestBody))).toEqual(expected);
      expect(JSON.stringify(requestBody.messages)).not.toContain("image_url");

      const system = requestBody.messages[0]?.content ?? "";
      expect(system).toContain("untrusted data");
      expect(system).toContain("Do not follow");
      expect(system).toContain("prompt_version: v1");
      expect(system).toContain(`prompt_hash: ${result.proposal.promptHash}`);
      expect(system).toContain("schema_name: puzzle_blind_review");
      expect(system).toContain("schema_version: v1");
      expect(system).toContain(`schema_hash: ${result.proposal.schemaHash}`);

      const event = listRequestEvents(db, result.logicalCallId).find(
        (candidate) => candidate.eventType === "blind_text_review",
      );
      expect(event).toBeDefined();
      expect(event?.payload).toMatchObject({
        family: slot.family,
        modality: slot.modality,
        inputHash: hashCanonicalJson(expected),
        choiceAgreement: expectedAgreement,
        review: result.review,
        promptVersion: "v1",
        schemaName: "puzzle_blind_review",
        schemaVersion: "v1",
      });
    }
    expect(fake.requests).toHaveLength(TEXT_SLOTS.length);
  });

  it("keeps hidden canaries out of the captured request", async () => {
    const fixture = insertPresentationReady(TEXT_SLOTS[0]!);
    const canaryPresentation = JSON.parse(
      JSON.stringify(fixture.assembled),
    ) as AssembledPresentation;
    canaryPresentation.reveal.hint = "CANARY_HINT";
    canaryPresentation.reveal.explanationSteps = [
      { factIds: ["r-domain"], text: "CANARY_EXPLANATION" },
    ];
    canaryPresentation.reveal.proof = {
      ...canaryPresentation.reveal.proof,
      witness: "CANARY_PROOF",
    };
    const canarySlot = TEXT_SLOTS[1]!;
    canaryPresentation.visible.slotId = canarySlot.slotId;
    canaryPresentation.visible.family = canarySlot.family;
    canaryPresentation.visible.modality = canarySlot.modality;
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: canarySlot.slotId,
      stage: "presentation_ready",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      elapsedMs: 0,
      payload: {
        presentation: canaryPresentation,
        wording: {
          source: "model",
          response: {
            question: "CANARY_WORDING_QUESTION",
            clueTexts: [],
            hint: "CANARY_WORDING_HINT",
            explanationSteps: [],
          },
        },
        lane: "CANARY_LANE",
        spec: "CANARY_SPEC",
        key: "CANARY_KEY",
        previousReview: "CANARY_PREVIOUS",
      },
    });

    fake.enqueue({ status: 200, body: successBody(validReview()) });
    const result = await callReview({ ...fixture, slot: canarySlot });
    const requestBody = asRequestBody(
      getLogicalCall(db, result.logicalCallId).requestBody,
    );
    const payload = capturedPayload(requestBody);
    expect(payload).toEqual(expectedPayload(fixture.assembled));
    expect(Object.keys(payload).sort()).toEqual([
      "clues",
      "options",
      "question",
      "rules",
    ]);
    const serialized = JSON.stringify(requestBody);
    for (const canary of [
      "CANARY_HINT",
      "CANARY_EXPLANATION",
      "CANARY_PROOF",
      "CANARY_WORDING_HINT",
      "CANARY_LANE",
      "CANARY_SPEC",
      "CANARY_KEY",
      "CANARY_PREVIOUS",
      canarySlot.slotId,
      canaryPresentation.visible.slotId,
    ]) {
      expect(serialized).not.toContain(canary);
    }
    const firstFactId = fixture.assembled.visible.clues[0]?.factId;
    if (firstFactId !== undefined) {
      expect(serialized).not.toContain(firstFactId);
    }
    expect(fake.requests).toHaveLength(1);
  });

  it("handles every answer-status/null relation, wrong choices, and uncertainty", async () => {
    const cases: Array<{
      readonly review: Record<string, unknown>;
      readonly valid: boolean;
    }> = [
      { review: validReview(), valid: true },
      {
        review: { ...validReview(), chosenOption: "B" },
        valid: true,
      },
      {
        review: { ...validReview(), chosenOption: null },
        valid: false,
      },
      {
        review: {
          ...validReview(),
          answerStatus: "no_unique_answer",
          chosenOption: null,
        },
        valid: true,
      },
      {
        review: {
          ...validReview(),
          answerStatus: "no_unique_answer",
          chosenOption: "A",
        },
        valid: false,
      },
      {
        review: {
          ...validReview(),
          answerStatus: "cannot_determine",
          chosenOption: null,
        },
        valid: true,
      },
      {
        review: {
          ...validReview(),
          answerStatus: "cannot_determine",
          chosenOption: "C",
        },
        valid: false,
      },
      {
        review: {
          ...validReview(),
          clarity: "unclear",
          ambiguity: "uncertain",
          confidence: 0.2,
        },
        valid: true,
      },
      {
        review: { ...validReview(), visualLegibility: "legible" },
        valid: false,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const slot = TEXT_SLOTS[index];
      if (slot === undefined) {
        throw new Error("not enough text slots for status cases");
      }
      const fixture = insertPresentationReady(slot);
      fake.enqueue({ status: 200, body: successBody(testCase.review) });
      if (testCase.valid) {
        const result = await callReview(fixture);
        expect(result.review.answerStatus).toBe(testCase.review.answerStatus);
        if (testCase.review.answerStatus === "selected") {
          expect(result.review.chosenOption).not.toBeNull();
          const expectedAgreement =
            result.review.chosenOption === fixture.correctLabel
              ? "agreed"
              : "disagreed";
          expect(result.choiceAgreement).toBe(expectedAgreement);
        } else {
          expect(result.choiceAgreement).toBe("not_applicable");
        }
      } else {
        const error = await expectReviewError(
          callReview(fixture),
          "INVALID_REVIEW",
        );
        expect(error.issues.length).toBeGreaterThan(0);
        expect(error.logicalCallId).not.toBeNull();
      }
      expect(getSlot(db, RUN_ID, slot.slotId).stage).toBe("presentation_ready");
    }
    expect(fake.requests).toHaveLength(cases.length);
  });

  it("retains refusal and invalid JSON without a stage or content retry", async () => {
    const refusalSlot = TEXT_SLOTS[0]!;
    const refusalFixture = insertPresentationReady(refusalSlot);
    fake.enqueue({
      status: 200,
      body: failureBody("content_filter", null, "I cannot comply."),
    });
    const refusal = await expectReviewError(
      callReview(refusalFixture),
      "TRANSPORT_FAILED",
    );
    expect(refusal.logicalCallId).not.toBeNull();
    if (refusal.logicalCallId === null) {
      throw new Error("refusal did not expose a logical call");
    }
    const refusalAttempts = listAttempts(db, refusal.logicalCallId);
    expect(refusalAttempts).toHaveLength(1);
    const refusalArtifact = refusalAttempts[0]?.rawResponseArtifactId;
    expect(refusalArtifact).not.toBeNull();
    if (refusalArtifact === null || refusalArtifact === undefined) {
      throw new Error("refusal did not save a raw response");
    }
    expect(rawArtifactBytes(refusalArtifact).toString("utf8")).toContain(
      "I cannot comply",
    );
    expect(refusalAttempts[0]?.actualCostUsd).toBe("0.001");
    expect(getSlot(db, RUN_ID, refusalSlot.slotId).stage).toBe(
      "presentation_ready",
    );

    const invalidJsonSlot = TEXT_SLOTS[1]!;
    const invalidJsonFixture = insertPresentationReady(invalidJsonSlot);
    fake.enqueue({
      status: 200,
      body: failureBody("stop", "not json"),
    });
    const invalidJson = await expectReviewError(
      callReview(invalidJsonFixture),
      "TRANSPORT_FAILED",
    );
    expect(invalidJson.logicalCallId).not.toBeNull();
    expect(getSlot(db, RUN_ID, invalidJsonSlot.slotId).stage).toBe(
      "presentation_ready",
    );
    expect(fake.requests).toHaveLength(2);
  });

  it("does not retry a disagreement or compare the choice with the key", async () => {
    const fixture = insertPresentationReady(TEXT_SLOTS[0]!);
    const wrong = {
      ...validReview(),
      chosenOption: fixture.correctLabel === "A" ? "B" : "A",
    };
    fake.enqueue({ status: 200, body: successBody(wrong) });
    const result = await callReview(fixture);
    expect(result.review.chosenOption).not.toBe(fixture.correctLabel);
    expect(result.choiceAgreement).toBe("disagreed");
    expect(fake.requests).toHaveLength(1);
    expect(getSlot(db, RUN_ID, fixture.slot.slotId).stage).toBe(
      "presentation_ready",
    );
  });

  it("accepts a slot advanced to duplicate_checked and rejects a mismatched stored slot", async () => {
    const advanced = insertPresentationReady(TEXT_SLOTS[0]!);
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: advanced.slot.slotId,
      stage: "duplicate_checked",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      elapsedMs: 0,
      payload: {},
    });
    fake.enqueue({ status: 200, body: successBody(validReview()) });
    const result = await callReview(advanced);
    expect(result.review.answerStatus).toBe("selected");
    expect(getSlot(db, RUN_ID, advanced.slot.slotId).stage).toBe(
      "duplicate_checked",
    );
    expect(fake.requests).toHaveLength(1);

    const base = insertPresentationReady(TEXT_SLOTS[2]!);
    const otherSlot = TEXT_SLOTS[3]!;
    insertPresentationReady(otherSlot, base.assembled);
    const mismatch = await expectReviewError(
      callReview({ ...base, slot: otherSlot }),
      "INVALID_STAGE",
    );
    expect(mismatch.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(1);
  });

  it("rejects non-blind-text routes, SVG slots, and non-presentation stages before a request", async () => {
    const fixture = insertPresentationReady(TEXT_SLOTS[0]!);
    const wrongRole = await expectReviewError(
      callReview(fixture, { route: blindTextRoute({ role: "wording" }) }),
      "ROUTE_ROLE_MISMATCH",
    );
    expect(wrongRole.logicalCallId).toBeNull();

    const imageRoute = await expectReviewError(
      callReview(fixture, { route: blindTextRoute({ requiresImage: true }) }),
      "INVALID_INPUT",
    );
    expect(imageRoute.logicalCallId).toBeNull();

    const svgSlot = SMOKE_PLAN.slots.find((slot) => slot.modality === "svg");
    if (svgSlot === undefined) {
      throw new Error("smoke plan has no SVG slot");
    }
    const svgFixture = insertPresentationReady(svgSlot);
    const svgError = await expectReviewError(
      callReview({ ...svgFixture, slot: svgSlot }),
      "INVALID_INPUT",
    );
    expect(svgError.logicalCallId).toBeNull();

    const plannedSlot = TEXT_SLOTS[2]!;
    const plannedError = await expectReviewError(
      callReview({ slot: plannedSlot, assembled: fixture.assembled, correctLabel: "A" }),
      "INVALID_STAGE",
    );
    expect(plannedError.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps prompt metadata stable and versioned", () => {
    const first = blindTextPromptMetadata();
    const second = blindTextPromptMetadata();
    expect(first).toEqual(second);
    expect(first.promptVersion).toBe("v1");
    expect(first.schemaVersion).toBe("v1");
    expect(first.schemaName).toBe("puzzle_blind_review");
    expect(first.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.schemaHash).toBe(strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA));

    const messages = buildBlindTextMessages(
      {
        question: "Question?",
        rules: {
          domain: "domain",
          closedWorld: "closed",
          target: "target",
          operations: ["op"],
          conventions: [],
        },
        clues: ["clue"],
        options: [
          { label: "A", text: "a" },
          { label: "B", text: "b" },
          { label: "C", text: "c" },
          { label: "D", text: "d" },
        ],
      },
      first,
    );
    expect(messages[0]?.content).toContain("prompt_version: v1");
    expect(messages[1]?.content).toContain("Public puzzle");
  });
});
