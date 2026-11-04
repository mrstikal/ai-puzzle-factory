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
  COUNTING_CELL_SIZE,
  COUNTING_CELL_STROKE,
  COUNTING_CELL_STROKE_WIDTH,
  COUNTING_CRITICAL_GROUPS,
  COUNTING_MEMBER_FILL,
  COUNTING_SOURCE_MARKER_SIZE,
  CountingRenderError,
  assertCountingScene,
  buildCountingScene,
  countingRenderer,
  type CountingChoiceInput,
  type CountingRenderErrorCode,
} from "../../src/families/counting/render.js";
import {
  constructCountingSpec,
  countingEngine,
} from "../../src/families/counting/engine.js";
import {
  CountingSpecSchema,
  membershipMaskGrid,
  sortCountingCells,
  type CountingCell,
  type CountingShape,
  type CountingSpec,
} from "../../src/families/counting/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { main as previewMain } from "../../src/cli/preview.js";

function cells(...values: readonly [number, number][]): CountingCell[] {
  return sortCountingCells(values.map(([row, column]) => ({ row, column })));
}

const TWO_SHAPES: readonly CountingShape[] = [
  { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
  { cells: cells([1, 1], [1, 2], [2, 1], [2, 2]) },
];

const THREE_SHAPES: readonly CountingShape[] = [
  { cells: cells([0, 0], [0, 1], [1, 0], [1, 1]) },
  { cells: cells([1, 1], [1, 2], [2, 1], [2, 2]) },
  { cells: cells([1, 1], [2, 1], [2, 2], [3, 2]) },
];

const twoShapeSpec: CountingSpec = CountingSpecSchema.parse({
  shapes: TWO_SHAPES,
  query: { operation: "unionCount" },
});

const threeShapeSpec: CountingSpec = CountingSpecSchema.parse({
  shapes: THREE_SHAPES,
  query: { operation: "exactlyKShapes", k: 2 },
});

function choicesFor(spec: CountingSpec): readonly CountingChoiceInput[] {
  const result = countingEngine.enumerateSolutions(spec);
  const correct = result.correctAnswer;
  if (correct === null) {
    throw new Error("expected a counting answer");
  }
  const set = countingEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
  return set.choices.map((choice) => ({ label: choice.label, answer: choice.value }));
}

function sceneFor(spec: CountingSpec): {
  readonly scene: Scene;
  readonly choices: readonly CountingChoiceInput[];
} {
  const choices = choicesFor(spec);
  return { scene: buildCountingScene(spec, choices), choices };
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

function markerFill(scene: Scene, prefix: string, shapeIndex: number): string {
  const marker = nodeById(scene, `${prefix}-marker-${shapeIndex}`);
  if (marker === undefined || !("fill" in marker)) {
    throw new Error(`missing marker ${prefix}-marker-${shapeIndex}`);
  }
  return marker.fill ?? "missing";
}

function markerSignature(scene: Scene, prefix: string, shapeCount: number): string {
  const parts: string[] = [];
  for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex += 1) {
    const marker = nodeById(scene, `${prefix}-marker-${shapeIndex}`);
    if (marker === undefined) {
      throw new Error(`missing marker ${prefix}-marker-${shapeIndex}`);
    }
    const fill = "fill" in marker ? marker.fill ?? "missing" : "missing";
    parts.push(`${marker.kind}:${fill}`);
  }
  return parts.join("|");
}

function markerCenters(
  cellX: number,
  cellY: number,
  cellSize: number,
  markerSize: number,
  shapeCount: number,
): readonly ScenePoint[] {
  const gap = 2;
  const total = shapeCount * markerSize + (shapeCount - 1) * gap;
  const start = (cellSize - total) / 2;
  const centers: ScenePoint[] = [];
  for (let index = 0; index < shapeCount; index += 1) {
    centers.push({
      x: cellX + start + markerSize / 2 + index * (markerSize + gap),
      y: cellY + cellSize / 2,
    });
  }
  return centers;
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
  code: CountingRenderErrorCode,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CountingRenderError);
  expect((caught as CountingRenderError).code).toBe(code);
}

describe("counting renderer", () => {
  it("builds a validated 5x5 marker grid, exact query, overlap legend, and four numeric choices", () => {
    const { scene, choices } = sceneFor(twoShapeSpec);
    expect(() => assertScene(scene)).not.toThrow();
    expect(() => assertCountingScene(scene, twoShapeSpec, choices)).not.toThrow();
    expect(scene.width).toBe(SCENE_SIZE);
    expect(scene.height).toBe(SCENE_SIZE);
    for (const id of COUNTING_CRITICAL_GROUPS) {
      expect(nodeById(scene, id)).toBeDefined();
    }
    const grid = nodeById(scene, "source-grid");
    if (grid === undefined) {
      throw new Error("missing source grid");
    }
    expect(collectByRole(grid, "tile-cell")).toHaveLength(25);
    const masks = membershipMaskGrid(twoShapeSpec);
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        const prefix = `source-cell-${row}-${column}`;
        const panel = nodeById(scene, `${prefix}-panel`);
        if (panel === undefined || panel.kind !== "rect") {
          throw new Error(`missing ${prefix} panel`);
        }
        expect(panel.fill).toBe("#ffffff");
        expect(panel.stroke).toBe(COUNTING_CELL_STROKE);
        expect(panel.strokeWidth).toBe(COUNTING_CELL_STROKE_WIDTH);
        const mask = masks[row]?.[column] ?? 0;
        expect(markerFill(scene, prefix, 0)).toBe(
          (mask & 1) !== 0 ? COUNTING_MEMBER_FILL : "none",
        );
        expect(markerFill(scene, prefix, 1)).toBe(
          (mask & 2) !== 0 ? COUNTING_MEMBER_FILL : "none",
        );
      }
    }
    expect(markerFill(scene, "source-cell-0-0", 0)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-0-0", 1)).toBe("none");
    expect(markerFill(scene, "source-cell-1-1", 0)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-1-1", 1)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-2-2", 0)).toBe("none");
    expect(markerFill(scene, "source-cell-2-2", 1)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-0-4", 0)).toBe("none");
    expect(markerFill(scene, "source-cell-0-4", 1)).toBe("none");

    const query = nodeById(scene, "stem-query");
    expect(query?.kind === "text" ? query.text : "").toBe(
      "Query: cells in at least one shape.",
    );
    const samples = collectByRole(
      nodeById(scene, "membership-legend") ?? { kind: "group", id: "missing", children: [] },
      "legend-sample",
    );
    expect(samples).toHaveLength(3);
    expect(new Set(choices.map((choice) => choice.answer)).size).toBe(4);
    expect(
      choices.filter((choice) => countingEngine.verifyAnswer(twoShapeSpec, choice.answer)),
    ).toHaveLength(1);
    expect(countingRenderer.buildScene(twoShapeSpec)).toEqual(
      buildCountingScene(twoShapeSpec),
    );
  });

  it("renders all seven nonempty three-shape memberships as distinct fixed glyph combinations", () => {
    const { scene, choices } = sceneFor(threeShapeSpec);
    expect(() => assertCountingScene(scene, threeShapeSpec, choices)).not.toThrow();
    const signatures = new Set<string>();
    const expectedLabels = ["A", "B", "AB", "C", "AC", "BC", "ABC"];
    for (let mask = 1; mask <= 7; mask += 1) {
      const prefix = `legend-sample-${mask}`;
      const label = nodeById(scene, `${prefix}-label`);
      expect(label?.kind === "text" ? label.text : "").toBe(
        expectedLabels[mask - 1],
      );
      expect(markerFill(scene, prefix, 0)).toBe(
        (mask & 1) !== 0 ? COUNTING_MEMBER_FILL : "none",
      );
      expect(markerFill(scene, prefix, 1)).toBe(
        (mask & 2) !== 0 ? COUNTING_MEMBER_FILL : "none",
      );
      expect(markerFill(scene, prefix, 2)).toBe(
        (mask & 4) !== 0 ? COUNTING_MEMBER_FILL : "none",
      );
      signatures.add(markerSignature(scene, prefix, 3));
    }
    expect(signatures.size).toBe(7);
    expect(markerFill(scene, "source-cell-1-1", 0)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-1-1", 1)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-1-1", 2)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-2-1", 0)).toBe("none");
    expect(markerFill(scene, "source-cell-2-1", 1)).toBe(COUNTING_MEMBER_FILL);
    expect(markerFill(scene, "source-cell-2-1", 2)).toBe(COUNTING_MEMBER_FILL);
  });

  it("rejects hidden overlaps, missing markers, missing legend, color-only cells, wrong queries, and duplicate choices", () => {
    const { scene, choices } = sceneFor(threeShapeSpec);
    const hiddenSourceOverlap = replaceNode(
      scene,
      "source-cell-1-1-marker-1",
      (node) => ("fill" in node ? { ...node, fill: "none" } : node),
    );
    assertRenderError(
      () => assertCountingScene(hiddenSourceOverlap, threeShapeSpec, choices),
      "WRONG_MARKER",
    );
    const hiddenLegendOverlap = replaceNode(
      scene,
      "legend-sample-3-marker-1",
      (node) => ("fill" in node ? { ...node, fill: "none" } : node),
    );
    assertRenderError(
      () => assertCountingScene(hiddenLegendOverlap, threeShapeSpec, choices),
      "WRONG_MARKER",
    );
    assertRenderError(
      () => assertCountingScene(removeNode(scene, "source-cell-0-0-marker-0"), threeShapeSpec, choices),
      "MISSING_MARKER",
    );
    assertRenderError(
      () => assertCountingScene(removeNode(scene, "legend-sample-3-marker-1"), threeShapeSpec, choices),
      "MISSING_MARKER",
    );
    assertRenderError(
      () => assertCountingScene(removeNode(scene, "membership-legend"), threeShapeSpec, choices),
      "MISSING_LEGEND",
    );
    const colorOnly = replaceNode(
      scene,
      "source-cell-0-0-panel",
      (node) => (node.kind === "rect" ? { ...node, fill: "#c0c0c0" } : node),
    );
    assertRenderError(
      () => assertCountingScene(colorOnly, threeShapeSpec, choices),
      "COLOR_ONLY_ENCODING",
    );
    const wrongQuery = replaceNode(scene, "stem-query", (node) =>
      node.kind === "text" ? { ...node, text: "Query: cells in all shapes." } : node,
    );
    assertRenderError(
      () => assertCountingScene(wrongQuery, threeShapeSpec, choices),
      "WRONG_QUERY",
    );
    const first = choices[0];
    if (first === undefined) {
      throw new Error("expected a first choice");
    }
    const duplicate = choices.map((choice, index) =>
      index === 1 ? { ...choice, answer: first.answer } : choice,
    );
    assertRenderError(
      () => buildCountingScene(threeShapeSpec, duplicate),
      "OPTION_NOT_DISTINCT",
    );
  });

  it("renders deterministic 1024/512 PNGs with grayscale-visible member and non-member markers", () => {
    const { scene } = sceneFor(threeShapeSpec);
    const full = renderScenePng(scene, SCENE_SIZE);
    const preview = renderScenePng(scene, PREVIEW_SIZE);
    expect(assertPngDimensions(full, SCENE_SIZE, SCENE_SIZE).width).toBe(SCENE_SIZE);
    expect(assertPngDimensions(preview, PREVIEW_SIZE, PREVIEW_SIZE).height).toBe(
      PREVIEW_SIZE,
    );
    expect(hashPng(renderScenePng(scene, SCENE_SIZE))).toBe(hashPng(full));
    expect(hashPng(renderScenePng(scene, PREVIEW_SIZE))).toBe(hashPng(preview));
    const png = readPng(preview);
    const memberPanel = nodeById(scene, "source-cell-1-1-panel");
    const emptyPanel = nodeById(scene, "source-cell-0-4-panel");
    if (memberPanel === undefined || emptyPanel === undefined) {
      throw new Error("missing source cell panels");
    }
    const memberBounds = nodeBounds(memberPanel);
    const emptyBounds = nodeBounds(emptyPanel);
    if (memberBounds === undefined || emptyBounds === undefined) {
      throw new Error("missing source cell bounds");
    }
    const memberCenters = markerCenters(
      memberBounds.x,
      memberBounds.y,
      COUNTING_CELL_SIZE,
      COUNTING_SOURCE_MARKER_SIZE,
      3,
    );
    const emptyCenters = markerCenters(
      emptyBounds.x,
      emptyBounds.y,
      COUNTING_CELL_SIZE,
      COUNTING_SOURCE_MARKER_SIZE,
      3,
    );
    const memberCenter = memberCenters[0];
    const emptyCenter = emptyCenters[0];
    if (memberCenter === undefined || emptyCenter === undefined) {
      throw new Error("missing marker centers");
    }
    expect(luminanceAt(png, memberCenter.x, memberCenter.y, PREVIEW_SIZE)).toBeLessThan(80);
    expect(luminanceAt(png, emptyCenter.x, emptyCenter.y, PREVIEW_SIZE)).toBeGreaterThan(240);
  });

  it("rasterizes 100 seeded scenes with bounds and four distinct numeric choices", () => {
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
        slotId: `counting-render-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructCountingSpec(seed, difficulty);
      const scene = countingRenderer.buildScene(spec);
      assertScene(scene);
      const result = countingEngine.enumerateSolutions(spec);
      const correct = result.correctAnswer;
      if (correct === null) {
        throw new Error("expected a unique counting answer");
      }
      const set = countingEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
      expect(new Set(set.choices.map((choice) => choice.value)).size).toBe(4);
      const png = renderScenePng(scene, PREVIEW_SIZE);
      assertPngDimensions(png, PREVIEW_SIZE, PREVIEW_SIZE);
      hashes.add(hashPng(png));
    }
    expect(hashes.size).toBeGreaterThan(1);
  }, 120000);

  it("detects removed critical groups in fixed and ten seeded cases", () => {
    const fixed = [twoShapeSpec, threeShapeSpec];
    for (const spec of fixed) {
      const { scene } = sceneFor(spec);
      const full = renderScenePng(scene, PREVIEW_SIZE);
      for (const group of COUNTING_CRITICAL_GROUPS) {
        const removed = removeNode(scene, group);
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
        slotId: `counting-critical-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructCountingSpec(seed, ((index % 3) + 1) as Difficulty);
      const scene = countingRenderer.buildScene(spec);
      const group = COUNTING_CRITICAL_GROUPS[index % COUNTING_CRITICAL_GROUPS.length];
      if (group === undefined) {
        throw new Error("expected a critical group");
      }
      const full = renderScenePng(scene, PREVIEW_SIZE);
      const removed = removeNode(scene, group);
      assertScene(removed);
      const removedPng = renderScenePng(removed, PREVIEW_SIZE);
      expect(
        assertCriticalGroupChanged(full, removedPng, scene.background, 8)
          .changedNonBackgroundPixels,
      ).toBeGreaterThanOrEqual(8);
    }
  }, 120000);

  it("runs the counting preview CLI and registers the final real renderer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p20-counting-"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await previewMain([
        "node",
        "preview",
        "--family",
        "counting",
        "--seed",
        "preview-v1",
        "--out",
        directory,
      ]);
      expect(exitCode).toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("family: counting");
      expect(output).toContain("preview_png:");
      expect(existsSync(join(directory, "counting-preview-v1.svg"))).toBe(true);
      expect(existsSync(join(directory, "counting-preview-v1-512.png"))).toBe(true);
      expect(productionRegistry.hasRenderer("counting")).toBe(true);
      expect(productionRegistry.listRendererFamilies()).toContain("counting");
      expect(() =>
        productionRegistry.assertComplete({ requireRenderers: true }),
      ).not.toThrow();
    } finally {
      write.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
