import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Difficulty } from "../../src/domain/experiment.js";
import type { D4Operation } from "../../src/families/contracts.js";
import { hashCanonicalJson } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";
import {
  PREVIEW_SIZE,
  SCENE_BACKGROUND,
  SCENE_INK,
  SCENE_PANEL,
  SCENE_SIZE,
  assertScene,
  nodeBounds,
  type Scene,
  type SceneNode,
  type ScenePoint,
} from "../../src/render/scene.js";
import {
  assertCriticalGroupChanged,
  assertPngDimensions,
  hashPng,
  readPng,
  renderScenePng,
} from "../../src/render/png.js";
import {
  TRANSFORM_RENDER_GRID_SIZE,
  TRANSFORMS_CRITICAL_GROUPS,
  TransformsRenderError,
  assertTransformsScene,
  buildTransformsScene,
  transformsRenderer,
  type TransformsChoiceInput,
  type TransformsRenderErrorCode,
} from "../../src/families/transforms/render.js";
import {
  constructTransformsSpec,
  transformsEngine,
} from "../../src/families/transforms/engine.js";
import {
  TransformsSpecSchema,
  gridFromCells,
  solveTransforms,
  type TransformCell,
  type TransformsSpec,
} from "../../src/families/transforms/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { main as previewMain } from "../../src/cli/preview.js";

const SOURCE: readonly TransformCell[] = [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 1, column: 1 },
  { row: 2, column: 1 },
];

function makeSpec(
  cells: readonly TransformCell[],
  operations: readonly D4Operation[],
): TransformsSpec {
  return TransformsSpecSchema.parse({
    source: gridFromCells(cells),
    operations,
  });
}

const baseSpec = makeSpec(SOURCE, ["rotate90"]);
const twoStepSpec = makeSpec(SOURCE, ["rotate90", "reflectLeftRight"]);
const reflectionSpec = makeSpec(SOURCE, ["reflectLeftRight"]);

function choicesFor(spec: TransformsSpec): readonly TransformsChoiceInput[] {
  const correct = solveTransforms(spec);
  const set = transformsEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
  return set.choices.map((choice) => ({ label: choice.label, cells: choice.value }));
}

function sceneFor(spec: TransformsSpec): {
  readonly scene: Scene;
  readonly choices: readonly TransformsChoiceInput[];
} {
  const choices = choicesFor(spec);
  return { scene: buildTransformsScene(spec, choices), choices };
}

function collectTexts(node: SceneNode): readonly string[] {
  if (node.kind === "text") {
    return [node.text];
  }
  if (node.kind !== "group") {
    return [];
  }
  return node.children.flatMap((child) => collectTexts(child));
}

function collectNodes(nodes: readonly SceneNode[]): readonly SceneNode[] {
  const collected: SceneNode[] = [];
  const visit = (node: SceneNode): void => {
    collected.push(node);
    if (node.kind === "group") {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return collected;
}

function nodeById(scene: Scene, id: string): SceneNode | undefined {
  return collectNodes(scene.nodes).find((node) => node.id === id);
}

function textsIn(scene: Scene, id: string): readonly string[] {
  const node = nodeById(scene, id);
  return node === undefined ? [] : collectTexts(node);
}

function replaceNode(
  scene: Scene,
  id: string,
  replace: (node: SceneNode) => SceneNode,
): Scene {
  const visit = (node: SceneNode): SceneNode => {
    if (node.id === id) {
      return replace(node);
    }
    if (node.kind === "group") {
      return { ...node, children: node.children.map(visit) };
    }
    return node;
  };
  return { ...scene, nodes: scene.nodes.map(visit) };
}

function removeNode(scene: Scene, id: string): Scene {
  const remove = (nodes: readonly SceneNode[]): SceneNode[] =>
    nodes
      .filter((node) => node.id !== id)
      .map((node) =>
        node.kind === "group" ? { ...node, children: remove(node.children) } : node,
      );
  return { ...scene, nodes: remove(scene.nodes) };
}

function removeRolesWithin(
  scene: Scene,
  rootId: string,
  roles: ReadonlySet<string>,
): Scene {
  const strip = (node: SceneNode): SceneNode | null => {
    if (node.role !== undefined && roles.has(node.role)) {
      return null;
    }
    if (node.kind !== "group") {
      return node;
    }
    return {
      ...node,
      children: node.children
        .map(strip)
        .filter((child): child is SceneNode => child !== null),
    };
  };
  const visit = (node: SceneNode): SceneNode => {
    if (node.id === rootId && node.kind === "group") {
      const stripped = strip(node);
      if (stripped === null || stripped.kind !== "group") {
        throw new Error("expected a group");
      }
      return stripped;
    }
    if (node.kind === "group") {
      return { ...node, children: node.children.map(visit) };
    }
    return node;
  };
  return { ...scene, nodes: scene.nodes.map(visit) };
}

function occupiedCells(scene: Scene, gridId: string): readonly TransformCell[] {
  const cells: TransformCell[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const cell = nodeById(scene, `${gridId}-cell-${row}-${column}`);
      if (cell !== undefined && cell.kind === "rect" && cell.fill === SCENE_INK) {
        cells.push({ row, column });
      }
    }
  }
  return cells;
}

function gridWidth(scene: Scene, gridId: string): number {
  const first = nodeById(scene, `${gridId}-cell-0-0`);
  const last = nodeById(scene, `${gridId}-cell-4-4`);
  if (first === undefined || last === undefined) {
    throw new Error(`missing ${gridId} corner cells`);
  }
  const firstBounds = nodeBounds(first);
  const lastBounds = nodeBounds(last);
  if (firstBounds === undefined || lastBounds === undefined) {
    throw new Error(`missing ${gridId} corner bounds`);
  }
  return lastBounds.x + lastBounds.width - firstBounds.x;
}

function cropGridRgba(
  png: ReturnType<typeof readPng>,
  scene: Scene,
  gridId: string,
  width: number,
): Buffer {
  const first = nodeById(scene, `${gridId}-cell-0-0`);
  const last = nodeById(scene, `${gridId}-cell-4-4`);
  if (first === undefined || last === undefined) {
    throw new Error(`missing ${gridId} corner cells`);
  }
  const firstBounds = nodeBounds(first);
  const lastBounds = nodeBounds(last);
  if (firstBounds === undefined || lastBounds === undefined) {
    throw new Error(`missing ${gridId} corner bounds`);
  }
  const scale = width / SCENE_SIZE;
  const x = Math.round(firstBounds.x * scale);
  const y = Math.round(firstBounds.y * scale);
  const cropWidth = Math.round(
    (lastBounds.x + lastBounds.width - firstBounds.x) * scale,
  );
  const cropHeight = Math.round(
    (lastBounds.y + lastBounds.height - firstBounds.y) * scale,
  );
  const output = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row += 1) {
    for (let column = 0; column < cropWidth; column += 1) {
      const sourceIndex = ((y + row) * png.width + (x + column)) * 4;
      const targetIndex = (row * cropWidth + column) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        output[targetIndex + channel] = png.data[sourceIndex + channel] ?? 0;
      }
    }
  }
  return output;
}

function assertOptionRastersDistinct(
  scene: Scene,
  png: ReturnType<typeof readPng>,
  width: number,
): void {
  const labels = ["A", "B", "C", "D"] as const;
  const crops = labels.map((label) =>
    cropGridRgba(png, scene, `option-${label}-grid`, width),
  );
  for (let left = 0; left < crops.length; left += 1) {
    for (let right = left + 1; right < crops.length; right += 1) {
      const first = crops[left];
      const second = crops[right];
      if (first === undefined || second === undefined) {
        throw new Error("missing option raster crop");
      }
      expect(first.equals(second)).toBe(false);
    }
  }
}

function removeCriticalMarks(scene: Scene, group: string): Scene {
  if (group === "operation-sequence") {
    return removeRolesWithin(
      scene,
      group,
      new Set(["rotation-arrow", "mirror-axis", "identity-mark"]),
    );
  }
  return removeNode(scene, group);
}

function assertRenderError(
  action: () => void,
  code: TransformsRenderErrorCode,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TransformsRenderError);
  expect((caught as TransformsRenderError).code).toBe(code);
}

function decorativeRotationArrow(): SceneNode {
  return {
    kind: "group",
    id: "decorative-rotation",
    role: "rotation-arrow",
    children: [
      {
        kind: "polyline",
        id: "decorative-rotation-arc",
        role: "arrow-arc",
        points: [
          { x: 940, y: 565 },
          { x: 955, y: 580 },
        ],
        fill: "none",
        stroke: SCENE_INK,
        strokeWidth: 4,
      },
      {
        kind: "polygon",
        id: "decorative-rotation-head",
        role: "arrow-head",
        points: [
          { x: 955, y: 580 },
          { x: 947, y: 576 },
          { x: 951, y: 570 },
        ],
        fill: SCENE_INK,
      },
    ],
  };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function operationCenter(scene: Scene, index: number): ScenePoint {
  const card = nodeById(scene, `operation-op${index}`);
  const bounds = card === undefined ? undefined : nodeBounds(card);
  if (bounds === undefined) {
    throw new Error(`missing operation-op${index} bounds`);
  }
  return { x: bounds.x + 80, y: bounds.y + 195 };
}

describe("transforms renderer", () => {
  it("builds a validated scene with ordered operations, axes, and same-scale grids", () => {
    const { scene, choices } = sceneFor(twoStepSpec);
    expect(() => assertScene(scene)).not.toThrow();
    expect(() => assertTransformsScene(scene, twoStepSpec, choices)).not.toThrow();
    expect(scene.width).toBe(SCENE_SIZE);
    expect(scene.height).toBe(SCENE_SIZE);
    for (const id of TRANSFORMS_CRITICAL_GROUPS) {
      expect(nodeById(scene, id)).toBeDefined();
    }
    expect(occupiedCells(scene, "source-grid")).toEqual([...SOURCE]);
    for (const choice of choices) {
      expect(occupiedCells(scene, `option-${choice.label}-grid`)).toEqual([
        ...choice.cells,
      ]);
    }
    const sourceWidth = gridWidth(scene, "source-grid");
    expect(sourceWidth).toBe(TRANSFORM_RENDER_GRID_SIZE);
    for (const choice of choices) {
      expect(gridWidth(scene, `option-${choice.label}-grid`)).toBe(sourceWidth);
    }

    const firstCell = nodeById(scene, "source-grid-cell-0-0");
    const pivot = nodeById(scene, "source-grid-pivot");
    const orientation = nodeById(scene, "source-grid-orientation");
    if (
      firstCell === undefined ||
      pivot === undefined ||
      orientation === undefined
    ) {
      throw new Error("expected source grid markers");
    }
    const firstBounds = nodeBounds(firstCell);
    const pivotBounds = nodeBounds(pivot);
    const orientationBounds = nodeBounds(orientation);
    if (
      firstBounds === undefined ||
      pivotBounds === undefined ||
      orientationBounds === undefined
    ) {
      throw new Error("expected source grid bounds");
    }
    expect(pivotBounds.x + pivotBounds.width / 2).toBe(
      firstBounds.x + TRANSFORM_RENDER_GRID_SIZE / 2,
    );
    expect(pivotBounds.y + pivotBounds.height / 2).toBe(
      firstBounds.y + TRANSFORM_RENDER_GRID_SIZE / 2,
    );
    expect(orientationBounds.y + orientationBounds.height).toBe(firstBounds.y - 4);

    const operationTexts = textsIn(scene, "operation-sequence");
    expect(operationTexts).toContain("Operations apply in order.");
    expect(operationTexts).toContain("First");
    expect(operationTexts).toContain("Then");
    expect(operationTexts).toContain("R90");
    expect(operationTexts).toContain("90° clockwise");
    expect(operationTexts).toContain("Mirror");
    expect(operationTexts).toContain("left-right axis");
    expect(nodeById(scene, "operation-op0-rotation-arrow")).toBeDefined();
    expect(nodeById(scene, "operation-op1-mirror-axis")).toBeDefined();

    const axisTexts = textsIn(scene, "axis-legend");
    expect(axisTexts).toContain("Viewer-relative axes and clockwise direction.");
    expect(axisTexts).toContain("Axes: top = up, right = right.");
    expect(axisTexts).toContain("Clockwise: top, right, bottom, left.");
    expect(axisTexts).toContain("Pivot: center (2,2); top marker = up.");
    expect(nodeById(scene, "axis-clockwise-arrow")).toBeDefined();

    expect(transformsRenderer.buildScene(twoStepSpec)).toEqual(
      buildTransformsScene(twoStepSpec),
    );
  });

  it("renders deterministic 1024/512 PNGs and distinct option rasters", () => {
    const { scene } = sceneFor(baseSpec);
    const full = renderScenePng(scene, SCENE_SIZE);
    const preview = renderScenePng(scene, PREVIEW_SIZE);
    expect(assertPngDimensions(full, SCENE_SIZE, SCENE_SIZE).width).toBe(SCENE_SIZE);
    expect(assertPngDimensions(preview, PREVIEW_SIZE, PREVIEW_SIZE).height).toBe(
      PREVIEW_SIZE,
    );
    expect(hashPng(renderScenePng(scene, SCENE_SIZE))).toBe(hashPng(full));
    expect(hashPng(renderScenePng(scene, PREVIEW_SIZE))).toBe(hashPng(preview));
    expect(readPng(full).width).toBe(SCENE_SIZE);
    assertOptionRastersDistinct(scene, readPng(preview), PREVIEW_SIZE);
  });

  it("rejects missing axes, reversed arrows, decorative rotations, and off-center grids", () => {
    const { scene, choices } = sceneFor(twoStepSpec);
    assertRenderError(
      () => assertTransformsScene(removeNode(scene, "axis-legend"), twoStepSpec, choices),
      "MISSING_AXIS",
    );
    const reversedArrow = replaceNode(
      scene,
      "operation-op0-rotation-arrow-arc",
      (node) =>
        node.kind === "polyline"
          ? { ...node, points: [...node.points].reverse() }
          : node,
    );
    assertRenderError(
      () => assertTransformsScene(reversedArrow, twoStepSpec, choices),
      "REVERSED_ARROW",
    );
    const counterClockwise = replaceNode(
      scene,
      "operation-op0-rotation-arrow-arc",
      (node) => {
        if (node.kind !== "polyline") {
          return node;
        }
        const center = operationCenter(scene, 0);
        const points = [-90, -180, -270, -360].map((degrees) => {
          const theta = (degrees * Math.PI) / 180;
          return {
            x: center.x + 32 * Math.cos(theta),
            y: center.y + 32 * Math.sin(theta),
          };
        });
        return { ...node, points };
      },
    );
    assertRenderError(
      () => assertTransformsScene(counterClockwise, twoStepSpec, choices),
      "REVERSED_ARROW",
    );
    const flippedHead = replaceNode(
      scene,
      "operation-op0-rotation-arrow-head",
      (node) => {
        if (node.kind !== "polygon") {
          return node;
        }
        const center = operationCenter(scene, 0);
        const end = { x: center.x + 32, y: center.y };
        return {
          ...node,
          points: [
            { x: end.x, y: end.y - 10 },
            { x: end.x - 7, y: end.y + 2 },
            { x: end.x + 7, y: end.y + 2 },
          ],
        };
      },
    );
    assertRenderError(
      () => assertTransformsScene(flippedHead, twoStepSpec, choices),
      "REVERSED_ARROW",
    );
    const chordArc = replaceNode(
      scene,
      "operation-op0-rotation-arrow-arc",
      (node) => {
        if (node.kind !== "polyline") {
          return node;
        }
        const center = operationCenter(scene, 0);
        const start = { x: center.x, y: center.y - 32 };
        const end = { x: center.x + 32, y: center.y };
        return { ...node, points: [start, end, end] };
      },
    );
    assertRenderError(
      () => assertTransformsScene(chordArc, twoStepSpec, choices),
      "REVERSED_ARROW",
    );
    const overRotatedArc = replaceNode(
      scene,
      "operation-op0-rotation-arrow-arc",
      (node) => {
        if (node.kind !== "polyline") {
          return node;
        }
        const center = operationCenter(scene, 0);
        const points = Array.from({ length: 19 }, (_, index) => {
          const theta = ((-90 + index * 25) * Math.PI) / 180;
          return {
            x: center.x + 32 * Math.cos(theta),
            y: center.y + 32 * Math.sin(theta),
          };
        });
        return { ...node, points };
      },
    );
    assertRenderError(
      () => assertTransformsScene(overRotatedArc, twoStepSpec, choices),
      "REVERSED_ARROW",
    );
    const reversedPivotPaint = replaceNode(
      scene,
      "source-grid-pivot",
      (node) =>
        node.kind === "group"
          ? { ...node, children: [...node.children].reverse() }
          : node,
    );
    assertRenderError(
      () => assertTransformsScene(reversedPivotPaint, twoStepSpec, choices),
      "INVISIBLE_MARKER",
    );
    const invisibleOrientation = replaceNode(
      scene,
      "source-grid-orientation",
      (node) =>
        node.kind === "polygon" ? { ...node, fill: SCENE_PANEL } : node,
    );
    assertRenderError(
      () => assertTransformsScene(invisibleOrientation, twoStepSpec, choices),
      "INVISIBLE_MARKER",
    );
    const invisiblePivot = replaceNode(
      scene,
      "source-grid-pivot-ring",
      (node) =>
        node.kind === "circle" ? { ...node, stroke: SCENE_PANEL } : node,
    );
    assertRenderError(
      () => assertTransformsScene(invisiblePivot, twoStepSpec, choices),
      "INVISIBLE_MARKER",
    );
    const decorative = replaceNode(scene, "legend", (node) =>
      node.kind === "group"
        ? { ...node, children: [...node.children, decorativeRotationArrow()] }
        : node,
    );
    assertRenderError(
      () => assertTransformsScene(decorative, twoStepSpec, choices),
      "DECORATIVE_ROTATION",
    );
    const offCenterPivot = replaceNode(scene, "source-grid-pivot", (node) => ({
      kind: "group",
      id: node.id,
      role: "pivot",
      children: [
        {
          kind: "circle",
          id: "source-grid-pivot-halo",
          role: "pivot-halo",
          cx: 100,
          cy: 180,
          r: 10,
          fill: SCENE_BACKGROUND,
        },
      ],
    }));
    assertRenderError(
      () => assertTransformsScene(offCenterPivot, twoStepSpec, choices),
      "OFF_CENTER_PIVOT",
    );
    assertRenderError(
      () =>
        assertTransformsScene(
          removeNode(scene, "source-grid-orientation"),
          twoStepSpec,
          choices,
        ),
      "MISSING_ORIENTATION",
    );
    const { scene: reflectionScene, choices: reflectionChoices } =
      sceneFor(reflectionSpec);
    const wrongAxis = replaceNode(
      reflectionScene,
      "operation-op0-mirror-axis",
      (node) => ({
        kind: "line",
        id: node.id,
        role: "mirror-axis",
        x1: 460,
        y1: 340,
        x2: 540,
        y2: 340,
        stroke: SCENE_INK,
        strokeWidth: 4,
      }),
    );
    assertRenderError(
      () => assertTransformsScene(wrongAxis, reflectionSpec, reflectionChoices),
      "WRONG_AXIS",
    );
    const reversedOrder = replaceNode(
      scene,
      "operation-op0-order-word",
      (node) => (node.kind === "text" ? { ...node, text: "Then" } : node),
    );
    assertRenderError(
      () => assertTransformsScene(reversedOrder, twoStepSpec, choices),
      "REVERSED_ORDER",
    );
    const wrongGeometry = replaceNode(
      scene,
      "source-grid-cell-0-0",
      (node) => (node.kind === "rect" ? { ...node, fill: SCENE_PANEL } : node),
    );
    assertRenderError(
      () => assertTransformsScene(wrongGeometry, twoStepSpec, choices),
      "WRONG_GEOMETRY",
    );
    assertRenderError(
      () => assertTransformsScene(removeNode(scene, "operation-op1"), twoStepSpec, choices),
      "MISSING_OPERATION",
    );
    const firstChoice = choices[0];
    if (firstChoice === undefined) {
      throw new Error("expected a first choice");
    }
    const duplicateChoices = choices.map((choice, index) =>
      index === 1 ? { ...choice, cells: firstChoice.cells } : choice,
    );
    assertRenderError(
      () => buildTransformsScene(twoStepSpec, duplicateChoices),
      "OPTION_NOT_DISTINCT",
    );
  });

  it("rasterizes 100 seeded scenes with bounds and distinct option rasters", () => {
    const difficulties: Difficulty[] = [
      ...Array.from({ length: 34 }, () => 1 as Difficulty),
      ...Array.from({ length: 33 }, () => 2 as Difficulty),
      ...Array.from({ length: 33 }, () => 3 as Difficulty),
    ];
    const hashes = new Set<string>();
    for (const [index, difficulty] of difficulties.entries()) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `transforms-render-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructTransformsSpec(seed, difficulty);
      const scene = transformsRenderer.buildScene(spec);
      assertScene(scene);
      const png = renderScenePng(scene, PREVIEW_SIZE);
      assertPngDimensions(png, PREVIEW_SIZE, PREVIEW_SIZE);
      assertOptionRastersDistinct(scene, readPng(png), PREVIEW_SIZE);
      hashes.add(hashPng(png));
    }
    expect(hashes.size).toBeGreaterThan(1);
  }, 120000);

  it("detects removed critical groups in fixed and ten seeded cases", () => {
    const fixed = [baseSpec, twoStepSpec, reflectionSpec];
    for (const spec of fixed) {
      const { scene } = sceneFor(spec);
      const full = renderScenePng(scene, PREVIEW_SIZE);
      for (const group of TRANSFORMS_CRITICAL_GROUPS) {
        const removed = removeCriticalMarks(scene, group);
        assertScene(removed);
        const removedPng = renderScenePng(removed, PREVIEW_SIZE);
        expect(
          assertCriticalGroupChanged(full, removedPng, scene.background, 8)
            .changedNonBackgroundPixels,
        ).toBeGreaterThanOrEqual(8);
      }
    }
    for (let index = 0; index < 10; index += 1) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `transforms-critical-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructTransformsSpec(seed, ((index % 3) + 1) as Difficulty);
      const scene = transformsRenderer.buildScene(spec);
      const group = TRANSFORMS_CRITICAL_GROUPS[index % TRANSFORMS_CRITICAL_GROUPS.length];
      if (group === undefined) {
        throw new Error("expected a critical group");
      }
      const full = renderScenePng(scene, PREVIEW_SIZE);
      const removed = removeCriticalMarks(scene, group);
      assertScene(removed);
      const removedPng = renderScenePng(removed, PREVIEW_SIZE);
      expect(
        assertCriticalGroupChanged(full, removedPng, scene.background, 8)
          .changedNonBackgroundPixels,
      ).toBeGreaterThanOrEqual(8);
    }
  }, 120000);

  it("runs the transforms preview CLI and registers the real renderer", async () => {
    const directory = tempDir("p14-transforms-");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exitCode = await previewMain([
        "node",
        "preview",
        "--family",
        "transforms",
        "--seed",
        "preview-v1",
        "--out",
        directory,
      ]);
      expect(exitCode).toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("family: transforms");
      expect(output).toContain("preview_png:");
      expect(existsSync(join(directory, "transforms-preview-v1.svg"))).toBe(true);
      expect(existsSync(join(directory, "transforms-preview-v1-512.png"))).toBe(true);
      expect(productionRegistry.hasRenderer("transforms")).toBe(true);
      expect(productionRegistry.listRendererFamilies()).toContain("transforms");

      write.mockClear();
      const difficultyThree = await previewMain([
        "node",
        "preview",
        "--family",
        "transforms",
        "--seed",
        "preview-v3",
        "--difficulty",
        "3",
        "--out",
        directory,
      ]);
      expect(difficultyThree).toBe(0);
      const difficultyOutput = write.mock.calls
        .map((call) => String(call[0]))
        .join("");
      expect(difficultyOutput).toContain("difficulty: 3");
      expect(existsSync(join(directory, "transforms-preview-v3-512.png"))).toBe(true);

      const invalidDifficulty = await previewMain([
        "node",
        "preview",
        "--family",
        "transforms",
        "--seed",
        "preview-v1",
        "--difficulty",
        "4",
        "--out",
        directory,
      ]);
      expect(invalidDifficulty).toBe(1);
    } finally {
      write.mockRestore();
      stderr.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
