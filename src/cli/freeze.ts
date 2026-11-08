import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { buildDesignerPlanManifest } from "../design/assignments.js";
import {
  buildCohortReference,
  buildFrozenReference,
  readCohortReference,
  readFrozenReference,
} from "../design/baseline.js";
import {
  buildDesignerConfigurationSnapshot,
  canFreezeDesignerProtocol,
  collectDesignerConfigurationHashes,
  computePilotPerFamilyAiAccepted,
  exportDesignerProtocolFreeze,
  insertDesignerProtocolFreeze,
  readDesignerConfigurationEvent,
  type DesignerBudgetForecast,
} from "../design/freeze.js";
import {
  assertRoutingConfirmationFresh,
  readRoutingConfirmationFile,
} from "../design/routing.js";
import { getDesignerRun } from "../storage/repository.js";
import { loadDesignerCohortMetrics } from "../reporting/design-metrics.js";

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
  readonly design?: string;
  readonly protocolsRoot?: string;
  readonly routingConfirmation?: string;
  readonly totalLogicalCalls?: string;
  readonly maxTransportAttempts?: string;
  readonly reserveUsd?: string;
  readonly model?: string;
  readonly concurrency?: string;
  readonly maxOutputTokens?: string;
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

async function runDesignerFreeze(
  program: Command,
  options: FreezeOptions,
): Promise<void> {
  if (options.design === undefined) {
    throw new Error("--design requires a pilot run ID");
  }
  if (options.maxRunCost === undefined) {
    program.error("--design requires --max-run-cost <usd>", { exitCode: 1 });
  }
  if (options.routingConfirmation === undefined) {
    program.error("--design requires --routing-confirmation <file>", {
      exitCode: 1,
    });
  }
  const routingConfirmation = readRoutingConfirmationFile(
    options.routingConfirmation,
  );
  assertRoutingConfirmationFresh(routingConfirmation, new Date());
  const dbPath = resolve(options.db ?? join("data", "experiment.sqlite"));
  const db = openDatabase(dbPath);
  try {
    migrate(db);
    const pilotRun = getDesignerRun(db, options.design);
    if (pilotRun.runKind !== "design_pilot") {
      throw new Error("--design requires a design_pilot run");
    }
    if (pilotRun.evidenceKind !== "live") {
      throw new Error("designer protocol freeze requires live pilot evidence");
    }
    const primaryPlan = buildDesignerPlanManifest({ runKind: "design_primary" });
    const referenceDirectory = join("data", "design", "reference");
    const frozenPath = join(referenceDirectory, "frozen-reference.json");
    const cohortPath = join(referenceDirectory, "cohort-reference.json");
    const frozen = existsSync(frozenPath)
      ? readFrozenReference(frozenPath)
      : buildFrozenReference();
    const cohort = existsSync(cohortPath)
      ? readCohortReference(cohortPath)
      : buildCohortReference(primaryPlan);
    const metrics = loadDesignerCohortMetrics(db, pilotRun.runId, {
      frozen,
      cohort,
    });
    const pilotConfiguration = readDesignerConfigurationEvent(db, pilotRun.runId);
    if (pilotConfiguration === null) {
      throw new Error(
        "the pilot has no recorded designer configuration event; rerun it with a configuration snapshot",
      );
    }
    const currentHashes = collectDesignerConfigurationHashes({
      frozenReferenceHash: frozen.referenceHash,
      cohortReferenceHash: cohort.cohortHash,
    });
    const currentConfiguration = buildDesignerConfigurationSnapshot({
      model: options.model ?? pilotConfiguration.model,
      outputCapField: pilotConfiguration.outputCapField,
      maxOutputTokens:
        options.maxOutputTokens === undefined
          ? pilotConfiguration.maxOutputTokens
          : Number(options.maxOutputTokens),
      concurrency:
        options.concurrency === undefined
          ? pilotConfiguration.concurrency
          : Number(options.concurrency) === 1
            ? 1
            : 2,
      ...(pilotConfiguration.settings === null
        ? {}
        : { settings: pilotConfiguration.settings }),
      routingConfirmation,
      hashes: currentHashes,
    });
    const perFamilyAccepted = computePilotPerFamilyAiAccepted(metrics);
    const knownCostsComplete =
      metrics.arms.ai_feedback.cost.unknownAttempts === 0 &&
      metrics.arms.ai_one_shot.cost.unknownAttempts === 0;
    const observedProviderMix: Record<string, number> = {};
    for (const arm of [
      metrics.arms.baseline,
      metrics.arms.ai_one_shot,
      metrics.arms.ai_feedback,
    ]) {
      for (const [provider, count] of Object.entries(arm.providerMix)) {
        observedProviderMix[provider] = (observedProviderMix[provider] ?? 0) + count;
      }
    }
    const totalLogicalCalls = Number(options.totalLogicalCalls ?? "400");
    const maxTransportAttempts = Number(options.maxTransportAttempts ?? "1200");
    const reserve = options.reserveUsd ?? "0.50";
    const budgetForecast: DesignerBudgetForecast = {
      totalLogicalCalls,
      maxTransportAttempts,
      conservativeReserveUsd: reserve,
      perRoleReserveUsd: {
        design: reserve,
        design_repair_1: reserve,
        design_repair_2: reserve,
      },
      observedPilotCostUsd:
        metrics.arms.ai_feedback.cost.finalKnownUsd === null ||
        metrics.arms.ai_one_shot.cost.finalKnownUsd === null
          ? null
          : (
              Number(metrics.arms.ai_feedback.cost.finalKnownUsd) +
              Number(metrics.arms.ai_one_shot.cost.finalKnownUsd)
            ).toFixed(6),
      method:
        "Conservative per-role reserve supplied explicitly; observed pilot costs are reported separately.",
    };
    const result = canFreezeDesignerProtocol({
      pilotRun,
      pilotMetrics: metrics,
      primaryPlan,
      currentConfiguration,
      pilotConfiguration,
      routingConfirmation,
      budgetForecast,
      authorization: {
        operator: options.operator ?? "freeze-cli",
        authorizedAt: new Date().toISOString(),
        maxRunCostUsd: options.maxRunCost,
        acknowledged: true,
      },
      pilotEvidence: {
        evidenceKind: "live",
        runKind: "design_pilot",
        completed: metrics.complete,
        assignments: metrics.planned.assignments,
        candidates: metrics.planned.candidates,
        perFamilyAccepted,
        knownCostsComplete,
        ledgerComplete: metrics.complete,
        unresolvedInfrastructureDefect:
          (metrics.arms.ai_feedback.errorCodeDistribution.INFRASTRUCTURE_ERROR ??
            0) > 0 ||
          (metrics.arms.ai_one_shot.errorCodeDistribution.INFRASTRUCTURE_ERROR ??
            0) > 0,
        observedProviderMix,
      },
      frozenAt: new Date().toISOString(),
    });
    let stored: unknown = null;
    if (result.ok && result.freeze !== null) {
      insertDesignerProtocolFreeze(db, result.freeze);
      const protocolsRoot = resolve(
        options.protocolsRoot ?? join("data", "protocols"),
      );
      const exported = exportDesignerProtocolFreeze({
        freeze: result.freeze,
        outputDirectory: join(protocolsRoot, result.freeze.protocolHash),
      });
      stored = { ...exported };
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "designer_freeze",
          ok: result.ok,
          failed: result.failures,
          protocolHash: result.freeze?.protocolHash ?? null,
          freezeHash: result.freeze?.freezeHash ?? null,
          stored,
        },
        null,
        2,
      )}\n`,
    );
    if (!result.ok) {
      throw new Error("designer protocol freeze validation failed");
    }
  } finally {
    db.close();
  }
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
    .option("--design <pilot-id>", "designer pilot run ID to freeze")
    .option("--protocols-root <dir>", "designer protocol export root (default: data/protocols)")
    .option("--routing-confirmation <file>", "operator routing confirmation JSON")
    .option("--total-logical-calls <n>", "forecast total logical calls (default: 400)")
    .option("--max-transport-attempts <n>", "forecast transport attempts (default: 1200)")
    .option("--reserve-usd <usd>", "conservative reserve estimate (default: 0.50)")
    .option("--model <slug>", "designer model override")
    .option("--concurrency <1|2>", "designer concurrency override")
    .option("--max-output-tokens <n>", "designer output cap override")
    .action(async (options: FreezeOptions) => {
      if (options.design !== undefined) {
        await runDesignerFreeze(program, options);
        return;
      }
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
