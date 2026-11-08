import { randomUUID } from "node:crypto";
import { canonicalJson } from "../util/hash.js";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
  buildDesignerPlanManifest,
  serializeDesignerPlanManifest,
} from "../design/assignments.js";
import {
  buildCohortReference,
  buildFrozenReference,
  writeReferenceArtifacts,
} from "../design/baseline.js";
import { renderDesignReferenceGallery } from "../reporting/design-metrics.js";
import type {
  DesignerPlanManifest,
  DesignerRunKind,
} from "../domain/design.js";
import { UsdSchema } from "../domain/experiment.js";
import { openDatabase, migrate } from "../storage/database.js";
import {
  compareUsd,
  getBudgetAccount,
  increaseBudgetCap,
} from "../ai/budget.js";
import { getDesignerRun } from "../storage/repository.js";
import { createMockTransport } from "../ai/mock.js";
import { createOpenRouterTransport } from "../ai/openrouter.js";
import {
  runDesignerCohort,
  type DesignerRunConfig,
  type DesignerTransport,
} from "../design/run.js";
import {
  assertRoutingConfirmationFresh,
  parseRoutingConfirmation,
  readRoutingConfirmationFile,
  type RoutingConfirmation,
} from "../design/routing.js";
import {
  buildDesignerConfigurationSnapshot,
  collectDesignerConfigurationHashes,
  computeDesignerConfigurationHash,
  DESIGNER_CONFIGURATION_HASH_FIELDS,
  getDesignerProtocolFreeze,
  readDesignerConfigurationEvent,
} from "../design/freeze.js";
import {
  fetchDesignerPreflightCatalog,
  runDesignerPreflightOnCatalog,
  runDesignerPreflightProbes,
  type DesignerProbeResult,
} from "../design/preflight.js";

export const PROGRAM_NAME = "designer";

const SCOPE_NOTE = [
  "Availability (P50):",
  "  --dry-run              print the deterministic DesignerPlanManifest and exit (implemented offline)",
  "  --build-reference      build the frozen 1,000-outcome and cohort baseline references (implemented offline)",
  "  --mock                 run the 300-candidate offline mock cohort with zero paid calls",
  "  --resume <run-id>      resume a designer run from SQLite without replaying saved responses",
  "  --pilot | --primary    authorization-gated live plans; require --live --allow-paid",
  "  --live                 live OpenRouter execution (requires --allow-paid)",
  "  --allow-paid           explicit paid-execution acknowledgement",
  "  --max-cost <usd>       run budget cap; increases require --ack-budget-increase",
  "  --routing-confirmation <file>  operator-confirmed Balanced/no-BYOK routing evidence",
  "  --protocol <hash>      frozen protocol hash required for --primary --live",
  "  --db <path>            SQLite database (default: data/experiment.sqlite)",
  "  --concurrency <1|2>    worker concurrency (default: 2)",
  "  --model <slug>         designer model (or DESIGNER_MODEL)",
  "  Reviewer and calibration flags are not part of the designer protocol and are rejected.",
].join("\n");

interface DesignOptions {
  readonly dryRun?: boolean;
  readonly primary?: boolean;
  readonly pilot?: boolean;
  readonly mock?: boolean;
  readonly seed?: string;
  readonly live?: boolean;
  readonly allowPaid?: boolean;
  readonly maxCost?: string;
  readonly preflightMaxCost?: string;
  readonly protocol?: string;
  readonly reviewer?: boolean;
  readonly calibration?: boolean;
  readonly buildReference?: boolean;
  readonly referenceDir?: string;
  readonly resume?: string;
  readonly db?: string;
  readonly concurrency?: string;
  readonly model?: string;
  readonly maxOutputTokens?: string;
  readonly reservation?: string;
  readonly ackBudgetIncrease?: boolean;
  readonly routingConfirmation?: string;
  readonly operator?: string;
  readonly runId?: string;
}

function rejectReviewerFlags(program: Command, options: DesignOptions): void {
  if (options.reviewer === true || options.calibration === true) {
    program.error(
      "reviewer and calibration flags are not part of the designer protocol",
      { exitCode: 1 },
    );
  }
}

function selectedPlan(options: DesignOptions): DesignerRunKind {
  const selected = [options.primary, options.pilot, options.mock].filter(
    (value) => value === true,
  ).length;
  if (selected > 1) {
    throw new Error("--primary, --pilot, and --mock are mutually exclusive");
  }
  return options.pilot === true
    ? "design_pilot"
    : options.mock === true
      ? "design_mock"
      : "design_primary";
}

function parseConcurrency(value: string | undefined): 1 | 2 {
  if (value === undefined) {
    return 2;
  }
  const parsed = Number(value);
  if (parsed !== 1 && parsed !== 2) {
    throw new Error("--concurrency must be 1 or 2");
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (value === undefined) {
    return 8192;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function openMigratedDatabase(path: string | undefined) {
  const db = openDatabase(resolve(path ?? join("data", "experiment.sqlite")));
  migrate(db);
  return db;
}

function routingConfirmationFor(
  options: DesignOptions,
): RoutingConfirmation | null {
  if (options.routingConfirmation === undefined) {
    return null;
  }
  const confirmation = readRoutingConfirmationFile(
    options.routingConfirmation,
  );
  assertRoutingConfirmationFresh(confirmation, new Date());
  return confirmation;
}

function configurationSnapshotFor(input: {
  readonly model: string;
  readonly options: DesignOptions;
  readonly routingConfirmation: RoutingConfirmation;
  readonly maxOutputTokens?: number;
  readonly concurrency?: 1 | 2;
}) {
  const frozen = buildFrozenReference();
  const cohort = buildCohortReference(
    buildDesignerPlanManifest({ runKind: "design_primary" }),
  );
  const hashes = collectDesignerConfigurationHashes({
    frozenReferenceHash: frozen.referenceHash,
    cohortReferenceHash: cohort.cohortHash,
  });
  return buildDesignerConfigurationSnapshot({
    model: input.model,
    outputCapField: "max_tokens",
    maxOutputTokens:
      input.maxOutputTokens ??
      parsePositiveInteger(input.options.maxOutputTokens, "--max-output-tokens"),
    concurrency:
      input.concurrency ?? parseConcurrency(input.options.concurrency),
    routingConfirmation: input.routingConfirmation,
    hashes,
  });
}

function mockRoutingConfirmation(): RoutingConfirmation {
  return parseRoutingConfirmation({
    operator: "mock",
    checkedAt: new Date().toISOString(),
    routingPolicy: "balanced",
    providerSort: null,
    byokProviderKeysConfigured: false,
  });
}

function designerConfig(input: {
  readonly model: string;
  readonly options: DesignOptions;
  readonly nonBilling: boolean;
  readonly maxOutputTokens?: number;
}): DesignerRunConfig {
  return {
    model: input.model,
    outputCapField: "max_tokens",
    maxOutputTokens:
      input.maxOutputTokens ??
      parsePositiveInteger(input.options.maxOutputTokens, "--max-output-tokens"),
    skinEnabled: true,
    reservationUsd: input.options.reservation ?? "0.01",
    nonBilling: input.nonBilling,
  };
}

async function executeMock(options: DesignOptions): Promise<number> {
  if (
    options.live === true ||
    options.allowPaid === true ||
    options.protocol !== undefined ||
    options.routingConfirmation !== undefined
  ) {
    throw new Error("--mock cannot be combined with live/paid/protocol flags");
  }
  const runKind: DesignerRunKind = "design_mock";
  const plan = buildDesignerPlanManifest({
    runKind,
    ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
  });
  const db = openMigratedDatabase(options.db);
  const runId = options.runId ?? randomUUID();
  const accountId = randomUUID();
  const transport = createMockTransport({ db });
  const configurationSnapshot = configurationSnapshotFor({
    model: "mock/model",
    options,
    routingConfirmation: mockRoutingConfirmation(),
  });
  try {
    const result = await runDesignerCohort({
      db,
      runId,
      plan,
      evidenceKind: "mock",
      apiKey: "mock",
      transport,
      accountId,
      maxCostUsd: options.maxCost ?? "0",
      config: designerConfig({
        model: "mock/model",
        options,
        nonBilling: true,
        maxOutputTokens: configurationSnapshot.maxOutputTokens,
      }),
      concurrency: configurationSnapshot.concurrency,
      configurationSnapshot,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "mock",
          runId,
          accountId,
          planHash: result.plan.planHash,
          status: result.status,
          summary: result.summary,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

function accountIdForRun(db: ReturnType<typeof openDatabase>, runId: string): string {
  const row = db
    .prepare("SELECT account_id FROM budget_accounts WHERE run_id = ? ORDER BY created_at LIMIT 1")
    .get(runId) as { account_id: string } | undefined;
  if (row === undefined) {
    throw new Error(`no budget account exists for run ${runId}`);
  }
  return row.account_id;
}

async function executeResume(options: DesignOptions): Promise<number> {
  if (options.resume === undefined) {
    throw new Error("--resume requires a run ID");
  }
  if (
    options.primary === true ||
    options.pilot === true ||
    options.mock === true ||
    options.dryRun === true ||
    options.buildReference === true
  ) {
    throw new Error("--resume cannot be combined with plan selectors or --dry-run");
  }
  const db = openMigratedDatabase(options.db);
  try {
    const run = getDesignerRun(db, options.resume);
    const plan: DesignerPlanManifest = run.manifest;
    const accountId = accountIdForRun(db, run.runId);
    const account = getBudgetAccount(db, accountId);
    if (
      options.maxCost !== undefined &&
      !UsdSchema.safeParse(options.maxCost).success
    ) {
      throw new Error("--max-cost must be a non-negative decimal USD string");
    }
    if (options.maxCost !== undefined && options.maxCost !== account.maxCostUsd) {
      if (Number(options.maxCost) > Number(account.maxCostUsd)) {
        if (options.ackBudgetIncrease !== true) {
          throw new Error(
            "raising the budget cap on resume requires --ack-budget-increase",
          );
        }
        increaseBudgetCap(db, {
          accountId,
          newMaxCostUsd: options.maxCost,
          acknowledged: true,
          operator: options.operator ?? "unknown",
        });
      }
    }
    if (run.evidenceKind === "live") {
      if (options.live !== true || options.allowPaid !== true) {
        throw new Error("live resume requires --live --allow-paid");
      }
      const routingConfirmation = routingConfirmationFor(options);
      if (routingConfirmation === null) {
        throw new Error("live resume requires a fresh --routing-confirmation file");
      }
      const storedConfiguration = readDesignerConfigurationEvent(
        db,
        run.runId,
      );
      if (storedConfiguration === null) {
        throw new Error(
          "live resume requires the stored designer configuration from the original run",
        );
      }
      if (
        options.model !== undefined &&
        options.model !== storedConfiguration.model
      ) {
        throw new Error(
          "live resume model differs from the stored designer configuration",
        );
      }
      const model = storedConfiguration.model;
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (apiKey === undefined || apiKey.trim() === "") {
        throw new Error("live resume requires OPENROUTER_API_KEY");
      }
      const transport = createOpenRouterTransport() as DesignerTransport;
      const result = await runDesignerCohort({
        db,
        runId: run.runId,
        plan,
        evidenceKind: "live",
        apiKey,
        transport,
        accountId,
        maxCostUsd: account.maxCostUsd,
        config: designerConfig({
          model,
          options,
          nonBilling: false,
          maxOutputTokens: storedConfiguration.maxOutputTokens,
        }),
        concurrency: storedConfiguration.concurrency,
        configurationSnapshot: configurationSnapshotFor({
          model,
          options,
          routingConfirmation,
          maxOutputTokens: storedConfiguration.maxOutputTokens,
          concurrency: storedConfiguration.concurrency,
        }),
        resume: true,
      });
      process.stdout.write(
        `${JSON.stringify({ mode: "resume", runId: run.runId, status: result.status, summary: result.summary }, null, 2)}\n`,
      );
      return 0;
    }
    const transport = createMockTransport({ db });
    const storedConfiguration = readDesignerConfigurationEvent(
      db,
      run.runId,
    );
    const model = storedConfiguration?.model ?? "mock/model";
    const maxOutputTokens = storedConfiguration?.maxOutputTokens;
    const concurrency =
      storedConfiguration?.concurrency ?? parseConcurrency(options.concurrency);
    const configurationSnapshot = configurationSnapshotFor({
      model,
      options,
      routingConfirmation: mockRoutingConfirmation(),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      concurrency,
    });
    const result = await runDesignerCohort({
      db,
      runId: run.runId,
      plan,
      evidenceKind: "mock",
      apiKey: "mock",
      transport,
      accountId,
      maxCostUsd: account.maxCostUsd,
      config: designerConfig({
        model,
        options,
        nonBilling: true,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      }),
      concurrency,
      configurationSnapshot,
      resume: true,
    });
    process.stdout.write(
      `${JSON.stringify({ mode: "resume", runId: run.runId, status: result.status, summary: result.summary }, null, 2)}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function executeLive(options: DesignOptions): Promise<number> {
  if (options.live !== true || options.allowPaid !== true) {
    throw new Error("live execution requires --live --allow-paid");
  }
  if (options.maxCost === undefined) {
    throw new Error("live execution requires --max-cost");
  }
  if (!UsdSchema.safeParse(options.maxCost).success) {
    throw new Error("--max-cost must be a non-negative decimal USD string");
  }
  const routingConfirmation = routingConfirmationFor(options);
  if (routingConfirmation === null) {
    throw new Error("live execution requires --routing-confirmation");
  }
  const runKind = selectedPlan(options);
  if (runKind === "design_mock") {
    throw new Error("--mock is the offline mock execution mode");
  }
  if (runKind === "design_primary" && options.protocol === undefined) {
    throw new Error("--primary --live requires --protocol <frozen-protocol-hash>");
  }
  const plan = buildDesignerPlanManifest({ runKind });
  const db = openMigratedDatabase(options.db);
  try {
    let model = options.model ?? process.env.DESIGNER_MODEL;
    let maxOutputTokens = parsePositiveInteger(
      options.maxOutputTokens,
      "--max-output-tokens",
    );
    let concurrency = parseConcurrency(options.concurrency);
    let freeze: ReturnType<typeof getDesignerProtocolFreeze> | null = null;
    if (runKind === "design_primary" && options.protocol !== undefined) {
      freeze = getDesignerProtocolFreeze(db, options.protocol);
      if (freeze.plan.planHash !== plan.planHash) {
        throw new Error("frozen protocol plan does not match the primary plan");
      }
      if (
        options.model !== undefined &&
        options.model !== freeze.configuration.model
      ) {
        throw new Error(
          "primary live model differs from the frozen protocol model",
        );
      }
      if (
        compareUsd(options.maxCost, freeze.authorization.maxRunCostUsd) > 0
      ) {
        throw new Error("--max-cost exceeds the frozen authorized run cap");
      }
      model = freeze.configuration.model;
      maxOutputTokens = freeze.configuration.maxOutputTokens;
      concurrency = freeze.configuration.concurrency;
    }
    if (model === undefined || model.trim() === "") {
      throw new Error("live execution requires DESIGNER_MODEL or --model");
    }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new Error("live execution requires OPENROUTER_API_KEY");
    }
    const configurationSnapshot = configurationSnapshotFor({
      model,
      options,
      routingConfirmation,
      maxOutputTokens,
      concurrency,
    });
    if (freeze !== null) {
      const differingFields = DESIGNER_CONFIGURATION_HASH_FIELDS.filter(
        (field) =>
          canonicalJson(configurationSnapshot[field]) !==
          canonicalJson(freeze.configuration[field]),
      );
      if (
        differingFields.length > 0 ||
        computeDesignerConfigurationHash(configurationSnapshot) !==
          freeze.configurationHash
      ) {
        throw new Error(
          `current designer configuration does not match the frozen protocol: ${differingFields.join(", ") || "configuration hash"}`,
        );
      }
    }
    const runId = options.runId ?? randomUUID();
    const accountId = randomUUID();
    const transport = createOpenRouterTransport() as DesignerTransport;
    let preflight: {
      readonly report: ReturnType<typeof runDesignerPreflightOnCatalog>;
      readonly probes: DesignerProbeResult;
    } | null = null;
    let beforeRun:
      | ((input: { readonly db: ReturnType<typeof openDatabase>; readonly runId: string }) => Promise<void>)
      | undefined;
    if (runKind === "design_pilot") {
      const catalog = await fetchDesignerPreflightCatalog({
        model,
        apiKey,
      });
      const report = runDesignerPreflightOnCatalog(catalog, {
        model,
        maxOutputTokens,
        skinEnabled: true,
      });
      if (!report.ok) {
        throw new Error(
          `designer preflight failed: ${report.failures
            .map((failure) => `${failure.role ?? "design"}/${failure.code}: ${failure.detail}`)
            .join("; ")}`,
        );
      }
      const preflightMaxCost = options.preflightMaxCost ?? "0.50";
      beforeRun = async ({ db: probeDb, runId: probeRunId }) => {
        const probes = await runDesignerPreflightProbes({
          db: probeDb,
          pilotRunId: probeRunId,
          apiKey,
          transport,
          model,
          maxOutputTokens,
          outputCapField: "max_tokens",
          skinEnabled: true,
          maxCostUsd: preflightMaxCost,
          reservationUsd: options.reservation ?? "0.01",
        });
        if (!probes.ok) {
          throw new Error(
            `designer preflight probes failed: ${probes.probes
              .filter((probe) => !probe.ok)
              .map((probe) => `${probe.probeKey}: ${probe.error ?? probe.outcome}`)
              .join("; ")}`,
          );
        }
        preflight = { report, probes };
      };
    }
    const result = await runDesignerCohort({
      db,
      runId,
      plan,
      evidenceKind: "live",
      apiKey,
      transport,
      accountId,
      maxCostUsd: options.maxCost,
      config: designerConfig({
        model,
        options,
        nonBilling: false,
        maxOutputTokens,
      }),
      concurrency,
      configurationSnapshot,
      ...(beforeRun === undefined ? {} : { beforeRun }),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: runKind === "design_pilot" ? "pilot" : "primary",
          runId,
          accountId,
          planHash: result.plan.planHash,
          status: result.status,
          summary: result.summary,
          preflight,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function handleOptions(program: Command, options: DesignOptions): Promise<number> {
  rejectReviewerFlags(program, options);
  if (options.referenceDir !== undefined && options.buildReference !== true) {
    program.error("--reference-dir requires --build-reference", { exitCode: 1 });
  }
  if (options.buildReference === true) {
    if (
      options.dryRun === true ||
      options.primary === true ||
      options.pilot === true ||
      options.mock === true ||
      options.seed !== undefined ||
      options.resume !== undefined
    ) {
      program.error(
        "--build-reference cannot be combined with --dry-run, plan selectors, --seed, or --resume",
        { exitCode: 1 },
      );
    }
    const plan = buildDesignerPlanManifest({ runKind: "design_primary" });
    const frozen = buildFrozenReference();
    const cohort = buildCohortReference(plan);
    const referenceDirectory = resolve(
      options.referenceDir ?? join("data", "design", "reference"),
    );
    const galleryHtml = renderDesignReferenceGallery(frozen, cohort);
    const manifest = writeReferenceArtifacts({
      outputDirectory: referenceDirectory,
      frozen,
      cohort,
      galleryHtml,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "build_reference",
          referenceDirectory,
          frozen: {
            outcomes: frozen.outcomes.length,
            hash: frozen.referenceHash,
            coverage: frozen.coverage,
          },
          cohort: {
            outcomes: cohort.outcomes.length,
            hash: cohort.cohortHash,
            coverage: cohort.coverage,
          },
          manifest,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (options.dryRun === true) {
    const runKind = selectedPlan(options);
    const plan = buildDesignerPlanManifest({
      runKind,
      ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
    });
    process.stdout.write(serializeDesignerPlanManifest(plan));
    return 0;
  }
  if (options.resume !== undefined) {
    return executeResume(options);
  }
  if (options.mock === true) {
    return executeMock(options);
  }
  return executeLive(options);
}

export function createProgram(onExitCode?: (code: number) => void): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("AI Puzzle Factory designer CLI.")
    .showHelpAfterError()
    .addHelpText("after", `\n${SCOPE_NOTE}`)
    .option("--dry-run", "print the deterministic designer plan manifest and exit")
    .option("--build-reference", "build the frozen and cohort baseline references")
    .option("--reference-dir <dir>", "reference output directory (default: data/design/reference)")
    .option("--primary", "select the 100-assignment primary plan")
    .option("--pilot", "select the 20-assignment pilot plan")
    .option("--mock", "run the 300-candidate offline mock cohort (or select the mock plan with --dry-run)")
    .option("--seed <seed>", "restate the fixed root seed for the selected plan kind")
    .option("--resume <run-id>", "resume a designer run")
    .option("--live", "authorization-gated live execution")
    .option("--allow-paid", "acknowledge paid execution")
    .option("--max-cost <usd>", "run budget cap")
    .option("--preflight-max-cost <usd>", "separate pilot probe budget cap (default: 0.50)")
    .option("--protocol <hash>", "frozen protocol hash required for --primary --live")
    .option("--routing-confirmation <file>", "operator routing confirmation JSON")
    .option("--ack-budget-increase", "acknowledge a budget cap increase on resume")
    .option("--operator <name>", "operator identity for cap changes")
    .option("--db <path>", "SQLite database (default: data/experiment.sqlite)")
    .option("--concurrency <1|2>", "worker concurrency (default: 2)")
    .option("--model <slug>", "designer model (or DESIGNER_MODEL)")
    .option("--max-output-tokens <n>", "maximum output tokens (default: 8192)")
    .option("--reservation <usd>", "conservative per-call reservation (default: 0.01)")
    .option("--run-id <uuid>", "explicit run ID for a new execution")
    .option("--reviewer", "rejected: reviewer flags are not part of the designer protocol")
    .option("--calibration", "rejected: calibration flags are not part of the designer protocol")
    .action(async (options: DesignOptions) => {
      try {
        const code = await handleOptions(program, options);
        onExitCode?.(code);
      } catch (error) {
        process.stderr.write(
          `error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        onExitCode?.(1);
        program.error("designer execution failed", { exitCode: 1 });
      }
    });
  return program;
}

export async function main(
  argv: readonly string[] = process.argv,
): Promise<number> {
  let exitCode = 0;
  const program = createProgram((code) => {
    exitCode = code;
  }).exitOverride();
  try {
    await program.parseAsync([...argv]);
    return exitCode;
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
