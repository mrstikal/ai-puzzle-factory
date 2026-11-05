import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitRequest,
  createBudgetAccount,
  getBudgetAccount,
} from "../../src/ai/budget.js";
import {
  createAttempt,
  createLogicalCall,
  getAttempt,
  getLogicalCall,
  getOrCreatePreparedAttempt,
  listAttempts,
  markAttemptDispatching,
  type LogicalCall,
} from "../../src/ai/ledger.js";
import {
  OpenRouterError,
  createOpenRouterTransport,
} from "../../src/ai/openrouter.js";
import { decideRetry, parseRetryAfter } from "../../src/ai/retry.js";
import {
  REDACTED,
  assertNoSecrets,
  containsSecret,
  redactHeaders,
  redactText,
  redactValue,
} from "../../src/ai/redact.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { createRun } from "../../src/storage/repository.js";
import {
  createFakeOpenRouter,
  type FakeOpenRouter,
} from "../helpers/fake-openrouter.js";
import { allowLocalFake } from "../setup.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-test-secret-do-not-persist";
const SCHEMA_HASH = "a".repeat(64);

interface TestClock {
  readonly sleeps: number[];
  now(): Date;
  sleep(ms: number): Promise<void>;
}

function makeClock(): TestClock {
  let current = Date.parse(CREATED_AT);
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(current),
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "test/model",
    messages: [{ role: "user", content: "Return JSON." }],
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
    provider: {
      only: ["test-provider"],
      allow_fallbacks: false,
      require_parameters: true,
    },
    max_tokens: 1024,
    ...overrides,
  };
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gen-1",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ answer: "ok" }) },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
    },
    ...overrides,
  };
}

let tempDirectory: string;
let db: Database.Database;
let fake: FakeOpenRouter;

function createCall(
  slotIndex: number,
  requestBody: Record<string, unknown> = makeRequest(),
): LogicalCall {
  const slot = SMOKE_PLAN.slots[slotIndex];
  if (slot === undefined) {
    throw new Error(`missing smoke slot ${slotIndex}`);
  }
  return createLogicalCall(db, {
    runId: RUN_ID,
    slotId: slot.slotId,
    role: "spec",
    runKind: "smoke",
    requestBody,
    expectedSchemaHash: SCHEMA_HASH,
    model: "test/model",
    provider: "test-provider",
    createdAt: CREATED_AT,
  });
}

interface ExecuteOptions {
  readonly requestBody?: Record<string, unknown>;
  readonly clock?: TestClock;
  readonly deadlineMs?: number;
  readonly random?: () => number;
}

async function execute(slotIndex = 0, options: ExecuteOptions = {}) {
  const call = createCall(slotIndex, options.requestBody);
  const clock = options.clock ?? makeClock();
  const transport = createOpenRouterTransport({
    baseUrl: fake.baseUrl,
    clock,
    random: options.random ?? (() => 0),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
  const result = await transport.executeCall({
    db,
    accountId: "test-account",
    logicalCallId: call.logicalCallId,
    apiKey: API_KEY,
    reservationUsd: "0.01",
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
  return { call, result, transport, clock };
}

function getRawArtifactBytes(artifactId: number): Buffer {
  const row = db
    .prepare("SELECT bytes FROM artifacts WHERE artifact_id = ?")
    .get(artifactId) as { bytes: Buffer } | undefined;
  if (row === undefined) {
    throw new Error(`missing raw artifact ${artifactId}`);
  }
  return row.bytes;
}

function assertNoSecretInDatabase(secret: string): void {
  for (const table of [
    "logical_calls",
    "request_attempts",
    "request_events",
    "budget_reservations",
    "budget_events",
  ]) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown[];
    expect(containsSecret(rows, [secret])).toBe(false);
  }
  const artifacts = db.prepare("SELECT bytes FROM artifacts").all() as Array<{
    bytes: Buffer;
  }>;
  for (const artifact of artifacts) {
    expect(artifact.bytes.toString("utf8")).not.toContain(secret);
  }
}

function expectOpenRouterError(action: () => Promise<unknown>, code: string): Promise<void> {
  return action().then(
    () => {
      throw new Error(`expected OpenRouterError ${code}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(OpenRouterError);
      expect((error as OpenRouterError).code).toBe(code);
    },
  );
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-openrouter-"));
  db = openDatabase(join(tempDirectory, "experiment.sqlite"));
  migrate(db);
  createRun(db, {
    runId: RUN_ID,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId: "test-account",
    runId: RUN_ID,
    runKind: "smoke",
    maxCostUsd: "10",
    createdAt: CREATED_AT,
  });
  fake = await createFakeOpenRouter();
  allowLocalFake(fake.baseUrl);
});

afterEach(async () => {
  await fake.close();
  try {
    db.close();
  } catch {
    // The test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("OpenRouter transport", () => {
  it("sends a non-streaming request, persists raw response, validates content, and redacts credentials", async () => {
    const clock = makeClock();
    fake.enqueue({ status: 200, body: successBody({ echo: API_KEY }) });
    const { call, result } = await execute(0, { clock });

    expect(result.outcome).toBe("success");
    expect(result.parsedContent).toEqual({ answer: "ok" });
    expect(result.content).toBe(JSON.stringify({ answer: "ok" }));
    expect(result.generationId).toBe("gen-1");
    expect(result.actualCostUsd).toBe("0.001");
    expect(result.costStatus).toBe("known");
    expect(result.error).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      attemptNumber: 1,
      httpStatus: 200,
      outcome: "success",
      costStatus: "known",
    });
    expect(getLogicalCall(db, call.logicalCallId).state).toBe("validated");
    const attempts = listAttempts(db, call.logicalCallId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("validated");
    expect(attempts[0]?.requestHash).toBe(call.requestHash);
    expect(attempts[0]?.partialCompletion).toBe(false);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.001");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.url).toBe("/api/v1/chat/completions");
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(fake.requests[0]?.body ?? "null")).toEqual(call.requestBody);

    const artifactId = result.attempts[0]?.responseArtifactId;
    if (artifactId === null || artifactId === undefined) {
      throw new Error("expected a raw response artifact");
    }
    const raw = getRawArtifactBytes(artifactId);
    expect(raw.toString("utf8")).not.toContain(API_KEY);
    expect(raw.toString("utf8")).toContain(REDACTED);
    assertNoSecretInDatabase(API_KEY);
    expect(containsSecret(result, [API_KEY])).toBe(false);
  });

  it("reuses an active reservation for a prepared attempt instead of admitting twice", async () => {
    const call = createCall(0);
    const attempt = createAttempt(db, {
      logicalCallId: call.logicalCallId,
      createdAt: CREATED_AT,
    });
    const admission = admitRequest(db, {
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      attemptId: attempt.attemptId,
      kind: "attempt",
      amountUsd: "0.01",
      createdAt: CREATED_AT,
    });
    expect(admission.admitted).toBe(true);
    fake.enqueue({ status: 200, body: successBody() });
    const transport = createOpenRouterTransport({
      baseUrl: fake.baseUrl,
      clock: makeClock(),
      random: () => 0,
    });
    const result = await transport.executeCall({
      db,
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      apiKey: API_KEY,
      reservationUsd: "0.01",
    });
    expect(result.outcome).toBe("success");
    expect(result.attempts).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    const reservations = db
      .prepare("SELECT COUNT(*) AS count FROM budget_reservations")
      .get() as { count: number };
    expect(reservations.count).toBe(1);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.001");
  });

  it("rejects reusing an active reservation from a different budget account", async () => {
    const call = createCall(0);
    const attempt = createAttempt(db, {
      logicalCallId: call.logicalCallId,
      createdAt: CREATED_AT,
    });
    const admission = admitRequest(db, {
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      attemptId: attempt.attemptId,
      kind: "attempt",
      amountUsd: "0.01",
      createdAt: CREATED_AT,
    });
    expect(admission.admitted).toBe(true);
    fake.enqueue({ status: 200, body: successBody() });
    const transport = createOpenRouterTransport({
      baseUrl: fake.baseUrl,
      clock: makeClock(),
      random: () => 0,
    });
    await expectOpenRouterError(
      () =>
        transport.executeCall({
          db,
          accountId: "missing-account",
          logicalCallId: call.logicalCallId,
          apiKey: API_KEY,
          reservationUsd: "0.01",
        }),
      "INVALID_STATE",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects an active reservation smaller than the requested amount", async () => {
    const call = createCall(0);
    const attempt = createAttempt(db, {
      logicalCallId: call.logicalCallId,
      createdAt: CREATED_AT,
    });
    const admission = admitRequest(db, {
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      attemptId: attempt.attemptId,
      kind: "attempt",
      amountUsd: "0.005",
      createdAt: CREATED_AT,
    });
    expect(admission.admitted).toBe(true);
    const transport = createOpenRouterTransport({
      baseUrl: fake.baseUrl,
      clock: makeClock(),
      random: () => 0,
    });
    await expectOpenRouterError(
      () =>
        transport.executeCall({
          db,
          accountId: "test-account",
          logicalCallId: call.logicalCallId,
          apiKey: API_KEY,
          reservationUsd: "0.01",
        }),
      "INVALID_STATE",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects reusing a nonbilling reservation for a billing call", async () => {
    const call = createCall(0);
    const attempt = createAttempt(db, {
      logicalCallId: call.logicalCallId,
      createdAt: CREATED_AT,
    });
    const admission = admitRequest(db, {
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      attemptId: attempt.attemptId,
      kind: "nonbilling",
      amountUsd: "0",
      nonBilling: true,
      createdAt: CREATED_AT,
    });
    expect(admission.admitted).toBe(true);
    const transport = createOpenRouterTransport({
      baseUrl: fake.baseUrl,
      clock: makeClock(),
      random: () => 0,
    });
    await expectOpenRouterError(
      () =>
        transport.executeCall({
          db,
          accountId: "test-account",
          logicalCallId: call.logicalCallId,
          apiKey: API_KEY,
          reservationUsd: "0.01",
        }),
      "INVALID_STATE",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("shares one prepared attempt across contending connections", async () => {
    const call = createCall(0);
    const readyPath = join(tempDirectory, "attempt-ready");
    const goPath = join(tempDirectory, "attempt-go");
    const resultPath = join(tempDirectory, "attempt-result.json");
    const errorPath = join(tempDirectory, "attempt-error.json");
    const script = `
      import { existsSync, writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const { openDatabase } = await import(
        pathToFileURL(process.cwd() + "/src/storage/database.ts").href
      );
      const { getOrCreatePreparedAttempt } = await import(
        pathToFileURL(process.cwd() + "/src/ai/ledger.ts").href
      );
      const db = openDatabase(process.env.DB_PATH);
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = getOrCreatePreparedAttempt(db, process.env.CALL_ID);
        writeFileSync(process.env.READY_PATH, "ready");
        while (!existsSync(process.env.GO_PATH)) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        db.exec("COMMIT");
        writeFileSync(process.env.RESULT_PATH, JSON.stringify(result));
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        writeFileSync(
          process.env.ERROR_PATH,
          JSON.stringify({
            code: error && error.code ? error.code : null,
            message: String(error),
          }),
        );
      } finally {
        db.close();
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_PATH: join(tempDirectory, "experiment.sqlite"),
          READY_PATH: readyPath,
          GO_PATH: goPath,
          RESULT_PATH: resultPath,
          ERROR_PATH: errorPath,
          CALL_ID: call.logicalCallId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath)) {
        if (Date.now() > deadline) {
          throw new Error(`attempt worker did not become ready: ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(goPath, "go");
      const parentAttempt = getOrCreatePreparedAttempt(db, call.logicalCallId);
      const exitCode = await exited;
      if (existsSync(errorPath)) {
        const workerError = JSON.parse(readFileSync(errorPath, "utf8")) as {
          code: string | null;
          message: string;
        };
        throw new Error(`attempt worker failed: ${workerError.code} ${workerError.message}`);
      }
      if (exitCode !== 0 || !existsSync(resultPath)) {
        throw new Error(`attempt worker exited ${String(exitCode)}: ${stderr}`);
      }
      const workerAttempt = JSON.parse(readFileSync(resultPath, "utf8")) as {
        attemptId: string;
      };
      expect(parentAttempt.attemptId).toBe(workerAttempt.attemptId);
      expect(listAttempts(db, call.logicalCallId)).toHaveLength(1);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  }, 15000);

  it("does not resend an attempt that is already dispatching", async () => {
    const call = createCall(0);
    const attempt = createAttempt(db, {
      logicalCallId: call.logicalCallId,
      createdAt: CREATED_AT,
    });
    const admission = admitRequest(db, {
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      attemptId: attempt.attemptId,
      kind: "attempt",
      amountUsd: "0.01",
      createdAt: CREATED_AT,
    });
    expect(admission.admitted).toBe(true);
    markAttemptDispatching(db, attempt.attemptId, CREATED_AT);
    fake.enqueue({ status: 200, body: successBody() });
    const transport = createOpenRouterTransport({
      baseUrl: fake.baseUrl,
      clock: makeClock(),
      random: () => 0,
    });
    const result = await transport.executeCall({
      db,
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      apiKey: API_KEY,
      reservationUsd: "0.01",
    });
    expect(result.outcome).toBe("already_dispatching");
    expect(result.error?.code).toBe("RESUME_UNCERTAIN");
    expect(fake.requests).toHaveLength(0);
  });

  it("keeps generation ID, content, and cost when an unrelated nested field is malformed", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 200,
      body: successBody({
        usage: {
          prompt_tokens: null,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.001,
        },
      }),
    });
    const { result } = await execute(0, { clock });
    expect(result.outcome).toBe("success");
    expect(result.generationId).toBe("gen-1");
    expect(result.actualCostUsd).toBe("0.001");
    expect(result.parsedContent).toEqual({ answer: "ok" });
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.001");
  });

  it("redacts an API key echoed inside assistant content", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 200,
      body: successBody({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ answer: API_KEY }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    });
    const { result } = await execute(0, { clock });
    expect(result.outcome).toBe("success");
    expect(result.content).not.toContain(API_KEY);
    expect(result.parsedContent).toEqual({ answer: REDACTED });
    expect(containsSecret(result, [API_KEY])).toBe(false);
    assertNoSecretInDatabase(API_KEY);
  });

  it("persists a long Retry-After and refuses an immediate redispatch", async () => {
    const clock = makeClock();
    const call = createCall(0);
    const transport = createOpenRouterTransport({
      baseUrl: fake.baseUrl,
      clock,
      random: () => 0,
    });
    fake.enqueue({
      status: 429,
      headers: { "retry-after": "31" },
      body: { error: { code: 429, message: "rate limited" } },
    });
    const first = await transport.executeCall({
      db,
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      apiKey: API_KEY,
      reservationUsd: "0.01",
    });
    expect(first.outcome).toBe("paused_retry_after");
    expect(getLogicalCall(db, call.logicalCallId).retryNotBefore).not.toBeNull();
    fake.enqueue({ status: 200, body: successBody() });
    const second = await transport.executeCall({
      db,
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      apiKey: API_KEY,
      reservationUsd: "0.01",
    });
    expect(second.outcome).toBe("paused_retry_after");
    expect(fake.requests).toHaveLength(1);
    await clock.sleep(31_000);
    fake.enqueue({ status: 200, body: successBody() });
    const third = await transport.executeCall({
      db,
      accountId: "test-account",
      logicalCallId: call.logicalCallId,
      apiKey: API_KEY,
      reservationUsd: "0.01",
    });
    expect(third.outcome).toBe("success");
    expect(fake.requests).toHaveLength(2);
    expect(getLogicalCall(db, call.logicalCallId).retryNotBefore).toBeNull();
  });

  it("retries only a certified 429 with identical bytes and the 500 ms base delay", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 429,
      body: { error: { code: 429, message: "rate limited" } },
    });
    fake.enqueue({ status: 200, body: successBody() });
    const { call, result } = await execute(0, { clock });

    expect(result.outcome).toBe("success");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      outcome: "refused_unprocessed",
      retryDelayMs: 500,
    });
    expect(result.attempts[1]).toMatchObject({
      outcome: "success",
      attemptNumber: 2,
    });
    expect(clock.sleeps).toEqual([500]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.body).toBe(fake.requests[1]?.body);
    const attempts = listAttempts(db, call.logicalCallId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.requestHash).toBe(attempts[1]?.requestHash);
    expect(attempts[0]?.state).toBe("refused_unprocessed");
    expect(attempts[1]?.state).toBe("validated");
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.001");
    expect(account.reservedUsd).toBe("0");
  });

  it("retries a no-provider 503 and honors a short Retry-After", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 503,
      headers: { "retry-after": "1" },
      body: {
        error: {
          code: "no_eligible_provider",
          message: "No eligible provider exists",
        },
      },
    });
    fake.enqueue({ status: 200, body: successBody() });
    const { result } = await execute(0, { clock });
    expect(result.outcome).toBe("success");
    expect(result.attempts).toHaveLength(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("pauses instead of shortening a long Retry-After", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 429,
      headers: { "retry-after": "31" },
      body: { error: { code: 429, message: "rate limited" } },
    });
    const { call, result } = await execute(0, { clock });
    expect(result.outcome).toBe("paused_retry_after");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("refused_unprocessed");
    expect(clock.sleeps).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    const attempts = listAttempts(db, call.logicalCallId);
    expect(attempts[0]?.state).toBe("refused_unprocessed");
    const account = getBudgetAccount(db, "test-account");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
  });

  it("does not retry 401, 402, or 403", async () => {
    const clock = makeClock();
    for (const [index, status] of [401, 402, 403].entries()) {
      fake.enqueue({
        status,
        body: { error: { code: status, message: "authentication failed" } },
      });
      const { result } = await execute(index, { clock });
      expect(result.outcome).toBe("failed_known");
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.httpStatus).toBe(status);
    }
    expect(fake.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([]);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0");
    expect(account.reservedUsd).toBe("0.03");
    expect(account.unknownExposureUsd).toBe("0.03");
  });

  it("marks generic 5xx, HTTP-200 error bodies, and provider errors after a generation ID uncertain", async () => {
    const clock = makeClock();
    fake.enqueue({ status: 500, body: { error: { code: 500, message: "upstream" } } });
    const first = await execute(0, { clock });
    expect(first.result.outcome).toBe("uncertain");
    expect(first.result.attempts).toHaveLength(1);

    fake.enqueue({ status: 502, body: { error: { code: 502, message: "bad gateway" } } });
    const second = await execute(1, { clock });
    expect(second.result.outcome).toBe("uncertain");
    expect(second.result.attempts).toHaveLength(1);

    fake.enqueue({
      status: 200,
      body: { error: { code: 500, message: `upstream rejected ${API_KEY}` } },
    });
    const third = await execute(2, { clock });
    expect(third.result.outcome).toBe("uncertain");
    expect(third.result.attempts).toHaveLength(1);
    expect(third.result.error?.message).not.toContain(API_KEY);
    assertNoSecretInDatabase(API_KEY);

    fake.enqueue({
      status: 200,
      body: {
        id: "gen-rate",
        error: { code: 429, message: "provider rate limited after generation" },
        choices: [],
      },
    });
    const fourth = await execute(3, { clock });
    expect(fourth.result.outcome).toBe("uncertain");
    expect(fourth.result.generationId).toBe("gen-rate");
    expect(fourth.result.attempts).toHaveLength(1);
    expect(fake.requests).toHaveLength(4);
    expect(clock.sleeps).toEqual([]);
    const account = getBudgetAccount(db, "test-account");
    expect(account.reservedUsd).toBe("0.04");
    expect(account.unknownExposureUsd).toBe("0.04");
  });

  it("does not retry a 429 that already has a generation ID or usage", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 429,
      body: {
        id: "gen-429",
        choices: [],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 0,
          total_tokens: 1,
          cost: 0.001,
        },
      },
    });
    const { result } = await execute(0, { clock });
    expect(result.outcome).toBe("uncertain");
    expect(result.generationId).toBe("gen-429");
    expect(result.attempts).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.001");
    expect(account.reservedUsd).toBe("0");
  });

  it("treats non-JSON content as a known failure while settling its actual cost", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 200,
      body: {
        id: "gen-invalid-json",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "not-json" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          cost: 0.002,
        },
      },
    });
    const { result } = await execute(0, { clock });
    expect(result.outcome).toBe("failed_known");
    expect(result.attempts).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.002");
    expect(account.reservedUsd).toBe("0");
  });

  it("marks timeouts and disconnects uncertain without retrying", async () => {
    const clock = makeClock();
    fake.enqueue({ hang: true });
    const timeout = await execute(0, { clock, deadlineMs: 50 });
    expect(timeout.result.outcome).toBe("uncertain");
    expect(timeout.result.attempts).toHaveLength(1);
    expect(timeout.result.attempts[0]?.errorCode).toBe("NETWORK_TIMEOUT");

    fake.enqueue({ destroy: true });
    const disconnect = await execute(1, { clock });
    expect(disconnect.result.outcome).toBe("uncertain");
    expect(disconnect.result.attempts).toHaveLength(1);
    expect(disconnect.result.attempts[0]?.errorCode).toBe("NETWORK_DISCONNECT");
    expect(clock.sleeps).toEqual([]);
    expect(fake.requests).toHaveLength(2);
    const account = getBudgetAccount(db, "test-account");
    expect(account.unknownExposureUsd).toBe("0.02");
  });

  it("treats content refusal and reasoning-only length output as known failures", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 200,
      body: {
        id: "gen-refusal",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: "I cannot help with that.",
            },
            finish_reason: "content_filter",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 0,
          total_tokens: 10,
          cost: 0.002,
        },
      },
    });
    const refusal = await execute(0, { clock });
    expect(refusal.result.outcome).toBe("failed_known");
    expect(refusal.result.attempts).toHaveLength(1);

    fake.enqueue({
      status: 200,
      body: {
        id: "gen-length",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              reasoning: "still thinking",
            },
            finish_reason: "length",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.003,
        },
      },
    });
    const length = await execute(1, { clock });
    expect(length.result.outcome).toBe("failed_known");
    expect(length.result.attempts).toHaveLength(1);
    expect(listAttempts(db, length.call.logicalCallId)[0]?.partialCompletion).toBe(true);
    expect(fake.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([]);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.005");
    expect(account.reservedUsd).toBe("0");
  });

  it("handles malformed bodies, missing cost, and oversized responses", async () => {
    const clock = makeClock();
    fake.enqueue({ status: 200, body: "not json" });
    const malformed = await execute(0, { clock });
    expect(malformed.result.outcome).toBe("failed_known");
    expect(malformed.result.attempts).toHaveLength(1);

    fake.enqueue({
      status: 200,
      body: successBody({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    const missingCost = await execute(1, { clock });
    expect(missingCost.result.outcome).toBe("success");
    expect(missingCost.result.costStatus).toBe("unknown");
    expect(missingCost.result.attempts).toHaveLength(1);

    const oversizedBody = Buffer.alloc(2 * 1024 * 1024 + 1, 65);
    fake.enqueue({ status: 200, body: oversizedBody });
    const oversized = await execute(2, { clock });
    expect(oversized.result.outcome).toBe("uncertain");
    expect(oversized.result.attempts).toHaveLength(1);
    const artifactId = oversized.result.attempts[0]?.responseArtifactId;
    if (artifactId === null || artifactId === undefined) {
      throw new Error("expected a raw response artifact");
    }
    const raw = getRawArtifactBytes(artifactId);
    expect(raw.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(fake.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([]);
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0");
    expect(account.reservedUsd).toBe("0.03");
    expect(account.unknownExposureUsd).toBe("0.03");
  });

  it("stops after three attempts and never makes a fourth request", async () => {
    const clock = makeClock();
    for (let index = 0; index < 3; index += 1) {
      fake.enqueue({
        status: 429,
        body: { error: { code: 429, message: "rate limited" } },
      });
    }
    const { call, result } = await execute(0, { clock });
    expect(result.outcome).toBe("refused_unprocessed");
    expect(result.attempts).toHaveLength(3);
    expect(fake.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([500, 1000]);
    const attempts = listAttempts(db, call.logicalCallId);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.state === "refused_unprocessed")).toBe(true);
    const account = getBudgetAccount(db, "test-account");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
  });

  it("rejects invalid OpenRouter request shapes before any fetch", async () => {
    const clock = makeClock();
    const bothCaps = makeRequest({ max_completion_tokens: 512 });
    const noCap = makeRequest();
    delete noCap.max_tokens;
    const cases: Array<[number, Record<string, unknown>]> = [
      [0, makeRequest({ stream: true })],
      [1, bothCaps],
      [2, noCap],
      [3, makeRequest({ tools: [] })],
    ];
    for (const [index, requestBody] of cases) {
      const call = createCall(index, requestBody);
      const transport = createOpenRouterTransport({ baseUrl: fake.baseUrl, clock });
      await expectOpenRouterError(
        () =>
          transport.executeCall({
            db,
            accountId: "test-account",
            logicalCallId: call.logicalCallId,
            apiKey: API_KEY,
            reservationUsd: "0.01",
          }),
        "INVALID_REQUEST",
      );
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("reconciles a missing actual cost through the bounded generation endpoint", async () => {
    const clock = makeClock();
    fake.enqueue({
      status: 200,
      body: successBody({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });
    const { result, transport } = await execute(0, { clock });
    expect(result.costStatus).toBe("unknown");
    const attemptId = result.attempts[0]?.attemptId;
    if (attemptId === undefined) {
      throw new Error("expected an attempt");
    }
    fake.enqueue({
      status: 200,
      body: {
        data: {
          total_cost: 0.004,
          tokens_prompt: 10,
          tokens_completion: 5,
          tokens_total: 15,
        },
      },
    });
    const reconciled = await transport.reconcileGeneration({
      db,
      attemptId,
      apiKey: API_KEY,
    });
    expect(reconciled.actualCostUsd).toBe("0.004");
    expect(reconciled.reservationSettled).toBe(true);
    const attempt = getAttempt(db, attemptId);
    expect(attempt.actualCostUsd).toBe("0.004");
    expect(attempt.costStatus).toBe("known");
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.004");
    expect(account.reservedUsd).toBe("0");
    expect(account.unknownExposureUsd).toBe("0");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.method).toBe("GET");
    expect(fake.requests[1]?.url).toBe("/api/v1/generation?id=gen-1");
    assertNoSecretInDatabase(API_KEY);
  });

  it("refuses to reconcile an attempt that already has a known cost", async () => {
    const clock = makeClock();
    fake.enqueue({ status: 200, body: successBody() });
    const { result, transport } = await execute(0, { clock });
    expect(result.costStatus).toBe("known");
    const attemptId = result.attempts[0]?.attemptId;
    if (attemptId === undefined) {
      throw new Error("expected an attempt");
    }
    fake.enqueue({
      status: 200,
      body: { data: { total_cost: 0.004 } },
    });
    await expectOpenRouterError(
      () => transport.reconcileGeneration({ db, attemptId, apiKey: API_KEY }),
      "RECONCILIATION_FAILED",
    );
    expect(getAttempt(db, attemptId).actualCostUsd).toBe("0.001");
    const account = getBudgetAccount(db, "test-account");
    expect(account.knownActualUsd).toBe("0.001");
  });
});

describe("retry policy and redaction", () => {
  it("parses Retry-After and applies the allowlisted retry policy", () => {
    expect(parseRetryAfter("1")).toBe(1);
    expect(
      parseRetryAfter(
        "Wed, 21 Oct 2015 07:28:00 GMT",
        new Date("2015-10-21T07:27:00Z"),
      ),
    ).toBe(60);
    expect(parseRetryAfter("not-a-date")).toBeNull();
    const base = {
      attemptNumber: 1,
      httpStatus: 429,
      generationId: null,
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
      errorClassification: "rate_limit",
      partialCompletion: false,
      actualCostUsd: null,
      retryAfterSeconds: null,
      random: () => 0,
    };
    expect(decideRetry(base)).toEqual({ retry: true, delayMs: 500 });
    expect(decideRetry({ ...base, attemptNumber: 2 })).toEqual({
      retry: true,
      delayMs: 1000,
    });
    expect(decideRetry({ ...base, retryAfterSeconds: 1 })).toEqual({
      retry: true,
      delayMs: 1000,
    });
    expect(decideRetry({ ...base, retryAfterSeconds: 31 })).toEqual({
      retry: false,
      reason: "retry_after_too_long",
    });
    expect(decideRetry({ ...base, httpStatus: 401 })).toEqual({
      retry: false,
      reason: "not_allowlisted",
    });
    expect(
      decideRetry({
        ...base,
        httpStatus: 503,
        errorClassification: "no_eligible_provider",
      }),
    ).toEqual({ retry: true, delayMs: 500 });
    expect(
      decideRetry({
        ...base,
        httpStatus: 503,
        errorClassification: "http_503",
      }),
    ).toEqual({ retry: false, reason: "not_allowlisted" });
    expect(decideRetry({ ...base, attemptNumber: 3 })).toEqual({
      retry: false,
      reason: "attempt_limit",
    });
  });

  it("redacts text, nested values, headers, and asserts no secrets", () => {
    const secret = "sk-secret";
    expect(redactText(`Bearer ${secret}`, [secret])).toBe(`Bearer ${REDACTED}`);
    expect(
      redactValue(
        { authorization: `Bearer ${secret}`, nested: { value: secret } },
        [secret],
      ),
    ).toEqual({
      authorization: REDACTED,
      nested: { value: REDACTED },
    });
    expect(redactHeaders({ authorization: `Bearer ${secret}` }, [secret])).toEqual({
      authorization: REDACTED,
    });
    expect(() => assertNoSecrets({ value: secret }, [secret])).toThrow();
    expect(() => assertNoSecrets({ value: "safe" }, [secret])).not.toThrow();
  });
});
