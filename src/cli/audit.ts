import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
  buildAuditSummary,
  importAuditLabels,
  loadAuditManifest,
  parseAuditLabelsCsv,
  writeAuditOutputs,
} from "../audit/labels.js";
import { selectAuditSample } from "../audit/sample.js";
import { buildCandidateRows, resolveRunDirectory, writeAtomicFile } from "../reporting/export.js";
import { getRun } from "../storage/repository.js";
import { migrate, openDatabase } from "../storage/database.js";

export const PROGRAM_NAME = "audit";

interface AuditOptions {
  readonly run?: string;
  readonly prepare?: boolean;
  readonly import?: string;
  readonly db?: string;
}

function formatShortfalls(
  shortfalls: ReturnType<typeof selectAuditSample>["shortfalls"],
): string {
  if (shortfalls.length === 0) {
    return "shortfalls: none";
  }
  return `shortfalls: ${shortfalls
    .map(
      (shortfall) =>
        `${shortfall.kind}/${shortfall.family}/${shortfall.lane ?? "-"}/${shortfall.available}of${shortfall.required}`,
    )
    .join(",")}`;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("Prepare a deterministic human-audit sample or import append-only human labels.")
    .showHelpAfterError()
    .option("--run <run-id>", "committed run ID")
    .option("--prepare", "select the deterministic sample, gallery, and pending label CSV")
    .option("--import <path>", "import a completed human audit label CSV")
    .option("--db <path>", "SQLite database path", "data/experiment.sqlite")
    .action((options: AuditOptions) => {
      if (options.run === undefined) {
        program.error("--run is required", { exitCode: 1 });
        return;
      }
      const modes = [options.prepare === true, options.import !== undefined].filter(
        Boolean,
      );
      if (modes.length !== 1) {
        program.error("choose exactly one of --prepare or --import", {
          exitCode: 1,
        });
        return;
      }
      const db = openDatabase(options.db ?? "data/experiment.sqlite");
      migrate(db);
      try {
        const run = getRun(db, options.run);
        const candidates = buildCandidateRows(db, run.runId);
        if (options.prepare === true) {
          const manifest = selectAuditSample({ run, candidates });
          const paths = writeAuditOutputs(db, run, manifest, candidates);
          const summary = buildAuditSummary(db, manifest, candidates);
          if (manifest.production) {
            writeAtomicFile(
              join(paths.directory, "summary.json"),
              `${JSON.stringify(summary, null, 2)}\n`,
            );
          }
          process.stdout.write(
            [
              `mode: ${manifest.preview ? "preview" : "production"}`,
              `production_audit: ${manifest.production}`,
              `run_id: ${manifest.runId}`,
              `sample_hash: ${manifest.sampleHash}`,
              `core: ${manifest.core.length}`,
              `additions: ${manifest.categoryAdditions.length}`,
              `total: ${manifest.denominators.total.sampled}`,
              `approved_sampled: ${manifest.denominators.approved.sampled}`,
              formatShortfalls(manifest.shortfalls),
              `manifest: ${paths.manifestPath}`,
              `labels: ${paths.labelsPath}`,
              `gallery: ${paths.galleryPath}`,
              ...(manifest.preview
                ? ["message: smoke runs only produce a labeled preview, not a production 40-slot audit"]
                : []),
            ].join("\n") + "\n",
          );
          return;
        }
        const importPath = options.import as string;
        const auditDirectory = join(resolveRunDirectory(run.runId, "data/runs"), "audit");
        const manifestPath = join(auditDirectory, "sample.json");
        let manifest;
        try {
          manifest = loadAuditManifest(manifestPath);
        } catch (error) {
          throw new Error(
            `production audit sample not found or invalid at ${manifestPath}; run --prepare on a full run first`,
            { cause: error },
          );
        }
        const rows = parseAuditLabelsCsv(readFileSync(importPath, "utf8"));
        const result = importAuditLabels({ db, manifest, run, candidates, rows });
        writeAtomicFile(
          join(auditDirectory, "summary.json"),
          `${JSON.stringify(result.summary, null, 2)}\n`,
        );
        process.stdout.write(
          [
            `imported: ${result.imported}`,
            `sample_hash: ${result.sampleHash}`,
            `auditor: ${result.auditor}`,
            `auditor_time: ${result.auditorTime}`,
            `revision_min: ${Math.min(...result.revisions)}`,
            `revision_max: ${Math.max(...result.revisions)}`,
            `total_sampled: ${result.summary.total.sampled}`,
            `total_labelled: ${result.summary.total.labelled}`,
            `total_inspectable: ${result.summary.total.inspectable}`,
            `approved_sampled: ${result.summary.approved.sampled}`,
            `approved_labelled: ${result.summary.approved.labelled}`,
            `approved_inspectable: ${result.summary.approved.inspectable}`,
          ].join("\n") + "\n",
        );
      } finally {
        db.close();
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
