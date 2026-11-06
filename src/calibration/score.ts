import type {
  AlignmentFieldName,
  AlignmentOverall,
  AlignmentReviewResponse,
  BlindAnswerStatus,
  BlindIssueCode,
  BlindReviewResponse,
} from "../ai/schemas.js";
import {
  ALIGNMENT_FIELD_NAMES,
  ALIGNMENT_REVIEW_RESPONSE_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
  deriveAlignmentOverall,
} from "../ai/schemas.js";
import type { Modality } from "../domain/experiment.js";
import { wilson95, type WilsonInterval } from "../reporting/metrics.js";
import type { CalibrationDefectCode, CalibrationField } from "./fixtures.js";
import {
  calibrationLabelsHash,
  type CalibrationLabelRow,
  type CalibrationLabels,
} from "./labels.js";

export type CalibrationObservationRole =
  | "blind"
  | "alignment";

export interface CalibrationRoleObservation {
  readonly response: unknown | null;
  readonly error: string | null;
}

export interface CalibrationObservation {
  readonly fixtureId: string;
  readonly blind: CalibrationRoleObservation;
  readonly alignment: CalibrationRoleObservation;
}

export interface CalibrationBlindSignal {
  readonly answerStatus: BlindAnswerStatus;
  readonly issueCodes: readonly BlindIssueCode[];
}

export const BLIND_DEFECT_SIGNALS: Readonly<
  Record<CalibrationDefectCode, CalibrationBlindSignal>
> = {
  DUPLICATE_CORRECT_OPTION: {
    answerStatus: "no_unique_answer",
    issueCodes: ["duplicate_options"],
  },
  NO_VALID_OFFERED_SOLUTION: {
    answerStatus: "no_unique_answer",
    issueCodes: ["no_correct_option"],
  },
  MULTIPLE_OFFERED_SOLUTIONS: {
    answerStatus: "no_unique_answer",
    issueCodes: ["no_correct_option", "ambiguous_rules"],
  },
  CONTRADICTORY_XOR_EXAMPLE: {
    answerStatus: "no_unique_answer",
    issueCodes: ["contradictory_clues", "no_correct_option"],
  },
  CONTRADICTORY_TRANSFORM_INSTRUCTIONS: {
    answerStatus: "no_unique_answer",
    issueCodes: ["ambiguous_rules", "contradictory_clues"],
  },
  CLOSED_ROUTE_EDGE: {
    answerStatus: "no_unique_answer",
    issueCodes: ["no_correct_option", "missing_information"],
  },
  CONTRADICTORY_SYMMETRY_AXIS: {
    answerStatus: "no_unique_answer",
    issueCodes: ["ambiguous_rules", "contradictory_clues"],
  },
  CONFLICTING_COUNTING_CONVENTIONS: {
    answerStatus: "no_unique_answer",
    issueCodes: ["ambiguous_rules", "contradictory_clues"],
  },
};

export function alignmentFieldForCalibrationField(
  field: CalibrationField,
  modality: Modality,
): AlignmentFieldName | null {
  switch (field) {
    case "question":
      return "question";
    case "rules":
    case "clues":
      return "rulesAndClues";
    case "options":
      return "options";
    case "assets":
      return modality === "svg" ? "image" : null;
  }
}

type DecisivePrediction = "defective" | "sound";
type PredictionBucket = DecisivePrediction | "abstention" | "error";

interface RoleCase {
  readonly bucket: PredictionBucket;
  readonly conservative: boolean;
  readonly error: string | null;
}

export interface ScoreCase {
  readonly fixtureId: string;
  readonly modality: Modality;
  readonly truth: "sound" | "defective";
  readonly blind: RoleCase;
  readonly alignment: RoleCase;
}

export interface MatrixCounts {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
  readonly abstentions: number;
  readonly errors: number;
}

export interface RateSet {
  readonly sensitivity: number | null;
  readonly specificity: number | null;
  readonly sensitivityWilson95: WilsonInterval | null;
  readonly specificityWilson95: WilsonInterval | null;
  readonly defectiveDenominator: number;
  readonly soundDenominator: number;
}

export interface ConservativeRateSet extends RateSet {
  readonly defectiveNumerator: number;
  readonly soundNumerator: number;
  readonly sensitivityGate: boolean;
  readonly specificityGate: boolean;
  readonly pass: boolean;
}

export interface CalibrationCombinationScore {
  readonly key: "text_blind" | "text_alignment" | "svg_blind" | "svg_alignment";
  readonly modality: Modality;
  readonly role: CalibrationObservationRole;
  readonly matrix: MatrixCounts;
  readonly decisive: RateSet & {
    readonly coverage: number | null;
  };
  readonly conservative: ConservativeRateSet;
}

export interface CalibrationScoreReport {
  readonly version: 1;
  readonly evidenceKind: "mock";
  readonly liveEligible: false;
  readonly provenance: "mock_test_only" | "human" | "mixed";
  readonly packHash: string;
  readonly labelsHash: string;
  readonly auditor: readonly string[];
  readonly auditorTime: readonly string[];
  readonly fixtureCount: number;
  readonly reviewCalls: number;
  readonly generationCalls: 0;
  readonly observations: number;
  readonly coverage: {
    readonly reviewed: number;
    readonly expected: number;
    readonly errors: number;
    readonly abstentions: number;
  };
  readonly combinations: Readonly<Record<string, CalibrationCombinationScore>>;
  readonly gates: {
    readonly allPass: boolean;
    readonly combinations: Readonly<Record<string, boolean>>;
  };
  readonly cases: readonly ScoreCase[];
}

function blindResponse(value: unknown): {
  readonly response: BlindReviewResponse | null;
  readonly error: string | null;
} {
  const parsed = BLIND_REVIEW_RESPONSE_SCHEMA.safeParse(value);
  return parsed.success
    ? { response: parsed.data, error: null }
    : { response: null, error: "invalid blind response schema" };
}

function alignmentResponse(value: unknown): {
  readonly response: AlignmentReviewResponse | null;
  readonly error: string | null;
} {
  const parsed = ALIGNMENT_REVIEW_RESPONSE_SCHEMA.safeParse(value);
  return parsed.success
    ? { response: parsed.data, error: null }
    : { response: null, error: "invalid alignment response schema" };
}

function blindPrediction(response: BlindReviewResponse | null, error: string | null): RoleCase {
  if (error !== null || response === null) {
    return { bucket: "error", conservative: false, error: error ?? "missing blind response" };
  }
  const selected = response.answerStatus === "selected";
  const clean =
    selected &&
    response.clarity === "clear" &&
    response.ambiguity === "none" &&
    response.issues.length === 0;
  if (clean) {
    return { bucket: "sound", conservative: true, error: null };
  }
  const explicitDefect =
    !selected &&
    response.ambiguity === "present" &&
    response.issues.length > 0;
  if (explicitDefect) {
    return { bucket: "defective", conservative: false, error: null };
  }
  return { bucket: "abstention", conservative: false, error: null };
}

function conservativeBlind(
  row: CalibrationLabelRow,
  response: BlindReviewResponse | null,
): boolean {
  if (response === null) {
    return false;
  }
  if (row.soundOrDefective === "sound") {
    return (
      response.answerStatus === "selected" &&
      response.chosenOption === row.proposedCorrectLabel &&
      response.clarity === "clear" &&
      response.ambiguity === "none" &&
      response.issues.length === 0
    );
  }
  if (
    response.answerStatus === "selected" ||
    response.ambiguity !== "present"
  ) {
    return false;
  }
  const acceptedIssues = new Set<BlindIssueCode>();
  for (const code of row.acceptedDefectCodes) {
    for (const issueCode of BLIND_DEFECT_SIGNALS[code].issueCodes) {
      acceptedIssues.add(issueCode);
    }
  }
  return response.issues.some((issue) => acceptedIssues.has(issue.code));
}

function alignmentDerived(
  response: AlignmentReviewResponse | null,
  modality: Modality,
  error: string | null,
): { derived: AlignmentOverall | null; error: string | null } {
  if (error !== null || response === null) {
    return { derived: null, error: error ?? "missing alignment response" };
  }
  try {
    return {
      derived: deriveAlignmentOverall(response.fields, modality),
      error: null,
    };
  } catch (cause) {
    return {
      derived: null,
      error: cause instanceof Error ? cause.message : "invalid alignment response",
    };
  }
}

function alignmentPrediction(
  response: AlignmentReviewResponse | null,
  modality: Modality,
  error: string | null,
): RoleCase {
  const result = alignmentDerived(response, modality, error);
  if (result.error !== null || result.derived === null || response === null) {
    return { bucket: "error", conservative: false, error: result.error };
  }
  if (response.overall !== result.derived) {
    return {
      bucket: "abstention",
      conservative: false,
      error: "alignment overall contradicts derived field statuses",
    };
  }
  if (result.derived === "pass") {
    return { bucket: "sound", conservative: true, error: null };
  }
  if (result.derived === "fail") {
    return { bucket: "defective", conservative: false, error: null };
  }
  return { bucket: "abstention", conservative: false, error: null };
}

function conservativeAlignment(
  row: CalibrationLabelRow,
  response: AlignmentReviewResponse | null,
): boolean {
  if (response === null) {
    return false;
  }
  let derived: AlignmentOverall;
  try {
    derived = deriveAlignmentOverall(response.fields, row.modality);
  } catch {
    return false;
  }
  if (response.overall !== derived) {
    return false;
  }
  if (row.soundOrDefective === "sound") {
    return derived === "pass";
  }
  if (derived !== "fail") {
    return false;
  }
  const acceptedFields = new Set(
    row.acceptedFailingFields
      .map((field) => alignmentFieldForCalibrationField(field, row.modality))
      .filter((field): field is AlignmentFieldName => field !== null),
  );
  const nonAcceptedFields = ALIGNMENT_FIELD_NAMES.filter(
    (fieldName) =>
      !acceptedFields.has(fieldName) &&
      !(fieldName === "image" && row.modality === "text"),
  );
  if (
    !nonAcceptedFields.some((fieldName) => {
      const field = response.fields[fieldName];
      return field.status === "pass" || field.status === "not_applicable";
    })
  ) {
    return false;
  }
  const acceptedFactIds = new Set(row.acceptedFactIds);
  for (const fieldName of acceptedFields) {
    const field = response.fields[fieldName];
    if (field.status !== "fail") {
      continue;
    }
    if (
      acceptedFactIds.size === 0 ||
      field.factIds.some((factId) => acceptedFactIds.has(factId))
    ) {
      return true;
    }
  }
  return false;
}

function matrix(cases: readonly { readonly truth: "sound" | "defective"; readonly bucket: PredictionBucket }[]): MatrixCounts {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let abstentions = 0;
  let errors = 0;
  for (const item of cases) {
    if (item.bucket === "abstention") {
      abstentions += 1;
    } else if (item.bucket === "error") {
      errors += 1;
    } else if (item.truth === "defective" && item.bucket === "defective") {
      truePositive += 1;
    } else if (item.truth === "defective" && item.bucket === "sound") {
      falseNegative += 1;
    } else if (item.truth === "sound" && item.bucket === "defective") {
      falsePositive += 1;
    } else {
      trueNegative += 1;
    }
  }
  return {
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    abstentions,
    errors,
  };
}

function rate(
  numerator: number,
  denominator: number,
): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function decisiveRates(counts: MatrixCounts): RateSet & { coverage: number | null } {
  const defectiveDenominator = counts.truePositive + counts.falseNegative;
  const soundDenominator = counts.trueNegative + counts.falsePositive;
  return {
    sensitivity: rate(counts.truePositive, defectiveDenominator),
    specificity: rate(counts.trueNegative, soundDenominator),
    sensitivityWilson95: wilson95(counts.truePositive, defectiveDenominator),
    specificityWilson95: wilson95(counts.trueNegative, soundDenominator),
    defectiveDenominator,
    soundDenominator,
    coverage: rate(
      counts.truePositive + counts.falseNegative + counts.trueNegative + counts.falsePositive,
      counts.truePositive +
        counts.falseNegative +
        counts.trueNegative +
        counts.falsePositive +
        counts.abstentions +
        counts.errors,
    ),
  };
}

function conservativeRates(
  cases: readonly { readonly truth: "sound" | "defective"; readonly conservative: boolean }[],
): ConservativeRateSet {
  const defective = cases.filter((item) => item.truth === "defective");
  const sound = cases.filter((item) => item.truth === "sound");
  const defectiveNumerator = defective.filter((item) => item.conservative).length;
  const soundNumerator = sound.filter((item) => item.conservative).length;
  return {
    sensitivity: rate(defectiveNumerator, defective.length),
    specificity: rate(soundNumerator, sound.length),
    sensitivityWilson95: wilson95(defectiveNumerator, defective.length),
    specificityWilson95: wilson95(soundNumerator, sound.length),
    defectiveDenominator: defective.length,
    soundDenominator: sound.length,
    defectiveNumerator,
    soundNumerator,
    sensitivityGate: defectiveNumerator >= 9,
    specificityGate: soundNumerator >= 8,
    pass: defectiveNumerator >= 9 && soundNumerator >= 8,
  };
}

function combination(
  key: CalibrationCombinationScore["key"],
  modality: Modality,
  role: CalibrationObservationRole,
  cases: readonly ScoreCase[],
): CalibrationCombinationScore {
  const relevant = cases.filter((item) => item.modality === modality);
  const roleCases = relevant.map((item) => ({
    truth: item.truth,
    bucket: item[role].bucket,
    conservative: item[role].conservative,
  }));
  const counts = matrix(roleCases);
  return {
    key,
    modality,
    role,
    matrix: counts,
    decisive: decisiveRates(counts),
    conservative: conservativeRates(roleCases),
  };
}

export interface ScoreCalibrationInput {
  readonly labels: CalibrationLabels;
  readonly observations: readonly CalibrationObservation[];
  readonly reviewCalls: number;
  readonly generationCalls: number;
}

export function scoreCalibration(
  input: ScoreCalibrationInput,
): CalibrationScoreReport {
  if (input.generationCalls !== 0) {
    throw new Error(
      "P41 calibration scoring is review-only; generationCalls must be 0",
    );
  }
  const observations = new Map(
    input.observations.map((observation) => [observation.fixtureId, observation]),
  );
  const cases: ScoreCase[] = input.labels.rows.map((row) => {
    const observation = observations.get(row.fixtureId);
    const blindParsed = blindResponse(observation?.blind.response ?? null);
    const alignmentParsed = alignmentResponse(observation?.alignment.response ?? null);
    const blind = blindParsed.response;
    const alignment = alignmentParsed.response;
    const blindCase = blindPrediction(
      blind,
      observation?.blind.error ??
        blindParsed.error ??
        (observation === undefined ? "missing observation" : null),
    );
    const alignmentCase = alignmentPrediction(
      alignment,
      row.modality,
      observation?.alignment.error ??
        alignmentParsed.error ??
        (observation === undefined ? "missing observation" : null),
    );
    return {
      fixtureId: row.fixtureId,
      modality: row.modality,
      truth: row.soundOrDefective,
      blind: {
        ...blindCase,
        conservative: conservativeBlind(row, blind),
      },
      alignment: {
        ...alignmentCase,
        conservative: conservativeAlignment(row, alignment),
      },
    };
  });
  const combinations = {
    text_blind: combination("text_blind", "text", "blind", cases),
    text_alignment: combination("text_alignment", "text", "alignment", cases),
    svg_blind: combination("svg_blind", "svg", "blind", cases),
    svg_alignment: combination("svg_alignment", "svg", "alignment", cases),
  };
  const errors = cases.reduce(
    (total, item) =>
      total +
      (item.blind.bucket === "error" ? 1 : 0) +
      (item.alignment.bucket === "error" ? 1 : 0),
    0,
  );
  const abstentions = cases.reduce(
    (total, item) =>
      total +
      (item.blind.bucket === "abstention" ? 1 : 0) +
      (item.alignment.bucket === "abstention" ? 1 : 0),
    0,
  );
  const provenance = new Set(input.labels.rows.map((row) => row.provenance));
  return {
    version: 1,
    evidenceKind: "mock",
    liveEligible: false,
    provenance:
      provenance.size === 1
        ? (input.labels.rows[0]?.provenance === "human" ? "human" : "mock_test_only")
        : "mixed",
    packHash: input.labels.packHash,
    labelsHash: calibrationLabelsHash(input.labels),
    auditor: [...new Set(input.labels.rows.map((row) => row.auditor))],
    auditorTime: [...new Set(input.labels.rows.map((row) => row.auditorTime))],
    fixtureCount: input.labels.rows.length,
    reviewCalls: input.reviewCalls,
    generationCalls: 0,
    observations: input.observations.length,
    coverage: {
      reviewed: input.observations.length,
      expected: input.labels.rows.length,
      errors,
      abstentions,
    },
    combinations,
    gates: {
      allPass: Object.values(combinations).every((item) => item.conservative.pass),
      combinations: Object.fromEntries(
        Object.entries(combinations).map(([key, item]) => [
          key,
          item.conservative.pass,
        ]),
      ),
    },
    cases,
  };
}
