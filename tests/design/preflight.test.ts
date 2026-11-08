import { describe, expect, it } from "vitest";
import {
  fetchDesignerPreflightCatalog,
  runDesignerPreflightOnCatalog,
} from "../../src/design/preflight.js";
import {
  assertRoutingConfirmationFresh,
  parseRoutingConfirmation,
} from "../../src/design/routing.js";

const CATALOG = {
  recorded_at: "2026-01-01T00:00:00.000Z",
  source: "local-fixture",
  models: [
    {
      id: "designer-model",
      name: "Designer",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      endpoints: [
        {
          tag: "provider/designer",
          provider_name: "provider",
          status: 0,
          context_length: 200_000,
          max_completion_tokens: 8192,
          max_prompt_tokens: 180_000,
          supported_parameters: [
            "structured_outputs",
            "response_format",
            "max_tokens",
            "temperature",
            "seed",
            "reasoning",
          ],
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
          },
        },
      ],
    },
  ],
};

describe("P50.4 designer provider preflight", () => {
  it("validates the text and SVG design schemas without image or reviewer roles", () => {
    const report = runDesignerPreflightOnCatalog(CATALOG, {
      model: "designer-model",
    });
    expect(report.ok).toBe(true);
    expect(report.roles).toHaveLength(2);
    expect(report.roles.every((role) => role.role === "design")).toBe(true);
    expect(report.roles.map((role) => role.resolved?.responseFormat.name)).toEqual([
      "puzzle_design_truth_d1_skin",
      "puzzle_design_matrix_d1_skin",
    ]);
    expect(report.failures).toEqual([]);
    expect(
      report.roles.every((role) => role.resolved?.requiresImage === false),
    ).toBe(true);
    expect(report.schemaHashes).toHaveProperty(
      "design:puzzle_design_truth_d1_skin",
    );
    expect(report.schemaHashes).toHaveProperty(
      "design:puzzle_design_matrix_d1_skin",
    );
  });

  it("accepts the normalized catalog returned by the live fetch adapter", async () => {
    const modelsPayload = {
      data: [
        {
          id: "provider/designer-model",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
      ],
    };
    const endpointsPayload = {
      data: {
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        endpoints: [
          {
            tag: "provider/designer",
            provider_name: "provider",
            status: 0,
            context_length: 200_000,
            max_completion_tokens: 8192,
            max_prompt_tokens: 180_000,
            supported_parameters: [
              "structured_outputs",
              "response_format",
              "max_tokens",
              "temperature",
              "seed",
              "reasoning",
            ],
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
            },
          },
        ],
      },
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/endpoints") ? endpointsPayload : modelsPayload,
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const catalog = await fetchDesignerPreflightCatalog({
      model: "provider/designer-model",
      fetchImpl,
    });
    const report = runDesignerPreflightOnCatalog(catalog, {
      model: "provider/designer-model",
    });
    expect(report.ok).toBe(true);
    expect(report.roles.map((role) => role.resolved?.responseFormat.name)).toEqual([
      "puzzle_design_truth_d1_skin",
      "puzzle_design_matrix_d1_skin",
    ]);
  });

  it("rejects a stale routing confirmation", () => {
    const confirmation = parseRoutingConfirmation({
      operator: "alex",
      checkedAt: "2026-01-01T00:00:00.000Z",
      routingPolicy: "balanced",
      providerSort: "default",
      byokProviderKeysConfigured: false,
    });
    expect(() =>
      assertRoutingConfirmationFresh(
        confirmation,
        new Date("2026-01-01T00:31:00.000Z"),
      ),
    ).toThrow(/stale/);
    expect(() =>
      assertRoutingConfirmationFresh(
        confirmation,
        new Date("2026-01-01T00:29:00.000Z"),
      ),
    ).not.toThrow();
  });

  it("fails closed when the designer model is absent from the catalog", () => {
    const report = runDesignerPreflightOnCatalog(CATALOG, {
      model: "missing-model",
    });
    expect(report.ok).toBe(false);
    expect(
      report.failures.every((failure) => failure.code === "MODEL_NOT_FOUND"),
    ).toBe(true);
  });
});
