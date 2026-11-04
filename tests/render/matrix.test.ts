import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashCanonicalJson } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";
import type { Difficulty } from "../../src/domain/experiment.js";
import {
  PREVIEW_SIZE,
  SCENE_SIZE,
  assertScene,
  nodeBounds,
  type Scene,
  type SceneNode,
} from "../../src/render/scene.js";
import {
  assertCriticalGroupChanged,
  assertPngDimensions,
  hashPng,
  readPng,
  renderScenePng,
} from "../../src/render/png.js";
import {
  MATRIX_CRITICAL_GROUPS,
  MatrixRenderError,
  assertMatrixScene,
  buildMatrixScene,
  matrixRenderer,
} from "../../src/families/matrix/render.js";
import {
  constructMatrixSpec,
  matrixEngine,
} from "../../src/families/matrix/engine.js";
import {
  MatrixSpecSchema,
  maskGlyphs,
  solveMatrix,
  type MatrixChoiceInput,
  type MatrixSpec,
} from "../../src/families/matrix/schema.js";
import { productionRegistry } from "../../src/families/registry.js";
import { main as previewMain } from "../../src/cli/preview.js";

const SEED_A = "0".repeat(64);

const baseSpec = MatrixSpecSchema.parse({
  rule: "xor",
  cells: [
    [1, 2, 3],
    [4, 3, 7],
    [5, 1, null],
  ],
});

const emptySpec = MatrixSpecSchema.parse({
  rule: "xor",
  cells: [
    [1, 2, 3],
    [4, 7, 3],
    [5, 5, null],
  ],
});

function choicesFor(spec: MatrixSpec): readonly MatrixChoiceInput[] {
  const solutions = solveMatrix(spec);
  const correct = solutions[0];
  if (correct === undefined) {
    throw new Error("expected a unique matrix completion");
  }
  const set = matrixEngine.makeOptions(spec, correct, SEED_A);
  return set.choices.map((choice) => ({ label: choice.label, mask: choice.value }));
}

function sceneFor(spec: MatrixSpec): { readonly scene: Scene; readonly choices: readonly MatrixChoiceInput[] } {
  const choices = choicesFor(spec);
  return { scene: buildMatrixScene(spec, choices), choices };
}

function replaceNode(scene: Scene, id: string, replace: (node: SceneNode) => SceneNode): Scene {
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

function removeGlyphs(scene: Scene, groupId: string): Scene {
  const strip = (node: SceneNode): SceneNode | null => {
    if (node.role === "glyph") {
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
    if (node.id === groupId && node.kind === "group") {
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

function removeNode(scene: Scene, id: string): Scene {
  const remove = (nodes: readonly SceneNode[]): SceneNode[] =>
    nodes
      .filter((node) => node.id !== id)
      .map((node) =>
        node.kind === "group" ? { ...node, children: remove(node.children) } : node,
      );
  return { ...scene, nodes: remove(scene.nodes) };
}

function nodeById(scene: Scene, id: string): SceneNode | undefined {
  const visit = (node: SceneNode): SceneNode | undefined => {
    if (node.id === id) {
      return node;
    }
    if (node.kind !== "group") {
      return undefined;
    }
    for (const child of node.children) {
      const found = visit(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  for (const node of scene.nodes) {
    const found = visit(node);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function glyphNodes(scene: Scene, gridId: string): readonly SceneNode[] {
  const grid = nodeById(scene, gridId);
  if (grid === undefined) {
    return [];
  }
  const collect = (node: SceneNode): SceneNode[] => {
    if (node.role === "glyph") {
      return [node];
    }
    if (node.kind !== "group") {
      return [];
    }
    return node.children.flatMap(collect);
  };
  return collect(grid);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("matrix renderer", () => {
  it("builds a validated scene with a 3x3 stem, missing cell, legend, and four tiles", () => {
    const { scene, choices } = sceneFor(baseSpec);
    expect(() => assertScene(scene)).not.toThrow();
    expect(() => assertMatrixScene(scene, baseSpec, choices)).not.toThrow();
    expect(scene.width).toBe(SCENE_SIZE);
    expect(scene.height).toBe(SCENE_SIZE);
    for (const id of MATRIX_CRITICAL_GROUPS) {
      expect(nodeById(scene, id)).toBeDefined();
    }
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (row === 2 && column === 2) {
          expect(nodeById(scene, "missing-cell")).toBeDefined();
        } else {
          const rowCells = baseSpec.cells[row];
          if (rowCells === undefined) {
            throw new Error("expected a matrix row");
          }
          const mask = rowCells[column];
          if (mask !== null && mask !== undefined) {
            expect(glyphNodes(scene, `cell-${row}-${column}`)).toHaveLength(maskGlyphs(mask).length);
          }
        }
      }
    }
    for (const choice of choices) {
      expect(glyphNodes(scene, `option-${choice.label}-grid`)).toHaveLength(
        maskGlyphs(choice.mask).length,
      );
    }
    expect(matrixRenderer.buildScene(baseSpec)).toEqual(buildMatrixScene(baseSpec));
  });

  it("handles the empty mask convention and rejects an injected empty-mask glyph", () => {
    const { scene, choices } = sceneFor(emptySpec);
    expect(() => assertMatrixScene(scene, emptySpec, choices)).not.toThrow();
    const emptyChoice = choices.find((choice) => choice.mask === 0);
    expect(emptyChoice).toBeDefined();
    if (emptyChoice === undefined) {
      throw new Error("expected an empty mask choice");
    }
    expect(glyphNodes(scene, `option-${emptyChoice.label}-grid`)).toHaveLength(0);
    const injected = replaceNode(scene, `option-${emptyChoice.label}-grid`, (node) => {
      if (node.kind !== "group") {
        return node;
      }
      const bounds = nodeBounds(node);
      if (bounds === undefined) {
        throw new Error("expected option grid bounds");
      }
      return {
        ...node,
        children: [
          ...node.children,
          {
            kind: "circle",
            id: `option-${emptyChoice.label}-grid-glyph-0`,
            role: "glyph",
            cx: bounds.x + 60,
            cy: bounds.y + 60,
            r: 8,
            fill: "#111111",
          },
        ],
      };
    });
    expect(() => assertMatrixScene(injected, emptySpec, choices)).toThrow(MatrixRenderError);
  });

  it("rejects swapped glyph positions and clipped glyphs", () => {
    const { scene, choices } = sceneFor(baseSpec);
    const swapped = replaceNode(scene, "cell-0-2-glyph-0", (node) =>
      node.kind === "circle" ? { ...node, cx: 910, cy: 74 } : node,
    );
    let swappedError: unknown;
    try {
      assertMatrixScene(swapped, baseSpec, choices);
    } catch (error) {
      swappedError = error;
    }
    expect(swappedError).toBeInstanceOf(MatrixRenderError);
    expect((swappedError as MatrixRenderError).code).toBe("SWAPPED_GLYPH");

    const clipped = replaceNode(scene, "cell-0-0-glyph-0", (node) =>
      node.kind === "circle" ? { ...node, cx: 580, cy: 74 } : node,
    );
    expect(() => assertMatrixScene(clipped, baseSpec, choices)).toThrow(MatrixRenderError);
  });
});

describe("matrix visual evidence", () => {
  it("renders a deterministic 1024/512 preview with real PNG dimensions", () => {
    const { scene } = sceneFor(baseSpec);
    const full = renderScenePng(scene, SCENE_SIZE);
    const preview = renderScenePng(scene, PREVIEW_SIZE);
    expect(assertPngDimensions(full, SCENE_SIZE, SCENE_SIZE).width).toBe(SCENE_SIZE);
    expect(assertPngDimensions(preview, PREVIEW_SIZE, PREVIEW_SIZE).height).toBe(PREVIEW_SIZE);
    expect(hashPng(renderScenePng(scene, SCENE_SIZE))).toBe(hashPng(full));
    expect(hashPng(renderScenePng(scene, PREVIEW_SIZE))).toBe(hashPng(preview));
    expect(readPng(full).width).toBe(SCENE_SIZE);
  });

  it("rasterizes 100 seeded scenes with bounds and distinct option masks", () => {
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
        slotId: `matrix-render-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructMatrixSpec(seed, difficulty);
      const scene = matrixRenderer.buildScene(spec);
      assertScene(scene);
      const solutions = solveMatrix(spec);
      const correct = solutions[0];
      if (correct === undefined) {
        throw new Error("expected a unique matrix completion");
      }
      const set = matrixEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
      expect(new Set(set.choices.map((choice) => choice.value)).size).toBe(4);
      const png = renderScenePng(scene, PREVIEW_SIZE);
      assertPngDimensions(png, PREVIEW_SIZE, PREVIEW_SIZE);
      hashes.add(hashPng(png));
    }
    expect(hashes.size).toBeGreaterThan(1);
  }, 120000);

  it("detects removed critical groups in fixed and ten seeded cases", () => {
    const fixed = [baseSpec, emptySpec];
    const fixedGroups = ["stem-grid", "missing-cell", "legend-glyphs", "option-A-grid"] as const;
    for (const spec of fixed) {
      const { scene, choices } = sceneFor(spec);
      const full = renderScenePng(scene, PREVIEW_SIZE);
      for (const group of fixedGroups) {
        const removed = removeNode(scene, group);
        assertScene(removed);
        const removedPng = renderScenePng(removed, PREVIEW_SIZE);
        expect(
          assertCriticalGroupChanged(full, removedPng, scene.background, 8)
            .changedNonBackgroundPixels,
        ).toBeGreaterThanOrEqual(8);

        const optionChoice = choices.find(
          (choice) => `option-${choice.label}-grid` === group,
        );
        if (optionChoice?.mask === 0) {
          continue;
        }
        const marksRemoved =
          group === "missing-cell"
            ? removeNode(scene, "missing-cell-mark")
            : removeGlyphs(scene, group);
        assertScene(marksRemoved);
        const marksPng = renderScenePng(marksRemoved, PREVIEW_SIZE);
        expect(
          assertCriticalGroupChanged(full, marksPng, scene.background, 8)
            .changedNonBackgroundPixels,
        ).toBeGreaterThanOrEqual(8);
      }
    }
    for (let index = 0; index < 10; index += 1) {
      const seed = deriveStreamSeed({
        protocolVersion: "1.0.0",
        rootSeed: "puzzle-poc-v1",
        slotId: `matrix-critical-${String(index + 1).padStart(3, "0")}`,
        purpose: "spec",
      });
      const { spec } = constructMatrixSpec(seed, (index % 3) + 1 as Difficulty);
      const scene = matrixRenderer.buildScene(spec);
      const group = MATRIX_CRITICAL_GROUPS[index % MATRIX_CRITICAL_GROUPS.length];
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

  it("runs the matrix preview CLI and registers the real renderer", async () => {
    const directory = tempDir("p12-matrix-");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await previewMain([
        "node",
        "preview",
        "--family",
        "matrix",
        "--seed",
        "preview-v1",
        "--out",
        directory,
      ]);
      expect(exitCode).toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("family: matrix");
      expect(output).toContain("preview_png:");
      expect(existsSync(join(directory, "matrix-preview-v1.svg"))).toBe(true);
      expect(existsSync(join(directory, "matrix-preview-v1-512.png"))).toBe(true);
      expect(productionRegistry.hasRenderer("matrix")).toBe(true);
      expect(productionRegistry.listRendererFamilies()).toContain("matrix");
    } finally {
      write.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
