import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import {
  canFreezeProtocol,
  getFrozenProtocol,
  storeFrozenProtocol,
  verifyFrozenProtocol,
  type FreezeProtocolEvidence,
  type FrozenProtocol,
} from "../../src/experiment/freeze.js";
import {
  decideFinal,
  type FinalDecisionEvidence,
} from "../../src/reporting/decision.js";
import { THRESHOLDS } from "../../src/domain/experiment.js";
import { migrate, openDatabase } from "../../src/storage/database.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const NOW = new Date("2026-11-06T12:00:00.000Z");
const CONFIG_UPDATED = "2026-11-06T08:00:00.000Z";
const PREFLIGHT = "2026-11-06T08:10:00.000Z";
const VERIFIED = "2026-11-06T08:20:00.000Z";
const CALIBRATED = "2026-11-06T08:30:00.000Z";
const SMOKE = "2026-11-06T08:40:00.000Z";

function freezeEvidence(): FreezeProtocolEvidence {
  const plan = buildPlanManifest({ runKind: "full" });
  const config = {
    configHash: HASH_A,
    promptHashes: { spec: HASH_B, wording: HASH_B },
    schemaHashes: { blind: HASH_C, alignment: HASH_C },
    routesHash: HASH_D,
    sourceHash: HASH_D,
    updatedAt: CONFIG_UPDATED,
  };
  return {
    protocolVersion: "1.0.0",
    rootSeed: "puzzle-poc-v1",
    plan,
    planHash: plan.planHash,
    configuration: config,
    preflight: {
      evidenceKind: "live",
      checkedAt: PREFLIGHT,
      configHash: HASH_A,
      routesSupported: true,
      pricesObservedAt: PREFLIGHT,
      priceCatalogHash: HASH_D,
      rolePrices: {
        spec: "0.01",
        wording: "0.01",
        blind_text: "0.01",
        blind_vision: "0.01",
        alignment_text: "0.01",
        alignment_vision: "0.01",
      },
      forecast: {
        maxUsd: "9.50",
        forecast680Usd: "9.00",
        projectedAt160ApprovalsUsd: "8.00",
        conservativeReserveUsd: "9.80",
      },
    },
    fixturePack: {
      packHash: HASH_B,
      labelsHash: HASH_C,
      humanVerified: true,
      verifiedFixtures: 40,
      totalFixtures: 40,
      verifiedAt: VERIFIED,
    },
    calibration: {
      runId: "calibration-live-1",
      evidenceKind: "live",
      completedAt: CALIBRATED,
      configHash: HASH_A,
      packHash: HASH_B,
      labelsHash: HASH_C,
      reviewCalls: 80,
      generationCalls: 0,
      combinations: {
        text_blind: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
        text_alignment: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
        svg_blind: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
        svg_alignment: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
      },
    },
    smoke: {
      runId: "smoke-live-1",
      evidenceKind: "live",
      controlState: "completed",
      acceptedAt: SMOKE,
      accepted: true,
      configHash: HASH_A,
      planHash: buildPlanManifest({ runKind: "smoke" }).planHash,
      plannedSlots: 20,
      terminalSlots: 20,
      families: 10,
      roles: [
        "blind_text",
        "blind_vision",
        "alignment_text",
        "alignment_vision",
      ],
    },
    authorizedCapUsd: "10.00",
    costPerApprovedThresholdUsd: THRESHOLDS.costPerApprovedMaxUsd,
    provenance: {
      sourceHash: HASH_D,
      promptHashes: config.promptHashes,
      schemaHashes: config.schemaHashes,
      configHash: HASH_A,
    },
  };
}

function frozen(): FrozenProtocol {
  const decision = canFreezeProtocol(freezeEvidence(), undefined, {
    now: () => NOW,
  });
  expect(decision.ok).toBe(true);
  if (decision.frozen === null) {
    throw new Error("freeze failed");
  }
  return decision.frozen;
}

function finalEvidence(overrides: Partial<FinalDecisionEvidence> = {}): FinalDecisionEvidence {
  const families = [
    "ranking",
    "matching",
    "scheduling",
    "truth",
    "arithmetic",
    "matrix",
    "transforms",
    "paths",
    "symmetry",
    "counting",
  ] as const;
  const byFamily = Object.fromEntries(
    families.map((family) => [family, { approved: 20, planned: 20 }]),
  ) as FinalDecisionEvidence["approvals"]["byFamily"];
  const byFamilyLane = Object.fromEntries(
    families.flatMap((family) => [
      [`${family}/spec_first`, { approved: 10, planned: 10 }],
      [`${family}/ai_spec`, { approved: 10, planned: 10 }],
    ]),
  );
  const approvedCoreByFamily = Object.fromEntries(
    families.map((family) => [family, 2]),
  ) as FinalDecisionEvidence["audit"]["approvedCoreByFamily"];
  const correctnessDefectsByFamily = Object.fromEntries(
    families.map((family) => [family, 0]),
  ) as FinalDecisionEvidence["audit"]["correctnessDefectsByFamily"];
  const nearByFamily = Object.fromEntries(
    families.map((family) => [
      family,
      { onlyNear: 0, additionalQuality: 0, incompleteOrFailedReview: 0 },
    ]),
  ) as FinalDecisionEvidence["nearDuplicate"]["byFamily"];
  const nearByFamilyLane = Object.fromEntries(
    families.flatMap((family) =>
      ["spec_first", "ai_spec"].map((lane) => [
        `${family}/${lane}`,
        { onlyNear: 0, additionalQuality: 0, incompleteOrFailedReview: 0 },
      ]),
    ),
  ) as FinalDecisionEvidence["nearDuplicate"]["byFamilyLane"];
  const base: FinalDecisionEvidence = {
    run: {
      runId: "primary-live-1",
      runKind: "full",
      evidenceKind: "live",
      controlState: "completed",
      planned: 200,
      terminal: 200,
      configHash: HASH_A,
      planHash: buildPlanManifest({ runKind: "full" }).planHash,
      rootSeed: "puzzle-poc-v1",
      protocolVersion: "1.0.0",
    },
    approvals: {
      byModality: {
        text: { approved: 100, planned: 100 },
        svg: { approved: 100, planned: 100 },
      },
      byFamily,
      byFamilyLane,
    },
    uniqueness: { structuralUniqueness: 1, fingerprintCoverage: 1 },
    cost: {
      actualCostUsd: "5.00",
      knownComplete: true,
      costPerApprovedUsd: "0.05",
      unknownAttempts: 0,
    },
    nearDuplicate: {
      approvedHighRisk: 0,
      onlyNear: 0,
      additionalQuality: 0,
      incompleteOrFailedReview: 0,
      byFamily: nearByFamily,
      byFamilyLane: nearByFamilyLane,
    },
    calibration: {
      evidenceKind: "live",
      completedAt: CALIBRATED,
      configHash: HASH_A,
      packHash: HASH_B,
      labelsHash: HASH_C,
      combinations: {
        text_blind: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
        text_alignment: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
        svg_blind: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
        svg_alignment: { sensitivity: 1, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: true },
      },
    },
    audit: {
      complete: true,
      sampleHash: HASH_D,
      labelsHash: HASH_C,
      coreSampled: 40,
      coreInspectable: 40,
      totalInspectable: 40,
      approvedSampled: 20,
      approvedInspectable: 20,
      approvedCoreByFamily,
      clarityAndTimePass: 20,
      clarityAndTimeDenominator: 20,
      unresolvedSoundnessDefects: 0,
      unresolvedDisagreements: 0,
      correctnessDefectsByFamily,
    },
    routesSupported: true,
    frozen: frozen(),
  };
  return { ...base, ...overrides };
}

describe("protocol freeze", { timeout: 30_000 }, () => {
  it("freezes a complete live pre-run evidence graph without primary or audit inputs", () => {
    const decision = canFreezeProtocol(freezeEvidence(), undefined, {
      now: () => NOW,
    });
    expect(decision.ok).toBe(true);
    expect(decision.failed).toEqual([]);
    expect(decision.frozen).not.toBeNull();
    expect(verifyFrozenProtocol(decision.frozen as FrozenProtocol)).toBe(true);
    expect(decision.frozen?.costPerApprovedThresholdUsd).toBe("0.10");
    expect(decision.frozen?.authorizedCapUsd).toBe("10.00");
  });

  it("rejects mock, unverified, stale, drifted, underfunded, or incomplete freeze evidence", () => {
    const cases: Array<[string, (evidence: FreezeProtocolEvidence) => void]> = [
      ["PREFLIGHT_NOT_LIVE", (evidence) => { (evidence.preflight as { evidenceKind: string }).evidenceKind = "mock"; }],
      ["FIXTURE_PACK_UNVERIFIED", (evidence) => { (evidence.fixturePack as { humanVerified: boolean }).humanVerified = false; }],
      ["CALIBRATION_NOT_LIVE", (evidence) => { (evidence.calibration as { evidenceKind: string }).evidenceKind = "mock"; }],
      ["CALIBRATION_STALE", (evidence) => { (evidence.calibration as { completedAt: string }).completedAt = "2026-11-06T07:00:00.000Z"; }],
      ["CALIBRATION_DRIFT", (evidence) => { (evidence.calibration as { packHash: string }).packHash = HASH_D; }],
      ["CALIBRATION_GATE", (evidence) => { (evidence.calibration.combinations.text_blind as { sensitivity: number }).sensitivity = 0.8; }],
      ["PREFLIGHT_CONFIG_DRIFT", (evidence) => { (evidence.preflight as { configHash: string }).configHash = HASH_D; }],
      ["COST_THRESHOLD", (evidence) => { (evidence as { costPerApprovedThresholdUsd: string }).costPerApprovedThresholdUsd = "0.11"; }],
      ["CAP_TOO_SMALL", (evidence) => { (evidence as { authorizedCapUsd: string }).authorizedCapUsd = "1.00"; }],
      ["FORECAST_INVALID", (evidence) => { (evidence.preflight.forecast as { maxUsd: string }).maxUsd = "0"; }],
      ["PROVENANCE_MISMATCH", (evidence) => { (evidence.provenance as { sourceHash: string }).sourceHash = HASH_A; }],
      ["SMOKE_NOT_ACCEPTED", (evidence) => { (evidence.smoke as { accepted: boolean }).accepted = false; }],
      ["SMOKE_COVERAGE", (evidence) => { (evidence.smoke as { terminalSlots: number }).terminalSlots = 19; }],
      ["SMOKE_DRIFT", (evidence) => { (evidence.smoke as { planHash: string }).planHash = buildPlanManifest({ runKind: "full" }).planHash; }],
      ["SMOKE_STALE", (evidence) => { (evidence.smoke as { acceptedAt: string }).acceptedAt = "2026-11-06T08:25:00.000Z"; }],
      ["PRICE_MISSING", (evidence) => { delete (evidence.preflight.rolePrices as Record<string, string>).alignment_vision; }],
      ["FORECAST_INVALID", (evidence) => { (evidence.preflight.forecast as { forecast680Usd: string }).forecast680Usd = "9.60"; }],
      ["FORECAST_INVALID", (evidence) => { (evidence.preflight.forecast as { maxUsd: string }).maxUsd = "not-a-number"; }],
    ];
    for (const [id, mutate] of cases) {
      const evidence = structuredClone(freezeEvidence());
      mutate(evidence);
      const decision = canFreezeProtocol(evidence, undefined, { now: () => NOW });
      expect(decision.ok, id).toBe(false);
      expect(decision.failed.map((failure) => failure.id), id).toContain(id);
    }
  });

  it("stores and reloads a frozen protocol from the append-only table", () => {
    const directory = mkdtempSync(join(tmpdir(), "puzzle-p43-"));
    const db = openDatabase(join(directory, "freeze.sqlite"));
    try {
      migrate(db);
      const protocol = frozen();
      storeFrozenProtocol(db, protocol, NOW.toISOString());
      expect(getFrozenProtocol(db, protocol.freezeHash)).toEqual(protocol);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM protocol_freezes").get(),
      ).toEqual({ count: 1 });
      expect(() =>
        db.prepare("UPDATE protocol_freezes SET authorized_cap_usd = '1'").run(),
      ).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM protocol_freezes").run()).toThrow(
        /append-only/,
      );
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records cap amendments as caveats without changing the frozen threshold", () => {
    const evidence = freezeEvidence();
    const withAmendments = {
      ...evidence,
      capAmendments: [
        {
          at: PREFLIGHT,
          fromUsd: "8.00",
          toUsd: "10.00",
          operator: "test-operator",
        },
      ],
    };
    const decision = canFreezeProtocol(withAmendments, undefined, {
      now: () => NOW,
    });
    expect(decision.ok).toBe(true);
    expect(decision.caveats.join(" ")).toContain("cap amendments");
    expect(decision.frozen?.costPerApprovedThresholdUsd).toBe("0.10");
  });
});

describe("final business decision", { timeout: 30_000 }, () => {
  it("proceeds only when every section 9.3 predicate passes", () => {
    const report = decideFinal(finalEvidence());
    expect(report.decision).toBe("proceed");
    expect(report.complete).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.predicates.every((item) => item.status === "pass")).toBe(true);
    expect(report.denominators.textApproval).toEqual({ approved: 100, planned: 100 });
    expect(report.denominators.audit.approvedInspectable).toBe(20);
  });

  it("revises at 79/100 and rejects at 49/100 for modality approvals", () => {
    const revise = finalEvidence({
      approvals: {
        ...finalEvidence().approvals,
        byModality: {
          text: { approved: 79, planned: 100 },
          svg: { approved: 100, planned: 100 },
        },
      },
    });
    expect(decideFinal(revise).decision).toBe("revise");
    expect(decideFinal(revise).failed.map((item) => item.id)).toContain(
      "text_approval_80_of_100",
    );
    const reject = finalEvidence({
      approvals: {
        ...finalEvidence().approvals,
        byModality: {
          text: { approved: 49, planned: 100 },
          svg: { approved: 100, planned: 100 },
        },
      },
    });
    expect(decideFinal(reject).decision).toBe("reject");
  });

  it("revises at 9/20 family approval and passes 10/20", () => {
    const evidence = finalEvidence();
    const withNine = {
      ...evidence,
      approvals: {
        ...evidence.approvals,
        byFamily: {
          ...evidence.approvals.byFamily,
          ranking: { approved: 9, planned: 20 },
        },
      },
    };
    expect(decideFinal(withNine).decision).toBe("revise");
    expect(decideFinal(withNine).failed.map((item) => item.id)).toContain(
      "family_approval_10_of_20",
    );
    expect(decideFinal(evidence).decision).toBe("proceed");
  });

  it("revises for inconsistent modality denominators instead of rejecting", () => {
    const evidence = finalEvidence();
    const report = decideFinal({
      ...evidence,
      approvals: {
        ...evidence.approvals,
        byModality: {
          text: { approved: 99, planned: 200 },
          svg: { approved: 100, planned: 100 },
        },
      },
    });
    expect(report.decision).toBe("revise");
    expect(report.failed.map((item) => item.id)).toContain(
      "modality_denominators_100",
    );
  });

  it("revises when a canonical family or family/lane cell is missing", () => {
    const evidence = finalEvidence();
    const byFamily = { ...evidence.approvals.byFamily };
    delete (byFamily as Partial<typeof byFamily>).paths;
    const report = decideFinal({
      ...evidence,
      approvals: { ...evidence.approvals, byFamily },
    });
    expect(report.decision).toBe("revise");
    expect(report.failed.map((item) => item.id)).toContain(
      "family_approval_10_of_20",
    );
  });

  it("revises when audit counters are inconsistent or the approval denominator is tiny", () => {
    const evidence = finalEvidence();
    const report = decideFinal({
      ...evidence,
      audit: {
        ...evidence.audit,
        clarityAndTimeDenominator: 1,
        clarityAndTimePass: 1,
      },
    });
    expect(report.decision).toBe("revise");
    expect(report.failed.map((item) => item.id)).toContain(
      "audit_denominators_consistent",
    );
    const tiny = decideFinal({
      ...evidence,
      audit: {
        ...evidence.audit,
        approvedInspectable: 1,
        approvedCoreByFamily: Object.fromEntries(
          Object.keys(evidence.audit.approvedCoreByFamily).map((family) => [family, 0]),
        ) as FinalDecisionEvidence["audit"]["approvedCoreByFamily"],
        clarityAndTimeDenominator: 1,
        clarityAndTimePass: 1,
      },
    });
    expect(tiny.decision).toBe("revise");
    expect(tiny.failed.map((item) => item.id)).toContain(
      "audit_approved_inspectable_20",
    );
    const impossiblePass = decideFinal({
      ...evidence,
      audit: {
        ...evidence.audit,
        clarityAndTimePass: 25,
        clarityAndTimeDenominator: 20,
      },
    });
    expect(impossiblePass.decision).toBe("revise");
    expect(impossiblePass.failed.map((item) => item.id)).toContain(
      "audit_denominators_consistent",
    );
  });

  it("revises at specificity 7/10 and passes at sensitivity 9/10 and specificity 8/10", () => {
    const evidence = finalEvidence();
    const lowSpecificity = decideFinal({
      ...evidence,
      calibration: {
        ...evidence.calibration,
        combinations: {
          ...evidence.calibration.combinations,
          text_blind: {
            sensitivity: 0.9,
            specificity: 0.7,
            defectiveDenominator: 10,
            soundDenominator: 10,
            pass: false,
          },
        },
      },
    });
    expect(lowSpecificity.decision).toBe("revise");
    expect(lowSpecificity.failed.map((item) => item.id)).toContain(
      "calibration_gates",
    );
    const boundary = decideFinal({
      ...evidence,
      calibration: {
        ...evidence.calibration,
        combinations: {
          ...evidence.calibration.combinations,
          text_blind: {
            sensitivity: 0.9,
            specificity: 0.8,
            defectiveDenominator: 10,
            soundDenominator: 10,
            pass: true,
          },
        },
      },
    });
    expect(boundary.decision).toBe("proceed");
  });

  it("revises at 8/10 calibration detection and rejects below 50%", () => {
    const evidence = finalEvidence();
    const low = {
      ...evidence,
      calibration: {
        ...evidence.calibration,
        combinations: {
          ...evidence.calibration.combinations,
          text_blind: { sensitivity: 0.8, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: false },
        },
      },
    };
    expect(decideFinal(low).decision).toBe("revise");
    expect(decideFinal(low).failed.map((item) => item.id)).toContain(
      "calibration_gates",
    );
    const reject = {
      ...evidence,
      calibration: {
        ...evidence.calibration,
        combinations: {
          ...evidence.calibration.combinations,
          text_blind: { sensitivity: 0.4, specificity: 1, defectiveDenominator: 10, soundDenominator: 10, pass: false },
        },
      },
    };
    expect(decideFinal(reject).decision).toBe("reject");
    const invalidDenominator = {
      ...evidence,
      calibration: {
        ...evidence.calibration,
        combinations: {
          ...evidence.calibration.combinations,
          text_blind: {
            sensitivity: 0.4,
            specificity: 1,
            defectiveDenominator: 9,
            soundDenominator: 10,
            pass: false,
          },
        },
      },
    };
    const invalidReport = decideFinal(invalidDenominator);
    expect(invalidReport.decision).toBe("revise");
    expect(invalidReport.failed.map((item) => item.id)).toContain(
      "calibration_denominators_10",
    );
  });

  it("revises for missing audit, low inspectability, unresolved defects, or poor clarity/time", () => {
    const cases: Array<[string, Partial<FinalDecisionEvidence["audit"]>]> = [
      ["audit_completed", { complete: false }],
      ["audit_core_inspectable_32", { coreInspectable: 31 }],
      ["audit_approved_core_two_per_family", { approvedCoreByFamily: { ...finalEvidence().audit.approvedCoreByFamily, ranking: 1 } }],
      ["audit_no_unresolved_soundness_semantic_legibility", { unresolvedSoundnessDefects: 1 }],
      ["audit_clear_and_solved_within_180s_80pct", { clarityAndTimePass: 15 }],
      ["audit_no_unresolved_disagreement", { unresolvedDisagreements: 1 }],
    ];
    for (const [id, patch] of cases) {
      const evidence = finalEvidence();
      const report = decideFinal({
        ...evidence,
        audit: { ...evidence.audit, ...patch },
      });
      expect(report.decision, id).toBe("revise");
      expect(report.failed.map((item) => item.id), id).toContain(id);
    }
  });

  it("revises for cost, uniqueness, coverage, near-duplicate, route, or frozen drift", () => {
    const evidence = finalEvidence();
    const cases: Array<[string, FinalDecisionEvidence]> = [
      ["known_complete_costs", { ...evidence, cost: { ...evidence.cost, actualCostUsd: null } }],
      ["cost_per_approved_010", { ...evidence, cost: { ...evidence.cost, costPerApprovedUsd: "0.11" } }],
      ["structural_uniqueness_95", { ...evidence, uniqueness: { ...evidence.uniqueness, structuralUniqueness: 0.94 } }],
      ["fingerprint_coverage_80", { ...evidence, uniqueness: { ...evidence.uniqueness, fingerprintCoverage: 0.79 } }],
      ["no_approved_high_risk_near_duplicate", { ...evidence, nearDuplicate: { ...evidence.nearDuplicate, approvedHighRisk: 1 } }],
      ["routes_supported", { ...evidence, routesSupported: false }],
      ["frozen_protocol_matches", { ...evidence, frozen: { ...(evidence.frozen as FrozenProtocol), configHash: HASH_D } }],
    ];
    for (const [id, candidate] of cases) {
      const report = decideFinal(candidate);
      expect(report.decision, id).toBe("revise");
      expect(report.failed.map((item) => item.id), id).toContain(id);
    }
  });

  it("revises when the frozen protocol is missing", () => {
    const evidence = finalEvidence();
    const withoutFrozen = { ...evidence };
    delete withoutFrozen.frozen;
    const report = decideFinal(withoutFrozen);
    expect(report.decision).toBe("revise");
    expect(report.failed.map((item) => item.id)).toContain(
      "frozen_protocol_matches",
    );
  });

  it("never rejects an incomplete run and always emits readable failures", () => {
    const evidence = finalEvidence({
      run: { ...finalEvidence().run, controlState: "running", terminal: 150 },
      approvals: {
        ...finalEvidence().approvals,
        byModality: {
          text: { approved: 0, planned: 100 },
          svg: { approved: 0, planned: 100 },
        },
      },
      audit: { ...finalEvidence().audit, complete: false },
    });
    const report = decideFinal(evidence);
    expect(report.decision).toBe("revise");
    expect(report.complete).toBe(false);
    expect(report.failed.length).toBeGreaterThan(0);
    expect(report.failed.every((item) => item.detail.length > 0)).toBe(true);
    expect(report.caveats.length).toBeGreaterThan(0);
  });

  it("rejects a repeatable audited correctness defect in one family", () => {
    const evidence = finalEvidence();
    const report = decideFinal({
      ...evidence,
      audit: {
        ...evidence.audit,
        correctnessDefectsByFamily: {
          ...evidence.audit.correctnessDefectsByFamily,
          ranking: 2,
        },
      },
    });
    expect(report.decision).toBe("reject");
    expect(report.strongFailures.join(" ")).toContain("repeatable");
  });

  it("discloses novelty-only and quality shortfalls without waiving the gate", () => {
    const evidence = finalEvidence({
      approvals: {
        ...finalEvidence().approvals,
        byModality: {
          text: { approved: 79, planned: 100 },
          svg: { approved: 100, planned: 100 },
        },
      },
      nearDuplicate: {
        ...finalEvidence().nearDuplicate,
        onlyNear: 1,
        additionalQuality: 2,
        incompleteOrFailedReview: 3,
      },
    });
    const report = decideFinal(evidence);
    expect(report.decision).toBe("revise");
    expect(report.caveats.join(" ")).toContain("novelty-only");
    expect(report.caveats.join(" ")).toContain("quality findings");
    expect(report.caveats.join(" ")).toContain("incomplete or failed");
    expect(report.nearDuplicate.byFamilyLane).toEqual(
      evidence.nearDuplicate.byFamilyLane,
    );
    const missingMap = { ...evidence.nearDuplicate };
    delete (missingMap as Partial<typeof missingMap>).byFamilyLane;
    const incompleteDisclosure = decideFinal({
      ...evidence,
      nearDuplicate: missingMap,
    });
    expect(incompleteDisclosure.decision).toBe("revise");
    expect(incompleteDisclosure.failed.map((item) => item.id)).toContain(
      "near_duplicate_disclosure_complete",
    );
    expect(report.failed.map((item) => item.id)).toContain(
      "text_approval_80_of_100",
    );
  });
});
