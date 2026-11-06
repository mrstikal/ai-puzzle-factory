import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { buildCalibrationPack } from "../calibration/fixtures.js";
import { writeCalibrationPack } from "../calibration/pack.js";

export const PROGRAM_NAME = "calibration";

interface CalibrationOptions {
  readonly prepare?: boolean;
  readonly out?: string;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("Build the offline held-out calibration fixture pack and pending labels.")
    .showHelpAfterError()
    .option("--prepare", "build the 40-item fixture pack, gallery, and pending label template")
    .option("--out <dir>", "output root for pack versions (default: data/calibration)")
    .action((options: CalibrationOptions) => {
      if (options.prepare !== true) {
        program.error("--prepare is required in P40", { exitCode: 1 });
      }
      const built = buildCalibrationPack();
      const paths = writeCalibrationPack(built, options.out ?? "data/calibration");
      const sound = built.pack.fixtures.filter(
        (fixture) => fixture.variant === "sound",
      ).length;
      const defective = built.pack.fixtures.length - sound;
      process.stdout.write(
        [
          `pack_hash: ${paths.packHash}`,
          `directory: ${paths.directory}`,
          `fixtures: ${built.pack.fixtures.length}`,
          `sound: ${sound}`,
          `defective: ${defective}`,
          `pack: ${paths.packPath}`,
          `labels: ${paths.labelsPath}`,
          `gallery: ${paths.galleryPath}`,
        ].join("\n") + "\n",
      );
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
