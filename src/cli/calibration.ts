import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import { Command, CommanderError } from "commander";
import {
  createBudgetAccount,
  getBudgetSummary,
  normalizeUsd,
} from "../ai/budget.js";
import {
  readLiveEnvironment,
  type LiveEnvironmentConfig,
} from "../ai/config.js";
import { loadLocalEnv } from "../ai/local-env.js";
import { createOpenRouterTransport } from "../ai/openrouter.js";
import {
  fetchCatalogForModels,
  runPreflightOnCatalog,
  type PreflightReport,
  type ResolvedRoute,
  type RolePreflightRequest,
} from "../ai/preflight.js";
import {
  buildCalibrationPack,
  buildCalibrationPackV2,
  buildCalibrationPilotPack,
  buildPathsDuplicateOnlyPilotPack,
  buildPathsDuplicatePilotPack,
  buildPathsPilotPack,
  buildPathsPilotPackV2,
} from "../calibration/fixtures.js";
import { auditPathsAsset } from "../calibration/asset-audit.js";
import type { ChoiceSet } from "../domain/answers.js";
import type { PathRoute, PathsSpec } from "../families/paths/schema.js";
import {
  acceptProposedLabels,
  calibrationLabelsHash,
  parseCalibrationLabelsCsv,
  renderCalibrationLabelsCsv,
  validateCalibrationLabels,
} from "../calibration/labels.js";
import {
  failedRunResult,
  runCalibrationLive,
  type CalibrationLiveRouteSet,
  type CalibrationLiveRunResult,
} from "../calibration/live.js";
import { writeCalibrationLiveArtifacts } from "../calibration/live-artifacts.js";
import { writeCalibrationPack } from "../calibration/pack.js";
import {
  buildCalibrationPilotLabels,
  calibrationPilotPass,
} from "../calibration/pilot.js";
import {
  CALIBRATION_MOCK_MODES,
  runCalibrationMock,
  type CalibrationMockMode,
} from "../calibration/run.js";
import { scoreCalibration } from "../calibration/score.js";
import {
  buildProvenanceSnapshot,
  provenanceConfigurationFromSnapshot,
  summarizeProvenanceSnapshot,
} from "../experiment/provenance.js";
import {
  acquireWriterLock,
  migrate,
  openDatabase,
} from "../storage/database.js";
import { hashCanonicalJson } from "../util/hash.js";

export const PROGRAM_NAME = "calibration";

interface CalibrationOptions {
  readonly prepare?: boolean;
  readonly prepareV2?: boolean;
  readonly auditAssets?: boolean;
  readonly auditSet?: string;
  readonly mock?: boolean;
  readonly live?: boolean;
  readonly pilot?: boolean;
  readonly pilotSet?: string;
  readonly allowPaid?: boolean;
  readonly maxCost?: string;
  readonly visionReasoningEffort?: string;
  readonly packVersion?: string;
  readonly mockMode?: string;
  readonly labels?: string;
  readonly verifyLabels?: string;
  readonly acceptProposed?: boolean;
  readonly auditor?: string;
  readonly auditorTime?: string;
  readonly out?: string;
}

function readLabels(path: string) {
  return parseCalibrationLabelsCsv(readFileSync(path, "utf8"));
}

function selectedPack(
  program: Command,
  options: CalibrationOptions,
): ReturnType<typeof buildCalibrationPack> {
  const version = options.packVersion ?? "1";
  if (version === "1") {
    return buildCalibrationPack();
  }
  if (version === "2") {
    return buildCalibrationPackV2();
  }
  program.error("--pack-version must be 1 or 2", { exitCode: 1 });
  return buildCalibrationPack();
}

function formatPreflightFailures(report: PreflightReport): string {
  return `${report.failures
    .map(
      (failure) =>
        `preflight failure ${failure.role ?? "global"} ${failure.code}: ${failure.detail}`,
    )
    .join("\n")}\n`;
}

function liveRoleRequests(
  config: ReturnType<typeof readLiveEnvironment>,
  visionReasoningEffort?: string,
): RolePreflightRequest[] {
  const vision =
    visionReasoningEffort === undefined
      ? undefined
      : { reasoningEffort: visionReasoningEffort as "low" | "medium" | "high" };
  return [
    { role: "spec", model: config.generator.model },
    { role: "wording", model: config.generator.model },
    { role: "blind_text", model: config.reviewer.model },
    { role: "alignment_text", model: config.alignmentText.model },
    {
      role: "blind_vision",
      model: config.visionReviewer.model,
      ...(vision === undefined ? {} : { settings: vision }),
    },
    {
      role: "alignment_vision",
      model: config.visionReviewer.model,
      ...(vision === undefined ? {} : { settings: vision }),
    },
  ];
}

function liveRoute(
  report: PreflightReport,
  role: RolePreflightRequest["role"],
): ResolvedRoute {
  const resolved =
    report.roles.find((entry) => entry.role === role)?.resolved ?? null;
  if (resolved === null) {
    throw new Error(`preflight did not resolve a live route for ${role}`);
  }
  return resolved;
}

function parseVisionReasoningEffort(
  program: Command,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) {
    return undefined;
  }
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    program.error("--vision-reasoning-effort must be low, medium, or high", {
      exitCode: 1,
    });
  }
  return effort;
}

async function resolveLiveRoutes(
  config: LiveEnvironmentConfig,
  visionReasoningEffort?: string,
): Promise<{
  readonly catalog: Awaited<ReturnType<typeof fetchCatalogForModels>>;
  readonly routes: CalibrationLiveRouteSet;
} | null> {
  const catalog = await fetchCatalogForModels({
    modelIds: [
      config.generator.model,
      config.reviewer.model,
      config.alignmentText.model,
      config.visionReviewer.model,
    ],
    apiKey: config.apiKey,
  });
  const report = runPreflightOnCatalog(
    catalog,
    liveRoleRequests(config, visionReasoningEffort),
    {
      mode: "live",
      allowConditionalOverrides: true,
      allowImageContextReserve: true,
    },
  );
  if (!report.ok) {
    process.stdout.write(formatPreflightFailures(report));
    return null;
  }
  return {
    catalog,
    routes: {
      blindText: liveRoute(report, "blind_text"),
      blindVision: liveRoute(report, "blind_vision"),
      alignmentText: liveRoute(report, "alignment_text"),
      alignmentVision: liveRoute(report, "alignment_vision"),
    },
  };
}

async function runLiveCalibration(
  program: Command,
  options: CalibrationOptions,
): Promise<number> {
  if (options.allowPaid !== true) {
    program.error("live calibration requires --allow-paid", { exitCode: 1 });
  }
  if (options.maxCost === undefined) {
    program.error("live calibration requires --max-cost <usd>", {
      exitCode: 1,
    });
  }
  if (options.labels === undefined) {
    program.error("live calibration requires --labels <path>", {
      exitCode: 1,
    });
  }
  let maxCostUsd: string;
  try {
    maxCostUsd = normalizeUsd(options.maxCost, "--max-cost");
  } catch (error) {
    program.error(
      error instanceof Error ? error.message : "--max-cost is invalid",
      { exitCode: 1 },
    );
    return 1;
  }
  if (new Decimal(maxCostUsd).lte(0)) {
    program.error("--max-cost must be a positive USD amount", { exitCode: 1 });
    return 1;
  }
  const visionReasoningEffort = parseVisionReasoningEffort(
    program,
    options.visionReasoningEffort,
  );
  const config = readLiveEnvironment(process.env);
  const built = selectedPack(program, options);
  const labelsPath = resolve(options.labels);
  const labels = readLabels(labelsPath);
  const auditors = [
    ...new Set(labels.rows.map((row) => row.auditor.trim())),
  ];
  const auditor =
    options.auditor?.trim() ??
    (auditors.length === 1 ? (auditors[0] ?? "") : "");
  if (auditor === "") {
    program.error(
      "live calibration requires --auditor when label rows do not share one auditor",
      { exitCode: 1 },
    );
    return 1;
  }
  validateCalibrationLabels({
    labels,
    pack: built.pack,
    mode: "verify",
    auditor,
  });
  const context = await resolveLiveRoutes(config, visionReasoningEffort);
  if (context === null) {
    return 1;
  }
  const { catalog, routes } = context;
  const provenanceSnapshot = buildProvenanceSnapshot({
    rootDirectory: process.cwd(),
    forbiddenSecrets: [config.apiKey],
  });
  const configuration = provenanceConfigurationFromSnapshot(provenanceSnapshot);
  const provenanceSummary = summarizeProvenanceSnapshot(provenanceSnapshot);
  const calibrationId = randomUUID();
  const outputRoot = resolve(options.out ?? "data/calibration");
  const directory = join(outputRoot, built.pack.packHash, "live", calibrationId);
  if (existsSync(directory)) {
    throw new Error(`calibration directory already exists: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, "calibration.sqlite");
  const db = openDatabase(dbPath);
  let lock: Awaited<ReturnType<typeof acquireWriterLock>> | null = null;
  let result: CalibrationLiveRunResult;
  let budgetSummary: unknown;
  const startedAt = new Date().toISOString();
  const accountId = `calibration-${calibrationId}`;
  try {
    migrate(db);
    lock = await acquireWriterLock(dbPath);
    createBudgetAccount(db, {
      accountId,
      runId: null,
      runKind: "calibration",
      maxCostUsd,
      createdAt: startedAt,
    });
    const transport = createOpenRouterTransport();
    result = await runCalibrationLive({
      built,
      labels,
      routes,
      db,
      accountId,
      apiKey: config.apiKey,
      transport,
    });
    budgetSummary = getBudgetSummary(db);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // The database and any side files remain part of the manifest.
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = failedRunResult(
      built,
      startedAt,
      new Date().toISOString(),
      message,
    );
    try {
      budgetSummary = getBudgetSummary(db);
    } catch {
      budgetSummary = null;
    }
  } finally {
    db.close();
    try {
      await lock?.release();
    } catch {
      // A compromised lock may already be gone; preserve the run result.
    }
  }
  const finalResult = result;
  const score = scoreCalibration({
    labels,
    observations: finalResult.observations,
    reviewCalls: finalResult.reviewCalls,
    generationCalls: 0,
    evidenceKind: "live",
    liveEligible:
      finalResult.status === "completed" &&
      finalResult.reviewCalls === 80 &&
      finalResult.observations.length === 40 &&
      !finalResult.budgetBreached,
  });
  const written = writeCalibrationLiveArtifacts({
    directory,
    calibrationId,
    built,
    labels,
    labelsPath,
    routes,
    models: {
      generator: config.generator.model,
      reviewer: config.reviewer.model,
      alignmentText: config.alignmentText.model,
      visionReviewer: config.visionReviewer.model,
    },
    catalog: {
      source: catalog.source,
      recordedAt: catalog.recordedAt,
      modelCount: catalog.models.length,
      catalogHash: hashCanonicalJson(catalog),
    },
    configuration,
    provenanceSummary,
    authorizedCapUsd: maxCostUsd,
    accountId,
    budgetSummary,
    result: finalResult,
    score,
    databasePath: dbPath,
  });
  const ok =
    finalResult.status === "completed" &&
    finalResult.fatalError === null &&
    !finalResult.budgetBreached &&
    score.liveEligible &&
    score.gates.allPass;
  const reportCommand =
    options.out === undefined
      ? `npm run report -- --run ${calibrationId}`
      : `npm run report -- --run ${calibrationId} --calibration-root ${JSON.stringify(outputRoot)}`;
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "live",
        calibrationId,
        status: finalResult.status,
        directory: written.directory,
        calibrationPath: written.calibrationPath,
        scorePath: written.scorePath,
        manifestPath: written.manifestPath,
        manifestHash: written.manifestHash,
        reportCommand,
        packHash: built.pack.packHash,
        labelsHash: calibrationLabelsHash(labels),
        reviewCalls: finalResult.reviewCalls,
        generationCalls: 0,
        observations: finalResult.observations.length,
        transportAttempts: finalResult.transportAttempts,
        providerMix: finalResult.providerMix,
        cost: {
          knownUsd: finalResult.knownCostUsd,
          unknownCalls: finalResult.unknownCalls,
          unknownAttempts: finalResult.unknownAttempts,
        },
        gates: score.gates,
        liveEligible: score.liveEligible,
        budgetPaused: finalResult.budgetPaused,
        budgetBreached: finalResult.budgetBreached,
        firstFailure: finalResult.firstFailure,
        fatalError: finalResult.fatalError,
        result: ok ? "ok" : "failed",
      },
      null,
      2,
    )}\n`,
  );
  return ok ? 0 : 1;
}

async function runPilotCalibration(
  program: Command,
  options: CalibrationOptions,
): Promise<number> {
  if (options.allowPaid !== true) {
    program.error("pilot requires --allow-paid", { exitCode: 1 });
  }
  if (options.maxCost === undefined) {
    program.error("pilot requires --max-cost <usd>", { exitCode: 1 });
  }
  if (options.labels !== undefined) {
    program.error(
      "--pilot uses code-derived pilot truth and does not accept --labels",
      { exitCode: 1 },
    );
  }
  let maxCostUsd: string;
  try {
    maxCostUsd = normalizeUsd(options.maxCost, "--max-cost");
  } catch (error) {
    program.error(
      error instanceof Error ? error.message : "--max-cost is invalid",
      { exitCode: 1 },
    );
    return 1;
  }
  if (new Decimal(maxCostUsd).lte(0)) {
    program.error("--max-cost must be a positive USD amount", { exitCode: 1 });
    return 1;
  }
  if (new Decimal(maxCostUsd).gt("0.25")) {
    program.error("pilot cap must not exceed the approved USD 0.25", {
      exitCode: 1,
    });
    return 1;
  }
  const visionReasoningEffort = parseVisionReasoningEffort(
    program,
    options.visionReasoningEffort,
  );
  const pilotSet = options.pilotSet ?? "full";
  if (
    pilotSet !== "full" &&
    pilotSet !== "paths" &&
    pilotSet !== "paths-medium" &&
    pilotSet !== "paths-duplicate" &&
    pilotSet !== "paths-duplicate-only"
  ) {
    program.error(
      "--pilot-set must be full, paths, paths-medium, paths-duplicate, or paths-duplicate-only",
      { exitCode: 1 },
    );
    return 1;
  }
  const config = readLiveEnvironment(process.env);
  const built =
    pilotSet === "paths"
      ? buildPathsPilotPack()
      : pilotSet === "paths-medium"
        ? buildPathsPilotPackV2()
        : pilotSet === "paths-duplicate"
          ? buildPathsDuplicatePilotPack()
          : pilotSet === "paths-duplicate-only"
            ? buildPathsDuplicateOnlyPilotPack()
            : buildCalibrationPilotPack();
  const labels = buildCalibrationPilotLabels(built);
  const context = await resolveLiveRoutes(config, visionReasoningEffort);
  if (context === null) {
    return 1;
  }
  const { catalog, routes } = context;
  const provenanceSnapshot = buildProvenanceSnapshot({
    rootDirectory: process.cwd(),
    forbiddenSecrets: [config.apiKey],
  });
  const configuration = provenanceConfigurationFromSnapshot(provenanceSnapshot);
  const provenanceSummary = summarizeProvenanceSnapshot(provenanceSnapshot);
  const pilotId = randomUUID();
  const outputRoot = resolve(options.out ?? "data/calibration-pilot");
  const directory = join(outputRoot, pilotId);
  if (existsSync(directory)) {
    throw new Error(`pilot directory already exists: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, "pilot.sqlite");
  const db = openDatabase(dbPath);
  let lock: Awaited<ReturnType<typeof acquireWriterLock>> | null = null;
  let result: CalibrationLiveRunResult;
  let budgetSummary: unknown;
  const startedAt = new Date().toISOString();
  const accountId = `pilot-${pilotId}`;
  try {
    migrate(db);
    lock = await acquireWriterLock(dbPath);
    createBudgetAccount(db, {
      accountId,
      runId: null,
      runKind: "calibration",
      maxCostUsd,
      createdAt: startedAt,
    });
    const transport = createOpenRouterTransport();
    result = await runCalibrationLive({
      built,
      labels,
      routes,
      db,
      accountId,
      apiKey: config.apiKey,
      transport,
      expectedCalls:
        pilotSet === "full"
          ? 12
          : pilotSet === "paths-duplicate"
            ? 4
            : pilotSet === "paths-duplicate-only"
              ? 2
              : 6,
    });
    budgetSummary = getBudgetSummary(db);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // The database and any side files remain part of the manifest.
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = failedRunResult(
      built,
      startedAt,
      new Date().toISOString(),
      message,
    );
    try {
      budgetSummary = getBudgetSummary(db);
    } catch {
      budgetSummary = null;
    }
  } finally {
    db.close();
    try {
      await lock?.release();
    } catch {
      // A compromised lock may already be gone; preserve the run result.
    }
  }
  const score = scoreCalibration({
    labels,
    observations: result.observations,
    reviewCalls: result.reviewCalls,
    generationCalls: 0,
    evidenceKind: "pilot",
    liveEligible: false,
  });
  const pilotPass = calibrationPilotPass(score, labels);
  const written = writeCalibrationLiveArtifacts({
    directory,
    calibrationId: pilotId,
    built,
    labels,
    labelsPath: "",
    labelsCsv: renderCalibrationLabelsCsv(labels.rows),
    routes,
    models: {
      generator: config.generator.model,
      reviewer: config.reviewer.model,
      alignmentText: config.alignmentText.model,
      visionReviewer: config.visionReviewer.model,
    },
    catalog: {
      source: catalog.source,
      recordedAt: catalog.recordedAt,
      modelCount: catalog.models.length,
      catalogHash: hashCanonicalJson(catalog),
    },
    configuration,
    provenanceSummary,
    authorizedCapUsd: maxCostUsd,
    accountId,
    budgetSummary,
    result,
    score,
    databasePath: dbPath,
    mode: "pilot",
    pilotSet,
    pilot: {
      pass: pilotPass.pass,
      criteria: pilotPass.criteria,
      combinations: pilotPass.combinations,
      schemaValidCalls: pilotPass.schemaValidCalls,
    },
  });
  const ok =
    result.status === "completed" &&
    result.fatalError === null &&
    !result.budgetBreached &&
    pilotPass.pass;
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "pilot",
        pilotSet,
        pilotId,
        status: result.status,
        pilotPass: pilotPass.pass,
        criteria: pilotPass.criteria,
        combinations: pilotPass.combinations,
        schemaValidCalls: pilotPass.schemaValidCalls,
        reviewCalls: result.reviewCalls,
        generationCalls: 0,
        observations: result.observations.length,
        transportAttempts: result.transportAttempts,
        providerMix: result.providerMix,
        cost: {
          knownUsd: result.knownCostUsd,
          unknownCalls: result.unknownCalls,
          unknownAttempts: result.unknownAttempts,
        },
        artifactPath: written.mainPath,
        manifestPath: written.manifestPath,
        manifestHash: written.manifestHash,
        freezeEligible: false,
        firstFailure: result.firstFailure,
        fatalError: result.fatalError,
        result: ok ? "ok" : "failed",
      },
      null,
      2,
    )}\n`,
  );
  return ok ? 0 : 1;
}

function printPackSummary(
  built: ReturnType<typeof buildCalibrationPack>,
  paths: ReturnType<typeof writeCalibrationPack>,
): void {
  const sound = built.pack.fixtures.filter(
    (fixture) => fixture.variant === "sound",
  ).length;
  const defective = built.pack.fixtures.length - sound;
  process.stdout.write(
    [
      `pack_hash: ${paths.packHash}`,
      `version: ${built.pack.version}`,
      `directory: ${paths.directory}`,
      `fixtures: ${built.pack.fixtures.length}`,
      `sound: ${sound}`,
      `defective: ${defective}`,
      `pack: ${paths.packPath}`,
      `labels: ${paths.labelsPath}`,
      `gallery: ${paths.galleryPath}`,
    ].join("\n") + "\n",
  );
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      "Build the held-out calibration pack, verify labels, run the mock scoring, or execute the authorization-gated live calibration.",
    )
    .showHelpAfterError()
    .option("--prepare", "build the 40-item fixture pack, gallery, and pending label template")
    .option("--prepare-v2", "build the version-2 40-item pack, gallery, and pending label template")
    .option("--audit-assets", "run the deterministic paths SVG/PNG audit on a development pilot pack")
    .option("--audit-set <set>", "asset audit set: full, paths, or paths-medium", "full")
    .option("--mock", "run the 80-call mock blind+alignment calibration and score it")
    .option("--live", "run the 80-call live blind+alignment calibration behind paid gates")
    .option("--pilot", "run the approved 6-case/12-call development pilot behind paid gates")
    .option("--pilot-set <set>", "pilot case set: full or paths", "full")
    .option("--allow-paid", "acknowledge paid execution for --live or --pilot")
    .option("--max-cost <usd>", "authorized maximum cost for --live or --pilot")
    .option(
      "--vision-reasoning-effort <effort>",
      "optional reasoning_effort for the vision roles (low, medium, high)",
    )
    .option("--mock-mode <mode>", "mock reviewer mode: oracle, agree, or reject", "oracle")
    .option("--labels <path>", "calibration label CSV for --mock or --live")
    .option(
      "--pack-version <version>",
      "calibration pack version for label-consuming modes (1 or 2; default: 1)",
      "1",
    )
    .option("--verify-labels <path>", "validate a human-verified label CSV without running reviews")
    .option("--accept-proposed", "after human review, fill blank observed_* fields from proposed_* and mark the file human-verified")
    .option("--auditor <name>", "auditor identity for --verify-labels, --accept-proposed, or --live")
    .option("--auditor-time <iso>", "auditor timestamp for --accept-proposed (default: now)")
    .option(
      "--out <dir>",
      "output root for --prepare, --prepare-v2, --live, or --pilot (pilot default: data/calibration-pilot; v2 default: data/calibration-v2); pass the same root to report --calibration-root",
    )
    .action(async (options: CalibrationOptions) => {
      const modes = [
        options.prepare === true,
        options.prepareV2 === true,
        options.auditAssets === true,
        options.mock === true,
        options.live === true,
        options.pilot === true,
        options.verifyLabels !== undefined,
        options.acceptProposed === true,
      ].filter(Boolean);
      if (modes.length !== 1) {
        program.error(
          "choose exactly one of --prepare, --prepare-v2, --audit-assets, --mock, --live, --pilot, --verify-labels, or --accept-proposed",
          { exitCode: 1 },
        );
        return;
      }
      if (options.live !== true && options.pilot !== true) {
        if (
          options.allowPaid === true ||
          options.maxCost !== undefined ||
          options.visionReasoningEffort !== undefined
        ) {
          program.error(
            "--allow-paid, --max-cost, and --vision-reasoning-effort require --live or --pilot",
            { exitCode: 1 },
          );
          return;
        }
      }
      if (options.pilot === true) {
        process.exitCode = await runPilotCalibration(program, options);
        return;
      }
      if (options.live === true) {
        process.exitCode = await runLiveCalibration(program, options);
        return;
      }
      if (options.prepareV2 === true) {
        if (
          options.labels !== undefined ||
          options.auditor !== undefined ||
          options.auditorTime !== undefined
        ) {
          program.error(
            "--prepare-v2 does not accept --labels, --auditor, or --auditor-time",
            { exitCode: 1 },
          );
          return;
        }
        const built = buildCalibrationPackV2();
        const paths = writeCalibrationPack(
          built,
          options.out ?? "data/calibration-v2",
        );
        printPackSummary(built, paths);
        return;
      }
      if (options.auditAssets === true) {
        const auditSet = options.auditSet ?? "full";
        let built: ReturnType<typeof buildCalibrationPilotPack>;
        if (auditSet === "full") {
          built = buildCalibrationPilotPack();
        } else if (auditSet === "paths") {
          built = buildPathsPilotPack();
        } else if (auditSet === "paths-medium") {
          built = buildPathsPilotPackV2();
        } else {
          program.error("--audit-set must be full, paths, or paths-medium", {
            exitCode: 1,
          });
          return;
        }
        const reports = built.fixtures
          .filter((entry) => entry.fixture.modality === "svg")
          .map((entry) => {
            const svg = entry.artifacts.visible.svg;
            const png = entry.artifacts.visible.png;
            if (svg === null || png === null) {
              throw new Error(
                `${entry.fixture.fixtureId} has no visible SVG/PNG`,
              );
            }
            return {
              fixtureId: entry.fixture.fixtureId,
              ...auditPathsAsset({
                svg,
                png,
                spec: entry.fixture.original.spec as PathsSpec,
                choices: entry.fixture.original
                  .choices as ChoiceSet<PathRoute>,
                expected: entry.fixture.expected,
                ...(entry.fixture.mutation === null
                  ? {}
                  : { mutation: entry.fixture.mutation }),
              }),
            };
          });
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: "audit-assets",
              pilotSet: auditSet,
              packHash: built.pack.packHash,
              reports,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (options.prepare === true) {
        if (
          options.labels !== undefined ||
          options.auditor !== undefined ||
          options.auditorTime !== undefined
        ) {
          program.error(
            "--prepare does not accept --labels, --auditor, or --auditor-time",
            { exitCode: 1 },
          );
          return;
        }
        const built = buildCalibrationPack();
        const paths = writeCalibrationPack(built, options.out ?? "data/calibration");
        printPackSummary(built, paths);
        return;
      }
      if (options.acceptProposed === true) {
        const auditor = options.auditor;
        if (auditor === undefined || auditor.trim() === "") {
          program.error("--accept-proposed requires --auditor", { exitCode: 1 });
          return;
        }
        if (options.labels === undefined) {
          program.error("--accept-proposed requires --labels <path>", {
            exitCode: 1,
          });
          return;
        }
        if (options.mock === true || options.verifyLabels !== undefined) {
          program.error(
            "--accept-proposed cannot be combined with --mock or --verify-labels",
            { exitCode: 1 },
          );
          return;
        }
        const labelsPath = resolve(options.labels);
        const labelsName = basename(labelsPath);
        if (
          labelsName === "labels.pending.csv" ||
          labelsName.includes("mock-labels")
        ) {
          program.error(
            "--accept-proposed refuses the pending template or a mock label fixture; use a human workspace copy",
            { exitCode: 1 },
          );
          return;
        }
        const built = selectedPack(program, options);
        const labels = readLabels(labelsPath);
        const nonPending = labels.rows.filter(
          (row) => row.provenance !== "" || row.humanVerified,
        );
        if (nonPending.length > 0) {
          program.error(
            `--accept-proposed requires pending rows; already attested: ${nonPending
              .map((row) => row.fixtureId)
              .join(", ")}`,
            { exitCode: 1 },
          );
          return;
        }
        const auditorTime = options.auditorTime ?? new Date().toISOString();
        const nonEmpty = (value: unknown): boolean =>
          Array.isArray(value)
            ? value.length > 0
            : value !== null && value !== "";
        const cellValues = (row: (typeof labels.rows)[number]): unknown[] => [
          row.observedBlindResult,
          row.observedCorrectLabel,
          row.observedDefectCodes,
          row.observedAlignmentResult,
          row.observedFailingFields,
          row.observedFactIds,
        ];
        let humanAttestedCells = 0;
        let machineFilledCells = 0;
        let emptyCells = 0;
        const acceptedForCounts = acceptProposedLabels(labels, {
          auditor,
          auditorTime,
        });
        for (let index = 0; index < labels.rows.length; index += 1) {
          const before = cellValues(labels.rows[index] as (typeof labels.rows)[number]);
          const after = cellValues(
            acceptedForCounts.rows[index] as (typeof acceptedForCounts.rows)[number],
          );
          for (let cell = 0; cell < before.length; cell += 1) {
            if (nonEmpty(before[cell])) {
              humanAttestedCells += 1;
            } else if (nonEmpty(after[cell])) {
              machineFilledCells += 1;
            } else {
              emptyCells += 1;
            }
          }
        }
        const accepted = acceptProposedLabels(labels, {
          auditor,
          auditorTime,
        });
        validateCalibrationLabels({
          labels: accepted,
          pack: built.pack,
          mode: "verify",
          auditor,
        });
        const temporaryPath = `${labelsPath}.tmp-${process.pid}`;
        try {
          writeFileSync(
            temporaryPath,
            renderCalibrationLabelsCsv(accepted.rows),
          );
          const reparsed = parseCalibrationLabelsCsv(
            readFileSync(temporaryPath, "utf8"),
          );
          validateCalibrationLabels({
            labels: reparsed,
            pack: built.pack,
            mode: "verify",
            auditor,
          });
          renameSync(temporaryPath, labelsPath);
          process.stdout.write(
            `${JSON.stringify(
              {
                labels_accepted: true,
                path: labelsPath,
                pack_hash: reparsed.packHash,
                labels_hash: calibrationLabelsHash(reparsed),
                fixtures: reparsed.rows.length,
                reviewed_rows: reparsed.rows.length,
                human_attested_cells: humanAttestedCells,
                machine_filled_cells: machineFilledCells,
                empty_cells: emptyCells,
                auditor,
                auditor_time: [
                  ...new Set(reparsed.rows.map((row) => row.auditorTime)),
                ],
                provenance: "human",
                human_verified: true,
              },
              null,
              2,
            )}\n`,
          );
        } finally {
          rmSync(temporaryPath, { force: true });
        }
        return;
      }
      if (options.verifyLabels !== undefined) {
        const auditor = options.auditor;
        if (auditor === undefined || auditor.trim() === "") {
          program.error("--verify-labels requires --auditor", { exitCode: 1 });
          return;
        }
        if (options.mock === true) {
          program.error("--verify-labels cannot be combined with --mock", {
            exitCode: 1,
          });
          return;
        }
        const built = selectedPack(program, options);
        const labels = readLabels(options.verifyLabels);
        validateCalibrationLabels({
          labels,
          pack: built.pack,
          mode: "verify",
          auditor,
        });
        process.stdout.write(
          `${JSON.stringify(
            {
              labels_verified: true,
              pack_hash: labels.packHash,
              labels_hash: calibrationLabelsHash(labels),
              fixtures: labels.rows.length,
              auditor,
              auditor_time: [...new Set(labels.rows.map((row) => row.auditorTime))],
              provenance: [...new Set(labels.rows.map((row) => row.provenance))],
              human_verified: labels.rows.every((row) => row.humanVerified),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      const labelsPath = options.labels;
      if (labelsPath === undefined) {
        program.error("--mock requires --labels", { exitCode: 1 });
        return;
      }
      const mockMode = options.mockMode ?? "oracle";
      if (!CALIBRATION_MOCK_MODES.includes(mockMode as CalibrationMockMode)) {
        program.error(
          `--mock-mode must be one of ${CALIBRATION_MOCK_MODES.join(", ")}`,
          { exitCode: 1 },
        );
        return;
      }
      const built = selectedPack(program, options);
      const labels = readLabels(labelsPath);
      validateCalibrationLabels({
        labels,
        pack: built.pack,
        mode: "mock",
      });
      const run = await runCalibrationMock({
        built,
        labels,
        mode: mockMode as CalibrationMockMode,
      });
      const score = scoreCalibration({
        labels,
        observations: run.observations,
        reviewCalls: run.reviewCalls,
        generationCalls: run.generationCalls,
      });
      process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
      process.stderr.write(
        "MOCK/TEST-ONLY calibration evidence; not live calibrated evidence.\n",
      );
    });
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  loadLocalEnv();
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof Error) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.exitCode = await main();
}
