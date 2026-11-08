import {
  fetchCatalogForModels,
  parseRecordedCatalog,
  runPreflightOnCatalog,
  type PreflightReport,
  type RecordedCatalog,
} from "../ai/preflight.js";
import { designerProposalJsonSchema } from "../ai/schemas.js";
import type { AiRoleSettings } from "../ai/config.js";
import type Database from "better-sqlite3";
import type { createOpenRouterTransport } from "../ai/openrouter.js";
import type { OutputCapField } from "../ai/config.js";

export const DESIGNER_PREFLIGHT_TEXT_FAMILY = "truth" as const;
export const DESIGNER_PREFLIGHT_SVG_FAMILY = "matrix" as const;

export interface DesignerPreflightInput {
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly settings?: AiRoleSettings;
  readonly skinEnabled?: boolean;
  readonly outputCapField?: OutputCapField;
}

export interface DesignerPreflightCatalogInput extends DesignerPreflightInput {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

export async function fetchDesignerPreflightCatalog(
  input: DesignerPreflightCatalogInput,
): Promise<RecordedCatalog> {
  return fetchCatalogForModels({
    modelIds: [input.model],
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
  });
}

function isNormalizedRecordedCatalog(
  value: unknown,
): value is RecordedCatalog {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return false;
  }
  return models.every((model) => {
    if (typeof model !== "object" || model === null) {
      return false;
    }
    const entry = model as {
      inputModalities?: unknown;
      endpoints?: unknown;
    };
    if (!Array.isArray(entry.inputModalities) || !Array.isArray(entry.endpoints)) {
      return false;
    }
    return entry.endpoints.every((endpoint) => {
      if (typeof endpoint !== "object" || endpoint === null) {
        return false;
      }
      return Array.isArray(
        (endpoint as { supportedParameters?: unknown }).supportedParameters,
      );
    });
  });
}

export function runDesignerPreflightOnCatalog(
  catalogInput: unknown,
  input: DesignerPreflightInput,
): PreflightReport {
  const catalog = isNormalizedRecordedCatalog(catalogInput)
    ? catalogInput
    : parseRecordedCatalog(catalogInput);
  const skinEnabled = input.skinEnabled ?? true;
  const settings =
    input.settings === undefined ? {} : { settings: input.settings };
  const maxOutputTokens =
    input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens };
  return runPreflightOnCatalog(
    catalog,
    [
      {
        role: "design",
        model: input.model,
        ...maxOutputTokens,
        ...settings,
        responseFormat: designerProposalJsonSchema(
          DESIGNER_PREFLIGHT_TEXT_FAMILY,
          1,
          { skinEnabled },
        ),
      },
      {
        role: "design",
        model: input.model,
        ...maxOutputTokens,
        ...settings,
        responseFormat: designerProposalJsonSchema(
          DESIGNER_PREFLIGHT_SVG_FAMILY,
          1,
          { skinEnabled },
        ),
      },
    ],
    { mode: "offline" },
  );
}

export interface DesignerProbeInput {
  readonly db: Database.Database;
  readonly pilotRunId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly outputCapField: OutputCapField;
  readonly settings?: AiRoleSettings;
  readonly skinEnabled?: boolean;
  readonly maxCostUsd: string;
  readonly reservationUsd: string;
  readonly clock?: { now(): Date };
}

export interface DesignerProbeResult {
  readonly ok: boolean;
  readonly probes: readonly {
    readonly probeKey: string;
    readonly logicalCallId: string;
    readonly ok: boolean;
    readonly outcome: string;
    readonly error: string | null;
    readonly costUsd: string | null;
    readonly costStatus: string;
  }[];
  readonly accountId: string;
}

export async function runDesignerPreflightProbes(
  input: DesignerProbeInput,
): Promise<DesignerProbeResult> {
  const { randomUUID } = await import("node:crypto");
  const { buildDesignProposalRequest, parseDesignProposal } = await import(
    "../ai/design-proposal.js"
  );
  const { createLogicalCall } = await import("../ai/ledger.js");
  const { createBudgetAccount } = await import("../ai/budget.js");
  const { insertEvent } = await import("../storage/repository.js");
  const clock = input.clock ?? { now: () => new Date() };
  const createdAt = clock.now().toISOString();
  const accountId = randomUUID();
  createBudgetAccount(input.db, {
    accountId,
    runId: input.pilotRunId,
    runKind: "design_pilot",
    pool: "preflight",
    maxCostUsd: input.maxCostUsd,
    createdAt,
  });
  const probes = [
    {
      probeKey: "designer-preflight-text",
      assignment: {
        assignmentId: "design-preflight-text",
        family: DESIGNER_PREFLIGHT_TEXT_FAMILY,
        difficulty: 1 as const,
      },
    },
    {
      probeKey: "designer-preflight-svg",
      assignment: {
        assignmentId: "design-preflight-svg",
        family: DESIGNER_PREFLIGHT_SVG_FAMILY,
        difficulty: 1 as const,
      },
    },
  ];
  const results: DesignerProbeResult["probes"][number][] = [];
  for (const probe of probes) {
    const built = buildDesignProposalRequest({
      assignment: probe.assignment,
      model: input.model,
      outputCapField: input.outputCapField,
      maxOutputTokens: input.maxOutputTokens,
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      skinEnabled: input.skinEnabled ?? true,
    });
    const call = createLogicalCall(input.db, {
      runId: input.pilotRunId,
      slotId: null,
      probeKey: probe.probeKey,
      role: "preflight",
      runKind: "design_pilot",
      requestBody: built.body,
      requestHash: built.requestHash,
      expectedSchemaHash: built.schemaHash,
      model: input.model,
      outputCapField: input.outputCapField,
      createdAt,
    });
    const executed = await input.transport.executeCall({
      db: input.db,
      accountId,
      logicalCallId: call.logicalCallId,
      apiKey: input.apiKey,
      reservationUsd: input.reservationUsd,
    });
    let ok = executed.outcome === "success";
    let error: string | null =
      executed.outcome === "success"
        ? null
        : (executed.error?.message ?? executed.outcome);
    if (ok && executed.parsedContent !== null) {
      try {
        parseDesignProposal(executed.parsedContent, probe.assignment, {
          skinEnabled: input.skinEnabled ?? true,
        });
      } catch (parseError) {
        ok = false;
        error =
          parseError instanceof Error
            ? parseError.message
            : "probe response failed strict schema validation";
      }
    } else if (ok) {
      ok = false;
      error = "probe returned no parsed content";
    }
    insertEvent(input.db, {
      runId: input.pilotRunId,
      slotId: null,
      eventType: "designer_preflight_probe",
      stage: null,
      payload: {
        probeKey: probe.probeKey,
        logicalCallId: call.logicalCallId,
        ok,
        error,
        outcome: executed.outcome,
        costUsd: executed.actualCostUsd,
        costStatus: executed.costStatus,
        schemaHash: built.schemaHash,
      },
      createdAt: clock.now().toISOString(),
    });
    results.push({
      probeKey: probe.probeKey,
      logicalCallId: call.logicalCallId,
      ok,
      outcome: executed.outcome,
      error,
      costUsd: executed.actualCostUsd,
      costStatus: executed.costStatus,
    });
  }
  return {
    ok: results.every((probe) => probe.ok),
    probes: results,
    accountId,
  };
}
