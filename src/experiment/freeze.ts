import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import {
  PROTOCOL_VERSION,
  REQUEST_ROLES,
  ROOT_SEEDS,
  THRESHOLDS,
  PlanManifestSchema,
  type PlanManifest,
} from "../domain/experiment.js";
import { buildPlanManifest } from "./planner.js";
import { hashCanonicalJson } from "../util/hash.js";

export const FREEZE_VERSION = 1 as const;
export const CALIBRATION_COMBINATIONS = [
  "text_blind",
  "text_alignment",
  "svg_blind",
  "svg_alignment",
] as const;
export type CalibrationCombination = (typeof CALIBRATION_COMBINATIONS)[number];

export interface CalibrationGateEvidence {
  readonly sensitivity: number;
  readonly specificity: number;
  readonly defectiveDenominator: number;
  readonly soundDenominator: number;
  readonly pass: boolean;
}

export interface ProvenanceEvidence {
  readonly sourceHash: string;
  readonly promptHashes: Readonly<Record<string, string>>;
  readonly schemaHashes: Readonly<Record<string, string>>;
  readonly configHash: string;
}

export type ProvenanceProvider = () => ProvenanceEvidence;

export interface FreezeProtocolEvidence {
  readonly protocolVersion: string;
  readonly rootSeed: string;
  readonly plan: PlanManifest;
  readonly planHash: string;
  readonly configuration: {
    readonly configHash: string;
    readonly promptHashes: Readonly<Record<string, string>>;
    readonly schemaHashes: Readonly<Record<string, string>>;
    readonly routesHash: string;
    readonly sourceHash: string;
    readonly updatedAt: string;
  };
  readonly preflight: {
    readonly evidenceKind: "live";
    readonly checkedAt: string;
    readonly configHash: string;
    readonly routesSupported: boolean;
    readonly pricesObservedAt: string;
    readonly priceCatalogHash: string;
    readonly rolePrices: Readonly<Record<string, string>>;
    readonly forecast: {
      readonly maxUsd: string;
      readonly forecast680Usd: string;
      readonly projectedAt160ApprovalsUsd: string;
      readonly conservativeReserveUsd: string;
    };
  };
  readonly fixturePack: {
    readonly packHash: string;
    readonly labelsHash: string;
    readonly humanVerified: boolean;
    readonly verifiedFixtures: number;
    readonly totalFixtures: number;
    readonly verifiedAt: string;
  };
  readonly calibration: {
    readonly runId: string;
    readonly evidenceKind: "live";
    readonly completedAt: string;
    readonly configHash: string;
    readonly packHash: string;
    readonly labelsHash: string;
    readonly reviewCalls: number;
    readonly generationCalls: number;
    readonly combinations: Readonly<
      Record<CalibrationCombination, CalibrationGateEvidence>
    >;
  };
  readonly smoke: {
    readonly runId: string;
    readonly evidenceKind: "live";
    readonly controlState: "completed";
    readonly acceptedAt: string;
    readonly accepted: boolean;
    readonly configHash: string;
    readonly planHash: string;
    readonly plannedSlots: number;
    readonly terminalSlots: number;
    readonly families: number;
    readonly roles: readonly string[];
  };
  readonly authorizedCapUsd: string;
  readonly costPerApprovedThresholdUsd: string;
  readonly provenance: ProvenanceEvidence;
  readonly capAmendments?: readonly {
    readonly at: string;
    readonly fromUsd: string;
    readonly toUsd: string;
    readonly operator: string;
  }[];
}

export interface FreezeFailure {
  readonly id: string;
  readonly detail: string;
}

export interface FrozenProtocol {
  readonly version: typeof FREEZE_VERSION;
  readonly protocolVersion: string;
  readonly rootSeed: string;
  readonly planHash: string;
  readonly configHash: string;
  readonly promptHashes: Readonly<Record<string, string>>;
  readonly schemaHashes: Readonly<Record<string, string>>;
  readonly routesHash: string;
  readonly sourceHash: string;
  readonly fixturePackHash: string;
  readonly labelsHash: string;
  readonly calibrationId: string;
  readonly calibrationCompletedAt: string;
  readonly costPerApprovedThresholdUsd: typeof THRESHOLDS.costPerApprovedMaxUsd;
  readonly authorizedCapUsd: string;
  readonly forecast: FreezeProtocolEvidence["preflight"]["forecast"];
  readonly frozenAt: string;
  readonly freezeHash: string;
}

export interface FreezeDecision {
  readonly ok: boolean;
  readonly failed: readonly FreezeFailure[];
  readonly caveats: readonly string[];
  readonly frozen: FrozenProtocol | null;
}

function sameHashes(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function validMoney(value: string): boolean {
  try {
    return new Decimal(value).isFinite() && new Decimal(value).gt(0);
  } catch {
    return false;
  }
}

function hash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isStale(after: string, before: string): boolean {
  const afterTime = Date.parse(after);
  const beforeTime = Date.parse(before);
  return !Number.isFinite(afterTime) || !Number.isFinite(beforeTime) || afterTime < beforeTime;
}

export function canFreezeProtocol(
  evidence: FreezeProtocolEvidence,
  provenance: ProvenanceProvider = () => evidence.provenance,
  clock: { now(): Date } = { now: () => new Date() },
): FreezeDecision {
  const failed: FreezeFailure[] = [];
  const caveats: string[] = [];
  const fail = (id: string, detail: string) => failed.push({ id, detail });
  let plan: PlanManifest | null = null;
  try {
    plan = PlanManifestSchema.parse(evidence.plan);
  } catch (error) {
    fail("PLAN_INVALID", error instanceof Error ? error.message : "invalid plan");
  }
  if (evidence.protocolVersion !== PROTOCOL_VERSION) {
    fail("PROTOCOL_VERSION", `expected ${PROTOCOL_VERSION}`);
  }
  if (evidence.rootSeed !== ROOT_SEEDS.full) {
    fail("ROOT_SEED", `expected ${ROOT_SEEDS.full}`);
  }
  if (evidence.costPerApprovedThresholdUsd !== THRESHOLDS.costPerApprovedMaxUsd) {
    fail(
      "COST_THRESHOLD",
      `expected ${THRESHOLDS.costPerApprovedMaxUsd} USD per approved`,
    );
  }
  if (plan !== null) {
    if (plan.runKind !== "full" || plan.slots.length !== 200) {
      fail("PLAN_QUOTA", "freeze requires the 200-slot full plan");
    }
    if (plan.planHash !== evidence.planHash) {
      fail("PLAN_HASH", "plan hash does not match the plan manifest");
    }
    if (plan.planHash !== buildPlanManifest({ runKind: "full" }).planHash) {
      fail("PLAN_HASH", "plan does not match the immutable full plan");
    }
    if (plan.quotas.totalSlots !== 200 || plan.quotas.textSlots !== 100 || plan.quotas.svgSlots !== 100) {
      fail("PLAN_QUOTA", "full plan quotas must be 200/100/100");
    }
  }
  const config = evidence.configuration;
  if (!hash(config.configHash) || !hash(config.routesHash) || !hash(config.sourceHash)) {
    fail("CONFIG_HASH", "configuration hashes must be 64-hex");
  }
  if (
    Object.keys(config.promptHashes).length === 0 ||
    Object.keys(config.schemaHashes).length === 0
  ) {
    fail("CONFIG_HASH", "prompt and schema hash sets must not be empty");
  }
  if (!hash(evidence.preflight.configHash) || evidence.preflight.configHash !== config.configHash) {
    fail("PREFLIGHT_CONFIG_DRIFT", "preflight config hash differs from the frozen configuration");
  }
  if (evidence.preflight.evidenceKind !== "live") {
    fail("PREFLIGHT_NOT_LIVE", "freeze requires live preflight evidence");
  }
  if (!evidence.preflight.routesSupported) {
    fail("ROUTES_UNSUPPORTED", "all required live routes must be supported");
  }
  if (isStale(evidence.preflight.checkedAt, config.updatedAt)) {
    fail("PREFLIGHT_STALE", "preflight predates the configuration");
  }
  if (isStale(evidence.preflight.pricesObservedAt, config.updatedAt)) {
    fail("PRICES_STALE", "price observation predates the configuration");
  }
  if (!hash(evidence.preflight.priceCatalogHash)) {
    fail("PRICE_CATALOG_HASH", "price catalog hash must be 64-hex");
  }
  const rolePrices = evidence.preflight.rolePrices;
  if (
    REQUEST_ROLES.some((role) => !validMoney(rolePrices[role] ?? "")) ||
    Object.values(rolePrices).some((price) => !validMoney(price))
  ) {
    fail("PRICE_MISSING", "every required role must have a positive known price");
  }
  const forecast = evidence.preflight.forecast;
  if (
    !validMoney(forecast.maxUsd) ||
    !validMoney(forecast.forecast680Usd) ||
    !validMoney(forecast.projectedAt160ApprovalsUsd) ||
    !validMoney(forecast.conservativeReserveUsd)
  ) {
    fail("FORECAST_INVALID", "forecast values must be positive known USD amounts");
  } else if (
    new Decimal(forecast.maxUsd).lt(forecast.forecast680Usd) ||
    new Decimal(forecast.conservativeReserveUsd).lt(forecast.maxUsd)
  ) {
    fail(
      "FORECAST_INVALID",
      "forecast must cover the 680-call ceiling and the conservative reserve must cover the maximum forecast",
    );
  }
  if (!validMoney(evidence.authorizedCapUsd)) {
    fail("CAP_INVALID", "authorized cap must be a positive known USD amount");
  } else if (
    validMoney(forecast.maxUsd) &&
    validMoney(forecast.forecast680Usd) &&
    validMoney(forecast.projectedAt160ApprovalsUsd) &&
    validMoney(forecast.conservativeReserveUsd)
  ) {
    const cap = new Decimal(evidence.authorizedCapUsd);
    const required = Decimal.max(
      new Decimal(forecast.maxUsd),
      new Decimal(forecast.forecast680Usd),
      new Decimal(forecast.projectedAt160ApprovalsUsd),
      new Decimal(forecast.conservativeReserveUsd),
    );
    if (cap.lt(required)) {
      fail("CAP_TOO_SMALL", `authorized cap ${cap.toString()} is below forecast ${required.toString()}`);
    }
  }
  if (evidence.capAmendments !== undefined && evidence.capAmendments.length > 0) {
    caveats.push("cap amendments are operational events; they do not change the frozen threshold");
  }
  const pack = evidence.fixturePack;
  if (!hash(pack.packHash) || !hash(pack.labelsHash)) {
    fail("FIXTURE_PACK_HASH", "fixture pack and label hashes must be 64-hex");
  }
  if (!pack.humanVerified || pack.verifiedFixtures !== 40 || pack.totalFixtures !== 40) {
    fail("FIXTURE_PACK_UNVERIFIED", "freeze requires all 40 fixtures human-verified");
  }
  if (isStale(pack.verifiedAt, config.updatedAt)) {
    fail("FIXTURE_PACK_STALE", "fixture verification predates the configuration");
  }
  const calibration = evidence.calibration;
  if (calibration.evidenceKind !== "live") {
    fail("CALIBRATION_NOT_LIVE", "mock calibration cannot qualify a live freeze");
  }
  if (
    calibration.configHash !== config.configHash ||
    calibration.packHash !== pack.packHash ||
    calibration.labelsHash !== pack.labelsHash
  ) {
    fail("CALIBRATION_DRIFT", "calibration does not match the frozen config or fixture pack");
  }
  if (
    calibration.reviewCalls !== 80 ||
    calibration.generationCalls !== 0
  ) {
    fail("CALIBRATION_CALLS", "calibration must be exactly 80 review calls and zero generations");
  }
  if (isStale(calibration.completedAt, config.updatedAt) || isStale(calibration.completedAt, pack.verifiedAt)) {
    fail("CALIBRATION_STALE", "calibration predates the configuration or fixture verification");
  }
  for (const combination of CALIBRATION_COMBINATIONS) {
    const gate = calibration.combinations[combination];
    if (
      gate === undefined ||
      !gate.pass ||
      gate.sensitivity < THRESHOLDS.calibrationSensitivityMin ||
      gate.specificity < THRESHOLDS.calibrationSpecificityMin ||
      gate.defectiveDenominator !== 10 ||
      gate.soundDenominator !== 10
    ) {
      fail(
        "CALIBRATION_GATE",
        `${combination} must meet sensitivity >= ${THRESHOLDS.calibrationSensitivityMin} and specificity >= ${THRESHOLDS.calibrationSpecificityMin}`,
      );
    }
  }
  const smoke = evidence.smoke;
  if (smoke.evidenceKind !== "live" || smoke.controlState !== "completed" || !smoke.accepted) {
    fail("SMOKE_NOT_ACCEPTED", "freeze requires an accepted completed live smoke");
  }
  if (
    smoke.configHash !== config.configHash ||
    smoke.planHash !== buildPlanManifest({ runKind: "smoke" }).planHash
  ) {
    fail("SMOKE_DRIFT", "smoke does not match the frozen configuration or smoke plan");
  }
  if (
    smoke.plannedSlots !== 20 ||
    smoke.terminalSlots !== 20 ||
    smoke.families !== 10 ||
    !["blind_text", "blind_vision", "alignment_text", "alignment_vision"].every((role) =>
      smoke.roles.includes(role),
    )
  ) {
    fail("SMOKE_COVERAGE", "smoke must cover 20 terminal slots, 10 families, and all four review roles");
  }
  if (isStale(smoke.acceptedAt, config.updatedAt)) {
    fail("SMOKE_STALE", "smoke acceptance predates the configuration");
  }
  if (isStale(smoke.acceptedAt, calibration.completedAt)) {
    fail("SMOKE_STALE", "smoke acceptance predates the live calibration");
  }
  const provenanceEvidence = provenance();
  if (
    provenanceEvidence.configHash !== config.configHash ||
    !sameHashes(provenanceEvidence.promptHashes, config.promptHashes) ||
    !sameHashes(provenanceEvidence.schemaHashes, config.schemaHashes) ||
    provenanceEvidence.sourceHash !== config.sourceHash
  ) {
    fail("PROVENANCE_MISMATCH", "provenance source/prompt/schema hashes do not match the configuration");
  }
  if (failed.length > 0) {
    return { ok: false, failed, caveats, frozen: null };
  }
  const frozenWithoutHash = {
    version: FREEZE_VERSION,
    protocolVersion: evidence.protocolVersion,
    rootSeed: evidence.rootSeed,
    planHash: evidence.planHash,
    configHash: config.configHash,
    promptHashes: config.promptHashes,
    schemaHashes: config.schemaHashes,
    routesHash: config.routesHash,
    sourceHash: config.sourceHash,
    fixturePackHash: pack.packHash,
    labelsHash: pack.labelsHash,
    calibrationId: calibration.runId,
    calibrationCompletedAt: calibration.completedAt,
    costPerApprovedThresholdUsd: THRESHOLDS.costPerApprovedMaxUsd,
    authorizedCapUsd: evidence.authorizedCapUsd,
    forecast,
    frozenAt: clock.now().toISOString(),
  } as const;
  return {
    ok: true,
    failed: [],
    caveats,
    frozen: {
      ...frozenWithoutHash,
      freezeHash: hashCanonicalJson(frozenWithoutHash),
    },
  };
}

export function verifyFrozenProtocol(frozen: FrozenProtocol): boolean {
  const { freezeHash, ...withoutHash } = frozen;
  return hashCanonicalJson(withoutHash) === freezeHash;
}

export function storeFrozenProtocol(
  db: Database.Database,
  frozen: FrozenProtocol,
  createdAt: string = new Date().toISOString(),
): void {
  if (!verifyFrozenProtocol(frozen)) {
    throw new Error("cannot store a frozen protocol with an invalid freeze hash");
  }
  db.prepare(
    `INSERT INTO protocol_freezes (
      freeze_hash, protocol_version, root_seed, plan_hash, config_hash, routes_hash,
      source_hash, fixture_pack_hash, labels_hash, calibration_id,
      calibration_completed_at, cost_per_approved_threshold_usd, authorized_cap_usd,
      forecast_json, frozen_at, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    frozen.freezeHash,
    frozen.protocolVersion,
    frozen.rootSeed,
    frozen.planHash,
    frozen.configHash,
    frozen.routesHash,
    frozen.sourceHash,
    frozen.fixturePackHash,
    frozen.labelsHash,
    frozen.calibrationId,
    frozen.calibrationCompletedAt,
    frozen.costPerApprovedThresholdUsd,
    frozen.authorizedCapUsd,
    JSON.stringify(frozen.forecast),
    frozen.frozenAt,
    JSON.stringify(frozen),
    createdAt,
  );
}

export function getFrozenProtocol(
  db: Database.Database,
  freezeHash: string,
): FrozenProtocol | null {
  const row = db
    .prepare("SELECT payload_json FROM protocol_freezes WHERE freeze_hash = ?")
    .get(freezeHash) as { payload_json: string } | undefined;
  if (row === undefined) {
    return null;
  }
  const parsed = JSON.parse(row.payload_json) as FrozenProtocol;
  return verifyFrozenProtocol(parsed) ? parsed : null;
}
