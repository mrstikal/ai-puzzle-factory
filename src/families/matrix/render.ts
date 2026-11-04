import type { ChoiceSet } from "../../domain/answers.js";
import { hashCanonicalJson } from "../../util/hash.js";
import {
  SCENE_INK,
  SCENE_PANEL,
  SCENE_SIZE,
  assertScene,
  nodeBounds,
  type Bounds,
  type Scene,
  type SceneCircle,
  type SceneGroup,
  type SceneNode,
  type ScenePoint,
  type ScenePolygon,
  type SceneRect,
  type SceneText,
} from "../../render/scene.js";
import { matrixEngine } from "./engine.js";
import {
  MATRIX_GLYPH_POSITIONS,
  MatrixSpecSchema,
  maskGlyphs,
  matrixCell,
  solveMatrix,
  type MatrixAnswer,
  type MatrixChoiceInput,
  type MatrixSpec,
} from "./schema.js";

export const MATRIX_CRITICAL_GROUPS = [
  "stem-grid",
  "missing-cell",
  "legend-glyphs",
  "option-A-grid",
  "option-B-grid",
  "option-C-grid",
  "option-D-grid",
] as const;
export type MatrixCriticalGroup = (typeof MATRIX_CRITICAL_GROUPS)[number];

export type MatrixRenderErrorCode =
  | "INVALID_SCENE"
  | "MISSING_GLYPH"
  | "EXTRA_GLYPH"
  | "CLIPPED_GLYPH"
  | "SWAPPED_GLYPH"
  | "MISSING_CRITICAL_GROUP"
  | "EMPTY_MASK_VIOLATION"
  | "OVERLAP";

export class MatrixRenderError extends Error {
  readonly code: MatrixRenderErrorCode;

  constructor(code: MatrixRenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatrixRenderError";
    this.code = code;
  }
}

function rectNode(
  id: string,
  role: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill = SCENE_PANEL,
  stroke = SCENE_INK,
): SceneRect {
  return { kind: "rect", id, role, x, y, width, height, fill, stroke, strokeWidth: 4 };
}

function textNode(
  id: string,
  role: string,
  x: number,
  y: number,
  text: string,
  fontSize = 32,
  anchor: SceneText["anchor"] = "start",
  fontWeight: "normal" | "bold" = "normal",
): SceneText {
  return {
    kind: "text",
    id,
    role,
    x,
    y,
    text,
    fontSize,
    fill: SCENE_INK,
    anchor,
    fontWeight,
  };
}

function glyphNode(
  glyph: number,
  x: number,
  y: number,
  id: string,
): SceneNode {
  if (glyph === 0) {
    return { kind: "circle", id, role: "glyph", cx: x, cy: y, r: 8, fill: SCENE_INK };
  }
  if (glyph === 1) {
    return {
      kind: "rect",
      id,
      role: "glyph",
      x: x - 8,
      y: y - 8,
      width: 16,
      height: 16,
      fill: SCENE_INK,
    };
  }
  if (glyph === 2) {
    const points: ScenePoint[] = [
      { x, y: y - 9 },
      { x: x - 9, y: y + 8 },
      { x: x + 9, y: y + 8 },
    ];
    return { kind: "polygon", id, role: "glyph", points, fill: SCENE_INK };
  }
  if (glyph === 3) {
    const points: ScenePoint[] = [
      { x, y: y - 9 },
      { x: x + 9, y },
      { x, y: y + 9 },
      { x: x - 9, y },
    ];
    return { kind: "polygon", id, role: "glyph", points, fill: SCENE_INK };
  }
  throw new MatrixRenderError("INVALID_SCENE", `unknown matrix glyph ${glyph}`);
}

function miniGrid(
  id: string,
  role: string,
  x: number,
  y: number,
  size: number,
  mask: number,
): SceneGroup {
  const children: SceneNode[] = [
    rectNode(`${id}-panel`, "panel", x, y, size, size),
  ];
  for (const glyph of maskGlyphs(mask)) {
    const position = MATRIX_GLYPH_POSITIONS[glyph];
    if (position === undefined) {
      throw new MatrixRenderError("INVALID_SCENE", `unknown glyph position ${glyph}`);
    }
    children.push(
      glyphNode(
        glyph,
        x + position.x * size,
        y + position.y * size,
        `${id}-glyph-${glyph}`,
      ),
    );
  }
  return { kind: "group", id, role, children };
}

function buildStem(spec: MatrixSpec): SceneGroup {
  const gridX = 600;
  const gridY = 48;
  const cellSize = 104;
  const gap = 12;
  const cells: SceneNode[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const x = gridX + column * (cellSize + gap);
      const y = gridY + row * (cellSize + gap);
      if (row === 2 && column === 2) {
        cells.push({
          kind: "group",
          id: "missing-cell",
          role: "missing",
          children: [
            rectNode("missing-cell-panel", "panel", x, y, cellSize, cellSize),
            textNode("missing-cell-mark", "label", x + cellSize / 2, y + cellSize / 2 + 10, "?", 32, "middle", "bold"),
          ],
        });
      } else {
        const mask = matrixCell(spec, row, column);
        if (mask === null) {
          throw new MatrixRenderError("INVALID_SCENE", "matrix has a null outside the missing cell");
        }
        cells.push(
          miniGrid(`cell-${row}-${column}`, "matrix-cell", x, y, cellSize, mask),
        );
      }
    }
  }
  return {
    kind: "group",
    id: "stem",
    role: "stem",
    children: [
      rectNode("stem-panel", "panel", 32, 24, 960, 400),
      textNode("stem-title", "label", 64, 72, "Complete the missing cell.", 32, "start", "bold"),
      textNode("stem-row-rule", "label", 64, 128, "Rows: 1st XOR 2nd = 3rd."),
      textNode("stem-column-rule", "label", 64, 176, "Cols: top XOR mid = bottom."),
      textNode("stem-missing-rule", "label", 64, 224, "Missing: bottom-right."),
      { kind: "group", id: "stem-grid", role: "matrix-grid", children: cells },
    ],
  };
}

function buildLegend(): SceneGroup {
  const children: SceneNode[] = [
    rectNode("legend-panel", "panel", 32, 440, 960, 160),
    textNode("legend-text", "label", 64, 488, "XOR: glyph present in exactly one input."),
    textNode("legend-empty", "label", 64, 536, "Empty mask = outlined empty cell."),
  ];
  const glyphChildren: SceneNode[] = [];
  for (let glyph = 0; glyph < 4; glyph += 1) {
    const x = 64 + glyph * 56;
    glyphChildren.push(
      rectNode(`legend-glyph-cell-${glyph}`, "panel", x, 552, 36, 36),
      glyphNode(glyph, x + 18, 570, `legend-glyph-${glyph}`),
    );
  }
  children.push({ kind: "group", id: "legend-glyphs", role: "glyph-legend", children: glyphChildren });
  return { kind: "group", id: "legend", role: "legend", children };
}

function buildOption(
  label: "A" | "B" | "C" | "D",
  mask: number,
  x: number,
  y: number,
): SceneGroup {
  return {
    kind: "group",
    id: `option-${label}`,
    role: "option",
    children: [
      rectNode(`option-${label}-tile`, "panel", x, y, 448, 180),
      miniGrid(`option-${label}-grid`, "option-grid", x + 16, y + 16, 120, mask),
      textNode(`option-${label}-label`, "label", x + 160, y + 64, label, 48, "start", "bold"),
      textNode(`option-${label}-caption-1`, "label", x + 160, y + 112, "See labeled"),
      textNode(`option-${label}-caption-2`, "label", x + 160, y + 152, `tile ${label}`),
    ],
  };
}

function validateChoices(choices: readonly MatrixChoiceInput[]): void {
  if (
    choices.length !== 4 ||
    choices.map((choice) => choice.label).join("") !== "ABCD" ||
    new Set(choices.map((choice) => choice.mask)).size !== 4 ||
    choices.some(
      (choice) =>
        !Number.isInteger(choice.mask) || choice.mask < 0 || choice.mask > 15,
    )
  ) {
    throw new MatrixRenderError(
      "INVALID_SCENE",
      "matrix renderer requires four distinct A-D masks in 0..15",
    );
  }
}

function resolveChoices(
  spec: MatrixSpec,
  choices: readonly MatrixChoiceInput[] | undefined,
): readonly MatrixChoiceInput[] {
  if (choices !== undefined) {
    return choices;
  }
  const solutions = solveMatrix(spec);
  const correct = solutions.length === 1 ? solutions[0] : undefined;
  if (correct === undefined) {
    throw new MatrixRenderError(
      "INVALID_SCENE",
      `matrix renderer requires one completion, received ${solutions.length}`,
    );
  }
  const set = matrixEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
  return set.choices.map((choice) => ({ label: choice.label, mask: choice.value }));
}

export function buildMatrixScene(
  spec: MatrixSpec,
  choices?: readonly MatrixChoiceInput[],
): Scene {
  const parsed = MatrixSpecSchema.parse(spec);
  const resolvedChoices = resolveChoices(parsed, choices);
  validateChoices(resolvedChoices);
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background: "#ffffff",
    title: "Matrix completion",
    desc: "Complete the missing bottom-right mask using XOR row and column rules.",
    nodes: [
      buildStem(parsed),
      buildLegend(),
      ...resolvedChoices.map((choice, index) =>
        buildOption(
          choice.label,
          choice.mask,
          index % 2 === 0 ? 32 : 512,
          index < 2 ? 616 : 812,
        ),
      ),
    ],
  };
  assertMatrixScene(scene, parsed, resolvedChoices);
  return scene;
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

function collectGlyphs(node: SceneNode): readonly SceneNode[] {
  if (node.role === "glyph") {
    return [node];
  }
  if (node.kind !== "group") {
    return [];
  }
  return node.children.flatMap((child) => collectGlyphs(child));
}

function collectTexts(node: SceneNode): readonly SceneText[] {
  if (node.kind === "text") {
    return [node];
  }
  if (node.kind !== "group") {
    return [];
  }
  return node.children.flatMap((child) => collectTexts(child));
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function expectedGlyphKind(glyph: number): SceneNode["kind"] {
  if (glyph === 0) {
    return "circle";
  }
  if (glyph === 1) {
    return "rect";
  }
  return "polygon";
}

function assertGlyphKind(glyph: number, node: SceneNode): void {
  if (node.kind !== expectedGlyphKind(glyph)) {
    throw new MatrixRenderError(
      "INVALID_SCENE",
      `glyph ${glyph} has the wrong shape ${node.kind}`,
    );
  }
  if (node.role !== "glyph" || ("fill" in node && node.fill !== SCENE_INK)) {
    throw new MatrixRenderError("INVALID_SCENE", `glyph ${glyph} has the wrong style`);
  }
  const bounds = nodeBounds(node);
  if (bounds === undefined) {
    throw new MatrixRenderError("INVALID_SCENE", `glyph ${glyph} has no bounds`);
  }
  const expectedWidth = glyph === 0 || glyph === 1 ? 16 : 18;
  const expectedHeight = glyph === 0 || glyph === 1 ? 16 : glyph === 2 ? 17 : 18;
  if (
    Math.abs(bounds.width - expectedWidth) > 1 ||
    Math.abs(bounds.height - expectedHeight) > 1
  ) {
    throw new MatrixRenderError("INVALID_SCENE", `glyph ${glyph} has the wrong size`);
  }
}

function assertGrid(
  grid: SceneNode,
  prefix: string,
  mask: number,
  parent: Bounds,
): void {
  const gridBounds = nodeBounds(grid);
  if (gridBounds === undefined || !boundsContain(parent, gridBounds)) {
    throw new MatrixRenderError("CLIPPED_GLYPH", `${prefix} is clipped by its parent`);
  }
  const glyphs = collectGlyphs(grid);
  const expected = maskGlyphs(mask);
  if (mask === 0 && glyphs.length !== 0) {
    throw new MatrixRenderError("EMPTY_MASK_VIOLATION", `${prefix} must not show glyphs`);
  }
  if (glyphs.length !== expected.length) {
    throw new MatrixRenderError(
      glyphs.length < expected.length ? "MISSING_GLYPH" : "EXTRA_GLYPH",
      `${prefix} shows ${glyphs.length} glyphs, expected ${expected.length}`,
    );
  }
  for (const glyph of expected) {
    const node = glyphs.find((candidate) => candidate.id === `${prefix}-glyph-${glyph}`);
    if (node === undefined) {
      throw new MatrixRenderError("MISSING_GLYPH", `${prefix} is missing glyph ${glyph}`);
    }
    assertGlyphKind(glyph, node);
    const bounds = nodeBounds(node);
    if (bounds === undefined || !boundsContain(gridBounds, bounds)) {
      throw new MatrixRenderError("CLIPPED_GLYPH", `${prefix} glyph ${glyph} is clipped`);
    }
    const position = MATRIX_GLYPH_POSITIONS[glyph];
    if (position === undefined) {
      throw new MatrixRenderError("INVALID_SCENE", `${prefix} has an unknown glyph position`);
    }
    const expectedX = gridBounds.x + position.x * gridBounds.width;
    const expectedY = gridBounds.y + position.y * gridBounds.height;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    if (Math.abs(centerX - expectedX) > 3 || Math.abs(centerY - expectedY) > 3) {
      throw new MatrixRenderError(
        "SWAPPED_GLYPH",
        `${prefix} glyph ${glyph} is not at its fixed position`,
      );
    }
  }
}

export function assertMatrixScene(
  scene: Scene,
  spec: MatrixSpec,
  choices: readonly MatrixChoiceInput[],
): void {
  assertScene(scene);
  validateChoices(choices);
  const parsed = MatrixSpecSchema.parse(spec);
  const solutions = solveMatrix(parsed);
  const correct = solutions.length === 1 ? solutions[0] : undefined;
  if (correct === undefined) {
    throw new MatrixRenderError(
      "INVALID_SCENE",
      `matrix renderer requires one completion, received ${solutions.length}`,
    );
  }
  if (!choices.some((choice) => choice.mask === correct)) {
    throw new MatrixRenderError(
      "INVALID_SCENE",
      "matrix option set does not contain the correct mask",
    );
  }
  const all = collectNodes(scene.nodes);
  const byId = new Map(all.map((node) => [node.id, node]));
  for (const critical of MATRIX_CRITICAL_GROUPS) {
    if (!byId.has(critical)) {
      throw new MatrixRenderError(
        "MISSING_CRITICAL_GROUP",
        `matrix scene is missing critical group ${critical}`,
      );
    }
  }
  const stem = byId.get("stem");
  const stemPanel = byId.get("stem-panel");
  const stemGrid = byId.get("stem-grid");
  if (stem === undefined || stemPanel === undefined || stemGrid === undefined) {
    throw new MatrixRenderError("INVALID_SCENE", "matrix stem is incomplete");
  }
  const stemPanelBounds = nodeBounds(stemPanel);
  const gridBounds = nodeBounds(stemGrid);
  if (stemPanelBounds === undefined || gridBounds === undefined) {
    throw new MatrixRenderError("INVALID_SCENE", "matrix stem has no bounds");
  }
  if (!boundsContain(stemPanelBounds, gridBounds)) {
    throw new MatrixRenderError("CLIPPED_GLYPH", "matrix stem grid is clipped");
  }
  const stemTexts = collectTexts(stem).map((text) => text.text);
  if (
    !stemTexts.some((text) => text.includes("Rows:")) ||
    !stemTexts.some((text) => text.includes("Cols:"))
  ) {
    throw new MatrixRenderError("INVALID_SCENE", "matrix stem must state both row and column rules");
  }
  if (stemTexts.some((text) => /\b[ABCD]\b/.test(text))) {
    throw new MatrixRenderError(
      "INVALID_SCENE",
      "matrix stem rules must not reuse answer-option labels",
    );
  }

  const cellBounds: Bounds[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const id = row === 2 && column === 2 ? "missing-cell" : `cell-${row}-${column}`;
      const cell = byId.get(id);
      if (cell === undefined) {
        throw new MatrixRenderError("INVALID_SCENE", `matrix cell ${id} is missing`);
      }
      const bounds = nodeBounds(cell);
      if (bounds === undefined || !boundsContain(gridBounds, bounds)) {
        throw new MatrixRenderError("CLIPPED_GLYPH", `matrix cell ${id} is clipped`);
      }
      cellBounds.push(bounds);
      if (row === 2 && column === 2) {
        if (collectGlyphs(cell).length !== 0) {
          throw new MatrixRenderError("EMPTY_MASK_VIOLATION", "missing cell must not show glyphs");
        }
        if (!collectTexts(cell).some((text) => text.text === "?")) {
          throw new MatrixRenderError("INVALID_SCENE", "missing cell marker is absent");
        }
      } else {
        const mask = matrixCell(parsed, row, column);
        if (mask === null) {
          throw new MatrixRenderError("INVALID_SCENE", "matrix has a null outside the missing cell");
        }
        assertGrid(cell, id, mask, gridBounds);
      }
    }
  }
  for (let left = 0; left < cellBounds.length; left += 1) {
    for (let right = left + 1; right < cellBounds.length; right += 1) {
      const first = cellBounds[left];
      const second = cellBounds[right];
      if (first !== undefined && second !== undefined && boundsOverlap(first, second)) {
        throw new MatrixRenderError("OVERLAP", "matrix cells overlap");
      }
    }
  }
  const missingBounds = cellBounds[cellBounds.length - 1];
  const otherBounds = cellBounds.slice(0, -1);
  if (missingBounds === undefined) {
    throw new MatrixRenderError("INVALID_SCENE", "missing cell has no bounds");
  }
  const maxX = Math.max(...otherBounds.map((bounds) => bounds.x));
  const maxY = Math.max(...otherBounds.map((bounds) => bounds.y));
  if (Math.abs(missingBounds.x - maxX) > 1 || Math.abs(missingBounds.y - maxY) > 1) {
    throw new MatrixRenderError("INVALID_SCENE", "missing cell is not bottom-right");
  }

  const legend = byId.get("legend");
  const legendGlyphs = byId.get("legend-glyphs");
  if (legend === undefined || legendGlyphs === undefined) {
    throw new MatrixRenderError("INVALID_SCENE", "matrix legend is incomplete");
  }
  const legendTexts = collectTexts(legend).map((text) => text.text);
  if (!legendTexts.some((text) => text.includes("Empty mask"))) {
    throw new MatrixRenderError("INVALID_SCENE", "empty-mask convention is absent");
  }
  for (let glyph = 0; glyph < 4; glyph += 1) {
    const node = byId.get(`legend-glyph-${glyph}`);
    if (node === undefined) {
      throw new MatrixRenderError("MISSING_GLYPH", `legend glyph ${glyph} is absent`);
    }
    assertGlyphKind(glyph, node);
  }

  for (const choice of choices) {
    const option = byId.get(`option-${choice.label}`);
    const tile = byId.get(`option-${choice.label}-tile`);
    const grid = byId.get(`option-${choice.label}-grid`);
    if (option === undefined || tile === undefined || grid === undefined) {
      throw new MatrixRenderError("INVALID_SCENE", `option ${choice.label} is incomplete`);
    }
    const tileBounds = nodeBounds(tile);
    if (tileBounds === undefined) {
      throw new MatrixRenderError("INVALID_SCENE", `option ${choice.label} has no tile bounds`);
    }
    assertGrid(grid, `option-${choice.label}-grid`, choice.mask, tileBounds);
    if (!collectTexts(option).some((text) => text.text === choice.label)) {
      throw new MatrixRenderError("INVALID_SCENE", `option ${choice.label} is not labeled`);
    }
  }
}

export const matrixRenderer = {
  family: "matrix" as const,
  version: "matrix-v1",
  buildScene(spec: MatrixSpec): Scene {
    return buildMatrixScene(spec);
  },
};

export type MatrixRenderer = typeof matrixRenderer;
export type MatrixChoiceSet = ChoiceSet<MatrixAnswer>;
export type MatrixCircleNode = SceneCircle;
export type MatrixPolygonNode = ScenePolygon;
