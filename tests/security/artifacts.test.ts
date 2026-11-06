import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitRequest } from "../../src/ai/budget.js";
import {
  createAttempt,
  createLogicalCall,
  markAttemptDispatching,
  saveAttemptResponse,
} from "../../src/ai/ledger.js";
import { replaySavedResponse } from "../../src/ai/openrouter.js";
import { VisiblePresentationSchema } from "../../src/domain/presentation.js";
import {
  ExportError,
  assertArtifactExportSafe,
  exportRun,
  readResultsCsv,
} from "../../src/reporting/export.js";
import { writeHtmlReport } from "../../src/reporting/html.js";
import { storeArtifact } from "../../src/storage/artifacts.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { insertStageResult } from "../../src/storage/repository.js";
import { hashCanonicalJson } from "../../src/util/hash.js";
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_RUN_ID,
  createSyntheticRun,
} from "../reporting/fixtures.js";

const CANARY = `sk-or-v1-${"e".repeat(64)}`;

let tempDirectory: string;
let db: Database.Database;
let outputRoot: string;

function addCredentialCall(): {
  readonly attemptId: string;
  readonly logicalCallId: string;
} {
  const createdAt = "2026-11-05T00:00:03.000Z";
  const finishedAt = "2026-11-05T00:00:04.000Z";
  const call = createLogicalCall(db, {
    runId: FIXTURE_RUN_ID,
    slotId: "text-truth-01",
    role: "wording",
    runKind: "smoke",
    requestBody: {
      model: "mock/model",
      messages: [{ role: "user", content: `leak ${CANARY}` }],
      api_key: CANARY,
      headers: { Authorization: `Bearer ${CANARY}` },
    },
    expectedSchemaHash: "a".repeat(64),
    model: "mock/model",
    routingPolicy: "balanced",
    createdAt,
  });
  const attempt = createAttempt(db, {
    logicalCallId: call.logicalCallId,
    createdAt,
  });
  const admission = admitRequest(db, {
    accountId: FIXTURE_ACCOUNT_ID,
    logicalCallId: call.logicalCallId,
    attemptId: attempt.attemptId,
    kind: "attempt",
    amountUsd: "0.01",
    nonBilling: false,
    createdAt,
  });
  if (!admission.admitted) {
    throw new Error(`credential fixture admission failed: ${admission.reason}`);
  }
  markAttemptDispatching(db, attempt.attemptId, createdAt);
  const artifact = storeArtifact(
    db,
    {
      kind: "raw_response",
      mediaType: "application/json",
      bytes: Buffer.from(
        JSON.stringify({
          id: "credential-leak",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ echo: CANARY }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
      role: "raw_response",
    },
    finishedAt,
  );
  saveAttemptResponse(db, {
    attemptId: attempt.attemptId,
    finishedAt,
    elapsedMs: 1_000,
    httpStatus: 200,
    generationId: null,
    rawResponseArtifactId: artifact.artifactId,
    finishReason: "stop",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    reasoningTokens: null,
    actualCostUsd: "0",
    errorClassification: null,
    partialCompletion: false,
  });
  return { attemptId: attempt.attemptId, logicalCallId: call.logicalCallId };
}

function addPresentationWithCanary(): void {
  const startedAt = "2026-11-05T00:00:05.000Z";
  const finishedAt = "2026-11-05T00:00:06.000Z";
  insertStageResult(db, {
    runId: FIXTURE_RUN_ID,
    slotId: "text-matching-02",
    stage: "presentation_ready",
    startedAt,
    finishedAt,
    elapsedMs: 1_000,
    payload: {
      presentation: {
        visible: {
          version: 1,
          slotId: "text-matching-02",
          family: "matching",
          modality: "text",
          question: "=cmd|' /C calc'!A0",
          rules: ["Match each item exactly once."],
          clues: [],
          options: [
            { label: "A", text: "Option A" },
            { label: "B", text: "Option B" },
            { label: "C", text: "Option C" },
            { label: "D", text: "Option D" },
          ],
          assets: { svgHash: null, pngHash: null },
        },
        reveal: {
          correctLabel: "A",
          correctValue: "A",
          hint: `hint ${CANARY}`,
          explanationSteps: [`step ${CANARY}`],
          proof: { facts: [] },
        },
      },
    },
    createdAt: finishedAt,
  });
}

function readTextArtifacts(directory: string): string[] {
  const texts: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      texts.push(...readTextArtifacts(path));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (statSync(path).size > 5_000_000) {
      continue;
    }
    if (/\.(?:png|ttf)$/i.test(entry.name)) {
      continue;
    }
    texts.push(readFileSync(path, "utf8"));
  }
  return texts;
}

function evidenceHash(): string {
  return hashCanonicalJson({
    run: db.prepare("SELECT * FROM runs WHERE run_id = ?").get(FIXTURE_RUN_ID),
    slots: db
      .prepare("SELECT * FROM slots WHERE run_id = ? ORDER BY slot_ordinal")
      .all(FIXTURE_RUN_ID),
    stages: db
      .prepare(
        "SELECT * FROM stage_results WHERE run_id = ? ORDER BY slot_id, stage",
      )
      .all(FIXTURE_RUN_ID),
    stageArtifacts: db
      .prepare("SELECT * FROM stage_artifacts ORDER BY run_id, slot_id, stage, version, artifact_id")
      .all(),
    artifacts: db
      .prepare(
        "SELECT artifact_id, content_hash, kind, media_type, byte_length, created_at FROM artifacts ORDER BY artifact_id",
      )
      .all(),
    calls: db
      .prepare("SELECT * FROM logical_calls WHERE run_id = ? ORDER BY logical_call_id")
      .all(FIXTURE_RUN_ID),
    attempts: db
      .prepare("SELECT * FROM request_attempts ORDER BY attempt_id")
      .all(),
    reservations: db
      .prepare("SELECT * FROM budget_reservations ORDER BY reservation_id")
      .all(),
    requestEvents: db
      .prepare("SELECT * FROM request_events ORDER BY event_id")
      .all(),
    events: db.prepare("SELECT * FROM events ORDER BY event_id").all(),
  });
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p44-artifacts-"));
  db = openDatabase(join(tempDirectory, "artifacts.sqlite"));
  migrate(db);
  outputRoot = join(tempDirectory, "runs");
  createSyntheticRun(db, { includeVisual: true, hostileHtml: true });
  addCredentialCall();
  addPresentationWithCanary();
});

afterEach(() => {
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("artifact security boundary", () => {
  it("redacts credentials across HTML, CSV, JSONL, puzzle, manifest, and SVG exports", () => {
    const before = evidenceHash();
    exportRun(db, FIXTURE_RUN_ID, { outputRoot, format: "all" });
    writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot });
    expect(evidenceHash()).toBe(before);

    const directory = join(outputRoot, FIXTURE_RUN_ID);
    const text = readTextArtifacts(directory).join("\n");
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("sk-or-v1-");
    expect(text).toContain("[REDACTED]");

    const html = readFileSync(join(directory, "report.html"), "utf8");
    expect(html).not.toContain(CANARY);
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain('</script><script>alert("question")</script>');
    expect(html).toContain("&lt;/script&gt;");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<svg");
    const revealTags = html.match(/<details class="reveal"[^>]*>/g) ?? [];
    expect(revealTags.length).toBeGreaterThan(0);
    for (const tag of revealTags) {
      expect(tag).not.toContain(" open");
    }

    const csvRows = readResultsCsv(join(directory, "results.csv"));
    const canaryRow = csvRows.find((row) => row.slot_id === "text-matching-02");
    expect(canaryRow?.question).toBe("'=cmd|' /C calc'!A0");
    expect(canaryRow?.hint).toBe("hint [REDACTED]");
    expect(canaryRow?.explanation).toBe("step [REDACTED]");

    const svg = readFileSync(
      join(directory, "images", "svg-matrix-01.svg"),
      "utf8",
    );
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("javascript:");
    expect(svg).not.toContain("onload=");

    const requests = readFileSync(join(directory, "requests.jsonl"), "utf8");
    expect(requests).toContain("[REDACTED]");
    expect(requests).not.toContain(CANARY);
  });

  it("rejects unsafe run and archive paths", () => {
    expect(() =>
      exportRun(db, "../escape", { outputRoot, format: "all" }),
    ).toThrow(ExportError);
    expect(() =>
      exportRun(db, "not-a-uuid", { outputRoot, format: "all" }),
    ).toThrow(ExportError);
    expect(() =>
      writeHtmlReport(db, "../escape", { outputRoot }),
    ).toThrow(ExportError);
    expect(() =>
      writeHtmlReport(db, "not-a-uuid", { outputRoot }),
    ).toThrow(ExportError);
  });

  it("replays stored LLM responses with identical content and no new attempts", () => {
    const rows = db
      .prepare(
        "SELECT logical_call_id, request_hash FROM logical_calls WHERE run_id = ? AND slot_id = ? AND role = ?",
      )
      .all(FIXTURE_RUN_ID, "text-truth-01", "wording") as Array<{
      logical_call_id: string;
      request_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    const callId = rows[0]?.logical_call_id;
    expect(callId).toBeDefined();
    const attempt = db
      .prepare(
        "SELECT attempt_id FROM request_attempts WHERE logical_call_id = ? ORDER BY attempt_number LIMIT 1",
      )
      .get(callId) as { attempt_id: string } | undefined;
    expect(attempt).toBeDefined();
    const attemptCountBefore = db
      .prepare(
        "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id = ?",
      )
      .get(callId) as { count: number };

    const first = replaySavedResponse(
      db,
      attempt?.attempt_id as string,
      "sk-test",
      "2026-11-06T12:00:00.000Z",
    );
    const second = replaySavedResponse(
      db,
      attempt?.attempt_id as string,
      "sk-test",
      "2026-11-06T12:01:00.000Z",
    );
    expect(first.content).toBe(JSON.stringify({ echo: CANARY }));
    expect(second.content).toBe(first.content);
    expect(second.parsedContent).toEqual(first.parsedContent);
    expect(second.usage).toEqual(first.usage);
    expect(second.actualCostUsd).toBe(first.actualCostUsd);
    const attemptCountAfter = db
      .prepare(
        "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id = ?",
      )
      .get(callId) as { count: number };
    expect(attemptCountAfter.count).toBe(attemptCountBefore.count);
  });

  it("rejects credential-shaped image artifacts instead of copying them", () => {
    const maliciousSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><text>${CANARY}</text></svg>`,
    );
    const artifact = storeArtifact(
      db,
      {
        kind: "svg",
        mediaType: "image/svg+xml",
        bytes: maliciousSvg,
        role: "render",
      },
      "2026-11-05T00:00:07.000Z",
    );
    insertStageResult(db, {
      runId: FIXTURE_RUN_ID,
      slotId: "text-truth-02",
      stage: "formal_checked",
      startedAt: "2026-11-05T00:00:07.000Z",
      finishedAt: "2026-11-05T00:00:08.000Z",
      elapsedMs: 1_000,
      payload: { render: { svgHash: artifact.contentHash, pngHash: null } },
      createdAt: "2026-11-05T00:00:08.000Z",
    });
    expect(() =>
      exportRun(db, FIXTURE_RUN_ID, { outputRoot, format: "all" }),
    ).toThrow(ExportError);
    expect(() =>
      exportRun(db, FIXTURE_RUN_ID, { outputRoot, format: "all" }),
    ).toThrow(/credential-shaped/);
    expect(() => assertArtifactExportSafe("png", Buffer.from(CANARY))).toThrow(
      ExportError,
    );
  });

  it("validates all report images before writing any image", () => {
    const maliciousSvg = storeArtifact(
      db,
      {
        kind: "svg",
        mediaType: "image/svg+xml",
        bytes: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg"><text>${CANARY}</text></svg>`,
        ),
        role: "render",
      },
      "2026-11-05T00:00:09.000Z",
    );
    const png = storeArtifact(
      db,
      {
        kind: "png",
        mediaType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        role: "render",
      },
      "2026-11-05T00:00:09.000Z",
    );
    insertStageResult(db, {
      runId: FIXTURE_RUN_ID,
      slotId: "text-truth-02",
      stage: "presentation_ready",
      startedAt: "2026-11-05T00:00:09.000Z",
      finishedAt: "2026-11-05T00:00:10.000Z",
      elapsedMs: 1_000,
      payload: {
        presentation: {
          visible: {
            version: 1,
            slotId: "text-truth-02",
            family: "truth",
            modality: "text",
            question: "Which statement is true?",
            rules: ["Use only the stated facts."],
            clues: [],
            options: [
              { label: "A", text: "Option A" },
              { label: "B", text: "Option B" },
              { label: "C", text: "Option C" },
              { label: "D", text: "Option D" },
            ],
            assets: {
              svgHash: maliciousSvg.contentHash,
              pngHash: png.contentHash,
            },
          },
          reveal: {
            correctLabel: "A",
            correctValue: "A",
            hint: "hint",
            explanationSteps: ["step"],
            proof: { facts: [] },
          },
        },
      },
      createdAt: "2026-11-05T00:00:10.000Z",
    });
    expect(() =>
      writeHtmlReport(db, FIXTURE_RUN_ID, { outputRoot }),
    ).toThrow(ExportError);
    expect(
      existsSync(
        join(outputRoot, FIXTURE_RUN_ID, "images", "text-truth-02.png"),
      ),
    ).toBe(false);
  });

  it("keeps reveal fields outside the public visible-presentation contract", () => {
    const visible = {
      version: 1,
      slotId: "text-ranking-01",
      family: "ranking",
      modality: "text",
      question: "Which option is first?",
      rules: {
        domain: "A short ordered list.",
        closedWorld: "Each item appears once.",
        target: "Choose the first item.",
        operations: ["Read the order."],
        conventions: [],
      },
      clues: [],
      options: [
        { label: "A", text: "Option A" },
        { label: "B", text: "Option B" },
        { label: "C", text: "Option C" },
        { label: "D", text: "Option D" },
      ],
      assets: { svgHash: null, pngHash: null },
    };
    expect(VisiblePresentationSchema.safeParse(visible).success).toBe(true);
    expect(
      VisiblePresentationSchema.safeParse({
        ...visible,
        reveal: { hint: "secret hint" },
      }).success,
    ).toBe(false);
  });
});
