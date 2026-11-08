import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createOpenRouterTransport,
  type ExecuteOpenRouterCallInput,
  type OpenRouterClock,
} from "./openrouter.js";
import { getLogicalCall } from "./ledger.js";
import {
  getDesignerSlot,
  getSlot,
  getStageResult,
} from "../storage/repository.js";
import {
  buildDesignerMockResponse,
  designerMockSlotIdForScenario,
  DesignerMockScenarioSchema,
  type DesignerMockScenario,
} from "../design/mock.js";
import {
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
} from "./schemas.js";
import {
  MODALITY_BY_FAMILY,
  REQUEST_ROLES,
  FamilySchema,
  type Difficulty,
  type Family,
  type RequestRole,
} from "../domain/experiment.js";
import {
  CHOICE_LABELS,
  ChoiceLabelSchema,
  type ChoiceLabel,
} from "../domain/answers.js";
import { productionRegistry } from "../families/registry.js";
import { makeFixtureWording } from "../presentation/wording.js";
import { hashCanonicalJson } from "../util/hash.js";

export const MOCK_SCENARIO_KINDS = [
  "valid",
  "wrong_answer",
  "schema_invalid",
  "refusal",
  "http_error",
  "timeout",
] as const;
export type MockScenarioKind = (typeof MOCK_SCENARIO_KINDS)[number];

const DifficultySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const MockScenarioSchema = z
  .strictObject({
    role: z.enum(REQUEST_ROLES),
    family: FamilySchema,
    difficulty: DifficultySchema,
    seed: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(MOCK_SCENARIO_KINDS),
  })
  .superRefine((scenario, ctx) => {
    const modality = MODALITY_BY_FAMILY[scenario.family];
    if (
      (scenario.role === "blind_text" || scenario.role === "alignment_text") &&
      modality !== "text"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "text roles require a text family",
      });
    }
    if (
      (scenario.role === "blind_vision" || scenario.role === "alignment_vision") &&
      modality !== "svg"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "vision roles require an SVG family",
      });
    }
    if (
      scenario.kind === "wrong_answer" &&
      (scenario.role === "spec" || scenario.role === "wording")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "wrong_answer applies only to review roles",
      });
    }
  });

export type MockScenario = z.infer<typeof MockScenarioSchema>;

const MockFixtureSchema = z.strictObject({
  version: z.literal(1),
  valid: z.strictObject({
    blind: BLIND_REVIEW_RESPONSE_SCHEMA,
    alignmentText: ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
    alignmentVision: ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  }),
  failures: z.strictObject({
    schemaInvalid: z.unknown(),
    refusal: z.strictObject({
      finishReason: z.string().min(1),
      refusal: z.string().min(1).nullable(),
    }),
    httpError: z.strictObject({
      status: z.number().int().min(400).max(599),
      body: z.unknown(),
    }),
    timeout: z.strictObject({}),
  }),
});

export type MockFixture = z.infer<typeof MockFixtureSchema>;

export type MockTransportErrorCode =
  | "FIXTURE_INVALID"
  | "INVALID_SCENARIO"
  | "MISSING_SCENARIO"
  | "DUPLICATE_SCENARIO"
  | "CONCURRENT_CALL";

export class MockTransportError extends Error {
  readonly code: MockTransportErrorCode;

  constructor(
    code: MockTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MockTransportError";
    this.code = code;
  }
}

export interface MockRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface MockTransport
  extends ReturnType<typeof createOpenRouterTransport> {
  readonly isMock: true;
  readonly requests: readonly MockRequest[];
  registerScenario(logicalCallId: string, scenario: MockScenario): void;
  registerDesignerScenario(
    logicalCallId: string,
    scenario: DesignerMockScenario,
  ): void;
  getDesignerScenario(logicalCallId: string): DesignerMockScenario | null;
  clearScenarios(): void;
  clear(): void;
}

function loadFixture(): MockFixture {
  let raw: string;
  try {
    raw = readFileSync(
      new URL("../../tests/fixtures/mock/role-responses.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    throw new MockTransportError(
      "FIXTURE_INVALID",
      "cannot read mock role-responses fixture",
      { cause: error },
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new MockTransportError(
      "FIXTURE_INVALID",
      "mock role-responses fixture is not valid JSON",
      { cause: error },
    );
  }
  const parsed = MockFixtureSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new MockTransportError(
      "FIXTURE_INVALID",
      "mock role-responses fixture does not satisfy its schema",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

const MOCK_FIXTURE = loadFixture();

function wrongLabel(label: ChoiceLabel): ChoiceLabel {
  const index = CHOICE_LABELS.indexOf(label);
  return CHOICE_LABELS[(index + 1) % CHOICE_LABELS.length] ?? "A";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function slotCorrectLabel(
  db: Database.Database,
  logicalCallId: string,
): ChoiceLabel | null {
  const call = getLogicalCall(db, logicalCallId);
  if (call.runId === null || call.slotId === null) {
    return null;
  }
  try {
    const stage = getStageResult(db, call.runId, call.slotId, "presentation_ready");
    if (!isRecord(stage.payload) || !isRecord(stage.payload.presentation)) {
      return null;
    }
    const reveal = stage.payload.presentation.reveal;
    if (!isRecord(reveal)) {
      return null;
    }
    const parsed = ChoiceLabelSchema.safeParse(reveal.correctLabel);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildMockContent(
  scenario: MockScenario,
  fixture: MockFixture = MOCK_FIXTURE,
  oracleLabel: ChoiceLabel | null = null,
): unknown {
  const parsed = MockScenarioSchema.safeParse(scenario);
  if (!parsed.success) {
    throw new MockTransportError(
      "INVALID_SCENARIO",
      "mock scenario does not satisfy its schema",
      { cause: parsed.error },
    );
  }
  const value = parsed.data;
  if (value.kind === "schema_invalid") {
    return fixture.failures.schemaInvalid;
  }
  if (
    value.kind === "refusal" ||
    value.kind === "http_error" ||
    value.kind === "timeout"
  ) {
    throw new MockTransportError(
      "INVALID_SCENARIO",
      `scenario kind ${value.kind} has no JSON content`,
    );
  }
  const engine = productionRegistry.getEngine(value.family);
  const spec = engine.generateSpec(value.seed, value.difficulty);
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new MockTransportError(
      "INVALID_SCENARIO",
      `mock ${value.family} engine produced no answer`,
    );
  }
  const choices = engine.makeOptions(
    spec,
    solve.correctAnswer,
    hashCanonicalJson(spec),
  );
  switch (value.role) {
    case "spec":
      return { family: value.family, spec };
    case "wording":
      return makeFixtureWording(engine, spec).response;
    case "blind_text":
    case "blind_vision": {
      const correctLabel = oracleLabel ?? choices.correctLabel;
      const chosenOption =
        value.kind === "wrong_answer"
          ? wrongLabel(correctLabel)
          : correctLabel;
      return {
        ...fixture.valid.blind,
        chosenOption,
        visualLegibility:
          value.role === "blind_vision" ? "legible" : "not_applicable",
      };
    }
    case "alignment_text":
    case "alignment_vision": {
      const base =
        value.role === "alignment_text"
          ? fixture.valid.alignmentText
          : fixture.valid.alignmentVision;
      if (value.kind !== "wrong_answer") {
        return base;
      }
      return {
        ...base,
        fields: {
          ...base.fields,
          options: {
            ...base.fields.options,
            status: "fail" as const,
            reason: "Mock wrong-answer scenario.",
          },
        },
      };
    }
  }
}

function chatBody(
  scenario: { readonly role: string; readonly seed: string; readonly [key: string]: unknown },
  content: unknown,
  finishReason: string,
  refusal: string | null,
): Record<string, unknown> {
  return {
    id: `mock-${scenario.role}-${scenario.seed.slice(0, 8)}`,
    model: "mock/model",
    provider: "mock",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content === null ? null : JSON.stringify(content),
          ...(refusal === null ? {} : { refusal }),
        },
        finish_reason: finishReason,
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === null || signal === undefined) {
      reject(new Error("mock timeout has no abort signal"));
      return;
    }
    if (signal.aborted) {
      reject(new Error("mock timeout"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("mock timeout"));
      },
      { once: true },
    );
  });
}

export interface CreateMockTransportOptions {
  readonly db: Database.Database;
  readonly clock?: OpenRouterClock;
  readonly random?: () => number;
  readonly deadlineMs?: number;
  readonly maxResponseBytes?: number;
  readonly afterResponseSaved?: (attemptId: string) => Promise<void> | void;
}

export function createMockTransport(
  options: CreateMockTransportOptions,
): MockTransport {
  const scenarios = new Map<string, MockScenario>();
  const designerScenarios = new Map<string, DesignerMockScenario>();
  const requests: MockRequest[] = [];
  const callContext = new AsyncLocalStorage<string>();
  let activeCalls = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const logicalCallId = callContext.getStore();
    if (logicalCallId === undefined) {
      throw new MockTransportError(
        "MISSING_SCENARIO",
        "mock fetch was called outside an executeCall",
      );
    }
    const scenario = scenarios.get(logicalCallId);
    const designerScenario = designerScenarios.get(logicalCallId);
    if (scenario === undefined && designerScenario === undefined) {
      throw new MockTransportError(
        "MISSING_SCENARIO",
        `no mock scenario is registered for logical call ${logicalCallId}`,
      );
    }
    requests.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });

    if (designerScenario !== undefined) {
      const built = buildDesignerMockResponse(designerScenario);
      if (built.failure?.kind === "generation_error") {
        return jsonResponse(
          200,
          chatBody(
            { role: "design", seed: logicalCallId, family: designerScenario.family, difficulty: designerScenario.difficulty, kind: "refusal" },
            null,
            MOCK_FIXTURE.failures.refusal.finishReason,
            MOCK_FIXTURE.failures.refusal.refusal,
          ),
        );
      }
      return jsonResponse(
        200,
        chatBody(
          {
            role: "design",
            seed: logicalCallId,
            family: designerScenario.family,
            difficulty: designerScenario.difficulty,
            kind: "valid",
          },
          built.proposal,
          "stop",
          null,
        ),
      );
    }
    if (scenario === undefined) {
      throw new MockTransportError(
        "MISSING_SCENARIO",
        `no mock scenario is registered for logical call ${logicalCallId}`,
      );
    }

    if (scenario.kind === "timeout") {
      await waitForAbort(init?.signal);
    }
    if (scenario.kind === "http_error") {
      return jsonResponse(
        MOCK_FIXTURE.failures.httpError.status,
        MOCK_FIXTURE.failures.httpError.body,
      );
    }
    if (scenario.kind === "refusal") {
      return jsonResponse(
        200,
        chatBody(
          scenario,
          null,
          MOCK_FIXTURE.failures.refusal.finishReason,
          MOCK_FIXTURE.failures.refusal.refusal,
        ),
      );
    }
    return jsonResponse(
      200,
      chatBody(
        scenario,
        buildMockContent(
          scenario,
          MOCK_FIXTURE,
          slotCorrectLabel(options.db, logicalCallId),
        ),
        "stop",
        null,
      ),
    );
  };

  const real = createOpenRouterTransport({
    baseUrl: "http://127.0.0.1:1/api/v1",
    fetchImpl,
    random: options.random ?? (() => 0),
    deadlineMs: options.deadlineMs ?? 1000,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.afterResponseSaved === undefined
      ? {}
      : { afterResponseSaved: options.afterResponseSaved }),
  });

  const executeCall = async (
    input: ExecuteOpenRouterCallInput,
  ): ReturnType<typeof real.executeCall> => {
    if (
      !scenarios.has(input.logicalCallId) &&
      !designerScenarios.has(input.logicalCallId)
    ) {
      throw new MockTransportError(
        "MISSING_SCENARIO",
        `no mock scenario is registered for logical call ${input.logicalCallId}`,
      );
    }
    if (activeCalls >= 2) {
      throw new MockTransportError(
        "CONCURRENT_CALL",
        "the deterministic mock transport supports at most two active calls",
      );
    }
    activeCalls += 1;
    try {
      return await callContext.run(input.logicalCallId, () =>
        real.executeCall(input),
      );
    } finally {
      activeCalls -= 1;
    }
  };

  return {
    ...real,
    executeCall,
    isMock: true as const,
    requests,
    registerScenario: (logicalCallId, scenario) => {
      const parsed = MockScenarioSchema.safeParse(scenario);
      if (!parsed.success) {
        throw new MockTransportError(
          "INVALID_SCENARIO",
          "mock scenario does not satisfy its schema",
          { cause: parsed.error },
        );
      }
      const call = getLogicalCall(options.db, logicalCallId);
      if (call.runId === null || call.slotId === null) {
        throw new MockTransportError(
          "INVALID_SCENARIO",
          "mock scenarios require a full or smoke logical call with a slot",
        );
      }
      const slot = getSlot(options.db, call.runId, call.slotId);
      if (
        call.role !== parsed.data.role ||
        slot.family !== parsed.data.family ||
        slot.difficulty !== parsed.data.difficulty
      ) {
        throw new MockTransportError(
          "INVALID_SCENARIO",
          `scenario ${parsed.data.role}/${parsed.data.family}/${parsed.data.difficulty} does not match call ${call.role}/${slot.family}/${slot.difficulty}`,
        );
      }
      if (scenarios.has(logicalCallId)) {
        throw new MockTransportError(
          "DUPLICATE_SCENARIO",
          `a mock scenario is already registered for logical call ${logicalCallId}`,
        );
      }
      scenarios.set(logicalCallId, parsed.data);
    },
    registerDesignerScenario: (logicalCallId, scenario) => {
      const parsed = DesignerMockScenarioSchema.safeParse(scenario);
      if (!parsed.success) {
        throw new MockTransportError(
          "INVALID_SCENARIO",
          "designer mock scenario does not satisfy its schema",
          { cause: parsed.error },
        );
      }
      const call = getLogicalCall(options.db, logicalCallId);
      if (call.runId === null || call.slotId === null) {
        throw new MockTransportError(
          "INVALID_SCENARIO",
          "designer mock scenarios require a designer logical call with a slot",
        );
      }
      const slot = getDesignerSlot(options.db, call.runId, call.slotId);
      const expectedSlotId = designerMockSlotIdForScenario(parsed.data);
      const expectedRole =
        parsed.data.attemptIndex === 0
          ? "design"
          : parsed.data.attemptIndex === 1
            ? "design_repair_1"
            : "design_repair_2";
      if (
        call.slotId !== expectedSlotId ||
        call.role !== expectedRole ||
        slot.family !== parsed.data.family ||
        slot.difficulty !== parsed.data.difficulty
      ) {
        throw new MockTransportError(
          "INVALID_SCENARIO",
          `designer scenario ${parsed.data.assignmentId}/${parsed.data.arm}/${parsed.data.attemptIndex} does not match call ${call.role}/${call.slotId}`,
        );
      }
      const existing = designerScenarios.get(logicalCallId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed.data)) {
          throw new MockTransportError(
            "DUPLICATE_SCENARIO",
            `a different designer mock scenario is already registered for logical call ${logicalCallId}`,
          );
        }
        return;
      }
      designerScenarios.set(logicalCallId, parsed.data);
    },
    getDesignerScenario: (logicalCallId) =>
      designerScenarios.get(logicalCallId) ?? null,
    clearScenarios: () => {
      scenarios.clear();
      designerScenarios.clear();
    },
    clear: () => {
      scenarios.clear();
      designerScenarios.clear();
      requests.length = 0;
    },
  };
}

export function mockScenarioForFamily(
  role: RequestRole,
  family: Family,
  difficulty: Difficulty,
  seed: string,
  kind: MockScenarioKind = "valid",
): MockScenario {
  return MockScenarioSchema.parse({ role, family, difficulty, seed, kind });
}
