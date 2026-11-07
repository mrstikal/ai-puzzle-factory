import { describe, expect, it } from "vitest";
import { ChoiceSetSchema } from "../../src/domain/answers.js";
import type {
  AlignmentFields,
  AlignmentReviewResponse,
  BlindReviewResponse,
} from "../../src/ai/schemas.js";
import {
  buildCalibrationPilotPack,
  buildPathsDuplicatePilotPack,
  buildPathsPilotPack,
  buildPathsPilotPackV2,
} from "../../src/calibration/fixtures.js";
import {
  buildCalibrationPilotLabels,
  calibrationPilotPass,
} from "../../src/calibration/pilot.js";
import {
  BLIND_DEFECT_SIGNALS,
  alignmentFieldForCalibrationField,
  scoreCalibration,
} from "../../src/calibration/score.js";
import { buildAlignmentReviewRequest } from "../../src/calibration/run.js";
import { hashPng } from "../../src/render/png.js";
import { mockRoute } from "../../src/runner/run.js";
import {
  PresentationError,
  assertAssembledPresentation,
} from "../../src/validation/presentation.js";

interface MutableObservation {
  fixtureId: string;
  blind: { response: unknown | null; error: string | null };
  alignment: { response: unknown | null; error: string | null };
}

function blindResponse(
  fixture: ReturnType<typeof buildCalibrationPilotPack>["fixtures"][number]["fixture"],
): BlindReviewResponse {
  const text = fixture.modality === "text";
  if (fixture.variant === "sound") {
    if (fixture.expected.blind.correctLabel === null) {
      throw new Error(`${fixture.fixtureId} sound fixture has no correct label`);
    }
    return {
      answerStatus: "selected",
      chosenOption: fixture.expected.blind.correctLabel,
      reasoning: "Pilot oracle selects the correct option.",
      clarity: "clear",
      ambiguity: "none",
      confidence: 1,
      visualLegibility: text ? "not_applicable" : "legible",
      issues: [],
    };
  }
  const code = fixture.expected.blind.acceptedDefectCodes[0];
  if (code === undefined) {
    throw new Error(`${fixture.fixtureId} defective fixture has no defect code`);
  }
  const signal = BLIND_DEFECT_SIGNALS[code];
  return {
    answerStatus: signal.answerStatus,
    chosenOption: null,
    reasoning: "Pilot oracle reports the accepted defect.",
    clarity: "clear",
    ambiguity: "none",
    confidence: 1,
    visualLegibility: text ? "not_applicable" : "legible",
    issues: [
      { code: signal.issueCodes[0]!, evidence: "Pilot accepted defect." },
    ],
  };
}

function alignmentResponse(
  fixture: ReturnType<typeof buildCalibrationPilotPack>["fixtures"][number]["fixture"],
): AlignmentReviewResponse {
  const text = fixture.modality === "text";
  const pass = { status: "pass" as const, factIds: [], reason: "Pilot pass." };
  const image = text
    ? {
        status: "not_applicable" as const,
        factIds: [],
        reason: "Text presentation.",
      }
    : pass;
  let failingField: string | null = null;
  if (fixture.variant === "defective") {
    const field = fixture.expected.alignment.acceptedFailingFields[0];
    if (field !== undefined) {
      failingField = alignmentFieldForCalibrationField(field, fixture.modality);
    }
  }
  const fail = {
    status: "fail" as const,
    factIds: [...fixture.expected.alignment.acceptedFactIds],
    reason: "Pilot accepted failing field.",
  };
  const fields: AlignmentFields = {
    question: failingField === "question" ? fail : pass,
    rulesAndClues: failingField === "rulesAndClues" ? fail : pass,
    options: failingField === "options" ? fail : pass,
    hint: failingField === "hint" ? fail : pass,
    explanation: failingField === "explanation" ? fail : pass,
    image: failingField === "image" ? fail : image,
  };
  return { fields };
}

function pilotObservations(
  pilot: ReturnType<typeof buildCalibrationPilotPack>,
): MutableObservation[] {
  return pilot.fixtures.map((entry) => ({
    fixtureId: entry.fixture.fixtureId,
    blind: { response: blindResponse(entry.fixture), error: null },
    alignment: { response: alignmentResponse(entry.fixture), error: null },
  }));
}

function defectiveObservation(
  pilot: ReturnType<typeof buildCalibrationPilotPack>,
  observations: MutableObservation[],
): MutableObservation {
  const observation = observations.find(
    (candidate) =>
      pilot.fixtures.find(
        (entry) => entry.fixture.fixtureId === candidate.fixtureId,
      )?.fixture.variant === "defective",
  );
  if (observation === undefined) {
    throw new Error("missing defective pilot observation");
  }
  return observation;
}

describe("calibration development pilot", () => {
  it("builds six disjoint development cases with one sound and two defective cases per modality", () => {
    const pilot = buildCalibrationPilotPack();
    expect(pilot.fixtures).toHaveLength(6);
    expect(pilot.fixtures.filter((entry) => entry.fixture.modality === "text")).toHaveLength(3);
    expect(pilot.fixtures.filter((entry) => entry.fixture.modality === "svg")).toHaveLength(3);
    expect(pilot.fixtures.filter((entry) => entry.fixture.variant === "sound")).toHaveLength(2);
    expect(pilot.fixtures.filter((entry) => entry.fixture.variant === "defective")).toHaveLength(4);
    for (const modality of ["text", "svg"] as const) {
      expect(
        pilot.fixtures.filter(
          (entry) =>
            entry.fixture.modality === modality &&
            entry.fixture.variant === "sound",
        ),
      ).toHaveLength(1);
      expect(
        pilot.fixtures.filter(
          (entry) =>
            entry.fixture.modality === modality &&
            entry.fixture.variant === "defective",
        ),
      ).toHaveLength(2);
    }
    expect(new Set(pilot.fixtures.map((entry) => entry.fixture.family))).toEqual(
      new Set(["ranking", "paths"]),
    );
    for (const entry of pilot.fixtures) {
      expect(entry.fixture.fixtureId).toMatch(/-9[789]$/);
      expect(entry.fixture.fixtureId).not.toMatch(/-0[1-4]$/);
      expect(entry.fixture.slotId).toMatch(/-9[789]$/);
      if (entry.fixture.variant === "defective") {
        const source = pilot.fixtures.find(
          (candidate) =>
            candidate.fixture.fixtureId === entry.fixture.sourceFixtureId,
        )?.fixture;
        if (source === undefined) {
          throw new Error(`${entry.fixture.fixtureId} has no sound twin`);
        }
        expect(entry.fixture.optionsSeed).toBe(source.optionsSeed);
        expect(entry.fixture.originalContentHash).toBe(source.contentHash);
        expect(entry.fixture.contentHash).not.toBe(
          entry.fixture.originalContentHash,
        );
      }
    }
  });

  it("proves the production validators reject the deliberate duplicate-option mutation", () => {
    const pilot = buildCalibrationPilotPack();
    const defective = pilot.fixtures.find(
      (entry) => entry.fixture.fixtureId === "cal-ranking-99",
    )?.fixture;
    if (defective === undefined) {
      throw new Error("missing ranking duplicate fixture");
    }
    expect(defective.mutation?.kind).toBe("duplicate_correct_option");
    expect(new Set(defective.visible.options.map((option) => option.text)).size).toBeLessThan(4);

    const assembled = {
      version: 1 as const,
      visible: defective.visible,
      reveal: defective.original.reveal,
      wordingSource: "model" as const,
      checks: {
        wordingSchema: "pass" as const,
        clueFactCoverage: "pass" as const,
        explanationReferences: "pass" as const,
        optionOrder: "pass" as const,
        optionTextDistinctness: "pass" as const,
        assets: "not_applicable" as const,
        semanticAlignment: "semantic_alignment_pending" as const,
      },
    };
    let error: unknown;
    try {
      assertAssembledPresentation(assembled);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PresentationError);
    expect((error as PresentationError).code).toBe("DUPLICATE_OPTION_TEXT");

    const choices = defective.original.choices.choices.map((choice) => ({
      ...choice,
    }));
    const first = choices[0];
    const second = choices[1];
    if (first === undefined || second === undefined) {
      throw new Error("missing original choices");
    }
    choices[1] = { ...second, value: first.value };
    expect(
      ChoiceSetSchema.safeParse({
        ...defective.original.choices,
        choices,
      }).success,
    ).toBe(false);
  });

  it("keeps the paths PNG, alignment payload, and scoring mapping faithful to the pack", () => {
    const pilot = buildCalibrationPilotPack();
    const entry = pilot.fixtures.find(
      (candidate) => candidate.fixture.fixtureId === "cal-paths-98",
    );
    if (entry === undefined) {
      throw new Error("missing paths defective fixture");
    }
    const fixture = entry.fixture;
    expect(fixture.mutation?.kind).toBe("closed_route_edge");
    expect(fixture.mutation?.changedFields).toContain("assets");
    expect(fixture.pngHash).not.toBe(fixture.originalPngHash);
    expect(entry.artifacts.visible.png).not.toBeNull();
    expect(entry.artifacts.original.png).not.toBeNull();
    expect(hashPng(entry.artifacts.visible.png!)).toBe(fixture.pngHash);
    expect(hashPng(entry.artifacts.original.png!)).toBe(fixture.originalPngHash);
    expect(fixture.expected.alignment.acceptedFailingFields).toContain("assets");
    expect(alignmentFieldForCalibrationField("assets", "svg")).toBe("image");
    const svg = entry.artifacts.visible.svg;
    if (svg === null) {
      throw new Error("missing paths SVG");
    }
    for (const label of "ABCD") {
      expect(svg).toContain(`>${label}<`);
    }

    const alignment = buildAlignmentReviewRequest(
      fixture,
      entry,
      mockRoute("alignment_vision"),
    );
    const messages = alignment.body.messages as readonly {
      readonly content: unknown;
    }[];
    const content = messages[1]?.content;
    if (!Array.isArray(content)) {
      throw new Error("paths alignment request has no content parts");
    }
    const textPart = (
      content as readonly { readonly type: string; readonly text?: string }[]
    ).find((part) => part.type === "text");
    if (textPart?.text === undefined) {
      throw new Error("paths alignment request has no text");
    }
    const payload = JSON.parse(
      textPart.text.slice(
        textPart.text.indexOf("{"),
        textPart.text.lastIndexOf("}") + 1,
      ),
    ) as {
      readonly dsl: unknown;
      readonly visible: unknown;
    };
    expect(payload.dsl).toEqual(fixture.original.spec);
    expect(payload.visible).toEqual({
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
    });
    expect(JSON.stringify(alignment.body)).toContain("data:image/png;base64,");
  });

  it("derives six pilot labels and passes the 2/1 conservative oracle", () => {
    const pilot = buildCalibrationPilotPack();
    const labels = buildCalibrationPilotLabels(pilot);
    expect(labels.packHash).toBe(pilot.pack.packHash);
    expect(labels.rows).toHaveLength(6);
    expect(labels.rows.every((row) => row.provenance === "mock_test_only")).toBe(
      true,
    );
    expect(labels.rows.every((row) => row.humanVerified === false)).toBe(true);

    const observations = pilotObservations(pilot);
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 12,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    expect(score.evidenceKind).toBe("pilot");
    expect(score.liveEligible).toBe(false);
    expect(score.reviewCalls).toBe(12);
    expect(score.observations).toBe(6);
    expect(score.coverage.errors).toBe(0);
    expect(score.coverage.reviewed).toBe(6);
    for (const combination of Object.values(score.combinations)) {
      expect(combination.conservative.defectiveDenominator).toBe(2);
      expect(combination.conservative.soundDenominator).toBe(1);
      expect(combination.conservative.defectiveNumerator).toBe(2);
      expect(combination.conservative.soundNumerator).toBe(1);
    }
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(true);
    expect(pass.pass).toBe(true);
    expect(pass.combinations).toEqual({
      text_blind: true,
      text_alignment: true,
      svg_blind: true,
      svg_alignment: true,
    });
  });

  it("fails the pilot on a schema error", () => {
    const pilot = buildCalibrationPilotPack();
    const labels = buildCalibrationPilotLabels(pilot);
    const observations = pilotObservations(pilot);
    const defective = defectiveObservation(pilot, observations);
    defective.blind = { response: null, error: "pilot schema failure" };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 12,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(false);
    expect(pass.pass).toBe(false);
  });

  it("fails the pilot on a valid abstention", () => {
    const pilot = buildCalibrationPilotPack();
    const labels = buildCalibrationPilotLabels(pilot);
    const observations = pilotObservations(pilot);
    const defective = defectiveObservation(pilot, observations);
    const fixture = pilot.fixtures.find(
      (entry) => entry.fixture.fixtureId === defective.fixtureId,
    )?.fixture;
    if (fixture === undefined) {
      throw new Error("missing defective fixture");
    }
    const code = fixture.expected.blind.acceptedDefectCodes[0];
    if (code === undefined) {
      throw new Error("missing accepted defect code");
    }
    const signal = BLIND_DEFECT_SIGNALS[code];
    defective.blind = {
      response: {
        answerStatus: signal.answerStatus,
        chosenOption: null,
        reasoning: "Pilot hedges without committing to the defect.",
        clarity: "unclear",
        ambiguity: "uncertain",
        confidence: 0.5,
        visualLegibility:
          fixture.modality === "text" ? "not_applicable" : "unclear",
        issues: [
          { code: signal.issueCodes[0]!, evidence: "Hedged defect signal." },
        ],
      },
      error: null,
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 12,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(true);
    expect(pass.pass).toBe(false);
    expect(
      score.combinations[`${fixture.modality}_blind`]?.conservative
        .defectiveNumerator,
    ).toBe(1);
  });

  it("fails the pilot on a valid missed defect", () => {
    const pilot = buildCalibrationPilotPack();
    const labels = buildCalibrationPilotLabels(pilot);
    const observations = pilotObservations(pilot);
    const defective = defectiveObservation(pilot, observations);
    const fixture = pilot.fixtures.find(
      (entry) => entry.fixture.fixtureId === defective.fixtureId,
    )?.fixture;
    if (fixture === undefined) {
      throw new Error("missing defective fixture");
    }
    defective.blind = {
      response: {
        answerStatus: "selected",
        chosenOption: "A",
        reasoning: "Pilot misses the defect and selects an option.",
        clarity: "clear",
        ambiguity: "none",
        confidence: 1,
        visualLegibility:
          fixture.modality === "text" ? "not_applicable" : "legible",
        issues: [],
      },
      error: null,
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 12,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(true);
    expect(pass.pass).toBe(false);
    expect(
      score.combinations[`${fixture.modality}_blind`]?.conservative
        .defectiveNumerator,
    ).toBe(1);
  });

  it("builds a three-case paths-only pilot and skips empty text combinations", () => {
    const pilot = buildPathsPilotPack();
    expect(pilot.fixtures).toHaveLength(3);
    expect(pilot.fixtures.filter((entry) => entry.fixture.modality === "svg")).toHaveLength(3);
    expect(pilot.fixtures.filter((entry) => entry.fixture.variant === "sound")).toHaveLength(1);
    expect(pilot.fixtures.filter((entry) => entry.fixture.variant === "defective")).toHaveLength(2);
    expect(new Set(pilot.fixtures.map((entry) => entry.fixture.fixtureId))).toEqual(
      new Set(["cal-paths-09", "cal-paths-10", "cal-paths-11"]),
    );
    for (const entry of pilot.fixtures) {
      expect(entry.fixture.slotId).toMatch(/-10[5-7]$/);
    }
    const labels = buildCalibrationPilotLabels(pilot);
    const observations = pilotObservations(pilot);
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 6,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    expect(score.reviewCalls).toBe(6);
    expect(score.observations).toBe(3);
    expect(score.coverage.errors).toBe(0);
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(true);
    expect(pass.pass).toBe(true);
    expect(pass.combinations).toEqual({
      text_blind: true,
      text_alignment: true,
      svg_blind: true,
      svg_alignment: true,
    });
  });

  it("builds the three-case paths-medium pilot with new cases", () => {
    const pilot = buildPathsPilotPackV2();
    expect(pilot.fixtures).toHaveLength(3);
    expect(pilot.fixtures.filter((entry) => entry.fixture.modality === "svg")).toHaveLength(3);
    expect(pilot.fixtures.filter((entry) => entry.fixture.variant === "sound")).toHaveLength(1);
    expect(pilot.fixtures.filter((entry) => entry.fixture.variant === "defective")).toHaveLength(2);
    expect(new Set(pilot.fixtures.map((entry) => entry.fixture.fixtureId))).toEqual(
      new Set(["cal-paths-12", "cal-paths-13", "cal-paths-14"]),
    );
    for (const entry of pilot.fixtures) {
      expect(entry.fixture.slotId).toMatch(/-(108|109|110)$/);
    }
    const labels = buildCalibrationPilotLabels(pilot);
    const observations = pilotObservations(pilot);
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 6,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    expect(score.reviewCalls).toBe(6);
    expect(score.observations).toBe(3);
    expect(score.coverage.errors).toBe(0);
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(true);
    expect(pass.pass).toBe(true);
  });

  it("builds the focused paths-duplicate pilot with one sound and one duplicate case", () => {
    const pilot = buildPathsDuplicatePilotPack();
    expect(pilot.fixtures).toHaveLength(2);
    expect(new Set(pilot.fixtures.map((entry) => entry.fixture.fixtureId))).toEqual(
      new Set(["cal-paths-12", "cal-paths-14"]),
    );
    expect(
      pilot.fixtures.filter((entry) => entry.fixture.variant === "sound"),
    ).toHaveLength(1);
    expect(
      pilot.fixtures.filter((entry) => entry.fixture.variant === "defective"),
    ).toHaveLength(1);
    const labels = buildCalibrationPilotLabels(pilot);
    const observations = pilotObservations(pilot);
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 4,
      generationCalls: 0,
      evidenceKind: "pilot",
      liveEligible: false,
    });
    expect(score.reviewCalls).toBe(4);
    expect(score.observations).toBe(2);
    expect(score.coverage.errors).toBe(0);
    const pass = calibrationPilotPass(score, labels);
    expect(pass.schemaValidCalls).toBe(true);
    expect(pass.pass).toBe(true);
  });
});
