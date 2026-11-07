import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  mkdirSync,
  readFileSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { PNG } from "pngjs";
import { Decimal } from "decimal.js";
import { addUsd } from "../ai/budget.js";
import {
  buildChatRequest,
  type ChatMessage,
} from "../ai/config.js";
import {
  getLogicalCall,
  getOrCreateLogicalCall,
  listAttempts,
  type RequestAttempt,
} from "../ai/ledger.js";
import type {
  createOpenRouterTransport,
  OpenRouterCallResult,
} from "../ai/openrouter.js";
import {
  conservativeReservationUsd,
  estimatePromptTokens,
  type ResolvedRoute,
} from "../ai/preflight.js";
import {
  BLIND_REVIEW_JSON_SCHEMA,
  BLIND_REVIEW_RESPONSE_SCHEMA,
  type BlindReviewResponse,
} from "../ai/schemas.js";
import { readPng } from "../render/png.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";
import type { ChoiceSet } from "../domain/answers.js";
import type { PathRoute, PathsSpec } from "../families/paths/schema.js";
import type {
  BuiltCalibrationPack,
  CalibrationFixture,
} from "./fixtures.js";
import {
  buildBlindPayload,
  buildBlindReviewRequest,
  formatZodIssues,
  type CalibrationReviewRequest,
} from "./run.js";

export const PATHS_DIAGNOSTIC_VARIANTS = ["A", "B", "C", "D"] as const;
export type PathsDiagnosticVariant = (typeof PATHS_DIAGNOSTIC_VARIANTS)[number];
export type PathsDiagnosticOutcome =
  | "defect_detected"
  | "abstained"
  | "selected"
  | "schema_error"
  | "budget_refused"
  | "transport_error"
  | "not_executed";
export type PathsDiagnosticClassification =
  | "control_pass"
  | "visual_interpretation"
  | "procedure"
  | "visual_detail"
  | "rules_logic"
  | "inconclusive";

export interface PathsDiagnosticAssets {
  readonly originalPng: Buffer;
  readonly sourceCropPng: Buffer;
  readonly optionCCropPng: Buffer;
}

export interface PathsDiagnosticRoutes {
  readonly vision: ResolvedRoute;
  readonly text: ResolvedRoute;
}

export interface PreparedPathsDiagnosticCall {
  readonly variant: PathsDiagnosticVariant;
  readonly description: string;
  readonly role: "blind_vision" | "blind_text";
  readonly route: ResolvedRoute;
  readonly request: CalibrationReviewRequest;
  readonly reservationUsd: string;
  readonly pngs: readonly Buffer[];
}

export interface PathsDiagnosticVariantResult {
  readonly variant: PathsDiagnosticVariant;
  readonly description: string;
  readonly role: "blind_vision" | "blind_text";
  readonly model: string;
  readonly outcome: PathsDiagnosticOutcome;
  readonly schemaValid: boolean;
  readonly answerStatus: string | null;
  readonly chosenOption: string | null;
  readonly issueCodes: readonly string[];
  readonly error: string | null;
  readonly requestHash: string | null;
  readonly responseHash: string | null;
  readonly provider: string | null;
  readonly finishReason: string | null;
  readonly usage: {
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly reasoningTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly costUsd: string | null;
  readonly costStatus: "known" | "unknown" | "not_applicable";
  readonly attempts: readonly {
    readonly attemptNumber: number;
    readonly state: string;
    readonly outcome: string;
    readonly httpStatus: number | null;
    readonly observedModel: string | null;
    readonly observedProvider: string | null;
    readonly actualCostUsd: string | null;
    readonly costStatus: "known" | "unknown" | "not_applicable";
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }[];
}

export interface PathsDiagnosticResult {
  readonly diagnosticId: string;
  readonly fixtureId: string;
  readonly model: string;
  readonly status: "completed" | "paused_budget" | "incomplete";
  readonly variants: readonly PathsDiagnosticVariantResult[];
  readonly classification: {
    readonly suggested: PathsDiagnosticClassification;
    readonly reasons: readonly string[];
  };
  readonly knownCostUsd: string;
  readonly unknownCalls: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

interface Edge {
  readonly from: { readonly row: number; readonly column: number };
  readonly to: { readonly row: number; readonly column: number };
}

function formatPoint(point: { readonly row: number; readonly column: number }): string {
  return `(${point.row},${point.column})`;
}

function formatEdge(edge: Edge): string {
  return `${formatPoint(edge.from)}-${formatPoint(edge.to)}`;
}

function formatRoute(route: PathRoute): string {
  return route.map(formatPoint).join(" -> ");
}

function imageDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function cropAndScalePng(
  source: Buffer,
  crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  scale: number,
): Buffer {
  const png = readPng(source);
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > png.width ||
    crop.y + crop.height > png.height
  ) {
    throw new Error("diagnostic crop is outside the PNG bounds");
  }
  const target = new PNG({
    width: crop.width * scale,
    height: crop.height * scale,
  });
  for (let row = 0; row < crop.height * scale; row += 1) {
    for (let column = 0; column < crop.width * scale; column += 1) {
      const sourceRow = crop.y + Math.floor(row / scale);
      const sourceColumn = crop.x + Math.floor(column / scale);
      const sourceIndex = (sourceRow * png.width + sourceColumn) * 4;
      const targetIndex = (row * target.width + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        target.data[targetIndex + channel] =
          png.data[sourceIndex + channel] ?? 0;
      }
    }
  }
  return PNG.sync.write(target);
}

export function buildPathsDiagnosticAssets(
  entry: BuiltCalibrationPack["fixtures"][number],
): PathsDiagnosticAssets {
  const originalPng = entry.artifacts.visible.png;
  if (originalPng === null) {
    throw new Error(`${entry.fixture.fixtureId} has no visible PNG`);
  }
  return {
    originalPng,
    sourceCropPng: cropAndScalePng(
      originalPng,
      { x: 80, y: 180, width: 90, height: 70 },
      4,
    ),
    optionCCropPng: cropAndScalePng(
      originalPng,
      { x: 60, y: 890, width: 90, height: 80 },
      4,
    ),
  };
}

function diagnosticPayloadText(fixture: CalibrationFixture): string {
  return JSON.stringify(buildBlindPayload(fixture), null, 2);
}

function diagnosticEdgeText(fixture: CalibrationFixture): string {
  const spec = fixture.original.spec as PathsSpec;
  const choices = fixture.original.choices as ChoiceSet<PathRoute>;
  const mutation = fixture.mutation;
  const details = mutation?.details as
    | { readonly visibleEdges?: readonly Edge[] }
    | undefined;
  const edges = details?.visibleEdges ?? spec.edges;
  return [
    "This is a text-only diagnostic. No image is provided.",
    "visualLegibility must be not_applicable.",
    "Grid coordinates are (row,column), 0-based.",
    `Start: ${formatPoint(spec.start)}.`,
    `Goal: ${formatPoint(spec.goal)}.`,
    `Active cells: ${spec.active.map(formatPoint).join(", ")}.`,
    `Open edges (visible): ${edges.map(formatEdge).join(", ")}.`,
    "A route segment is open only if it appears in the open-edge list; any other segment is closed.",
    "Offered routes:",
    ...choices.choices.map(
      (choice) => `${choice.label}: ${formatRoute(choice.value)}`,
    ),
    "Which offered route is a valid complete start-to-goal path using only open edges, starting at Start, ending at Goal, without repeating a cell?",
    "If none is valid, return no_unique_answer. If two routes are identical, return no_unique_answer and report the duplicate.",
    "Return the strict blind review JSON.",
  ].join("\n");
}

function diagnosticBMessages(
  payload: string,
  originalUrl: string,
): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a diagnostic reviewer. Follow the explicit edge-check procedure exactly. Return only the strict blind review JSON.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Image 1 is the full original puzzle. The visible walls are authoritative.",
            "Start is (1,1); goal is (0,0).",
            "Follow this procedure exactly:",
            "1. Read the four offered routes A-D from the image.",
            "2. For every consecutive pair in each route, check the shared edge in the image; the edge is open only if there is no black wall between the two cells.",
            "3. A route is valid only if every segment is open, it starts at S, ends at G, and does not repeat a cell.",
            "4. Compare all four routes. If exactly one is valid, select it. If none is valid, return no_unique_answer. If two are identical, return no_unique_answer and report the duplicate.",
            "Keep the reasoning field to a short final rationale. visualLegibility must be legible or unclear, never not_applicable.",
            "Public puzzle payload:",
            payload,
          ].join("\n"),
        },
        { type: "image_url", image_url: { url: originalUrl } },
      ],
    },
  ];
}

function diagnosticCMessages(
  payload: string,
  originalUrl: string,
  sourceCropUrl: string,
  optionCUrl: string,
): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a diagnostic reviewer. Use the full image for context and the zoomed crops for detail. Return only the strict blind review JSON.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Image 1 is the full original puzzle.",
            "Image 2 is a 4x zoom of the source maze edge between (1,1) and (2,1).",
            "Image 3 is a 4x zoom of option C's corresponding edge.",
            "The visible walls are authoritative; a segment is open only if no black wall crosses it.",
            "Trace every offered route. If exactly one route is valid, select it. If none is valid, return no_unique_answer. If two are identical, return no_unique_answer and report the duplicate.",
            "Keep the reasoning field to a short final rationale. visualLegibility must be legible or unclear, never not_applicable.",
            "Public puzzle payload:",
            payload,
          ].join("\n"),
        },
        { type: "image_url", image_url: { url: originalUrl } },
        { type: "image_url", image_url: { url: sourceCropUrl } },
        { type: "image_url", image_url: { url: optionCUrl } },
      ],
    },
  ];
}

function diagnosticDMessages(edgeText: string): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a diagnostic reviewer. This is a text-only geometry; do not infer visual content. Return only the strict blind review JSON.",
    },
    {
      role: "user",
      content: edgeText,
    },
  ];
}

function requestReservation(
  variant: PathsDiagnosticVariant,
  route: ResolvedRoute,
  messages: readonly ChatMessage[],
  requiresImage: boolean,
): string {
  const base = conservativeReservationUsd(
    route,
    estimatePromptTokens(messages, requiresImage),
    route.maxOutputTokens,
  );
  if (variant !== "C") {
    return base;
  }
  const imagePrice = String(route.pricing.image ?? route.pricing.prompt);
  const extra = new Decimal(imagePrice).mul(8192).mul(4).toFixed();
  return addUsd(base, extra);
}

function buildDiagnosticRequest(
  variant: "B" | "C" | "D",
  route: ResolvedRoute,
  messages: readonly ChatMessage[],
): CalibrationReviewRequest {
  const built = buildChatRequest({
    role: variant === "D" ? "blind_text" : "blind_vision",
    model: route.model,
    outputCapField: route.outputCapField,
    maxOutputTokens: route.maxOutputTokens,
    messages,
    responseFormat: BLIND_REVIEW_JSON_SCHEMA,
    ...(route.settings === undefined ? {} : { settings: route.settings }),
  });
  return {
    role: variant === "D" ? "blind_text" : "blind_vision",
    body: built.body,
    schemaHash: built.schemaHash,
    png: null,
    inventoryIds: null,
  };
}

export function buildPathsDiagnosticRequests(input: {
  readonly fixture: CalibrationFixture;
  readonly entry: BuiltCalibrationPack["fixtures"][number];
  readonly assets: PathsDiagnosticAssets;
  readonly routes: PathsDiagnosticRoutes;
}): readonly PreparedPathsDiagnosticCall[] {
  const { fixture, entry, assets, routes } = input;
  const payload = diagnosticPayloadText(fixture);
  const originalUrl = imageDataUrl(assets.originalPng);
  const sourceCropUrl = imageDataUrl(assets.sourceCropPng);
  const optionCUrl = imageDataUrl(assets.optionCCropPng);
  const blind = buildBlindReviewRequest(fixture, entry, routes.vision);
  const bMessages = diagnosticBMessages(payload, originalUrl);
  const cMessages = diagnosticCMessages(
    payload,
    originalUrl,
    sourceCropUrl,
    optionCUrl,
  );
  const dMessages = diagnosticDMessages(diagnosticEdgeText(fixture));
  const bRequest = buildDiagnosticRequest("B", routes.vision, bMessages);
  const cRequest = buildDiagnosticRequest("C", routes.vision, cMessages);
  const dRequest = buildDiagnosticRequest("D", routes.text, dMessages);
  return [
    {
      variant: "A",
      description: "original PNG + original v3 blind prompt (control)",
      role: "blind_vision",
      route: routes.vision,
      request: blind,
      reservationUsd: requestReservation(
        "A",
        routes.vision,
        blind.body.messages as readonly ChatMessage[],
        true,
      ),
      pngs: [assets.originalPng],
    },
    {
      variant: "B",
      description: "original PNG + explicit per-edge verification procedure",
      role: "blind_vision",
      route: routes.vision,
      request: bRequest,
      reservationUsd: requestReservation("B", routes.vision, bMessages, true),
      pngs: [assets.originalPng],
    },
    {
      variant: "C",
      description: "full original PNG + zoomed source/option C edge crops",
      role: "blind_vision",
      route: routes.vision,
      request: cRequest,
      reservationUsd: requestReservation("C", routes.vision, cMessages, true),
      pngs: [
        assets.originalPng,
        assets.sourceCropPng,
        assets.optionCCropPng,
      ],
    },
    {
      variant: "D",
      description: "text-only open-edge list; no image",
      role: "blind_text",
      route: routes.text,
      request: dRequest,
      reservationUsd: requestReservation("D", routes.text, dMessages, false),
      pngs: [],
    },
  ];
}

function attemptRecord(
  attempt: RequestAttempt,
  resultAttempt: OpenRouterCallResult["attempts"][number] | undefined,
): PathsDiagnosticVariantResult["attempts"][number] {
  return {
    attemptNumber: attempt.attemptNumber,
    state: attempt.state,
    outcome: resultAttempt?.outcome ?? attempt.state,
    httpStatus: attempt.httpStatus,
    observedModel: attempt.observedModel,
    observedProvider: attempt.observedProvider,
    actualCostUsd: attempt.actualCostUsd,
    costStatus: attempt.costStatus,
    errorCode: resultAttempt?.errorCode ?? null,
    errorMessage: resultAttempt?.errorMessage ?? null,
  };
}

function variantOutcome(
  result: OpenRouterCallResult,
  schemaValid: boolean,
  response: BlindReviewResponse | null,
): PathsDiagnosticOutcome {
  if (result.outcome === "paused_budget") {
    return "budget_refused";
  }
  if (result.outcome !== "success") {
    return "transport_error";
  }
  if (!schemaValid || response === null) {
    return "schema_error";
  }
  if (response.answerStatus === "selected") {
    return "selected";
  }
  if (response.answerStatus === "no_unique_answer") {
    return "defect_detected";
  }
  return "abstained";
}

function emptyVariantResult(
  prepared: PreparedPathsDiagnosticCall,
  outcome: PathsDiagnosticOutcome,
  error: string | null,
): PathsDiagnosticVariantResult {
  return {
    variant: prepared.variant,
    description: prepared.description,
    role: prepared.role,
    model: prepared.route.model,
    outcome,
    schemaValid: false,
    answerStatus: null,
    chosenOption: null,
    issueCodes: [],
    error,
    requestHash: null,
    responseHash: null,
    provider: null,
    finishReason: null,
    usage: {
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    },
    costUsd: null,
    costStatus: "not_applicable",
    attempts: [],
  };
}

export async function runPathsDiagnostic(input: {
  readonly diagnosticId: string;
  readonly built: BuiltCalibrationPack;
  readonly fixtureId: string;
  readonly routes: PathsDiagnosticRoutes;
  readonly assets?: PathsDiagnosticAssets;
  readonly prepared?: readonly PreparedPathsDiagnosticCall[];
  readonly db: Database.Database;
  readonly accountId: string;
  readonly apiKey: string;
  readonly transport: ReturnType<typeof createOpenRouterTransport>;
  readonly maxActualCostUsd: string;
  readonly clock?: { now(): Date };
}): Promise<PathsDiagnosticResult> {
  const entry = input.built.fixtures.find(
    (candidate) => candidate.fixture.fixtureId === input.fixtureId,
  );
  if (entry === undefined) {
    throw new Error(`missing diagnostic fixture ${input.fixtureId}`);
  }
  const fixture = entry.fixture;
  const assets = input.assets ?? buildPathsDiagnosticAssets(entry);
  const prepared =
    input.prepared ??
    buildPathsDiagnosticRequests({
      fixture,
      entry,
      assets,
      routes: input.routes,
    });
  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now().toISOString();
  const variants: PathsDiagnosticVariantResult[] = [];
  let status: PathsDiagnosticResult["status"] = "completed";
  let knownCostUsd = "0";
  let unknownCalls = 0;

  for (const call of prepared) {
    if (new Decimal(knownCostUsd).gt(input.maxActualCostUsd)) {
      status = "incomplete";
      variants.push(
        emptyVariantResult(call, "not_executed", "actual-cost guard stopped the diagnostic"),
      );
      continue;
    }
    try {
      const createdAt = clock.now().toISOString();
      const logical = getOrCreateLogicalCall(input.db, {
        runId: null,
        slotId: null,
        probeKey: `paths-diagnostic:${input.diagnosticId}:${call.variant}`,
        role: call.role,
        runKind: "calibration",
        requestBody: call.request.body,
        expectedSchemaHash: call.request.schemaHash,
        model: call.route.model,
        routingPolicy: "balanced",
        outputCapField: call.route.outputCapField,
        createdAt,
      });
      const result = await input.transport.executeCall({
        db: input.db,
        accountId: input.accountId,
        logicalCallId: logical.logicalCallId,
        apiKey: input.apiKey,
        reservationUsd: call.reservationUsd,
      });
      const stored = getLogicalCall(input.db, logical.logicalCallId);
      const attempts = listAttempts(input.db, logical.logicalCallId);
      const resultAttempts = new Map(
        result.attempts.map((attempt) => [attempt.attemptId, attempt]),
      );
      const parsed =
        result.outcome === "success" && result.parsedContent !== null
          ? BLIND_REVIEW_RESPONSE_SCHEMA.safeParse(result.parsedContent)
          : null;
      const schemaValid = parsed?.success === true;
      const response = parsed?.success ? parsed.data : null;
      const error =
        result.outcome !== "success"
          ? result.error === null
            ? `outcome ${result.outcome}`
            : `${result.error.code}: ${result.error.message}`
          : result.parsedContent === null
            ? "no parseable JSON content"
            : parsed !== null && !parsed.success
              ? `blind response does not satisfy the strict schema: ${formatZodIssues(parsed.error.issues)}`
              : null;
      const outcome = variantOutcome(result, schemaValid, response);
      const lastAttempt = attempts[attempts.length - 1];
      variants.push({
        variant: call.variant,
        description: call.description,
        role: call.role,
        model: call.route.model,
        outcome,
        schemaValid,
        answerStatus: response?.answerStatus ?? null,
        chosenOption: response?.chosenOption ?? null,
        issueCodes: response?.issues.map((issue) => issue.code) ?? [],
        error,
        requestHash: stored.requestHash,
        responseHash:
          result.content === null ? null : sha256Hex(result.content),
        provider: lastAttempt?.observedProvider ?? null,
        finishReason: lastAttempt?.finishReason ?? null,
        usage: {
          promptTokens: lastAttempt?.promptTokens ?? null,
          completionTokens: lastAttempt?.completionTokens ?? null,
          reasoningTokens: lastAttempt?.reasoningTokens ?? null,
          totalTokens: lastAttempt?.totalTokens ?? null,
        },
        costUsd: result.actualCostUsd,
        costStatus: result.costStatus,
        attempts: attempts.map((attempt) =>
          attemptRecord(attempt, resultAttempts.get(attempt.attemptId)),
        ),
      });
      knownCostUsd = addUsd(knownCostUsd, result.actualCostUsd ?? "0");
      if (result.costStatus === "unknown") {
        unknownCalls += 1;
      }
      if (result.outcome === "paused_budget") {
        status = "paused_budget";
        break;
      }
      if (new Decimal(knownCostUsd).gt(input.maxActualCostUsd)) {
        status = "incomplete";
        break;
      }
    } catch (error) {
      variants.push(
        emptyVariantResult(
          call,
          "transport_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
      status = "incomplete";
      break;
    }
  }

  for (const call of prepared) {
    if (!variants.some((variant) => variant.variant === call.variant)) {
      variants.push(
        emptyVariantResult(call, "not_executed", "not executed"),
      );
    }
  }
  variants.sort(
    (left, right) =>
      PATHS_DIAGNOSTIC_VARIANTS.indexOf(left.variant) -
      PATHS_DIAGNOSTIC_VARIANTS.indexOf(right.variant),
  );
  const classification = classifyPathsDiagnostic(variants);
  return {
    diagnosticId: input.diagnosticId,
    fixtureId: input.fixtureId,
    model: input.routes.vision.model,
    status,
    variants,
    classification,
    knownCostUsd,
    unknownCalls,
    startedAt,
    completedAt: clock.now().toISOString(),
  };
}

export function classifyPathsDiagnostic(
  variants: readonly PathsDiagnosticVariantResult[],
): PathsDiagnosticResult["classification"] {
  const get = (variant: PathsDiagnosticVariant) =>
    variants.find((candidate) => candidate.variant === variant);
  const success = (variant: PathsDiagnosticVariant): boolean =>
    get(variant)?.outcome === "defect_detected";
  const executed = variants.filter((variant) =>
    ["defect_detected", "abstained", "selected", "schema_error"].includes(
      variant.outcome,
    ),
  ).length;
  const reasons = variants.map(
    (variant) =>
      `${variant.variant}: ${variant.outcome}` +
      (variant.answerStatus === null
        ? ""
        : ` (answerStatus=${variant.answerStatus}` +
          (variant.chosenOption === null
            ? ")"
            : `, chosenOption=${variant.chosenOption})`)) +
      (variant.error === null ? "" : ` error=${variant.error}`),
  );
  if (executed < 4) {
    return { suggested: "inconclusive", reasons };
  }
  if (success("A")) {
    return { suggested: "control_pass", reasons };
  }
  if (success("D")) {
    return { suggested: "visual_interpretation", reasons };
  }
  if (success("B")) {
    return { suggested: "procedure", reasons };
  }
  if (success("C")) {
    return { suggested: "visual_detail", reasons };
  }
  return { suggested: "rules_logic", reasons };
}

export interface PathsDiagnosticArtifactInput {
  readonly directory: string;
  readonly result: PathsDiagnosticResult;
  readonly assets: PathsDiagnosticAssets;
  readonly prepared: readonly PreparedPathsDiagnosticCall[];
  readonly expected: CalibrationFixture["expected"];
  readonly packHash: string;
  readonly authorizedCapUsd: string;
  readonly maxActualCostUsd: string;
  readonly databasePath: string;
}

export interface PathsDiagnosticArtifactPaths {
  readonly directory: string;
  readonly diagnosticPath: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
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

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(directory: string): {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}[] {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
      } else if (stats.isFile()) {
        files.push({
          path: relative(directory, path).split("\\").join("/"),
          bytes: stats.size,
          sha256: fileSha256(path),
        });
      }
    }
  };
  walk(directory);
  return files;
}

export function writePathsDiagnosticArtifacts(
  input: PathsDiagnosticArtifactInput,
): PathsDiagnosticArtifactPaths {
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true });
  const imagesDirectory = join(directory, "images");
  mkdirSync(imagesDirectory, { recursive: true });
  const imagePaths = {
    original: join(imagesDirectory, "original.png"),
    sourceCrop: join(imagesDirectory, "source-edge-crop.png"),
    optionCCrop: join(imagesDirectory, "option-c-edge-crop.png"),
  };
  writeFileSync(imagePaths.original, input.assets.originalPng);
  writeFileSync(imagePaths.sourceCrop, input.assets.sourceCropPng);
  writeFileSync(imagePaths.optionCCrop, input.assets.optionCCropPng);
  const requestsPath = join(directory, "requests.jsonl");
  writeJsonl(
    requestsPath,
    input.prepared.map((call) => ({
      variant: call.variant,
      description: call.description,
      role: call.role,
      model: call.route.model,
      reservationUsd: call.reservationUsd,
      requestBody: call.request.body,
    })),
  );
  const responsesPath = join(directory, "responses.jsonl");
  writeJsonl(responsesPath, input.result.variants);
  const diagnosticPath = join(directory, "diagnostic.json");
  writeJson(diagnosticPath, {
    version: 1,
    diagnosticId: input.result.diagnosticId,
    mode: "paths-diagnostic",
    calibrationEligible: false,
    freezeEligible: false,
    status: input.result.status,
    fixtureId: input.result.fixtureId,
    packHash: input.packHash,
    model: input.result.model,
    expected: input.expected,
    variants: input.result.variants,
    classification: input.result.classification,
    cost: {
      knownUsd: input.result.knownCostUsd,
      unknownCalls: input.result.unknownCalls,
    },
    authorizedCapUsd: input.authorizedCapUsd,
    maxActualCostUsd: input.maxActualCostUsd,
    startedAt: input.result.startedAt,
    completedAt: input.result.completedAt,
    images: {
      original: "images/original.png",
      sourceEdgeCrop: "images/source-edge-crop.png",
      optionCEdgeCrop: "images/option-c-edge-crop.png",
    },
    artifacts: {
      requests: "requests.jsonl",
      responses: "responses.jsonl",
      database: relative(directory, resolve(input.databasePath))
        .split("\\")
        .join("/"),
    },
    limitations: [
      "Variants B-D change the information or procedure available to the model; their outcomes cannot be counted as a success of the original blind review or as calibration evidence.",
      "The diagnostic is a single-case, single-call-per-variant probe; it does not estimate reviewer accuracy.",
      "The original blind review and calibration scores remain unchanged; this artifact is freeze-ineligible.",
      "Provider-side image preprocessing remains unrecorded; the sent images are preserved in images/.",
    ],
  });
  const files = listFiles(directory).filter((file) => file.path !== "manifest.json");
  const manifestHash = hashCanonicalJson(files);
  const manifestPath = join(directory, "manifest.json");
  writeJson(manifestPath, {
    version: 1,
    diagnosticId: input.result.diagnosticId,
    createdAt: input.result.completedAt,
    files,
    manifestHash,
  });
  return { directory, diagnosticPath, manifestPath, manifestHash };
}
