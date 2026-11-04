import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deepEqual } from "../../src/domain/answers.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import { hashCanonicalJson } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";
import {
  PREVIEW_SIZE,
  SCENE_INK,
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
  PATH_BLOCKED_FILL,
  PATH_WALL_STROKE,
  PATHS_CRITICAL_GROUPS,
  PathsRenderError,
  assertPathsScene,
  buildPathsScene,
  pathsRenderer,
  type PathsChoiceInput,
  type PathsRenderErrorCode,
} from "../../src/families/paths/render.js";
import {
  constructPathsSpec,
  pathsEngine,
} from "../../src/families/paths/engine.js";
import {
  PathsSpecSchema,
  findTreeRoute,
  routeUsesClosedCorridor,
  sortPathCells,
  sortPathEdges,
  type PathCell,
  type PathEdge,
  type PathsSpec,
} from "../../src/families/paths/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { main as previewMain } from "../../src/cli/preview.js";

const SEED_A = "0".repeat(64);

const BASE_ACTIVE: readonly PathCell[] = [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 0, column: 2 },
  { row: 1, column: 0 },
  { row: 1, column: 1 },
  { row: 1, column: 2 },
];

const BASE_EDGES: readonly PathEdge[] = [
  { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
  { from: { row: 0, column: 0 }, to: { row: 1, column: 0 } },
  { from: { row: 0, column: 1 }, to: { row: 0, column: 2 } },
  { from: { row: 1, column: 0 }, to: { row: 1, column: 1 } },
  { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } },
];

const baseSpec = PathsSpecSchema.parse({
  active: sortPathCells(BASE_ACTIVE),
  edges: sortPathEdges(BASE_EDGES),
  start: { row: 0, column: 0 },
  goal: { row: 1, column: 2 },
});

function choicesFor(spec: PathsSpec): readonly PathsChoiceInput[] {
  const correct = findTreeRoute(spec.active, spec.edges, spec.start, spec.goal);
  if (correct === undefined) {
    throw new Error("expected a tree route");
  }
  const set = pathsEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
  return set.choices.map((choice) => ({ label: choice.label, route: choice.value }));
}

function sceneFor(spec: PathsSpec): {
  readonly scene: Scene;
  readonly choices: readonly PathsChoiceInput[];
} {
  const choices = choicesFor(spec);
  return { scene: buildPathsScene(spec, choices), choices };
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

function collectTexts(node: SceneNode): readonly string[] {
  if (node.kind === "text") {
    return [node.text];
  }
  if (node.kind !== "group") {
    return [];
  }
  return node.children.flatMap((child) => collectTexts(child));
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

function mazeGridOrigin(scene: Scene, mazeId: string): ScenePoint {
  const cell = nodeById(scene, `${mazeId}-cell-0-0`);
  const bounds = cell === undefined ? undefined : nodeBounds(cell);
  if (bounds === undefined) {
    throw new Error(`missing ${mazeId} origin`);
  }
  return { x: bounds.x, y: bounds.y };
}

function mazeCellFills(scene: Scene, mazeId: string): readonly string[] {
  const fills: string[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const cell = nodeById(scene, `${mazeId}-cell-${row}-${column}`);
      fills.push(
        cell !== undefined && cell.kind === "rect"
          ? (cell.fill ?? "missing")
          : "missing",
      );
    }
  }
  return fills;
}

function mazeWallIds(scene: Scene, mazeId: string): readonly string[] {
  const maze = nodeById(scene, mazeId);
  if (maze === undefined) {
    throw new Error(`missing ${mazeId}`);
  }
  return collectNodes([maze])
    .filter((node) => node.role === "wall")
    .map((node) =>
      node.id.startsWith(`${mazeId}-`) ? node.id.slice(mazeId.length + 1) : node.id,
    )
    .sort();
}

function markerCenter(scene: Scene, markerId: string): ScenePoint {
  const halo = nodeById(scene, `${markerId}-halo`);
  if (halo === undefined || halo.kind !== "circle") {
    throw new Error(`missing ${markerId} halo`);
  }
  return { x: halo.cx, y: halo.cy };
}

function routePoints(scene: Scene, mazeId: string): readonly ScenePoint[] {
  const line = nodeById(scene, `${mazeId}-route-line`);
  if (line === undefined || line.kind !== "polyline") {
    throw new Error(`missing ${mazeId} route line`);
  }
  return line.points;
}

function cellCenter(grid: ScenePoint, cell: PathCell): ScenePoint {
  return {
    x: grid.x + cell.column * 40 + 20,
    y: grid.y + cell.row * 40 + 20,
  };
}

function cropNodeRgba(
  png: ReturnType<typeof readPng>,
  scene: Scene,
  nodeId: string,
  width: number,
): Buffer {
  const node = nodeById(scene, nodeId);
  const bounds = node === undefined ? undefined : nodeBounds(node);
  if (bounds === undefined) {
    throw new Error(`missing ${nodeId} bounds`);
  }
  const scale = width / SCENE_SIZE;
  const x = Math.round(bounds.x * scale);
  const y = Math.round(bounds.y * scale);
  const cropWidth = Math.round(bounds.width * scale);
  const cropHeight = Math.round(bounds.height * scale);
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
    cropNodeRgba(png, scene, `option-${label}-maze`, width),
  );
  for (let left = 0; left < crops.length; left += 1) {
    for (let right = left + 1; right < crops.length; right += 1) {
      const first = crops[left];
      const second = crops[right];
      if (first === undefined || second === undefined) {
        throw new Error("missing option maze crop");
      }
      expect(first.equals(second)).toBe(false);
    }
  }
}

function luminanceAt(
  png: ReturnType<typeof readPng>,
  sceneX: number,
  sceneY: number,
  width: number,
): number {
  const scale = width / SCENE_SIZE;
  const x = Math.round(sceneX * scale);
  const y = Math.round(sceneY * scale);
  const index = (y * png.width + x) * 4;
  const red = png.data[index] ?? 0;
  const green = png.data[index + 1] ?? 0;
  const blue = png.data[index + 2] ?? 0;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function assertRenderError(
  action: () => void,
  code: PathsRenderErrorCode,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PathsRenderError);
  expect((caught as PathsRenderError).code).toBe(code);
}

function removeCriticalGroup(scene: Scene, group: string): Scene {
  return removeNode(scene, group);
}

describe("paths renderer", () => {
  it("builds a checked maze and four identical-maze route choices", () => {
    const { scene, choices } = sceneFor(baseSpec);
    expect(() => assertScene(scene)).not.toThrow();
    expect(() => assertPathsScene(scene, baseSpec, choices)).not.toThrow();
    expect(scene.width).toBe(SCENE_SIZE);
    for (const id of PATHS_CRITICAL_GROUPS) {
      expect(nodeById(scene, id)).toBeDefined();
    }
    const sourceFills = mazeCellFills(scene, "source-maze");
    for (const choice of choices) {
      expect(mazeCellFills(scene, `option-${choice.label}-maze`)).toEqual(sourceFills);
      expect(mazeWallIds(scene, `option-${choice.label}-maze`)).toEqual(
        mazeWallIds(scene, "source-maze"),
      );
      const grid = mazeGridOrigin(scene, `option-${choice.label}-maze`);
      const points = routePoints(scene, `option-${choice.label}-maze`);
      expect(points).toEqual(choice.route.map((cell) => cellCenter(grid, cell)));
      expect(
        markerCenter(scene, `option-${choice.label}-maze-start-marker`),
      ).toEqual(cellCenter(grid, baseSpec.start));
      expect(
        markerCenter(scene, `option-${choice.label}-maze-goal-marker`),
      ).toEqual(cellCenter(grid, baseSpec.goal));
    }
    const sourceGrid = mazeGridOrigin(scene, "source-maze");
    expect(markerCenter(scene, "source-maze-start-marker")).toEqual(
      cellCenter(sourceGrid, baseSpec.start),
    );
    expect(markerCenter(scene, "source-maze-goal-marker")).toEqual(
      cellCenter(sourceGrid, baseSpec.goal),
    );
    const sourceWalls = mazeWallIds(scene, "source-maze");
    expect(sourceWalls).not.toContain("wall-v-0-0");
    expect(sourceWalls).toContain("wall-h-0-1");
    expect(sourceWalls).toContain("outer-wall");
    expect(textsIn(scene, "wall-legend")).toContain("Thick black lines = walls.");
    expect(textsIn(scene, "wall-legend")).toContain(
      "Gaps between cells = open corridors.",
    );
    expect(textsIn(scene, "wall-legend")).toContain(
      "Blue route; walls cover blocked crossings.",
    );
    expect(deepEqual(pathsRenderer.buildScene(baseSpec), buildPathsScene(baseSpec))).toBe(
      true,
    );
  });

  it("renders deterministic 1024/512 PNGs with distinct route rasters and grayscale walls", () => {
    const { scene } = sceneFor(baseSpec);
    const full = renderScenePng(scene, SCENE_SIZE);
    const preview = renderScenePng(scene, PREVIEW_SIZE);
    expect(assertPngDimensions(full, SCENE_SIZE, SCENE_SIZE).width).toBe(SCENE_SIZE);
    expect(assertPngDimensions(preview, PREVIEW_SIZE, PREVIEW_SIZE).height).toBe(
      PREVIEW_SIZE,
    );
    expect(hashPng(renderScenePng(scene, SCENE_SIZE))).toBe(hashPng(full));
    expect(hashPng(renderScenePng(scene, PREVIEW_SIZE))).toBe(hashPng(preview));
    const png = readPng(preview);
    assertOptionRastersDistinct(scene, png, PREVIEW_SIZE);
    const grid = mazeGridOrigin(scene, "source-maze");
    const wallLuminance = luminanceAt(png, grid.x + 80, grid.y, PREVIEW_SIZE);
    const cellLuminance = luminanceAt(png, grid.x + 60, grid.y + 20, PREVIEW_SIZE);
    const corridorLuminance = luminanceAt(
      png,
      grid.x + 40,
      grid.y + 20,
      PREVIEW_SIZE,
    );
    expect(wallLuminance).toBeLessThan(100);
    expect(cellLuminance).toBeGreaterThan(150);
    expect(corridorLuminance).toBeGreaterThan(150);
    expect(cellLuminance - wallLuminance).toBeGreaterThan(80);
    expect(corridorLuminance - wallLuminance).toBeGreaterThan(80);
  });

  it("rejects hidden walls, clipped endpoints, diagonals, changed mazes, and wall paint order", () => {
    const { scene, choices } = sceneFor(baseSpec);
    assertRenderError(
      () =>
        assertPathsScene(
          removeNode(scene, "source-maze-wall-h-0-1"),
          baseSpec,
          choices,
        ),
      "MISSING_WALL",
    );
    const clippedEndpoint = replaceNode(
      scene,
      "source-maze-start-marker-label",
      (node) =>
        node.kind === "text" ? { ...node, fontSize: 40 } : node,
    );
    assertRenderError(
      () => assertPathsScene(clippedEndpoint, baseSpec, choices),
      "CLIPPED_ENDPOINT",
    );
    const displacedLabel = replaceNode(
      scene,
      "source-maze-start-marker-label",
      (node) => (node.kind === "text" ? { ...node, x: node.x + 40 } : node),
    );
    assertRenderError(
      () => assertPathsScene(displacedLabel, baseSpec, choices),
      "WRONG_ENDPOINT",
    );
    const displacedOptionLabel = replaceNode(
      scene,
      "option-A-maze-start-marker-label",
      (node) => (node.kind === "text" ? { ...node, x: node.x + 40 } : node),
    );
    assertRenderError(
      () => assertPathsScene(displacedOptionLabel, baseSpec, choices),
      "CHANGED_MAZE",
    );
    const displacedHalo = replaceNode(
      scene,
      "option-A-maze-route-halo",
      (node) => {
        if (node.kind !== "polyline") {
          return node;
        }
        const points = [...node.points];
        const first = points[0];
        if (first !== undefined) {
          points[0] = { x: first.x + 10, y: first.y };
        }
        return { ...node, points };
      },
    );
    assertRenderError(
      () => assertPathsScene(displacedHalo, baseSpec, choices),
      "WRONG_ROUTE",
    );
    const diagonal = replaceNode(
      scene,
      "option-A-maze-route-line",
      (node) => {
        if (node.kind !== "polyline") {
          return node;
        }
        const points = [...node.points];
        const optionGrid = mazeGridOrigin(scene, "option-A-maze");
        points[1] = { x: optionGrid.x + 60, y: optionGrid.y + 60 };
        return { ...node, points };
      },
    );
    assertRenderError(
      () => assertPathsScene(diagonal, baseSpec, choices),
      "ILLEGAL_DIAGONAL",
    );
    const changedMaze = replaceNode(scene, "option-A-maze-cell-0-0", (node) =>
      node.kind === "rect" ? { ...node, fill: PATH_BLOCKED_FILL } : node,
    );
    assertRenderError(
      () => assertPathsScene(changedMaze, baseSpec, choices),
      "CHANGED_MAZE",
    );
    const paintOrder = replaceNode(scene, "option-A-maze", (node) => {
      if (node.kind !== "group") {
        return node;
      }
      const route = node.children.find((child) => child.id === "option-A-maze-route");
      const walls = node.children.find((child) => child.id === "option-A-maze-walls");
      if (route === undefined || walls === undefined) {
        return node;
      }
      const withoutRoute = node.children.filter((child) => child.id !== route.id);
      const wallsIndex = withoutRoute.findIndex((child) => child.id === walls.id);
      const reordered = [...withoutRoute];
      reordered.splice(wallsIndex + 1, 0, route);
      return { ...node, children: reordered };
    });
    assertRenderError(
      () => assertPathsScene(paintOrder, baseSpec, choices),
      "WALL_PAINT_ORDER",
    );
    assertRenderError(
      () => assertPathsScene(removeNode(scene, "wall-legend"), baseSpec, choices),
      "MISSING_LEGEND",
    );
    const unexpectedWall = replaceNode(scene, "source-maze-walls", (node) => {
      if (node.kind !== "group") {
        return node;
      }
      const sourceGrid = mazeGridOrigin(scene, "source-maze");
      return {
        ...node,
        children: [
          ...node.children,
          {
            kind: "line",
            id: "source-maze-wall-v-0-0-extra",
            role: "wall",
            x1: sourceGrid.x + 40,
            y1: sourceGrid.y,
            x2: sourceGrid.x + 40,
            y2: sourceGrid.y + 40,
            stroke: SCENE_INK,
            strokeWidth: PATH_WALL_STROKE,
          },
        ],
      };
    });
    assertRenderError(
      () => assertPathsScene(unexpectedWall, baseSpec, choices),
      "UNEXPECTED_WALL",
    );
  });

  it("keeps false routes visibly blocked and options semantically distinct", () => {
    const { scene, choices } = sceneFor(baseSpec);
    const falseChoices = choices.filter(
      (choice) => !pathsEngine.verifyAnswer(baseSpec, [...choice.route]),
    );
    expect(falseChoices).toHaveLength(3);
    for (const choice of falseChoices) {
      expect(routeUsesClosedCorridor(baseSpec, choice.route)).toBe(true);
      const routeGroup = nodeById(scene, `option-${choice.label}-maze-route`);
      const wallsGroup = nodeById(scene, `option-${choice.label}-maze-walls`);
      expect(routeGroup).toBeDefined();
      expect(wallsGroup).toBeDefined();
    }
    const first = choices[0];
    if (first === undefined) {
      throw new Error("expected a first choice");
    }
    const duplicate = choices.map((choice, index) =>
      index === 1 ? { ...choice, route: first.route } : choice,
    );
    assertRenderError(
      () => buildPathsScene(baseSpec, duplicate),
      "OPTION_NOT_DISTINCT",
    );
  });

  it("rasterizes 100 seeded scenes with bounds and distinct route rasters", () => {
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
        slotId: `paths-render-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructPathsSpec(seed, difficulty);
      const scene = pathsRenderer.buildScene(spec);
      assertScene(scene);
      const png = renderScenePng(scene, PREVIEW_SIZE);
      assertPngDimensions(png, PREVIEW_SIZE, PREVIEW_SIZE);
      assertOptionRastersDistinct(scene, readPng(png), PREVIEW_SIZE);
      hashes.add(hashPng(png));
    }
    expect(hashes.size).toBeGreaterThan(1);
  }, 120000);

  it("detects removed critical groups in fixed and ten seeded cases", () => {
    const fixed = [baseSpec, constructPathsSpec(SEED_A, 3).spec];
    for (const spec of fixed) {
      const { scene } = sceneFor(spec);
      const full = renderScenePng(scene, PREVIEW_SIZE);
      for (const group of PATHS_CRITICAL_GROUPS) {
        const removed = removeCriticalGroup(scene, group);
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
        slotId: `paths-critical-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructPathsSpec(seed, ((index % 3) + 1) as Difficulty);
      const scene = pathsRenderer.buildScene(spec);
      const group = PATHS_CRITICAL_GROUPS[index % PATHS_CRITICAL_GROUPS.length];
      if (group === undefined) {
        throw new Error("expected a critical group");
      }
      const full = renderScenePng(scene, PREVIEW_SIZE);
      const removed = removeCriticalGroup(scene, group);
      assertScene(removed);
      const removedPng = renderScenePng(removed, PREVIEW_SIZE);
      expect(
        assertCriticalGroupChanged(full, removedPng, scene.background, 8)
          .changedNonBackgroundPixels,
      ).toBeGreaterThanOrEqual(8);
    }
  }, 120000);

  it("runs the paths preview CLI and registers the real renderer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p16-paths-"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await previewMain([
        "node",
        "preview",
        "--family",
        "paths",
        "--seed",
        "preview-v1",
        "--out",
        directory,
      ]);
      expect(exitCode).toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("family: paths");
      expect(output).toContain("preview_png:");
      expect(existsSync(join(directory, "paths-preview-v1.svg"))).toBe(true);
      expect(existsSync(join(directory, "paths-preview-v1-512.png"))).toBe(true);
      expect(productionRegistry.hasRenderer("paths")).toBe(true);
      expect(productionRegistry.listRendererFamilies()).toContain("paths");
    } finally {
      write.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
