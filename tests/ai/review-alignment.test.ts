import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import {
  createLogicalCall,
  getLogicalCall,
  listAttempts,
  listRequestEvents,
} from "../../src/ai/ledger.js";
import { createOpenRouterTransport } from "../../src/ai/openrouter.js";
import type { ResolvedRoute } from "../../src/ai/preflight.js";
import {
  ALIGNMENT_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_JSON_SCHEMA,
  strictSchemaHash,
  type AlignmentFieldStatus,
  type AlignmentFields,
  type AlignmentReviewResponse,
} from "../../src/ai/schemas.js";
import {
  ReviewAlignmentError,
  alignmentPromptMetadata,
  buildAlignmentMessages,
  reviewAlignment,
  type AlignmentPayload,
} from "../../src/ai/review-alignment.js";
import type { WordingResponse } from "../../src/domain/presentation.js";
import type { AssembledPresentation } from "../../src/domain/presentation.js";
import type { Family, SvgFamily } from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { assemblePresentation } from "../../src/presentation/assemble.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import { renderScenePng } from "../../src/render/png.js";
import { SCENE_SIZE, type Scene } from "../../src/render/scene.js";
import { serializeScene } from "../../src/render/svg.js";
import { hashArtifactBytes, storeArtifact } from "../../src/storage/artifacts.js";
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
import { sha256Hex } from "../../src/util/hash.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174004";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p30-test-secret-do-not-persist";
const TEXT_SLOTS = SMOKE_PLAN.slots.filter((slot) => slot.modality === "text");
const VISUAL_SLOTS = SMOKE_PLAN.slots.filter((slot) => slot.modality === "svg");

let tempDirectory: string;
let db: Database.Database;
let fake: FakeOpenRouter;
let transport: ReturnType<typeof createOpenRouterTransport>;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function testSeed(label: string): string {
  return sha256Hex(`p30-test:${label}`);
}

function alignmentRoute(
  modality: "text" | "svg",
  overrides: Partial<ResolvedRoute> = {},
): ResolvedRoute {
  return {
    role: modality === "svg" ? "alignment_vision" : "alignment_text",
    model: "test/model",
    providerTag: "test-provider",
    providerName: "Test Provider",
    endpointTag: "test-provider",
    outputCapField: "max_tokens",
    maxOutputTokens: 4096,
    minPromptTokens: modality === "svg" ? 32_768 : 16_384,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: {
      prompt: "0.000001",
      completion: "0.000002",
      ...(modality === "svg" ? { image: "0.0001" } : {}),
    },
    requiresImage: modality === "svg",
    imageInputDeclared: modality === "svg",
    visionProbeRequired: modality === "svg",
    responseFormat: ALIGNMENT_REVIEW_JSON_SCHEMA,
    schemaHash: strictSchemaHash(ALIGNMENT_REVIEW_JSON_SCHEMA),
    settings: {},
    ...overrides,
  };
}

function textSlotFor(family: Family) {
  const slot = TEXT_SLOTS.find((candidate) => candidate.family === family);
  if (slot === undefined) {
    throw new Error(`smoke plan has no text slot for ${family}`);
  }
  return slot;
}

function visualSlotFor(family: Family) {
  const slot = VISUAL_SLOTS.find((candidate) => candidate.family === family);
  if (slot === undefined) {
    throw new Error(`smoke plan has no visual slot for ${family}`);
  }
  return slot;
}

interface AlignmentFixture {
  readonly slot: (typeof SMOKE_PLAN.slots)[number];
  readonly assembled: AssembledPresentation;
  readonly correctLabel: string;
  readonly png: Buffer | null;
  readonly pngHash: string | null;
  readonly wording: ReturnType<typeof makeFixtureWording>;
}

function fixtureForSlot(
  slot: (typeof SMOKE_PLAN.slots)[number],
  wordingPatch?: Partial<WordingResponse>,
): AlignmentFixture {
  const engine = productionRegistry.getEngine(slot.family);
  const seed = testSeed(`slot:${slot.slotId}`);
  const spec = engine.generateSpec(seed, slot.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`expected a unique ${slot.family} answer`);
  }
  const choices = engine.makeOptions(spec, solve.correctAnswer, seed);
  const baseWording = makeFixtureWording(engine, spec);
  const wording =
    wordingPatch === undefined
      ? baseWording
      : {
          source: baseWording.source,
          response: { ...baseWording.response, ...wordingPatch },
        };
  let png: Buffer | null = null;
  let pngHash: string | null = null;
  let assets: { svgHash: string; pngHash: string } | undefined;
  if (slot.modality === "svg") {
    const renderer = productionRegistry.getRenderer(slot.family as SvgFamily);
    const scene = renderer.buildScene(spec) as Scene;
    png = renderScenePng(scene, SCENE_SIZE);
    pngHash = hashArtifactBytes(png);
    const svgHash = sha256Hex(serializeScene(scene));
    storeArtifact(
      db,
      {
        kind: "png",
        mediaType: "image/png",
        bytes: png,
        role: "presentation_full",
      },
      CREATED_AT,
    );
    assets = { svgHash, pngHash };
  }
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
    stage: "formal_checked",
    startedAt: CREATED_AT,
    finishedAt: CREATED_AT,
    elapsedMs: 0,
    payload: { spec, solveResult: solve, choices },
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
  return {
    slot,
    assembled,
    correctLabel: choices.correctLabel,
    png,
    pngHash,
    wording,
  };
}

function insertPresentationOnly(
  slot: (typeof SMOKE_PLAN.slots)[number],
): void {
  const engine = productionRegistry.getEngine(slot.family);
  const seed = testSeed(`slot:${slot.slotId}`);
  const spec = engine.generateSpec(seed, slot.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`expected a unique ${slot.family} answer`);
  }
  const choices = engine.makeOptions(spec, solve.correctAnswer, seed);
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
}

function field(
  status: AlignmentFieldStatus,
  factIds: readonly string[] = ["r-domain"],
) {
  return {
    status,
    factIds: status === "not_applicable" ? [] : [...factIds],
    reason: "Model evidence for this field.",
  };
}

function validFields(modality: "text" | "svg"): AlignmentFields {
  return {
    question: field("pass"),
    rulesAndClues: field("pass"),
    options: field("pass"),
    hint: field("pass"),
    explanation: field("pass"),
    image: field(modality === "text" ? "not_applicable" : "pass"),
  };
}

interface AlignmentResponseOverrides {
  readonly overall?: AlignmentReviewResponse["overall"];
  readonly fields?: Partial<AlignmentFields>;
}

function alignmentResponse(
  modality: "text" | "svg",
  overrides: AlignmentResponseOverrides = {},
): AlignmentReviewResponse {
  return {
    overall: overrides.overall ?? "pass",
    fields: {
      ...validFields(modality),
      ...(overrides.fields ?? {}),
    },
  };
}

function callAlignment(
  fixture: AlignmentFixture,
  overrides: Partial<Parameters<typeof reviewAlignment>[0]> = {},
) {
  return reviewAlignment({
    db,
    accountId: "test-account",
    apiKey: API_KEY,
    transport,
    runId: RUN_ID,
    slotId: fixture.slot.slotId,
    route: alignmentRoute(fixture.slot.modality),
    reservationUsd: "0.01",
    clock,
    ...overrides,
  });
}

function successBody(content: unknown): Record<string, unknown> {
  return {
    id: "gen-p30",
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
    id: "gen-p30-failure",
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

function asRequestBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("logical call has no request body");
  }
  return value as Record<string, unknown>;
}

function userText(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content: unknown }>;
  const content = messages[1]?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new Error("alignment request has no user content");
  }
  const part = content.find(
    (candidate): candidate is { type: "text"; text: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === "text",
  );
  if (part === undefined) {
    throw new Error("alignment request has no text part");
  }
  return part.text;
}

function capturedPayload(body: Record<string, unknown>): AlignmentPayload {
  const content = userText(body);
  const marker = "Alignment review payload:\n";
  const start = content.indexOf(marker);
  const end = content.indexOf("\n\nReturn exactly");
  if (start < 0 || end < 0) {
    throw new Error("alignment request has no payload");
  }
  return JSON.parse(content.slice(start + marker.length, end)) as AlignmentPayload;
}

function decodeImage(body: Record<string, unknown>): Buffer {
  const messages = body.messages as Array<{ content: unknown }>;
  const content = messages[1]?.content;
  if (!Array.isArray(content)) {
    throw new Error("alignment vision request has no content parts");
  }
  const part = content.find(
    (candidate): candidate is { type: "image_url"; image_url: { url: string } } =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === "image_url",
  );
  const url = part?.image_url.url;
  const prefix = "data:image/png;base64,";
  if (url === undefined || !url.startsWith(prefix)) {
    throw new Error("alignment vision request has no PNG data URL");
  }
  return Buffer.from(url.slice(prefix.length), "base64");
}

async function expectAlignmentError(
  action: Promise<unknown>,
  code: string,
): Promise<ReviewAlignmentError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewAlignmentError);
    const alignmentError = error as ReviewAlignmentError;
    expect(alignmentError.code).toBe(code);
    return alignmentError;
  }
  throw new Error(`expected ReviewAlignmentError ${code}`);
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
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p30-"));
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

describe("informed alignment reviewer", () => {
  it("reviews a text presentation with DSL, proof, key, visible text, hint, explanation, and inventory", async () => {
    const fixture = fixtureForSlot(textSlotFor("ranking"));
    fake.enqueue({
      status: 200,
      body: successBody(alignmentResponse("text")),
    });
    const result = await callAlignment(fixture);
    expect(result.role).toBe("alignment_text");
    expect(result.modality).toBe("text");
    expect(result.modelOverall).toBe("pass");
    expect(result.derivedOverall).toBe("pass");
    expect(result.overallMismatch).toBe(false);
    expect(result.concerns).toEqual([]);
    expect(result.deterministicEvidence.correctLabel).toBe(fixture.correctLabel);
    expect(result.deterministicEvidence.proof).not.toBeNull();
    expect(getSlot(db, RUN_ID, fixture.slot.slotId).stage).toBe(
      "presentation_ready",
    );

    const call = getLogicalCall(db, result.logicalCallId);
    expect(call.role).toBe("alignment_text");
    expect(call.expectedSchemaHash).toBe(result.proposal.schemaHash);
    const requestBody = asRequestBody(call.requestBody);
    const payload = capturedPayload(requestBody);
    expect(payload.dsl).toBeDefined();
    expect(payload.proof).toBeDefined();
    expect(payload.correctOption.label).toBe(fixture.correctLabel);
    expect(payload.options).toHaveLength(4);
    expect(payload.visible.question).toBe(fixture.assembled.visible.question);
    expect(payload.visible.clues.length).toBeGreaterThan(0);
    expect(payload.wording.hint).toBe(fixture.assembled.reveal.hint);
    expect(payload.inventory.length).toBeGreaterThan(0);
    expect(JSON.stringify(requestBody.messages)).not.toContain("image_url");
    expect(JSON.stringify(requestBody.messages)).not.toContain("BLIND_CANARY");

    const event = listRequestEvents(db, result.logicalCallId).find(
      (candidate) => candidate.eventType === "alignment_review",
    );
    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      role: "alignment_text",
      family: "ranking",
      modality: "text",
      derivedOverall: "pass",
      overallMismatch: false,
      modelEvidence: { overall: "pass", concerns: [] },
      promptVersion: "v1",
      schemaName: "puzzle_alignment_review",
      schemaVersion: "v1",
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("reviews an SVG presentation with the actual PNG and records deterministic evidence separately", async () => {
    const fixture = fixtureForSlot(visualSlotFor("matrix"));
    fake.enqueue({
      status: 200,
      body: successBody(alignmentResponse("svg")),
    });
    const result = await callAlignment(fixture);
    expect(result.role).toBe("alignment_vision");
    expect(result.modality).toBe("svg");
    expect(result.pngHash).toBe(fixture.pngHash);
    expect(result.pngByteLength).toBe(fixture.png?.length);
    expect(result.derivedOverall).toBe("pass");
    expect(result.deterministicEvidence.correctLabel).toBe(fixture.correctLabel);
    expect(result.deterministicEvidence.proof).not.toBeNull();
    expect(getSlot(db, RUN_ID, fixture.slot.slotId).stage).toBe(
      "presentation_ready",
    );

    const call = getLogicalCall(db, result.logicalCallId);
    const requestBody = asRequestBody(call.requestBody);
    expect(decodeImage(requestBody).equals(fixture.png as Buffer)).toBe(true);
    const capturedBody = JSON.parse(
      fake.requests.at(-1)?.body ?? "null",
    ) as Record<string, unknown>;
    expect(decodeImage(capturedBody).equals(fixture.png as Buffer)).toBe(true);
    const payload = capturedPayload(requestBody);
    expect(payload.visible.clues).toEqual([]);
    expect(payload.visible.question).toBe(fixture.assembled.visible.question);
    expect(payload.wording.explanationSteps).toEqual(
      fixture.assembled.reveal.explanationSteps,
    );
    const event = listRequestEvents(db, result.logicalCallId).find(
      (candidate) => candidate.eventType === "alignment_review",
    );
    expect(event?.payload).toMatchObject({
      role: "alignment_vision",
      modality: "svg",
      pngHash: fixture.pngHash,
      pngByteLength: fixture.png?.length,
      derivedOverall: "pass",
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("retains a model-authored contradiction as model evidence and computes fail", async () => {
    const fixture = fixtureForSlot(textSlotFor("ranking"), {
      hint: "The correct answer is not A.",
      explanationSteps: [
        { factIds: ["r-domain"], text: "This step contradicts the proof." },
      ],
    });
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("text", {
          overall: "fail",
          fields: {
            rulesAndClues: field("fail"),
            hint: field("fail"),
            explanation: field("fail"),
          },
        }),
      ),
    });
    const result = await callAlignment(fixture);
    expect(result.derivedOverall).toBe("fail");
    expect(result.modelOverall).toBe("fail");
    expect(result.concerns.map((concern) => concern.field)).toEqual(
      expect.arrayContaining(["rulesAndClues", "hint", "explanation"]),
    );
    expect(result.publicPayload.wording.hint).toContain("not A");
    expect(result.publicPayload.proof).toBeDefined();
    expect(getSlot(db, RUN_ID, fixture.slot.slotId).stage).toBe(
      "presentation_ready",
    );
  });

  it("detects a changed visual option and SVG rules/observation mismatch despite empty clueTexts", async () => {
    const fixture = fixtureForSlot(visualSlotFor("transforms"));
    expect(fixture.assembled.visible.clues).toEqual([]);
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("svg", {
          overall: "fail",
          fields: {
            rulesAndClues: field("fail"),
            options: field("fail"),
            image: field("fail"),
          },
        }),
      ),
    });
    const result = await callAlignment(fixture);
    expect(result.derivedOverall).toBe("fail");
    expect(result.concerns.map((concern) => concern.field)).toEqual(
      expect.arrayContaining(["rulesAndClues", "options", "image"]),
    );
    expect(result.publicPayload.visible.clues).toEqual([]);
    expect(result.pngHash).toBe(fixture.pngHash);
  });

  it("ignores a model overall pass when a field fails and records the mismatch", async () => {
    const fixture = fixtureForSlot(textSlotFor("matching"));
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("text", {
          overall: "pass",
          fields: { question: field("fail") },
        }),
      ),
    });
    const result = await callAlignment(fixture);
    expect(result.modelOverall).toBe("pass");
    expect(result.derivedOverall).toBe("fail");
    expect(result.overallMismatch).toBe(true);
    expect(result.concerns[0]?.field).toBe("question");
  });

  it("rejects improper not_applicable statuses in text and SVG", async () => {
    const textImage = fixtureForSlot(textSlotFor("scheduling"));
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("text", {
          fields: { image: field("pass") },
        }),
      ),
    });
    await expectAlignmentError(callAlignment(textImage), "INVALID_ALIGNMENT");

    const textHint = fixtureForSlot(textSlotFor("truth"));
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("text", {
          fields: { hint: field("not_applicable") },
        }),
      ),
    });
    await expectAlignmentError(callAlignment(textHint), "INVALID_ALIGNMENT");

    const svgImage = fixtureForSlot(visualSlotFor("paths"));
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("svg", {
          fields: { image: field("not_applicable") },
        }),
      ),
    });
    await expectAlignmentError(callAlignment(svgImage), "INVALID_ALIGNMENT");
    expect(fake.requests).toHaveLength(3);
  });

  it("accepts uncertain status and rejects unknown fact citations", async () => {
    const uncertain = fixtureForSlot(textSlotFor("arithmetic"));
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("text", {
          overall: "uncertain",
          fields: { question: field("uncertain") },
        }),
      ),
    });
    const result = await callAlignment(uncertain);
    expect(result.derivedOverall).toBe("uncertain");
    expect(result.concerns.map((concern) => concern.field)).toContain("question");

    const unknown = fixtureForSlot(textSlotFor("ranking"));
    fake.enqueue({
      status: 200,
      body: successBody(
        alignmentResponse("text", {
          fields: { question: field("fail", ["f999"]) },
        }),
      ),
    });
    const error = await expectAlignmentError(
      callAlignment(unknown),
      "INVALID_ALIGNMENT",
    );
    expect(error.issues).toContain("question:f999");
    expect(fake.requests).toHaveLength(2);
  });

  it("retains refusal and invalid JSON, and rejects a missing review", async () => {
    const refusal = fixtureForSlot(textSlotFor("ranking"));
    fake.enqueue({
      status: 200,
      body: failureBody("content_filter", null, "I cannot comply."),
    });
    const refusalError = await expectAlignmentError(
      callAlignment(refusal),
      "TRANSPORT_FAILED",
    );
    expect(refusalError.logicalCallId).not.toBeNull();
    if (refusalError.logicalCallId === null) {
      throw new Error("refusal did not expose a logical call");
    }
    const attempts = listAttempts(db, refusalError.logicalCallId);
    expect(attempts).toHaveLength(1);
    const artifactId = attempts[0]?.rawResponseArtifactId;
    expect(artifactId).not.toBeNull();
    if (artifactId === null || artifactId === undefined) {
      throw new Error("refusal did not save a raw response");
    }
    expect(rawArtifactBytes(artifactId).toString("utf8")).toContain(
      "I cannot comply",
    );

    const invalidJson = fixtureForSlot(textSlotFor("matching"));
    fake.enqueue({ status: 200, body: failureBody("stop", "not json") });
    await expectAlignmentError(callAlignment(invalidJson), "TRANSPORT_FAILED");

    const missing = fixtureForSlot(textSlotFor("scheduling"));
    fake.enqueue({ status: 200, body: successBody({ overall: "pass" }) });
    await expectAlignmentError(callAlignment(missing), "INVALID_ALIGNMENT");
    expect(fake.requests).toHaveLength(3);
  });

  it("does not include blind review or change an existing blind request hash", async () => {
    const fixture = fixtureForSlot(textSlotFor("ranking"));
    const blindCall = createLogicalCall(db, {
      runId: RUN_ID,
      slotId: fixture.slot.slotId,
      role: "blind_text",
      runKind: "smoke",
      requestBody: { blindCanary: "BLIND_CANARY" },
      expectedSchemaHash: strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA),
      model: "blind/model",
      provider: "blind-provider",
      outputCapField: "max_tokens",
      createdAt: CREATED_AT,
    });
    const before = getLogicalCall(db, blindCall.logicalCallId).requestHash;
    fake.enqueue({
      status: 200,
      body: successBody(alignmentResponse("text")),
    });
    const result = await callAlignment(fixture);
    expect(result.role).toBe("alignment_text");
    expect(getLogicalCall(db, blindCall.logicalCallId).requestHash).toBe(before);
    const requestBody = asRequestBody(
      getLogicalCall(db, result.logicalCallId).requestBody,
    );
    expect(JSON.stringify(requestBody.messages)).not.toContain("BLIND_CANARY");
    expect(JSON.stringify(requestBody.messages)).not.toContain("blindCanary");
  });

  it("rejects wrong routes, missing formal evidence, and already-reviewed slots before a request", async () => {
    const fixture = fixtureForSlot(textSlotFor("ranking"));
    const wrongRole = await expectAlignmentError(
      callAlignment(fixture, {
        route: alignmentRoute("text", { role: "alignment_vision" }),
      }),
      "ROUTE_ROLE_MISMATCH",
    );
    expect(wrongRole.logicalCallId).toBeNull();

    const imageRoute = await expectAlignmentError(
      callAlignment(fixture, {
        route: alignmentRoute("text", { requiresImage: true }),
      }),
      "INVALID_INPUT",
    );
    expect(imageRoute.logicalCallId).toBeNull();

    const missingFormal = textSlotFor("matching");
    insertPresentationOnly(missingFormal);
    const missingError = await expectAlignmentError(
      callAlignment({ ...fixture, slot: missingFormal }),
      "INVALID_STAGE",
    );
    expect(missingError.logicalCallId).toBeNull();

    const reviewedSlot = textSlotFor("scheduling");
    const reviewed = fixtureForSlot(reviewedSlot);
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: reviewedSlot.slotId,
      stage: "alignment_reviewed",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      elapsedMs: 0,
      payload: {},
    });
    const reviewedError = await expectAlignmentError(
      callAlignment(reviewed),
      "INVALID_STAGE",
    );
    expect(reviewedError.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps text and vision prompt metadata stable and versioned", () => {
    const text = alignmentPromptMetadata("text");
    const svg = alignmentPromptMetadata("svg");
    expect(text.promptVersion).toBe("v1");
    expect(svg.promptVersion).toBe("v1");
    expect(text.schemaName).toBe("puzzle_alignment_review");
    expect(svg.schemaName).toBe("puzzle_alignment_review");
    expect(text.schemaVersion).toBe("v1");
    expect(svg.schemaVersion).toBe("v1");
    expect(text.promptHash).not.toBe(svg.promptHash);
    expect(text.schemaHash).toBe(strictSchemaHash(ALIGNMENT_REVIEW_JSON_SCHEMA));
    expect(svg.schemaHash).toBe(strictSchemaHash(ALIGNMENT_REVIEW_JSON_SCHEMA));

    const payload: AlignmentPayload = {
      family: "ranking",
      modality: "text",
      difficulty: 1,
      dsl: {},
      proof: {},
      correctOption: { label: "A", value: [], text: "option" },
      options: [],
      visible: { question: "Question?", rules: {}, clues: [], options: [] },
      wording: { hint: "hint", explanationSteps: [] },
      inventory: [],
    };
    const messages = buildAlignmentMessages(payload, text, null);
    expect(messages[0]?.content).toContain("prompt_version: v1");
    expect(messages[0]?.content).toContain(
      "image field must be not_applicable",
    );
    expect(messages[1]?.content).toContain("Alignment review payload");
  });
});
