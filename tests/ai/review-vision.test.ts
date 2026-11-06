import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import { MAX_PNG_BYTES } from "../../src/ai/config.js";
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
  ReviewVisionError,
  blindVisionPromptMetadata,
  buildBlindVisionMessages,
  reviewVision,
  type BlindVisionPromptMetadata,
} from "../../src/ai/review-vision.js";
import {
  type BlindTextPublicPayload,
} from "../../src/ai/review-text.js";
import type { AssembledPresentation } from "../../src/domain/presentation.js";
import {
  type Family,
  type SvgFamily,
} from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { assemblePresentation } from "../../src/presentation/assemble.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import {
  renderScenePng,
} from "../../src/render/png.js";
import { SCENE_SIZE, type Scene } from "../../src/render/scene.js";
import { serializeScene } from "../../src/render/svg.js";
import {
  hashArtifactBytes,
  storeArtifact,
} from "../../src/storage/artifacts.js";
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
const RUN_ID = "123e4567-e89b-42d3-a456-426614174003";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p29-test-secret-do-not-persist";
const VISUAL_FAMILIES = [
  "matrix",
  "transforms",
  "paths",
  "symmetry",
  "counting",
] as const satisfies readonly SvgFamily[];
const VISUAL_SLOTS = SMOKE_PLAN.slots.filter(
  (slot) => slot.modality === "svg",
);

let tempDirectory: string;
let db: Database.Database;
let fake: FakeOpenRouter;
let transport: ReturnType<typeof createOpenRouterTransport>;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function testSeed(label: string): string {
  return sha256Hex(`p29-test:${label}`);
}

function blindVisionRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    role: "blind_vision",
    model: "test/model",
    routingPolicy: "balanced",
    compatibleEndpointTags: ["test-provider"],
    compatibleProviderNames: ["Test Provider"],
    outputCapField: "max_tokens",
    maxOutputTokens: 4096,
    minPromptTokens: 32_768,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: { prompt: "0.000001", completion: "0.000002", image: "0.0001" },
    requiresImage: true,
    imageInputDeclared: true,
    visionProbeRequired: true,
    responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    schemaHash: strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA),
    settings: {},
    ...overrides,
  };
}

function visualSlotFor(family: Family) {
  const slot = VISUAL_SLOTS.find((candidate) => candidate.family === family);
  if (slot === undefined) {
    throw new Error(`smoke plan has no visual slot for ${family}`);
  }
  return slot;
}

interface VisualFixture {
  readonly slot: (typeof SMOKE_PLAN.slots)[number];
  readonly assembled: AssembledPresentation;
  readonly png: Buffer;
  readonly pngHash: string;
  readonly svgHash: string;
  readonly correctLabel: string;
}

function visualFixture(
  slot: (typeof SMOKE_PLAN.slots)[number],
  pngOverride?: Buffer,
): VisualFixture {
  const engine = productionRegistry.getEngine(slot.family);
  const renderer = productionRegistry.getRenderer(slot.family as SvgFamily);
  const seed = testSeed(`slot:${slot.slotId}`);
  const spec = engine.generateSpec(seed, slot.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`expected a unique ${slot.family} answer`);
  }
  const choices = engine.makeOptions(spec, solve.correctAnswer, seed);
  const wording = makeFixtureWording(engine, spec);
  const scene = renderer.buildScene(spec) as Scene;
  const png = pngOverride ?? renderScenePng(scene, SCENE_SIZE);
  const pngHash = hashArtifactBytes(png);
  const svgHash = sha256Hex(serializeScene(scene));
  storeArtifact(db, {
    kind: "png",
    mediaType: "image/png",
    bytes: png,
    role: "presentation_full",
  }, CREATED_AT);
  const assembled = assemblePresentation({
    slotId: slot.slotId,
    engine,
    spec,
    solveResult: solve,
    choices,
    wording,
    assets: { svgHash, pngHash },
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
      presentation: assembled,
      proposal: {},
    },
  });
  return {
    slot,
    assembled,
    png,
    pngHash,
    svgHash,
    correctLabel: choices.correctLabel,
  };
}

function insertPngStage(
  slot: (typeof SMOKE_PLAN.slots)[number],
  pngHash: string,
): void {
  const engine = productionRegistry.getEngine(slot.family);
  const renderer = productionRegistry.getRenderer(slot.family as SvgFamily);
  const seed = testSeed(`slot:${slot.slotId}`);
  const spec = engine.generateSpec(seed, slot.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`expected a unique ${slot.family} answer`);
  }
  const choices = engine.makeOptions(spec, solve.correctAnswer, seed);
  const wording = makeFixtureWording(engine, spec);
  const scene = renderer.buildScene(spec) as Scene;
  const assembled = assemblePresentation({
    slotId: slot.slotId,
    engine,
    spec,
    solveResult: solve,
    choices,
    wording,
    assets: { svgHash: sha256Hex(serializeScene(scene)), pngHash },
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

function validReview(): Record<string, unknown> {
  return {
    answerStatus: "selected",
    chosenOption: "A",
    reasoning: "The visible labeled tile A satisfies the rules.",
    clarity: "clear",
    ambiguity: "none",
    confidence: 0.8,
    visualLegibility: "legible",
    issues: [],
  };
}

function callReview(
  fixture: VisualFixture,
  overrides: Partial<Parameters<typeof reviewVision>[0]> = {},
) {
  return reviewVision({
    db,
    accountId: "test-account",
    apiKey: API_KEY,
    transport,
    runId: RUN_ID,
    slotId: fixture.slot.slotId,
    route: blindVisionRoute(),
    reservationUsd: "0.01",
    clock,
    ...overrides,
  });
}

function successBody(content: unknown): Record<string, unknown> {
  return {
    id: "gen-p29",
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
    id: "gen-p29-failure",
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

function asRequestBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("logical call has no request body");
  }
  return value as Record<string, unknown>;
}

function decodeImage(body: Record<string, unknown>): Buffer {
  const messages = body.messages as Array<{ content: unknown }>;
  const parts = messages[1]?.content;
  if (!Array.isArray(parts)) {
    throw new Error("vision request has no content parts");
  }
  const imagePart = parts.find(
    (part): part is { type: "image_url"; image_url: { url: string } } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "image_url",
  );
  const url = imagePart?.image_url.url;
  const prefix = "data:image/png;base64,";
  if (url === undefined || !url.startsWith(prefix)) {
    throw new Error("vision request has no PNG data URL");
  }
  return Buffer.from(url.slice(prefix.length), "base64");
}

function textPart(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content: unknown }>;
  const parts = messages[1]?.content;
  if (!Array.isArray(parts)) {
    throw new Error("vision request has no content parts");
  }
  const text = parts.find(
    (part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text",
  );
  if (text === undefined) {
    throw new Error("vision request has no text part");
  }
  return text.text;
}

async function expectVisionError(
  action: Promise<unknown>,
  code: string,
): Promise<ReviewVisionError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewVisionError);
    const visionError = error as ReviewVisionError;
    expect(visionError.code).toBe(code);
    return visionError;
  }
  throw new Error(`expected ReviewVisionError ${code}`);
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

function withTextChunk(png: Buffer): Buffer {
  const type = Buffer.from("tEXt");
  const data = Buffer.from("Comment\0CANARY_PNG_METADATA");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  const chunk = Buffer.concat([length, type, data, crc]);
  const iendStart = png.length - 12;
  return Buffer.concat([png.subarray(0, iendStart), chunk, png.subarray(iendStart)]);
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p29-"));
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

describe("blind vision reviewer", () => {
  it("reviews all five visual families with byte-identical PNG bytes and source-hash agreement", async () => {
    for (const family of VISUAL_FAMILIES) {
      const slot = visualSlotFor(family);
      const fixture = visualFixture(slot);
      fake.enqueue({ status: 200, body: successBody(validReview()) });
      const result = await callReview(fixture);
      expect(result.pngHash).toBe(fixture.pngHash);
      expect(result.pngByteLength).toBe(fixture.png.length);
      expect(result.publicPayload).toEqual(expectedPayload(fixture.assembled));
      expect(result.choiceAgreement).toBe(
        result.review.chosenOption === fixture.correctLabel
          ? "agreed"
          : "disagreed",
      );
      expect(getSlot(db, RUN_ID, slot.slotId).stage).toBe("presentation_ready");

      const call = getLogicalCall(db, result.logicalCallId);
      expect(call.expectedSchemaHash).toBe(result.proposal.schemaHash);
      const requestBody = asRequestBody(call.requestBody);
      const decoded = decodeImage(requestBody);
      expect(decoded.equals(fixture.png)).toBe(true);
      const capturedBody = JSON.parse(
        fake.requests.at(-1)?.body ?? "null",
      ) as Record<string, unknown>;
      expect(decodeImage(capturedBody).equals(fixture.png)).toBe(true);
      expect(decoded.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(hashArtifactBytes(decoded)).toBe(fixture.pngHash);
      expect(textPart(requestBody)).not.toContain(fixture.pngHash);
      expect(textPart(requestBody)).not.toContain(slot.slotId);

      const event = listRequestEvents(db, result.logicalCallId).find(
        (candidate) => candidate.eventType === "blind_vision_review",
      );
      expect(event).toBeDefined();
      expect(event?.payload).toMatchObject({
        family,
        modality: "svg",
        inputHash: hashCanonicalJson(expectedPayload(fixture.assembled)),
        pngHash: fixture.pngHash,
        pngByteLength: fixture.png.length,
        review: result.review,
        promptVersion: "v1",
        schemaName: "puzzle_blind_review",
        schemaVersion: "v1",
      });
    }
    expect(fake.requests).toHaveLength(VISUAL_FAMILIES.length);
  });

  it("keeps SVG, scene, key, hint, proof, and previous-review canaries out of the textual input", async () => {
    const slot = visualSlotFor("matrix");
    const fixture = visualFixture(slot);
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
    const canarySlot = visualSlotFor("counting");
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
        svg: "CANARY_SVG",
        scene: "CANARY_SCENE",
        key: "CANARY_KEY",
        previousReview: "CANARY_PREVIOUS",
        lane: "CANARY_LANE",
        spec: "CANARY_SPEC",
      },
    });

    fake.enqueue({ status: 200, body: successBody(validReview()) });
    const result = await callReview({ ...fixture, slot: canarySlot });
    const requestBody = asRequestBody(
      getLogicalCall(db, result.logicalCallId).requestBody,
    );
    const messages = requestBody.messages as unknown[];
    const textual = `${JSON.stringify(messages[0])}\n${textPart(requestBody)}`;
    for (const canary of [
      "CANARY_HINT",
      "CANARY_EXPLANATION",
      "CANARY_PROOF",
      "CANARY_WORDING_QUESTION",
      "CANARY_WORDING_HINT",
      "CANARY_SVG",
      "CANARY_SCENE",
      "CANARY_KEY",
      "CANARY_PREVIOUS",
      "CANARY_LANE",
      "CANARY_SPEC",
      canarySlot.slotId,
    ]) {
      expect(textual).not.toContain(canary);
    }
    expect(textual).not.toContain("svgHash");
    expect(textual).not.toContain("pngHash");
    expect(fake.requests).toHaveLength(1);
  });

  it("handles unreadable, wrong, uncertain, refusal, and invalid JSON responses without a stage or retry", async () => {
    const unreadableSlot = visualSlotFor("matrix");
    const unreadable = visualFixture(unreadableSlot);
    fake.enqueue({
      status: 200,
      body: successBody({
        ...validReview(),
        answerStatus: "cannot_determine",
        chosenOption: null,
        visualLegibility: "unclear",
        ambiguity: "present",
        confidence: 0.2,
      }),
    });
    const unreadableResult = await callReview(unreadable);
    expect(unreadableResult.choiceAgreement).toBe("not_applicable");
    expect(unreadableResult.review.visualLegibility).toBe("unclear");
    expect(getSlot(db, RUN_ID, unreadableSlot.slotId).stage).toBe(
      "presentation_ready",
    );

    const wrongSlot = visualSlotFor("transforms");
    const wrong = visualFixture(wrongSlot);
    fake.enqueue({
      status: 200,
      body: successBody({
        ...validReview(),
        chosenOption: wrong.correctLabel === "A" ? "B" : "A",
      }),
    });
    const wrongResult = await callReview(wrong);
    expect(wrongResult.choiceAgreement).toBe("disagreed");
    expect(fake.requests).toHaveLength(2);

    const refusalSlot = visualSlotFor("paths");
    const refusal = visualFixture(refusalSlot);
    fake.enqueue({
      status: 200,
      body: failureBody("content_filter", null, "I cannot comply."),
    });
    const refusalError = await expectVisionError(
      callReview(refusal),
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
    expect(attempts[0]?.actualCostUsd).toBe("0.001");

    const invalidJsonSlot = visualSlotFor("symmetry");
    const invalidJson = visualFixture(invalidJsonSlot);
    fake.enqueue({ status: 200, body: failureBody("stop", "not json") });
    await expectVisionError(callReview(invalidJson), "TRANSPORT_FAILED");
    expect(fake.requests).toHaveLength(4);
  });

  it("rejects text legibility not_applicable and invalid review relations", async () => {
    const slot = visualSlotFor("counting");
    const fixture = visualFixture(slot);
    fake.enqueue({
      status: 200,
      body: successBody({
        ...validReview(),
        visualLegibility: "not_applicable",
      }),
    });
    const error = await expectVisionError(callReview(fixture), "INVALID_REVIEW");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(1);

    const relationSlot = visualSlotFor("matrix");
    const relation = visualFixture(relationSlot);
    fake.enqueue({
      status: 200,
      body: successBody({
        ...validReview(),
        answerStatus: "no_unique_answer",
        chosenOption: "A",
      }),
    });
    await expectVisionError(callReview(relation), "INVALID_REVIEW");
    expect(fake.requests).toHaveLength(2);
  });

  it("rejects missing, corrupt, metadata-bearing, oversized, and wrong-shape PNG assets", async () => {
    const missing = visualFixture(visualSlotFor("matrix"));
    insertPngStage(
      visualSlotFor("transforms"),
      sha256Hex("missing-png"),
    );
    const missingError = await expectVisionError(
      callReview({ ...missing, slot: visualSlotFor("transforms") }),
      "PNG_NOT_FOUND",
    );
    expect(missingError.logicalCallId).toBeNull();

    const missingAssetSlot = VISUAL_SLOTS.find(
      (slot) => slot.family === "matrix" && slot.slotId !== missing.slot.slotId,
    );
    if (missingAssetSlot === undefined) {
      throw new Error("smoke plan has no second matrix slot");
    }
    const missingAssetPresentation = JSON.parse(
      JSON.stringify(missing.assembled),
    ) as AssembledPresentation;
    missingAssetPresentation.visible.assets.pngHash = null;
    insertStageResult(db, {
      runId: RUN_ID,
      slotId: missingAssetSlot.slotId,
      stage: "presentation_ready",
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      elapsedMs: 0,
      payload: { presentation: missingAssetPresentation },
    });
    await expectVisionError(
      callReview({ ...missing, slot: missingAssetSlot }),
      "MISSING_PNG_ASSET",
    );

    const corruptSlot = visualSlotFor("paths");
    const corrupt = Buffer.from("not a png");
    const corruptHash = hashArtifactBytes(corrupt);
    storeArtifact(
      db,
      { kind: "png", mediaType: "image/png", bytes: corrupt, role: "presentation_full" },
      CREATED_AT,
    );
    insertPngStage(corruptSlot, corruptHash);
    await expectVisionError(
      callReview({ ...missing, slot: corruptSlot }),
      "INVALID_PNG",
    );

    const metadataSlot = visualSlotFor("symmetry");
    const base = visualFixture(visualSlotFor("counting"));
    const tampered = withTextChunk(base.png);
    const tamperedHash = hashArtifactBytes(tampered);
    storeArtifact(
      db,
      { kind: "png", mediaType: "image/png", bytes: tampered, role: "presentation_full" },
      CREATED_AT,
    );
    insertPngStage(metadataSlot, tamperedHash);
    await expectVisionError(
      callReview({ ...missing, slot: metadataSlot }),
      "INVALID_PNG",
    );

    const oversized = Buffer.concat([base.png, Buffer.alloc(MAX_PNG_BYTES)]);
    expect(() =>
      storeArtifact(
        db,
        { kind: "png", mediaType: "image/png", bytes: oversized, role: "presentation_full" },
        CREATED_AT,
      ),
    ).toThrow();

    const wrongShapeSlot = VISUAL_SLOTS.find(
      (slot) => slot.family === "counting" && slot.slotId !== base.slot.slotId,
    );
    if (wrongShapeSlot === undefined) {
      throw new Error("smoke plan has no second counting slot");
    }
    const previewScene = productionRegistry
      .getRenderer("counting")
      .buildScene(
        productionRegistry
          .getEngine("counting")
          .generateSpec(testSeed("wrong-shape"), 1),
      ) as Scene;
    const preview = renderScenePng(previewScene, 512);
    const previewHash = hashArtifactBytes(preview);
    storeArtifact(
      db,
      { kind: "png", mediaType: "image/png", bytes: preview, role: "presentation_preview" },
      CREATED_AT,
    );
    insertPngStage(wrongShapeSlot, previewHash);
    await expectVisionError(
      callReview({ ...missing, slot: wrongShapeSlot }),
      "INVALID_PNG",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects non-vision routes, text slots, and non-presentation stages before a request", async () => {
    const fixture = visualFixture(visualSlotFor("matrix"));
    const wrongRole = await expectVisionError(
      callReview(fixture, { route: blindVisionRoute({ role: "blind_text" }) }),
      "ROUTE_ROLE_MISMATCH",
    );
    expect(wrongRole.logicalCallId).toBeNull();

    const textRoute = await expectVisionError(
      callReview(fixture, { route: blindVisionRoute({ requiresImage: false }) }),
      "INVALID_INPUT",
    );
    expect(textRoute.logicalCallId).toBeNull();

    const textSlot = SMOKE_PLAN.slots.find((slot) => slot.modality === "text");
    if (textSlot === undefined) {
      throw new Error("smoke plan has no text slot");
    }
    const textError = await expectVisionError(
      callReview({ ...fixture, slot: textSlot }),
      "INVALID_INPUT",
    );
    expect(textError.logicalCallId).toBeNull();

    const plannedSlot = visualSlotFor("transforms");
    const plannedError = await expectVisionError(
      callReview({ ...fixture, slot: plannedSlot }),
      "INVALID_STAGE",
    );
    expect(plannedError.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps prompt metadata stable and versioned", () => {
    const first = blindVisionPromptMetadata();
    const second = blindVisionPromptMetadata();
    expect(first).toEqual(second);
    expect(first.promptVersion).toBe("v1");
    expect(first.schemaVersion).toBe("v1");
    expect(first.schemaName).toBe("puzzle_blind_review");
    expect(first.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.schemaHash).toBe(strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA));

    const metadata: BlindVisionPromptMetadata = first;
    const messages = buildBlindVisionMessages(
      {
        question: "Question?",
        rules: {
          domain: "domain",
          closedWorld: "closed",
          target: "target",
          operations: ["op"],
          conventions: [],
        },
        clues: [],
        options: [
          { label: "A", text: "a" },
          { label: "B", text: "b" },
          { label: "C", text: "c" },
          { label: "D", text: "d" },
        ],
      },
      metadata,
      Buffer.from("png"),
    );
    expect(messages[0]?.content).toContain("prompt_version: v1");
    expect(JSON.stringify(messages[1]?.content)).toContain("data:image/png;base64,");
  });
});
