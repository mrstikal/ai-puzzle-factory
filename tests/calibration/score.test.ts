import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  AlignmentFields,
  AlignmentReviewResponse,
  BlindReviewResponse,
} from "../../src/ai/schemas.js";
import { CHOICE_LABELS, type ChoiceLabel } from "../../src/domain/answers.js";
import {
  buildCalibrationPack,
  type BuiltCalibrationPack,
} from "../../src/calibration/fixtures.js";
import {
  acceptProposedLabels,
  calibrationLabelsHash,
  parseCalibrationLabelsCsv,
  pendingLabelRows,
  validateCalibrationLabels,
  type CalibrationLabelRow,
  type CalibrationLabels,
} from "../../src/calibration/labels.js";
import {
  buildBlindPayload,
  runCalibrationMock,
  type CalibrationMockMode,
} from "../../src/calibration/run.js";
import {
  BLIND_DEFECT_SIGNALS,
  scoreCalibration,
  type CalibrationObservation,
  type CalibrationScoreReport,
} from "../../src/calibration/score.js";

const FIXED_NOW = new Date("2026-11-06T12:00:00.000Z");
const CLOCK = { now: () => FIXED_NOW, sleep: async () => {} };

let built: BuiltCalibrationPack;
let labels: CalibrationLabels;
let oracleRun: Awaited<ReturnType<typeof runCalibrationMock>>;
let oracleScore: CalibrationScoreReport;

function rowFor(fixtureId: string): CalibrationLabelRow {
  const row = labels.rows.find((candidate) => candidate.fixtureId === fixtureId);
  if (row === undefined) {
    throw new Error(`missing label row ${fixtureId}`);
  }
  return row;
}

interface MutableObservation {
  fixtureId: string;
  blind: { response: unknown | null; error: string | null };
  alignment: { response: unknown | null; error: string | null };
}

function cloneObservations(
  observations: readonly CalibrationObservation[],
): MutableObservation[] {
  return structuredClone(observations) as MutableObservation[];
}

function blindResponse(observation: CalibrationObservation): BlindReviewResponse {
  return observation.blind.response as BlindReviewResponse;
}

function alignmentResponse(
  observation: CalibrationObservation,
): AlignmentReviewResponse {
  return observation.alignment.response as AlignmentReviewResponse;
}

function wrongLabel(label: ChoiceLabel): ChoiceLabel {
  const index = CHOICE_LABELS.indexOf(label);
  return CHOICE_LABELS[(index + 1) % CHOICE_LABELS.length] ?? "A";
}

function withLabels(mutator: (rows: CalibrationLabelRow[]) => void): CalibrationLabels {
  const copy = structuredClone(labels) as CalibrationLabels & {
    rows: CalibrationLabelRow[];
  };
  mutator(copy.rows);
  return copy;
}

function humanLabels(): CalibrationLabels {
  return {
    packHash: labels.packHash,
    rows: labels.rows.map((row) => ({
      ...row,
      provenance: "human" as const,
      auditor: "test-auditor",
      auditorTime: "2026-11-06T10:00:00.000Z",
    })),
  };
}

async function runMode(mode: CalibrationMockMode): Promise<CalibrationScoreReport> {
  const run = await runCalibrationMock({ built, labels, mode, clock: CLOCK });
  return scoreCalibration({
    labels,
    observations: run.observations,
    reviewCalls: run.reviewCalls,
    generationCalls: run.generationCalls,
  });
}

beforeAll(async () => {
  built = buildCalibrationPack();
  labels = parseCalibrationLabelsCsv(
    readFileSync(
      join(process.cwd(), "tests", "fixtures", "calibration", "mock-labels.csv"),
      "utf8",
    ),
  );
  validateCalibrationLabels({
    labels,
    pack: built.pack,
    mode: "mock",
    clock: CLOCK,
  });
  oracleRun = await runCalibrationMock({
    built,
    labels,
    mode: "oracle",
    clock: CLOCK,
  });
  oracleScore = scoreCalibration({
    labels,
    observations: oracleRun.observations,
    reviewCalls: oracleRun.reviewCalls,
    generationCalls: oracleRun.generationCalls,
  });
}, 120_000);

describe("calibration runner and scoring", { timeout: 120_000 }, () => {
  it("accepts proposed labels only after a per-row human blind result", () => {
    const pending: CalibrationLabels = {
      packHash: built.pack.packHash,
      rows: pendingLabelRows(built.pack),
    };
    expect(pending.rows.every((row) => row.observedBlindResult === "")).toBe(true);
    expect(() =>
      acceptProposedLabels(pending, {
        auditor: "Lexa",
        auditorTime: FIXED_NOW.toISOString(),
      }),
    ).toThrow(/human review is missing observed_blind_result/);

    const reviewed = structuredClone(pending) as CalibrationLabels & {
      rows: CalibrationLabelRow[];
    };
    for (const row of reviewed.rows) {
      row.observedBlindResult = row.proposedBlindResult;
    }
    const defective = reviewed.rows.find(
      (row) => row.soundOrDefective === "defective",
    );
    const sound = reviewed.rows.find((row) => row.soundOrDefective === "sound");
    if (defective === undefined || sound === undefined) {
      throw new Error("calibration fixture mix is missing");
    }
    defective.auditor = "Row-Auditor";
    defective.auditorTime = "2026-11-06T11:00:00.000Z";
    const accepted = acceptProposedLabels(reviewed, {
      auditor: "Lexa",
      auditorTime: FIXED_NOW.toISOString(),
    });
    expect(
      accepted.rows.every(
        (row) =>
          row.provenance === "human" &&
          row.humanVerified &&
          row.observedBlindResult !== "",
      ),
    ).toBe(true);
    expect(accepted.rows[0]?.observedBlindResult).toBe(
      accepted.rows[0]?.proposedBlindResult,
    );
    const acceptedDefective = accepted.rows.find(
      (row) => row.fixtureId === defective.fixtureId,
    );
    const acceptedSound = accepted.rows.find(
      (row) => row.fixtureId === sound.fixtureId,
    );
    expect(acceptedDefective?.observedCorrectLabel).toBeNull();
    expect(acceptedDefective?.observedDefectCodes).toEqual(
      acceptedDefective?.acceptedDefectCodes,
    );
    expect(acceptedDefective?.auditor).toBe("Lexa");
    expect(acceptedDefective?.auditorTime).toBe(
      "2026-11-06T11:00:00.000Z",
    );
    expect(acceptedSound?.observedCorrectLabel).not.toBeNull();
    expect(() =>
      validateCalibrationLabels({
        labels: accepted,
        pack: built.pack,
        mode: "verify",
        auditor: "Lexa",
      }),
    ).not.toThrow();
    expect(calibrationLabelsHash(accepted)).toMatch(/^[0-9a-f]{64}$/);

    const contradictory = structuredClone(reviewed) as CalibrationLabels & {
      rows: CalibrationLabelRow[];
    };
    const soundRow = contradictory.rows.find(
      (row) => row.fixtureId === sound.fixtureId,
    );
    if (soundRow === undefined) {
      throw new Error("sound fixture is missing");
    }
    soundRow.observedDefectCodes = ["DUPLICATE_CORRECT_OPTION"];
    const contradictoryAccepted = acceptProposedLabels(contradictory, {
      auditor: "Lexa",
      auditorTime: FIXED_NOW.toISOString(),
    });
    expect(() =>
      validateCalibrationLabels({
        labels: contradictoryAccepted,
        pack: built.pack,
        mode: "verify",
        auditor: "Lexa",
      }),
    ).toThrow(/correct blind result/);
  });

  it("runs exactly 80 blind+alignment calls with zero generations", () => {
    expect(oracleRun.reviewCalls).toBe(80);
    expect(oracleRun.generationCalls).toBe(0);
    expect(oracleRun.transportRequests).toBe(80);
    expect(
      oracleRun.requestRoles.filter((role) => role.startsWith("blind_")),
    ).toHaveLength(40);
    expect(
      oracleRun.requestRoles.filter((role) => role.startsWith("alignment_")),
    ).toHaveLength(40);
    expect(
      oracleRun.requestRoles.some(
        (role) => !role.startsWith("blind_") && !role.startsWith("alignment_"),
      ),
    ).toBe(false);
    expect(oracleRun.observations).toHaveLength(40);
    expect(oracleScore.evidenceKind).toBe("mock");
    expect(oracleScore.liveEligible).toBe(false);
    expect(oracleScore.provenance).toBe("mock_test_only");
    expect(oracleScore.labelsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(oracleScore.labelsHash).toBe(calibrationLabelsHash(labels));
    expect(oracleScore.coverage).toMatchObject({
      reviewed: 40,
      expected: 40,
      errors: 0,
      abstentions: 0,
    });
  });

  it("keeps truth labels out of the blind payload", () => {
    const payload = buildBlindPayload(built.pack.fixtures[0]!);
    expect(Object.keys(payload).sort()).toEqual([
      "clues",
      "options",
      "question",
      "rules",
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("sound");
    expect(serialized).not.toContain("defective");
    expect(serialized).not.toContain("expected");
    expect(serialized).not.toContain("mutation");
    expect(serialized).not.toContain("fixtureId");
  });

  it("produces separate text/SVG blind/alignment matrices and conservative gates", () => {
    expect(Object.keys(oracleScore.combinations)).toEqual([
      "text_blind",
      "text_alignment",
      "svg_blind",
      "svg_alignment",
    ]);
    for (const combination of Object.values(oracleScore.combinations)) {
      expect(combination.matrix).toMatchObject({
        truePositive: 10,
        falsePositive: 0,
        trueNegative: 10,
        falseNegative: 0,
        abstentions: 0,
        errors: 0,
      });
      expect(combination.decisive.defectiveDenominator).toBe(10);
      expect(combination.decisive.soundDenominator).toBe(10);
      expect(combination.conservative.defectiveDenominator).toBe(10);
      expect(combination.conservative.soundDenominator).toBe(10);
      expect(combination.conservative.defectiveNumerator).toBe(10);
      expect(combination.conservative.soundNumerator).toBe(10);
      expect(combination.conservative.sensitivityGate).toBe(true);
      expect(combination.conservative.specificityGate).toBe(true);
      expect(combination.conservative.pass).toBe(true);
      expect(combination.conservative.sensitivityWilson95).not.toBeNull();
      expect(combination.conservative.specificityWilson95).not.toBeNull();
    }
    expect(oracleScore.gates.allPass).toBe(true);
  });

  it("does not make an agree-with-everything mock reviewer sensitive", async () => {
    const score = await runMode("agree");
    expect(score.gates.allPass).toBe(false);
    for (const combination of Object.values(score.combinations)) {
      expect(combination.decisive.sensitivity).toBe(0);
      expect(combination.decisive.specificity).toBe(1);
      expect(combination.conservative.sensitivity).toBe(0);
      expect(combination.conservative.specificity).toBe(1);
      expect(combination.conservative.sensitivityGate).toBe(false);
      expect(combination.conservative.specificityGate).toBe(true);
    }
  });

  it("does not let a reject-everything mock reviewer pass specificity", async () => {
    const score = await runMode("reject");
    expect(score.gates.allPass).toBe(false);
    for (const combination of Object.values(score.combinations)) {
      expect(combination.decisive.sensitivity).toBe(1);
      expect(combination.decisive.specificity).toBe(0);
      expect(combination.conservative.sensitivity).toBe(0);
      expect(combination.conservative.specificity).toBe(0);
      expect(combination.conservative.specificityGate).toBe(false);
    }
  });

  it("does not reward a wrong clean answer on a sound fixture conservatively", () => {
    const observations = cloneObservations(oracleRun.observations);
    const sound = labels.rows.find(
      (row) => row.soundOrDefective === "sound" && row.modality === "text",
    );
    if (sound === undefined || sound.proposedCorrectLabel === null) {
      throw new Error("missing sound text fixture");
    }
    const observation = observations.find(
      (candidate) => candidate.fixtureId === sound.fixtureId,
    );
    if (observation === undefined) {
      throw new Error("missing observation");
    }
    observation.blind.response = {
      ...blindResponse(observation),
      chosenOption: wrongLabel(sound.proposedCorrectLabel),
      clarity: "clear",
      ambiguity: "none",
      issues: [],
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(score.combinations.text_blind!.decisive.specificity).toBe(1);
    expect(score.combinations.text_blind!.conservative.soundNumerator).toBe(9);
    expect(score.combinations.text_blind!.conservative.specificityGate).toBe(true);
  });

  it("does not credit a hedged abstention as a conservative detection", () => {
    const observations = cloneObservations(oracleRun.observations);
    const defective = labels.rows.find(
      (row) => row.soundOrDefective === "defective" && row.modality === "text",
    );
    if (defective === undefined) {
      throw new Error("missing defective text fixture");
    }
    const observation = observations.find(
      (candidate) => candidate.fixtureId === defective.fixtureId,
    );
    if (observation === undefined) {
      throw new Error("missing observation");
    }
    const signal = BLIND_DEFECT_SIGNALS[defective.acceptedDefectCodes[0]!];
    observation.blind.response = {
      ...blindResponse(observation),
      answerStatus: "no_unique_answer",
      chosenOption: null,
      clarity: "unclear",
      ambiguity: "uncertain",
      issues: [{ code: signal.issueCodes[0]!, evidence: "Hedged but named." }],
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(score.combinations.text_blind!.matrix.abstentions).toBe(1);
    expect(score.combinations.text_blind!.conservative.defectiveNumerator).toBe(9);
  });

  it("does not reward unrelated criticism on a defective fixture conservatively", () => {
    const observations = cloneObservations(oracleRun.observations);
    const defective = labels.rows.find(
      (row) => row.soundOrDefective === "defective" && row.modality === "text",
    );
    if (defective === undefined) {
      throw new Error("missing defective text fixture");
    }
    const observation = observations.find(
      (candidate) => candidate.fixtureId === defective.fixtureId,
    );
    if (observation === undefined) {
      throw new Error("missing observation");
    }
    observation.blind.response = {
      ...blindResponse(observation),
      answerStatus: "no_unique_answer",
      chosenOption: null,
      clarity: "unclear",
      ambiguity: "present",
      issues: [{ code: "other", evidence: "Unrelated criticism." }],
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(score.combinations.text_blind!.decisive.sensitivity).toBe(1);
    expect(score.combinations.text_blind!.conservative.defectiveNumerator).toBe(9);
    expect(score.combinations.text_blind!.conservative.sensitivityGate).toBe(true);
  });

  it("does not reward an incorrect failing field or wrong fact ID", () => {
    const observations = cloneObservations(oracleRun.observations);
    const symmetry = rowFor("cal-symmetry-04");
    const observation = observations.find(
      (candidate) => candidate.fixtureId === symmetry.fixtureId,
    );
    if (observation === undefined) {
      throw new Error("missing symmetry observation");
    }
    const response = alignmentResponse(observation);
    const fields: AlignmentFields = structuredClone(response.fields);
    fields.rulesAndClues = {
      status: "pass",
      factIds: [],
      reason: "Mock pass.",
    };
    fields.hint = {
      status: "fail",
      factIds: [],
      reason: "Unrelated hint criticism.",
    };
    observation.alignment.response = {
      overall: "fail",
      fields,
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(score.combinations.svg_alignment!.decisive.sensitivity).toBe(1);
    expect(score.combinations.svg_alignment!.conservative.defectiveNumerator).toBe(9);

    const wrongFactFields: AlignmentFields = structuredClone(response.fields);
    wrongFactFields.rulesAndClues = {
      status: "fail",
      factIds: ["r-target"],
      reason: "Wrong accepted fact ID.",
    };
    observation.alignment.response = {
      overall: "fail",
      fields: wrongFactFields,
    };
    const wrongFactScore = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(
      wrongFactScore.combinations.svg_alignment!.conservative.defectiveNumerator,
    ).toBe(9);
  });

  it("keeps credit for an accepted field even when another field also fails", () => {
    const observations = cloneObservations(oracleRun.observations);
    const symmetry = rowFor("cal-symmetry-04");
    const observation = observations.find(
      (candidate) => candidate.fixtureId === symmetry.fixtureId,
    );
    if (observation === undefined) {
      throw new Error("missing symmetry observation");
    }
    const response = alignmentResponse(observation);
    const fields: AlignmentFields = structuredClone(response.fields);
    fields.explanation = {
      status: "fail",
      factIds: [],
      reason: "The original explanation also contradicts the visible rule.",
    };
    observation.alignment.response = {
      overall: "fail",
      fields,
    };
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(score.combinations.svg_alignment!.conservative.defectiveNumerator).toBe(10);
  });

  it("rejects non-review generation counts and changes the label hash with labels", () => {
    expect(() =>
      scoreCalibration({
        labels,
        observations: oracleRun.observations,
        reviewCalls: 80,
        generationCalls: 1,
      }),
    ).toThrow(/review-only/);
    const changed = withLabels((rows) => {
      rows[0]!.notes = "changed";
    });
    expect(calibrationLabelsHash(changed)).not.toBe(calibrationLabelsHash(labels));
  });

  it("counts all-abstain/errors against the fixed all-ten denominators", () => {
    const observations = oracleRun.observations.map((observation) => ({
      fixtureId: observation.fixtureId,
      blind: { response: null, error: "mock timeout" },
      alignment: { response: null, error: "mock timeout" },
    }));
    const score = scoreCalibration({
      labels,
      observations,
      reviewCalls: 80,
      generationCalls: 0,
    });
    expect(score.gates.allPass).toBe(false);
    expect(score.coverage.errors).toBe(80);
    for (const combination of Object.values(score.combinations)) {
      expect(combination.decisive.defectiveDenominator).toBe(0);
      expect(combination.decisive.soundDenominator).toBe(0);
      expect(combination.conservative.defectiveDenominator).toBe(10);
      expect(combination.conservative.soundDenominator).toBe(10);
      expect(combination.conservative.defectiveNumerator).toBe(0);
      expect(combination.conservative.soundNumerator).toBe(0);
      expect(combination.conservative.pass).toBe(false);
    }
  });

  it("keeps all-ten denominators for a partial run and marks missing cases as errors", () => {
    const score = scoreCalibration({
      labels,
      observations: oracleRun.observations.slice(0, 10),
      reviewCalls: 20,
      generationCalls: 0,
    });
    expect(score.coverage.reviewed).toBe(10);
    expect(score.coverage.errors).toBe(60);
    for (const combination of Object.values(score.combinations)) {
      expect(combination.conservative.defectiveDenominator).toBe(10);
      expect(combination.conservative.soundDenominator).toBe(10);
      expect(combination.conservative.pass).toBe(false);
    }
  });

  it("validates mock and human label files, hashes, auditor identity, and times", () => {
    const human = humanLabels();
    expect(() =>
      validateCalibrationLabels({
        labels: human,
        pack: built.pack,
        mode: "verify",
        auditor: "test-auditor",
        clock: CLOCK,
      }),
    ).not.toThrow();
    expect(() =>
      validateCalibrationLabels({
        labels: human,
        pack: built.pack,
        mode: "mock",
        clock: CLOCK,
      }),
    ).toThrow(/mock_test_only/);
    expect(() =>
      validateCalibrationLabels({
        labels: labels,
        pack: built.pack,
        mode: "verify",
        auditor: "test-auditor",
        clock: CLOCK,
      }),
    ).toThrow(/human provenance/);
    expect(() =>
      validateCalibrationLabels({
        labels: withLabels((rows) => {
          rows[0]!.fixtureHash = "0".repeat(64);
        }),
        pack: built.pack,
        mode: "mock",
        clock: CLOCK,
      }),
    ).toThrow(/metadata/);
    expect(() =>
      validateCalibrationLabels({
        labels: withLabels((rows) => {
          rows[0]!.packHash = "1".repeat(64);
        }),
        pack: built.pack,
        mode: "mock",
        clock: CLOCK,
      }),
    ).toThrow(/pack/);
    expect(() =>
      validateCalibrationLabels({
        labels: withLabels((rows) => {
          rows[0]!.observedBlindResult = "";
        }),
        pack: built.pack,
        mode: "mock",
        clock: CLOCK,
      }),
    ).toThrow(/observed blind result/);
    expect(() =>
      validateCalibrationLabels({
        labels: withLabels((rows) => {
          rows[0]!.auditorTime = "2999-01-01T00:00:00.000Z";
        }),
        pack: built.pack,
        mode: "mock",
        clock: CLOCK,
      }),
    ).toThrow(/future/);
    expect(() =>
      validateCalibrationLabels({
        labels: human,
        pack: built.pack,
        mode: "verify",
        auditor: "other-auditor",
        clock: CLOCK,
      }),
    ).toThrow(/auditor/);
  });
});
