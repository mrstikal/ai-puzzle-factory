import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { computeRunMetrics } from "../reporting/metrics.js";
import { openDatabase } from "../storage/database.js";

export const PROGRAM_NAME = "report";

interface ReportOptions {
  readonly run?: string;
  readonly db?: string;
}

export function createReportProgram(): Command {
  return new Command()
    .name(PROGRAM_NAME)
    .description("Print exact metrics for a committed run as JSON.")
    .requiredOption("--run <run-id>", "run UUID to report")
    .option("--db <path>", "SQLite path (default: data/experiment.sqlite)")
    .showHelpAfterError()
    .action((options: ReportOptions) => {
      if (options.run === undefined) {
        throw new CommanderError(1, "commander.missingArgument", "--run is required");
      }
      const db = openDatabase(options.db ?? "data/experiment.sqlite");
      try {
        const metrics = computeRunMetrics(db, options.run);
        process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
      } finally {
        db.close();
      }
    });
}

export async function reportMain(
  argv: readonly string[] = process.argv,
): Promise<number> {
  const program = createReportProgram().exitOverride();
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.exitCode = await reportMain();
}
