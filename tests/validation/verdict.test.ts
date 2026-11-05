import { describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  type FailureCode,
  type FailureRecord,
} from "../../src/domain/candidate.js";
import {
  PrimaryVerdictInputSchema,
  failureClass,
  reducePrimaryVerdict,
  type PrimaryVerdictInput,
} from "../../src/validation/verdict.js";

function failure(
  code: FailureCode,
  source: FailureRecord["source"] = "model",
  stage: FailureRecord["stage"] = "terminal",
  severity: FailureRecord["severity"] = "high",
): FailureRecord {
  return {
    code,
    stage,
    severity,
    source,
    evidence: `evidence for ${code}`,
  };
}

function textInput(
  overrides: Partial<PrimaryVerdictInput> = {},
): PrimaryVerdictInput {
  return {
    version: 1,
    slotId: "text-ranking-01",
    family: "ranking",
    modality: "text",
    runControl: "running",
    preparation: "ready",
    generation: { state: "usable" },
    formalPassed: true,
    presentationPassed: true,
    duplicate: {
      outcome: "unique",
      ownerSlotId: null,
      nearPairSlotIds: [],
    },
    blind: {
      required: true,
      completed: true,
      answerStatus: "selected",
      chosenOption: "A",
      expectedOption: "A",
      clarity: "clear",
      ambiguity: "none",
      issues: 0,
      visualLegibility: "not_applicable",
    },
    alignment: {
      required: true,
      completed: true,
      derivedOverall: "pass",
    },
    costStatus: "known",
    failures: [],
    ...overrides,
  };
}

function svgInput(
  overrides: Partial<PrimaryVerdictInput> = {},
): PrimaryVerdictInput {
  return textInput({
    slotId: "svg-matrix-01",
    family: "matrix",
    modality: "svg",
    blind: {
      required: true,
      completed: true,
      answerStatus: "selected",
      chosenOption: "A",
      expectedOption: "A",
      clarity: "clear",
      ambiguity: "none",
      issues: 0,
      visualLegibility: "legible",
    },
    ...overrides,
  });
}

function inputForFailureCode(code: FailureCode): PrimaryVerdictInput {
  const base = textInput({ failures: [failure(code)] });
  switch (code) {
    case "SCHEMA_INVALID":
      return textInput({
        generation: { state: "malformed" },
        failures: [failure(code, "infrastructure")],
      });
    case "API_ERROR":
      return textInput({
        generation: { state: "api_error" },
        failures: [failure(code, "infrastructure")],
      });
    case "UNSAT":
    case "MULTIPLE_SOLUTIONS":
    case "MULTIPLE_ANSWERS":
    case "DUPLICATE_OPTION":
    case "SOLVER_LIMIT":
      return textInput({
        formalPassed: false,
        failures: [failure(code, "deterministic", "formal_checked")],
      });
    case "SVG_RENDER_INVALID":
      return svgInput({
        presentationPassed: false,
        failures: [failure(code, "deterministic", "presentation_ready")],
      });
    case "EXACT_DUPLICATE":
      return textInput({
        duplicate: {
          outcome: "exact_duplicate",
          ownerSlotId: "text-ranking-02",
          nearPairSlotIds: [],
        },
        failures: [failure(code, "deterministic", "duplicate_checked")],
      });
    case "STRUCTURAL_DUPLICATE":
      return textInput({
        duplicate: {
          outcome: "structural_duplicate",
          ownerSlotId: "text-ranking-02",
          nearPairSlotIds: [],
        },
        failures: [failure(code, "deterministic", "duplicate_checked")],
      });
    case "NEAR_DUPLICATE_SUSPECTED":
      return textInput({
        duplicate: {
          outcome: "near_suspected",
          ownerSlotId: null,
          nearPairSlotIds: ["text-ranking-02"],
        },
        failures: [failure(code, "deterministic", "duplicate_checked")],
      });
    case "REVIEWER_DISAGREES":
      return textInput({
        blind: {
          ...textInput().blind,
          chosenOption: "B",
        },
        failures: [failure(code, "model", "blind_reviewed")],
      });
    case "REVIEWER_CANNOT_SOLVE":
      return textInput({
        blind: {
          ...textInput().blind,
          answerStatus: "no_unique_answer",
          chosenOption: null,
        },
        failures: [failure(code, "model", "blind_reviewed")],
      });
    case "VISION_REVIEW_UNCERTAIN":
      return svgInput({
        blind: {
          ...svgInput().blind,
          visualLegibility: "unclear",
        },
        failures: [failure(code, "model", "blind_reviewed")],
      });
    case "MISSING_REVIEW":
      return textInput({
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
        failures: [failure(code, "model", "blind_reviewed")],
      });
    case "VISUAL_AMBIGUITY":
      return svgInput({
        blind: {
          ...svgInput().blind,
          ambiguity: "present",
        },
        failures: [failure(code, "model", "blind_reviewed")],
      });
    case "TEXT_SPEC_MISMATCH":
      return base;
    case "EXPLANATION_MISMATCH":
      return base;
    case "COST_UNKNOWN":
      return textInput({
        costStatus: "unknown",
        failures: [failure(code, "infrastructure", "terminal")],
      });
  }
}

describe("pure primary-verdict reducer", () => {
  it("approves only when every required check passes", () => {
    const result = reducePrimaryVerdict(textInput());
    expect(result.verdict).toBe("approved");
    expect(result.completion).toBe("complete");
    expect(result.proceed).toBe(true);
    expect(result.primaryFailure).toBeNull();
    expect(result.businessBlockers).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("covers every verdict", () => {
    expect(
      reducePrimaryVerdict(
        textInput({
          formalPassed: false,
          failures: [failure("UNSAT", "deterministic", "formal_checked")],
        }),
      ).verdict,
    ).toBe("rejected");
    expect(
      reducePrimaryVerdict(
        textInput({
          blind: { ...textInput().blind, chosenOption: "B" },
          failures: [failure("REVIEWER_DISAGREES", "model", "blind_reviewed")],
        }),
      ).verdict,
    ).toBe("inconclusive");
    expect(
      reducePrimaryVerdict(
        textInput({
          generation: { state: "refused" },
          failures: [failure("API_ERROR", "infrastructure")],
        }),
      ).verdict,
    ).toBe("generation_error");
    expect(
      reducePrimaryVerdict(
        textInput({
          preparation: "paused",
        }),
      ).verdict,
    ).toBeNull();
  });

  it("covers every failure code with the documented class", () => {
    for (const code of FAILURE_CODES) {
      const input = inputForFailureCode(code);
      expect(PrimaryVerdictInputSchema.safeParse(input).success).toBe(true);
      const result = reducePrimaryVerdict(input);
      expect(result.failures.some((record) => record.code === code)).toBe(true);
      const failureClassValue = failureClass(failure(code));
      if (code === "COST_UNKNOWN") {
        expect(result.verdict).toBe("approved");
        expect(result.proceed).toBe(false);
        expect(result.businessBlockers).toContain("COST_UNKNOWN");
        continue;
      }
      if (failureClassValue === "generation_error") {
        expect(result.verdict).toBe("generation_error");
      } else if (failureClassValue === "rejected") {
        expect(result.verdict).toBe("rejected");
      } else {
        expect(result.verdict).toBe("inconclusive");
      }
      expect(result.proceed).toBe(false);
    }
  });

  it("treats review-stage API/schema failures as inconclusive, not generation_error", () => {
    const apiFailure = reducePrimaryVerdict(
      textInput({
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
        failures: [failure("API_ERROR", "infrastructure", "blind_reviewed")],
      }),
    );
    expect(apiFailure.verdict).toBe("inconclusive");
    expect(apiFailure.primaryFailure).toBe("MISSING_REVIEW");
    expect(apiFailure.failures.some((record) => record.code === "API_ERROR")).toBe(
      true,
    );

    const schemaFailure = reducePrimaryVerdict(
      textInput({
        alignment: { required: true, completed: false, derivedOverall: null },
        failures: [
          failure("SCHEMA_INVALID", "model", "alignment_reviewed"),
        ],
      }),
    );
    expect(schemaFailure.verdict).toBe("inconclusive");
    expect(schemaFailure.primaryFailure).toBe("MISSING_REVIEW");
  });

  it("does not let a correct reviewer answer override an invalid spec", () => {
    const result = reducePrimaryVerdict(
      textInput({
        formalPassed: false,
        failures: [failure("UNSAT", "deterministic", "formal_checked")],
      }),
    );
    expect(result.verdict).toBe("rejected");
    expect(result.primaryFailure).toBe("UNSAT");
    expect(result.proceed).toBe(false);
  });

  it("treats an incorrect reviewer on a valid spec as inconclusive", () => {
    const result = reducePrimaryVerdict(
      textInput({
        blind: { ...textInput().blind, chosenOption: "B" },
        failures: [failure("REVIEWER_DISAGREES", "model", "blind_reviewed")],
      }),
    );
    expect(result.verdict).toBe("inconclusive");
    expect(result.primaryFailure).toBe("REVIEWER_DISAGREES");
    expect(result.proceed).toBe(false);
  });

  it("treats blind/alignment conflict and missing vision as inconclusive", () => {
    const conflict = reducePrimaryVerdict(
      textInput({
        alignment: { required: true, completed: true, derivedOverall: "fail" },
      }),
    );
    expect(conflict.verdict).toBe("inconclusive");
    expect(conflict.primaryFailure).toBe("TEXT_SPEC_MISMATCH");

    const missingVision = reducePrimaryVerdict(
      svgInput({
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
      }),
    );
    expect(missingVision.verdict).toBe("inconclusive");
    expect(missingVision.primaryFailure).toBe("MISSING_REVIEW");
  });

  it("handles exact duplicate ownership and near-pair suspicion on both members", () => {
    const duplicateMember = reducePrimaryVerdict(
      textInput({
        duplicate: {
          outcome: "exact_duplicate",
          ownerSlotId: "text-ranking-02",
          nearPairSlotIds: [],
        },
      }),
    );
    expect(duplicateMember.verdict).toBe("rejected");
    expect(duplicateMember.primaryFailure).toBe("EXACT_DUPLICATE");

    const owner = reducePrimaryVerdict(
      textInput({
        duplicate: {
          outcome: "owner",
          ownerSlotId: null,
          nearPairSlotIds: [],
        },
      }),
    );
    expect(owner.verdict).toBe("approved");

    const left = reducePrimaryVerdict(
      textInput({
        slotId: "text-ranking-01",
        duplicate: {
          outcome: "near_suspected",
          ownerSlotId: null,
          nearPairSlotIds: ["text-ranking-02"],
        },
      }),
    );
    const right = reducePrimaryVerdict(
      textInput({
        slotId: "text-ranking-02",
        duplicate: {
          outcome: "near_suspected",
          ownerSlotId: null,
          nearPairSlotIds: ["text-ranking-01"],
        },
      }),
    );
    expect(left.verdict).toBe("inconclusive");
    expect(right.verdict).toBe("inconclusive");
    expect(left.primaryFailure).toBe("NEAR_DUPLICATE_SUSPECTED");
    expect(right.primaryFailure).toBe("NEAR_DUPLICATE_SUSPECTED");
  });

  it("keeps a budget-paused review stage incomplete instead of a complete inconclusive", () => {
    const result = reducePrimaryVerdict(
      textInput({
        runControl: "paused_budget",
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
      }),
    );
    expect(result.verdict).toBeNull();
    expect(result.completion).toBe("incomplete");
    expect(result.proceed).toBe(false);
    expect(result.primaryFailure).toBeNull();
  });

  it("keeps a known generation or deterministic rejection under a paused run", () => {
    const generation = reducePrimaryVerdict(
      textInput({
        runControl: "paused_budget",
        generation: { state: "refused" },
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
        failures: [failure("API_ERROR", "infrastructure", "spec_ready")],
      }),
    );
    expect(generation.verdict).toBe("generation_error");
    expect(generation.completion).toBe("complete");

    const rejected = reducePrimaryVerdict(
      textInput({
        runControl: "paused_budget",
        formalPassed: false,
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
        failures: [failure("UNSAT", "deterministic", "formal_checked")],
      }),
    );
    expect(rejected.verdict).toBe("rejected");
    expect(rejected.completion).toBe("complete");
  });

  it("treats a failed run with a pending review as incomplete", () => {
    const result = reducePrimaryVerdict(
      textInput({
        runControl: "failed",
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
      }),
    );
    expect(result.verdict).toBeNull();
    expect(result.completion).toBe("incomplete");
    expect(result.primaryFailure).toBeNull();
  });

  it("names a review-stage API/schema failure as the inconclusive primary", () => {
    const result = reducePrimaryVerdict(
      textInput({
        failures: [failure("API_ERROR", "infrastructure", "blind_reviewed")],
      }),
    );
    expect(result.verdict).toBe("inconclusive");
    expect(result.primaryFailure).toBe("API_ERROR");

    const schema = reducePrimaryVerdict(
      textInput({
        failures: [
          failure("SCHEMA_INVALID", "model", "alignment_reviewed"),
        ],
      }),
    );
    expect(schema.verdict).toBe("inconclusive");
    expect(schema.primaryFailure).toBe("SCHEMA_INVALID");
  });

  it("never ignores a completed negative review just because it is not required", () => {
    const blind = reducePrimaryVerdict(
      textInput({
        blind: {
          ...textInput().blind,
          required: false,
          chosenOption: "B",
        },
      }),
    );
    expect(blind.verdict).toBe("inconclusive");
    expect(blind.primaryFailure).toBe("REVIEWER_DISAGREES");

    const alignment = reducePrimaryVerdict(
      textInput({
        alignment: { required: false, completed: true, derivedOverall: "fail" },
      }),
    );
    expect(alignment.verdict).toBe("inconclusive");
    expect(alignment.primaryFailure).toBe("TEXT_SPEC_MISMATCH");
  });

  it("uses review precedence for a near-suspected candidate with a review concern", () => {
    const result = reducePrimaryVerdict(
      textInput({
        duplicate: {
          outcome: "near_suspected",
          ownerSlotId: null,
          nearPairSlotIds: ["text-ranking-02"],
        },
        blind: { ...textInput().blind, chosenOption: "B" },
        failures: [
          failure("NEAR_DUPLICATE_SUSPECTED", "deterministic", "duplicate_checked"),
          failure("REVIEWER_DISAGREES", "model", "blind_reviewed"),
        ],
      }),
    );
    expect(result.verdict).toBe("inconclusive");
    expect(result.primaryFailure).toBe("REVIEWER_DISAGREES");
    expect(result.failures.some((record) => record.code === "NEAR_DUPLICATE_SUSPECTED")).toBe(true);
  });

  it("does not turn paused or incomplete stages into generation_error", () => {
    for (const preparation of ["not_started", "in_progress", "paused"] as const) {
      const result = reducePrimaryVerdict(textInput({ preparation }));
      expect(result.verdict).toBeNull();
      expect(result.completion).toBe("incomplete");
      expect(result.proceed).toBe(false);
      expect(result.primaryFailure).toBeNull();
    }
  });

  it("strictly prohibits approval with a pending check", () => {
    const pendingBlind = reducePrimaryVerdict(
      textInput({
        blind: {
          required: true,
          completed: false,
          answerStatus: null,
          chosenOption: null,
          expectedOption: null,
          clarity: null,
          ambiguity: null,
          issues: 0,
          visualLegibility: null,
        },
      }),
    );
    expect(pendingBlind.verdict).not.toBe("approved");
    expect(pendingBlind.primaryFailure).toBe("MISSING_REVIEW");

    const pendingAlignment = reducePrimaryVerdict(
      textInput({
        alignment: { required: true, completed: false, derivedOverall: null },
      }),
    );
    expect(pendingAlignment.verdict).not.toBe("approved");
    expect(pendingAlignment.primaryFailure).toBe("MISSING_REVIEW");
  });

  it("keeps cost-unknown as a business blocker without reversing approved quality", () => {
    const result = reducePrimaryVerdict(
      textInput({
        costStatus: "unknown",
        failures: [failure("COST_UNKNOWN", "infrastructure", "terminal", "medium")],
      }),
    );
    expect(result.verdict).toBe("approved");
    expect(result.proceed).toBe(false);
    expect(result.primaryFailure).toBeNull();
    expect(result.businessBlockers).toEqual(["COST_UNKNOWN"]);
    expect(result.rationale).toContain("business proceed");
  });

  it("keeps every failure code and applies deterministic precedence", () => {
    const result = reducePrimaryVerdict(
      textInput({
        formalPassed: false,
        costStatus: "unknown",
        failures: [
          failure("UNSAT", "deterministic", "formal_checked"),
          failure("REVIEWER_DISAGREES", "model", "blind_reviewed"),
          failure("TEXT_SPEC_MISMATCH", "model", "alignment_reviewed"),
          failure("COST_UNKNOWN", "infrastructure", "terminal", "medium"),
        ],
      }),
    );
    expect(result.verdict).toBe("rejected");
    expect(result.primaryFailure).toBe("UNSAT");
    expect(result.failures.map((record) => record.code)).toEqual(
      expect.arrayContaining([
        "UNSAT",
        "REVIEWER_DISAGREES",
        "TEXT_SPEC_MISMATCH",
        "COST_UNKNOWN",
      ]),
    );
    expect(result.businessBlockers).toEqual(["COST_UNKNOWN"]);
    expect(result.proceed).toBe(false);
  });

  it("treats deterministic text/explanation mismatches as rejection, model ones as inconclusive", () => {
    const deterministic = reducePrimaryVerdict(
      textInput({
        failures: [
          failure("TEXT_SPEC_MISMATCH", "deterministic", "alignment_reviewed"),
        ],
      }),
    );
    expect(deterministic.verdict).toBe("rejected");
    expect(deterministic.primaryFailure).toBe("TEXT_SPEC_MISMATCH");

    const model = reducePrimaryVerdict(
      textInput({
        failures: [failure("EXPLANATION_MISMATCH", "model", "alignment_reviewed")],
      }),
    );
    expect(model.verdict).toBe("inconclusive");
    expect(model.primaryFailure).toBe("EXPLANATION_MISMATCH");
  });

  it("is pure and deterministic", () => {
    const input = textInput({
      failures: [failure("COST_UNKNOWN", "infrastructure", "terminal", "medium")],
      costStatus: "unknown",
    });
    const before = JSON.parse(JSON.stringify(input)) as unknown;
    const first = reducePrimaryVerdict(input);
    const second = reducePrimaryVerdict(input);
    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });
});
