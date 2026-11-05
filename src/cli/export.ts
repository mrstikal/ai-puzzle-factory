import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { exportRun, type ExportFormat } from "../reporting/export.js";
import { openDatabase } from "../storage/database.js";

export const PROGRAM_NAME = "export";

interface ExportCliOptions {
  readonly run?: string;
  readonly format?: string;
  readonly db?: string;
}

export function createExportProgram(): Command {
  return new Command()
    .name(PROGRAM_NAME)
    .description("Write controlled JSONL/CSV/assets exports for a committed run.")
    .requiredOption("--run <run-id>", "run UUID to export")
    .option("--format <format>", "all, csv, or jsonl (default: all)", "all")
    .option("--db <path>", "SQLite path (default: data/experiment.sqlite)")
    .showHelpAfterError()
    .action((options: ExportCliOptions) => {
      if (options.run === undefined) {
        throw new CommanderError(1, "commander.missingArgument", "--run is required");
      }
      const format = options.format ?? "all";
      if (format !== "all" && format !== "csv" && format !== "jsonl") {
        throw new CommanderError(
          1,
          "commander.invalidArgument",
          `--format must be all, csv, or jsonl`,
        );
      }
      const db = openDatabase(options.db ?? "data/experiment.sqlite");
      try {
        const result = exportRun(db, options.run, {
          format: format as ExportFormat,
        });
        process.stdout.write(
          [
            `run ${result.runId}`,
            `directory ${result.directory}`,
            ...result.files.map((file) => `file ${file}`),
            "",
          ].join("\n"),
        );
      } finally {
        db.close();
      }
    });
}

export async function exportMain(
  argv: readonly string[] = process.argv,
): Promise<number> {
  const program = createExportProgram().exitOverride();
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
  process.exitCode = await exportMain();
}
