import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
  canFreezeProtocol,
  storeFrozenProtocol,
  type FreezeProtocolEvidence,
} from "../experiment/freeze.js";
import {
  buildProvenanceSnapshot,
  createProvenanceProviderFromArchive,
  provenanceConfigurationFromSnapshot,
  summarizeProvenanceSnapshot,
  writeProvenanceArchive,
  type LoadedProvenance,
} from "../experiment/provenance.js";
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
  readonly provenance?: string;
  readonly archiveProvenance?: string;
  readonly verifyProvenance?: string;
  readonly sourceRoot?: string;
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

function configuredSecrets(): readonly string[] {
  const value = process.env.OPENROUTER_API_KEY;
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function provenanceBuildOptions(rootDirectory: string): Parameters<
  typeof buildProvenanceSnapshot
>[0] {
  const forbiddenSecrets = configuredSecrets();
  return {
    rootDirectory,
    ...(forbiddenSecrets.length === 0 ? {} : { forbiddenSecrets }),
  };
}

function provenanceVerifyOptions(rootDirectory: string): {
  readonly rootDirectory: string;
  readonly forbiddenSecrets?: readonly string[];
} {
  const forbiddenSecrets = configuredSecrets();
  return {
    rootDirectory,
    ...(forbiddenSecrets.length === 0 ? {} : { forbiddenSecrets }),
  };
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      "Validate a protocol-freeze evidence bundle, verify source provenance, and optionally evaluate the final business decision.",
    )
    .showHelpAfterError()
    .option("--evidence <path>", "JSON bundle containing freeze and optional final evidence")
    .option("--smoke <run-id>", "smoke run ID (DB wiring arrives in later phases)")
    .option("--calibration <id>", "calibration ID (DB wiring arrives in later phases)")
    .option("--max-run-cost <usd>", "authorized primary cap override")
    .option("--operator <name>", "operator identity for a cap override", "freeze-cli")
    .option("--db <path>", "optional SQLite path to persist a successful frozen protocol")
    .option(
      "--provenance <dir>",
      "verified source provenance archive used as the freeze provider",
    )
    .option(
      "--archive-provenance <dir>",
      "write a hashed source/prompt/schema/font provenance archive and exit",
    )
    .option(
      "--verify-provenance <dir>",
      "verify a provenance archive against the current source tree and exit",
    )
    .option(
      "--source-root <dir>",
      "source tree inspected for provenance (default: current directory)",
    )
    .action(async (options: FreezeOptions) => {
      const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
      if (
        options.archiveProvenance !== undefined &&
        options.verifyProvenance !== undefined
      ) {
        program.error(
          "--archive-provenance and --verify-provenance are mutually exclusive",
          { exitCode: 1 },
        );
        return;
      }
      if (options.archiveProvenance !== undefined) {
        if (
          options.evidence !== undefined ||
          options.smoke !== undefined ||
          options.calibration !== undefined ||
          options.maxRunCost !== undefined ||
          options.db !== undefined ||
          options.provenance !== undefined
        ) {
          program.error(
            "--archive-provenance cannot be combined with evidence, smoke, calibration, cap, database, or provenance options",
            { exitCode: 1 },
          );
          return;
        }
        const snapshot = buildProvenanceSnapshot(
          provenanceBuildOptions(sourceRoot),
        );
        const written = writeProvenanceArchive(snapshot, {
          rootDirectory: sourceRoot,
          archiveDirectory: options.archiveProvenance,
        });
        process.stdout.write(
          `${JSON.stringify(
            {
              provenance: {
                ok: true,
                directory: written.directory,
                manifestPath: written.manifestPath,
                schemasPath: written.schemasPath,
                fileCopies: written.files.length,
                summary: summarizeProvenanceSnapshot(snapshot),
                configuration: provenanceConfigurationFromSnapshot(snapshot),
              },
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (options.verifyProvenance !== undefined) {
        if (
          options.evidence !== undefined ||
          options.smoke !== undefined ||
          options.calibration !== undefined ||
          options.maxRunCost !== undefined ||
          options.db !== undefined ||
          options.provenance !== undefined
        ) {
          program.error(
            "--verify-provenance cannot be combined with evidence, smoke, calibration, cap, database, or provenance options",
            { exitCode: 1 },
          );
          return;
        }
        const loaded = createProvenanceProviderFromArchive({
          archiveDirectory: options.verifyProvenance,
          ...provenanceVerifyOptions(sourceRoot),
        });
        process.stdout.write(
          `${JSON.stringify(
            {
              provenance: {
                ok: loaded.verification.ok,
                archive: options.verifyProvenance,
                failures: loaded.verification.failures,
                summary: summarizeProvenanceSnapshot(loaded.snapshot),
                configuration: provenanceConfigurationFromSnapshot(
                  loaded.snapshot,
                ),
              },
            },
            null,
            2,
          )}\n`,
        );
        if (!loaded.verification.ok) {
          throw new Error("provenance archive does not match the current source tree");
        }
        return;
      }
      if (options.evidence === undefined) {
        program.error(
          "--evidence <path> is required unless --archive-provenance is used; live DB wiring for smoke/calibration arrives in P48/P49",
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
      let loadedProvenance: LoadedProvenance | null = null;
      if (options.provenance !== undefined) {
        loadedProvenance = createProvenanceProviderFromArchive({
          archiveDirectory: options.provenance,
          ...provenanceVerifyOptions(sourceRoot),
        });
        if (!loadedProvenance.verification.ok) {
          process.stdout.write(
            `${JSON.stringify(
              {
                provenance: {
                  ok: false,
                  archive: options.provenance,
                  failures: loadedProvenance.verification.failures,
                  summary: summarizeProvenanceSnapshot(
                    loadedProvenance.snapshot,
                  ),
                },
                freeze: {
                  ok: false,
                  failed: [],
                  caveats: [],
                  frozen: null,
                  stored: false,
                },
                decision: null,
              },
              null,
              2,
            )}\n`,
          );
          throw new Error("provenance archive does not match the current source tree");
        }
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
      const freeze =
        loadedProvenance === null
          ? canFreezeProtocol(withCap)
          : canFreezeProtocol(withCap, loadedProvenance.provider);
      const futureOptions =
        options.smoke !== undefined || options.calibration !== undefined
          ? [
              "P44 does not collect --smoke/--calibration evidence; the supplied JSON bundle is authoritative until P48/P49.",
            ]
          : [];
      const provenanceCaveats =
        loadedProvenance === null
          ? [
              "provenance was read from the evidence bundle; use --provenance <archive> to verify the current source tree",
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
            provenance:
              loadedProvenance === null
                ? null
                : {
                    ok: true,
                    archive: options.provenance,
                    summary: summarizeProvenanceSnapshot(
                      loadedProvenance.snapshot,
                    ),
                    configuration: provenanceConfigurationFromSnapshot(
                      loadedProvenance.snapshot,
                    ),
                  },
            freeze: {
              ok: freeze.ok,
              failed: freeze.failed,
              caveats: [
                ...freeze.caveats,
                ...futureOptions,
                ...provenanceCaveats,
              ],
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
