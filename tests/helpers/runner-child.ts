import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { getLogicalCall } from "../../src/ai/ledger.js";
import { createOpenRouterTransport } from "../../src/ai/openrouter.js";
import type { PlanManifest } from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { makeFixtureWording } from "../../src/presentation/wording.js";
import {
  buildMockRoutes,
  runSmokeCohort,
  type RunSmokeHooks,
} from "../../src/runner/run.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import { deriveStreamSeed } from "../../src/util/random.js";

export const LOOPBACK_API_KEY = "p36-loopback-key";

export type CrashPoint =
  | "none"
  | "before_dispatch"
  | "after_dispatch"
  | "after_response_saved"
  | "after_stage_commit"
  | "during_review";

interface FixtureShape {
  readonly valid: {
    readonly blind: Record<string, unknown>;
    readonly alignmentText: Record<string, unknown>;
    readonly alignmentVision: Record<string, unknown>;
  };
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../fixtures/mock/role-responses.json", import.meta.url),
    "utf8",
  ),
) as FixtureShape;

let paused = false;

export async function pauseAtMarker(markerPath: string): Promise<void> {
  if (paused) {
    return;
  }
  paused = true;
  writeFileSync(markerPath, "paused", "utf8");
  await new Promise<void>(() => undefined);
}

export function buildLoopbackResponses(
  plan: PlanManifest,
): Map<string, unknown> {
  const responses = new Map<string, unknown>();
  for (const slot of plan.slots) {
    const engine = productionRegistry.getEngine(slot.family);
    const specSeed = deriveStreamSeed({
      protocolVersion: plan.protocolVersion,
      rootSeed: plan.rootSeed,
      slotId: slot.slotId,
      purpose: "spec",
    });
    const optionsSeed = deriveStreamSeed({
      protocolVersion: plan.protocolVersion,
      rootSeed: plan.rootSeed,
      slotId: slot.slotId,
      purpose: "options",
    });
    const spec = engine.generateSpec(specSeed, slot.difficulty);
    const solve = engine.enumerateSolutions(spec);
    if (solve.correctAnswer === null) {
      throw new Error(`loopback fixture has no answer for ${slot.slotId}`);
    }
    const choices = engine.makeOptions(spec, solve.correctAnswer, optionsSeed);
    responses.set(`${slot.slotId}/spec`, { family: slot.family, spec });
    responses.set(
      `${slot.slotId}/wording`,
      makeFixtureWording(engine, spec).response,
    );
    responses.set(`${slot.slotId}/blind_text`, {
      ...FIXTURE.valid.blind,
      chosenOption: choices.correctLabel,
      visualLegibility: "not_applicable",
    });
    responses.set(`${slot.slotId}/blind_vision`, {
      ...FIXTURE.valid.blind,
      chosenOption: choices.correctLabel,
      visualLegibility: "legible",
    });
    responses.set(
      `${slot.slotId}/alignment_text`,
      FIXTURE.valid.alignmentText,
    );
    responses.set(
      `${slot.slotId}/alignment_vision`,
      FIXTURE.valid.alignmentVision,
    );
  }
  return responses;
}

export function chatEnvelope(content: unknown): Record<string, unknown> {
  return {
    id: "loopback",
    model: "mock/model",
    provider: "mock",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost: 0,
    },
  };
}

export interface LoopbackTransportOptions {
  readonly baseUrl: string;
  readonly db: Database.Database;
  readonly crashPoint?: CrashPoint;
  readonly markerPath?: string;
}

export function createLoopbackTransport(
  options: LoopbackTransportOptions,
): ReturnType<typeof createOpenRouterTransport> & {
  readonly isMock?: true;
} {
  const callContext = new AsyncLocalStorage<string>();
  const crashPoint = options.crashPoint ?? "none";
  const fetchImpl: typeof fetch = async (input, init) => {
    const logicalCallId = callContext.getStore();
    if (logicalCallId === undefined) {
      throw new Error("loopback fetch was called outside executeCall");
    }
    const call = getLogicalCall(options.db, logicalCallId);
    if (crashPoint === "after_dispatch") {
      await pauseAtMarker(options.markerPath as string);
    }
    const headers = new Headers(init?.headers);
    if (call.slotId !== null) {
      headers.set("x-p36-slot", call.slotId);
    }
    headers.set("x-p36-role", call.role);
    return fetch(input, { ...init, headers });
  };
  const base = createOpenRouterTransport({
    baseUrl: options.baseUrl,
    fetchImpl,
    ...(crashPoint === "after_response_saved"
      ? {
          afterResponseSaved: async () => {
            await pauseAtMarker(options.markerPath as string);
          },
        }
      : {}),
  });
  return {
    ...base,
    executeCall: async (input) => {
      if (crashPoint === "before_dispatch") {
        await pauseAtMarker(options.markerPath as string);
      }
      return callContext.run(input.logicalCallId, () => base.executeCall(input));
    },
    reconcileGeneration: base.reconcileGeneration,
  };
}

export async function waitForMarker(
  markerPath: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for crash marker ${markerPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing environment variable ${name}`);
  }
  return value;
}

export async function runChildFromEnv(): Promise<void> {
  const dbPath = env("P36_DB");
  const runId = env("P36_RUN_ID");
  const accountId = env("P36_ACCOUNT_ID");
  const baseUrl = env("P36_FAKE_URL");
  const crashPoint = env("P36_CRASH_POINT") as CrashPoint;
  const markerPath = env("P36_MARKER");
  const db = openDatabase(dbPath);
  migrate(db);
  try {
    const plan = buildPlanManifest({ runKind: "smoke" });
    const transport = createLoopbackTransport({
      baseUrl,
      db,
      crashPoint,
      markerPath,
    });
    const hooks: RunSmokeHooks = {
      onStageCommitted: async ({ stage }) => {
        if (crashPoint === "after_stage_commit" && stage === "presentation_ready") {
          await pauseAtMarker(markerPath);
        }
      },
      onSlotReviewed: async (slotId) => {
        if (crashPoint === "during_review" && slotId === "text-ranking-01") {
          await pauseAtMarker(markerPath);
        }
      },
    };
    await runSmokeCohort({
      db,
      runId,
      accountId,
      apiKey: LOOPBACK_API_KEY,
      transport,
      evidenceKind: "live",
      runKind: "smoke",
      routes: buildMockRoutes(),
      maxCostUsd: "10",
      plan,
      concurrency: 1,
      hooks,
    });
  } finally {
    db.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  runChildFromEnv().catch((error: unknown) => {
    process.stderr.write(
      `runner-child error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
