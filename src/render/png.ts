import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { parseHexColor, PREVIEW_SIZE, SCENE_SIZE, type Scene } from "./scene.js";
import { serializeScene } from "./svg.js";

export const FONT_VERSION = "2.37";
export const FONT_SHA256 = "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954";
export const FONT_LICENSE_SHA256 = "7a083b136e64d064794c3419751e5c7dd10d2f64c108fe5ba161eae5e5958a93";
export const FONT_PATH = resolvePinnedFontPath();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_NON_BACKGROUND_PIXELS = 1000;

function resolvePinnedFontPath(): string {
  const candidates = [
    fileURLToPath(new URL("../../assets/fonts/DejaVuSans.ttf", import.meta.url)),
    fileURLToPath(new URL("../assets/fonts/DejaVuSans.ttf", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `pinned DejaVuSans.ttf ${FONT_VERSION} is missing from assets/fonts`,
  );
}

export function hashPng(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function assertPinnedFont(): void {
  const bytes = readFileSync(FONT_PATH);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== FONT_SHA256) {
    throw new Error(
      `pinned font SHA-256 mismatch: expected ${FONT_SHA256}, received ${hash}`,
    );
  }
}

export function getResvgOptions(width: number): ResvgRenderOptions {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`render width must be a positive integer, received ${width}`);
  }
  assertPinnedFont();
  return {
    fitTo: { mode: "width", value: width },
    font: {
      loadSystemFonts: false,
      fontFiles: [FONT_PATH],
      defaultFontFamily: "DejaVu Sans",
      sansSerifFamily: "DejaVu Sans",
    },
    shapeRendering: 1,
    textRendering: 2,
    logLevel: "error",
  };
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly nonBackgroundPixels: number;
}

export function readPng(buffer: Buffer): PNG {
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("buffer is not a PNG");
  }
  return PNG.sync.read(buffer);
}

export function assertPngDimensions(
  buffer: Buffer,
  expectedWidth: number,
  expectedHeight: number,
): PngInfo {
  const png = readPng(buffer);
  if (png.width !== expectedWidth || png.height !== expectedHeight) {
    throw new Error(
      `PNG dimensions ${png.width}x${png.height} do not match ${expectedWidth}x${expectedHeight}`,
    );
  }
  return { width: png.width, height: png.height, nonBackgroundPixels: 0 };
}

export function countNonBackgroundPixels(buffer: Buffer, background: string): number {
  const png = readPng(buffer);
  const backgroundColor = parseHexColor(background);
  if (backgroundColor === undefined) {
    throw new Error(`background ${background} is not a hex color`);
  }
  let count = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index] ?? 0;
    const green = png.data[index + 1] ?? 0;
    const blue = png.data[index + 2] ?? 0;
    const alpha = png.data[index + 3] ?? 0;
    if (alpha === 0) {
      continue;
    }
    if (
      Math.max(
        Math.abs(red - backgroundColor.r),
        Math.abs(green - backgroundColor.g),
        Math.abs(blue - backgroundColor.b),
      ) >= 8
    ) {
      count += 1;
    }
  }
  return count;
}

export function assertRasterNonBlank(buffer: Buffer, background: string): PngInfo {
  const png = readPng(buffer);
  const nonBackgroundPixels = countNonBackgroundPixels(buffer, background);
  if (nonBackgroundPixels < MIN_NON_BACKGROUND_PIXELS) {
    throw new Error(
      `PNG is blank or nearly blank: ${nonBackgroundPixels} non-background pixels`,
    );
  }
  return { width: png.width, height: png.height, nonBackgroundPixels };
}


export interface RasterComparison {
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly changedNonBackgroundPixels: number;
}

export function compareRasterPng(
  left: Buffer,
  right: Buffer,
  background: string,
): RasterComparison {
  const leftPng = readPng(left);
  const rightPng = readPng(right);
  if (leftPng.width !== rightPng.width || leftPng.height !== rightPng.height) {
    throw new Error("raster dimensions differ");
  }
  const backgroundColor = parseHexColor(background);
  if (backgroundColor === undefined) {
    throw new Error(`background ${background} is not a hex color`);
  }
  let changedPixels = 0;
  let changedNonBackgroundPixels = 0;
  for (let index = 0; index < leftPng.data.length; index += 4) {
    const leftRgba = [
      leftPng.data[index] ?? 0,
      leftPng.data[index + 1] ?? 0,
      leftPng.data[index + 2] ?? 0,
      leftPng.data[index + 3] ?? 0,
    ];
    const rightRgba = [
      rightPng.data[index] ?? 0,
      rightPng.data[index + 1] ?? 0,
      rightPng.data[index + 2] ?? 0,
      rightPng.data[index + 3] ?? 0,
    ];
    const changed = leftRgba.some((value, channel) => value !== rightRgba[channel]);
    if (!changed) {
      continue;
    }
    changedPixels += 1;
    const leftIsBackground =
      Math.max(
        Math.abs((leftRgba[0] ?? 0) - backgroundColor.r),
        Math.abs((leftRgba[1] ?? 0) - backgroundColor.g),
        Math.abs((leftRgba[2] ?? 0) - backgroundColor.b),
      ) < 8 || (leftRgba[3] ?? 0) === 0;
    const rightIsBackground =
      Math.max(
        Math.abs((rightRgba[0] ?? 0) - backgroundColor.r),
        Math.abs((rightRgba[1] ?? 0) - backgroundColor.g),
        Math.abs((rightRgba[2] ?? 0) - backgroundColor.b),
      ) < 8 || (rightRgba[3] ?? 0) === 0;
    if (!leftIsBackground || !rightIsBackground) {
      changedNonBackgroundPixels += 1;
    }
  }
  return {
    width: leftPng.width,
    height: leftPng.height,
    changedPixels,
    changedNonBackgroundPixels,
  };
}

export function assertRasterEquivalent(left: Buffer, right: Buffer): void {
  const comparison = compareRasterPng(left, right, "#ffffff");
  if (comparison.changedPixels !== 0) {
    throw new Error(`rasters differ in ${comparison.changedPixels} pixels`);
  }
}

export function assertCriticalGroupChanged(
  full: Buffer,
  removed: Buffer,
  background: string,
  minimum = 8,
): RasterComparison {
  const comparison = compareRasterPng(full, removed, background);
  if (comparison.changedNonBackgroundPixels < minimum) {
    throw new Error(
      `critical group changed only ${comparison.changedNonBackgroundPixels} non-background pixels`,
    );
  }
  return comparison;
}

export function renderScenePng(scene: Scene, width: number = SCENE_SIZE): Buffer {
  const svg = serializeScene(scene);
  const resvg = new Resvg(svg, {
    ...getResvgOptions(width),
    background: scene.background,
  });
  const bbox = resvg.getBBox();
  if (
    bbox === undefined ||
    bbox.width <= 0 ||
    bbox.height <= 0 ||
    bbox.x < -1 ||
    bbox.y < -1 ||
    bbox.x + bbox.width > SCENE_SIZE + 1 ||
    bbox.y + bbox.height > SCENE_SIZE + 1
  ) {
    throw new Error("scene content is clipped or has no renderable bounds");
  }
  const png = resvg.render().asPng();
  assertPngDimensions(png, width, width);
  assertRasterNonBlank(png, scene.background);
  return png;
}

export interface ScenePreviewExports {
  readonly svgPath: string;
  readonly fullPngPath: string;
  readonly previewPngPath: string;
  readonly fullHash: string;
  readonly previewHash: string;
}

export function writeScenePreviewExports(
  scene: Scene,
  family: string,
  seed: string,
  outputDir = resolve(process.cwd(), "data", "previews"),
): ScenePreviewExports {
  if (!/^[a-z][a-z0-9-]*$/.test(family)) {
    throw new Error(`invalid preview family ${family}`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(seed)) {
    throw new Error(`invalid preview seed ${seed}`);
  }
  mkdirSync(outputDir, { recursive: true });
  const stem = `${family}-${seed}`;
  const svgPath = join(outputDir, `${stem}.svg`);
  const fullPngPath = join(outputDir, `${stem}-1024.png`);
  const previewPngPath = join(outputDir, `${stem}-512.png`);
  const svg = serializeScene(scene);
  const full = renderScenePng(scene, SCENE_SIZE);
  const preview = renderScenePng(scene, PREVIEW_SIZE);
  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, svg, "utf8");
  writeFileSync(fullPngPath, full);
  writeFileSync(previewPngPath, preview);
  return {
    svgPath,
    fullPngPath,
    previewPngPath,
    fullHash: hashPng(full),
    previewHash: hashPng(preview),
  };
}
