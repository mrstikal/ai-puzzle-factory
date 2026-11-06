import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHtmlReport } from "../../src/reporting/html.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  FIXTURE_RUN_ID,
  createSyntheticRun,
} from "../reporting/fixtures.js";

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
