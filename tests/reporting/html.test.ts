import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportError } from "../../src/reporting/export.js";
import {
  writeHtmlReport,
  type HtmlReportResult,
} from "../../src/reporting/html.js";
import { createRun } from "../../src/storage/repository.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  FIXTURE_RUN_ID,
  createSyntheticRun,
  type SyntheticFixture,
} from "./fixtures.js";

let tempDirectory: string;
let db: Database.Database;
let outputRoot: string;
let fixture: SyntheticFixture;

function readHtml(result: HtmlReportResult): string {
  return readFileSync(result.htmlPath, "utf8");
}

function embeddedData(html: string): {
  version: number;
  counts: { planned: number; terminal: number; approved: number; generationError: number };
  cost: { knownActualUsd: string; actualCostUsd: string | null; costStatus: string };
  cards: Array<{
    slotId: string;
    question: string | null;
    status: string;
    disagreement: boolean;
    alignment: string | null;
    costStatus: string;
    assets: { png: string | null; svg: string | null };
  }>;
} {
  const match = html.match(
    /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/,
  );
  if (match === null) {
    throw new Error("embedded report data missing");
  }
  return JSON.parse(match[1] as string) as ReturnType<typeof embeddedData>;
}

function cspContent(html: string): string {
  const match = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/,
  );
  if (match === null) {
    throw new Error("content security policy missing");
  }
  return (match[1] as string)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p38-html-"));
  db = openDatabase(join(tempDirectory, "html.sqlite"));
  migrate(db);
  outputRoot = join(tempDirectory, "runs");
  fixture = createSyntheticRun(db, {
    includeVisual: true,
    hostileHtml: true,
    blindDisagreement: true,
  });
});

afterEach(() => {
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("static offline HTML gallery", () => {
  it("renders one card per planned slot with local images and run banners", () => {
    const result = writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot });
    const html = readHtml(result);
    expect(result.cardCount).toBe(20);
    expect(html.match(/<article class="card"/g)).toHaveLength(20);
    for (const slot of fixture.plan.slots) {
      expect(html).toContain(`data-slot-id="${slot.slotId}"`);
    }
    expect(html).toContain("MOCK DATA");
    expect(html).toContain("INCOMPLETE RUN");
    expect(html).toContain("6 of 20 planned slots are terminal");
    expect(html).toContain('src="images/svg-matrix-01.png"');
    expect(html).toContain('href="images/svg-matrix-01.svg"');
    expect(
      existsSync(join(outputRoot, FIXTURE_RUN_ID, "images", "svg-matrix-01.png")),
    ).toBe(true);
    expect(
      existsSync(join(outputRoot, FIXTURE_RUN_ID, "images", "svg-matrix-01.svg")),
    ).toBe(true);
    expect(result.imageFiles).toHaveLength(2);
    expect(html).toContain("Zoom image");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("sk-");
  });

  it("keeps every planned failure card and failure evidence visible", () => {
    const html = readHtml(writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }));
    expect(html).toContain("generation_error");
    expect(html).toContain("API_ERROR");
    expect(html).toContain("NEAR_DUPLICATE_SUSPECTED");
    expect(html).toContain("UNSAT");
    expect(html).toContain("MISSING_REVIEW");
    expect(html).toContain("No public presentation was committed for this slot.");
    expect(html).toContain("No failure records.");
    expect(html).toContain('class="failures"');
    expect(html).toContain("Failure evidence");
  });

  it("hides key, hint, explanation, proof, reviews, and provenance by default", () => {
    const html = readHtml(writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }));
    const revealTags = html.match(/<details class="reveal"[^>]*>/g) ?? [];
    expect(revealTags).toHaveLength(80);
    for (const tag of revealTags) {
      expect(tag).not.toContain(" open");
    }
    expect(html).toContain("<summary>Reveal key, hint, and explanation</summary>");
    expect(html).toContain("<summary>Reveal solution proof and fingerprint</summary>");
    expect(html).toContain("<summary>Reveal blind, alignment, and duplicate reviews</summary>");
    expect(html).toContain("<summary>Reveal cost, failure evidence, and provenance</summary>");
  });

  it("uses a restrictive CSP whose script and style hashes match the inline assets", () => {
    const html = readHtml(writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }));
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(scriptMatch).not.toBeNull();
    expect(styleMatch).not.toBeNull();
    const scriptHash = createHash("sha256")
      .update(scriptMatch?.[1] as string, "utf8")
      .digest("base64");
    const styleHash = createHash("sha256")
      .update(styleMatch?.[1] as string, "utf8")
      .digest("base64");
    const csp = cspContent(html);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain(`script-src 'sha256-${scriptHash}'`);
    expect(csp).toContain(`style-src 'sha256-${styleHash}'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("http:");
    expect(csp).not.toContain("https:");
  });

  it("escapes hostile model text, attributes, and embedded JSON", () => {
    const html = readHtml(writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }));
    expect(html).not.toContain('</script><script>alert("question")');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('"><img src=x');
    expect(html).toContain(
      "&lt;/script&gt;&lt;script&gt;alert(&quot;question&quot;)&lt;/script&gt;",
    );
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)&quot; &lt;svg onload=alert(1)&gt;");
    expect(html).toContain("\\u003c/script\\u003e");
    const data = embeddedData(html);
    const hostileCard = data.cards.find((card) => card.slotId === "text-ranking-01");
    expect(hostileCard?.question).toContain("</script>");
    expect(hostileCard?.question).toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("XMLHttpRequest");
  });

  it("provides keyboard-accessible filters, reveal controls, and image zoom", () => {
    const html = readHtml(writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }));
    for (const filter of [
      "modality",
      "family",
      "lane",
      "status",
      "difficulty",
      "disagreement",
    ]) {
      expect(html).toContain(`data-filter="${filter}"`);
      expect(html).toContain(`for="filter-${filter === "status" ? "status-filter" : filter}"`);
    }
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<button type="button" id="reset-filters"');
    expect(html).toContain('<button type="button" id="reveal-all"');
    expect(html).toContain('<button type="button" id="hide-all"');
    expect(html).toContain('<dialog id="zoom-dialog"');
    expect(html).toContain('data-zoom-target="slot-svg-matrix-01"');
    expect(html).toContain('aria-label="Zoom image for svg-matrix-01"');
    expect(html).toContain('<button type="button" id="zoom-close"');
    expect(html).toContain('data-disagreement="yes"');
    expect(html).toContain('data-disagreement="no"');
    expect(html).toContain('<option value="yes">Disagreement</option>');
    expect(html).toContain("Showing 20 of 20 cards.");
  });

  it("embeds summary, per-card cost, status, and provenance details", () => {
    const html = readHtml(writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }));
    const data = embeddedData(html);
    expect(data.version).toBe(1);
    expect(data.counts.planned).toBe(20);
    expect(data.counts.terminal).toBe(6);
    expect(data.counts.approved).toBe(2);
    expect(data.counts.generationError).toBe(1);
    expect(data.cost.knownActualUsd).toBe("0.013");
    expect(data.cost.actualCostUsd).toBeNull();
    expect(data.cost.costStatus).toBe("unknown");
    const approved = data.cards.find((card) => card.slotId === "text-ranking-01");
    expect(approved).toMatchObject({
      status: "approved",
      disagreement: true,
      alignment: "pass",
      costStatus: "known",
      assets: { png: null, svg: null },
    });
    const failed = data.cards.find((card) => card.slotId === "text-ranking-02");
    expect(failed).toMatchObject({
      status: "generation_error",
      disagreement: false,
      costStatus: "unknown",
    });
    const unstarted = data.cards.find((card) => card.slotId === "text-matching-02");
    expect(unstarted?.status).toBe("unstarted");
    expect(data.cards.find((card) => card.slotId === "svg-matrix-01")?.assets).toEqual({
      png: "images/svg-matrix-01.png",
      svg: "images/svg-matrix-01.svg",
    });
    expect(html).toContain("Cost status");
    expect(html).toContain("Known actual");
    expect(html).toContain("Stage records");
    expect(html).toContain("Requests");
    expect(html).toContain("Checkpoint");
    expect(html).toContain("mock/model");
    expect(html).toContain("Primary failure");
    expect(html).toContain("alignment pass");
  });

  it("does not treat an alignment failure as reviewer disagreement", () => {
    const alignmentDirectory = join(tempDirectory, "alignment");
    const alignmentDb = openDatabase(join(alignmentDirectory, "alignment.sqlite"));
    try {
      migrate(alignmentDb);
      createSyntheticRun(alignmentDb, {
        includeVisual: true,
        alignmentOutcome: "fail",
      });
      const html = readHtml(
        writeHtmlReport(alignmentDb, FIXTURE_RUN_ID, {
          outputRoot: join(alignmentDirectory, "runs"),
        }),
      );
      const data = embeddedData(html);
      const card = data.cards.find((item) => item.slotId === "text-ranking-01");
      expect(card).toMatchObject({
        status: "approved",
        disagreement: false,
        alignment: "fail",
      });
      expect(html).toContain("alignment fail");
      expect(html).toContain('data-slot-id="text-ranking-01" data-modality="text"');
      expect(html).toContain('data-disagreement="no"');
    } finally {
      alignmentDb.close();
    }
  });

  it("renders a not-applicable run cost instead of unknown when no attempts exist", () => {
    const zeroRunId = "123e4567-e89b-42d3-a456-426614174198";
    createRun(db, {
      runId: zeroRunId,
      plan: fixture.plan,
      evidenceKind: "mock",
    });
    const html = readHtml(
      writeHtmlReport(db, zeroRunId, { outputRoot }),
    );
    const data = embeddedData(html);
    expect(data.cost.costStatus).toBe("not_applicable");
    expect(data.cost.actualCostUsd).toBeNull();
    expect(html).toContain("<dt>Actual cost</dt><dd>not applicable</dd>");
    expect(html).toContain("<dt>Cost status</dt><dd>not_applicable</dd>");
    expect(html).toContain("<dt>Actual</dt><dd>not applicable</dd>");
  });

  it("renders a live-evidence banner and remains deterministic on rewrite", () => {
    const liveDirectory = join(tempDirectory, "live");
    const liveDb = openDatabase(join(liveDirectory, "live.sqlite"));
    try {
      migrate(liveDb);
      createSyntheticRun(liveDb, { includeVisual: true, evidenceKind: "live" });
      const liveRoot = join(liveDirectory, "runs");
      const first = writeHtmlReport(liveDb, FIXTURE_RUN_ID, {
        outputRoot: liveRoot,
      });
      const firstHtml = readHtml(first);
      expect(firstHtml).toContain("LIVE DATA");
      expect(firstHtml).not.toContain("MOCK DATA");
      expect(firstHtml).toContain("INCOMPLETE RUN");
      const second = writeHtmlReport(liveDb, FIXTURE_RUN_ID, {
        outputRoot: liveRoot,
      });
      expect(readHtml(second)).toBe(firstHtml);
    } finally {
      liveDb.close();
    }
  });

  it("rejects invalid run ids and unknown runs", () => {
    expect(() =>
      writeHtmlReport(db, "not-a-uuid", { outputRoot }),
    ).toThrow(ExportError);
    expect(() =>
      writeHtmlReport(db, "123e4567-e89b-42d3-a456-426614174199", {
        outputRoot,
      }),
    ).toThrow(ExportError);
  });
});
