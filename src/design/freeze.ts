import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  DESIGNER_PROTOCOL_VERSION,
  DesignerPlanManifestSchema,
  type DesignerPlanManifest,
  type DesignerRunRecord,
} from "../domain/design.js";
import { FAMILIES, UsdSchema } from "../domain/experiment.js";
import { addUsd, compareUsd } from "../ai/budget.js";
import type { DesignerCohortMetrics } from "../reporting/design-metrics.js";
import {
  DESIGNER_DECISION_THRESHOLDS,
  DesignerDecisionThresholdsSchema,
} from "../reporting/design-decision.js";
import {
  computeRoutingConfirmationHash,
  RoutingConfirmationSchema,
  type RoutingConfirmation,
} from "./routing.js";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { withTransaction } from "../storage/database.js";
import { readFileSync as readFile } from "node:fs";
import type { OutputCapField } from "../ai/config.js";

export const DESIGNER_PROTOCOL_FREEZE_VERSION = "p50.2-freeze-v1" as const;

export const DesignerConfigurationSnapshotSchema = z.strictObject({
  model: z.string().min(1).max(200),
  routingPolicy: z.literal("balanced"),
  providerSort: z.enum(["default", "balanced"]).nullable(),
  byokProviderKeysConfigured: z.literal(false),
  outputCapField: z.enum(["max_tokens", "max_completion_tokens"]),
  maxOutputTokens: z.number().int().positive(),
  concurrency: z.union([z.literal(1), z.literal(2)]),
  settingsMode: z.enum(["explicit", "default"]),
  settings: z
    .strictObject({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      seed: z.number().int().optional(),
      reasoning: z.unknown().optional(),
    })
    .nullable(),
  promptsHash: z.string().regex(/^[0-9a-f]{64}$/),
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  fontHash: z.string().regex(/^[0-9a-f]{64}$/),
  referenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  cohortHash: z.string().regex(/^[0-9a-f]{64}$/),
  dependencyLockHash: z.string().regex(/^[0-9a-f]{64}$/),
  templateHash: z.string().regex(/^[0-9a-f]{64}$/),
  comparatorHash: z.string().regex(/^[0-9a-f]{64}$/),
  metricsHash: z.string().regex(/^[0-9a-f]{64}$/),
  decisionEvaluatorHash: z.string().regex(/^[0-9a-f]{64}$/),
  humanRubricHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignerConfigurationSnapshot = z.infer<
  typeof DesignerConfigurationSnapshotSchema
>;

export function computeDesignerConfigurationHash(
  configuration: DesignerConfigurationSnapshot,
): string {
  return sha256Hex(canonicalJson(DesignerConfigurationSnapshotSchema.parse(configuration)));
}

export const DESIGNER_CONFIGURATION_HASH_FIELDS = [
  "model",
  "routingPolicy",
  "providerSort",
  "byokProviderKeysConfigured",
  "outputCapField",
  "maxOutputTokens",
  "concurrency",
  "settingsMode",
  "settings",
  "promptsHash",
  "schemaHash",
  "sourceHash",
  "fontHash",
  "referenceHash",
  "cohortHash",
  "dependencyLockHash",
  "templateHash",
  "comparatorHash",
  "metricsHash",
  "decisionEvaluatorHash",
  "humanRubricHash",
] as const;

export const DesignerBudgetForecastSchema = z.strictObject({
  totalLogicalCalls: z.number().int().nonnegative(),
  maxTransportAttempts: z.number().int().nonnegative(),
  conservativeReserveUsd: UsdSchema,
  perRoleReserveUsd: z.strictObject({
    design: UsdSchema,
    design_repair_1: UsdSchema,
    design_repair_2: UsdSchema,
  }),
  observedPilotCostUsd: UsdSchema.nullable(),
  method: z.string().min(1).max(2_000),
});
export type DesignerBudgetForecast = z.infer<
  typeof DesignerBudgetForecastSchema
>;

export const DesignerPilotEvidenceSchema = z.strictObject({
  evidenceKind: z.literal("live"),
  runKind: z.literal("design_pilot"),
  completed: z.boolean(),
  assignments: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  perFamilyAccepted: z.record(z.enum(FAMILIES), z.number().int().nonnegative()),
  knownCostsComplete: z.boolean(),
  ledgerComplete: z.boolean(),
  unresolvedInfrastructureDefect: z.boolean(),
  observedProviderMix: z.record(z.string(), z.number().int().nonnegative()),
});
export type DesignerPilotEvidence = z.infer<
  typeof DesignerPilotEvidenceSchema
>;

export function computePilotPerFamilyAiAccepted(
  metrics: DesignerCohortMetrics,
): Record<(typeof FAMILIES)[number], number> {
  return Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      metrics.strata.byFamilyArm
        .filter(
          (row) =>
            row.key === `${family}:ai_feedback` ||
            row.key === `${family}:ai_one_shot`,
        )
        .reduce((sum, row) => sum + row.finalAccepted, 0),
    ]),
  ) as Record<(typeof FAMILIES)[number], number>;
}

export const DesignerHumanEvaluationPlanSchema = z.strictObject({
  samplerVersion: z.string().min(1),
  rubricVersion: z.string().min(1),
  maxCoreCandidates: z.number().int().positive(),
  maxAdditions: z.number().int().positive(),
  maxCandidates: z.number().int().positive(),
});
export type DesignerHumanEvaluationPlan = z.infer<
  typeof DesignerHumanEvaluationPlanSchema
>;

export const DESIGNER_HUMAN_EVALUATION_PLAN = Object.freeze({
  samplerVersion: "p50.3-design-sample-v1",
  rubricVersion: "p50.3-rubric-v1",
  maxCoreCandidates: 30,
  maxAdditions: 10,
  maxCandidates: 40,
} as const);

export const DesignerProtocolFreezeSchema = z
  .strictObject({
    version: z.literal(DESIGNER_PROTOCOL_FREEZE_VERSION),
    kind: z.literal("designer_protocol_freeze"),
    protocolHash: z.string().regex(/^[0-9a-f]{64}$/),
    freezeHash: z.string().regex(/^[0-9a-f]{64}$/),
    frozenAt: z.iso.datetime(),
    pilotRunId: z.string().uuid(),
    pilotManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    pilotConfigurationHash: z.string().regex(/^[0-9a-f]{64}$/),
    configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
    configuration: DesignerConfigurationSnapshotSchema,
    plan: DesignerPlanManifestSchema,
    thresholds: DesignerDecisionThresholdsSchema,
    budgetForecast: DesignerBudgetForecastSchema,
    pilotEvidence: DesignerPilotEvidenceSchema,
    humanEvaluationPlan: DesignerHumanEvaluationPlanSchema,
    routingConfirmation: RoutingConfirmationSchema,
    routingConfirmationHash: z.string().regex(/^[0-9a-f]{64}$/),
    authorization: z.strictObject({
      operator: z.string().min(1).max(200),
      authorizedAt: z.iso.datetime(),
      maxRunCostUsd: UsdSchema,
      acknowledged: z.literal(true),
    }),
    protocolVersion: z.literal(DESIGNER_PROTOCOL_VERSION),
  })
  .superRefine((freeze, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (freeze.configurationHash !== computeDesignerConfigurationHash(freeze.configuration)) {
      issue(["configurationHash"], "configuration hash does not match snapshot");
    }
    if (
      freeze.routingConfirmationHash !==
      computeRoutingConfirmationHash(freeze.routingConfirmation)
    ) {
      issue(["routingConfirmationHash"], "routing confirmation hash mismatch");
    }
    if (canonicalJson(freeze.thresholds) !== canonicalJson(DESIGNER_DECISION_THRESHOLDS)) {
      issue(["thresholds"], "thresholds must equal the frozen decision constants");
    }
    if (
      canonicalJson(freeze.humanEvaluationPlan) !==
      canonicalJson(DESIGNER_HUMAN_EVALUATION_PLAN)
    ) {
      issue(["humanEvaluationPlan"], "human evaluation plan must equal the fixed plan");
    }
  });
export type DesignerProtocolFreeze = z.infer<
  typeof DesignerProtocolFreezeSchema
>;

function freezeBody(freeze: DesignerProtocolFreeze): Omit<
  DesignerProtocolFreeze,
  "protocolHash" | "freezeHash"
> {
  const body: Partial<DesignerProtocolFreeze> = { ...freeze };
  delete body.protocolHash;
  delete body.freezeHash;
  return body as Omit<DesignerProtocolFreeze, "protocolHash" | "freezeHash">;
}

export function computeDesignerProtocolHash(
  freeze: DesignerProtocolFreeze,
): string {
  return sha256Hex(canonicalJson(freezeBody(freeze)));
}

export function computeDesignerFreezeHash(
  freeze: DesignerProtocolFreeze,
): string {
  return sha256Hex(
    canonicalJson({
      ...freezeBody(freeze),
      protocolHash: freeze.protocolHash,
    }),
  );
}

export interface DesignerFreezeFailure {
  readonly code: string;
  readonly message: string;
}

export interface DesignerFreezeInput {
  readonly pilotRun: DesignerRunRecord;
  readonly pilotMetrics: DesignerCohortMetrics;
  readonly primaryPlan: DesignerPlanManifest;
  readonly currentConfiguration: DesignerConfigurationSnapshot;
  readonly pilotConfiguration: DesignerConfigurationSnapshot;
  readonly routingConfirmation: RoutingConfirmation;
  readonly budgetForecast: DesignerBudgetForecast;
  readonly authorization: DesignerProtocolFreeze["authorization"];
  readonly pilotEvidence: DesignerPilotEvidence;
  readonly frozenAt: string;
  readonly thresholds?: typeof DESIGNER_DECISION_THRESHOLDS;
  readonly humanEvaluationPlan?: DesignerHumanEvaluationPlan;
}

export interface DesignerFreezeResult {
  readonly ok: boolean;
  readonly failures: readonly DesignerFreezeFailure[];
  readonly freeze: DesignerProtocolFreeze | null;
}

function configurationDifferences(
  left: DesignerConfigurationSnapshot,
  right: DesignerConfigurationSnapshot,
): string[] {
  return DESIGNER_CONFIGURATION_HASH_FIELDS.filter(
    (field) => canonicalJson(left[field]) !== canonicalJson(right[field]),
  );
}

export function canFreezeDesignerProtocol(
  input: DesignerFreezeInput,
): DesignerFreezeResult {
  const failures: DesignerFreezeFailure[] = [];
  const fail = (code: string, message: string): void => {
    failures.push({ code, message });
  };

  if (input.pilotRun.runKind !== "design_pilot") {
    fail("pilot_run_kind", "freeze requires a design_pilot run");
  }
  if (input.pilotRun.evidenceKind !== "live") {
    fail("mock_pilot_evidence", "mock pilot evidence cannot be frozen for live execution");
  }
  if (!input.pilotRun.manifest.planHash || input.pilotRun.manifest.planHash !== input.pilotMetrics.planHash) {
    fail("pilot_manifest_mismatch", "pilot manifest hash does not match the metrics run");
  }
  if (!input.pilotMetrics.complete) {
    fail("pilot_incomplete", "pilot metrics are incomplete");
  }
  if (
    input.pilotMetrics.planned.assignments !== 20 ||
    input.pilotMetrics.planned.candidates !== 60
  ) {
    fail("pilot_scope", "pilot must contain 20 assignments and 60 candidates");
  }
  if (!input.pilotEvidence.completed) {
    fail("pilot_not_completed", "pilot run did not complete");
  }
  if (!input.pilotEvidence.knownCostsComplete) {
    fail("pilot_unknown_costs", "pilot has unknown or incomplete costs");
  }
  if (!input.pilotEvidence.ledgerComplete) {
    fail("pilot_ledger_incomplete", "pilot ledger or checkpoint coverage is incomplete");
  }
  if (input.pilotEvidence.unresolvedInfrastructureDefect) {
    fail("pilot_unresolved_defect", "pilot has an unresolved infrastructure defect");
  }
  for (const family of FAMILIES) {
    if ((input.pilotEvidence.perFamilyAccepted[family] ?? 0) < 1) {
      fail(
        "pilot_family_coverage",
        `pilot has no fully accepted candidate for family ${family}`,
      );
    }
  }
  if (input.primaryPlan.runKind !== "design_primary") {
    fail("primary_plan_kind", "freeze must target the design_primary plan");
  }
  if (input.pilotMetrics.evidenceKind !== "live") {
    fail("pilot_metrics_evidence", "pilot metrics are not live evidence");
  }
  const drift = configurationDifferences(
    input.pilotConfiguration,
    input.currentConfiguration,
  );
  if (drift.length > 0) {
    fail(
      "configuration_drift",
      `pilot configuration differs from the current configuration: ${drift.join(", ")}`,
    );
  }
  if (input.pilotRun.protocolVersion !== input.primaryPlan.protocolVersion) {
    fail("protocol_version_drift", "pilot protocol version differs from the primary plan");
  }
  if (
    input.routingConfirmation.providerSort !== null &&
    input.routingConfirmation.providerSort !== "default" &&
    input.routingConfirmation.providerSort !== "balanced"
  ) {
    fail("routing_confirmation_conflict", "provider sort is not default Balanced");
  }
  if (input.routingConfirmation.byokProviderKeysConfigured !== false) {
    fail("byok_configured", "BYOK provider keys must not be configured");
  }
  if (input.budgetForecast.totalLogicalCalls > 400) {
    fail("forecast_calls", "forecast exceeds the 400 primary logical-call cap");
  }
  if (input.budgetForecast.maxTransportAttempts > 1_200) {
    fail("forecast_attempts", "forecast exceeds the 1,200 transport-attempt cap");
  }
  const forecast = DesignerBudgetForecastSchema.safeParse(
    input.budgetForecast,
  );
  if (!forecast.success) {
    fail(
      "forecast_invalid",
      "budget forecast reserve fields must be non-negative decimal USD strings",
    );
  }
  if (
    !UsdSchema.safeParse(input.authorization.maxRunCostUsd).success
  ) {
    fail(
      "authorization_cap_invalid",
      "authorized run cap must be a non-negative decimal USD string",
    );
  } else {
    const parsedForecast = forecast.success ? forecast.data : null;
    if (parsedForecast !== null) {
      const perRoleTotal = addUsd(
        parsedForecast.perRoleReserveUsd.design,
        parsedForecast.perRoleReserveUsd.design_repair_1,
        parsedForecast.perRoleReserveUsd.design_repair_2,
      );
      if (
        compareUsd(
          parsedForecast.conservativeReserveUsd,
          input.authorization.maxRunCostUsd,
        ) > 0 ||
        compareUsd(perRoleTotal, input.authorization.maxRunCostUsd) > 0
      ) {
        fail(
          "forecast_exceeds_authorization",
          "conservative reserve or per-role reserve total exceeds the authorized cap",
        );
      }
    }
  }
  if (input.authorization.acknowledged !== true) {
    fail("authorization_missing", "freeze requires explicit authorization");
  }
  const thresholds = input.thresholds ?? DESIGNER_DECISION_THRESHOLDS;
  if (canonicalJson(thresholds) !== canonicalJson(DESIGNER_DECISION_THRESHOLDS)) {
    fail(
      "thresholds_changed",
      "threshold changes require a new protocol revision and new pilot evidence",
    );
  }
  const humanPlan = input.humanEvaluationPlan ?? DESIGNER_HUMAN_EVALUATION_PLAN;
  if (canonicalJson(humanPlan) !== canonicalJson(DESIGNER_HUMAN_EVALUATION_PLAN)) {
    fail(
      "human_plan_changed",
      "human-evaluation sampler/rubric changes require a new protocol revision",
    );
  }

  if (failures.length > 0) {
    return { ok: false, failures, freeze: null };
  }

  const configurationHash = computeDesignerConfigurationHash(
    input.currentConfiguration,
  );
  const body: DesignerProtocolFreeze = {
    version: DESIGNER_PROTOCOL_FREEZE_VERSION,
    kind: "designer_protocol_freeze",
    protocolHash: "0".repeat(64),
    freezeHash: "0".repeat(64),
    frozenAt: input.frozenAt,
    pilotRunId: input.pilotRun.runId,
    pilotManifestHash: input.pilotRun.manifestHash,
    pilotConfigurationHash: computeDesignerConfigurationHash(
      input.pilotConfiguration,
    ),
    configurationHash,
    configuration: input.currentConfiguration,
    plan: input.primaryPlan,
    thresholds,
    budgetForecast: input.budgetForecast,
    pilotEvidence: input.pilotEvidence,
    humanEvaluationPlan: humanPlan,
    routingConfirmation: input.routingConfirmation,
    routingConfirmationHash: computeRoutingConfirmationHash(
      input.routingConfirmation,
    ),
    authorization: input.authorization,
    protocolVersion: input.pilotRun.protocolVersion,
  };
  const protocolHash = computeDesignerProtocolHash(body);
  const withProtocol = { ...body, protocolHash };
  const freeze = DesignerProtocolFreezeSchema.parse({
    ...withProtocol,
    freezeHash: computeDesignerFreezeHash(withProtocol),
  });
  if (freeze.protocolHash !== protocolHash) {
    throw new Error("designer protocol freeze hash construction is inconsistent");
  }
  return { ok: true, failures: [], freeze };
}

export function insertDesignerProtocolFreeze(
  db: Database.Database,
  freeze: DesignerProtocolFreeze,
): DesignerProtocolFreeze {
  const parsed = DesignerProtocolFreezeSchema.parse(freeze);
  if (parsed.protocolHash !== computeDesignerProtocolHash(parsed)) {
    throw new Error("designer protocol hash does not match freeze payload");
  }
  if (parsed.freezeHash !== computeDesignerFreezeHash(parsed)) {
    throw new Error("designer freeze hash does not match freeze payload");
  }
  const payloadJson = canonicalJson(parsed);
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO designer_protocol_freezes (freeze_hash, protocol_hash, pilot_run_id, frozen_at, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      parsed.freezeHash,
      parsed.protocolHash,
      parsed.pilotRunId,
      parsed.frozenAt,
      payloadJson,
      sha256Hex(payloadJson),
      parsed.frozenAt,
    );
  });
  return parsed;
}

export function getDesignerProtocolFreeze(
  db: Database.Database,
  protocolHash: string,
): DesignerProtocolFreeze {
  const row = db
    .prepare(
      "SELECT payload_json, payload_hash FROM designer_protocol_freezes WHERE protocol_hash = ?",
    )
    .get(protocolHash) as
    | { payload_json: string; payload_hash: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`designer protocol freeze not found: ${protocolHash}`);
  }
  if (sha256Hex(row.payload_json) !== row.payload_hash) {
    throw new Error("stored designer protocol freeze payload hash mismatch");
  }
  const freeze = DesignerProtocolFreezeSchema.parse(JSON.parse(row.payload_json));
  if (freeze.protocolHash !== protocolHash) {
    throw new Error("stored designer protocol freeze hash mismatch");
  }
  return freeze;
}

export function readDesignerConfigurationEvent(
  db: Database.Database,
  runId: string,
): DesignerConfigurationSnapshot | null {
  const row = db
    .prepare(
      "SELECT payload_json FROM events WHERE run_id = ? AND event_type = 'designer_configuration' ORDER BY event_id DESC LIMIT 1",
    )
    .get(runId) as { payload_json: string } | undefined;
  if (row === undefined) {
    return null;
  }
  return DesignerConfigurationSnapshotSchema.parse(
    JSON.parse(row.payload_json) as unknown,
  );
}

export function listDesignerProtocolFreezes(
  db: Database.Database,
): DesignerProtocolFreeze[] {
  const rows = db
    .prepare(
      "SELECT payload_json FROM designer_protocol_freezes ORDER BY frozen_at, protocol_hash",
    )
    .all() as Array<{ payload_json: string }>;
  return rows.map((row) =>
    DesignerProtocolFreezeSchema.parse(JSON.parse(row.payload_json)),
  );
}

export function exportDesignerProtocolFreeze(input: {
  readonly freeze: DesignerProtocolFreeze;
  readonly outputDirectory: string;
}): { readonly protocolPath: string; readonly protocolHash: string } {
  mkdirSync(input.outputDirectory, { recursive: true });
  const protocolPath = join(input.outputDirectory, "protocol.json");
  writeFileSync(protocolPath, `${canonicalJson(input.freeze)}\n`, "utf8");
  return { protocolPath, protocolHash: input.freeze.protocolHash };
}

export function readDesignerProtocolFreeze(path: string): DesignerProtocolFreeze {
  return DesignerProtocolFreezeSchema.parse(
    JSON.parse(readFile(path, "utf8")),
  );
}

export function verifyDesignerProtocolFreezeFromDb(
  db: Database.Database,
  protocolHash: string,
): DesignerProtocolFreeze {
  const freeze = getDesignerProtocolFreeze(db, protocolHash);
  if (freeze.protocolHash !== computeDesignerProtocolHash(freeze)) {
    throw new Error("designer protocol hash replay mismatch");
  }
  if (freeze.freezeHash !== computeDesignerFreezeHash(freeze)) {
    throw new Error("designer freeze hash replay mismatch");
  }
  return freeze;
}

export function hashFile(path: string): string {
  if (!existsSync(path)) {
    return sha256Hex(`missing:${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hashFiles(paths: readonly string[]): string {
  return sha256Hex(
    canonicalJson(
      paths.map((path) => ({
        path,
        hash: hashFile(path),
      })),
    ),
  );
}

export function buildDesignerConfigurationSnapshot(input: {
  readonly model: string;
  readonly outputCapField: OutputCapField;
  readonly maxOutputTokens: number;
  readonly concurrency: 1 | 2;
  readonly settings?: DesignerConfigurationSnapshot["settings"] | undefined;
  readonly routingConfirmation: RoutingConfirmation;
  readonly hashes: Omit<
    DesignerConfigurationSnapshot,
    | "model"
    | "routingPolicy"
    | "providerSort"
    | "byokProviderKeysConfigured"
    | "outputCapField"
    | "maxOutputTokens"
    | "concurrency"
    | "settingsMode"
    | "settings"
  >;
}): DesignerConfigurationSnapshot {
  return DesignerConfigurationSnapshotSchema.parse({
    model: input.model,
    routingPolicy: "balanced",
    providerSort: "default",
    byokProviderKeysConfigured: false,
    outputCapField: input.outputCapField,
    maxOutputTokens: input.maxOutputTokens,
    concurrency: input.concurrency,
    settingsMode: input.settings === undefined ? "default" : "explicit",
    settings: input.settings ?? null,
    ...input.hashes,
  });
}

export function hashDirectory(root: string, options: {
  readonly exclude?: (relativePath: string) => boolean;
} = {}): string {
  const files: Array<{ path: string; hash: string }> = [];
  const visit = (directory: string, relative: string): void => {
    if (!existsSync(directory)) {
      return;
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (options.exclude?.(relativePath) === true) {
          continue;
        }
        files.push({ path: relativePath, hash: hashFile(absolutePath) });
      }
    }
  };
  visit(root, "");
  return sha256Hex(canonicalJson(files));
}

export interface DesignerConfigurationHashes {
  readonly promptsHash: string;
  readonly schemaHash: string;
  readonly sourceHash: string;
  readonly fontHash: string;
  readonly referenceHash: string;
  readonly cohortHash: string;
  readonly dependencyLockHash: string;
  readonly templateHash: string;
  readonly comparatorHash: string;
  readonly metricsHash: string;
  readonly decisionEvaluatorHash: string;
  readonly humanRubricHash: string;
}

export function collectDesignerConfigurationHashes(input: {
  readonly root?: string;
  readonly frozenReferenceHash: string;
  readonly cohortReferenceHash: string;
}): DesignerConfigurationHashes {
  const root = input.root ?? process.cwd();
  const path = (relative: string): string => join(root, relative);
  return {
    promptsHash: hashDirectory(path("src/ai/prompts/designer-v1")),
    schemaHash: hashFiles([
      path("src/domain/design.ts"),
      path("src/domain/spec.ts"),
      path("src/domain/answers.ts"),
      path("src/families/canonicalize.ts"),
      path("src/ai/schemas.ts"),
      path("src/ai/design-proposal.ts"),
      path("src/ai/repair-proposal.ts"),
      path("src/families/truth/schema.ts"),
      path("src/families/truth/canonical.ts"),
      path("src/families/truth/engine.ts"),
    ]),
    sourceHash: sha256Hex(
      canonicalJson([
        hashFiles([
          path("package.json"),
          path("tsconfig.json"),
          path("src/ai/design-proposal.ts"),
          path("src/ai/repair-proposal.ts"),
          path("src/ai/schemas.ts"),
          path("src/ai/openrouter.ts"),
          path("src/ai/ledger.ts"),
          path("src/ai/budget.ts"),
          path("src/ai/mock.ts"),
          path("src/ai/preflight.ts"),
          path("src/ai/config.ts"),
          path("src/ai/retry.ts"),
          path("src/ai/redact.ts"),
          path("src/design/preflight.ts"),
          path("src/design/routing.ts"),
        ]),
        hashDirectory(path("src/design")),
        hashDirectory(path("src/families/truth")),
        hashDirectory(path("src/presentation")),
        hashDirectory(path("src/render")),
      ]),
    ),
    fontHash: hashFile(path("assets/fonts/DejaVuSans.ttf")),
    referenceHash: input.frozenReferenceHash,
    cohortHash: input.cohortReferenceHash,
    dependencyLockHash: hashFile(path("package-lock.json")),
    templateHash: hashFiles([
      path("src/presentation/templates.ts"),
      path("src/presentation/explain.ts"),
    ]),
    comparatorHash: hashFiles([
      path("src/families/canonicalize.ts"),
      path("src/design/novelty.ts"),
    ]),
    metricsHash: hashFile(path("src/reporting/design-metrics.ts")),
    decisionEvaluatorHash: hashFile(path("src/reporting/design-decision.ts")),
    humanRubricHash: hashFile(path("docs/design-evaluation.md")),
  };
}
