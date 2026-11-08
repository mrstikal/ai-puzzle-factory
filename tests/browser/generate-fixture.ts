import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeHtmlReport } from "../../src/reporting/html.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  FIXTURE_RUN_ID,
  createSyntheticRun,
} from "../reporting/fixtures.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import { runDesignerCohort } from "../../src/design/run.js";
import { createMockTransport } from "../../src/ai/mock.js";
import { exportDesignerRun } from "../../src/reporting/design-report.js";
import { buildDesignSampleCandidates } from "../../src/cli/design-audit.js";
import { buildDesignEvaluationSample } from "../../src/audit/design-sample.js";
import {
  buildDesignEvaluationLabelsCsv,
  storeDesignEvaluationSample,
  writeDesignEvaluationArtifacts,
} from "../../src/audit/design-labels.js";

async function generateDesignerFixture(): Promise<void> {
  const root = join(process.cwd(), "data", "browser-design");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "fixture.sqlite"));
  try {
    migrate(db);
    const plan = buildDesignerPlanManifest({ runKind: "design_pilot" });
    const runId = randomUUID();
    const accountId = randomUUID();
    const transport = createMockTransport({ db });
    const result = await runDesignerCohort({
      db,
      runId,
      plan,
      evidenceKind: "mock",
      apiKey: "mock",
      transport,
      accountId,
      maxCostUsd: "0",
      config: {
        model: "mock/model",
        outputCapField: "max_tokens",
        maxOutputTokens: 8192,
        skinEnabled: true,
        reservationUsd: "0.01",
        nonBilling: true,
      },
      concurrency: 2,
    });
    if (result.status !== "completed") {
      throw new Error("designer browser fixture run did not complete");
    }
    const exported = exportDesignerRun(db, runId, {
      outputRoot: join(root, "runs"),
    });
    const candidates = buildDesignSampleCandidates(db, runId);
    const sample = buildDesignEvaluationSample({
      runId,
      planHash: plan.planHash,
      protocolVersion: plan.protocolVersion,
      rootSeed: plan.rootSeed,
      createdAt: new Date().toISOString(),
      candidates,
    });
    storeDesignEvaluationSample(db, sample);
    const artifacts = writeDesignEvaluationArtifacts({
      sample,
      outputDirectory: join(root, "design-evaluation"),
      labelsCsv: buildDesignEvaluationLabelsCsv(sample),
    });
    writeFileSync(
      join(root, "design-fixture.json"),
      `${JSON.stringify(
        {
          runId,
          reportPath: join(exported.directory, "report.html"),
          solvePath: artifacts.solveHtmlPath,
          revealPath: artifacts.revealHtmlPath,
          labelsPath: artifacts.labelsPath,
          sampleHash: sample.sampleHash,
          slotCount: exported.metrics.planned.candidates,
          tripletCount: sample.publicBundle.triplets.length,
          additionCount: sample.publicBundle.additions.length,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`designer browser gallery: ${exported.directory}\n`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const root = join(process.cwd(), "data", "browser-report");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "fixture.sqlite"));
  try {
    migrate(db);
    createSyntheticRun(db, {
      includeVisual: true,
      hostileHtml: true,
      blindDisagreement: true,
      largeVisual: true,
      includeIncomplete: true,
    });
    const result = writeHtmlReport(db, FIXTURE_RUN_ID, {
      outputRoot: join(root, "runs"),
    });
    writeFileSync(
      join(root, "fixture.json"),
      `${JSON.stringify(
        {
          runId: FIXTURE_RUN_ID,
          htmlPath: result.htmlPath,
          imageFiles: result.imageFiles,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`browser gallery: ${result.htmlPath}\n`);
  } finally {
    db.close();
  }
  await generateDesignerFixture();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
