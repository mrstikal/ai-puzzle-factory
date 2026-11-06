import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBudgetAccount,
  getBudgetAccount,
} from "../../src/ai/budget.js";
import {
  createMockTransport,
  type MockTransport,
} from "../../src/ai/mock.js";
import type { ResolvedRoute } from "../../src/ai/preflight.js";
import {
  FAMILY_SPEC_JSON_SCHEMAS,
  WORDING_JSON_SCHEMA,
  strictSchemaHash,
} from "../../src/ai/schemas.js";
import {
  WORKFLOW_STAGES,
  type WorkflowStage,
} from "../../src/domain/candidate.js";
import type { Family, SvgFamily } from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { productionRegistry } from "../../src/families/registry.js";
import { fingerprintContentFor } from "../../src/presentation/assemble.js";
import { assertPngNoTextMetadata, hashPng } from "../../src/render/png.js";
import { serializeScene } from "../../src/render/svg.js";
import {
  FormalStagePayloadSchema,
  PREPARATION_FAILURE_STATUS,
  PREPARATION_READY_STATUS,
  type PreparationError,
  PreparationFailureStagePayloadSchema,
  SpecFirstStagePayloadSchema,
  prepareSlot,
  type PreparationResult,
} from "../../src/runner/prepare-slot.js";
import { getArtifact } from "../../src/storage/artifacts.js";
import { migrate, openDatabase } from "../../src/storage/database.js";
import {
  createRun,
  getSlot,
  getStageResult,
  listStageResults,
} from "../../src/storage/repository.js";
import {
  assertFingerprintConsistency,
  computeContentHash,
} from "../../src/validation/fingerprints.js";
import { sha256Hex } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";

const SMOKE_PLAN = buildPlanManifest({ runKind: "smoke" });
const RUN_ID = "123e4567-e89b-42d3-a456-426614174010";
const ACCOUNT_ID = "p33-smoke-account";
const CREATED_AT = "2026-11-05T00:00:00.000Z";
const API_KEY = "sk-p33-mock-secret-do-not-persist";

let tempDirectory: string;
let db: Database.Database;
let mock: MockTransport;

const clock = {
  now: () => new Date(CREATED_AT),
  sleep: async (_ms: number): Promise<void> => {},
};

function route(role: "spec" | "wording"): ResolvedRoute {
  const responseFormat =
    role === "spec" ? FAMILY_SPEC_JSON_SCHEMAS.ranking : WORDING_JSON_SCHEMA;
  return {
    role,
    model: "mock/model",
    routingPolicy: "balanced",
    compatibleEndpointTags: ["mock"],
    compatibleProviderNames: ["Mock Provider"],
    outputCapField: "max_tokens",
    maxOutputTokens: 8192,
    minPromptTokens: 16_384,
    contextLength: 131_072,
    maxPromptTokens: null,
    maxCompletionTokens: 16_384,
    supportedParameters: ["structured_outputs", "max_tokens"],
    pricing: { prompt: "0", completion: "0" },
    requiresImage: false,
    imageInputDeclared: false,
    visionProbeRequired: false,
    responseFormat,
    schemaHash: strictSchemaHash(responseFormat),
    settings: {},
  };
}

const SPEC_ROUTE = route("spec");
const WORDING_ROUTE = route("wording");

function slotFor(family: Family, lane: "spec_first" | "ai_spec") {
  const slot = SMOKE_PLAN.slots.find(
    (candidate) => candidate.family === family && candidate.lane === lane,
  );
  if (slot === undefined) {
    throw new Error(`smoke plan has no ${family}/${lane} slot`);
  }
  return slot;
}

function prepare(
  slotId: string,
  mockScenarioKinds?: Parameters<typeof prepareSlot>[0]["mockScenarioKinds"],
): Promise<PreparationResult> {
  return prepareSlot({
    db,
    runId: RUN_ID,
    slotId,
    accountId: ACCOUNT_ID,
    apiKey: API_KEY,
    transport: mock,
    routes: { spec: SPEC_ROUTE, wording: WORDING_ROUTE },
    reservations: { spec: "0.01", wording: "0.01" },
    ...(mockScenarioKinds === undefined ? {} : { mockScenarioKinds }),
    clock,
  });
}

function orderedStages(slotId: string) {
  return listStageResults(db, RUN_ID, slotId).sort(
    (left, right) =>
      WORKFLOW_STAGES.indexOf(left.stage as WorkflowStage) -
      WORKFLOW_STAGES.indexOf(right.stage as WorkflowStage),
  );
}

function count(sql: string, ...params: unknown[]): number {
  return (
    db.prepare(sql).get(...params) as {
      count: number;
    }
  ).count;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p33-"));
  db = openDatabase(join(tempDirectory, "experiment.sqlite"));
  migrate(db);
  createRun(db, {
    runId: RUN_ID,
    plan: SMOKE_PLAN,
    evidenceKind: "mock",
    createdAt: CREATED_AT,
  });
  createBudgetAccount(db, {
    accountId: ACCOUNT_ID,
    runId: RUN_ID,
    runKind: "smoke",
    maxCostUsd: "0",
    createdAt: CREATED_AT,
  });
  mock = createMockTransport({
    db,
    clock,
    random: () => 0,
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // The test may already have closed the database.
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("per-slot preparation", () => {
  it(
    "prepares one slot for every family and lane through the mock transport",
    async () => {
      for (const slot of SMOKE_PLAN.slots) {
        const engine = productionRegistry.getEngine(slot.family);
        const specSeed = deriveStreamSeed({
          protocolVersion: SMOKE_PLAN.protocolVersion,
          rootSeed: SMOKE_PLAN.rootSeed,
          slotId: slot.slotId,
          purpose: "spec",
        });
        const optionsSeed = deriveStreamSeed({
          protocolVersion: SMOKE_PLAN.protocolVersion,
          rootSeed: SMOKE_PLAN.rootSeed,
          slotId: slot.slotId,
          purpose: "options",
        });
        const layoutSeed = deriveStreamSeed({
          protocolVersion: SMOKE_PLAN.protocolVersion,
          rootSeed: SMOKE_PLAN.rootSeed,
          slotId: slot.slotId,
          purpose: "layout",
        });

        const result = await prepare(slot.slotId);
        expect(result.status).toBe(PREPARATION_READY_STATUS);
        expect(result.slotId).toBe(slot.slotId);
        expect(result.terminalVerdict).toBeNull();
        expect(result.failures).toEqual([]);
        expect(result.stages).toEqual([
          "spec_ready",
          "formal_checked",
          "presentation_ready",
        ]);
        expect(result.cost).toEqual({ actualCostUsd: "0", costStatus: "known" });
        expect(result.candidate.preparationStatus).toBe("ready");
        expect(result.candidate.formalPassed).toBe(true);
        expect(result.candidate.presentationCheckPassed).toBe(true);
        expect(result.candidate.terminalVerdict).toBeNull();
        expect(result.candidate.fingerprint).toEqual(result.fingerprint);
        expect(result.fingerprint).not.toBeNull();
        expect(result.fingerprint?.contentHash).not.toBeNull();
        expect(result.fingerprint?.canonicalStructure).not.toBeNull();
        assertFingerprintConsistency(result.fingerprint);

        const storedSlot = getSlot(db, RUN_ID, slot.slotId);
        expect(storedSlot.stage).toBe("presentation_ready");
        expect(storedSlot.verdict).toBeNull();
        expect(storedSlot.checkpointVersion).toBe(3);

        const stages = orderedStages(slot.slotId);
        expect(stages.map((stage) => stage.stage)).toEqual([
          "spec_ready",
          "formal_checked",
          "presentation_ready",
        ]);

        const specStage = getStageResult(
          db,
          RUN_ID,
          slot.slotId,
          "spec_ready",
        );
        if (slot.lane === "spec_first") {
          const payload = SpecFirstStagePayloadSchema.parse(specStage.payload);
          expect(payload.family).toBe(slot.family);
          expect(payload.difficulty).toBe(slot.difficulty);
          expect(payload.seed).toBe(specSeed);
          expect(payload.construction).toEqual({
            method: "engine.generateSpec",
            seed: specSeed,
            deterministic: true,
          });
          expect(payload.spec).toEqual(
            engine.generateSpec(specSeed, slot.difficulty),
          );
        } else {
          const payload = specStage.payload as {
            family: string;
            difficulty: number;
            spec: unknown;
            proposal: {
              logicalCallId: string;
              attemptIds: string[];
              actualCostUsd: string;
              costStatus: string;
            };
            formal: {
              solutionCount: number;
              answerCount: number;
              enumeratedStates: number;
              checkerVersion: string;
            };
          };
          expect(payload.family).toBe(slot.family);
          expect(payload.difficulty).toBe(slot.difficulty);
          expect(payload.spec).toEqual(
            engine.generateSpec(specSeed, slot.difficulty),
          );
          expect(payload.formal.solutionCount).toBe(1);
          expect(payload.formal.answerCount).toBe(1);
          expect(payload.proposal.logicalCallId).toBeTruthy();
          expect(payload.proposal.attemptIds).toHaveLength(1);
          expect(payload.proposal.actualCostUsd).toBe("0");
          expect(payload.proposal.costStatus).toBe("known");
        }

        const formalStage = getStageResult(
          db,
          RUN_ID,
          slot.slotId,
          "formal_checked",
        );
        const formal = FormalStagePayloadSchema.parse(formalStage.payload);
        expect(formal.family).toBe(slot.family);
        expect(formal.modality).toBe(slot.modality);
        expect(formal.lane).toBe(slot.lane);
        expect(formal.difficulty).toBe(slot.difficulty);
        expect(formal.spec).toEqual(
          engine.generateSpec(specSeed, slot.difficulty),
        );
        expect(formal.seeds).toEqual({
          spec: specSeed,
          options: optionsSeed,
          layout: layoutSeed,
        });
        expect(formal.solveResult.solutionCount).toBe(1);
        expect(formal.solveResult.answerCount).toBe(1);
        expect(formal.solveResult.correctAnswer).not.toBeNull();
        expect(formal.solveResult.proof).not.toBeNull();
        expect(formal.choices.choices.map((choice) => choice.label)).toEqual([
          "A",
          "B",
          "C",
          "D",
        ]);
        expect(formal.choices.correctLabel).toMatch(/^[ABCD]$/);
        expect(formal.checks).toEqual({
          uniqueness: "pass",
          options: "pass",
          render: slot.modality === "svg" ? "pass" : "not_applicable",
        });
        expect(formal.fingerprint.contentHash).toBeNull();
        expect(formal.fingerprint.canonicalStructure).not.toBeNull();
        expect(formal.fingerprint.specHash).not.toBeNull();
        expect(formal.fingerprint.structureHash).not.toBeNull();
        expect(formal.fingerprint.features.length).toBeGreaterThan(0);

        if (slot.modality === "text") {
          expect(formal.render).toEqual({
            rendererVersion: null,
            svgHash: null,
            pngHash: null,
            previewPngHash: null,
          });
          expect(formalStage.artifacts).toEqual([]);
        } else {
          expect(formal.render.rendererVersion).toBeTruthy();
          expect(formal.render.svgHash).not.toBeNull();
          expect(formal.render.pngHash).not.toBeNull();
          expect(formal.render.previewPngHash).not.toBeNull();
          expect(formalStage.artifacts).toHaveLength(3);
          const svgArtifact = getArtifact(
            db,
            formal.render.svgHash as string,
            "svg",
          );
          const pngArtifact = getArtifact(
            db,
            formal.render.pngHash as string,
            "png",
          );
          const previewArtifact = getArtifact(
            db,
            formal.render.previewPngHash as string,
            "png",
          );
          expect(sha256Hex(svgArtifact.bytes.toString("utf8"))).toBe(
            formal.render.svgHash,
          );
          expect(svgArtifact.bytes.toString("utf8").startsWith("<svg")).toBe(
            true,
          );
          expect(hashPng(pngArtifact.bytes)).toBe(formal.render.pngHash);
          assertPngNoTextMetadata(pngArtifact.bytes);
          expect(pngArtifact.bytes.readUInt32BE(16)).toBe(1024);
          expect(pngArtifact.bytes.readUInt32BE(20)).toBe(1024);
          expect(hashPng(previewArtifact.bytes)).toBe(
            formal.render.previewPngHash,
          );
          assertPngNoTextMetadata(previewArtifact.bytes);
          expect(previewArtifact.bytes.readUInt32BE(16)).toBe(512);
          expect(previewArtifact.bytes.readUInt32BE(20)).toBe(512);

          const renderer = productionRegistry.getRenderer(slot.family as SvgFamily);
          const rendered = renderer.buildScene(
            formal.spec,
            formal.seeds.options,
          );
          expect(() =>
            renderer.assertScene(rendered, formal.spec, formal.choices),
          ).not.toThrow();
          expect(serializeScene(rendered as Parameters<typeof serializeScene>[0])).toBe(
            svgArtifact.bytes.toString("utf8"),
          );
          const nonCorrect = formal.choices.choices.filter(
            (choice) => choice.label !== formal.choices.correctLabel,
          );
          const firstNonCorrect = nonCorrect[0];
          const secondNonCorrect = nonCorrect[1];
          if (firstNonCorrect === undefined || secondNonCorrect === undefined) {
            throw new Error("a four-choice set must contain two non-correct values");
          }
          const mutatedChoices = {
            ...formal.choices,
            choices: formal.choices.choices.map((choice) => {
              if (choice.label === firstNonCorrect.label) {
                return { ...choice, value: secondNonCorrect.value };
              }
              if (choice.label === secondNonCorrect.label) {
                return { ...choice, value: firstNonCorrect.value };
              }
              return choice;
            }),
          };
          expect(() =>
            renderer.assertScene(rendered, formal.spec, mutatedChoices),
          ).toThrow();
        }

        const presentationStage = getStageResult(
          db,
          RUN_ID,
          slot.slotId,
          "presentation_ready",
        );
        const presentationPayload = presentationStage.payload as {
          wording: { source: string };
          presentation: Parameters<typeof fingerprintContentFor>[0];
          proposal: { logicalCallId: string; actualCostUsd: string };
        };
        expect(presentationPayload.wording.source).toBe("model");
        expect(presentationPayload.presentation.visible.slotId).toBe(
          slot.slotId,
        );
        expect(presentationPayload.presentation.visible.family).toBe(
          slot.family,
        );
        expect(presentationPayload.presentation.visible.assets).toEqual({
          svgHash: formal.render.svgHash,
          pngHash: formal.render.pngHash,
        });
        expect(presentationPayload.presentation.reveal.correctLabel).toBe(
          formal.choices.correctLabel,
        );
        expect(presentationPayload.proposal.logicalCallId).toBeTruthy();
        expect(presentationPayload.proposal.actualCostUsd).toBe("0");
        expect(
          computeContentHash(
            fingerprintContentFor(presentationPayload.presentation),
          ),
        ).toBe(result.fingerprint?.contentHash);

        const expectedRoles = slot.lane === "ai_spec" ? ["spec", "wording"] : ["wording"];
        expect(result.logicalCalls.map((call) => call.role)).toEqual(
          expectedRoles,
        );
        for (const call of result.logicalCalls) {
          expect(call.state).toBe("validated");
          expect(call.attemptIds).toHaveLength(1);
          expect(call.rawResponseArtifactIds).toHaveLength(1);
          expect(call.actualCostUsd).toBe("0");
          expect(call.costStatus).toBe("known");
        }
      }

      expect(mock.requests).toHaveLength(30);
      for (const request of mock.requests) {
        expect(request.body).not.toContain("mockScenario");
        expect(request.body).not.toContain("mockRegistry");
        expect(request.body).not.toContain("oracle");
        expect(request.body).not.toContain("scenario");
        expect(request.body).not.toContain(API_KEY);
      }

      expect(
        count("SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ?", RUN_ID),
      ).toBe(30);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND role = 'spec'",
          RUN_ID,
        ),
      ).toBe(10);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND role = 'wording'",
          RUN_ID,
        ),
      ).toBe(20);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND role NOT IN ('spec', 'wording')",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND state != 'validated'",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?)",
          RUN_ID,
        ),
      ).toBe(30);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?) AND (state != 'validated' OR actual_cost_usd != '0' OR cost_status != 'known')",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage IN ('duplicate_checked', 'blind_reviewed', 'alignment_reviewed', 'terminal')",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM slots WHERE run_id = ? AND (stage != 'presentation_ready' OR verdict IS NOT NULL)",
          RUN_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM budget_reservations WHERE account_id = ? AND (kind != 'nonbilling' OR state != 'settled' OR amount_usd != '0' OR actual_cost_usd != '0')",
          ACCOUNT_ID,
        ),
      ).toBe(0);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM budget_reservations WHERE account_id = ?",
          ACCOUNT_ID,
        ),
      ).toBe(30);
      const account = getBudgetAccount(db, ACCOUNT_ID);
      expect(account.knownActualUsd).toBe("0");
      expect(account.reservedUsd).toBe("0");
      expect(account.unknownExposureUsd).toBe("0");
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_artifacts sa JOIN artifacts a ON a.artifact_id = sa.artifact_id WHERE sa.run_id = ? AND sa.role = 'source_svg' AND a.kind = 'svg'",
          RUN_ID,
        ),
      ).toBe(10);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_artifacts sa JOIN artifacts a ON a.artifact_id = sa.artifact_id WHERE sa.run_id = ? AND sa.role = 'full_png' AND a.kind = 'png'",
          RUN_ID,
        ),
      ).toBe(10);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_artifacts sa JOIN artifacts a ON a.artifact_id = sa.artifact_id WHERE sa.run_id = ? AND sa.role = 'preview_png' AND a.kind = 'png'",
          RUN_ID,
        ),
      ).toBe(10);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM stage_artifacts WHERE run_id = ?",
          RUN_ID,
        ),
      ).toBe(30);
      expect(
        count(
          "SELECT COUNT(*) AS count FROM artifacts WHERE kind = 'json'",
        ),
      ).toBe(0);
    },
    180_000,
  );

  it("refuses to regenerate an already prepared slot", async () => {
    const slot = slotFor("ranking", "spec_first");
    await prepare(slot.slotId);
    const callsBefore = count(
      "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ?",
      RUN_ID,
    );
    const stagesBefore = orderedStages(slot.slotId).map((stage) => stage.stage);

    await expect(prepare(slot.slotId)).rejects.toMatchObject({
      name: "PreparationError",
      code: "INVALID_STAGE",
    } satisfies Partial<PreparationError>);

    expect(
      count("SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ?", RUN_ID),
    ).toBe(callsBefore);
    expect(orderedStages(slot.slotId).map((stage) => stage.stage)).toEqual(
      stagesBefore,
    );
  });

  it("persists an evidenced ai_spec generation failure without a fallback", async () => {
    const slot = slotFor("ranking", "ai_spec");
    const result = await prepare(slot.slotId, { spec: "schema_invalid" });

    expect(result.status).toBe(PREPARATION_FAILURE_STATUS);
    expect(result.terminalVerdict).toBe("generation_error");
    expect(result.stages).toEqual(["terminal"]);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "SCHEMA_INVALID",
    ]);
    expect(result.cost).toEqual({ actualCostUsd: "0", costStatus: "known" });
    expect(result.candidate.preparationStatus).toBe("early_failure");
    expect(result.candidate.formalPassed).toBe(false);
    expect(result.candidate.presentationCheckPassed).toBe(false);
    expect(result.candidate.terminalVerdict).toBe("generation_error");
    expect(result.candidate.fingerprint).toBeNull();
    expect(result.logicalCalls.map((call) => call.role)).toEqual(["spec"]);
    expect(result.logicalCalls[0]?.state).toBe("validated");
    expect(result.logicalCalls[0]?.attemptIds).toHaveLength(1);
    expect(result.logicalCalls[0]?.rawResponseArtifactIds).toHaveLength(1);

    const storedSlot = getSlot(db, RUN_ID, slot.slotId);
    expect(storedSlot.stage).toBe("terminal");
    expect(storedSlot.verdict).toBe("generation_error");
    expect(storedSlot.checkpointVersion).toBe(1);

    const stages = orderedStages(slot.slotId);
    expect(stages.map((stage) => stage.stage)).toEqual(["terminal"]);
    const terminal = PreparationFailureStagePayloadSchema.parse(
      stages[0]?.payload,
    );
    expect(terminal.failureStage).toBe("spec_ready");
    expect(terminal.failures.map((failure) => failure.code)).toEqual([
      "SCHEMA_INVALID",
    ]);
    expect(terminal.terminalVerdict).toBe("generation_error");
    expect(terminal.fingerprint).toBeNull();
    expect(terminal.logicalCalls).toEqual(result.logicalCalls);
    expect(stages[0]?.artifacts).toHaveLength(1);
    expect(stages[0]?.artifacts[0]?.kind).toBe("json");

    const rawArtifactId =
      result.logicalCalls[0]?.rawResponseArtifactIds[0] as number;
    const rawArtifact = getArtifact(
      db,
      (
        db
          .prepare(
            "SELECT content_hash FROM artifacts WHERE artifact_id = ?",
          )
          .get(rawArtifactId) as { content_hash: string }
      ).content_hash,
      "raw_response",
    );
    const rawText = rawArtifact.bytes.toString("utf8");
    expect(rawText).toContain("mock/model");
    expect(rawText).toContain("unexpected");

    expect(mock.requests).toHaveLength(1);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage IN ('formal_checked', 'presentation_ready')",
        RUN_ID,
      ),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM logical_calls WHERE run_id = ? AND role = 'wording'",
        RUN_ID,
      ),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?)",
        RUN_ID,
      ),
    ).toBe(1);
    expect(getBudgetAccount(db, ACCOUNT_ID).knownActualUsd).toBe("0");
  });

  it("keeps formal evidence and a diagnostic fingerprint when wording fails", async () => {
    const slot = slotFor("ranking", "spec_first");
    const result = await prepare(slot.slotId, { wording: "refusal" });

    expect(result.status).toBe(PREPARATION_FAILURE_STATUS);
    expect(result.terminalVerdict).toBe("generation_error");
    expect(result.stages).toEqual([
      "spec_ready",
      "formal_checked",
      "terminal",
    ]);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "API_ERROR",
    ]);
    expect(result.cost).toEqual({ actualCostUsd: "0", costStatus: "known" });
    expect(result.candidate.preparationStatus).toBe("early_failure");
    expect(result.candidate.formalPassed).toBe(true);
    expect(result.candidate.presentationCheckPassed).toBe(false);
    expect(result.candidate.fingerprint).not.toBeNull();
    expect(result.candidate.fingerprint?.contentHash).toBeNull();
    expect(result.candidate.fingerprint?.canonicalStructure).not.toBeNull();
    expect(result.fingerprint).toEqual(result.candidate.fingerprint);
    expect(result.logicalCalls.map((call) => call.role)).toEqual(["wording"]);
    expect(result.logicalCalls[0]?.state).toBe("failed_known");
    expect(result.logicalCalls[0]?.attemptIds).toHaveLength(1);
    expect(result.logicalCalls[0]?.rawResponseArtifactIds).toHaveLength(1);

    const storedSlot = getSlot(db, RUN_ID, slot.slotId);
    expect(storedSlot.stage).toBe("terminal");
    expect(storedSlot.verdict).toBe("generation_error");
    expect(storedSlot.checkpointVersion).toBe(3);

    const stages = orderedStages(slot.slotId);
    expect(stages.map((stage) => stage.stage)).toEqual([
      "spec_ready",
      "formal_checked",
      "terminal",
    ]);
    const formal = FormalStagePayloadSchema.parse(
      getStageResult(db, RUN_ID, slot.slotId, "formal_checked").payload,
    );
    expect(formal.fingerprint.contentHash).toBeNull();
    expect(formal.fingerprint.canonicalStructure).not.toBeNull();
    const terminal = PreparationFailureStagePayloadSchema.parse(
      stages[2]?.payload,
    );
    expect(terminal.failureStage).toBe("presentation_ready");
    expect(terminal.fingerprint).toEqual(formal.fingerprint);
    expect(terminal.terminalVerdict).toBe("generation_error");
    expect(
      count(
        "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage = 'presentation_ready'",
        RUN_ID,
      ),
    ).toBe(0);
    expect(mock.requests).toHaveLength(1);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM request_attempts WHERE logical_call_id IN (SELECT logical_call_id FROM logical_calls WHERE run_id = ?)",
        RUN_ID,
      ),
    ).toBe(1);
  });

  it("rolls back the terminal checkpoint and its evidence atomically", async () => {
    const slot = slotFor("truth", "spec_first");
    db.exec(`
      CREATE TRIGGER block_p33_terminal
      BEFORE INSERT ON stage_results
      WHEN NEW.stage = 'terminal'
      BEGIN
        SELECT RAISE(ABORT, 'blocked p33 terminal');
      END;
    `);

    await expect(
      prepare(slot.slotId, { wording: "refusal" }),
    ).rejects.toThrow();

    const storedSlot = getSlot(db, RUN_ID, slot.slotId);
    expect(storedSlot.stage).toBe("formal_checked");
    expect(storedSlot.verdict).toBeNull();
    expect(storedSlot.checkpointVersion).toBe(2);
    const stages = orderedStages(slot.slotId);
    expect(stages.map((stage) => stage.stage)).toEqual([
      "spec_ready",
      "formal_checked",
    ]);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage = 'terminal'",
        RUN_ID,
      ),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM stage_results WHERE run_id = ? AND stage = 'presentation_ready'",
        RUN_ID,
      ),
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) AS count FROM artifacts WHERE kind = 'json'"),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM artifacts WHERE kind = 'raw_response'",
      ),
    ).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS count FROM stage_artifacts WHERE run_id = ?",
        RUN_ID,
      ),
    ).toBe(0);
  });
});
