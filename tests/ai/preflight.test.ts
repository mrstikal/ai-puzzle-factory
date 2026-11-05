import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ALIGNMENT_REVIEW_JSON_SCHEMA,
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  AlignmentContractError,
  BLIND_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
  FAMILY_SPEC_JSON_SCHEMAS,
  StrictSchemaError,
  WORDING_JSON_SCHEMA,
  assertStrictJsonSchema,
  compileStrictJsonSchema,
  deriveAlignmentOverall,
  familySpecEnvelopeJsonSchema,
  familySpecJsonSchema,
  strictSchemaHash,
  type AlignmentFieldStatus,
  type AlignmentFields,
  type StrictJsonSchema,
} from "../../src/ai/schemas.js";
import {
  AiConfigError,
  OutputCapFieldSchema,
  buildChatRequest,
  readLiveEnvironment,
  type AiRoleSettings,
  type LiveEnvironmentConfig,
} from "../../src/ai/config.js";
import {
  DEFAULT_MIN_PROMPT_TOKENS,
  PreflightError,
  buildLiveProbePlan,
  fetchCatalogForModels,
  fixtureRoleRequests,
  parseRecordedCatalog,
  runOfflinePreflight,
  runPreflightOnCatalog,
  type PreflightFailureCode,
  type PreflightReport,
  type ResolvedRoute,
  type RolePreflightRequest,
} from "../../src/ai/preflight.js";
import { FAMILIES, type RequestRole } from "../../src/domain/experiment.js";
import { main as preflightMain } from "../../src/cli/preflight.js";

interface FixtureEndpoint {
  tag: string;
  provider_name?: string | null;
  status?: number | null;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  max_prompt_tokens?: number | null;
  supported_parameters?: string[];
  pricing?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FixtureModel {
  id: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  endpoints?: FixtureEndpoint[];
  [key: string]: unknown;
}

interface FixtureRole {
  role: RequestRole;
  model: string;
  provider: string;
}

interface FixtureCatalog {
  models: FixtureModel[];
  offline_fixture_roles?: FixtureRole[];
  [key: string]: unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rawFixture(): FixtureCatalog {
  return JSON.parse(
    readFileSync(
      new URL("../fixtures/openrouter/catalog.json", import.meta.url),
      "utf8",
    ),
  ) as FixtureCatalog;
}

function fixture(): FixtureCatalog {
  return clone(rawFixture());
}

function fixtureModel(catalog: FixtureCatalog, id: string): FixtureModel {
  const model = catalog.models.find((candidate) => candidate.id === id);
  if (model === undefined) {
    throw new Error(`fixture model ${id} is missing`);
  }
  return model;
}

function fixtureEndpoint(
  catalog: FixtureCatalog,
  modelId: string,
  tag: string,
): FixtureEndpoint {
  const model = fixtureModel(catalog, modelId);
  const endpoint = model.endpoints?.find((candidate) => candidate.tag === tag);
  if (endpoint === undefined) {
    throw new Error(`fixture endpoint ${modelId}/${tag} is missing`);
  }
  return endpoint;
}

function baseRoles(catalog: FixtureCatalog): RolePreflightRequest[] {
  return (catalog.offline_fixture_roles ?? []).map((role) => ({
    role: role.role,
    model: role.model,
    providerTag: role.provider,
  }));
}

function replaceRole(
  roles: readonly RolePreflightRequest[],
  role: RequestRole,
  patch: Partial<RolePreflightRequest>,
): RolePreflightRequest[] {
  return roles.map((candidate) =>
    candidate.role === role ? { ...candidate, ...patch } : candidate,
  );
}

function run(
  catalog: FixtureCatalog,
  roles: readonly RolePreflightRequest[] = baseRoles(catalog),
): PreflightReport {
  return runOfflinePreflight({ catalog, roles });
}

function roleResult(report: PreflightReport, role: RequestRole) {
  const result = report.roles.find((candidate) => candidate.role === role);
  if (result === undefined) {
    throw new Error(`report role ${role} is missing`);
  }
  return result;
}

function expectFailure(
  report: PreflightReport,
  code: PreflightFailureCode,
  role: RequestRole | null,
): void {
  expect(
    report.failures.some(
      (failure) => failure.code === code && failure.role === role,
    ),
  ).toBe(true);
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

function expectAllObjectsStrict(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((item) => expectAllObjectsStrict(item));
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "object" || record.properties !== undefined) {
    expect(record.additionalProperties).toBe(false);
    const properties = record.properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      throw new Error("object properties must be a record");
    }
    const required = record.required;
    expect(Array.isArray(required)).toBe(true);
    if (Array.isArray(required)) {
      for (const name of required) {
        expect(properties).toHaveProperty(name);
      }
      for (const name of Object.keys(properties)) {
        expect(required).toContain(name);
      }
    }
  }
  if (Array.isArray(record.items)) {
    throw new Error("tuple items are not provider-compatible");
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child !== null && typeof child === "object") {
      for (const property of Object.values(child)) {
        expectAllObjectsStrict(property);
      }
    } else if (key === "$defs" && child !== null && typeof child === "object") {
      for (const definition of Object.values(child)) {
        expectAllObjectsStrict(definition);
      }
    } else if (key !== "required" && key !== "$ref") {
      expectAllObjectsStrict(child);
    }
  }
}

function validBlindReview() {
  return {
    answerStatus: "selected" as const,
    chosenOption: "A" as const,
    reasoning: "The visible clues force option A.",
    clarity: "clear" as const,
    ambiguity: "none" as const,
    confidence: 0.8,
    visualLegibility: "not_applicable" as const,
    issues: [],
  };
}

function alignmentField(status: AlignmentFieldStatus) {
  return {
    status,
    factIds: ["f001"],
    reason: "The cited deterministic fact supports this status.",
  };
}

function alignmentFields(
  status: AlignmentFieldStatus,
  imageStatus: AlignmentFieldStatus,
): AlignmentFields {
  return {
    question: alignmentField(status),
    rulesAndClues: alignmentField(status),
    options: alignmentField(status),
    hint: alignmentField(status),
    explanation: alignmentField(status),
    image: alignmentField(imageStatus),
  };
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    OPENROUTER_API_KEY: "test-inference-key",
    GENERATOR_MODEL: "fixture/generator-text",
    GENERATOR_PROVIDER: "fixture-generator/turbo",
    REVIEWER_MODEL: "fixture/reviewer-text",
    REVIEWER_PROVIDER: "fixture-reviewer/text",
    VISION_REVIEWER_MODEL: "fixture/reviewer-vision",
    VISION_REVIEWER_PROVIDER: "fixture-vision",
  };
}

function resolvedRoutes(report: PreflightReport): ResolvedRoute[] {
  return report.roles
    .map((role) => role.resolved)
    .filter((route): route is ResolvedRoute => route !== null);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

describe("strict provider JSON schemas", () => {
  it("compiles every family, wording, blind, and alignment schema", () => {
    const formats = [
      ...Object.values(FAMILY_SPEC_JSON_SCHEMAS),
      WORDING_JSON_SCHEMA,
      BLIND_REVIEW_JSON_SCHEMA,
      ALIGNMENT_REVIEW_JSON_SCHEMA,
      ...FAMILIES.map((family) => familySpecJsonSchema(family)),
      ...FAMILIES.map((family) => familySpecEnvelopeJsonSchema(family)),
    ];
    for (const format of formats) {
      expect(format.strict).toBe(true);
      expect(format.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      assertStrictJsonSchema(format.schema);
      expectAllObjectsStrict(format.schema);
      const serialized = JSON.stringify(format.schema);
      expect(serialized).not.toContain('"$schema"');
      expect(serialized).not.toContain('"oneOf"');
      expect(serialized).not.toContain('"const"');
      expect(serialized).not.toContain('"additionalItems"');
      expect(strictSchemaHash(format)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("keeps schema hashes stable and format-specific", () => {
    const first = strictSchemaHash(WORDING_JSON_SCHEMA);
    const second = strictSchemaHash(WORDING_JSON_SCHEMA);
    expect(first).toBe(second);
    expect(first).not.toBe(strictSchemaHash(BLIND_REVIEW_JSON_SCHEMA));
  });

  it("rejects invalid schema names and unrepresentable loose objects", () => {
    const badName = captureError(() =>
      compileStrictJsonSchema("bad name", z.strictObject({ value: z.string() })),
    );
    expect(badName).toBeInstanceOf(StrictSchemaError);
    expect((badName as StrictSchemaError).code).toBe("INVALID_SCHEMA_NAME");

    const loose = captureError(() =>
      compileStrictJsonSchema(
        "loose_object",
        z.object({ value: z.record(z.string(), z.string()) }),
      ),
    );
    expect(loose).toBeInstanceOf(StrictSchemaError);
    expect((loose as StrictSchemaError).code).toBe("UNSUPPORTED_SCHEMA_KEYWORD");
  });

  it("enforces the blind review contract and rejects extra fields", () => {
    expect(BLIND_REVIEW_RESPONSE_SCHEMA.safeParse(validBlindReview()).success).toBe(
      true,
    );
    expect(
      BLIND_REVIEW_RESPONSE_SCHEMA.safeParse({
        ...validBlindReview(),
        chosenOption: null,
      }).success,
    ).toBe(false);
    expect(
      BLIND_REVIEW_RESPONSE_SCHEMA.safeParse({
        ...validBlindReview(),
        answerStatus: "no_unique_answer",
        chosenOption: "A",
      }).success,
    ).toBe(false);
    expect(
      BLIND_REVIEW_RESPONSE_SCHEMA.safeParse({
        ...validBlindReview(),
        extra: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      BLIND_REVIEW_RESPONSE_SCHEMA.safeParse({
        ...validBlindReview(),
        confidence: 1.1,
      }).success,
    ).toBe(false);
    expect(
      BLIND_REVIEW_RESPONSE_SCHEMA.safeParse({
        ...validBlindReview(),
        issues: [{ code: "made_up", evidence: "evidence" }],
      }).success,
    ).toBe(false);
  });

  it("computes alignment overall from fields and ignores model-reported overall", () => {
    const passing = alignmentFields("pass", "not_applicable");
    expect(deriveAlignmentOverall(passing, "text")).toBe("pass");

    const parsed = ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse({
      overall: "pass",
      fields: alignmentFields("fail", "not_applicable"),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(deriveAlignmentOverall(parsed.data.fields, "text")).toBe("fail");
    }

    const modelSaysFail = ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse({
      overall: "fail",
      fields: alignmentFields("pass", "not_applicable"),
    });
    expect(modelSaysFail.success).toBe(true);
    if (modelSaysFail.success) {
      expect(deriveAlignmentOverall(modelSaysFail.data.fields, "text")).toBe(
        "pass",
      );
    }

    const improperTextImage = captureError(() =>
      deriveAlignmentOverall(alignmentFields("pass", "pass"), "text"),
    );
    expect(improperTextImage).toBeInstanceOf(AlignmentContractError);
    expect((improperTextImage as AlignmentContractError).code).toBe(
      "IMPROPER_NOT_APPLICABLE",
    );

    const improperSvgImage = captureError(() =>
      deriveAlignmentOverall(alignmentFields("pass", "not_applicable"), "svg"),
    );
    expect(improperSvgImage).toBeInstanceOf(AlignmentContractError);

    const uncertainSvg = alignmentFields("pass", "uncertain");
    expect(deriveAlignmentOverall(uncertainSvg, "svg")).toBe("uncertain");

    expect(
      ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse({
        overall: "pass",
        fields: alignmentFields("pass", "not_applicable"),
        extra: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("keeps the wording schema strict", () => {
    expect(WORDING_JSON_SCHEMA.schema.additionalProperties).toBe(false);
    expect(WORDING_JSON_SCHEMA.schema.required).toEqual([
      "question",
      "clueTexts",
      "hint",
      "explanationSteps",
    ]);
  });
});

describe("live configuration", () => {
  it("requires an explicit inference key and model/provider values", () => {
    const missingKey = captureError(() => readLiveEnvironment({}));
    expect(missingKey).toBeInstanceOf(AiConfigError);
    expect((missingKey as AiConfigError).code).toBe("MISSING_INFERENCE_KEY");

    const env = validEnvironment();
    env.GENERATOR_MODEL = "";
    const missingModel = captureError(() => readLiveEnvironment(env));
    expect(missingModel).toBeInstanceOf(AiConfigError);
    expect((missingModel as AiConfigError).code).toBe("MISSING_MODEL");
    expect((missingModel as AiConfigError).field).toBe("GENERATOR_MODEL");

    const providerEnv = validEnvironment();
    providerEnv.REVIEWER_PROVIDER = " ";
    const missingProvider = captureError(() => readLiveEnvironment(providerEnv));
    expect(missingProvider).toBeInstanceOf(AiConfigError);
    expect((missingProvider as AiConfigError).code).toBe("MISSING_PROVIDER");
    expect((missingProvider as AiConfigError).field).toBe("REVIEWER_PROVIDER");
  });

  it("rejects wildcard providers and role-separation violations", () => {
    const wildcard = validEnvironment();
    wildcard.GENERATOR_PROVIDER = "fixture-generator/*";
    const wildcardError = captureError(() => readLiveEnvironment(wildcard));
    expect(wildcardError).toBeInstanceOf(AiConfigError);
    expect((wildcardError as AiConfigError).code).toBe("INVALID_ENV_VALUE");

    const sameGeneratorAndReviewer = validEnvironment();
    sameGeneratorAndReviewer.REVIEWER_MODEL = "fixture/generator-text";
    const separation = captureError(() =>
      readLiveEnvironment(sameGeneratorAndReviewer),
    );
    expect(separation).toBeInstanceOf(AiConfigError);
    expect((separation as AiConfigError).code).toBe(
      "ROLE_SEPARATION_VIOLATION",
    );

    const sameGeneratorAndVision = validEnvironment();
    sameGeneratorAndVision.VISION_REVIEWER_MODEL = "fixture/generator-text";
    const visionSeparation = captureError(() =>
      readLiveEnvironment(sameGeneratorAndVision),
    );
    expect(visionSeparation).toBeInstanceOf(AiConfigError);
    expect((visionSeparation as AiConfigError).code).toBe(
      "ROLE_SEPARATION_VIOLATION",
    );
  });

  it("allows the vision reviewer to reuse the text reviewer and discloses correlations", () => {
    const env = validEnvironment();
    env.VISION_REVIEWER_MODEL = "fixture/reviewer-text";
    env.VISION_REVIEWER_PROVIDER = "fixture-reviewer/text";
    const config: LiveEnvironmentConfig = readLiveEnvironment(env);
    expect(config.visionReviewer.model).toBe(config.reviewer.model);
    expect(config.correlations).toContain(
      "vision_reviewer_uses_text_reviewer_model",
    );
    expect(config.correlations).toContain(
      "text_and_vision_reviewers_share_provider",
    );
  });

  it("serializes exactly one output cap field and exact provider routing", () => {
    const base = {
      role: "spec" as const,
      model: "fixture/generator-text",
      providerTag: "fixture-generator/turbo",
      maxOutputTokens: 8192,
      messages: [{ role: "user" as const, content: "Return JSON." }],
      responseFormat: FAMILY_SPEC_JSON_SCHEMAS.ranking,
    };
    const maxTokens = buildChatRequest({
      ...base,
      outputCapField: "max_tokens",
    });
    expect(maxTokens.body.max_tokens).toBe(8192);
    expect(maxTokens.body).not.toHaveProperty("max_completion_tokens");
    expect(maxTokens.body.provider).toEqual({
      only: ["fixture-generator/turbo"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(maxTokens.body.stream).toBe(false);
    expect(maxTokens.body).not.toHaveProperty("models");
    expect(maxTokens.body).not.toHaveProperty("tools");
    expect(maxTokens.body).not.toHaveProperty("plugins");
    expect(maxTokens.body).not.toHaveProperty("route");

    const completionTokens = buildChatRequest({
      ...base,
      outputCapField: "max_completion_tokens",
    });
    expect(completionTokens.body.max_completion_tokens).toBe(8192);
    expect(completionTokens.body).not.toHaveProperty("max_tokens");

    const invalidCap = captureError(() =>
      buildChatRequest({
        ...base,
        outputCapField: "max_output_tokens" as unknown as "max_tokens",
      }),
    );
    expect(invalidCap).toBeInstanceOf(AiConfigError);
    expect((invalidCap as AiConfigError).code).toBe("INVALID_OUTPUT_CAP");

    const missingCap = captureError(() =>
      buildChatRequest({
        ...base,
        outputCapField: "max_tokens",
        maxOutputTokens: 0,
      }),
    );
    expect(missingCap).toBeInstanceOf(AiConfigError);
    expect((missingCap as AiConfigError).code).toBe("INVALID_OUTPUT_CAP");
  });

  it("includes only explicitly configured supported settings", () => {
    const base = {
      role: "wording" as const,
      model: "fixture/generator-text",
      providerTag: "fixture-generator/turbo",
      outputCapField: "max_tokens" as const,
      maxOutputTokens: 8192,
      messages: [{ role: "user" as const, content: "Return JSON." }],
      responseFormat: WORDING_JSON_SCHEMA,
    };
    const absent = buildChatRequest(base);
    expect(absent.body).not.toHaveProperty("temperature");
    expect(absent.body).not.toHaveProperty("seed");
    expect(absent.body).not.toHaveProperty("reasoning");

    const settings: AiRoleSettings = { temperature: 0.2, seed: 7, reasoning: true };
    const present = buildChatRequest({ ...base, settings });
    expect(present.body.temperature).toBe(0.2);
    expect(present.body.seed).toBe(7);
    expect(present.body.reasoning).toBe(true);
    expect(OutputCapFieldSchema.parse("max_tokens")).toBe("max_tokens");
  });

  it("binds image parts to vision roles only", () => {
    const textBase = {
      role: "blind_text" as const,
      model: "fixture/reviewer-text",
      providerTag: "fixture-reviewer/text",
      outputCapField: "max_tokens" as const,
      maxOutputTokens: 4096,
      responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    };
    const visionWithoutImage = captureError(() =>
      buildChatRequest({
        ...textBase,
        role: "blind_vision",
        model: "fixture/reviewer-vision",
        providerTag: "fixture-vision",
        outputCapField: "max_completion_tokens",
        messages: [{ role: "user", content: "No image here." }],
      }),
    );
    expect(visionWithoutImage).toBeInstanceOf(AiConfigError);
    expect((visionWithoutImage as AiConfigError).code).toBe("INVALID_REQUEST");

    const textWithImage = captureError(() =>
      buildChatRequest({
        ...textBase,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Unexpected image." },
              { type: "image_url", image_url: { url: PNG_DATA_URL } },
            ],
          },
        ],
      }),
    );
    expect(textWithImage).toBeInstanceOf(AiConfigError);
    expect((textWithImage as AiConfigError).code).toBe("INVALID_REQUEST");
  });
});

describe("offline preflight route validation", () => {
  it("accepts the recorded fixture and freezes cap fields per role", () => {
    const report = run(fixture());
    expect(report.mode).toBe("offline");
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.roles).toHaveLength(6);
    expect(roleResult(report, "spec").resolved?.outputCapField).toBe(
      "max_tokens",
    );
    expect(roleResult(report, "blind_vision").resolved?.outputCapField).toBe(
      "max_completion_tokens",
    );
    expect(roleResult(report, "blind_vision").notes).toContain(
      "vision_probe_required",
    );
    expect(roleResult(report, "spec").resolved?.minPromptTokens).toBe(
      DEFAULT_MIN_PROMPT_TOKENS.text,
    );
    expect(roleResult(report, "blind_vision").resolved?.minPromptTokens).toBe(
      DEFAULT_MIN_PROMPT_TOKENS.vision,
    );
    expect(
      Object.keys(report.schemaHashes).every((key) => key.includes(":")),
    ).toBe(true);
  });

  it("reports an unavailable model", () => {
    const catalog = fixture();
    const report = run(
      catalog,
      replaceRole(baseRoles(catalog), "spec", { model: "fixture/missing" }),
    );
    expect(report.ok).toBe(false);
    expectFailure(report, "MODEL_NOT_FOUND", "spec");
  });

  it("rejects a base provider slug when only variant tags exist", () => {
    const catalog = fixture();
    const report = run(
      catalog,
      replaceRole(baseRoles(catalog), "spec", {
        providerTag: "fixture-generator",
      }),
    );
    expect(report.ok).toBe(false);
    expectFailure(report, "PROVIDER_TAG_BASE_WILDCARD", "spec");
  });

  it("rejects duplicate exact provider tags", () => {
    const catalog = fixture();
    const model = fixtureModel(catalog, "fixture/generator-text");
    const endpoint = fixtureEndpoint(
      catalog,
      "fixture/generator-text",
      "fixture-generator/turbo",
    );
    model.endpoints?.push(clone(endpoint));
    const report = run(catalog);
    expect(report.ok).toBe(false);
    expectFailure(report, "PROVIDER_TAG_AMBIGUOUS", "spec");
  });

  it("rejects an inactive endpoint", () => {
    const catalog = fixture();
    fixtureEndpoint(
      catalog,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).status = 1;
    const report = run(catalog);
    expect(report.ok).toBe(false);
    expectFailure(report, "ENDPOINT_INACTIVE", "spec");
  });

  it("names missing structured-output and cap capabilities", () => {
    const noStructured = fixture();
    const structuredEndpoint = fixtureEndpoint(
      noStructured,
      "fixture/generator-text",
      "fixture-generator/turbo",
    );
    structuredEndpoint.supported_parameters = (
      structuredEndpoint.supported_parameters ?? []
    ).filter((parameter) => parameter !== "structured_outputs");
    const structuredReport = run(noStructured);
    expect(structuredReport.ok).toBe(false);
    expectFailure(structuredReport, "MISSING_STRUCTURED_OUTPUTS", "spec");

    const noCap = fixture();
    const capEndpoint = fixtureEndpoint(
      noCap,
      "fixture/generator-text",
      "fixture-generator/turbo",
    );
    capEndpoint.supported_parameters = (
      capEndpoint.supported_parameters ?? []
    ).filter(
      (parameter) =>
        parameter !== "max_tokens" && parameter !== "max_completion_tokens",
    );
    const capReport = run(noCap);
    expect(capReport.ok).toBe(false);
    expectFailure(capReport, "MISSING_OUTPUT_CAP_FIELD", "spec");
  });

  it("rejects insufficient output, context, and prompt limits", () => {
    const outputLimited = fixture();
    fixtureEndpoint(
      outputLimited,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).max_completion_tokens = 1024;
    const outputReport = run(outputLimited);
    expectFailure(outputReport, "OUTPUT_LIMIT_TOO_SMALL", "spec");

    const missingOutputLimit = fixture();
    fixtureEndpoint(
      missingOutputLimit,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).max_completion_tokens = null;
    const missingOutputReport = run(missingOutputLimit);
    expectFailure(
      missingOutputReport,
      "MISSING_MAX_COMPLETION_TOKENS",
      "spec",
    );

    const contextLimited = fixture();
    fixtureEndpoint(
      contextLimited,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).context_length = 8192;
    const contextReport = run(contextLimited);
    expectFailure(contextReport, "CONTEXT_LIMIT_TOO_SMALL", "spec");

    const promptLimited = fixture();
    fixtureEndpoint(
      promptLimited,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).max_prompt_tokens = 1024;
    const promptReport = run(promptLimited);
    expectFailure(promptReport, "PROMPT_LIMIT_TOO_SMALL", "spec");
  });

  it("does not pass an image route from a multimodal-sounding name alone", () => {
    const catalog = fixture();
    const model = fixtureModel(catalog, "fixture/reviewer-vision");
    model.name = "Fixture Omni Vision 9000";
    if (model.architecture === undefined) {
      throw new Error("fixture vision architecture is missing");
    }
    model.architecture.input_modalities = ["text"];
    const report = run(catalog);
    expect(report.ok).toBe(false);
    expectFailure(report, "MISSING_IMAGE_INPUT_MODALITY", "blind_vision");
  });

  it("rejects unknown, invalid, and unsupported pricing", () => {
    const unknown = fixture();
    const unknownPricing = fixtureEndpoint(
      unknown,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).pricing;
    if (unknownPricing === undefined) {
      throw new Error("fixture pricing is missing");
    }
    delete unknownPricing.completion;
    const unknownReport = run(unknown);
    expectFailure(unknownReport, "UNKNOWN_PRICING", "spec");

    const invalid = fixture();
    const invalidPricing = fixtureEndpoint(
      invalid,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).pricing;
    if (invalidPricing === undefined) {
      throw new Error("fixture pricing is missing");
    }
    invalidPricing.completion = "-0.1";
    const invalidReport = run(invalid);
    expectFailure(invalidReport, "INVALID_PRICING", "spec");

    const overrides = fixture();
    const overridePricing = fixtureEndpoint(
      overrides,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).pricing;
    if (overridePricing === undefined) {
      throw new Error("fixture pricing is missing");
    }
    overridePricing.overrides = {};
    const overrideReport = run(overrides);
    expectFailure(overrideReport, "UNSUPPORTED_PRICING", "spec");
  });

  it("requires an image price or a documented conservative reserve", () => {
    const catalog = fixture();
    const pricing = fixtureEndpoint(
      catalog,
      "fixture/reviewer-vision",
      "fixture-vision",
    ).pricing;
    if (pricing === undefined) {
      throw new Error("fixture pricing is missing");
    }
    delete pricing.image;
    const withoutReserve = run(catalog);
    expect(withoutReserve.ok).toBe(false);
    expectFailure(withoutReserve, "UNKNOWN_IMAGE_PRICING", "blind_vision");

    const rolesWithReserve = replaceRole(
      replaceRole(baseRoles(catalog), "blind_vision", {
        imagePricingReserveUsd: "0.01",
      }),
      "alignment_vision",
      { imagePricingReserveUsd: "0.01" },
    );
    const withReserve = run(catalog, rolesWithReserve);
    expect(withReserve.ok).toBe(true);
    expect(roleResult(withReserve, "blind_vision").notes).toContain(
      "image_pricing_conservative_reserve",
    );
  });

  it("rejects settings the exact endpoint does not advertise", () => {
    const catalog = fixture();
    const report = run(
      catalog,
      replaceRole(baseRoles(catalog), "blind_vision", {
        settings: { temperature: 0.2 },
      }),
    );
    expect(report.ok).toBe(false);
    expectFailure(report, "UNSUPPORTED_SETTING", "blind_vision");
  });

  it("rejects generator/reviewer model overlap", () => {
    const catalog = fixture();
    const report = run(
      catalog,
      replaceRole(baseRoles(catalog), "blind_text", {
        model: "fixture/generator-text",
        providerTag: "fixture-generator/turbo",
      }),
    );
    expect(report.ok).toBe(false);
    expectFailure(report, "ROLE_SEPARATION_VIOLATION", null);
  });

  it("uses no network and needs no inference key offline", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const report = run(fixture());
      expect(report.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
      fetchSpy.mockRestore();
    }
  });

  it("rejects an invalid role response schema", () => {
    const catalog = fixture();
    const invalid: StrictJsonSchema = {
      ...WORDING_JSON_SCHEMA,
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    };
    const report = run(
      catalog,
      replaceRole(baseRoles(catalog), "wording", {
        responseFormat: invalid,
      }),
    );
    expect(report.ok).toBe(false);
    expectFailure(report, "INVALID_ROLE_SCHEMA", "wording");
  });

  it("parses fixture roles into preflight requests", () => {
    const catalog = parseRecordedCatalog(rawFixture());
    expect(catalog.models).toHaveLength(3);
    expect(fixtureRoleRequests(catalog)).toHaveLength(6);
  });
});

describe("public catalog fetch", () => {
  it("fails closed on 403 without a management credential or retry", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(JSON.stringify({ error: { message: "forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const error = await captureAsyncError(() =>
      fetchCatalogForModels({
        apiKey: "inference-key",
        modelIds: ["fixture/generator-text"],
        fetchImpl,
      }),
    );
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as PreflightError).code).toBe("CATALOG_FORBIDDEN");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      throw new Error("fetch was not called");
    }
    const init = call[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer inference-key");
    expect(JSON.stringify(headers).toLowerCase()).not.toContain("management");
  });

  it("merges model architecture with exact endpoint data", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/models")) {
          return jsonResponse({
            data: [
              {
                id: "fixture/generator-text",
                name: "Fixture Generator Text",
                architecture: { input_modalities: ["text"] },
              },
            ],
          });
        }
        return jsonResponse({
          data: {
            name: "Fixture Generator Text",
            architecture: { input_modalities: ["text"] },
            endpoints: [
              {
                tag: "fixture-generator/turbo",
                provider_name: "Fixture Generator Turbo",
                status: 0,
                context_length: 131072,
                max_completion_tokens: 16384,
                supported_parameters: [
                  "structured_outputs",
                  "max_tokens",
                ],
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
            ],
          },
        });
      },
    );
    const catalog = await fetchCatalogForModels({
      apiKey: "inference-key",
      modelIds: ["fixture/generator-text"],
      fetchImpl,
    });
    expect(catalog.models[0]?.endpoints[0]?.tag).toBe(
      "fixture-generator/turbo",
    );
    const report = runPreflightOnCatalog(catalog, [
      {
        role: "spec",
        model: "fixture/generator-text",
        providerTag: "fixture-generator/turbo",
      },
    ]);
    expect(report.ok).toBe(true);
  });
});

describe("live probe authorization", () => {
  function routes(): ResolvedRoute[] {
    const report = run(fixture());
    expect(report.ok).toBe(true);
    return resolvedRoutes(report);
  }

  it("requires explicit paid authorization, a positive budget, and an inference key", () => {
    const denied = captureError(() =>
      buildLiveProbePlan({
        allowPaid: false,
        maxCostUsd: "0.50",
        apiKey: "inference-key",
        routes: routes(),
        visionPngDataUrl: PNG_DATA_URL,
      }),
    );
    expect(denied).toBeInstanceOf(PreflightError);
    expect((denied as PreflightError).code).toBe("LIVE_PROBE_NOT_AUTHORIZED");

    const zeroBudget = captureError(() =>
      buildLiveProbePlan({
        allowPaid: true,
        maxCostUsd: "0",
        apiKey: "inference-key",
        routes: routes(),
        visionPngDataUrl: PNG_DATA_URL,
      }),
    );
    expect(zeroBudget).toBeInstanceOf(PreflightError);
    expect((zeroBudget as PreflightError).code).toBe("INVALID_LIVE_BUDGET");

    const noKey = captureError(() =>
      buildLiveProbePlan({
        allowPaid: true,
        maxCostUsd: "0.50",
        apiKey: " ",
        routes: routes(),
        visionPngDataUrl: PNG_DATA_URL,
      }),
    );
    expect(noKey).toBeInstanceOf(PreflightError);
    expect((noKey as PreflightError).code).toBe("MISSING_INFERENCE_KEY");

    const noPng = captureError(() =>
      buildLiveProbePlan({
        allowPaid: true,
        maxCostUsd: "0.50",
        apiKey: "inference-key",
        routes: routes(),
        visionPngDataUrl: null,
      }),
    );
    expect(noPng).toBeInstanceOf(PreflightError);
    expect((noPng as PreflightError).code).toBe("MISSING_PROBE_PNG");
  });

  it("builds three bounded probes without executing them", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const plan = buildLiveProbePlan({
      allowPaid: true,
      maxCostUsd: "0.50",
      apiKey: "inference-key",
      routes: routes(),
      visionPngDataUrl: PNG_DATA_URL,
    });
    expect(plan.probes).toHaveLength(3);
    expect(plan.probes.map((probe) => probe.role)).toEqual([
      "spec",
      "blind_text",
      "blind_vision",
    ]);
    const generator = plan.probes[0];
    const vision = plan.probes[2];
    if (generator === undefined || vision === undefined) {
      throw new Error("live probe plan is incomplete");
    }
    expect(generator.body).toHaveProperty("max_tokens", 8192);
    expect(generator.body).not.toHaveProperty("max_completion_tokens");
    expect(vision.body).toHaveProperty("max_completion_tokens", 4096);
    expect(vision.body).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(vision.body)).toContain("image_url");
    expect(JSON.stringify(vision.body)).toContain("data:image/png;base64,");
    for (const probe of plan.probes) {
      expect(probe.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects non-separated resolved routes", () => {
    const report = run(fixture());
    const routes = resolvedRoutes(report);
    const reviewer = routes.find((route) => route.role === "blind_text");
    if (reviewer === undefined) {
      throw new Error("reviewer route is missing");
    }
    const mixed = routes.map((route) =>
      route.role === "spec" ? { ...route, model: reviewer.model } : route,
    );
    const error = captureError(() =>
      buildLiveProbePlan({
        allowPaid: true,
        maxCostUsd: "0.50",
        apiKey: "inference-key",
        routes: mixed,
        visionPngDataUrl: PNG_DATA_URL,
      }),
    );
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as PreflightError).code).toBe("INVALID_LIVE_PROBE_ROUTES");
  });
});

describe("preflight CLI", () => {
  it("validates the recorded fixture offline", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = await preflightMain(["node", "preflight", "--offline"]);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    write.mockRestore();
    expect(code).toBe(0);
    expect(output).toContain("mode: offline");
    expect(output).toContain("network: not used");
    expect(output).toContain("result: ok");
    expect(output).not.toContain("inference_key: required");
  });

  it("rejects invalid flag combinations and live execution in P25", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    expect(await preflightMain(["node", "preflight"])).toBe(1);
    expect(
      await preflightMain(["node", "preflight", "--offline", "--live"]),
    ).toBe(1);
    expect(
      await preflightMain([
        "node",
        "preflight",
        "--offline",
        "--allow-paid",
        "--max-cost",
        "0.50",
      ]),
    ).toBe(1);
    expect(
      await preflightMain([
        "node",
        "preflight",
        "--live",
        "--allow-paid",
        "--max-cost",
        "0.50",
      ]),
    ).toBe(1);
    stderr.mockRestore();
  });
});
