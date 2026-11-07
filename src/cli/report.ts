import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { writeHtmlReport } from "../reporting/html.js";
import { computeRunMetrics } from "../reporting/metrics.js";
import { openDatabase } from "../storage/database.js";

export const PROGRAM_NAME = "report";

interface ReportOptions {
  readonly run?: string;
  readonly db?: string;
  readonly calibrationRoot?: string;
}

function findCalibrationLiveArtifact(
  runId: string,
  root: string,
): string | null {
  if (!existsSync(root)) {
    return null;
  }
  for (const packHash of readdirSync(root)) {
    const candidate = join(root, packHash, "live", runId, "calibration.json");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function createReportProgram(): Command {
  return new Command()
    .name(PROGRAM_NAME)
    .description("Print exact metrics for a committed run and write its offline HTML gallery.")
    .requiredOption("--run <run-id>", "run UUID to report")
    .option("--db <path>", "SQLite path (default: data/experiment.sqlite)")
    .option(
      "--calibration-root <dir>",
      "calibration artifact root (default: data/calibration); use the live --out root",
    )
    .showHelpAfterError()
    .action((options: ReportOptions) => {
      if (options.run === undefined) {
        throw new CommanderError(1, "commander.missingArgument", "--run is required");
      }
      const preflightPath = resolve(
        "data",
        "preflight",
        options.run,
        "preflight.json",
      );
      if (existsSync(preflightPath)) {
        const artifact = JSON.parse(
          readFileSync(preflightPath, "utf8"),
        ) as Record<string, unknown>;
        process.stdout.write(
          `${JSON.stringify({ mode: "preflight", artifactPath: preflightPath, ...artifact }, null, 2)}\n`,
        );
        return;
      }
      const calibrationPath = findCalibrationLiveArtifact(
        options.run,
        resolve(options.calibrationRoot ?? join("data", "calibration")),
      );
      if (calibrationPath !== null) {
        const artifact = JSON.parse(
          readFileSync(calibrationPath, "utf8"),
        ) as Record<string, unknown>;
        process.stdout.write(
          `${JSON.stringify({ mode: "calibration_live", artifactPath: calibrationPath, ...artifact }, null, 2)}\n`,
        );
        return;
      }
      const db = openDatabase(options.db ?? "data/experiment.sqlite");
      try {
        const metrics = computeRunMetrics(db, options.run);
        process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
        const html = writeHtmlReport(db, options.run);
        process.stderr.write(`report.html ${html.htmlPath}\n`);
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
