import type {
  BuiltCalibrationPack,
  CalibrationFixture,
} from "./fixtures.js";
import type {
  CalibrationLabelRow,
  CalibrationLabels,
} from "./labels.js";
import type { CalibrationScoreReport } from "./score.js";

const PILOT_AUDITOR = "pilot-code";
const PILOT_AUDITOR_TIME = "2026-11-07T00:00:00.000Z";

function pilotLabelRow(
  packHash: string,
  fixture: CalibrationFixture,
): CalibrationLabelRow {
  const expected = fixture.expected;
  return {
    packHash,
    fixtureId: fixture.fixtureId,
    slotId: fixture.slotId,
    sourceFixtureId: fixture.sourceFixtureId,
    family: fixture.family,
    modality: fixture.modality,
    difficulty: fixture.difficulty,
    soundOrDefective: fixture.variant,
    seed: fixture.seed,
    contentHash: fixture.contentHash,
    pngHash: fixture.pngHash,
    svgHash: fixture.svgHash,
    fixtureHash: fixture.fixtureHash,
    proposedBlindResult: expected.blind.result,
    proposedCorrectLabel: expected.blind.correctLabel,
    acceptedDefectCodes: [...expected.blind.acceptedDefectCodes],
    proposedAlignmentResult: expected.alignment.result,
    acceptedFailingFields: [...expected.alignment.acceptedFailingFields],
    acceptedFactIds: [...expected.alignment.acceptedFactIds],
    corruptionExplanation:
      fixture.mutation?.description ?? "Sound pilot fixture.",
    observedBlindResult: expected.blind.result,
    observedCorrectLabel: expected.blind.correctLabel,
    observedDefectCodes: [...expected.blind.acceptedDefectCodes],
    observedAlignmentResult: expected.alignment.result,
    observedFailingFields: [...expected.alignment.acceptedFailingFields],
    observedFactIds: [...expected.alignment.acceptedFactIds],
    provenance: "mock_test_only",
    humanVerified: false,
    auditor: PILOT_AUDITOR,
    auditorTime: PILOT_AUDITOR_TIME,
    notes:
      "Code-derived pilot truth; not human-verified and not freeze evidence.",
  };
}

export function buildCalibrationPilotLabels(
  built: BuiltCalibrationPack,
): CalibrationLabels {
  return {
    packHash: built.pack.packHash,
    rows: built.fixtures.map((entry) =>
      pilotLabelRow(built.pack.packHash, entry.fixture),
    ),
  };
}

export interface CalibrationPilotPass {
  readonly pass: boolean;
  readonly criteria: string;
  readonly combinations: Readonly<Record<string, boolean>>;
  readonly schemaValidCalls: boolean;
}

export function calibrationPilotPass(
  score: CalibrationScoreReport,
  labels: CalibrationLabels,
): CalibrationPilotPass {
  const expected = (
    modality: "text" | "svg",
    variant: "sound" | "defective",
  ): number =>
    labels.rows.filter(
      (row) => row.modality === modality && row.soundOrDefective === variant,
    ).length;
  const combinations: Record<string, boolean> = {};
  for (const [key, combination] of Object.entries(score.combinations)) {
    const modality = key.startsWith("text") ? "text" : "svg";
    const expectedDefective = expected(modality, "defective");
    const expectedSound = expected(modality, "sound");
    if (expectedDefective === 0 && expectedSound === 0) {
      combinations[key] = true;
      continue;
    }
    combinations[key] =
      expectedDefective > 0 &&
      expectedSound > 0 &&
      combination.conservative.defectiveDenominator === expectedDefective &&
      combination.conservative.defectiveNumerator === expectedDefective &&
      combination.conservative.soundDenominator === expectedSound &&
      combination.conservative.soundNumerator === expectedSound;
  }
  const expectedCalls = labels.rows.length * 2;
  const schemaValidCalls =
    score.reviewCalls === expectedCalls &&
    score.observations === labels.rows.length &&
    score.coverage.errors === 0 &&
    score.coverage.reviewed === labels.rows.length &&
    score.coverage.blindReviewed === labels.rows.length &&
    score.coverage.alignmentReviewed === labels.rows.length;
  return {
    pass: schemaValidCalls && Object.values(combinations).every(Boolean),
    criteria: `${expectedCalls}/${expectedCalls} schema-valid review calls and ${labels.rows.length}/${labels.rows.length} blind plus ${labels.rows.length}/${labels.rows.length} alignment outcomes; each applicable combination requires all labeled defective and sound cases to be detected/passed conservatively.`,
    combinations,
    schemaValidCalls,
  };
}
