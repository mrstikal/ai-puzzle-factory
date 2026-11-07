import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import {
  BLIND_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
  ALIGNMENT_REVIEW_JSON_SCHEMA,
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  deriveAlignmentOverall,
  type AlignmentFieldName,
  type AlignmentFields,
  type AlignmentReviewResponse,
  type BlindReviewResponse,
} from "../ai/schemas.js";
import { buildChatRequest, MAX_PNG_BYTES, type AiRoleSettings } from "../ai/config.js";
import { createBudgetAccount } from "../ai/budget.js";
import { getOrCreateLogicalCall } from "../ai/ledger.js";
import {
  createOpenRouterTransport,
  type ExecuteOpenRouterCallInput,
  type OpenRouterCallResult,
} from "../ai/openrouter.js";
import type { ResolvedRoute } from "../ai/preflight.js";
import {
  blindTextPromptMetadata,
  buildBlindTextMessages,
  BlindTextPublicPayloadSchema,
} from "../ai/review-text.js";
import {
  blindVisionPromptMetadata,
  buildBlindVisionMessages,
} from "../ai/review-vision.js";
import {
  alignmentPromptMetadata,
  buildAlignmentMessages,
  type AlignmentPayload,
} from "../ai/review-alignment.js";
import {
  ChoiceSetSchema,
} from "../domain/answers.js";
import {
  SolveResultSchema,
  mergeFactInventory,
  ruleFacts,
} from "../families/contracts.js";
import { productionRegistry } from "../families/registry.js";
import { formatOptionText } from "../presentation/assemble.js";
import {
  assertPngDimensions,
  assertPngNoTextMetadata,
  hashPng,
} from "../render/png.js";
import { SCENE_SIZE } from "../render/scene.js";
import { buildMockRoutes } from "../runner/run.js";
import { migrate, openDatabase } from "../storage/database.js";
import type {
  BuiltCalibrationPack,
  CalibrationFixture,
} from "./fixtures.js";
import {
  validateCalibrationLabels,
  type CalibrationLabelRow,
  type CalibrationLabels,
} from "./labels.js";
import {
  BLIND_DEFECT_SIGNALS,
  alignmentFieldForCalibrationField,
  type CalibrationObservation,
} from "./score.js";

export const CALIBRATION_MOCK_MODES = ["oracle", "agree", "reject"] as const;
export type CalibrationMockMode = (typeof CALIBRATION_MOCK_MODES)[number];

export type CalibrationRole =
  | "blind_text"
  | "blind_vision"
  | "alignment_text"
  | "alignment_vision";

export interface CalibrationReviewRequest {
  readonly role: CalibrationRole;
  readonly body: Readonly<Record<string, unknown>>;
  readonly schemaHash: string;
  readonly png: Buffer | null;
  readonly inventoryIds: ReadonlySet<string> | null;
}

interface MockPlan {
  readonly role: CalibrationRole;
  readonly fixture: CalibrationFixture;
  readonly label: CalibrationLabelRow;
  readonly mode: CalibrationMockMode;
}

interface CalibrationMockTransport {
  register(logicalCallId: string, plan: MockPlan): void;
  readonly requests: readonly string[];
  readonly roles: readonly CalibrationRole[];
  executeCall(input: ExecuteOpenRouterCallInput): Promise<OpenRouterCallResult>;
}

export interface RunCalibrationMockInput {
  readonly built: BuiltCalibrationPack;
  readonly labels: CalibrationLabels;
  readonly mode?: CalibrationMockMode;
  readonly clock?: {
    now(): Date;
    sleep?(ms: number): Promise<void>;
  };
}

export interface RunCalibrationMockResult {
  readonly observations: readonly CalibrationObservation[];
  readonly reviewCalls: number;
  readonly generationCalls: 0;
  readonly mockOnly: true;
  readonly transportRequests: number;
  readonly requestRoles: readonly CalibrationRole[];
}

function chatBody(plan: MockPlan, content: unknown): Record<string, unknown> {
  return {
    id: `mock-${plan.role}-${plan.fixture.fixtureId}`,
    model: "mock/model",
    provider: "mock",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify(content),
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost: 0,
    },
  };
}

function createCalibrationMockTransport(
  clock: { now(): Date; sleep?(ms: number): Promise<void> },
): CalibrationMockTransport {
  const plans = new Map<string, MockPlan>();
  const requests: string[] = [];
  const roles: CalibrationRole[] = [];
  const context = new AsyncLocalStorage<string>();
  const fetchImpl: typeof fetch = async (input, _init) => {
    const logicalCallId = context.getStore();
    if (logicalCallId === undefined) {
      throw new Error("calibration mock fetch called outside executeCall");
    }
    const plan = plans.get(logicalCallId);
    if (plan === undefined) {
      throw new Error(`no calibration mock plan for ${logicalCallId}`);
    }
    requests.push(String(input));
    roles.push(plan.role);
    const content =
      plan.role === "blind_text" || plan.role === "blind_vision"
        ? blindContent(plan)
        : alignmentContent(plan);
    return new Response(JSON.stringify(chatBody(plan, content)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const real = createOpenRouterTransport({
    baseUrl: "http://127.0.0.1:1/api/v1",
    fetchImpl,
    random: () => 0,
    deadlineMs: 1000,
    clock: {
      now: clock.now,
      sleep:
        clock.sleep ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    },
  });
  return {
    register(logicalCallId, plan) {
      plans.set(logicalCallId, plan);
    },
    requests,
    roles,
    executeCall(input) {
      return context.run(input.logicalCallId, () => real.executeCall(input));
    },
  };
}

function blindContent(plan: MockPlan): BlindReviewResponse {
  const { fixture, label, mode } = plan;
  const visualLegibility = fixture.modality === "svg" ? "legible" : "not_applicable";
  if (mode === "reject") {
    return {
      answerStatus: "no_unique_answer",
      chosenOption: null,
      reasoning: "Mock reject-all reviewer rejects every presentation.",
      clarity: "unclear",
      ambiguity: "present",
      confidence: 0.5,
      visualLegibility,
      issues: [{ code: "other", evidence: "Mock reject-all scenario." }],
    };
  }
  if (mode === "agree" || label.observedBlindResult === "correct") {
    return {
      answerStatus: "selected",
      chosenOption: fixture.original.choices.correctLabel,
      reasoning: "Mock reviewer selects the original correct option.",
      clarity: "clear",
      ambiguity: "none",
      confidence: 1,
      visualLegibility,
      issues: [],
    };
  }
  const code = label.observedDefectCodes[0];
  const signal = code === undefined ? null : BLIND_DEFECT_SIGNALS[code];
  return {
    answerStatus: "no_unique_answer",
    chosenOption: null,
    reasoning: "Mock oracle detects the labeled visible defect.",
    clarity: "unclear",
    ambiguity: "present",
    confidence: 0.9,
    visualLegibility,
    issues: [
      {
        code: signal?.issueCodes[0] ?? "other",
        evidence: `Mock oracle detected ${code ?? "a visible defect"}.`,
      },
    ],
  };
}

function alignmentFields(modality: "text" | "svg"): AlignmentFields {
  return {
    question: { status: "pass", factIds: [], reason: "Mock pass." },
    rulesAndClues: { status: "pass", factIds: [], reason: "Mock pass." },
    options: { status: "pass", factIds: [], reason: "Mock pass." },
    hint: { status: "pass", factIds: [], reason: "Mock pass." },
    explanation: { status: "pass", factIds: [], reason: "Mock pass." },
    image:
      modality === "text"
        ? { status: "not_applicable", factIds: [], reason: "Text presentation." }
        : { status: "pass", factIds: [], reason: "Mock pass." },
  };
}

function failField(
  reason: string,
  factIds: readonly string[],
): AlignmentFields[AlignmentFieldName] {
  return { status: "fail", factIds: [...factIds], reason };
}

function alignmentContent(plan: MockPlan): AlignmentReviewResponse {
  const { fixture, label, mode } = plan;
  const fields = alignmentFields(fixture.modality);
  if (mode === "reject") {
    for (const field of [
      "question",
      "rulesAndClues",
      "options",
      "hint",
      "explanation",
    ] as const) {
      fields[field] = failField("Mock reject-all scenario.", []);
    }
    if (fixture.modality === "svg") {
      fields.image = failField("Mock reject-all scenario.", []);
    }
    return { fields };
  }
  if (mode === "agree" || label.observedAlignmentResult === "pass") {
    return { fields };
  }
  const mapped = new Set<AlignmentFieldName>();
  for (const field of label.observedFailingFields) {
    const alignmentField = alignmentFieldForCalibrationField(field, fixture.modality);
    if (alignmentField !== null) {
      mapped.add(alignmentField);
    }
  }
  for (const fieldName of mapped) {
    const factIds =
      fieldName === "rulesAndClues" ? label.observedFactIds : [];
    fields[fieldName] = failField(
      "Mock oracle detects the labeled failing field.",
      factIds,
    );
  }
  return { fields };
}

function validatePng(fixture: CalibrationFixture, bytes: Buffer | null): Buffer {
  if (bytes === null) {
    throw new Error(`${fixture.fixtureId} has no visible PNG artifact`);
  }
  if (bytes.length > MAX_PNG_BYTES) {
    throw new Error(`${fixture.fixtureId} PNG exceeds the review limit`);
  }
  if (fixture.pngHash === null || hashPng(bytes) !== fixture.pngHash) {
    throw new Error(`${fixture.fixtureId} PNG hash does not match the pack`);
  }
  assertPngNoTextMetadata(bytes);
  assertPngDimensions(bytes, SCENE_SIZE, SCENE_SIZE);
  return bytes;
}

function buildAlignmentPayload(
  fixture: CalibrationFixture,
): { readonly payload: AlignmentPayload; readonly inventoryIds: ReadonlySet<string> } {
  const engine = productionRegistry.getEngine(fixture.family);
  const spec = engine.schema.parse(fixture.original.spec);
  const solve = SolveResultSchema.parse(fixture.original.solveResult);
  const choices = ChoiceSetSchema.parse(fixture.original.choices);
  if (solve.proof === null) {
    throw new Error(`${fixture.fixtureId} has no proof`);
  }
  const correctChoice = choices.choices.find(
    (choice) => choice.label === choices.correctLabel,
  );
  if (correctChoice === undefined) {
    throw new Error(`${fixture.fixtureId} has no correct choice`);
  }
  const inventory = mergeFactInventory(
    ruleFacts(engine.visibleRules(spec)),
    engine.facts(spec),
    solve.proof.facts,
  );
  return {
    payload: {
      family: fixture.family,
      modality: fixture.modality,
      difficulty: fixture.difficulty,
      dsl: spec,
      proof: solve.proof,
      correctOption: {
        label: correctChoice.label,
        value: correctChoice.value,
        text: formatOptionText(fixture.family, correctChoice.label, correctChoice.value),
      },
      options: choices.choices.map((choice) => ({
        label: choice.label,
        value: choice.value,
        text: formatOptionText(fixture.family, choice.label, choice.value),
      })),
      visible: {
        question: fixture.visible.question,
        rules: fixture.visible.rules,
        clues: fixture.visible.clues.map((clue) => ({
          factId: clue.factId,
          text: clue.text,
        })),
        options: fixture.visible.options.map((option) => ({
          label: option.label,
          text: option.text,
        })),
      },
      wording: {
        hint: fixture.original.reveal.hint,
        explanationSteps: fixture.original.reveal.explanationSteps,
      },
      inventory,
    },
    inventoryIds: new Set(inventory.map((fact) => fact.factId)),
  };
}

function settingsFor(route: ResolvedRoute): AiRoleSettings | undefined {
  return Object.keys(route.settings).length > 0 ? route.settings : undefined;
}

async function executeCalibrationCall(input: {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly transport: CalibrationMockTransport;
  readonly clock: { now(): Date };
  readonly probeKey: string;
  readonly role: CalibrationRole;
  readonly route: ResolvedRoute;
  readonly requestBody: unknown;
  readonly schemaHash: string;
  readonly plan: MockPlan;
}): Promise<{ readonly response: unknown | null; readonly error: string | null }> {
  const createdAt = input.clock.now().toISOString();
  const call = getOrCreateLogicalCall(input.db, {
    runId: null,
    slotId: null,
    probeKey: input.probeKey,
    role: input.role,
    runKind: "calibration",
    requestBody: input.requestBody,
    expectedSchemaHash: input.schemaHash,
    model: input.route.model,
    routingPolicy: "balanced",
    outputCapField: input.route.outputCapField,
    createdAt,
  });
  input.transport.register(call.logicalCallId, input.plan);
  const result = await input.transport.executeCall({
    db: input.db,
    accountId: input.accountId,
    logicalCallId: call.logicalCallId,
    apiKey: "mock-offline-key",
    reservationUsd: "0",
    nonBilling: true,
  });
  if (result.outcome !== "success" || result.parsedContent === null) {
    return {
      response: null,
      error: result.error?.message ?? `calibration call outcome ${result.outcome}`,
    };
  }
  return { response: result.parsedContent, error: null };
}

export function buildBlindPayload(
  fixture: CalibrationFixture,
): ReturnType<typeof BlindTextPublicPayloadSchema.parse> {
  return BlindTextPublicPayloadSchema.parse({
    question: fixture.visible.question,
    rules: fixture.visible.rules,
    clues: fixture.visible.clues.map((clue) => clue.text),
    options: fixture.visible.options.map((option) => ({
      label: option.label,
      text: option.text,
    })),
  });
}

function assertRouteRole(route: ResolvedRoute, role: CalibrationRole): void {
  if (route.role !== role) {
    throw new Error(`calibration route ${route.role} cannot serve ${role}`);
  }
}

export function buildBlindReviewRequest(
  fixture: CalibrationFixture,
  entry: BuiltCalibrationPack["fixtures"][number],
  route: ResolvedRoute,
): CalibrationReviewRequest {
  const svg = fixture.modality === "svg";
  const role: CalibrationRole = svg ? "blind_vision" : "blind_text";
  assertRouteRole(route, role);
  const metadata = svg ? blindVisionPromptMetadata() : blindTextPromptMetadata();
  const png = svg
    ? validatePng(fixture, entry.artifacts.visible.png)
    : null;
  const payload = buildBlindPayload(fixture);
  const messages = svg
    ? buildBlindVisionMessages(payload, metadata, png as Buffer)
    : buildBlindTextMessages(payload, metadata);
  const settings = settingsFor(route);
  const built = buildChatRequest({
    role,
    model: route.model,
    outputCapField: route.outputCapField,
    maxOutputTokens: route.maxOutputTokens,
    messages,
    responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    ...(settings === undefined ? {} : { settings }),
  });
  return {
    role,
    body: built.body,
    schemaHash: built.schemaHash,
    png,
    inventoryIds: null,
  };
}

export function buildAlignmentReviewRequest(
  fixture: CalibrationFixture,
  entry: BuiltCalibrationPack["fixtures"][number],
  route: ResolvedRoute,
): CalibrationReviewRequest {
  const svg = fixture.modality === "svg";
  const role: CalibrationRole = svg ? "alignment_vision" : "alignment_text";
  assertRouteRole(route, role);
  const { payload, inventoryIds } = buildAlignmentPayload(fixture);
  const metadata = alignmentPromptMetadata(fixture.modality);
  const png = svg
    ? validatePng(fixture, entry.artifacts.visible.png)
    : null;
  const messages = buildAlignmentMessages(payload, metadata, png);
  const settings = settingsFor(route);
  const built = buildChatRequest({
    role,
    model: route.model,
    outputCapField: route.outputCapField,
    maxOutputTokens: route.maxOutputTokens,
    messages,
    responseFormat: ALIGNMENT_REVIEW_JSON_SCHEMA,
    ...(settings === undefined ? {} : { settings }),
  });
  return {
    role,
    body: built.body,
    schemaHash: built.schemaHash,
    png,
    inventoryIds,
  };
}

export function formatZodIssues(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): string {
  return issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? "$" : issue.path.map(String).join(".")}: ${issue.message}`,
    )
    .join("; ");
}

export function parseBlindReviewResponse(
  fixture: CalibrationFixture,
  response: unknown,
): { readonly response: BlindReviewResponse | null; readonly error: string | null } {
  const parsed = BLIND_REVIEW_RESPONSE_SCHEMA.safeParse(response);
  if (!parsed.success) {
    return {
      response: null,
      error: `blind response does not satisfy the strict schema: ${formatZodIssues(parsed.error.issues)}`,
    };
  }
  if (
    fixture.modality === "text" &&
    parsed.data.visualLegibility !== "not_applicable"
  ) {
    return { response: null, error: "text blind response has an image legibility status" };
  }
  if (
    fixture.modality === "svg" &&
    parsed.data.visualLegibility === "not_applicable"
  ) {
    return { response: null, error: "SVG blind response has no image legibility status" };
  }
  return { response: parsed.data, error: null };
}

export function parseAlignmentReviewResponse(
  fixture: CalibrationFixture,
  response: unknown,
  inventoryIds: ReadonlySet<string>,
): { readonly response: AlignmentReviewResponse | null; readonly error: string | null } {
  const parsed = ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse(response);
  if (!parsed.success) {
    return {
      response: null,
      error: `alignment response does not satisfy the strict schema: ${formatZodIssues(parsed.error.issues)}`,
    };
  }
  for (const field of Object.values(parsed.data.fields)) {
    for (const factId of field.factIds) {
      if (!inventoryIds.has(factId)) {
        return {
          response: null,
          error: `alignment response cites unknown fact ${factId}`,
        };
      }
    }
  }
  try {
    deriveAlignmentOverall(parsed.data.fields, fixture.modality);
  } catch (error) {
    return {
      response: null,
      error: error instanceof Error ? error.message : "invalid alignment field applicability",
    };
  }
  return { response: parsed.data, error: null };
}

async function runBlind(input: {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly transport: CalibrationMockTransport;
  readonly clock: { now(): Date };
  readonly fixture: CalibrationFixture;
  readonly entry: BuiltCalibrationPack["fixtures"][number];
  readonly label: CalibrationLabelRow;
  readonly mode: CalibrationMockMode;
  readonly routes: ReturnType<typeof buildMockRoutes>;
}): Promise<{ readonly response: unknown | null; readonly error: string | null }> {
  const route =
    input.fixture.modality === "svg"
      ? input.routes.blindVision
      : input.routes.blindText;
  const request = buildBlindReviewRequest(input.fixture, input.entry, route);
  const result = await executeCalibrationCall({
    db: input.db,
    accountId: input.accountId,
    transport: input.transport,
    clock: input.clock,
    probeKey: input.fixture.fixtureId,
    role: request.role,
    route,
    requestBody: request.body,
    schemaHash: request.schemaHash,
    plan: {
      role: request.role,
      fixture: input.fixture,
      label: input.label,
      mode: input.mode,
    },
  });
  if (result.error !== null || result.response === null) {
    return result;
  }
  return parseBlindReviewResponse(input.fixture, result.response);
}

async function runAlignment(input: {
  readonly db: Database.Database;
  readonly accountId: string;
  readonly transport: CalibrationMockTransport;
  readonly clock: { now(): Date };
  readonly fixture: CalibrationFixture;
  readonly entry: BuiltCalibrationPack["fixtures"][number];
  readonly label: CalibrationLabelRow;
  readonly mode: CalibrationMockMode;
  readonly routes: ReturnType<typeof buildMockRoutes>;
}): Promise<{ readonly response: unknown | null; readonly error: string | null }> {
  const route =
    input.fixture.modality === "svg"
      ? input.routes.alignmentVision
      : input.routes.alignmentText;
  const request = buildAlignmentReviewRequest(input.fixture, input.entry, route);
  if (request.inventoryIds === null) {
    throw new Error(`${input.fixture.fixtureId} alignment request has no fact inventory`);
  }
  const result = await executeCalibrationCall({
    db: input.db,
    accountId: input.accountId,
    transport: input.transport,
    clock: input.clock,
    probeKey: input.fixture.fixtureId,
    role: request.role,
    route,
    requestBody: request.body,
    schemaHash: request.schemaHash,
    plan: {
      role: request.role,
      fixture: input.fixture,
      label: input.label,
      mode: input.mode,
    },
  });
  if (result.error !== null || result.response === null) {
    return result;
  }
  return parseAlignmentReviewResponse(
    input.fixture,
    result.response,
    request.inventoryIds,
  );
}

export async function runCalibrationMock(
  input: RunCalibrationMockInput,
): Promise<RunCalibrationMockResult> {
  const mode = input.mode ?? "oracle";
  if (!CALIBRATION_MOCK_MODES.includes(mode)) {
    throw new Error(`unsupported calibration mock mode ${mode}`);
  }
  validateCalibrationLabels({
    labels: input.labels,
    pack: input.built.pack,
    mode: "mock",
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const labelsByFixture = new Map(
    input.labels.rows.map((row) => [row.fixtureId, row]),
  );
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const clock = input.clock ?? {
      now: () => new Date(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const accountId = "calibration-mock";
    createBudgetAccount(db, {
      accountId,
      runKind: "calibration",
      maxCostUsd: "0",
      createdAt: clock.now().toISOString(),
    });
    const transport = createCalibrationMockTransport(clock);
    const routes = buildMockRoutes();
    const observations: CalibrationObservation[] = [];
    let reviewCalls = 0;
    for (const entry of input.built.fixtures) {
      const fixture = entry.fixture;
      const label = labelsByFixture.get(fixture.fixtureId);
      if (label === undefined) {
        throw new Error(`missing label for ${fixture.fixtureId}`);
      }
      const blind = await runBlind({
        db,
        accountId,
        transport,
        clock,
        fixture,
        entry,
        label,
        mode,
        routes,
      });
      reviewCalls += 1;
      const alignment = await runAlignment({
        db,
        accountId,
        transport,
        clock,
        fixture,
        entry,
        label,
        mode,
        routes,
      });
      reviewCalls += 1;
      observations.push({
        fixtureId: fixture.fixtureId,
        blind,
        alignment,
      });
    }
    return {
      observations,
      reviewCalls,
      generationCalls: 0,
      mockOnly: true,
      transportRequests: transport.requests.length,
      requestRoles: transport.roles,
    };
  } finally {
    db.close();
  }
}
