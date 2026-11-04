import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Difficulty } from "../../src/domain/experiment.js";
import { hashCanonicalJson } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";
import {
  PREVIEW_SIZE,
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
  SYMMETRY_AXIS_INK,
  SYMMETRY_CRITICAL_GROUPS,
  SYMMETRY_EMPTY_FILL,
  SYMMETRY_OCCUPIED_FILL,
  SYMMETRY_UNKNOWN_FILL,
  SymmetryRenderError,
  assertSymmetryScene,
  buildSymmetryScene,
  symmetryRenderer,
  type SymmetryChoiceInput,
  type SymmetryRenderErrorCode,
} from "../../src/families/symmetry/render.js";
import {
  constructSymmetrySpec,
  symmetryEngine,
} from "../../src/families/symmetry/engine.js";
import {
  SymmetrySpecSchema,
  completeSymmetry,
  knownEmptyCells,
  knownOccupiedCells,
  missingSymmetryCells,
  type SymmetryAxis,
  type SymmetryCell,
  type SymmetryCellState,
  type SymmetrySpec,
} from "../../src/families/symmetry/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { main as previewMain } from "../../src/cli/preview.js";

const SEED_A = "0".repeat(64);

const BASE_OCCUPIED: readonly SymmetryCell[] = [
  { row: 0, column: 0 },
  { row: 1, column: 0 },
  { row: 1, column: 1 },
  { row: 2, column: 2 },
];

function makeSpec(
  axis: SymmetryAxis,
  occupied: readonly SymmetryCell[],
): SymmetrySpec {
  const occupiedKeys = new Set(
    occupied.map((cell) => `${cell.row}:${cell.column}`),
  );
  const cells: SymmetryCellState[][] = Array.from(
    { length: 8 },
    () => Array.from({ length: 8 }, () => "unknown" as const),
  );
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const known = axis === "vertical" ? column < 4 : row < 4;
      if (known) {
        const targetRow = cells[row];
        if (targetRow !== undefined) {
          targetRow[column] = occupiedKeys.has(`${row}:${column}`)
            ? "occupied"
            : "empty";
        }
      }
    }
  }
  return SymmetrySpecSchema.parse({ axis, cells });
}

const baseSpec = makeSpec("vertical", BASE_OCCUPIED);
const horizontalSpec = makeSpec(
  "horizontal",
  BASE_OCCUPIED.map((cell) => ({ row: cell.column, column: cell.row })),
);

function choicesFor(spec: SymmetrySpec): readonly SymmetryChoiceInput[] {
  const correct = completeSymmetry(spec);
  const set = symmetryEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
  return set.choices.map((choice) => ({ label: choice.label, answer: choice.value }));
}

function sceneFor(spec: SymmetrySpec): {
  readonly scene: Scene;
  readonly choices: readonly SymmetryChoiceInput[];
} {
  const choices = choicesFor(spec);
  return { scene: buildSymmetryScene(spec, choices), choices };
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

function collectByRole(node: SceneNode, role: string): readonly SceneNode[] {
  return collectNodes([node]).filter((candidate) => candidate.role === role);
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

function tileGridOrigin(scene: Scene, tileId: string): ScenePoint {
  const cell = nodeById(scene, `${tileId}-cell-0-0`);
  const bounds = cell === undefined ? undefined : nodeBounds(cell);
  if (bounds === undefined) {
    throw new Error(`missing ${tileId} origin`);
  }
  return { x: bounds.x, y: bounds.y };
}

function cellFill(scene: Scene, tileId: string, row: number, column: number): string {
  const cell = nodeById(scene, `${tileId}-cell-${row}-${column}`);
  if (cell === undefined || cell.kind !== "rect") {
    throw new Error(`missing ${tileId} cell ${row},${column}`);
  }
  return cell.fill ?? "missing";
}

function cellCenter(grid: ScenePoint, row: number, column: number): ScenePoint {
  return {
    x: grid.x + column * 22 + 11,
    y: grid.y + row * 22 + 11,
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

function assertOptionTilesDistinct(
  scene: Scene,
  png: ReturnType<typeof readPng>,
  width: number,
): void {
  const labels = ["A", "B", "C", "D"] as const;
  const crops = labels.map((label) =>
    cropNodeRgba(png, scene, `option-${label}-tile`, width),
  );
  for (let left = 0; left < crops.length; left += 1) {
    for (let right = left + 1; right < crops.length; right += 1) {
      const first = crops[left];
      const second = crops[right];
      if (first === undefined || second === undefined) {
        throw new Error("missing option tile crop");
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
  code: SymmetryRenderErrorCode,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SymmetryRenderError);
  expect((caught as SymmetryRenderError).code).toBe(code);
}

function removeCriticalGroup(scene: Scene, group: string): Scene {
  return removeNode(scene, group);
}

describe("symmetry renderer", () => {
  it("builds a source with unknown gray, a dashed labeled axis, and four full completions", () => {
    const { scene, choices } = sceneFor(baseSpec);
    expect(() => assertScene(scene)).not.toThrow();
    expect(() => assertSymmetryScene(scene, baseSpec, choices)).not.toThrow();
    expect(scene.width).toBe(SCENE_SIZE);
    for (const id of SYMMETRY_CRITICAL_GROUPS) {
      expect(nodeById(scene, id)).toBeDefined();
    }
    for (const cell of knownOccupiedCells(baseSpec)) {
      expect(cellFill(scene, "source-tile", cell.row, cell.column)).toBe(
        SYMMETRY_OCCUPIED_FILL,
      );
    }
    for (const cell of knownEmptyCells(baseSpec)) {
      expect(cellFill(scene, "source-tile", cell.row, cell.column)).toBe(
        SYMMETRY_EMPTY_FILL,
      );
    }
    for (const cell of missingSymmetryCells(baseSpec.axis)) {
      expect(cellFill(scene, "source-tile", cell.row, cell.column)).toBe(
        SYMMETRY_UNKNOWN_FILL,
      );
    }
    for (const choice of choices) {
      for (const cell of knownOccupiedCells(baseSpec)) {
        expect(cellFill(scene, `option-${choice.label}-tile`, cell.row, cell.column)).toBe(
          SYMMETRY_OCCUPIED_FILL,
        );
      }
      for (const cell of knownEmptyCells(baseSpec)) {
        expect(cellFill(scene, `option-${choice.label}-tile`, cell.row, cell.column)).toBe(
          SYMMETRY_EMPTY_FILL,
        );
      }
      for (let row = 0; row < 8; row += 1) {
        for (let column = 0; column < 8; column += 1) {
          const fill = cellFill(scene, `option-${choice.label}-tile`, row, column);
          expect(fill === SYMMETRY_OCCUPIED_FILL || fill === SYMMETRY_EMPTY_FILL).toBe(
            true,
          );
        }
      }
    }
    const sourceGrid = tileGridOrigin(scene, "source-tile");
    const sourceAxis = nodeById(scene, "source-axis");
    if (sourceAxis === undefined) {
      throw new Error("missing source axis");
    }
    const dashes = collectByRole(sourceAxis, "axis-dash");
    expect(dashes.length).toBeGreaterThanOrEqual(6);
    for (const dash of dashes) {
      if (dash.kind !== "line") {
        throw new Error("expected line dash");
      }
      expect(dash.stroke).toBe(SYMMETRY_AXIS_INK);
      expect(dash.x1).toBe(sourceGrid.x + 88);
      expect(dash.x2).toBe(sourceGrid.x + 88);
    }
    expect(textsIn(scene, "source-axis-label")).toContain("axis");
    expect(textsIn(scene, "state-legend")).toContain("Gray = unknown");
    expect(textsIn(scene, "state-legend")).toContain("White = empty");
    expect(textsIn(scene, "state-legend")).toContain("Black = filled");
    expect(textsIn(scene, "state-legend")).toContain("Dashed red = axis.");

    const horizontal = sceneFor(horizontalSpec);
    expect(() => assertSymmetryScene(horizontal.scene, horizontalSpec, horizontal.choices)).not.toThrow();
    const horizontalGrid = tileGridOrigin(horizontal.scene, "source-tile");
    const horizontalAxis = nodeById(horizontal.scene, "source-axis");
    if (horizontalAxis === undefined) {
      throw new Error("missing horizontal axis");
    }
    for (const dash of collectByRole(horizontalAxis, "axis-dash")) {
      if (dash.kind !== "line") {
        throw new Error("expected horizontal dash");
      }
      expect(dash.y1).toBe(horizontalGrid.y + 88);
      expect(dash.y2).toBe(horizontalGrid.y + 88);
    }
    expect(symmetryRenderer.buildScene(baseSpec)).toEqual(buildSymmetryScene(baseSpec));
  });

  it("renders deterministic PNGs with distinct option tiles and clear state contrast", () => {
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
    assertOptionTilesDistinct(scene, png, PREVIEW_SIZE);
    const grid = tileGridOrigin(scene, "source-tile");
    const occupied = cellCenter(grid, 0, 0);
    const empty = cellCenter(grid, 0, 1);
    const unknown = cellCenter(grid, 0, 4);
    const occupiedLuminance = luminanceAt(png, occupied.x, occupied.y, PREVIEW_SIZE);
    const emptyLuminance = luminanceAt(png, empty.x, empty.y, PREVIEW_SIZE);
    const unknownLuminance = luminanceAt(png, unknown.x, unknown.y, PREVIEW_SIZE);
    expect(occupiedLuminance).toBeLessThan(80);
    expect(emptyLuminance).toBeGreaterThan(240);
    expect(unknownLuminance).toBeGreaterThan(140);
    expect(unknownLuminance).toBeLessThan(230);
    expect(unknownLuminance - occupiedLuminance).toBeGreaterThan(80);
    expect(emptyLuminance - unknownLuminance).toBeGreaterThan(30);
  });

  it("rejects swapped known halves, hidden axes, unknown option cells, and malformed choices", () => {
    const { scene, choices } = sceneFor(baseSpec);
    const swapped = choices.map((choice, index) => {
      if (index !== 0) {
        return choice;
      }
      const answer = choice.answer.map((row) => [...row]);
      const known = knownOccupiedCells(baseSpec)[0];
      if (known !== undefined) {
        const row = answer[known.row];
        if (row !== undefined) {
          row[known.column] = 0;
        }
      }
      return { ...choice, answer };
    });
    assertRenderError(
      () => buildSymmetryScene(baseSpec, swapped),
      "CHANGED_KNOWN_HALF",
    );
    assertRenderError(
      () => assertSymmetryScene(removeNode(scene, "source-axis"), baseSpec, choices),
      "MISSING_AXIS",
    );
    assertRenderError(
      () => assertSymmetryScene(removeNode(scene, "option-A-axis"), baseSpec, choices),
      "MISSING_AXIS",
    );
    const unknownOption = replaceNode(
      scene,
      "option-A-tile-cell-0-0",
      (node) => (node.kind === "rect" ? { ...node, fill: SYMMETRY_UNKNOWN_FILL } : node),
    );
    assertRenderError(
      () => assertSymmetryScene(unknownOption, baseSpec, choices),
      "UNKNOWN_IN_OPTION",
    );
    const sourceAxis = nodeById(scene, "source-axis");
    if (sourceAxis === undefined) {
      throw new Error("missing source axis");
    }
    const firstDash = collectByRole(sourceAxis, "axis-dash")[0];
    if (firstDash === undefined) {
      throw new Error("missing source axis dash");
    }
    const wrongAxis = replaceNode(
      scene,
      firstDash.id,
      (node) =>
        node.kind === "line" ? { ...node, x1: node.x1 + 10, x2: node.x2 + 10 } : node,
    );
    assertRenderError(
      () => assertSymmetryScene(wrongAxis, baseSpec, choices),
      "WRONG_AXIS",
    );
    assertRenderError(
      () => assertSymmetryScene(removeNode(scene, "state-legend"), baseSpec, choices),
      "MISSING_LEGEND",
    );
    assertRenderError(
      () => assertSymmetryScene(removeNode(scene, "source-axis-label"), baseSpec, choices),
      "MISSING_AXIS_LABEL",
    );
    const first = choices[0];
    if (first === undefined) {
      throw new Error("expected a first choice");
    }
    const duplicate = choices.map((choice, index) =>
      index === 1 ? { ...choice, answer: first.answer } : choice,
    );
    assertRenderError(
      () => buildSymmetryScene(baseSpec, duplicate),
      "OPTION_NOT_DISTINCT",
    );
    const axisCell = replaceNode(scene, "option-A-tile", (node) => {
      if (node.kind !== "group") {
        return node;
      }
      const optionGrid = tileGridOrigin(scene, "option-A-tile");
      return {
        ...node,
        children: [
          ...node.children,
          {
            kind: "rect",
            id: "option-A-tile-axis-cell",
            role: "tile-cell",
            x: optionGrid.x,
            y: optionGrid.y,
            width: 22,
            height: 22,
            fill: SYMMETRY_UNKNOWN_FILL,
            stroke: "#8a8a8a",
            strokeWidth: 4,
          },
        ],
      };
    });
    assertRenderError(
      () => assertSymmetryScene(axisCell, baseSpec, choices),
      "WRONG_GEOMETRY",
    );
  });

  it("rasterizes 100 seeded scenes with bounds and distinct completion tiles", () => {
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
        slotId: `symmetry-render-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructSymmetrySpec(seed, difficulty);
      const scene = symmetryRenderer.buildScene(spec);
      assertScene(scene);
      const png = renderScenePng(scene, PREVIEW_SIZE);
      assertPngDimensions(png, PREVIEW_SIZE, PREVIEW_SIZE);
      assertOptionTilesDistinct(scene, readPng(png), PREVIEW_SIZE);
      hashes.add(hashPng(png));
    }
    expect(hashes.size).toBeGreaterThan(1);
  }, 120000);

  it("detects removed critical groups in fixed and ten seeded cases", () => {
    const fixed = [baseSpec, constructSymmetrySpec(SEED_A, 3).spec];
    for (const spec of fixed) {
      const { scene } = sceneFor(spec);
      const full = renderScenePng(scene, PREVIEW_SIZE);
      for (const group of SYMMETRY_CRITICAL_GROUPS) {
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
        slotId: `symmetry-critical-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructSymmetrySpec(seed, ((index % 3) + 1) as Difficulty);
      const scene = symmetryRenderer.buildScene(spec);
      const group = SYMMETRY_CRITICAL_GROUPS[index % SYMMETRY_CRITICAL_GROUPS.length];
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

  it("runs the symmetry preview CLI and registers the real renderer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p18-symmetry-"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await previewMain([
        "node",
        "preview",
        "--family",
        "symmetry",
        "--seed",
        "preview-v1",
        "--out",
        directory,
      ]);
      expect(exitCode).toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("family: symmetry");
      expect(output).toContain("preview_png:");
      expect(existsSync(join(directory, "symmetry-preview-v1.svg"))).toBe(true);
      expect(existsSync(join(directory, "symmetry-preview-v1-512.png"))).toBe(true);
      expect(productionRegistry.hasRenderer("symmetry")).toBe(true);
      expect(productionRegistry.listRendererFamilies()).toContain("symmetry");
    } finally {
      write.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
