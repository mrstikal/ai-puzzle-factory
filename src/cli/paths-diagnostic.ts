import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import { Command, CommanderError } from "commander";
import {
  createBudgetAccount,
  getBudgetSummary,
  normalizeUsd,
} from "../ai/budget.js";
import { readLiveEnvironment } from "../ai/config.js";
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
  buildPathsDiagnosticAssets,
  buildPathsDiagnosticRequests,
  runPathsDiagnostic,
  writePathsDiagnosticArtifacts,
} from "../calibration/paths-diagnostic.js";
import { buildPathsPilotPackV2 } from "../calibration/fixtures.js";
import {
  acquireWriterLock,
  migrate,
  openDatabase,
} from "../storage/database.js";

interface DiagnosticOptions {
  readonly allowPaid?: boolean;
  readonly maxCost?: string;
  readonly maxActualCost?: string;
  readonly model?: string;
  readonly variants?: string;
  readonly out?: string;
}

function route(
  report: PreflightReport,
  role: RolePreflightRequest["role"],
): ResolvedRoute {
  const resolved =
    report.roles.find((entry) => entry.role === role)?.resolved ?? null;
  if (resolved === null) {
    throw new Error(`preflight did not resolve a route for ${role}`);
  }
  return resolved;
}

async function runDiagnostic(
  program: Command,
  options: DiagnosticOptions,
): Promise<number> {
  if (options.allowPaid !== true) {
    program.error("paths diagnostic requires --allow-paid", { exitCode: 1 });
  }
  if (options.maxCost === undefined) {
    program.error("paths diagnostic requires --max-cost <usd>", {
      exitCode: 1,
    });
  }
  let maxCostUsd: string;
  let maxActualCostUsd: string;
  try {
    maxCostUsd = normalizeUsd(options.maxCost, "--max-cost");
    maxActualCostUsd = normalizeUsd(
      options.maxActualCost ?? "0.05",
      "--max-actual-cost",
    );
  } catch (error) {
    program.error(
      error instanceof Error ? error.message : "invalid cost argument",
      { exitCode: 1 },
    );
    return 1;
  }
  if (new Decimal(maxCostUsd).lte(0)) {
    program.error("--max-cost must be positive", { exitCode: 1 });
    return 1;
  }
  if (new Decimal(maxCostUsd).gt("0.05")) {
    program.error(
      "paths diagnostic admission cap must not exceed the current remaining envelope of USD 0.05",
      { exitCode: 1 },
    );
    return 1;
  }
  if (new Decimal(maxActualCostUsd).lte(0)) {
    program.error("--max-actual-cost must be positive", { exitCode: 1 });
    return 1;
  }
  if (new Decimal(maxActualCostUsd).gt("0.05")) {
    program.error(
      "paths diagnostic actual-cost guard must not exceed the current remaining envelope of USD 0.05",
      { exitCode: 1 },
    );
    return 1;
  }
  const model = options.model ?? "anthropic/claude-sonnet-5.5";
  const config = readLiveEnvironment(process.env);
  const catalog = await fetchCatalogForModels({
    modelIds: [model],
    apiKey: config.apiKey,
  });
  const roleRequests: RolePreflightRequest[] = [
    { role: "blind_text", model },
    { role: "blind_vision", model },
  ];
  const report = runPreflightOnCatalog(catalog, roleRequests, {
    mode: "live",
    allowConditionalOverrides: true,
    allowImageContextReserve: true,
  });
  if (!report.ok) {
    process.stdout.write(
      `${report.failures
        .map(
          (failure) =>
            `preflight failure ${failure.role ?? "global"} ${failure.code}: ${failure.detail}`,
        )
        .join("\n")}\n`,
    );
    return 1;
  }
  const routes = {
    vision: route(report, "blind_vision"),
    text: route(report, "blind_text"),
  };
  const built = buildPathsPilotPackV2();
  const entry = built.fixtures.find(
    (candidate) => candidate.fixture.fixtureId === "cal-paths-13",
  );
  if (entry === undefined) {
    throw new Error("missing cal-paths-13 in the paths-medium pack");
  }
  const requested = (options.variants ?? "A,B,C,D")
    .split(",")
    .map((variant) => variant.trim().toUpperCase())
    .filter((variant) => variant !== "");
  const validVariants = ["A", "B", "C", "D"];
  if (
    requested.length === 0 ||
    requested.some((variant) => !validVariants.includes(variant))
  ) {
    program.error("--variants must be a non-empty subset of A,B,C,D", {
      exitCode: 1,
    });
    return 1;
  }
  const selected = new Set(requested);
  const assets = buildPathsDiagnosticAssets(entry);
  const prepared = buildPathsDiagnosticRequests({
    fixture: entry.fixture,
    entry,
    assets,
    routes,
  }).filter((call) => selected.has(call.variant));
  if (prepared.length !== selected.size) {
    throw new Error(
      `paths diagnostic requested ${selected.size} variants, prepared ${prepared.length}`,
    );
  }
  const diagnosticId = randomUUID();
  const outputRoot = resolve(options.out ?? "data/paths-diagnostic");
  const directory = join(outputRoot, diagnosticId);
  if (existsSync(directory)) {
    throw new Error(`diagnostic directory already exists: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, "diagnostic.sqlite");
  const db = openDatabase(dbPath);
  let lock: Awaited<ReturnType<typeof acquireWriterLock>> | null = null;
  let result: Awaited<ReturnType<typeof runPathsDiagnostic>>;
  let budgetSummary: unknown;
  const startedAt = new Date().toISOString();
  const accountId = `paths-diagnostic-${diagnosticId}`;
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
    result = await runPathsDiagnostic({
      diagnosticId,
      built,
      fixtureId: "cal-paths-13",
      routes,
      assets,
      prepared,
      db,
      accountId,
      apiKey: config.apiKey,
      transport,
      maxActualCostUsd,
    });
    budgetSummary = getBudgetSummary(db);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // The database and any side files remain part of the manifest.
    }
  } finally {
    db.close();
    try {
      await lock?.release();
    } catch {
      // A compromised lock may already be gone; preserve the result.
    }
  }
  const written = writePathsDiagnosticArtifacts({
    directory,
    result,
    assets,
    prepared,
    expected: entry.fixture.expected,
    packHash: built.pack.packHash,
    authorizedCapUsd: maxCostUsd,
    maxActualCostUsd,
    databasePath: dbPath,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "paths-diagnostic",
        diagnosticId,
        fixtureId: "cal-paths-13",
        model,
        variantsRequested: [...selected],
        status: result.status,
        classification: result.classification,
        variants: result.variants.map((variant) => ({
          variant: variant.variant,
          description: variant.description,
          outcome: variant.outcome,
          answerStatus: variant.answerStatus,
          chosenOption: variant.chosenOption,
          issueCodes: variant.issueCodes,
          schemaValid: variant.schemaValid,
          error: variant.error,
          provider: variant.provider,
          costUsd: variant.costUsd,
          costStatus: variant.costStatus,
        })),
        cost: {
          knownUsd: result.knownCostUsd,
          unknownCalls: result.unknownCalls,
        },
        authorizedCapUsd: maxCostUsd,
        maxActualCostUsd,
        budgetSummary,
        diagnosticPath: written.diagnosticPath,
        manifestPath: written.manifestPath,
        manifestHash: written.manifestHash,
        calibrationEligible: false,
        freezeEligible: false,
        result: result.status === "completed" ? "ok" : "failed",
      },
      null,
      2,
    )}\n`,
  );
  return result.status === "completed" ? 0 : 1;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("paths-diagnostic")
    .description(
      "Run the separate four-variant paths closed-edge diagnostic; never calibration evidence.",
    )
    .showHelpAfterError()
    .option("--allow-paid", "acknowledge the paid diagnostic calls")
    .option("--max-cost <usd>", "admission cap; must not exceed the current remaining envelope of USD 0.05")
    .option(
      "--max-actual-cost <usd>",
      "hard actual-cost guard; default USD 0.05 and never above the current remaining envelope",
      "0.05",
    )
    .option("--model <id>", "diagnostic model", "anthropic/claude-sonnet-5.5")
    .option("--variants <list>", "comma-separated subset of A,B,C,D", "A,B,C,D")
    .option("--out <dir>", "output root", "data/paths-diagnostic")
    .action(async (options: DiagnosticOptions) => {
      process.exitCode = await runDiagnostic(program, options);
    });
  return program;
}

export async function main(
  argv: readonly string[] = process.argv,
): Promise<number> {
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

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
