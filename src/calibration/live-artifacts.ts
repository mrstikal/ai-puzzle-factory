import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ProvenanceEvidence } from "../experiment/freeze.js";
import type { ProvenanceSummary } from "../experiment/provenance.js";
import { hashPng } from "../render/png.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";
import type { BuiltCalibrationPack } from "./fixtures.js";
import type { CalibrationLabels } from "./labels.js";
import type {
  CalibrationLiveRunResult,
  CalibrationLiveRouteSet,
} from "./live.js";
import type { CalibrationScoreReport } from "./score.js";

export interface CalibrationLiveArtifactInput {
  readonly directory: string;
  readonly calibrationId: string;
  readonly built: BuiltCalibrationPack;
  readonly labels: CalibrationLabels;
  readonly labelsPath: string;
  readonly labelsCsv?: string;
  readonly routes: CalibrationLiveRouteSet;
  readonly models: {
    readonly generator: string;
    readonly reviewer: string;
    readonly alignmentText: string;
    readonly visionReviewer: string;
  };
  readonly catalog: {
    readonly source: string;
    readonly recordedAt: string;
    readonly modelCount: number;
    readonly catalogHash: string;
  };
  readonly configuration: ProvenanceEvidence;
  readonly provenanceSummary: ProvenanceSummary;
  readonly authorizedCapUsd: string;
  readonly accountId: string;
  readonly budgetSummary: unknown;
  readonly result: CalibrationLiveRunResult;
  readonly score: CalibrationScoreReport;
  readonly databasePath: string;
  readonly mode?: "live" | "pilot";
  readonly pilotSet?: string;
  readonly limitations?: readonly string[];
  readonly pilot?: {
    readonly pass: boolean;
    readonly criteria: string;
    readonly combinations: Readonly<Record<string, boolean>>;
    readonly schemaValidCalls: boolean;
  };
}

export interface CalibrationLiveArtifactPaths {
  readonly directory: string;
  readonly mainPath: string;
  readonly calibrationPath: string;
  readonly scorePath: string;
  readonly requestsPath: string;
  readonly responsesPath: string;
  readonly labelsPath: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly imagePaths: readonly string[];
}

interface ManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(
    path,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

export function labelReviewMethod(
  labels: CalibrationLabels,
): "independent_human" | "operator_delegated_ai" | "code_derived" {
  const humanProvenance = labels.rows.every(
    (row) => row.provenance === "human",
  );
  const humanVerified = labels.rows.every((row) => row.humanVerified);
  if (!humanProvenance || !humanVerified) {
    return "code_derived";
  }
  return labels.rows.some((row) =>
    `${row.auditor} ${row.notes}`.toLowerCase().includes("delegated"),
  )
    ? "operator_delegated_ai"
    : "independent_human";
}

function routeProjection(route: CalibrationLiveRouteSet[keyof CalibrationLiveRouteSet]) {
  return {
    role: route.role,
    model: route.model,
    routingPolicy: route.routingPolicy,
    compatibleEndpointTags: route.compatibleEndpointTags,
    compatibleProviderNames: route.compatibleProviderNames,
    outputCapField: route.outputCapField,
    maxOutputTokens: route.maxOutputTokens,
    contextLength: route.contextLength,
    maxPromptTokens: route.maxPromptTokens,
    maxCompletionTokens: route.maxCompletionTokens,
    pricing: route.pricing,
    requiresImage: route.requiresImage,
    schemaHash: route.schemaHash,
    settings: route.settings,
  };
}

function listFiles(directory: string): ManifestFile[] {
  const files: ManifestFile[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      files.push({
        path: relative(directory, path).split("\\").join("/"),
        bytes: stats.size,
        sha256: fileSha256(path),
      });
    }
  };
  walk(directory);
  return files;
}

function copyVisibleImages(
  directory: string,
  built: BuiltCalibrationPack,
): string[] {
  const imagesDirectory = join(directory, "images");
  mkdirSync(imagesDirectory, { recursive: true });
  const paths: string[] = [];
  for (const entry of built.fixtures) {
    const fixture = entry.fixture;
    if (fixture.modality !== "svg") {
      continue;
    }
    const png = entry.artifacts.visible.png;
    if (png === null || fixture.pngHash === null) {
      throw new Error(`${fixture.fixtureId} has no visible PNG`);
    }
    if (hashPng(png) !== fixture.pngHash) {
      throw new Error(`${fixture.fixtureId} visible PNG hash does not match the pack`);
    }
    const pngPath = join(imagesDirectory, `${fixture.fixtureId}.png`);
    writeFileSync(pngPath, png);
    paths.push(pngPath);
    const svg = entry.artifacts.visible.svg;
    if (svg === null || fixture.svgHash === null) {
      throw new Error(`${fixture.fixtureId} has no visible SVG`);
    }
    if (sha256Hex(svg) !== fixture.svgHash) {
      throw new Error(`${fixture.fixtureId} visible SVG hash does not match the pack`);
    }
    writeFileSync(
      join(imagesDirectory, `${fixture.fixtureId}.svg`),
      Buffer.from(svg, "utf8"),
    );
  }
  return paths;
}

export function writeCalibrationLiveArtifacts(
  input: CalibrationLiveArtifactInput,
): CalibrationLiveArtifactPaths {
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true });
  const mode = input.mode ?? "live";
  const imagePaths = copyVisibleImages(directory, input.built);
  const labelsPath = join(directory, "labels.csv");
  if (input.labelsCsv !== undefined) {
    writeFileSync(labelsPath, input.labelsCsv, "utf8");
  } else {
    copyFileSync(input.labelsPath, labelsPath);
  }
  const requestsPath = join(directory, "requests.jsonl");
  writeJsonl(
    requestsPath,
    input.result.calls.map((call) => ({
      fixtureId: call.fixtureId,
      role: call.role,
      logicalCallId: call.logicalCallId,
      requestHash: call.requestHash,
      model: call.model,
      routingPolicy: call.routingPolicy,
      outputCapField: call.outputCapField,
      reservationUsd: call.reservationUsd,
      requestBody: call.requestBody,
    })),
  );
  const responsesPath = join(directory, "responses.jsonl");
  writeJsonl(
    responsesPath,
    input.result.calls.map((call) => ({
      fixtureId: call.fixtureId,
      role: call.role,
      logicalCallId: call.logicalCallId,
      responseHash: call.responseHash,
      response: call.response,
      error: call.error,
      costStatus: call.costStatus,
      actualCostUsd: call.actualCostUsd,
      attempts: call.attempts,
    })),
  );
  const scorePath = join(directory, "score.json");
  writeJson(scorePath, input.score);
  const calibrationPath = join(
    directory,
    mode === "pilot" ? "pilot.json" : "calibration.json",
  );
  writeJson(calibrationPath, {
    version: 1,
    calibrationId: input.calibrationId,
    mode,
    pilotSet: input.pilotSet ?? null,
    evidenceKind: mode,
    freezeEligible: mode === "live" ? input.score.liveEligible : false,
    status: input.result.status,
    startedAt: input.result.startedAt,
    completedAt: input.result.completedAt,
    packHash: input.labels.packHash,
    labelsHash: input.score.labelsHash,
    labels: {
      path: "labels.csv",
      rows: input.labels.rows.length,
      auditor: [...new Set(input.labels.rows.map((row) => row.auditor))],
      auditorTime: [
        ...new Set(input.labels.rows.map((row) => row.auditorTime)),
      ],
      provenance: [...new Set(input.labels.rows.map((row) => row.provenance))],
      humanVerified: input.labels.rows.every((row) => row.humanVerified),
      reviewMethod: labelReviewMethod(input.labels),
      notes: [
        ...new Set(
          input.labels.rows
            .map((row) => row.notes)
            .filter((note) => note.trim() !== ""),
        ),
      ],
    },
    models: input.models,
    routingPolicy: {
      mode: "balanced",
      allowFallbacks: true,
      requireParameters: true,
    },
    catalog: input.catalog,
    routes: {
      blind_text: routeProjection(input.routes.blindText),
      blind_vision: routeProjection(input.routes.blindVision),
      alignment_text: routeProjection(input.routes.alignmentText),
      alignment_vision: routeProjection(input.routes.alignmentVision),
    },
    configuration: input.configuration,
    provenance: input.provenanceSummary,
    authorizedCapUsd: input.authorizedCapUsd,
    accountId: input.accountId,
    budget: input.budgetSummary,
    budgetPaused: input.result.budgetPaused,
    budgetBreached: input.result.budgetBreached,
    cost: {
      knownUsd: input.result.knownCostUsd,
      unknownCalls: input.result.unknownCalls,
      unknownAttempts: input.result.unknownAttempts,
    },
    calls: {
      review: input.result.reviewCalls,
      generation: input.result.generationCalls,
      transportAttempts: input.result.transportAttempts,
    },
    providerMix: input.result.providerMix,
    coverage: input.score.coverage,
    gates: input.score.gates,
    firstFailure: input.result.firstFailure,
    observations: input.result.observations,
    score: input.score,
    pilot: input.pilot ?? null,
    artifacts: {
      labels: "labels.csv",
      requests: "requests.jsonl",
      responses: "responses.jsonl",
      score: "score.json",
      database: relative(directory, resolve(input.databasePath))
        .split("\\")
        .join("/"),
      images: imagePaths.map((path) => relative(directory, path).split("\\").join("/")),
    },
    limitations:
      input.limitations ??
      (mode === "pilot"
        ? [
            "Pilot cases are code-derived development cases, not the held-out P48 calibration set.",
            "Pilot truth is code-derived and not human-verified; the pilot is not freeze evidence.",
            "Two cases per modality cannot estimate reviewer accuracy; the pilot is a behavioral smoke test.",
            "Observed provider identities are diagnostics only; Balanced routing may select different providers for later calls.",
            "No content retry, fixture dropping, relabeling, or partial-to-pass conversion is allowed.",
          ]
        : [
            "Observed provider identities are diagnostics only; Balanced routing may select different providers for later calls.",
            "Calibration measures held-out fixture review behavior, not primary puzzle approval rates or business success.",
            "Wilson 95% intervals are reported for the conservative rates and remain wide with ten sound and ten defective fixtures per modality.",
            "The calibration does not prove that future remote generations are reproducible; stored responses and the run database are the replayable evidence.",
            "No generation call, fixture relabeling, content retry, or failed-fixture removal is permitted; incomplete or budget-paused runs are not freeze-eligible.",
          ]),
  });
  const databasePath = resolve(input.databasePath);
  const files = listFiles(directory).filter((file) => file.path !== "manifest.json");
  const manifestHash = hashCanonicalJson(files);
  const manifestPath = join(directory, "manifest.json");
  writeJson(manifestPath, {
    version: 1,
    calibrationId: input.calibrationId,
    createdAt: input.result.completedAt,
    files,
    manifestHash,
  });
  return {
    directory,
    mainPath: calibrationPath,
    calibrationPath,
    scorePath,
    requestsPath,
    responsesPath,
    labelsPath,
    databasePath,
    manifestPath,
    manifestHash,
    imagePaths,
  };
}
