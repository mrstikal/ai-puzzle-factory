import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
  canFreezeProtocol,
  storeFrozenProtocol,
  type FreezeProtocolEvidence,
} from "../experiment/freeze.js";
import {
  decideFinal,
  type FinalDecisionEvidence,
} from "../reporting/decision.js";
import {
  acquireWriterLock,
  migrate,
  openDatabase,
} from "../storage/database.js";

export const PROGRAM_NAME = "freeze";

interface FreezeOptions {
  readonly evidence?: string;
  readonly smoke?: string;
  readonly calibration?: string;
  readonly maxRunCost?: string;
  readonly operator?: string;
  readonly db?: string;
}

interface EvidenceBundle {
  readonly freeze?: FreezeProtocolEvidence;
  readonly freezeEvidence?: FreezeProtocolEvidence;
  readonly final?: FinalDecisionEvidence;
  readonly finalEvidence?: FinalDecisionEvidence;
}

function loadBundle(path: string): EvidenceBundle {
  return JSON.parse(readFileSync(path, "utf8")) as EvidenceBundle;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      "Validate a protocol-freeze evidence bundle and optionally evaluate the final business decision.",
    )
    .showHelpAfterError()
    .option("--evidence <path>", "JSON bundle containing freeze and optional final evidence")
    .option("--smoke <run-id>", "smoke run ID (DB wiring arrives in later phases)")
    .option("--calibration <id>", "calibration ID (DB wiring arrives in later phases)")
    .option("--max-run-cost <usd>", "authorized primary cap override")
    .option("--operator <name>", "operator identity for a cap override", "freeze-cli")
    .option("--db <path>", "optional SQLite path to persist a successful frozen protocol")
    .action(async (options: FreezeOptions) => {
      if (options.evidence === undefined) {
        program.error(
          "--evidence <path> is required in P43; live DB/provenance wiring arrives in P44/P48",
          { exitCode: 1 },
        );
        return;
      }
      const bundle = loadBundle(options.evidence);
      const freezeEvidence = bundle.freeze ?? bundle.freezeEvidence;
      if (freezeEvidence === undefined) {
        program.error("evidence bundle has no freeze/freezeEvidence object", {
          exitCode: 1,
        });
        return;
      }
      const withCap =
        options.maxRunCost === undefined
          ? freezeEvidence
          : {
              ...freezeEvidence,
              authorizedCapUsd: options.maxRunCost,
              capAmendments: [
                ...(freezeEvidence.capAmendments ?? []),
                {
                  at: new Date().toISOString(),
                  fromUsd: freezeEvidence.authorizedCapUsd,
                  toUsd: options.maxRunCost,
                  operator: options.operator ?? "freeze-cli",
                },
              ],
            };
      const freeze = canFreezeProtocol(withCap);
      const futureOptions =
        options.smoke !== undefined || options.calibration !== undefined
          ? [
              "P43 does not collect --smoke/--calibration evidence; the supplied JSON bundle is authoritative until P44/P48/P49.",
            ]
          : [];
      let stored = false;
      if (freeze.ok && freeze.frozen !== null && options.db !== undefined) {
        const db = openDatabase(options.db);
        let lock: Awaited<ReturnType<typeof acquireWriterLock>> | null = null;
        try {
          migrate(db);
          lock = await acquireWriterLock(options.db);
          storeFrozenProtocol(db, freeze.frozen);
          stored = true;
        } finally {
          db.close();
          try {
            await lock?.release();
          } catch {
            // A compromised lock may already be gone; preserve the persistence result.
          }
        }
      }
      const finalEvidence = bundle.final ?? bundle.finalEvidence;
      const decision =
        freeze.ok && finalEvidence !== undefined
          ? decideFinal(finalEvidence)
          : null;
      process.stdout.write(
        `${JSON.stringify(
          {
            freeze: {
              ok: freeze.ok,
              failed: freeze.failed,
              caveats: [...freeze.caveats, ...futureOptions],
              frozen: freeze.frozen,
              stored,
            },
            decision,
          },
          null,
          2,
        )}\n`,
      );
      if (!freeze.ok) {
        throw new Error("protocol freeze validation failed");
      }
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
