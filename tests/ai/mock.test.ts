import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import { buildChatRequest } from "../../src/ai/config.js";
import type { ResolvedRoute } from "../../src/ai/preflight.js";
import { getLogicalCall, createLogicalCall } from "../../src/ai/ledger.js";
import { reviewText } from "../../src/ai/review-text.js";
import {
  MOCK_SCENARIO_KINDS,
  MockTransportError,
  buildMockContent,
  createMockTransport,
  mockScenarioForFamily,
  type MockTransport,
} from "../../src/ai/mock.js";
import {
  OpenRouterError,
  createOpenRouterTransport,
  type OpenRouterTransportOptions,
} from "../../src/ai/openrouter.js";
import {
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  BLIND_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
  FAMILY_SPEC_JSON_SCHEMAS,
} from "../../src/ai/schemas.js";
import {
  FamilySpecEnvelopeSchema,
} from "../../src/domain/spec.js";
import { WordingResponseSchema } from "../../src/domain/presentation.js";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
  type RequestRole,
} from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { assemblePresentation } from "../../src/presentation/assemble.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { createRun, getSlot, insertStageResult } from "../../src/storage/repository.js";
import { hashCanonicalJson, sha256Hex } from "../../src/util/hash.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174005";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const MOCK_API_KEY = "mock-test-key-do-not-persist";
let tempDirectory: string;
let db: Database.Database;
let mock: MockTransport;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function seedFor(label: string): string {
  return sha256Hex(`p32-test:${label}`);
}

function slotForCall(call: ReturnType<typeof createLogicalCall>) {
  if (call.runId === null || call.slotId === null) {
    throw new Error("mock test call has no slot");
  }
  return getSlot(db, call.runId, call.slotId);
}

function requestBody(role: RequestRole = "spec"): Record<string, unknown> {
  const schema =
    role === "spec" ? FAMILY_SPEC_JSON_SCHEMAS.ranking : BLIND_REVIEW_JSON_SCHEMA;
  return buildChatRequest({
    role,
    model: "mock/model",
    providerTag: "mock-provider",
    outputCapField: "max_tokens",
    maxOutputTokens: 128,
    messages: [{ role: "user", content: "public mock request" }],
    responseFormat: schema,
  }).body as Record<string, unknown>;
}

function createMockCall(
  role: RequestRole = "spec",
  slotIndex = 0,
): ReturnType<typeof createLogicalCall> {
  const slot = SMOKE_PLAN.slots[slotIndex];
  if (slot === undefined) {
    throw new Error(`missing smoke slot ${slotIndex}`);
  }
  return createLogicalCall(db, {
    runId: RUN_ID,
    slotId: slot.slotId,
    role,
    runKind: "smoke",
    requestBody: requestBody(role),
    expectedSchemaHash: "a".repeat(64),
    model: "mock/model",
    provider: "mock-provider",
    outputCapField: "max_tokens",
    createdAt: CREATED_AT,
  });
}

async function execute(
  call: ReturnType<typeof createLogicalCall>,
): Promise<Awaited<ReturnType<MockTransport["executeCall"]>>> {
  return mock.executeCall({
    db,
    accountId: "test-account",
    logicalCallId: call.logicalCallId,
    apiKey: MOCK_API_KEY,
    reservationUsd: "0.01",
  });
}

function roleSchema(role: RequestRole) {
  switch (role) {
    case "spec":
      return FamilySpecEnvelopeSchema;
    case "wording":
      return WordingResponseSchema;
    case "blind_text":
    case "blind_vision":
      return BLIND_REVIEW_RESPONSE_SCHEMA;
    case "alignment_text":
    case "alignment_vision":
      return ALIGNMENT_REVIEW_RESPONSE_SCHEMA;
  }
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p32-"));
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
  mock = createMockTransport({ db, clock });
});

afterEach(() => {
  mock.clear();
  try {
    db.close();
  } catch {
    // The test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("deterministic mock transport", () => {
  it("builds valid role content for every family and role", () => {
    for (const family of FAMILIES) {
      const modality = MODALITY_BY_FAMILY[family];
      const roles: RequestRole[] = ["spec", "wording"];
      if (modality === "text") {
        roles.push("blind_text", "alignment_text");
      } else {
        roles.push("blind_vision", "alignment_vision");
      }
      for (const role of roles) {
        const scenario = mockScenarioForFamily(
          role,
          family,
          1,
          seedFor(`${role}:${family}`),
        );
        const content = buildMockContent(scenario);
        const parsed = roleSchema(role).safeParse(content);
        expect(parsed.success, `${role}/${family}`).toBe(true);
      }
    }
  });

  it("is stable for a repeated seed and changes with the seed", () => {
    const scenario = mockScenarioForFamily(
      "blind_text",
      "ranking",
      1,
      seedFor("stable"),
    );
    expect(buildMockContent(scenario)).toEqual(buildMockContent(scenario));
    const other = mockScenarioForFamily(
      "blind_text",
      "ranking",
      1,
      seedFor("other"),
    );
    expect(buildMockContent(scenario)).not.toEqual(buildMockContent(other));
  });

  it("uses the real ledger/schema path with zero synthetic usage and visible mock identity", async () => {
    const call = createMockCall("spec", 0);
    mock.registerScenario(call.logicalCallId, {
      role: "spec",
      family: "ranking",
      difficulty: slotForCall(call).difficulty,
      seed: seedFor("ledger"),
      kind: "valid",
    });
    const result = await execute(call);
    expect(result.outcome).toBe("success");
    expect(FamilySpecEnvelopeSchema.safeParse(result.parsedContent).success).toBe(
      true,
    );
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      reasoningTokens: null,
    });
    expect(result.actualCostUsd).toBe("0");
    expect(result.costStatus).toBe("known");
    expect(result.generationId).toMatch(/^mock-spec-/);
    expect(mock.isMock).toBe(true);
    expect(getLogicalCall(db, call.logicalCallId).state).toBe("validated");
    expect(mock.requests).toHaveLength(1);
    const captured = mock.requests[0];
    expect(captured?.url).toContain("/chat/completions");
    expect(captured?.headers.authorization).toBe(`Bearer ${MOCK_API_KEY}`);
    const capturedBody = JSON.parse(captured?.body ?? "null") as Record<string, unknown>;
    expect(capturedBody.model).toBe("mock/model");
    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.messages).toBeDefined();
    expect(capturedBody.provider).toBeDefined();
    expect(captured?.body).not.toContain("oracle");
    expect(captured?.body).not.toContain("correctLabel");
    expect(captured?.body).not.toContain("scenario");
  });

  it("keeps scenarios keyed by logical call even when request bodies match", async () => {
    const first = createMockCall("blind_text", 0);
    const second = createMockCall("blind_text", 1);
    expect(requestBody("blind_text")).toEqual(requestBody("blind_text"));
    mock.registerScenario(first.logicalCallId, {
      role: "blind_text",
      family: slotForCall(first).family,
      difficulty: slotForCall(first).difficulty,
      seed: seedFor("keyed-valid"),
      kind: "valid",
    });
    mock.registerScenario(second.logicalCallId, {
      role: "blind_text",
      family: slotForCall(second).family,
      difficulty: slotForCall(second).difficulty,
      seed: seedFor("keyed-wrong"),
      kind: "wrong_answer",
    });
    const firstResult = await execute(first);
    const secondResult = await execute(second);
    const firstReview = BLIND_REVIEW_RESPONSE_SCHEMA.parse(
      firstResult.parsedContent,
    );
    const secondReview = BLIND_REVIEW_RESPONSE_SCHEMA.parse(
      secondResult.parsedContent,
    );
    expect(firstReview.chosenOption).not.toBe(secondReview.chosenOption);
  });

  it("supports wrong-answer, schema-invalid, refusal, HTTP-error, and timeout scenarios", async () => {
    const wrong = buildMockContent({
      role: "blind_vision",
      family: "matrix",
      difficulty: 1,
      seed: seedFor("wrong"),
      kind: "wrong_answer",
    });
    const wrongReview = BLIND_REVIEW_RESPONSE_SCHEMA.parse(wrong);
    const engine = productionRegistry.getEngine("matrix");
    const spec = engine.generateSpec(seedFor("wrong"), 1);
    const solve = engine.enumerateSolutions(spec);
    if (solve.correctAnswer === null) {
      throw new Error("expected a unique matrix answer");
    }
    const choices = engine.makeOptions(
      spec,
      solve.correctAnswer,
      hashCanonicalJson(spec),
    );
    expect(wrongReview.chosenOption).not.toBe(choices.correctLabel);

    const wrongAlignment = buildMockContent({
      role: "alignment_text",
      family: "ranking",
      difficulty: 1,
      seed: seedFor("wrong-alignment"),
      kind: "wrong_answer",
    });
    const wrongAlignmentReview =
      ALIGNMENT_REVIEW_RESPONSE_SCHEMA.parse(wrongAlignment);
    expect(wrongAlignmentReview.overall).toBe("fail");
    expect(wrongAlignmentReview.fields.options.status).toBe("fail");

    const schemaInvalid = buildMockContent({
      role: "spec",
      family: "ranking",
      difficulty: 1,
      seed: seedFor("schema"),
      kind: "schema_invalid",
    });
    expect(FamilySpecEnvelopeSchema.safeParse(schemaInvalid).success).toBe(false);

    const schemaCall = createMockCall("spec", 3);
    mock.registerScenario(schemaCall.logicalCallId, {
      role: "spec",
      family: slotForCall(schemaCall).family,
      difficulty: slotForCall(schemaCall).difficulty,
      seed: seedFor("schema-transport"),
      kind: "schema_invalid",
    });
    const schemaResult = await execute(schemaCall);
    expect(schemaResult.outcome).toBe("success");
    expect(
      FamilySpecEnvelopeSchema.safeParse(schemaResult.parsedContent).success,
    ).toBe(false);

    const wrongCall = createMockCall("blind_text", 4);
    const wrongSeed = seedFor("wrong-transport");
    mock.registerScenario(wrongCall.logicalCallId, {
      role: "blind_text",
      family: slotForCall(wrongCall).family,
      difficulty: slotForCall(wrongCall).difficulty,
      seed: wrongSeed,
      kind: "wrong_answer",
    });
    const wrongResult = await execute(wrongCall);
    const wrongTransportReview = BLIND_REVIEW_RESPONSE_SCHEMA.parse(
      wrongResult.parsedContent,
    );
    const wrongEngine = productionRegistry.getEngine(
      slotForCall(wrongCall).family,
    );
    const wrongSpec = wrongEngine.generateSpec(
      wrongSeed,
      slotForCall(wrongCall).difficulty,
    );
    const wrongSolve = wrongEngine.enumerateSolutions(wrongSpec);
    if (wrongSolve.correctAnswer === null) {
      throw new Error("expected a unique transport wrong-answer result");
    }
    const wrongChoices = wrongEngine.makeOptions(
      wrongSpec,
      wrongSolve.correctAnswer,
      hashCanonicalJson(wrongSpec),
    );
    expect(wrongTransportReview.chosenOption).not.toBe(
      wrongChoices.correctLabel,
    );

    for (const kind of ["refusal", "http_error"] as const) {
      const call = createMockCall("spec", kind === "refusal" ? 0 : 1);
      mock.registerScenario(call.logicalCallId, {
        role: "spec",
        family: slotForCall(call).family,
        difficulty: slotForCall(call).difficulty,
        seed: seedFor(kind),
        kind,
      });
      const result = await execute(call);
      expect(result.outcome).not.toBe("success");
    }

    const timeoutMock = createMockTransport({ db, clock, deadlineMs: 10 });
    const timeoutCall = createMockCall("spec", 2);
    timeoutMock.registerScenario(timeoutCall.logicalCallId, {
      role: "spec",
      family: slotForCall(timeoutCall).family,
      difficulty: slotForCall(timeoutCall).difficulty,
      seed: seedFor("timeout"),
      kind: "timeout",
    });
    const timeoutResult = await timeoutMock.executeCall({
      db,
      accountId: "test-account",
      logicalCallId: timeoutCall.logicalCallId,
      apiKey: MOCK_API_KEY,
      reservationUsd: "0.01",
    });
    expect(timeoutResult.outcome).toBe("uncertain");
    expect(timeoutResult.error?.code).toBe("NETWORK_TIMEOUT");
  });

  it("never calls global fetch and never includes mock oracle data in blind requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const call = createMockCall("blind_text", 0);
    mock.registerScenario(call.logicalCallId, {
      role: "blind_text",
      family: slotForCall(call).family,
      difficulty: slotForCall(call).difficulty,
      seed: seedFor("blind-allowlist"),
      kind: "valid",
    });
    const result = await execute(call);
    expect(result.outcome).toBe("success");
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = mock.requests[0]?.body ?? "";
    expect(body).not.toContain("oracle");
    expect(body).not.toContain("correctLabel");
    expect(body).not.toContain("expectedOption");
    expect(body).not.toContain(MOCK_API_KEY);
    fetchSpy.mockRestore();
  });

  it("drives a real blind adapter request through the mock transport", async () => {
    const slot = SMOKE_PLAN.slots[0];
    if (slot === undefined) {
      throw new Error("smoke plan has no first slot");
    }
    const engine = productionRegistry.getEngine(slot.family);
    const seed = seedFor(`adapter:${slot.slotId}`);
    const spec = engine.generateSpec(seed, slot.difficulty);
    const solve = engine.enumerateSolutions(spec);
    if (solve.correctAnswer === null) {
      throw new Error("expected a unique adapter answer");
    }
    const choices = engine.makeOptions(
      spec,
      solve.correctAnswer,
      hashCanonicalJson(spec),
    );
    const wording = makeFixtureWording(engine, spec);
    const assembled = assemblePresentation({
      slotId: slot.slotId,
      engine,
      spec,
      solveResult: solve,
      choices,
      wording,
    });
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: slot.slotId,
      stage: "presentation_ready",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      elapsedMs: 0,
      payload: { presentation: assembled, wording },
    });
    const route: ResolvedRoute = {
      role: "blind_text",
      model: "mock/model",
      providerTag: "mock-provider",
      providerName: "Mock Provider",
      endpointTag: "mock-provider",
      outputCapField: "max_tokens",
      maxOutputTokens: 4096,
      minPromptTokens: 16_384,
      contextLength: 131_072,
      maxPromptTokens: null,
      maxCompletionTokens: 16_384,
      supportedParameters: ["structured_outputs", "max_tokens"],
      pricing: { prompt: "0", completion: "0" },
      requiresImage: false,
      imageInputDeclared: false,
      visionProbeRequired: false,
      responseFormat: BLIND_REVIEW_JSON_SCHEMA,
      schemaHash: "a".repeat(64),
      settings: {},
    };
    const adapterTransport = {
      ...mock,
      executeCall: async (
        input: Parameters<typeof mock.executeCall>[0],
      ): ReturnType<typeof mock.executeCall> => {
        mock.registerScenario(input.logicalCallId, {
          role: "blind_text",
          family: slot.family,
          difficulty: slot.difficulty,
          seed: seedFor("adapter-scenario-different"),
          kind: "valid",
        });
        return mock.executeCall(input);
      },
    };
    const result = await reviewText({
      db,
      accountId: "test-account",
      apiKey: MOCK_API_KEY,
      transport: adapterTransport,
      runId: RUN_ID,
      slotId: slot.slotId,
      route,
      reservationUsd: "0.01",
      clock,
    });
    expect(result.choiceAgreement).toBe("agreed");
    expect(result.review.chosenOption).toBe(choices.correctLabel);
    const body = mock.requests.at(-1)?.body ?? "";
    expect(body).toContain(assembled.visible.question);
    expect(body).not.toContain("oracle");
    expect(body).not.toContain("correctLabel");
    expect(body).not.toContain("expectedOption");
    expect(body).not.toContain(MOCK_API_KEY);
  });

  it("rejects missing scenarios and live-factory mock oracle options", async () => {
    const call = createMockCall("spec", 0);
    const missing = await mock
      .executeCall({
        db,
        accountId: "test-account",
        logicalCallId: call.logicalCallId,
        apiKey: MOCK_API_KEY,
        reservationUsd: "0.01",
      })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(MockTransportError);
    expect((missing as MockTransportError).code).toBe("MISSING_SCENARIO");

    const mismatchCall = createMockCall("spec", 1);
    const mismatch = (() => {
      try {
        mock.registerScenario(mismatchCall.logicalCallId, {
          role: "blind_text",
          family: slotForCall(mismatchCall).family,
          difficulty: slotForCall(mismatchCall).difficulty,
          seed: seedFor("mismatch"),
          kind: "valid",
        });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(mismatch).toBeInstanceOf(MockTransportError);
    expect((mismatch as MockTransportError).code).toBe("INVALID_SCENARIO");

    const live = (() => {
      try {
        createOpenRouterTransport({
          mockRegistry: new Map(),
        } as unknown as OpenRouterTransportOptions);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(live).toBeInstanceOf(OpenRouterError);
    expect((live as OpenRouterError).code).toBe("MOCK_NOT_ALLOWED");

    const liveOracle = (() => {
      try {
        createOpenRouterTransport({
          oracle: { correctLabel: "A" },
        } as unknown as OpenRouterTransportOptions);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(liveOracle).toBeInstanceOf(OpenRouterError);
    expect((liveOracle as OpenRouterError).code).toBe("MOCK_NOT_ALLOWED");
  });

  it("exposes the fixture failure and scenario kind vocabulary", () => {
    expect(MOCK_SCENARIO_KINDS).toEqual([
      "valid",
      "wrong_answer",
      "schema_invalid",
      "refusal",
      "http_error",
      "timeout",
    ]);
  });
});
