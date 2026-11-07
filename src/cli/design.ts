import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
  buildDesignerPlanManifest,
  serializeDesignerPlanManifest,
} from "../design/assignments.js";
import type { DesignerRunKind } from "../domain/design.js";

export const PROGRAM_NAME = "designer";

const SCOPE_NOTE = [
  "Availability (P46):",
  "  --dry-run              print the deterministic DesignerPlanManifest and exit (implemented offline)",
  "  --primary              select the 100-assignment primary plan (default for --dry-run)",
  "  --pilot                select the 20-assignment pilot plan",
  "  --mock                 select the 100-assignment synthetic mock plan",
  "  --seed <seed>          restate the fixed root seed for the selected plan kind",
  "  Mock/pilot/full execution is not implemented in P46; P50/P51 add simulated and live execution.",
  "  --live, --allow-paid, --max-cost, and --protocol are authorization-gated and not implemented in P46.",
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
  readonly protocol?: string;
  readonly reviewer?: boolean;
  readonly calibration?: boolean;
}

function handleOptions(program: Command, options: DesignOptions): number {
  if (options.reviewer === true || options.calibration === true) {
    program.error(
      "reviewer and calibration flags are not part of the designer protocol",
      { exitCode: 1 },
    );
  }
  if (
    options.live === true ||
    options.allowPaid === true ||
    options.maxCost !== undefined ||
    options.protocol !== undefined
  ) {
    program.error(
      "live/paid execution is not implemented in P46; P51 executes the frozen designer protocol",
      { exitCode: 1 },
    );
  }
  if (options.dryRun !== true) {
    program.error(
      "P46 implements only --dry-run; mock/pilot/full execution arrives in P50/P51",
      { exitCode: 1 },
    );
  }
  const selected = [options.primary, options.pilot, options.mock].filter(
    (value) => value === true,
  ).length;
  if (selected > 1) {
    program.error("--primary, --pilot, and --mock are mutually exclusive", {
      exitCode: 1,
    });
  }
  const runKind: DesignerRunKind =
    options.pilot === true
      ? "design_pilot"
      : options.mock === true
        ? "design_mock"
        : "design_primary";
  const plan = buildDesignerPlanManifest({
    runKind,
    ...(options.seed === undefined ? {} : { rootSeed: options.seed }),
  });
  process.stdout.write(serializeDesignerPlanManifest(plan));
  return 0;
}

export function createProgram(onExitCode?: (code: number) => void): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("AI Puzzle Factory designer CLI.")
    .showHelpAfterError()
    .addHelpText("after", `\n${SCOPE_NOTE}`)
    .option("--dry-run", "print the deterministic designer plan manifest and exit")
    .option("--primary", "select the 100-assignment primary plan")
    .option("--pilot", "select the 20-assignment pilot plan")
    .option("--mock", "select the 100-assignment synthetic mock plan")
    .option("--seed <seed>", "restate the fixed root seed for the selected plan kind")
    .option("--live", "authorization-gated live path (not implemented in P46)")
    .option("--allow-paid", "acknowledge paid execution (not implemented in P46)")
    .option("--max-cost <usd>", "live budget cap (not implemented in P46)")
    .option("--protocol <hash>", "frozen protocol hash (not implemented in P46)")
    .option("--reviewer", "rejected: reviewer flags are not part of the designer protocol")
    .option("--calibration", "rejected: calibration flags are not part of the designer protocol")
    .action((options: DesignOptions) => {
      const code = handleOptions(program, options);
      onExitCode?.(code);
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
