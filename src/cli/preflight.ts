import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import {
  PreflightError,
  fixtureRoleRequests,
  parseRecordedCatalog,
  runPreflightOnCatalog,
  type PreflightReport,
} from "../ai/preflight.js";
import { FAMILY_SPEC_JSON_SCHEMAS } from "../ai/schemas.js";

export const PROGRAM_NAME = "preflight";
export const DEFAULT_CATALOG_PATH = "tests/fixtures/openrouter/catalog.json";

const SCOPE_NOTE = [
  "Availability (P25):",
  "  --offline              validate recorded capability fixtures and strict schemas",
  "  --catalog <path>       recorded catalog fixture path",
  "  no network request, inference key, or paid call is made by --offline",
  "  --live                 authorization-gated live probe; reserved for P46",
  "  --allow-paid           required with --live; P25 does not execute paid probes",
  "  --max-cost <usd>       required with --live; P25 does not execute paid probes",
].join("\n");

interface PreflightOptions {
  readonly offline?: boolean;
  readonly live?: boolean;
  readonly catalog?: string;
  readonly allowPaid?: boolean;
  readonly maxCost?: string;
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
  const lines: string[] = [
    "mode: offline",
    "network: not used",
    "inference_key: not required",
    `catalog_source: ${report.catalog.source}`,
    `catalog_recorded_at: ${report.catalog.recordedAt}`,
    `catalog_models: ${report.catalog.modelCount}`,
    `schema_formats: ${Object.keys(FAMILY_SPEC_JSON_SCHEMAS).length + 3}`,
    `offline_fixture_roles: ${report.roles.length}`,
  ];
  for (const role of report.roles) {
    if (role.resolved === null) {
      lines.push(
        `role ${role.role}: FAILED model=${role.model} provider=${role.providerTag}`,
      );
      continue;
    }
    const resolved = role.resolved;
    lines.push(
      [
        `role ${role.role}: ok`,
        `model=${resolved.model}`,
        `provider=${resolved.providerTag}`,
        `endpoint=${resolved.endpointTag}`,
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
  lines.push("live_routes: not evaluated (P46)");
  return `${lines.join("\n")}\n`;
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
    .description("Validate OpenRouter route capabilities offline; never contacts a provider.")
    .showHelpAfterError()
    .addHelpText("after", `\n${SCOPE_NOTE}`)
    .option("--offline", "validate recorded capability fixtures and strict schemas")
    .option("--live", "authorization-gated live probe (reserved for P46)")
    .option("--catalog <path>", "recorded catalog fixture path")
    .option("--allow-paid", "acknowledge paid execution for --live")
    .option("--max-cost <usd>", "authorized maximum cost for --live")
    .action((options: PreflightOptions) => {
      if (options.offline === true && options.live === true) {
        program.error("--offline and --live are mutually exclusive", { exitCode: 1 });
      }
      if (options.offline !== true && options.live !== true) {
        program.error("choose --offline or --live", { exitCode: 1 });
      }
      if (options.offline === true) {
        if (options.allowPaid === true || options.maxCost !== undefined) {
          program.error("--allow-paid and --max-cost are invalid with --offline", {
            exitCode: 1,
          });
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
      program.error(
        "live preflight execution is reserved for P46; P25 exposes --offline only",
        { exitCode: 1 },
      );
    });
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
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
