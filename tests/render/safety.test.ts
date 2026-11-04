import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import {
  FONT_PATH,
  FONT_SHA256,
  assertPinnedFont,
  assertCriticalGroupChanged,
  assertPngDimensions,
  assertRasterEquivalent,
  assertRasterNonBlank,
  countNonBackgroundPixels,
  getResvgOptions,
  hashPng,
  readPng,
  renderScenePng,
  writeScenePreviewExports,
} from "../../src/render/png.js";
import {
  PREVIEW_SIZE,
  SCENE_SIZE,
  SceneValidationError,
  assertScene,
  contrastRatio,
  createSceneDemo,
  previewRegistry,
  type Scene,
  type SceneNode,
} from "../../src/render/scene.js";
import { SvgSafetyError, parseScene, serializeScene } from "../../src/render/svg.js";
import { main as previewMain } from "../../src/cli/preview.js";

function mapNode(node: SceneNode, id: string, replace: (node: SceneNode) => SceneNode): SceneNode {
  if (node.id === id) {
    return replace(node);
  }
  if (node.kind === "group") {
    return { ...node, children: node.children.map((child) => mapNode(child, id, replace)) };
  }
  return node;
}

function replaceNode(scene: Scene, id: string, replace: (node: SceneNode) => SceneNode): Scene {
  return { ...scene, nodes: scene.nodes.map((node) => mapNode(node, id, replace)) };
}

function replaceText(scene: Scene, id: string, text: string): Scene {
  return replaceNode(scene, id, (node) =>
    node.kind === "text" ? { ...node, text } : node,
  );
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

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("safe scene", () => {
  it("builds a bounded scene-demo with a stem, legend, and four labeled options", () => {
    const scene = createSceneDemo("preview-v1");
    expect(() => assertScene(scene)).not.toThrow();
    expect(scene.width).toBe(SCENE_SIZE);
    expect(scene.height).toBe(SCENE_SIZE);
    expect(scene.nodes).toHaveLength(6);
    expect(previewRegistry.listFamilies()).toEqual(["scene-demo"]);
    const serialized = serializeScene(scene);
    expect(serialized).toContain('viewBox="0 0 1024 1024"');
    expect(serialized).toContain("<title>Scene demo</title>");
    expect(serialized).toContain(">A</text>");
    expect(serialized).toContain(">B</text>");
    expect(serialized).toContain(">C</text>");
    expect(serialized).toContain(">D</text>");
  });

  it("round-trips a scene and escapes text", () => {
    const scene = replaceText(createSceneDemo("preview-v1"), "stem-text", "A < B & C > D");
    const serialized = serializeScene(scene);
    expect(serialized).toContain("&lt;");
    expect(serialized).toContain("&amp;");
    expect(serialized).not.toContain("<script>");
    const parsed = parseScene(serialized);
    expect(parsed).toEqual(scene);
  });

  it("rejects blank, clipped, oversized, low-contrast, overlapping, and undersized scenes", () => {
    const scene = createSceneDemo("preview-v1");
    expect(() => assertScene({ ...scene, nodes: [] })).toThrow(SceneValidationError);
    expect(() => assertScene({ ...scene, width: 2048 })).toThrow(SceneValidationError);
    expect(() =>
      assertScene(
        replaceNode(scene, "stem-panel", (node) =>
          node.kind === "rect" ? { ...node, x: -10 } : node,
        ),
      ),
    ).toThrow(SceneValidationError);
    expect(() =>
      assertScene(
        replaceNode(scene, "stem-text", (node) =>
          node.kind === "text" ? { ...node, fill: "#fefefe" } : node,
        ),
      ),
    ).toThrow(SceneValidationError);
    const darkPanel = replaceNode(scene, "stem-panel", (node) =>
      node.kind === "rect" ? { ...node, fill: "#595959" } : node,
    );
    expect(() =>
      assertScene(
        replaceNode(darkPanel, "stem-text", (node) =>
          node.kind === "text" ? { ...node, fill: "#767676" } : node,
        ),
      ),
    ).toThrow(SceneValidationError);
    expect(() =>
      assertScene(
        replaceNode(scene, "option-A-mark", (node) =>
          node.kind === "circle" ? { ...node, r: 2 } : node,
        ),
      ),
    ).toThrow(SceneValidationError);
    expect(() =>
      assertScene(
        replaceNode(scene, "stem-panel", (node) =>
          node.kind === "rect" ? { ...node, strokeWidth: 2 } : node,
        ),
      ),
    ).toThrow(SceneValidationError);
    expect(() =>
      assertScene(
        replaceNode(scene, "stem-text", (node) =>
          node.kind === "text" ? { ...node, fontSize: 16 } : node,
        ),
      ),
    ).toThrow(SceneValidationError);
    expect(() =>
      assertScene({ ...scene, nodes: scene.nodes.filter((node) => node.id !== "option-D") }),
    ).toThrow(SceneValidationError);
    expect(() =>
      assertScene(
        replaceNode(scene, "option-B", (node) => {
          if (node.kind !== "group") {
            return node;
          }
          return {
            ...node,
            children: node.children.map((child) =>
              child.kind === "rect" ? { ...child, x: 64 } : child,
            ),
          };
        }),
      ),
    ).toThrow(SceneValidationError);
  });

  it("accepts an essential filled rect and rejects a low-contrast top-level sibling label", () => {
    const scene = createSceneDemo("preview-v1");
    const essentialRect = {
      ...scene,
      nodes: [
        ...scene.nodes,
        {
          kind: "rect" as const,
          id: "essential-rect",
          role: "essential",
          x: 700,
          y: 430,
          width: 40,
          height: 40,
          fill: "#111111",
        },
      ],
    };
    expect(() => assertScene(essentialRect)).not.toThrow();

    const edgePanel = {
      ...scene,
      nodes: [
        ...scene.nodes,
        {
          kind: "rect" as const,
          id: "edge-panel",
          x: 544,
          y: 464,
          width: 416,
          height: 224,
          fill: "#595959",
        },
        {
          kind: "text" as const,
          id: "edge-label",
          x: 568,
          y: 520,
          text: "Twenty-one chars label",
          fontSize: 32,
          fill: "#767676",
        },
      ],
    };
    expect(() => assertScene(edgePanel)).toThrow(SceneValidationError);

    const siblingPanel = {
      ...scene,
      nodes: [
        ...scene.nodes,
        {
          kind: "rect" as const,
          id: "sibling-panel",
          x: 64,
          y: 430,
          width: 400,
          height: 80,
          fill: "#595959",
        },
        {
          kind: "text" as const,
          id: "sibling-label",
          x: 80,
          y: 480,
          text: "Low contrast sibling",
          fontSize: 32,
          fill: "#767676",
        },
      ],
    };
    expect(() => assertScene(siblingPanel)).toThrow(SceneValidationError);
  });

  it("resolves backdrops geometrically and accepts a group-essential filled rect", () => {
    const scene = createSceneDemo("preview-v1");
    const groupEssential = {
      ...scene,
      nodes: scene.nodes.map((node) =>
        node.id === "option-A" && node.kind === "group"
          ? {
              ...node,
              children: [
                {
                  kind: "rect" as const,
                  id: "option-A-essential",
                  role: "essential",
                  x: 64,
                  y: 464,
                  width: 40,
                  height: 40,
                  fill: "#111111",
                },
                ...node.children,
              ],
            }
          : node,
      ),
    };
    expect(() => assertScene(groupEssential)).not.toThrow();

    const legendSwatch = {
      ...scene,
      nodes: scene.nodes.map((node) => {
        if (node.id !== "legend" || node.kind !== "group") {
          return node;
        }
        return {
          ...node,
          children: [
            node.children[0]!,
            node.children[1]!,
            {
              kind: "rect" as const,
              id: "legend-swatch",
              role: "essential",
              x: 850,
              y: 256,
              width: 20,
              height: 20,
              fill: "#111111",
            },
            ...node.children.slice(2),
          ],
        };
      }),
    };
    expect(() => assertScene(legendSwatch)).not.toThrow();
  });

  it("serializes tiny coordinates without exponent notation", () => {
    const scene = createSceneDemo("preview-v1");
    const tiny = {
      ...scene,
      nodes: [
        ...scene.nodes,
        {
          kind: "line" as const,
          id: "tiny-line",
          x1: 6.123233995736766e-17,
          y1: 430,
          x2: 100,
          y2: 430,
          stroke: "#111111",
          strokeWidth: 4,
        },
      ],
    };
    expect(() => assertScene(tiny)).not.toThrow();
    const serialized = serializeScene(tiny);
    expect(serialized).not.toMatch(/[0-9][eE][+-]?[0-9]/);
    expect(() => parseScene(serialized)).not.toThrow();
  });

  it("computes contrast ratios and rejects low-contrast pairs", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#111111", "#ffffff")).toBeGreaterThan(4.5);
  });
});

describe("strict SVG parser", () => {
  const scene = createSceneDemo("preview-v1");
  const valid = serializeScene(scene);

  it("rejects scripts, foreign objects, unsafe attributes, DOCTYPE, PIs, and URLs", () => {
    const unsafe = [
      valid.replace("</desc>", "</desc><script>alert(1)</script>"),
      valid.replace("</desc>", "</desc><foreignObject></foreignObject>"),
      valid.replace("</desc>", '</desc><image href="https://example.com/x.png"/>'),
      valid.replace("<rect ", '<rect onclick="alert(1)" '),
      valid.replace("<rect ", '<rect href="https://example.com/x.png" '),
      valid.replace("<rect ", '<rect style="fill:red" '),
      valid.replace("<rect ", '<rect xlink:href="https://example.com/x.png" '),
      valid.replace('fill="#f2f2f2"', 'fill="url(https://example.com/x)"'),
      valid.replace(
        "</desc>",
        '</desc><path id="bad" d="M0 0 A 1 1 0 0 0 1 1" stroke="#111111" stroke-width="4"/>',
      ),
      `<!DOCTYPE svg [<!ENTITY x "y">]>${valid}`,
      `<?xml-stylesheet href="https://example.com/x.css"?>${valid}`,
      valid.replace("</desc>", "</desc><!-- comment -->"),
      valid.replace('viewBox="0 0 1024 1024"', 'viewBox="0 0 1 1"'),
    ];
    for (const unsafeSvg of unsafe) {
      expect(() => parseScene(unsafeSvg)).toThrow(SvgSafetyError);
    }
  });

  it("rejects duplicate ids after parsing", () => {
    const duplicate = valid.replace('id="stem-panel"', 'id="stem"');
    expect(() => parseScene(duplicate)).toThrow(SvgSafetyError);
  });
});

describe("pinned PNG renderer", () => {
  const scene = createSceneDemo("preview-v1");

  it("uses only the pinned DejaVu font and renders real deterministic PNGs", () => {
    expect(FONT_PATH).toContain("assets/fonts/DejaVuSans.ttf");
    expect(FONT_SHA256).toHaveLength(64);
    expect(() => assertPinnedFont()).not.toThrow();
    const options = getResvgOptions(SCENE_SIZE);
    expect(options.font?.loadSystemFonts).toBe(false);
    expect(options.font?.fontFiles).toEqual([FONT_PATH]);
    expect(options.font?.defaultFontFamily).toBe("DejaVu Sans");

    const full = renderScenePng(scene, SCENE_SIZE);
    const preview = renderScenePng(scene, PREVIEW_SIZE);
    expect(full.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(assertPngDimensions(full, SCENE_SIZE, SCENE_SIZE).width).toBe(SCENE_SIZE);
    expect(assertPngDimensions(preview, PREVIEW_SIZE, PREVIEW_SIZE).height).toBe(PREVIEW_SIZE);
    expect(countNonBackgroundPixels(preview, scene.background)).toBeGreaterThan(1000);
    expect(hashPng(renderScenePng(scene, SCENE_SIZE))).toBe(hashPng(full));
    expect(hashPng(renderScenePng(scene, PREVIEW_SIZE))).toBe(hashPng(preview));
    expect(readPng(full).width).toBe(SCENE_SIZE);
    expect(() => assertRasterEquivalent(full, full)).not.toThrow();
    const withoutMark = renderScenePng(removeNode(scene, "option-A-mark"), SCENE_SIZE);
    expect(
      assertCriticalGroupChanged(full, withoutMark, scene.background, 8)
        .changedNonBackgroundPixels,
    ).toBeGreaterThanOrEqual(8);
  });

  it("rejects blank PNGs and writes ignored-style preview exports", () => {
    const blank = new PNG({ width: 512, height: 512 });
    for (let index = 0; index < blank.data.length; index += 4) {
      blank.data[index] = 255;
      blank.data[index + 1] = 255;
      blank.data[index + 2] = 255;
      blank.data[index + 3] = 255;
    }
    expect(() => assertRasterNonBlank(PNG.sync.write(blank), "#ffffff")).toThrow();

    const directory = tempDir("p10-preview-");
    try {
      const exported = writeScenePreviewExports(scene, "scene-demo", "preview-v1", directory);
      expect(existsSync(exported.svgPath)).toBe(true);
      expect(existsSync(exported.fullPngPath)).toBe(true);
      expect(existsSync(exported.previewPngPath)).toBe(true);
      expect(readFileSync(exported.svgPath, "utf8")).toContain("<svg");
      expect(readPng(readFileSync(exported.fullPngPath)).width).toBe(SCENE_SIZE);
      expect(readPng(readFileSync(exported.previewPngPath)).width).toBe(PREVIEW_SIZE);
      expect(exported.fullHash).toBe(hashPng(readFileSync(exported.fullPngPath)));
      expect(exported.previewHash).toBe(hashPng(readFileSync(exported.previewPngPath)));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs the preview CLI and prints source and PNG paths", async () => {
    const directory = tempDir("p10-cli-");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await previewMain([
        "node",
        "preview",
        "--family",
        "scene-demo",
        "--seed",
        "preview-v1",
        "--out",
        directory,
      ]);
      expect(exitCode).toBe(0);
      const output = write.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("family: scene-demo");
      expect(output).toContain("preview_png:");
      expect(output).toContain("full_sha256:");
      expect(existsSync(join(directory, "scene-demo-preview-v1.svg"))).toBe(true);
      expect(existsSync(join(directory, "scene-demo-preview-v1-512.png"))).toBe(true);
    } finally {
      write.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
