import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";

export const PROGRAM_NAME = "experiment";

const SCOPE_NOTE = [
  "Availability (P01 toolchain bootstrap):",
  "  --help                 show this help and exit",
  "  no other mode exists   offline manifests, generation, persistence and",
  "                         paid execution arrive in later phases",
].join("\n");

export function createProgram(): Command {
  return new Command()
    .name(PROGRAM_NAME)
    .description("AI Puzzle Factory experiment CLI.")
    .showHelpAfterError()
    .addHelpText("after", `\n${SCOPE_NOTE}`)
    .action(() => {
      throw new Error(
        "no experiment execution mode is implemented yet; only --help is available in P01",
      );
    });
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
