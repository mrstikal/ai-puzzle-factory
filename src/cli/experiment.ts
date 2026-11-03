import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import type { RunKind } from "../domain/experiment.js";
import { buildPlanManifest, serializePlanManifest } from "../experiment/planner.js";

export const PROGRAM_NAME = "experiment";

const SCOPE_NOTE = [
  "Availability (P02):",
  "  --dry-run              print the deterministic PlanManifest and exit",
  "  --full | --smoke       select the 200-slot or 20-slot plan (default: full)",
  "  --mock | --live        evidence mode; only offline mock dry-run is implemented",
  "  --seed <seed>          restate the fixed root seed for the selected run kind",
  "  no generation, database write, model call, or image rendering is performed",
].join("\n");

interface ExperimentOptions {
  readonly dryRun?: boolean;
  readonly full?: boolean;
  readonly smoke?: boolean;
  readonly mock?: boolean;
  readonly live?: boolean;
  readonly seed?: string;
}

function handleOptions(program: Command, options: ExperimentOptions): void {
  if (options.full === true && options.smoke === true) {
    program.error("--full and --smoke are mutually exclusive", { exitCode: 1 });
  }
  if (options.mock === true && options.live === true) {
    program.error("--mock and --live are mutually exclusive", { exitCode: 1 });
  }
  if (options.live === true) {
    program.error(
      "live execution is not implemented; P02 supports offline --dry-run only",
      { exitCode: 1 },
    );
  }
  if (options.dryRun !== true) {
    program.error(
      "no experiment execution mode is implemented yet; use --dry-run",
      { exitCode: 1 },
    );
  }

  const runKind: RunKind = options.smoke === true ? "smoke" : "full";
  const plan = buildPlanManifest({
    runKind,
    ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
  });
  process.stdout.write(serializePlanManifest(plan));
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
    .option("--smoke", "plan the 20-slot smoke cohort")
    .option("--mock", "use synthetic mock evidence (default)")
    .option("--live", "use live provider evidence (not implemented)")
    .option("--seed <seed>", "restate the fixed root seed for the selected run kind")
    .action((options: ExperimentOptions) => {
      handleOptions(program, options);
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
