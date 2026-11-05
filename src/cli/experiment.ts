import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { createMockTransport } from "../ai/mock.js";
import {
  REQUEST_ROLES,
  UsdSchema,
  type RunKind,
} from "../domain/experiment.js";
import { buildPlanManifest, serializePlanManifest } from "../experiment/planner.js";
import {
  acquireWriterLock,
  migrate,
  openDatabase,
} from "../storage/database.js";
import {
  runSmokeMockExperiment,
  type RunSmokeMockResult,
} from "../runner/run.js";

export const PROGRAM_NAME = "experiment";

const SCOPE_NOTE = [
  "Availability (P34):",
  "  --dry-run              print the deterministic PlanManifest and exit",
  "  --full | --smoke       select the 200-slot or 20-slot plan (default: full)",
  "  --mock | --live        evidence mode; P34 executes only --smoke --mock",
  "  --seed <seed>          restate the fixed root seed for the selected run kind",
  "  --max-cost <usd>       smoke mock budget cap (default: 0; mock calls are nonbilling)",
  "  --db <path>            SQLite path (default: data/experiment.sqlite)",
  "  --resume               rejected until P36",
  "  P34 writes a serial smoke mock run to SQLite; no live, full, report, or gallery",
].join("\n");

interface ExperimentOptions {
  readonly dryRun?: boolean;
  readonly full?: boolean;
  readonly smoke?: boolean;
  readonly mock?: boolean;
  readonly live?: boolean;
  readonly resume?: boolean;
  readonly seed?: string;
  readonly maxCost?: string;
  readonly db?: string;
}

function printSummary(result: RunSmokeMockResult, dbPath: string): void {
  const { summary } = result;
  const calls = REQUEST_ROLES.map(
    (role) => `${role}=${summary.callsByRole[role]}`,
  ).join(" ");
  const duplicates =
    summary.barrier.exactDuplicates +
    summary.barrier.specDuplicates +
    summary.barrier.structuralDuplicates;
  process.stdout.write(
    [
      `run ${result.runId}`,
      `database ${dbPath}`,
      `slots ${summary.terminalSlots}/${summary.slots} terminal`,
      `verdicts approved=${summary.verdicts.approved} rejected=${summary.verdicts.rejected} inconclusive=${summary.verdicts.inconclusive} generation_error=${summary.verdicts.generation_error}`,
      `calls ${calls}`,
      `attempts ${summary.attempts} unknown=${summary.unknownAttempts}`,
      `cost status=${summary.cost.costStatus} actual=${summary.cost.actualCostUsd ?? "unknown"}`,
      `barrier unique=${summary.barrier.uniqueCandidates} owners=${summary.barrier.owners} near=${summary.barrier.nearSuspectedCandidates} duplicates=${duplicates}`,
      "",
    ].join("\n"),
  );
}

async function handleOptions(
  program: Command,
  options: ExperimentOptions,
): Promise<void> {
  if (options.full === true && options.smoke === true) {
    program.error("--full and --smoke are mutually exclusive", { exitCode: 1 });
  }
  if (options.mock === true && options.live === true) {
    program.error("--mock and --live are mutually exclusive", { exitCode: 1 });
  }
  if (options.resume === true) {
    program.error("resume is not implemented until P36", { exitCode: 1 });
  }
  if (options.live === true) {
    program.error(
      "live execution is not implemented; P34 supports offline --smoke --mock",
      { exitCode: 1 },
    );
  }

  const runKind: RunKind = options.smoke === true ? "smoke" : "full";
  if (options.dryRun === true) {
    const plan = buildPlanManifest({
      runKind,
      ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
    });
    process.stdout.write(serializePlanManifest(plan));
    return;
  }

  if (options.smoke !== true) {
    program.error("P34 execution supports only --smoke --mock", {
      exitCode: 1,
    });
  }
  const maxCost = options.maxCost ?? "0";
  const parsedCost = UsdSchema.safeParse(maxCost);
  if (!parsedCost.success) {
    program.error("--max-cost must be a non-negative decimal USD string", {
      exitCode: 1,
    });
  }
  buildPlanManifest({
    runKind: "smoke",
    ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
  });
  const dbPath = options.db ?? join("data", "experiment.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  let lock: Awaited<ReturnType<typeof acquireWriterLock>> | null = null;
  try {
    migrate(db);
    lock = await acquireWriterLock(dbPath);
    const runId = randomUUID();
    const accountId = `smoke-${runId}`;
    const mock = createMockTransport({
      db,
      clock: {
        now: () => new Date(),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      random: () => 0,
    });
    const result = await runSmokeMockExperiment({
      db,
      runId,
      accountId,
      apiKey: "mock-offline-key",
      transport: mock,
      maxCostUsd: maxCost,
      ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
    });
    printSummary(result, dbPath);
  } finally {
    db.close();
    if (lock !== null) {
      await lock.release();
    }
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("AI Puzzle Factory experiment CLI.")
    .showHelpAfterError()
    .addHelpText("after", `\n${SCOPE_NOTE}`)
    .option("--dry-run", "print the deterministic plan manifest and exit")
    .option("--full", "plan the full 200-slot cohort (default)")
    .option("--smoke", "plan or run the 20-slot smoke cohort")
    .option("--mock", "use synthetic mock evidence (default)")
    .option("--live", "use live provider evidence (not implemented)")
    .option("--resume", "resume a run (not implemented until P36)")
    .option("--seed <seed>", "restate the fixed root seed for the selected run kind")
    .option("--max-cost <usd>", "smoke mock budget cap (default: 0)")
    .option("--db <path>", "SQLite path (default: data/experiment.sqlite)")
    .action(async (options: ExperimentOptions) => {
      await handleOptions(program, options);
    });
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync([...argv]);
    return 0;
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
