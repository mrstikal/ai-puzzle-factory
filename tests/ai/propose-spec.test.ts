import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetAccount } from "../../src/ai/budget.js";
import {
  getLogicalCall,
  listAttempts,
  listRequestEvents,
} from "../../src/ai/ledger.js";
import {
  createOpenRouterTransport,
} from "../../src/ai/openrouter.js";
import type { ResolvedRoute } from "../../src/ai/preflight.js";
import {
  SpecProposalError,
  buildSpecProposalMessages,
  proposeSpec,
  specProposalMetadataForFamily,
} from "../../src/ai/propose-spec.js";
import {
  FAMILY_SPEC_JSON_SCHEMAS,
  familySpecEnvelopeJsonSchema,
  strictSchemaHash,
} from "../../src/ai/schemas.js";
import {
  FAMILIES,
  type Difficulty,
  type Family,
} from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getSlot,
  getStageResult,
} from "../../src/storage/repository.js";
import {
  createFakeOpenRouter,
  type FakeOpenRouter,
} from "../helpers/fake-openrouter.js";
import { allowLocalFake } from "../setup.js";
import { sha256Hex } from "../../src/util/hash.js";

const FULL_PLAN = buildPlanManifest({ runKind: "full" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p26-test-secret-do-not-persist";

let tempDirectory: string;
let db: Database.Database;
let fake: FakeOpenRouter;
let transport: ReturnType<typeof createOpenRouterTransport>;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function specRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  const responseFormat = FAMILY_SPEC_JSON_SCHEMAS.ranking;
  return {
    role: "spec",
    model: "test/model",
    providerTag: "test-provider",
    providerName: "Test Provider",
    endpointTag: "test-provider",
    outputCapField: "max_tokens",
    maxOutputTokens: 8192,
    minPromptTokens: 16_384,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: { prompt: "0.000001", completion: "0.000002" },
    requiresImage: false,
    imageInputDeclared: false,
    visionProbeRequired: false,
    responseFormat,
    schemaHash: strictSchemaHash(responseFormat),
    settings: {},
    ...overrides,
  };
}

function testSeed(label: string): string {
  return sha256Hex(`p26-test:${label}`);
}

function slotsForFamily(family: Family) {
  return FULL_PLAN.slots.filter((slot) => slot.family === family);
}

function slotFor(family: Family, difficulty?: Difficulty) {
  const slot = FULL_PLAN.slots.find(
    (candidate) =>
      candidate.family === family &&
      (difficulty === undefined || candidate.difficulty === difficulty),
  );
  if (slot === undefined) {
    throw new Error(`full plan has no ${family} slot at difficulty ${String(difficulty)}`);
  }
  return slot;
}

function successBody(content: unknown): Record<string, unknown> {
  return {
    id: "gen-p26",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify(content),
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
    },
  };
}

function failureBody(
  finishReason: string,
  content: string | null,
  refusal: string | null = null,
): Record<string, unknown> {
  return {
    id: "gen-p26-failure",
    model: "test/model",
    provider: "test-provider",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      cost: 0.001,
    },
  };
}

function proposeFor(
  family: Family,
  difficulty: Difficulty,
  slotId = slotFor(family, difficulty).slotId,
  route: ResolvedRoute = specRoute(),
) {
  return proposeSpec({
    db,
    accountId: "test-account",
    apiKey: API_KEY,
    transport,
    runId: RUN_ID,
    slotId,
    family,
    difficulty,
    route,
    reservationUsd: "0.01",
    clock,
  });
}

async function expectSpecError(
  action: Promise<unknown>,
  code: string,
): Promise<SpecProposalError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(SpecProposalError);
    const proposalError = error as SpecProposalError;
    expect(proposalError.code).toBe(code);
    return proposalError;
  }
  throw new Error(`expected SpecProposalError ${code}`);
}

function rawArtifactBytes(artifactId: number): Buffer {
  const row = db
    .prepare("SELECT bytes FROM artifacts WHERE artifact_id = ?")
    .get(artifactId) as { bytes: Buffer } | undefined;
  if (row === undefined) {
    throw new Error(`missing raw artifact ${artifactId}`);
  }
  return row.bytes;
}

function expectPlanned(slotId: string): void {
  expect(getSlot(db, RUN_ID, slotId).stage).toBe("planned");
  expect(() => getStageResult(db, RUN_ID, slotId, "spec_ready")).toThrow();
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p26-"));
  db = openDatabase(join(tempDirectory, "experiment.sqlite"));
  migrate(db);
  createRun(db, {
    runId: RUN_ID,
    plan: FULL_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId: "test-account",
    runId: RUN_ID,
    runKind: "full",
    maxCostUsd: "10",
    createdAt: CREATED_AT,
  });
  fake = await createFakeOpenRouter();
  allowLocalFake(fake.baseUrl);
  transport = createOpenRouterTransport({
    baseUrl: fake.baseUrl,
    clock,
    random: () => 0,
  });
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

describe("one-shot spec proposal", () => {
  it("accepts a valid spec for every family and saves prompt/schema provenance", async () => {
    for (const family of FAMILIES) {
      const slot = slotsForFamily(family)[0];
      if (slot === undefined) {
        throw new Error(`full plan has no slot for ${family}`);
      }
      const engine = productionRegistry.getEngine(family);
      const spec = engine.generateSpec(testSeed(`valid-${family}`), slot.difficulty);
      fake.enqueue({ status: 200, body: successBody({ family, spec }) });

      const result = await proposeFor(family, slot.difficulty, slot.slotId);
      expect(result.family).toBe(family);
      expect(result.spec).toEqual(spec);
      expect(result.proposal.schemaName).toBe(
        familySpecEnvelopeJsonSchema(family).name,
      );
      expect(result.proposal.schemaHash).toBe(
        strictSchemaHash(familySpecEnvelopeJsonSchema(family)),
      );
      expect(result.proposal.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.actualCostUsd).toBe("0.001");
      expect(result.attempts).toHaveLength(1);
      expect(getSlot(db, RUN_ID, slot.slotId).stage).toBe("spec_ready");

      const stage = getStageResult(db, RUN_ID, slot.slotId, "spec_ready");
      const payload = stage.payload as {
        spec: unknown;
        proposal: {
          promptVersion: string;
          promptHash: string;
          schemaName: string;
          schemaVersion: string;
          schemaHash: string;
          logicalCallId: string;
        };
        formal: { solutionCount: number; answerCount: number };
      };
      expect(payload.spec).toEqual(spec);
      expect(payload.proposal.promptVersion).toBe("v1");
      expect(payload.proposal.promptHash).toBe(result.proposal.promptHash);
      expect(payload.proposal.schemaVersion).toBe("v1");
      expect(payload.proposal.schemaHash).toBe(result.proposal.schemaHash);
      expect(payload.proposal.logicalCallId).toBe(result.logicalCallId);
      expect(payload.formal).toMatchObject({ solutionCount: 1, answerCount: 1 });

      const call = getLogicalCall(db, result.logicalCallId);
      expect(call.expectedSchemaHash).toBe(result.proposal.schemaHash);
      const requestBody = call.requestBody as {
        messages: Array<{ role: string; content: string }>;
        response_format: { json_schema: { name: string; strict: boolean } };
        provider: { only: string[]; allow_fallbacks: boolean; require_parameters: boolean };
        max_tokens: number;
      };
      expect(requestBody.response_format.json_schema.name).toBe(
        result.proposal.schemaName,
      );
      expect(requestBody.response_format.json_schema.strict).toBe(true);
      expect(requestBody.provider).toEqual({
        only: ["test-provider"],
        allow_fallbacks: false,
        require_parameters: true,
      });
      expect(requestBody.max_tokens).toBe(8192);
      const system = requestBody.messages[0]?.content ?? "";
      expect(system).toContain("prompt_version: v1");
      expect(system).toContain(`prompt_hash: ${result.proposal.promptHash}`);
      expect(system).toContain(`schema_name: ${result.proposal.schemaName}`);
      expect(system).toContain("schema_version: v1");
      expect(system).toContain(`schema_hash: ${result.proposal.schemaHash}`);

      const metadataEvent = listRequestEvents(db, result.logicalCallId).find(
        (event) => event.eventType === "proposal_metadata",
      );
      expect(metadataEvent).toBeDefined();
      expect(metadataEvent?.payload).toMatchObject({
        family,
        difficulty: slot.difficulty,
        promptVersion: "v1",
        schemaName: result.proposal.schemaName,
        schemaVersion: "v1",
        promptHash: result.proposal.promptHash,
        schemaHash: result.proposal.schemaHash,
      });

      const sent = JSON.parse(fake.requests.at(-1)?.body ?? "null") as {
        response_format: { json_schema: { name: string } };
      };
      expect(sent.response_format.json_schema.name).toBe(result.proposal.schemaName);
    }
    expect(fake.requests).toHaveLength(FAMILIES.length);
  });

  it("rejects an invalid schema for every family and leaves the slot planned", async () => {
    for (const family of FAMILIES) {
      const slot = slotsForFamily(family)[1];
      if (slot === undefined) {
        throw new Error(`full plan has no second slot for ${family}`);
      }
      fake.enqueue({ status: 200, body: successBody({ family, spec: {} }) });
      const error = await expectSpecError(
        proposeFor(family, slot.difficulty, slot.slotId),
        "SCHEMA_INVALID",
      );
      expect(error.issues.length).toBeGreaterThan(0);
      expect(error.logicalCallId).not.toBeNull();
      if (error.logicalCallId === null) {
        throw new Error("schema failure did not expose a logical call");
      }
      const attempts = listAttempts(db, error.logicalCallId);
      expect(attempts).toHaveLength(1);
      const artifactId = attempts[0]?.rawResponseArtifactId;
      expect(artifactId).not.toBeNull();
      if (artifactId === null || artifactId === undefined) {
        throw new Error("schema failure did not save a raw response");
      }
      const rawResponse = JSON.parse(
        rawArtifactBytes(artifactId).toString("utf8"),
      ) as { choices: Array<{ message: { content: string } }> };
      expect(rawResponse.choices[0]?.message.content).toBe(
        `{"family":"${family}","spec":{}}`,
      );
      expect(attempts[0]?.actualCostUsd).toBe("0.001");
      expectPlanned(slot.slotId);
    }
    expect(fake.requests).toHaveLength(FAMILIES.length);
  });

  it("rejects a response for the wrong family", async () => {
    const slot = slotFor("ranking", 1);
    const matchingSpec = productionRegistry
      .getEngine("matching")
      .generateSpec(testSeed("wrong-family"), 1);
    fake.enqueue({
      status: 200,
      body: successBody({ family: "matching", spec: matchingSpec }),
    });
    const error = await expectSpecError(
      proposeFor("ranking", 1, slot.slotId),
      "WRONG_FAMILY",
    );
    expect(error.logicalCallId).not.toBeNull();
    expectPlanned(slot.slotId);
  });

  it("rejects out-of-domain IDs, extra answer keys, options, and prose", async () => {
    const slot = slotFor("ranking", 1);
    fake.enqueue({
      status: 200,
      body: successBody({
        family: "ranking",
        spec: {
          size: 4,
          clues: [{ kind: "at", item: 9, position: 1 }],
        },
      }),
    });
    const outOfDomain = await expectSpecError(
      proposeFor("ranking", 1, slot.slotId),
      "SCHEMA_INVALID",
    );
    expect(outOfDomain.issues.join(" ")).toContain("outside");
    expectPlanned(slot.slotId);

    const slot2 = slotFor("ranking", 2);
    fake.enqueue({
      status: 200,
      body: successBody({
        family: "ranking",
        spec: {
          size: 5,
          clues: [
            { kind: "before", before: 0, after: 1 },
            { kind: "before", before: 1, after: 2 },
            { kind: "before", before: 2, after: 3 },
          ],
        },
        answer: "A",
        options: ["A", "B"],
        prose: "Solve this.",
      }),
    });
    const extra = await expectSpecError(
      proposeFor("ranking", 2, slot2.slotId),
      "FORBIDDEN_FIELD",
    );
    expect(extra.issues).toEqual(
      expect.arrayContaining(["answer", "options", "prose"]),
    );
    expect(extra.logicalCallId).not.toBeNull();
    expect(extra.attemptIds).toHaveLength(1);
    expect(extra.result?.outcome).toBe("success");
    expectPlanned(slot2.slotId);
  });

  it("rejects unsatisfiable and multiple-solution specs", async () => {
    const unsatSlot = slotFor("ranking", 1);
    fake.enqueue({
      status: 200,
      body: successBody({
        family: "ranking",
        spec: {
          size: 4,
          clues: [
            { kind: "at", item: 0, position: 1 },
            { kind: "at", item: 0, position: 2 },
            { kind: "at", item: 1, position: 1 },
          ],
        },
      }),
    });
    await expectSpecError(
      proposeFor("ranking", 1, unsatSlot.slotId),
      "UNSAT",
    );
    expectPlanned(unsatSlot.slotId);

    const multipleSlot = slotFor("ranking", 2);
    fake.enqueue({
      status: 200,
      body: successBody({
        family: "ranking",
        spec: {
          size: 5,
          clues: [
            { kind: "before", before: 0, after: 1 },
            { kind: "before", before: 0, after: 2 },
            { kind: "before", before: 0, after: 3 },
          ],
        },
      }),
    });
    await expectSpecError(
      proposeFor("ranking", 2, multipleSlot.slotId),
      "MULTIPLE_SOLUTIONS",
    );
    expectPlanned(multipleSlot.slotId);
  });

  it("rejects refusal and truncation with one saved content proposal", async () => {
    const refusalSlot = slotFor("ranking", 1);
    fake.enqueue({
      status: 200,
      body: failureBody("content_filter", null, "I cannot comply."),
    });
    const refusal = await expectSpecError(
      proposeFor("ranking", 1, refusalSlot.slotId),
      "TRANSPORT_FAILED",
    );
    expect(refusal.result?.outcome).toBe("failed_known");
    expect(refusal.attemptIds).toHaveLength(1);
    expect(refusal.result?.attempts[0]?.responseArtifactId).not.toBeNull();
    expect(fake.requests).toHaveLength(1);
    expectPlanned(refusalSlot.slotId);

    const truncationSlot = slotFor("ranking", 2);
    fake.enqueue({
      status: 200,
      body: failureBody("length", '{"family":"ranking","spec":'),
    });
    const truncation = await expectSpecError(
      proposeFor("ranking", 2, truncationSlot.slotId),
      "TRANSPORT_FAILED",
    );
    expect(truncation.result?.outcome).toBe("failed_known");
    expect(fake.requests).toHaveLength(2);
    expectPlanned(truncationSlot.slotId);
  });

  it("rejects out-of-bounds difficulty for every family", async () => {
    for (const family of FAMILIES) {
      const slot = slotFor(family, 1);
      const engine = productionRegistry.getEngine(family);
      let invalidSpec: unknown;
      switch (family) {
        case "ranking":
          invalidSpec = engine.generateSpec(testSeed("difficulty-ranking"), 2);
          break;
        case "matching":
        case "scheduling": {
          const generated = engine.generateSpec(testSeed(`difficulty-${family}`), 1) as {
            clues: unknown[];
          };
          invalidSpec = { clues: generated.clues.slice(0, 4) };
          break;
        }
        case "truth":
          invalidSpec = engine.generateSpec(testSeed("difficulty-truth"), 2);
          break;
        case "arithmetic": {
          const generated = engine.generateSpec(testSeed("difficulty-arithmetic"), 1) as {
            allDifferent: boolean;
            constraints: Array<{
              coeffs: [number, number, number];
              op: string;
              constant: number;
            }>;
          };
          invalidSpec = {
            ...generated,
            constraints: generated.constraints.map((constraint, index) =>
              index === 0
                ? { ...constraint, coeffs: [2, constraint.coeffs[1], constraint.coeffs[2]] }
                : constraint,
            ),
          };
          break;
        }
        case "matrix": {
          const generated = engine.generateSpec(testSeed("difficulty-matrix"), 1) as {
            rule: "xor";
            cells: [[number, number, number], [number, number, number], [number, number, null]];
          };
          invalidSpec = {
            ...generated,
            cells: [
              [7, generated.cells[0][1], generated.cells[0][2]],
              generated.cells[1],
              generated.cells[2],
            ],
          };
          break;
        }
        case "transforms":
          invalidSpec = engine.generateSpec(testSeed("difficulty-transforms"), 2);
          break;
        case "paths":
          invalidSpec = engine.generateSpec(testSeed("difficulty-paths"), 3);
          break;
        case "symmetry":
          invalidSpec = engine.generateSpec(testSeed("difficulty-symmetry"), 3);
          break;
        case "counting":
          invalidSpec = engine.generateSpec(testSeed("difficulty-counting"), 3);
          break;
      }
      fake.enqueue({
        status: 200,
        body: successBody({ family, spec: invalidSpec }),
      });
      const error = await expectSpecError(
        proposeFor(family, 1, slot.slotId),
        "DIFFICULTY_OUT_OF_BOUNDS",
      );
      expect(error.issues.length).toBeGreaterThan(0);
      expectPlanned(slot.slotId);
    }
    expect(fake.requests).toHaveLength(FAMILIES.length);
  });

  it("binds the symmetry axis to the requested difficulty", async () => {
    const slot = slotFor("symmetry", 1);
    const cells: Array<Array<"occupied" | "empty" | "unknown">> = [];
    for (let row = 0; row < 8; row += 1) {
      const line: Array<"occupied" | "empty" | "unknown"> = [];
      for (let column = 0; column < 8; column += 1) {
        line.push(row < 4 ? "empty" : "unknown");
      }
      cells.push(line);
    }
    cells[0]![0] = "occupied";
    cells[0]![1] = "occupied";
    cells[1]![0] = "occupied";
    cells[1]![1] = "occupied";
    fake.enqueue({
      status: 200,
      body: successBody({
        family: "symmetry",
        spec: { axis: "horizontal", cells },
      }),
    });
    const error = await expectSpecError(
      proposeFor("symmetry", 1, slot.slotId),
      "DIFFICULTY_OUT_OF_BOUNDS",
    );
    expect(error.issues.join(" ")).toContain("vertical axis");
    expectPlanned(slot.slotId);
  });

  it("reports a two-constraint level-3 arithmetic spec as a typed difficulty failure", async () => {
    const slot = slotFor("arithmetic", 3);
    fake.enqueue({
      status: 200,
      body: successBody({
        family: "arithmetic",
        spec: {
          allDifferent: false,
          constraints: [
            { coeffs: [1, 1, 1], op: "eq", constant: 36 },
            { coeffs: [3, 3, 3], op: "le", constant: 108 },
          ],
        },
      }),
    });
    const error = await expectSpecError(
      proposeFor("arithmetic", 3, slot.slotId),
      "DIFFICULTY_OUT_OF_BOUNDS",
    );
    expect(error.issues.join(" ")).toContain("nonredundant");
    expect(error.logicalCallId).not.toBeNull();
    expectPlanned(slot.slotId);
  });

  it("rejects a resolved route for another role before any request", async () => {
    const slot = slotFor("ranking", 1);
    const error = await expectSpecError(
      proposeFor("ranking", 1, slot.slotId, specRoute({ role: "blind_text" })),
      "ROUTE_ROLE_MISMATCH",
    );
    expect(error.logicalCallId).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expectPlanned(slot.slotId);
  });

  it("keeps prompt and schema metadata stable across calls", () => {
    const first = specProposalMetadataForFamily("ranking");
    const second = specProposalMetadataForFamily("ranking");
    const other = specProposalMetadataForFamily("matching");
    expect(first).toEqual(second);
    expect(first.promptHash).not.toBe(other.promptHash);
    expect(first.schemaHash).not.toBe(other.schemaHash);
    expect(first.promptVersion).toBe("v1");
    expect(first.schemaVersion).toBe("v1");

    const paths = buildSpecProposalMessages(
      "paths",
      1,
      specProposalMetadataForFamily("paths"),
    );
    const pathsUser = paths[1]?.content ?? "";
    expect(pathsUser).toContain("4x4");
    expect(pathsUser).not.toContain("5x5");

    const symmetry = buildSpecProposalMessages(
      "symmetry",
      1,
      specProposalMetadataForFamily("symmetry"),
    );
    expect(symmetry[1]?.content ?? "").toContain('"axis": "vertical"');
  });
});
