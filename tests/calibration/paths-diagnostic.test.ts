import { describe, expect, it } from "vitest";
import {
  buildPathsDiagnosticAssets,
  buildPathsDiagnosticRequests,
  classifyPathsDiagnostic,
  type PathsDiagnosticVariantResult,
} from "../../src/calibration/paths-diagnostic.js";
import { buildPathsPilotPackV2 } from "../../src/calibration/fixtures.js";
import { readPng } from "../../src/render/png.js";
import { mockRoute } from "../../src/runner/run.js";

function variantResult(
  variant: "A" | "B" | "C" | "D",
  outcome: PathsDiagnosticVariantResult["outcome"],
): PathsDiagnosticVariantResult {
  return {
    variant,
    description: variant,
    role: variant === "D" ? "blind_text" : "blind_vision",
    model: "fixture/model",
    outcome,
    schemaValid: outcome !== "schema_error",
    answerStatus:
      outcome === "defect_detected"
        ? "no_unique_answer"
        : outcome === "selected"
          ? "selected"
          : outcome === "abstained"
            ? "cannot_determine"
            : null,
    chosenOption: outcome === "selected" ? "C" : null,
    issueCodes: [],
    error: outcome === "schema_error" ? "schema error" : null,
    requestHash: null,
    responseHash: null,
    provider: null,
    finishReason: null,
    usage: {
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    },
    costUsd: null,
    costStatus: "not_applicable",
    attempts: [],
  };
}

describe("paths diagnostic", { timeout: 180_000 }, () => {
  it("builds the four isolated variants from the actual closed-route fixture", () => {
    const built = buildPathsPilotPackV2();
    const entry = built.fixtures.find(
      (candidate) => candidate.fixture.fixtureId === "cal-paths-13",
    );
    if (entry === undefined) {
      throw new Error("missing cal-paths-13");
    }
    const assets = buildPathsDiagnosticAssets(entry);
    expect(assets.originalPng.length).toBeGreaterThan(0);
    const source = readPng(assets.sourceCropPng);
    const optionC = readPng(assets.optionCCropPng);
    expect({ width: source.width, height: source.height }).toEqual({
      width: 360,
      height: 280,
    });
    expect({ width: optionC.width, height: optionC.height }).toEqual({
      width: 360,
      height: 320,
    });

    const routes = {
      vision: mockRoute("blind_vision"),
      text: mockRoute("blind_text"),
    };
    const prepared = buildPathsDiagnosticRequests({
      fixture: entry.fixture,
      entry,
      assets,
      routes,
    });
    expect(prepared.map((call) => call.variant)).toEqual(["A", "B", "C", "D"]);
    const byVariant = new Map(prepared.map((call) => [call.variant, call]));
    const a = byVariant.get("A");
    const b = byVariant.get("B");
    const c = byVariant.get("C");
    const d = byVariant.get("D");
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      throw new Error("missing diagnostic variant");
    }
    const imageCount = (body: unknown): number =>
      (JSON.stringify(body).match(/data:image\/png;base64,/g) ?? []).length;
    expect(a.role).toBe("blind_vision");
    expect(imageCount(a.request.body)).toBe(1);
    expect(JSON.stringify(a.request.body)).toContain(
      "Compare all four tiles pairwise",
    );
    expect(b.role).toBe("blind_vision");
    expect(imageCount(b.request.body)).toBe(1);
    expect(JSON.stringify(b.request.body)).toContain(
      "For every consecutive pair",
    );
    expect(c.role).toBe("blind_vision");
    expect(imageCount(c.request.body)).toBe(3);
    expect(JSON.stringify(c.request.body)).toContain("4x zoom");
    expect(d.role).toBe("blind_text");
    expect(imageCount(d.request.body)).toBe(0);
    expect(JSON.stringify(d.request.body)).toContain("Open edges (visible):");
    expect(JSON.stringify(d.request.body)).toContain("Start: (1,1)");
    expect(JSON.stringify(d.request.body)).toContain("Goal: (0,0)");
    expect(JSON.stringify(d.request.body)).toContain(
      "visualLegibility must be not_applicable",
    );
    for (const call of prepared) {
      expect(call.request.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      expect(call.reservationUsd).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it("classifies the four-variant outcomes into the intended diagnostic buckets", () => {
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "selected"),
        variantResult("B", "selected"),
        variantResult("C", "selected"),
        variantResult("D", "defect_detected"),
      ]).suggested,
    ).toBe("visual_interpretation");
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "selected"),
        variantResult("B", "defect_detected"),
        variantResult("C", "selected"),
        variantResult("D", "selected"),
      ]).suggested,
    ).toBe("procedure");
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "selected"),
        variantResult("B", "selected"),
        variantResult("C", "defect_detected"),
        variantResult("D", "selected"),
      ]).suggested,
    ).toBe("visual_detail");
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "selected"),
        variantResult("B", "selected"),
        variantResult("C", "selected"),
        variantResult("D", "selected"),
      ]).suggested,
    ).toBe("rules_logic");
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "defect_detected"),
        variantResult("B", "selected"),
        variantResult("C", "selected"),
        variantResult("D", "selected"),
      ]).suggested,
    ).toBe("control_pass");
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "selected"),
        variantResult("B", "not_executed"),
        variantResult("C", "not_executed"),
        variantResult("D", "not_executed"),
      ]).suggested,
    ).toBe("inconclusive");
    expect(
      classifyPathsDiagnostic([
        variantResult("A", "selected"),
        variantResult("B", "budget_refused"),
        variantResult("C", "transport_error"),
        variantResult("D", "not_executed"),
      ]).suggested,
    ).toBe("inconclusive");
  });
});
