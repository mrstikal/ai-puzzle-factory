import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { migrate, openDatabase } from "../storage/database.js";
import {
  getDesignerRun,
  listDesignAttempts,
  listDesignerSlots,
  listDesignerStageResults,
} from "../storage/repository.js";
import { getArtifactById } from "../storage/artifacts.js";
import {
  buildCohortReference,
  buildFrozenReference,
} from "../design/baseline.js";
import { buildDesignerPlanManifest } from "../design/assignments.js";
import {
  annotateNoveltySpec,
  buildNoveltyReferenceView,
} from "../design/novelty.js";
import type { DesignView } from "../presentation/design-view.js";
import {
  buildDesignEvaluationSample,
  type DesignSampleCandidate,
} from "../audit/design-sample.js";
import {
  buildDesignEvaluationLabelsCsv,
  getDesignEvaluationSample,
  importDesignEvaluationRows,
  parseDesignEvaluationLabelsCsv,
  storeDesignEvaluationSample,
  writeDesignEvaluationArtifacts,
} from "../audit/design-labels.js";
import type { DesignAttemptRecord } from "../design/attempts.js";
import { z } from "zod";

interface DesignAuditOptions {
  readonly design?: boolean;
  readonly run?: string;
  readonly prepare?: boolean;
  readonly import?: string;
  readonly db?: string;
  readonly outputRoot?: string;
  readonly syntheticTest?: boolean;
}

const EvidenceSchema = z.looseObject({
  spec: z.unknown().nullable(),
});

function specFromAttempt(
  db: ReturnType<typeof openDatabase>,
  attempt: DesignAttemptRecord,
): unknown | null {
  const artifact = attempt.artifacts.find(
    (entry) => entry.role === "solver_result",
  );
  if (artifact === undefined) {
    return null;
  }
  const bytes = getArtifactById(db, artifact.artifact.artifactId);
  const parsed = EvidenceSchema.safeParse(
    JSON.parse(bytes.bytes.toString("utf8")),
  );
  return parsed.success ? parsed.data.spec : null;
}

export function buildDesignSampleCandidates(
  db: ReturnType<typeof openDatabase>,
  runId: string,
): DesignSampleCandidate[] {
  const run = getDesignerRun(db, runId);
  const slots = listDesignerSlots(db, runId);
  const frozen = buildFrozenReference();
  const cohort = buildCohortReference(
    run.manifest.runKind === "design_primary"
      ? run.manifest
      : buildDesignerPlanManifest({ runKind: "design_primary" }),
  );
  const frozenView = buildNoveltyReferenceView(frozen);
  const cohortView = buildNoveltyReferenceView(cohort);
  const candidates: DesignSampleCandidate[] = [];
  for (const slot of slots) {
    if (slot.verdict !== "accepted") {
      continue;
    }
    const stages = listDesignerStageResults(db, runId, slot.slotId);
    const presentation = stages.find((stage) => stage.stage === "presentation_ready");
    if (presentation === undefined) {
      throw new Error(`accepted candidate ${slot.slotId} has no presentation stage`);
    }
    const payload = presentation.payload as { view?: DesignView };
    if (payload.view === undefined) {
      throw new Error(`accepted candidate ${slot.slotId} has no design view`);
    }
    const view = payload.view;
    const attempts = listDesignAttempts(db, runId, slot.slotId);
    const finalAttempt = attempts[attempts.length - 1];
    if (finalAttempt === undefined) {
      continue;
    }
    const spec = specFromAttempt(db, finalAttempt);
    if (spec === null) {
      throw new Error(`accepted candidate ${slot.slotId} has no final spec evidence`);
    }
    const annotation = annotateNoveltySpec({
      candidateId: `${slot.slotId}:final`,
      assignmentId: slot.assignmentId,
      arm: slot.arm,
      view: "final",
      family: slot.family,
      difficulty: slot.difficulty,
      spec,
      frozen: frozenView,
      cohort: cohortView,
    });
    const svgArtifact = presentation.artifacts.find(
      (artifact) => artifact.kind === "svg",
    );
    const svg =
      svgArtifact === undefined
        ? null
        : getArtifactById(db, svgArtifact.artifactId).bytes.toString("utf8");
    candidates.push({
      slotId: slot.slotId,
      assignmentId: slot.assignmentId,
      assignmentOrdinal:
        run.manifest.assignments.find(
          (assignment) => assignment.assignmentId === slot.assignmentId,
        )?.assignmentOrdinal ?? 1,
      arm: slot.arm,
      family: slot.family,
      difficulty: slot.difficulty,
      finalVerdict: "accepted",
      attemptCount: attempts.length,
      finalNovelty: annotation.annotation,
      view,
      svg,
      certificateHash: view.certificate.certificateHash,
    });
  }
  return candidates;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("design-audit")
    .description("Prepare and import blinded designer human-evaluation samples.")
    .showHelpAfterError()
    .option("--design", "designer evaluation mode")
    .option("--run <design-id>", "designer run ID")
    .option("--prepare", "prepare the deterministic blinded sample and CSV")
    .option("--import <path>", "import append-only label revisions from CSV")
    .option("--db <path>", "SQLite database (default: data/experiment.sqlite)")
    .option("--output-root <dir>", "evaluation output root")
    .option("--synthetic-test", "mark imported labels as synthetic test-only")
    .action(async (options: DesignAuditOptions) => {
      if (options.design !== true) {
        throw new Error("design-audit requires --design");
      }
      if (options.run === undefined) {
        throw new Error("--design requires --run <design-id>");
      }
      if ((options.prepare === true) === (options.import !== undefined)) {
        throw new Error("exactly one of --prepare or --import is required");
      }
      const db = openDatabase(resolve(options.db ?? join("data", "experiment.sqlite")));
      try {
        migrate(db);
        const run = getDesignerRun(db, options.run);
        if (options.prepare === true) {
          const candidates = buildDesignSampleCandidates(db, run.runId);
          const sample = buildDesignEvaluationSample({
            runId: run.runId,
            planHash: run.manifest.planHash,
            protocolVersion: run.protocolVersion,
            rootSeed: run.rootSeed,
            createdAt: run.createdAt,
            candidates,
          });
          const storedSample = storeDesignEvaluationSample(db, sample);
          const labelsCsv = buildDesignEvaluationLabelsCsv(storedSample, {
            syntheticTestOnly: options.syntheticTest === true,
          });
          const outputRoot = resolve(
            options.outputRoot ?? join("data", "runs", run.runId, "design-evaluation"),
          );
          const artifacts = writeDesignEvaluationArtifacts({
            sample: storedSample,
            outputDirectory: outputRoot,
            labelsCsv,
          });
          process.stdout.write(
            `${JSON.stringify(
              {
                mode: "prepare",
                runId: run.runId,
                sampleHash: storedSample.sampleHash,
                selection: storedSample.selection,
                artifacts,
                syntheticTestOnly: options.syntheticTest === true,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        const csv = readFileSync(options.import as string, "utf8");
        const dataLine = csv
          .split(/\r?\n/)
          .find(
            (line) =>
              line.trim() !== "" &&
              !line.startsWith("#") &&
              !line.startsWith("sample_hash,"),
          );
        const sampleHash = dataLine?.split(",")[0] ?? "";
        if (!/^[0-9a-f]{64}$/.test(sampleHash)) {
          throw new Error("CSV does not carry a valid sample_hash");
        }
        const sample = getDesignEvaluationSample(db, sampleHash);
        const parsed = parseDesignEvaluationLabelsCsv({
          text: csv,
          sample,
          syntheticTestOnly: options.syntheticTest === true,
          now: new Date(),
        });
        const imported = importDesignEvaluationRows(db, sample, parsed.rows);
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: "import",
              runId: run.runId,
              sampleHash: sample.sampleHash,
              synthetic: parsed.synthetic,
              inserted: imported.inserted,
            },
            null,
            2,
          )}\n`,
        );
      } finally {
        db.close();
      }
    });
  return program;
}
