import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { createBudgetAccount } from "../ai/budget.js";
import {
  defaultMaxOutputTokensFor,
  readLiveEnvironment,
  type AiRoleSettings,
  type LiveEnvironmentConfig,
} from "../ai/config.js";
import { loadLocalEnv } from "../ai/local-env.js";
import { createOpenRouterTransport } from "../ai/openrouter.js";
import { Resvg } from "@resvg/resvg-js";
import {
  PreflightError,
  buildLiveProbePlan,
  executeLiveProbePlan,
  fetchCatalogForModels,
  fixtureRoleRequests,
  parseRecordedCatalog,
  runPreflightOnCatalog,
  type PreflightReport,
  type RolePreflightRequest,
} from "../ai/preflight.js";
import { FAMILY_SPEC_JSON_SCHEMAS } from "../ai/schemas.js";
import { RoutingConfirmationSchema } from "../domain/experiment.js";
import { migrate, openDatabase } from "../storage/database.js";

export const PROGRAM_NAME = "preflight";
export const DEFAULT_CATALOG_PATH = "tests/fixtures/openrouter/catalog.json";

const SCOPE_NOTE = [
  "Availability (P25):",
  "  --offline              validate recorded capability fixtures and strict schemas",
  "  --catalog <path>       recorded catalog fixture path",
  "  no network request, inference key, or paid call is made by --offline",
  "  --live                 Balanced live probe behind paid and routing-confirmation gates",
  "  --allow-paid           required with --live",
  "  --max-cost <usd>       required with --live",
  "  --routing-confirmation <path>  operator account check JSON required with --live",
  "  --vision-reasoning-effort <effort>  optional low|medium|high for vision probes",
  "  --db <path>            SQLite path for preflight ledger (default: data/experiment.sqlite)",
].join("\n");

interface PreflightOptions {
  readonly offline?: boolean;
  readonly live?: boolean;
  readonly catalog?: string;
  readonly allowPaid?: boolean;
  readonly maxCost?: string;
  readonly routingConfirmation?: string;
  readonly visionReasoningEffort?: string;
  readonly db?: string;
}

function loadCatalog(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new PreflightError(
      "INVALID_CATALOG",
      `cannot read recorded catalog fixture ${path}`,
      null,
      { cause: error },
    );
  }
}

function formatReport(report: PreflightReport): string {
  const live = report.mode === "live";
  const lines: string[] = [
    `mode: ${report.mode}`,
    live
      ? "network: catalog GET used; inference probes not dispatched"
      : "network: not used",
    live ? "inference_key: required" : "inference_key: not required",
    `catalog_source: ${report.catalog.source}`,
    `catalog_recorded_at: ${report.catalog.recordedAt}`,
    `catalog_models: ${report.catalog.modelCount}`,
    `schema_formats: ${Object.keys(FAMILY_SPEC_JSON_SCHEMAS).length + 3}`,
    `offline_fixture_roles: ${report.roles.length}`,
  ];
  for (const role of report.roles) {
    if (role.resolved === null) {
      lines.push(
        `role ${role.role}: FAILED model=${role.model} compatible=${role.compatibleEndpointTags.join(",")}`,
      );
      continue;
    }
    const resolved = role.resolved;
    lines.push(
      [
        `role ${role.role}: ok`,
        `model=${resolved.model}`,
        `compatible=${resolved.compatibleEndpointTags.join(",")}`,
        `cap=${resolved.outputCapField}:${resolved.maxOutputTokens}`,
        `context=${resolved.contextLength}`,
        `prompt_reserve=${resolved.minPromptTokens}`,
        `image=${resolved.imageInputDeclared ? "declared" : "not_required"}`,
        `vision_probe=${resolved.visionProbeRequired ? "required" : "not_required"}`,
        `schema=${resolved.responseFormat.name}`,
        `schema_sha256=${resolved.schemaHash}`,
      ].join(" "),
    );
    for (const note of role.notes) {
      lines.push(`note ${role.role}: ${note}`);
    }
  }
  for (const failure of report.failures) {
    lines.push(
      `failure role=${failure.role ?? "global"} code=${failure.code} detail=${failure.detail}`,
    );
  }
  lines.push(`result: ${report.ok ? "ok" : "failed"}`);
  lines.push(
    live ? "live_routes: evaluated" : "live_routes: not evaluated",
  );
  return `${lines.join("\n")}\n`;
}

function livePngDataUrl(): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" fill="#f4f1ea"/>' +
    '<rect x="6" y="6" width="24" height="24" fill="#d94b3d"/>' +
    '<rect x="34" y="6" width="24" height="24" fill="#3d7bd9"/>' +
    '<rect x="6" y="34" width="24" height="24" fill="#3da36b"/>' +
    '<rect x="34" y="34" width="24" height="24" fill="#e0b23c"/>' +
    "</svg>";
  const png = new Resvg(svg).render().asPng();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function visionSettings(
  effort: string | undefined,
): AiRoleSettings | undefined {
  if (effort === undefined) {
    return undefined;
  }
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    programError("--vision-reasoning-effort must be low, medium, or high");
  }
  return { reasoningEffort: effort };
}

function liveRoleRequests(
  config: LiveEnvironmentConfig,
  visionReasoningEffort?: string,
): RolePreflightRequest[] {
  const vision = visionSettings(visionReasoningEffort);
  return [
    { role: "spec", model: config.generator.model },
    { role: "wording", model: config.generator.model },
    { role: "blind_text", model: config.reviewer.model },
    { role: "alignment_text", model: config.alignmentText.model },
    {
      role: "blind_vision",
      model: config.visionReviewer.model,
      ...(vision === undefined ? {} : { settings: vision }),
    },
    {
      role: "alignment_vision",
      model: config.visionReviewer.model,
      ...(vision === undefined ? {} : { settings: vision }),
    },
  ];
}

function loadRoutingConfirmation(path: string): {
  readonly operator: string;
  readonly checkedAt: string;
  readonly providerSort: "default_balanced";
  readonly byokConfigured: false;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new PreflightError(
      "ROUTING_CONFIRMATION_INVALID",
      `cannot read routing confirmation ${path}`,
      null,
      { cause: error },
    );
  }
  const parsed = RoutingConfirmationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PreflightError(
      "ROUTING_CONFIRMATION_INVALID",
      "routing confirmation must contain operator, checkedAt, default_balanced sort, and byokConfigured=false",
      null,
      { cause: parsed.error },
    );
  }
  const checkedAt = Date.parse(parsed.data.checkedAt);
  if (!Number.isFinite(checkedAt)) {
    throw new PreflightError(
      "ROUTING_CONFIRMATION_INVALID",
      "routing confirmation checkedAt is invalid",
    );
  }
  if (checkedAt > Date.now()) {
    throw new PreflightError(
      "ROUTING_CONFIRMATION_INVALID",
      "routing confirmation checkedAt is in the future",
    );
  }
  if (Date.now() - checkedAt > 15 * 60 * 1000) {
    throw new PreflightError(
      "ROUTING_CONFIRMATION_STALE",
      "routing confirmation is older than 15 minutes",
    );
  }
  return parsed.data;
}

async function runLive(options: PreflightOptions): Promise<number> {
  const config = readLiveEnvironment(process.env);
  if (options.routingConfirmation === undefined) {
    programError("live preflight requires --routing-confirmation <path>");
  }
  const confirmation = loadRoutingConfirmation(options.routingConfirmation);
  const modelIds = [
    config.generator.model,
    config.reviewer.model,
    config.alignmentText.model,
    config.visionReviewer.model,
  ];
  const catalog = await fetchCatalogForModels({
    modelIds,
    apiKey: config.apiKey,
  });
  const roles = liveRoleRequests(config, options.visionReasoningEffort);
  const preflightId = randomUUID();
  const report = runPreflightOnCatalog(catalog, roles, {
    mode: "live",
    allowConditionalOverrides: true,
    allowImageContextReserve: true,
  });
  if (!report.ok) {
    process.stdout.write(formatReport(report));
    return 1;
  }
  const routes = report.roles
    .map((role) => role.resolved)
    .filter((route): route is NonNullable<typeof route> => route !== null);
  const plan = buildLiveProbePlan({
    allowPaid: true,
    maxCostUsd: options.maxCost as string,
    apiKey: config.apiKey,
    routes,
    visionPngDataUrl: livePngDataUrl(),
    probeKeyPrefix: `preflight:${preflightId}`,
    probeMaxOutputTokensByRole: {
      spec: 2048,
      blind_text: defaultMaxOutputTokensFor("blind_text"),
      alignment_text: defaultMaxOutputTokensFor("alignment_text"),
      blind_vision: defaultMaxOutputTokensFor("blind_vision"),
      alignment_vision: defaultMaxOutputTokensFor("alignment_vision"),
    },
  });
  const dbPath = resolve(options.db ?? "data/experiment.sqlite");
  const db = openDatabase(dbPath);
  try {
    migrate(db);
    const createdAt = new Date().toISOString();
    const existingAccount = db
      .prepare(
        "SELECT account_id, max_cost_usd FROM budget_accounts WHERE run_kind = 'preflight' AND run_id IS NULL LIMIT 1",
      )
      .get() as { account_id: string; max_cost_usd: string } | undefined;
    let accountId: string;
    let effectiveCapUsd = options.maxCost as string;
    if (existingAccount !== undefined) {
      if (
        !new Decimal(options.maxCost as string).eq(
          new Decimal(existingAccount.max_cost_usd),
        )
      ) {
        throw new PreflightError(
          "PREFLIGHT_CAP_MISMATCH",
          `existing preflight account cap ${existingAccount.max_cost_usd} does not match the requested ${options.maxCost}; use the same cap or a fresh database`,
        );
      }
      accountId = existingAccount.account_id;
      effectiveCapUsd = existingAccount.max_cost_usd;
    } else {
      accountId = `preflight-${preflightId}`;
      createBudgetAccount(db, {
        accountId,
        runId: null,
        runKind: "preflight",
        maxCostUsd: effectiveCapUsd,
        createdAt,
      });
    }
    const transport = createOpenRouterTransport();
    const results = await executeLiveProbePlan({
      db,
      accountId,
      apiKey: config.apiKey,
      plan,
      transport,
    });
    const artifactDirectory = resolve("data", "preflight", preflightId);
    mkdirSync(artifactDirectory, { recursive: true });
    const artifactPath = join(artifactDirectory, "preflight.json");
    writeFileSync(
      artifactPath,
      `${JSON.stringify(
        {
          version: 1,
          preflightId,
          createdAt,
          authorizedCapUsd: effectiveCapUsd,
          confirmation,
          requestedModels: {
            generator: config.generator.model,
            reviewer: config.reviewer.model,
            visionReviewer: config.visionReviewer.model,
          },
          routingPolicy: plan.probes[0]?.body.provider ?? null,
          catalog: {
            source: catalog.source,
            recordedAt: catalog.recordedAt,
            modelCount: catalog.models.length,
          },
          roles: report.roles,
          probes: plan.probes.map((probe) => ({
            probeKey: probe.probeKey,
            role: probe.role,
            model: probe.model,
            compatibleEndpointTags: probe.compatibleEndpointTags,
            outputCapField: probe.outputCapField,
            reservationUsd: probe.reservationUsd,
            schemaHash: probe.schemaHash,
          })),
          results,
        },
        null,
        2,
      )}
`,
    );
    const ok = results.every(
      (result) =>
        result.result.outcome === "success" &&
        result.schemaValid &&
        (result.role !== "blind_vision" || result.visionInterpreted),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "live",
          preflightId,
          artifactPath,
          authorizedCapUsd: effectiveCapUsd,
          confirmation,
          probes: results.map((result) => ({
            probeKey: result.probeKey,
            outcome: result.result.outcome,
            observedModel: result.result.attempts.at(-1)?.observedModel ?? null,
            observedProvider:
              result.result.attempts.at(-1)?.observedProvider ?? null,
            schemaValid: result.schemaValid,
            schemaError: result.schemaError,
            visionInterpreted: result.visionInterpreted,
            actualCostUsd: result.result.actualCostUsd,
            costStatus: result.result.costStatus,
            error: result.result.error,
          })),
          result: ok ? "ok" : "failed",
        },
        null,
        2,
      )}
`,
    );
    return ok ? 0 : 1;
  } finally {
    db.close();
  }
}

function programError(message: string): never {
  throw new PreflightError("INVALID_LIVE_PROBE_ROUTES", message);
}

function runOffline(options: PreflightOptions): number {
  const path = resolve(options.catalog ?? DEFAULT_CATALOG_PATH);
  const rawCatalog = loadCatalog(path);
  const catalog = parseRecordedCatalog(rawCatalog);
  const roles = fixtureRoleRequests(catalog);
  const report = runPreflightOnCatalog(catalog, roles);
  process.stdout.write(formatReport(report));
  return report.ok ? 0 : 1;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("Validate Balanced OpenRouter routes offline or execute authorization-gated live probes.")
    .showHelpAfterError()
    .addHelpText("after", `\n${SCOPE_NOTE}`)
    .option("--offline", "validate recorded capability fixtures and strict schemas")
    .option("--live", "authorization-gated Balanced live probe")
    .option("--catalog <path>", "recorded catalog fixture path")
    .option("--allow-paid", "acknowledge paid execution for --live")
    .option("--max-cost <usd>", "authorized maximum cost for --live")
    .option("--routing-confirmation <path>", "operator account routing check JSON for --live")
    .option("--vision-reasoning-effort <effort>", "optional reasoning_effort for the vision probes (low, medium, high)")
    .option("--db <path>", "SQLite path for preflight ledger")
    .action(async (options: PreflightOptions) => {
      if (options.offline === true && options.live === true) {
        program.error("--offline and --live are mutually exclusive", { exitCode: 1 });
      }
      if (options.offline !== true && options.live !== true) {
        program.error("choose --offline or --live", { exitCode: 1 });
      }
      if (options.offline === true) {
        if (
          options.allowPaid === true ||
          options.maxCost !== undefined ||
          options.routingConfirmation !== undefined ||
          options.db !== undefined
        ) {
          program.error(
            "--allow-paid, --max-cost, --routing-confirmation, and --db are invalid with --offline",
            { exitCode: 1 },
          );
        }
        process.exitCode = runOffline(options);
        return;
      }
      if (options.allowPaid !== true) {
        program.error("live preflight requires --allow-paid", { exitCode: 1 });
      }
      if (options.maxCost === undefined) {
        program.error("live preflight requires --max-cost <usd>", { exitCode: 1 });
      }
      if (options.routingConfirmation === undefined) {
        program.error(
          "live preflight requires --routing-confirmation <path>",
          { exitCode: 1 },
        );
      }
      process.exitCode = await runLive(options);
    });
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  loadLocalEnv();
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    if (error instanceof Error) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  process.exitCode = await main();
}
