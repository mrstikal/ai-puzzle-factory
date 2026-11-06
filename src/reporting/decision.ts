import { Decimal } from "decimal.js";
import {
  FAMILIES,
  LANES,
  THRESHOLDS,
  type Family,
  type Modality,
} from "../domain/experiment.js";
import {
  CALIBRATION_COMBINATIONS,
  verifyFrozenProtocol,
  type CalibrationCombination,
  type CalibrationGateEvidence,
  type FrozenProtocol,
} from "../experiment/freeze.js";

export type FinalDecision = "proceed" | "revise" | "reject";

export interface FinalApprovalCounts {
  readonly approved: number;
  readonly planned: number;
}

export interface FinalDecisionEvidence {
  readonly run: {
    readonly runId: string;
    readonly runKind: string;
    readonly evidenceKind: string;
    readonly controlState: string;
    readonly planned: number;
    readonly terminal: number;
    readonly configHash: string;
    readonly planHash: string;
    readonly rootSeed: string;
    readonly protocolVersion: string;
  };
  readonly approvals: {
    readonly byModality: Readonly<Record<Modality, FinalApprovalCounts>>;
    readonly byFamily: Readonly<Record<Family, FinalApprovalCounts>>;
    readonly byFamilyLane: Readonly<Record<string, FinalApprovalCounts>>;
  };
  readonly uniqueness: {
    readonly structuralUniqueness: number | null;
    readonly fingerprintCoverage: number | null;
  };
  readonly cost: {
    readonly actualCostUsd: string | null;
    readonly knownComplete: boolean;
    readonly costPerApprovedUsd: string | null;
    readonly unknownAttempts: number;
  };
  readonly nearDuplicate: {
    readonly approvedHighRisk: number;
    readonly onlyNear: number;
    readonly additionalQuality: number;
    readonly incompleteOrFailedReview: number;
    readonly byFamily: Readonly<
      Record<
        Family,
        {
          readonly onlyNear: number;
          readonly additionalQuality: number;
          readonly incompleteOrFailedReview: number;
        }
      >
    >;
    readonly byFamilyLane: Readonly<
      Record<
        string,
        {
          readonly onlyNear: number;
          readonly additionalQuality: number;
          readonly incompleteOrFailedReview: number;
        }
      >
    >;
  };
  readonly calibration: {
    readonly evidenceKind: string;
    readonly completedAt: string;
    readonly configHash: string;
    readonly packHash: string;
    readonly labelsHash: string;
    readonly combinations: Readonly<
      Record<CalibrationCombination, CalibrationGateEvidence>
    >;
  };
  readonly audit: {
    readonly complete: boolean;
    readonly sampleHash: string;
    readonly labelsHash: string;
    readonly coreSampled: number;
    readonly coreInspectable: number;
    readonly totalInspectable: number;
    readonly approvedSampled: number;
    readonly approvedInspectable: number;
    /**
     * Approved core slots that are inspectable and genuinely audited, keyed by family.
     */
    readonly approvedCoreByFamily: Readonly<Record<Family, number>>;
    readonly clarityAndTimePass: number;
    readonly clarityAndTimeDenominator: number;
    readonly unresolvedSoundnessDefects: number;
    readonly unresolvedDisagreements: number;
    readonly correctnessDefectsByFamily: Readonly<Record<Family, number>>;
  };
  readonly routesSupported: boolean;
  readonly frozen?: FrozenProtocol;
}

export interface DecisionPredicate {
  readonly id: string;
  readonly status: "pass" | "fail" | "not_evaluable";
  readonly detail: string;
  readonly required: string;
  readonly actual: string;
}

export interface FinalDecisionReport {
  readonly version: 1;
  readonly decision: FinalDecision;
  readonly complete: boolean;
  readonly failed: readonly DecisionPredicate[];
  readonly strongFailures: readonly string[];
  readonly caveats: readonly string[];
  readonly predicates: readonly DecisionPredicate[];
  readonly thresholds: typeof THRESHOLDS;
  readonly nearDuplicate: FinalDecisionEvidence["nearDuplicate"];
  readonly denominators: {
    readonly textApproval: FinalApprovalCounts;
    readonly svgApproval: FinalApprovalCounts;
    readonly familyApproval: Readonly<Record<Family, FinalApprovalCounts>>;
    readonly familyLaneApproval: Readonly<Record<string, FinalApprovalCounts>>;
    readonly audit: {
      readonly coreSampled: number;
      readonly coreInspectable: number;
      readonly totalInspectable: number;
      readonly approvedSampled: number;
      readonly approvedInspectable: number;
    };
  };
}

function predicate(
  id: string,
  pass: boolean,
  detail: string,
  required: string,
  actual: string,
  evaluable = true,
): DecisionPredicate {
  return {
    id,
    status: evaluable ? (pass ? "pass" : "fail") : "not_evaluable",
    detail,
    required,
    actual,
  };
}

function moneyAtMost(value: string | null, maximum: string): boolean {
  if (value === null) {
    return false;
  }
  try {
    return new Decimal(value).lte(new Decimal(maximum));
  } catch {
    return false;
  }
}

function ratio(value: number, denominator: number): number | null {
  return denominator === 0 ? null : value / denominator;
}

export function decideFinal(
  evidence: FinalDecisionEvidence,
): FinalDecisionReport {
  const predicates: DecisionPredicate[] = [];
  const caveats: string[] = [];
  const strongFailures: string[] = [];
  const add = (item: DecisionPredicate) => {
    predicates.push(item);
    return item;
  };
  const runComplete =
    evidence.run.runKind === "full" &&
    evidence.run.evidenceKind === "live" &&
    evidence.run.controlState === "completed" &&
    evidence.run.planned === 200 &&
    evidence.run.terminal === 200;
  add(
    predicate(
      "completed_live_200_slot_cohort",
      runComplete,
      "A completed live full run with 200 terminal planned slots is required.",
      "runKind=full, evidenceKind=live, controlState=completed, 200/200",
      `${evidence.run.runKind}/${evidence.run.evidenceKind}/${evidence.run.controlState}/${evidence.run.terminal}of${evidence.run.planned}`,
    ),
  );
  const calibrationUsable =
    evidence.calibration.evidenceKind === "live" &&
    evidence.calibration.configHash === evidence.run.configHash &&
    CALIBRATION_COMBINATIONS.every(
      (combination) => evidence.calibration.combinations[combination] !== undefined,
    );
  add(
    predicate(
      "valid_same_configuration_live_calibration",
      calibrationUsable,
      "Calibration must be live, same-configuration, and contain all four modality/role combinations.",
      "live calibration with the run config and four combinations",
      `${evidence.calibration.evidenceKind}/${evidence.calibration.configHash === evidence.run.configHash ? "same-config" : "drift"}`,
    ),
  );
  const calibrationDenominatorsValid = CALIBRATION_COMBINATIONS.every(
    (combination) => {
      const gate = evidence.calibration.combinations[combination];
      return (
        gate !== undefined &&
        gate.defectiveDenominator === 10 &&
        gate.soundDenominator === 10
      );
    },
  );
  add(
    predicate(
      "calibration_denominators_10",
      calibrationDenominatorsValid,
      "Each calibration combination must retain ten defective and ten sound cases.",
      "10 defective and 10 sound in all four combinations",
      CALIBRATION_COMBINATIONS.map((combination) => {
        const gate = evidence.calibration.combinations[combination];
        return `${combination}=${gate?.defectiveDenominator ?? "?"}/${gate?.soundDenominator ?? "?"}`;
      }).join(","),
      calibrationUsable,
    ),
  );
  const calibrationGates = CALIBRATION_COMBINATIONS.every((combination) => {
    const gate = evidence.calibration.combinations[combination];
    return (
      gate !== undefined &&
      gate.pass &&
      gate.sensitivity >= THRESHOLDS.calibrationSensitivityMin &&
      gate.specificity >= THRESHOLDS.calibrationSpecificityMin
    );
  });
  add(
    predicate(
      "calibration_gates",
      calibrationGates,
      "Each text/SVG blind/alignment combination must meet the fixed calibration gates.",
      `sensitivity >= ${THRESHOLDS.calibrationSensitivityMin}, specificity >= ${THRESHOLDS.calibrationSpecificityMin} in all four combinations`,
      CALIBRATION_COMBINATIONS.map((combination) => {
        const gate = evidence.calibration.combinations[combination];
        return `${combination}=${gate?.sensitivity ?? "?"}/${gate?.specificity ?? "?"}`;
      }).join(","),
      calibrationUsable,
    ),
  );
  const text = evidence.approvals.byModality.text ?? { approved: 0, planned: 0 };
  const svg = evidence.approvals.byModality.svg ?? { approved: 0, planned: 0 };
  const modalityDenominatorsValid = text.planned === 100 && svg.planned === 100;
  add(
    predicate(
      "modality_denominators_100",
      modalityDenominatorsValid,
      "Text and SVG approval denominators are fixed at 100.",
      "text planned=100 and svg planned=100",
      `${text.planned}/${svg.planned}`,
    ),
  );
  add(
    predicate(
      "text_approval_80_of_100",
      text.approved >= THRESHOLDS.textApprovalMin && text.planned === 100,
      "Text approval must meet the frozen 80/100 floor.",
      `${THRESHOLDS.textApprovalMin}/100`,
      `${text.approved}/${text.planned}`,
    ),
  );
  add(
    predicate(
      "svg_approval_80_of_100",
      svg.approved >= THRESHOLDS.svgApprovalMin && svg.planned === 100,
      "SVG approval must meet the frozen 80/100 floor.",
      `${THRESHOLDS.svgApprovalMin}/100`,
      `${svg.approved}/${svg.planned}`,
    ),
  );
  const families = FAMILIES.map(
    (family) =>
      [family, evidence.approvals.byFamily[family] ?? { approved: 0, planned: 0 }] as [
        Family,
        FinalApprovalCounts,
      ],
  );
  const familyLaneKeys = FAMILIES.flatMap((family) =>
    LANES.map((lane) => `${family}/${lane}`),
  );
  const familyLaneComplete = familyLaneKeys.every(
    (key) => evidence.approvals.byFamilyLane[key] !== undefined,
  );
  add(
    predicate(
      "family_lane_denominators_complete",
      familyLaneComplete,
      "Every family/lane cell must be disclosed.",
      `${familyLaneKeys.length} family/lane cells`,
      `${Object.keys(evidence.approvals.byFamilyLane).length} supplied`,
    ),
  );
  const familyFloorPass = families.every(
    ([, counts]) => counts.planned === 20 && counts.approved >= THRESHOLDS.familyApprovalMin,
  );
  add(
    predicate(
      "family_approval_10_of_20",
      familyFloorPass,
      "No family may fall below the frozen 10/20 approval floor.",
      `${THRESHOLDS.familyApprovalMin}/20 in every family`,
      families.map(([family, counts]) => `${family}=${counts.approved}/${counts.planned}`).join(","),
    ),
  );
  const uniqueness = evidence.uniqueness.structuralUniqueness;
  add(
    predicate(
      "structural_uniqueness_95",
      uniqueness !== null && uniqueness >= THRESHOLDS.structuralUniquenessMin,
      "Distinct structural fingerprints must cover the frozen uniqueness floor.",
      `>= ${THRESHOLDS.structuralUniquenessMin}`,
      uniqueness === null ? "missing" : String(uniqueness),
    ),
  );
  const fingerprintCoverage = evidence.uniqueness.fingerprintCoverage;
  add(
    predicate(
      "fingerprint_coverage_80",
      fingerprintCoverage !== null && fingerprintCoverage >= THRESHOLDS.fingerprintCoverageMin,
      "Fingerprintable candidates must cover the frozen coverage floor.",
      `>= ${THRESHOLDS.fingerprintCoverageMin}`,
      fingerprintCoverage === null ? "missing" : String(fingerprintCoverage),
    ),
  );
  const costKnown =
    evidence.cost.knownComplete &&
    evidence.cost.actualCostUsd !== null &&
    evidence.cost.unknownAttempts === 0;
  add(
    predicate(
      "known_complete_costs",
      costKnown,
      "All possibly billed primary attempts must have known cost evidence.",
      "knownComplete, actual cost present, zero unknown attempts",
      `${evidence.cost.knownComplete}/${evidence.cost.actualCostUsd ?? "null"}/${evidence.cost.unknownAttempts}`,
    ),
  );
  add(
    predicate(
      "cost_per_approved_010",
      moneyAtMost(evidence.cost.costPerApprovedUsd, THRESHOLDS.costPerApprovedMaxUsd),
      "Primary actual cost per approved puzzle must meet the frozen USD 0.10 threshold.",
      `<= ${THRESHOLDS.costPerApprovedMaxUsd} USD`,
      evidence.cost.costPerApprovedUsd === null ? "missing" : `${evidence.cost.costPerApprovedUsd} USD`,
    ),
  );
  add(
    predicate(
      "no_approved_high_risk_near_duplicate",
      evidence.nearDuplicate.approvedHighRisk === 0,
      "No approved candidate may retain a high-risk near-duplicate flag.",
      "0 approved high-risk near-duplicates",
      String(evidence.nearDuplicate.approvedHighRisk),
    ),
  );
  add(
    predicate(
      "audit_completed",
      evidence.audit.complete,
      "The required human audit must be completed with imported labels.",
      "complete audit sample with labels",
      evidence.audit.complete ? "complete" : "incomplete",
    ),
  );
  add(
    predicate(
      "audit_core_inspectable_32",
      evidence.audit.coreInspectable >= THRESHOLDS.auditCoreSlotsMin,
      "At least 32 core audit slots must be inspectable and genuinely audited.",
      `>= ${THRESHOLDS.auditCoreSlotsMin}`,
      `${evidence.audit.coreInspectable}/${evidence.audit.coreSampled}`,
      evidence.audit.complete,
    ),
  );
  const approvedCoreFamilies = families.every(
    ([family]) =>
      (evidence.audit.approvedCoreByFamily[family] ?? 0) >=
      THRESHOLDS.auditApprovedPerFamilyMin,
  );
  const approvedCoreTotal = families.reduce(
    (total, [family]) => total + (evidence.audit.approvedCoreByFamily[family] ?? 0),
    0,
  );
  const auditDenominatorsConsistent =
    evidence.audit.coreInspectable <= evidence.audit.coreSampled &&
    evidence.audit.approvedInspectable <= evidence.audit.approvedSampled &&
    evidence.audit.approvedInspectable >= approvedCoreTotal &&
    evidence.audit.clarityAndTimePass <= evidence.audit.clarityAndTimeDenominator &&
    evidence.audit.unresolvedSoundnessDefects <= evidence.audit.approvedInspectable &&
    evidence.audit.clarityAndTimeDenominator === evidence.audit.approvedInspectable;
  add(
    predicate(
      "audit_denominators_consistent",
      auditDenominatorsConsistent,
      "Audit counters must be mutually consistent and the approval-based clarity denominator must equal approved inspectable approvals.",
      "core inspectable <= sampled, approved inspectable <= sampled, approved inspectable >= approved core, clarity pass <= clarity denominator, unresolved defects <= approved inspectable, clarity denominator = approved inspectable",
      `core ${evidence.audit.coreInspectable}/${evidence.audit.coreSampled}, approved ${evidence.audit.approvedInspectable}/${evidence.audit.approvedSampled}, core-approved ${approvedCoreTotal}, clarity denominator ${evidence.audit.clarityAndTimeDenominator}`,
      evidence.audit.complete,
    ),
  );
  const nearByFamily = evidence.nearDuplicate.byFamily ?? {};
  const nearByFamilyLane = evidence.nearDuplicate.byFamilyLane ?? {};
  const nearDisclosureComplete =
    FAMILIES.every((family) => nearByFamily[family] !== undefined) &&
    familyLaneKeys.every((key) => nearByFamilyLane[key] !== undefined);
  add(
    predicate(
      "near_duplicate_disclosure_complete",
      nearDisclosureComplete,
      "Near-duplicate categories must be disclosed for every family and family/lane cell.",
      `${FAMILIES.length} families and ${familyLaneKeys.length} family/lane cells`,
      `${Object.keys(nearByFamily).length}/${Object.keys(nearByFamilyLane).length}`,
    ),
  );
  add(
    predicate(
      "audit_approved_inspectable_20",
      evidence.audit.approvedInspectable >= THRESHOLDS.auditApprovedCoreSlotsMin,
      "The approval-based audit denominator may never be zero, one, or two; at least 20 approved slots must be inspectable.",
      `>= ${THRESHOLDS.auditApprovedCoreSlotsMin}`,
      String(evidence.audit.approvedInspectable),
      evidence.audit.complete,
    ),
  );
  add(
    predicate(
      "audit_approved_core_two_per_family",
      approvedCoreFamilies && approvedCoreTotal >= THRESHOLDS.auditApprovedCoreSlotsMin,
      "At least two approved core slots per family and 20 total must be inspectable.",
      `${THRESHOLDS.auditApprovedPerFamilyMin} per family and ${THRESHOLDS.auditApprovedCoreSlotsMin} total`,
      families.map(([family]) => `${family}=${evidence.audit.approvedCoreByFamily[family] ?? 0}`).join(","),
      evidence.audit.complete,
    ),
  );
  add(
    predicate(
      "audit_no_unresolved_soundness_semantic_legibility",
      evidence.audit.unresolvedSoundnessDefects === 0,
      "No audited approval may retain an unresolved soundness, semantic, or legibility defect.",
      "0 unresolved defects among audited approvals",
      `${evidence.audit.unresolvedSoundnessDefects} of ${evidence.audit.approvedInspectable}`,
      evidence.audit.complete && evidence.audit.approvedInspectable > 0,
    ),
  );
  const clearAndSolved =
    evidence.audit.clarityAndTimeDenominator > 0
      ? ratio(
          evidence.audit.clarityAndTimePass,
          evidence.audit.clarityAndTimeDenominator,
        )
      : null;
  add(
    predicate(
      "audit_clear_and_solved_within_180s_80pct",
      clearAndSolved !== null &&
        clearAndSolved >= THRESHOLDS.auditClearAndSolvedWithin180sMin,
      "At least 80% of inspectable audited approvals must be clear and solved within 180 seconds.",
      `>= ${THRESHOLDS.auditClearAndSolvedWithin180sMin}`,
      clearAndSolved === null ? "missing" : String(clearAndSolved),
      evidence.audit.complete &&
        auditDenominatorsConsistent &&
        evidence.audit.approvedInspectable >= THRESHOLDS.auditApprovedCoreSlotsMin,
    ),
  );
  add(
    predicate(
      "audit_no_unresolved_disagreement",
      evidence.audit.unresolvedDisagreements === 0,
      "Unresolved human/reviewer disagreement blocks proceed rather than being forced.",
      "0 unresolved disagreements",
      String(evidence.audit.unresolvedDisagreements),
      evidence.audit.complete && evidence.audit.approvedInspectable > 0,
    ),
  );
  add(
    predicate(
      "routes_supported",
      evidence.routesSupported,
      "All required model routes must remain supported.",
      "all routes supported",
      String(evidence.routesSupported),
    ),
  );
  const frozenMatches =
    evidence.frozen !== undefined &&
    verifyFrozenProtocol(evidence.frozen) &&
    evidence.frozen.configHash === evidence.run.configHash &&
    evidence.frozen.planHash === evidence.run.planHash &&
    evidence.frozen.rootSeed === evidence.run.rootSeed &&
    evidence.frozen.protocolVersion === evidence.run.protocolVersion &&
    evidence.frozen.calibrationCompletedAt === evidence.calibration.completedAt &&
    evidence.frozen.fixturePackHash === evidence.calibration.packHash &&
    evidence.frozen.labelsHash === evidence.calibration.labelsHash &&
    evidence.frozen.costPerApprovedThresholdUsd ===
      THRESHOLDS.costPerApprovedMaxUsd;
  add(
    predicate(
      "frozen_protocol_matches",
      frozenMatches,
      "The final evidence must match the frozen protocol, calibration, and fixture pack.",
      "frozen hash/config/plan/root/calibration/pack/threshold agree",
      evidence.frozen === undefined ? "missing" : frozenMatches ? "match" : "drift",
      evidence.frozen !== undefined,
    ),
  );
  if (evidence.frozen === undefined) {
    caveats.push("No frozen protocol was supplied; freeze evidence is missing and proceed is not allowed.");
  }
  if (evidence.nearDuplicate.onlyNear > 0) {
    caveats.push(
      `${evidence.nearDuplicate.onlyNear} approval shortfall(s) are novelty-only near-duplicate concerns; the frozen proceed gate is not waived.`,
    );
  }
  if (evidence.nearDuplicate.additionalQuality > 0) {
    caveats.push(
      `${evidence.nearDuplicate.additionalQuality} near-duplicate-blocked candidate(s) also have quality findings.`,
    );
  }
  if (evidence.nearDuplicate.incompleteOrFailedReview > 0) {
    caveats.push(
      `${evidence.nearDuplicate.incompleteOrFailedReview} near-duplicate-blocked candidate(s) have incomplete or failed review evidence (unverified, not a proven quality defect).`,
    );
  }
  for (const family of FAMILIES) {
    const counts = nearByFamily[family];
    if (counts !== undefined && counts.onlyNear > 0) {
      caveats.push(
        `${family}: ${counts.onlyNear} novelty-only near-duplicate approval shortfall(s).`,
      );
    }
  }
  if (evidence.audit.complete) {
    caveats.push(
      "The human audit is stratified and enriched for problems; its defect fraction is not an unbiased population accuracy estimate.",
    );
  }
  if (!runComplete) {
    caveats.push("The primary run is not a completed live 200-slot cohort; the decision is incomplete evidence, not a business rejection.");
  }
  if (!costKnown) {
    caveats.push("Primary costs are not known-complete; the final decision cannot be proceed or reject on cost evidence.");
  }
  if (!evidence.audit.complete) {
    caveats.push("The required human audit is incomplete; missing human evidence blocks proceed and reject.");
  }
  if (!calibrationUsable) {
    caveats.push("Calibration evidence is missing, mock, or configuration-drifted.");
  }
  const evaluable =
    runComplete &&
    modalityDenominatorsValid &&
    familyLaneComplete &&
    nearDisclosureComplete &&
    calibrationUsable &&
    calibrationDenominatorsValid &&
    costKnown &&
    evidence.routesSupported &&
    evidence.audit.complete &&
    auditDenominatorsConsistent &&
    evidence.audit.approvedInspectable >= THRESHOLDS.auditApprovedCoreSlotsMin &&
    frozenMatches;
  const textRatio = text.planned === 100 ? text.approved / 100 : null;
  const svgRatio = svg.planned === 100 ? svg.approved / 100 : null;
  const rejectModality =
    (textRatio !== null && textRatio < THRESHOLDS.rejectModalityApprovalBelow) ||
    (svgRatio !== null && svgRatio < THRESHOLDS.rejectModalityApprovalBelow);
  const calibrationBelowReject =
    calibrationDenominatorsValid &&
    CALIBRATION_COMBINATIONS.some((combination) => {
      const gate = evidence.calibration.combinations[combination];
      return (
        gate !== undefined &&
        (gate.sensitivity < THRESHOLDS.rejectCalibrationBelow ||
          gate.specificity < THRESHOLDS.rejectCalibrationBelow)
      );
    });
  const repeatableCorrectness = families.some(
    ([family]) =>
      (evidence.audit.correctnessDefectsByFamily[family] ?? 0) >= 2,
  );
  if (rejectModality) {
    strongFailures.push("modality approval below 50%");
  }
  if (calibrationBelowReject) {
    strongFailures.push("calibration sensitivity or specificity below 50%");
  }
  if (repeatableCorrectness) {
    strongFailures.push(
      "repeatable audited correctness defect in at least two approved candidates of one family",
    );
  }
  const allProceed = predicates.every((item) => item.status === "pass");
  const decision: FinalDecision = !evaluable
    ? "revise"
    : strongFailures.length > 0
      ? "reject"
      : allProceed
        ? "proceed"
        : "revise";
  if (decision === "revise" && evaluable && strongFailures.length === 0) {
    caveats.push("One or more proceed predicates failed or are borderline; revise rather than reject.");
  }
  if (decision === "reject") {
    caveats.push("A complete evaluable run has at least one strong failure; this is a business rejection, not an incomplete-evidence rejection.");
  }
  return {
    version: 1,
    decision,
    complete: evaluable,
    failed: predicates.filter((item) => item.status !== "pass"),
    strongFailures,
    caveats,
    predicates,
    thresholds: THRESHOLDS,
    nearDuplicate: {
      ...evidence.nearDuplicate,
      byFamily: nearByFamily,
      byFamilyLane: nearByFamilyLane,
    },
    denominators: {
      textApproval: text,
      svgApproval: svg,
      familyApproval: evidence.approvals.byFamily,
      familyLaneApproval: evidence.approvals.byFamilyLane,
      audit: {
        coreSampled: evidence.audit.coreSampled,
        coreInspectable: evidence.audit.coreInspectable,
        totalInspectable: evidence.audit.totalInspectable,
        approvedSampled: evidence.audit.approvedSampled,
        approvedInspectable: evidence.audit.approvedInspectable,
      },
    },
  };
}
