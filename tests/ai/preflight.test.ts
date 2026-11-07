import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { constructRankingSpec } from "../../src/families/ranking/engine.js";
import {
  AiConfigError,
  assertNoForbiddenRequestFields,
  buildChatRequest,
  defaultMaxOutputTokensFor,
  readLiveEnvironment,
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
  conservativeReservationUsd,
  runPreflightOnCatalog,
  validateProbeContent,
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

function fixtureEndpoints(
  catalog: FixtureCatalog,
  modelId: string,
): FixtureEndpoint[] {
  return fixtureModel(catalog, modelId).endpoints ?? [];
}

function baseRoles(catalog: FixtureCatalog): RolePreflightRequest[] {
  return (catalog.offline_fixture_roles ?? []).map((role) => ({
    role: role.role,
    model: role.model,
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
    REVIEWER_MODEL: "fixture/reviewer-text",
    VISION_REVIEWER_MODEL: "fixture/reviewer-vision",
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

  it("derives alignment overall from fields and rejects a model-reported overall", () => {
    const passing = alignmentFields("pass", "not_applicable");
    expect(deriveAlignmentOverall(passing, "text")).toBe("pass");

    const parsed = ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse({
      fields: alignmentFields("fail", "not_applicable"),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(deriveAlignmentOverall(parsed.data.fields, "text")).toBe("fail");
    }

    expect(
      ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse({
        overall: "pass",
        fields: alignmentFields("pass", "not_applicable"),
      }).success,
    ).toBe(false);

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
  it("requires an explicit inference key and model values without provider IDs", () => {
    const missingKey = captureError(() => readLiveEnvironment({}));
    expect(missingKey).toBeInstanceOf(AiConfigError);
    expect((missingKey as AiConfigError).code).toBe("MISSING_INFERENCE_KEY");

    const env = validEnvironment();
    env.GENERATOR_MODEL = "";
    const missingModel = captureError(() => readLiveEnvironment(env));
    expect(missingModel).toBeInstanceOf(AiConfigError);
    expect((missingModel as AiConfigError).code).toBe("MISSING_MODEL");
    expect((missingModel as AiConfigError).field).toBe("GENERATOR_MODEL");

    const config = readLiveEnvironment(validEnvironment());
    expect(config.generator.model).toBe("fixture/generator-text");
    expect(config.reviewer.model).toBe("fixture/reviewer-text");
    expect(config.alignmentText.model).toBe("fixture/reviewer-text");
    expect(config.correlations).toContain("alignment_text_uses_reviewer_model");
    expect(config.visionReviewer.model).toBe("fixture/reviewer-vision");
  });

  it("rejects wildcard models and role-separation violations", () => {
    const wildcard = validEnvironment();
    wildcard.GENERATOR_MODEL = "fixture/*";
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

    const sameGeneratorAndAlignment = validEnvironment();
    sameGeneratorAndAlignment.ALIGNMENT_TEXT_MODEL = "fixture/generator-text";
    const alignmentSeparation = captureError(() =>
      readLiveEnvironment(sameGeneratorAndAlignment),
    );
    expect(alignmentSeparation).toBeInstanceOf(AiConfigError);
    expect((alignmentSeparation as AiConfigError).code).toBe(
      "ROLE_SEPARATION_VIOLATION",
    );
  });

  it("routes alignment_text to a separate model and discloses correlations", () => {
    const env = validEnvironment();
    env.ALIGNMENT_TEXT_MODEL = "fixture/alignment-text";
    const config = readLiveEnvironment(env);
    expect(config.alignmentText.model).toBe("fixture/alignment-text");
    expect(config.correlations).not.toContain(
      "alignment_text_uses_reviewer_model",
    );
  });

  it("allows the vision reviewer to reuse the text reviewer and discloses model correlations", () => {
    const env = validEnvironment();
    env.VISION_REVIEWER_MODEL = "fixture/reviewer-text";
    const config: LiveEnvironmentConfig = readLiveEnvironment(env);
    expect(config.visionReviewer.model).toBe(config.reviewer.model);
    expect(config.correlations).toContain(
      "vision_reviewer_uses_text_reviewer_model",
    );
    expect(config.correlations).toContain(
      "text_and_vision_reviewers_share_model_author",
    );
  });

  it("serializes exactly one output cap field and Balanced provider routing", () => {
    const base = {
      role: "spec" as const,
      model: "fixture/generator-text",
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
      allow_fallbacks: true,
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

    const nitro = captureError(() =>
      buildChatRequest({
        ...base,
        model: "fixture/generator-text:nitro",
        outputCapField: "max_tokens",
      }),
    );
    expect(nitro).toBeInstanceOf(AiConfigError);
    expect((nitro as AiConfigError).code).toBe("INVALID_REQUEST");

    const floor = captureError(() =>
      buildChatRequest({
        ...base,
        model: "fixture/generator-text:floor",
        outputCapField: "max_tokens",
      }),
    );
    expect(floor).toBeInstanceOf(AiConfigError);
    expect((floor as AiConfigError).code).toBe("INVALID_REQUEST");
  });

  it("serializes reasoning effort without a boolean reasoning field", () => {
    const built = buildChatRequest({
      role: "blind_text",
      model: "fixture/vision",
      maxOutputTokens: 4096,
      messages: [{ role: "user", content: "Return JSON." }],
      responseFormat: BLIND_REVIEW_JSON_SCHEMA,
      outputCapField: "max_tokens",
      settings: { reasoningEffort: "low" },
    });
    expect(built.body.reasoning_effort).toBe("low");
    expect(built.body).not.toHaveProperty("reasoning");
  });

  it("rejects provider selectors in a hand-built request", () => {
    const base = {
      role: "spec" as const,
      model: "fixture/generator-text",
      maxOutputTokens: 8192,
      messages: [{ role: "user" as const, content: "Return JSON." }],
      responseFormat: FAMILY_SPEC_JSON_SCHEMAS.ranking,
    };
    const built = buildChatRequest({ ...base, outputCapField: "max_tokens" });
    const withSelector = {
      ...built.body,
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        sort: "price",
      },
    };
    const error = captureError(() =>
      assertNoForbiddenRequestFields(withSelector),
    );
    expect(error).toBeInstanceOf(AiConfigError);
    expect((error as AiConfigError).code).toBe("INVALID_REQUEST");
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

  it("uses model-level Balanced routing without provider IDs", () => {
    const catalog = fixture();
    const report = run(catalog);
    expect(report.ok).toBe(true);
    const spec = roleResult(report, "spec").resolved;
    expect(spec?.routingPolicy).toBe("balanced");
    expect(spec?.compatibleEndpointTags).toEqual([
      "fixture-generator/turbo",
    ]);
    expect(spec?.outputCapField).toBe("max_tokens");
    expect(roleResult(report, "spec").notes).toContain(
      "balanced_provider_fallback_enabled",
    );
    const reservation = conservativeReservationUsd(
      roleResult(report, "spec").resolved as NonNullable<
        ReturnType<typeof roleResult>["resolved"]
      >,
    );
    expect(reservation).toMatch(/^\d+\.\d+$/);
    expect(Number(reservation)).toBeGreaterThan(0);
  });

  it("accepts provider removal and addition without pinning", () => {
    const removed = fixture();
    fixtureEndpoint(
      removed,
      "fixture/generator-text",
      "fixture-generator/turbo",
    ).status = 1;
    const removedReport = run(removed);
    expect(removedReport.ok).toBe(true);
    const removedSpec = roleResult(removedReport, "spec").resolved;
    expect(removedSpec?.compatibleEndpointTags).toEqual([
      "fixture-generator/plus",
    ]);
    expect(removedSpec?.outputCapField).toBe("max_completion_tokens");

    const added = fixture();
    const endpoint = fixtureEndpoint(
      added,
      "fixture/generator-text",
      "fixture-generator/turbo",
    );
    added.models
      .find((model) => model.id === "fixture/generator-text")
      ?.endpoints?.push({
        ...clone(endpoint),
        tag: "fixture-generator/new",
        provider_name: "Fixture New",
      });
    const addedReport = run(added);
    expect(addedReport.ok).toBe(true);
    expect(roleResult(addedReport, "spec").resolved?.compatibleEndpointTags).toEqual(
      ["fixture-generator/new", "fixture-generator/turbo"],
    );
  });

  it("fails only when no active compatible endpoint remains", () => {
    const inactive = fixture();
    for (const endpoint of fixtureEndpoints(inactive, "fixture/generator-text")) {
      endpoint.status = 1;
    }
    const inactiveReport = run(inactive);
    expect(inactiveReport.ok).toBe(false);
    expectFailure(inactiveReport, "NO_ACTIVE_ENDPOINT", "spec");

    const noStructured = fixture();
    for (const endpoint of fixtureEndpoints(
      noStructured,
      "fixture/generator-text",
    )) {
      endpoint.supported_parameters = (
        endpoint.supported_parameters ?? []
      ).filter((parameter) => parameter !== "structured_outputs");
    }
    const structuredReport = run(noStructured);
    expect(structuredReport.ok).toBe(false);
    expectFailure(structuredReport, "MISSING_STRUCTURED_OUTPUTS", "spec");
  });

  it("names missing cap capability when every compatible endpoint lacks it", () => {
    const catalog = fixture();
    for (const endpoint of fixtureEndpoints(catalog, "fixture/generator-text")) {
      endpoint.supported_parameters = (
        endpoint.supported_parameters ?? []
      ).filter(
        (parameter) =>
          parameter !== "max_tokens" && parameter !== "max_completion_tokens",
      );
    }
    const report = run(catalog);
    expect(report.ok).toBe(false);
    expectFailure(report, "MISSING_OUTPUT_CAP_FIELD", "spec");
  });

  it("rejects insufficient output, context, and prompt limits when all endpoints fail", () => {
    const outputLimited = fixture();
    for (const endpoint of fixtureEndpoints(
      outputLimited,
      "fixture/generator-text",
    )) {
      endpoint.max_completion_tokens = 1024;
    }
    expectFailure(run(outputLimited), "OUTPUT_LIMIT_TOO_SMALL", "spec");

    const missingOutputLimit = fixture();
    for (const endpoint of fixtureEndpoints(
      missingOutputLimit,
      "fixture/generator-text",
    )) {
      endpoint.max_completion_tokens = null;
    }
    expectFailure(
      run(missingOutputLimit),
      "MISSING_MAX_COMPLETION_TOKENS",
      "spec",
    );

    const contextLimited = fixture();
    for (const endpoint of fixtureEndpoints(
      contextLimited,
      "fixture/generator-text",
    )) {
      endpoint.context_length = 8192;
    }
    expectFailure(run(contextLimited), "CONTEXT_LIMIT_TOO_SMALL", "spec");

    const promptLimited = fixture();
    for (const endpoint of fixtureEndpoints(
      promptLimited,
      "fixture/generator-text",
    )) {
      endpoint.max_prompt_tokens = 1024;
    }
    expectFailure(run(promptLimited), "PROMPT_LIMIT_TOO_SMALL", "spec");
  });

  it("uses conservative pricing across all compatible endpoints", () => {
    const catalog = fixture();
    const endpoint = fixtureEndpoint(
      catalog,
      "fixture/generator-text",
      "fixture-generator/turbo",
    );
    catalog.models
      .find((model) => model.id === "fixture/generator-text")
      ?.endpoints?.push({
        ...clone(endpoint),
        tag: "fixture-generator/premium",
        provider_name: "Fixture Premium",
        pricing: { ...endpoint.pricing, completion: "0.000099" },
      });
    const report = run(catalog);
    expect(report.ok).toBe(true);
    expect(roleResult(report, "spec").resolved?.compatibleEndpointTags).toEqual([
      "fixture-generator/premium",
      "fixture-generator/turbo",
    ]);
    expect(roleResult(report, "spec").resolved?.pricing.completion).toBe(
      "0.000099",
    );

    const tiny = fixture();
    const tinyEndpoint = fixtureEndpoint(
      tiny,
      "fixture/generator-text",
      "fixture-generator/turbo",
    );
    if (tinyEndpoint.pricing !== undefined) {
      tinyEndpoint.pricing.completion = "0.0000005";
    }
    const tinyReport = run(tiny);
    expect(tinyReport.ok).toBe(true);
    expect(roleResult(tinyReport, "spec").resolved?.pricing.completion).toBe(
      "0.0000005",
    );
  });

  it("rejects unknown, invalid, and unsupported pricing when all endpoints fail", () => {
    const unknown = fixture();
    for (const endpoint of fixtureEndpoints(unknown, "fixture/generator-text")) {
      if (endpoint.pricing !== undefined) {
        delete endpoint.pricing.completion;
      }
    }
    expectFailure(run(unknown), "UNKNOWN_PRICING", "spec");

    const invalid = fixture();
    for (const endpoint of fixtureEndpoints(invalid, "fixture/generator-text")) {
      if (endpoint.pricing !== undefined) {
        endpoint.pricing.completion = "-0.1";
      }
    }
    expectFailure(run(invalid), "INVALID_PRICING", "spec");

    const overrides = fixture();
    for (const endpoint of fixtureEndpoints(
      overrides,
      "fixture/generator-text",
    )) {
      if (endpoint.pricing !== undefined) {
        endpoint.pricing.overrides = {};
      }
    }
    expectFailure(run(overrides), "UNSUPPORTED_PRICING", "spec");
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

  it("builds five bounded probes for all four review contracts without executing them", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const plan = buildLiveProbePlan({
      allowPaid: true,
      maxCostUsd: "0.50",
      apiKey: "inference-key",
      routes: routes(),
      visionPngDataUrl: PNG_DATA_URL,
    });
    expect(plan.probes).toHaveLength(5);
    expect(plan.probes.map((probe) => probe.role)).toEqual([
      "spec",
      "blind_text",
      "alignment_text",
      "blind_vision",
      "alignment_vision",
    ]);
    const prefixed = buildLiveProbePlan({
      allowPaid: true,
      maxCostUsd: "0.50",
      apiKey: "inference-key",
      routes: routes(),
      visionPngDataUrl: PNG_DATA_URL,
      probeKeyPrefix: "preflight:test-id",
    });
    expect(prefixed.probes.map((probe) => probe.probeKey)).toEqual([
      "preflight:test-id:spec",
      "preflight:test-id:blind_text",
      "preflight:test-id:alignment_text",
      "preflight:test-id:blind_vision",
      "preflight:test-id:alignment_vision",
    ]);
    const generator = plan.probes[0];
    const alignmentText = plan.probes[2];
    const vision = plan.probes[3];
    const alignmentVision = plan.probes[4];
    if (
      generator === undefined ||
      alignmentText === undefined ||
      vision === undefined ||
      alignmentVision === undefined
    ) {
      throw new Error("live probe plan is incomplete");
    }
    expect(generator.body).toHaveProperty("max_tokens", 8192);
    expect(generator.body).not.toHaveProperty("max_completion_tokens");
    expect(vision.body).toHaveProperty("max_completion_tokens", 4096);
    expect(vision.body).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(vision.body)).toContain("image_url");
    expect(JSON.stringify(vision.body)).toContain("data:image/png;base64,");
    expect(alignmentText.responseFormat.name).toBe("puzzle_alignment_review");
    expect(JSON.stringify(alignmentText.body)).not.toContain("image_url");
    expect(JSON.stringify(alignmentText.body)).toContain("not_applicable");
    expect(
      alignmentText.body.max_completion_tokens ?? alignmentText.body.max_tokens,
    ).toBe(4096);
    expect(alignmentVision.responseFormat.name).toBe("puzzle_alignment_review");
    expect(JSON.stringify(alignmentVision.body)).toContain("image_url");
    expect(JSON.stringify(alignmentVision.body)).toContain(
      "data:image/png;base64,",
    );
    expect(
      alignmentVision.body.max_completion_tokens ??
        alignmentVision.body.max_tokens,
    ).toBe(4096);
    const promptText = (probe: typeof alignmentText): string => {
      const messages = probe.body.messages as readonly {
        readonly content: unknown;
      }[];
      const content = messages[1]?.content;
      if (!Array.isArray(content)) {
        throw new Error("alignment probe has no content parts");
      }
      const part = (
        content as readonly { readonly type: string; readonly text?: string }[]
      ).find((candidate) => candidate.type === "text");
      return part?.text ?? "";
    };
    expect(promptText(alignmentText)).toContain(
      "the text image field must be not_applicable",
    );
    expect(promptText(alignmentText)).not.toContain(
      "the image field must be pass or uncertain",
    );
    expect(promptText(alignmentVision)).toContain(
      "the image field must be pass or uncertain",
    );
    expect(promptText(alignmentVision)).not.toContain(
      "the text image field must be not_applicable",
    );
    const productionCaps = buildLiveProbePlan({
      allowPaid: true,
      maxCostUsd: "0.50",
      apiKey: "inference-key",
      routes: routes(),
      visionPngDataUrl: PNG_DATA_URL,
      probeMaxOutputTokensByRole: {
        spec: 2048,
        blind_text: defaultMaxOutputTokensFor("blind_text"),
        alignment_text: defaultMaxOutputTokensFor("alignment_text"),
        blind_vision: defaultMaxOutputTokensFor("blind_vision"),
        alignment_vision: defaultMaxOutputTokensFor("alignment_vision"),
      },
    });
    for (const probe of productionCaps.probes) {
      const cap =
        probe.body.max_completion_tokens ?? probe.body.max_tokens;
      expect(cap).toBe(
        probe.role === "spec" ? 2048 : defaultMaxOutputTokensFor(probe.role),
      );
    }
    for (const probe of plan.probes) {
      expect(probe.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      expect(() =>
        assertStrictJsonSchema(
          probe.responseFormat.schema,
          `${probe.role}.responseFormat`,
        ),
      ).not.toThrow();
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


describe("preflight CLI live gate", () => {
  it("requires paid authorization and a routing confirmation before any network", async () => {
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await preflightMain(["node", "preflight", "--live"])).toBe(1);
      expect(stderr.join("")).toContain("--allow-paid");
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
      expect(stderr.join("")).toContain("--routing-confirmation");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("blocks stale, conflicting, and BYOK confirmations before any network", async () => {
    const previous = { ...process.env };
    process.env.OPENROUTER_API_KEY = "test-inference-key";
    process.env.GENERATOR_MODEL = "fixture/generator-text";
    process.env.REVIEWER_MODEL = "fixture/reviewer-text";
    process.env.VISION_REVIEWER_MODEL = "fixture/reviewer-vision";
    const directory = mkdtempSync(join(tmpdir(), "puzzle-preflight-confirmation-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const writeConfirmation = (name: string, value: unknown): string => {
        const path = join(directory, name);
        writeFileSync(path, `${JSON.stringify(value)}\n`);
        return path;
      };
      const base = {
        operator: "operator",
        checkedAt: new Date().toISOString(),
        providerSort: "default_balanced",
        byokConfigured: false,
      };
      const stale = writeConfirmation("stale.json", {
        ...base,
        checkedAt: "2020-01-01T00:00:00.000Z",
      });
      const conflicting = writeConfirmation("conflicting.json", {
        ...base,
        providerSort: "price",
      });
      const byok = writeConfirmation("byok.json", {
        ...base,
        byokConfigured: true,
      });
      const future = writeConfirmation("future.json", {
        ...base,
        checkedAt: new Date(Date.now() + 60_000).toISOString(),
      });

      for (const [path, expected] of [
        [stale, "older than 15 minutes"],
        [conflicting, "routing confirmation must contain"],
        [byok, "routing confirmation must contain"],
        [future, "checkedAt is in the future"],
      ] as const) {
        const stderr: string[] = [];
        const spy = vi
          .spyOn(process.stderr, "write")
          .mockImplementation((chunk: unknown) => {
            stderr.push(String(chunk));
            return true;
          });
        try {
          const code = await preflightMain([
            "node",
            "preflight",
            "--live",
            "--allow-paid",
            "--max-cost",
            "0.50",
            "--routing-confirmation",
            path,
          ]);
          expect(code).toBe(1);
          expect(stderr.join("")).toContain(expected);
        } finally {
          spy.mockRestore();
        }
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(previous)) {
        process.env[key] = value;
      }
    }
  });
});


describe("live probe response validation", () => {
  it("requires the role strict schema and a real vision interpretation", () => {
    const validSpec = constructRankingSpec("a".repeat(64), 1).spec;
    expect(validateProbeContent("spec", validSpec).schemaValid).toBe(true);
    expect(validateProbeContent("spec", { family: "ranking" }).schemaValid).toBe(
      false,
    );

    const blind = {
      answerStatus: "cannot_determine",
      chosenOption: null,
      reasoning: "The image is too small to identify a tile.",
      clarity: "unclear",
      ambiguity: "present",
      confidence: 0.2,
      visualLegibility: "unclear",
      issues: [],
    };
    expect(validateProbeContent("blind_vision", blind)).toMatchObject({
      schemaValid: true,
      visionInterpreted: true,
    });
    expect(
      validateProbeContent("blind_vision", {
        ...blind,
        visualLegibility: "not_applicable",
      }),
    ).toMatchObject({
      schemaValid: false,
      visionInterpreted: false,
    });
    expect(
      validateProbeContent("blind_text", {
        ...blind,
        visualLegibility: "not_applicable",
      }),
    ).toMatchObject({
      schemaValid: true,
      visionInterpreted: false,
    });
    expect(
      validateProbeContent("blind_text", {
        ...blind,
        visualLegibility: "legible",
      }),
    ).toMatchObject({
      schemaValid: false,
      visionInterpreted: false,
    });
  });

  it("validates text and vision alignment field applicability without a model overall", () => {
    const pass = { status: "pass" as const, factIds: [], reason: "Looks right." };
    const fields: AlignmentFields = {
      question: pass,
      rulesAndClues: { ...pass, factIds: ["f001", "f002"] },
      options: pass,
      hint: { status: "pass", factIds: [], reason: "No hint is present, which is acceptable." },
      explanation: { ...pass, factIds: ["f001", "f002"] },
      image: { status: "not_applicable", factIds: [], reason: "Text presentation." },
    };
    const textAlignment = { fields };
    expect(validateProbeContent("alignment_text", textAlignment)).toMatchObject({
      schemaValid: true,
      visionInterpreted: false,
    });
    expect(
      validateProbeContent("alignment_text", {
        fields: {
          ...fields,
          image: { status: "pass", factIds: [], reason: "Image present." },
        },
      }),
    ).toMatchObject({
      schemaValid: false,
      visionInterpreted: false,
    });
    expect(
      validateProbeContent("alignment_text", {
        fields,
        overall: "fail",
      }),
    ).toMatchObject({
      schemaValid: false,
      visionInterpreted: false,
    });

    const visionFields: AlignmentFields = {
      ...fields,
      image: { status: "pass", factIds: [], reason: "The image is legible." },
    };
    expect(
      validateProbeContent("alignment_vision", {
        fields: visionFields,
      }),
    ).toMatchObject({
      schemaValid: true,
      visionInterpreted: true,
    });
    expect(
      validateProbeContent("alignment_vision", {
        fields: {
          ...visionFields,
          image: {
            status: "not_applicable",
            factIds: [],
            reason: "No image.",
          },
        },
      }),
    ).toMatchObject({
      schemaValid: false,
      visionInterpreted: false,
    });
  });

  it("rejects regex lookaround and other provider-incompatible pattern constructs", () => {
    const schemaWithPattern = (pattern: string) => ({
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", pattern } },
      required: ["id"],
    });
    for (const pattern of [
      "^(?!0+$)\\d+$",
      "^(?=a)a$",
      "^(?<=a)b$",
      "^(?<!a)b$",
      "^(a)\\1$",
      "^(?>a)$",
      "^(?i)a$",
      "^\\p{Letter}+$",
      "^a*+$",
    ]) {
      expect(() =>
        assertStrictJsonSchema(schemaWithPattern(pattern), "test"),
      ).toThrow(StrictSchemaError);
    }
    expect(() =>
      assertStrictJsonSchema(schemaWithPattern("^[a-z]+$"), "test"),
    ).not.toThrow();
    expect(() =>
      assertStrictJsonSchema(
        BLIND_REVIEW_JSON_SCHEMA.schema,
        "blindReview.responseFormat",
      ),
    ).not.toThrow();
    expect(() =>
      assertStrictJsonSchema(
        ALIGNMENT_REVIEW_JSON_SCHEMA.schema,
        "alignmentReview.responseFormat",
      ),
    ).not.toThrow();
  });
});
