import { createHash } from "node:crypto";
import type { ChoiceSet } from "../domain/answers.js";
import type { PathsSpec, PathRoute } from "../families/paths/schema.js";
import {
  PathsRenderError,
  pathsRenderer,
} from "../families/paths/render.js";
import {
  assertRasterEquivalent,
  readPng,
  renderScenePng,
} from "../render/png.js";
import {
  SCENE_SIZE,
  nodeBounds,
  type Scene,
  type SceneNode,
} from "../render/scene.js";
import { parseScene } from "../render/svg.js";
import type {
  CalibrationExpected,
  CalibrationMutation,
} from "./fixtures.js";

export interface PathsAssetAuditInput {
  readonly svg: string;
  readonly png: Buffer;
  readonly spec: PathsSpec;
  readonly choices: ChoiceSet<PathRoute>;
  readonly expected?: CalibrationExpected;
  readonly mutation?: CalibrationMutation;
}

export interface PathsAssetAuditResult {
  readonly status: "pass" | "fail";
  readonly sceneError: { readonly code: string; readonly message: string } | null;
  readonly rasterEquivalent: boolean;
  readonly rasterError: string | null;
  readonly optionCropHashes: readonly {
    readonly label: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly distinctOptionCount: number;
  readonly duplicateOptionGroups: readonly (readonly string[])[];
  readonly validOptionCount: number | null;
  readonly expectedValidOptionCount: 1;
  readonly checks: {
    readonly scene: boolean;
    readonly raster: boolean;
    readonly optionDistinctness: boolean;
    readonly singleValidOption: boolean;
  };
}

function findNode(
  nodes: readonly SceneNode[],
  id: string,
): SceneNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.kind === "group") {
      const found = findNode(node.children, id);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function cropNodeRgba(
  png: ReturnType<typeof readPng>,
  scene: Scene,
  nodeId: string,
): Buffer {
  const node = findNode(scene.nodes, nodeId);
  const bounds = node === undefined ? undefined : nodeBounds(node);
  if (bounds === undefined) {
    throw new Error(`missing ${nodeId} bounds`);
  }
  const scale = png.width / SCENE_SIZE;
  const x = Math.round(bounds.x * scale);
  const y = Math.round(bounds.y * scale);
  const width = Math.round(bounds.width * scale);
  const height = Math.round(bounds.height * scale);
  const output = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceIndex = ((y + row) * png.width + (x + column)) * 4;
      const targetIndex = (row * width + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        output[targetIndex + channel] = png.data[sourceIndex + channel] ?? 0;
      }
    }
  }
  return output;
}

function duplicateGroups(
  hashes: readonly { readonly label: string; readonly sha256: string }[],
): string[][] {
  const byHash = new Map<string, string[]>();
  for (const entry of hashes) {
    const labels = byHash.get(entry.sha256) ?? [];
    labels.push(entry.label);
    byHash.set(entry.sha256, labels);
  }
  return [...byHash.values()]
    .filter((labels) => labels.length > 1)
    .map((labels) => [...labels].sort());
}

function validOptionCount(
  expected: CalibrationExpected | undefined,
  mutation: CalibrationMutation | undefined,
  duplicates: readonly (readonly string[])[],
): number | null {
  if (expected === undefined) {
    return null;
  }
  if (expected.blind.acceptedDefectCodes.includes("CLOSED_ROUTE_EDGE")) {
    const details = mutation?.details as
      | { readonly solutionCount?: number; readonly offeredValidLabels?: readonly string[] }
      | undefined;
    if (details?.offeredValidLabels !== undefined) {
      return details.offeredValidLabels.length;
    }
    return details?.solutionCount === 0 ? 0 : null;
  }
  if (expected.blind.acceptedDefectCodes.includes("DUPLICATE_CORRECT_OPTION")) {
    const details = mutation?.details as
      | { readonly duplicatedLabel?: string; readonly correctLabel?: string }
      | undefined;
    const group = duplicates.find(
      (labels) =>
        labels.includes(details?.correctLabel ?? "") &&
        labels.includes(details?.duplicatedLabel ?? ""),
    );
    return group?.length ?? null;
  }
  if (expected.blind.result === "correct") {
    return 1;
  }
  return null;
}

export function auditPathsAsset(
  input: PathsAssetAuditInput,
): PathsAssetAuditResult {
  let scene: Scene;
  try {
    scene = parseScene(input.svg);
  } catch (error) {
    return {
      status: "fail",
      sceneError: {
        code: "SCENE_PARSE_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
      rasterEquivalent: false,
      rasterError: "scene parse failed",
      optionCropHashes: [],
      distinctOptionCount: 0,
      duplicateOptionGroups: [],
      validOptionCount: null,
      expectedValidOptionCount: 1,
      checks: {
        scene: false,
        raster: false,
        optionDistinctness: false,
        singleValidOption: false,
      },
    };
  }
  let sceneError: { code: string; message: string } | null = null;
  try {
    pathsRenderer.assertScene(scene, input.spec, input.choices);
  } catch (error) {
    const code =
      error instanceof PathsRenderError
        ? error.code
        : typeof (error as { code?: unknown }).code === "string"
          ? String((error as { code: unknown }).code)
          : "SCENE_ERROR";
    sceneError = {
      code,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const png = readPng(input.png);
  let rasterEquivalent = false;
  let rasterError: string | null = null;
  try {
    const rendered = renderScenePng(scene, png.width);
    assertRasterEquivalent(rendered, input.png);
    rasterEquivalent = true;
  } catch (error) {
    rasterError = error instanceof Error ? error.message : String(error);
  }

  const optionCropHashes = ["A", "B", "C", "D"].map((label) => {
    const crop = cropNodeRgba(png, scene, `option-${label}-maze`);
    return {
      label,
      sha256: createHash("sha256").update(crop).digest("hex"),
      bytes: crop.length,
    };
  });
  const duplicates = duplicateGroups(optionCropHashes);
  const distinctOptionCount = new Set(
    optionCropHashes.map((entry) => entry.sha256),
  ).size;
  const validCount = validOptionCount(input.expected, input.mutation, duplicates);
  const checks = {
    scene: sceneError === null,
    raster: rasterEquivalent,
    optionDistinctness: duplicates.length === 0,
    singleValidOption: validCount === 1,
  };
  return {
    status: Object.values(checks).every(Boolean) ? "pass" : "fail",
    sceneError,
    rasterEquivalent,
    rasterError,
    optionCropHashes,
    distinctOptionCount,
    duplicateOptionGroups: duplicates,
    validOptionCount: validCount,
    expectedValidOptionCount: 1,
    checks,
  };
}
