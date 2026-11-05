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
import { RunCancellation } from "../runner/cancel.js";
import {
  DEFAULT_CONCURRENCY,
  assertConcurrency,
  type Concurrency,
} from "../runner/workers.js";

export const PROGRAM_NAME = "experiment";

const SCOPE_NOTE = [
  "Availability (P35):",
  "  --dry-run              print the deterministic PlanManifest and exit",
  "  --full | --smoke       select the 200-slot or 20-slot plan (default: full)",
  "  --mock | --live        evidence mode; P35 executes only --smoke --mock",
  "  --seed <seed>          restate the fixed root seed for the selected run kind",
  "  --concurrency <1|2>    candidate workers and max in-flight requests (default: 2)",
  "  --max-cost <usd>       smoke mock budget cap (default: 0; mock calls are nonbilling)",
  "  --db <path>            SQLite path (default: data/experiment.sqlite)",
  "  --resume               rejected until P36",
  "  P35 writes a bounded-concurrency smoke mock run; SIGINT drains and leaves a resumable checkpoint",
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
  readonly concurrency?: string;
}

function printSummary(result: RunSmokeMockResult, dbPath: string): void {
  const { summary } = result;
  const calls = REQUEST_ROLES.map(
    (role) => `${role}=${summary.callsByRole[role]}`,
  ).join(" ");
  const lines = [
    `run ${result.runId}`,
    `database ${dbPath}`,
    `status ${summary.status}`,
    `slots ${summary.terminalSlots}/${summary.slots} terminal`,
    `verdicts approved=${summary.verdicts.approved} rejected=${summary.verdicts.rejected} inconclusive=${summary.verdicts.inconclusive} generation_error=${summary.verdicts.generation_error}`,
    `calls ${calls}`,
    `attempts ${summary.attempts} unknown=${summary.unknownAttempts}`,
    `cost status=${summary.cost.costStatus} actual=${summary.cost.actualCostUsd ?? "unknown"}`,
    `budget known=${summary.budget.knownActualUsd} reserved=${summary.budget.reservedUsd} unknown=${summary.budget.unknownExposureUsd}`,
  ];
  if (summary.barrier === null) {
    lines.push("barrier not-run");
  } else {
    const duplicates =
      summary.barrier.exactDuplicates +
      summary.barrier.specDuplicates +
      summary.barrier.structuralDuplicates;
    lines.push(
      `barrier unique=${summary.barrier.uniqueCandidates} owners=${summary.barrier.owners} near=${summary.barrier.nearSuspectedCandidates} duplicates=${duplicates}`,
    );
  }
  if (summary.cancellation !== null) {
    lines.push(
      `cancellation reason=${summary.cancellation.reason} phase=${summary.cancellation.phase} drained=${summary.cancellation.drained} marked_uncertain=${summary.cancellation.markedUncertain}`,
    );
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

async function handleOptions(
  program: Command,
  options: ExperimentOptions,
): Promise<number> {
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
      "live execution is not implemented; P35 supports offline --smoke --mock",
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
    return 0;
  }

  if (options.smoke !== true) {
    program.error("P35 execution supports only --smoke --mock", {
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
  let concurrency: Concurrency;
  try {
    concurrency = assertConcurrency(
      Number(options.concurrency ?? DEFAULT_CONCURRENCY),
    );
  } catch (error) {
    program.error(
      error instanceof Error ? error.message : "concurrency must be 1 or 2",
      { exitCode: 1 },
    );
  }
  buildPlanManifest({
    runKind: "smoke",
    ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
  });
  const dbPath = options.db ?? join("data", "experiment.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const cancellation = new RunCancellation();
  const onSigint = (): void => {
    cancellation.stop("sigint");
  };
  process.on("SIGINT", onSigint);
  let lock: Awaited<ReturnType<typeof acquireWriterLock>> | null = null;
  try {
    migrate(db);
    lock = await acquireWriterLock(dbPath, {
      onCompromised: (error) => {
        cancellation.stop("writer_lock_compromised", error);
      },
    });
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
      concurrency,
      cancellation,
      ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
    });
    printSummary(result, dbPath);
    return result.status === "cancelled" ? 130 : 0;
  } finally {
    process.off("SIGINT", onSigint);
    db.close();
    if (lock !== null) {
      try {
        await lock.release();
      } catch {
        // A compromised lock may already be gone; preserve the run result.
      }
    }
  }
}

export function createProgram(onExitCode?: (code: number) => void): Command {
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
    .option("--concurrency <1|2>", "candidate workers (default: 2)")
    .option("--max-cost <usd>", "smoke mock budget cap (default: 0)")
    .option("--db <path>", "SQLite path (default: data/experiment.sqlite)")
    .action(async (options: ExperimentOptions) => {
      const code = await handleOptions(program, options);
      onExitCode?.(code);
    });
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
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
