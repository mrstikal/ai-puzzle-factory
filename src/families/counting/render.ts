import type { ChoiceLabel } from "../../domain/answers.js";
import { hashCanonicalJson } from "../../util/hash.js";
import {
  SCENE_BACKGROUND,
  SCENE_INK,
  SCENE_PANEL,
  SCENE_SIZE,
  assertScene,
  nodeBounds,
  type Bounds,
  type Scene,
  type SceneGroup,
  type SceneNode,
  type ScenePoint,
  type SceneRect,
  type SceneText,
} from "../../render/scene.js";
import { countingEngine } from "./engine.js";
import {
  COUNTING_GRID_SIZE,
  CountingAnswerSchema,
  CountingSpecSchema,
  checkCountingAnswer,
  membershipMaskGrid,
  type CountingAnswer,
  type CountingQuery,
  type CountingSpec,
} from "./schema.js";

export const COUNTING_CELL_SIZE = 76;
export const COUNTING_RENDER_GRID_SIZE = COUNTING_GRID_SIZE * COUNTING_CELL_SIZE;
export const COUNTING_CELL_FILL = SCENE_BACKGROUND;
export const COUNTING_CELL_STROKE = "#333333";
export const COUNTING_MEMBER_FILL = SCENE_INK;
export const COUNTING_MARKER_STROKE_WIDTH = 4;
export const COUNTING_CELL_STROKE_WIDTH = 8;
export const COUNTING_SOURCE_MARKER_SIZE = 22;
export const COUNTING_LEGEND_MARKER_SIZE = 16;

const STEM_PANEL = { x: 32, y: 24, width: 960, height: 500 } as const;
const LEGEND_PANEL = { x: 32, y: 540, width: 960, height: 190 } as const;
const SOURCE_GRID = { x: 64, y: 128 } as const;
const LEGEND_SAMPLE = { x: 64, y: 624, size: 56, step: 128 } as const;
const OPTION_TILE = { width: 448, height: 140 } as const;
const OPTION_POSITIONS = [
  { x: 32, y: 736 },
  { x: 512, y: 736 },
  { x: 32, y: 882 },
  { x: 512, y: 882 },
] as const;

export const COUNTING_CRITICAL_GROUPS = [
  "source-grid",
  "membership-legend",
  "option-A-number",
  "option-B-number",
  "option-C-number",
  "option-D-number",
] as const;
export type CountingCriticalGroup = (typeof COUNTING_CRITICAL_GROUPS)[number];

export type CountingRenderErrorCode =
  | "INVALID_SCENE"
  | "MISSING_CRITICAL_GROUP"
  | "WRONG_GEOMETRY"
  | "MISSING_MARKER"
  | "WRONG_MARKER"
  | "MISSING_LEGEND"
  | "WRONG_QUERY"
  | "COLOR_ONLY_ENCODING"
  | "OPTION_NOT_DISTINCT"
  | "INVALID_CHOICE";

export class CountingRenderError extends Error {
  readonly code: CountingRenderErrorCode;

  constructor(
    code: CountingRenderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CountingRenderError";
    this.code = code;
  }
}

export interface CountingChoiceInput {
  readonly label: ChoiceLabel;
  readonly answer: CountingAnswer;
}

interface NormalizedCountingChoice {
  readonly label: ChoiceLabel;
  readonly answer: CountingAnswer;
}

type MarkerKind = "square" | "circle" | "triangle";

const MARKER_KINDS: readonly MarkerKind[] = ["square", "circle", "triangle"];
const SHAPE_LABELS = ["A", "B", "C"] as const;

export function countingQueryPhrase(query: CountingQuery): string {
  switch (query.operation) {
    case "unionCount":
      return "cells in at least one shape";
    case "intersectionAll":
      return "cells in all shapes";
    case "exactlyOneShape":
      return "cells in exactly one shape";
    case "exactlyKShapes":
      return `cells in exactly ${query.k} shapes`;
    default:
      throw new CountingRenderError(
        "INVALID_SCENE",
        `unknown counting query ${String(query.operation)}`,
      );
  }
}

export function countingQueryText(query: CountingQuery): string {
  return `Query: ${countingQueryPhrase(query)}.`;
}

function rectNode(
  id: string,
  role: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke?: string,
  strokeWidth?: number,
): SceneRect {
  return {
    kind: "rect",
    id,
    role,
    x,
    y,
    width,
    height,
    fill,
    ...(stroke !== undefined
      ? { stroke, strokeWidth: strokeWidth ?? 4 }
      : {}),
  };
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

function markerNode(
  id: string,
  shapeIndex: number,
  center: ScenePoint,
  size: number,
  member: boolean,
): SceneNode {
  const half = size / 2;
  const fill = member ? COUNTING_MEMBER_FILL : "none";
  const kind = MARKER_KINDS[shapeIndex];
  if (kind === undefined) {
    throw new CountingRenderError(
      "INVALID_SCENE",
      `counting marker ${shapeIndex} has no declared glyph`,
    );
  }
  if (kind === "square") {
    return {
      kind: "rect",
      id,
      role: "essential",
      x: center.x - half,
      y: center.y - half,
      width: size,
      height: size,
      fill,
      stroke: SCENE_INK,
      strokeWidth: COUNTING_MARKER_STROKE_WIDTH,
    };
  }
  if (kind === "circle") {
    return {
      kind: "circle",
      id,
      role: "essential",
      cx: center.x,
      cy: center.y,
      r: half,
      fill,
      stroke: SCENE_INK,
      strokeWidth: COUNTING_MARKER_STROKE_WIDTH,
    };
  }
  return {
    kind: "polygon",
    id,
    role: "essential",
    points: [
      { x: center.x, y: center.y - half },
      { x: center.x + half, y: center.y + half - 1 },
      { x: center.x - half, y: center.y + half - 1 },
    ],
    fill,
    stroke: SCENE_INK,
    strokeWidth: COUNTING_MARKER_STROKE_WIDTH,
  };
}

function maskLabel(mask: number, shapeCount: number): string {
  return SHAPE_LABELS.slice(0, shapeCount)
    .filter((_, index) => (mask & (1 << index)) !== 0)
    .join("");
}

function buildSourceCell(
  spec: CountingSpec,
  masks: readonly (readonly number[])[],
  row: number,
  column: number,
): SceneGroup {
  const x = SOURCE_GRID.x + column * COUNTING_CELL_SIZE;
  const y = SOURCE_GRID.y + row * COUNTING_CELL_SIZE;
  const mask = masks[row]?.[column] ?? 0;
  const children: SceneNode[] = [
    rectNode(
      `source-cell-${row}-${column}-panel`,
      "cell-panel",
      x,
      y,
      COUNTING_CELL_SIZE,
      COUNTING_CELL_SIZE,
      COUNTING_CELL_FILL,
      COUNTING_CELL_STROKE,
      COUNTING_CELL_STROKE_WIDTH,
    ),
  ];
  const centers = markerCenters(
    x,
    y,
    COUNTING_CELL_SIZE,
    COUNTING_SOURCE_MARKER_SIZE,
    spec.shapes.length,
  );
  for (let shapeIndex = 0; shapeIndex < spec.shapes.length; shapeIndex += 1) {
    const center = centers[shapeIndex];
    if (center === undefined) {
      throw new CountingRenderError(
        "INVALID_SCENE",
        `counting source cell ${row},${column} lost a marker center`,
      );
    }
    children.push(
      markerNode(
        `source-cell-${row}-${column}-marker-${shapeIndex}`,
        shapeIndex,
        center,
        COUNTING_SOURCE_MARKER_SIZE,
        (mask & (1 << shapeIndex)) !== 0,
      ),
    );
  }
  return {
    kind: "group",
    id: `source-cell-${row}-${column}`,
    role: "tile-cell",
    children,
  };
}

function buildSourceGrid(spec: CountingSpec): SceneGroup {
  const masks = membershipMaskGrid(spec);
  const cells: SceneNode[] = [];
  for (let row = 0; row < COUNTING_GRID_SIZE; row += 1) {
    for (let column = 0; column < COUNTING_GRID_SIZE; column += 1) {
      cells.push(buildSourceCell(spec, masks, row, column));
    }
  }
  return { kind: "group", id: "source-grid", role: "counting-grid", children: cells };
}

function buildStem(spec: CountingSpec): SceneGroup {
  const shapeLabels = SHAPE_LABELS.slice(0, spec.shapes.length).join(", ");
  return {
    kind: "group",
    id: "stem",
    role: "stem",
    children: [
      rectNode(
        "stem-panel",
        "panel",
        STEM_PANEL.x,
        STEM_PANEL.y,
        STEM_PANEL.width,
        STEM_PANEL.height,
        SCENE_PANEL,
        SCENE_INK,
        4,
      ),
      textNode(
        "stem-title",
        "label",
        64,
        64,
        "Count the membership cells.",
        32,
        "start",
        "bold",
      ),
      textNode(
        "stem-query",
        "label",
        64,
        104,
        countingQueryText(spec.query),
        32,
        "start",
        "bold",
      ),
      buildSourceGrid(spec),
      textNode("stem-shapes", "label", 460, 160, `Shapes: ${shapeLabels}`),
      textNode(
        "stem-note-count",
        "label",
        460,
        208,
        `Each cell has ${spec.shapes.length} markers.`,
      ),
      textNode(
        "stem-note-order",
        "label",
        460,
        256,
        `Left to right: ${shapeLabels}.`,
      ),
      textNode(
        "stem-note-shapes",
        "label",
        460,
        304,
        `${SHAPE_LABELS.slice(0, spec.shapes.length)
          .map((label, index) => `${label} ${["square", "circle", "tri"][index] ?? "marker"}`)
          .join(", ")}.`,
      ),
      textNode("stem-note-filled", "label", 460, 352, "Filled = member."),
      textNode(
        "stem-note-outline",
        "label",
        460,
        400,
        "Outline = not a member.",
      ),
      textNode(
        "stem-note-counting",
        "label",
        460,
        448,
        "Count whole cells once.",
      ),
      textNode(
        "stem-note-overlap",
        "label",
        460,
        496,
        "Overlap = several markers.",
      ),
    ],
  };
}

function buildLegendSample(
  mask: number,
  shapeCount: number,
  x: number,
  y: number,
): SceneGroup {
  const size = LEGEND_SAMPLE.size;
  const children: SceneNode[] = [
    rectNode(
      `legend-sample-${mask}-panel`,
      "cell-panel",
      x,
      y,
      size,
      size,
      COUNTING_CELL_FILL,
      COUNTING_CELL_STROKE,
      4,
    ),
  ];
  const centers = markerCenters(x, y, size, COUNTING_LEGEND_MARKER_SIZE, shapeCount);
  for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex += 1) {
    const center = centers[shapeIndex];
    if (center === undefined) {
      throw new CountingRenderError(
        "INVALID_SCENE",
        `counting legend sample ${mask} lost a marker center`,
      );
    }
    children.push(
      markerNode(
        `legend-sample-${mask}-marker-${shapeIndex}`,
        shapeIndex,
        center,
        COUNTING_LEGEND_MARKER_SIZE,
        (mask & (1 << shapeIndex)) !== 0,
      ),
    );
  }
  children.push(
    textNode(
      `legend-sample-${mask}-label`,
      "label",
      x + size / 2,
      y + size + 40,
      maskLabel(mask, shapeCount),
      32,
      "middle",
      "bold",
    ),
  );
  return {
    kind: "group",
    id: `legend-sample-${mask}`,
    role: "legend-sample",
    children,
  };
}

function buildLegend(spec: CountingSpec): SceneGroup {
  const maxMask = (1 << spec.shapes.length) - 1;
  const samples: SceneNode[] = [];
  for (let mask = 1; mask <= maxMask; mask += 1) {
    samples.push(
      buildLegendSample(
        mask,
        spec.shapes.length,
        LEGEND_SAMPLE.x + (mask - 1) * LEGEND_SAMPLE.step,
        LEGEND_SAMPLE.y,
      ),
    );
  }
  return {
    kind: "group",
    id: "legend",
    role: "legend",
    children: [
      rectNode(
        "legend-panel",
        "panel",
        LEGEND_PANEL.x,
        LEGEND_PANEL.y,
        LEGEND_PANEL.width,
        LEGEND_PANEL.height,
        SCENE_PANEL,
        SCENE_INK,
        4,
      ),
      textNode(
        "legend-title",
        "label",
        64,
        576,
        "Overlap examples",
        32,
        "start",
        "bold",
      ),
      textNode(
        "legend-note",
        "label",
        64,
        612,
        "Filled = member. Outline = not a member.",
      ),
      {
        kind: "group",
        id: "membership-legend",
        role: "membership-legend",
        children: samples,
      },
    ],
  };
}

function buildOption(
  choice: NormalizedCountingChoice,
  index: number,
): SceneGroup {
  const position = OPTION_POSITIONS[index];
  if (position === undefined) {
    throw new CountingRenderError(
      "INVALID_SCENE",
      `missing counting option position ${index}`,
    );
  }
  return {
    kind: "group",
    id: `option-${choice.label}`,
    role: "option",
    children: [
      rectNode(
        `option-${choice.label}-panel`,
        "panel",
        position.x,
        position.y,
        OPTION_TILE.width,
        OPTION_TILE.height,
        SCENE_PANEL,
        SCENE_INK,
        4,
      ),
      textNode(
        `option-${choice.label}-label`,
        "label",
        position.x + 32,
        position.y + 64,
        choice.label,
        48,
        "start",
        "bold",
      ),
      textNode(
        `option-${choice.label}-number`,
        "label",
        position.x + 224,
        position.y + 104,
        String(choice.answer),
        96,
        "middle",
        "bold",
      ),
      textNode(
        `option-${choice.label}-caption`,
        "label",
        position.x + 32,
        position.y + 120,
        "Count",
      ),
    ],
  };
}

function resolveChoices(
  spec: CountingSpec,
  choices: readonly CountingChoiceInput[] | undefined,
): readonly CountingChoiceInput[] {
  if (choices !== undefined) {
    return choices;
  }
  const result = countingEngine.enumerateSolutions(spec);
  const correct = result.correctAnswer;
  if (correct === null) {
    throw new CountingRenderError(
      "INVALID_SCENE",
      "counting renderer requires a unique query answer",
    );
  }
  const set = countingEngine.makeOptions(spec, correct, hashCanonicalJson(spec));
  return set.choices.map((choice) => ({
    label: choice.label,
    answer: choice.value,
  }));
}

function validateChoices(
  spec: CountingSpec,
  choices: readonly CountingChoiceInput[],
): readonly NormalizedCountingChoice[] {
  if (choices.length !== 4 || choices.map((choice) => choice.label).join("") !== "ABCD") {
    throw new CountingRenderError(
      "INVALID_CHOICE",
      "counting renderer requires four ordered A-D choices",
    );
  }
  const normalized: NormalizedCountingChoice[] = [];
  for (const choice of choices) {
    const parsed = CountingAnswerSchema.safeParse(choice.answer);
    if (!parsed.success) {
      throw new CountingRenderError(
        "INVALID_CHOICE",
        `counting choice ${choice.label} is not an integer in 0..25`,
      );
    }
    normalized.push({ label: choice.label, answer: parsed.data });
  }
  if (new Set(normalized.map((choice) => choice.answer)).size !== 4) {
    throw new CountingRenderError(
      "OPTION_NOT_DISTINCT",
      "counting choices must be four distinct integers",
    );
  }
  const trueChoices = normalized.filter((choice) =>
    checkCountingAnswer(spec, choice.answer),
  );
  if (trueChoices.length !== 1) {
    throw new CountingRenderError(
      "INVALID_CHOICE",
      `counting choices must contain exactly one correct integer, found ${trueChoices.length}`,
    );
  }
  return normalized;
}

export function buildCountingScene(
  spec: CountingSpec,
  choices?: readonly CountingChoiceInput[],
): Scene {
  const parsed = CountingSpecSchema.parse(spec);
  const resolved = resolveChoices(parsed, choices);
  const normalized = validateChoices(parsed, resolved);
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background: SCENE_BACKGROUND,
    title: "Counting and inclusion-exclusion",
    desc:
      "Count the cells selected by the query using the fixed A/B/C membership markers.",
    nodes: [
      buildStem(parsed),
      buildLegend(parsed),
      ...normalized.map((choice, index) => buildOption(choice, index)),
    ],
  };
  assertCountingScene(scene, parsed, normalized);
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

function collectByRole(node: SceneNode, role: string): readonly SceneNode[] {
  return collectNodes([node]).filter((candidate) => candidate.role === role);
}

function requireNode(
  byId: ReadonlyMap<string, SceneNode>,
  id: string,
): SceneNode {
  const node = byId.get(id);
  if (node === undefined) {
    throw new CountingRenderError(
      "INVALID_SCENE",
      `counting scene is missing ${id}`,
    );
  }
  return node;
}

function requireBounds(node: SceneNode, message: string): Bounds {
  const bounds = nodeBounds(node);
  if (bounds === undefined) {
    throw new CountingRenderError("INVALID_SCENE", message);
  }
  return bounds;
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function expectedMarkerKind(shapeIndex: number): MarkerKind {
  const kind = MARKER_KINDS[shapeIndex];
  if (kind === undefined) {
    throw new CountingRenderError(
      "INVALID_SCENE",
      `counting shape ${shapeIndex} has no declared marker glyph`,
    );
  }
  return kind;
}

function assertMarker(
  marker: SceneNode | undefined,
  id: string,
  shapeIndex: number,
  center: ScenePoint,
  size: number,
  member: boolean,
): void {
  if (marker === undefined) {
    throw new CountingRenderError("MISSING_MARKER", `${id} is absent`);
  }
  const kind = expectedMarkerKind(shapeIndex);
  const expectedKind =
    kind === "square" ? "rect" : kind === "circle" ? "circle" : "polygon";
  if (marker.kind !== expectedKind) {
    throw new CountingRenderError(
      "WRONG_MARKER",
      `${id} is not the ${kind} glyph for shape ${shapeIndex}`,
    );
  }
  const bounds = requireBounds(marker, `${id} has no bounds`);
  const expectedWidth = size;
  const expectedHeight = kind === "triangle" ? size - 1 : size;
  if (
    Math.abs(bounds.x - (center.x - size / 2)) > 1 ||
    Math.abs(bounds.y - (center.y - size / 2)) > 1 ||
    Math.abs(bounds.width - expectedWidth) > 1 ||
    Math.abs(bounds.height - expectedHeight) > 1
  ) {
    throw new CountingRenderError(
      "WRONG_MARKER",
      `${id} is not at its fixed marker position`,
    );
  }
  if (marker.role !== "essential") {
    throw new CountingRenderError(
      "WRONG_MARKER",
      `${id} is not an essential membership mark`,
    );
  }
  const fill = "fill" in marker ? marker.fill : undefined;
  const stroke = "stroke" in marker ? marker.stroke : undefined;
  const strokeWidth = "strokeWidth" in marker ? marker.strokeWidth : undefined;
  if (
    fill !== (member ? COUNTING_MEMBER_FILL : "none") ||
    stroke !== SCENE_INK ||
    strokeWidth !== COUNTING_MARKER_STROKE_WIDTH
  ) {
    throw new CountingRenderError(
      "WRONG_MARKER",
      `${id} does not encode ${member ? "membership" : "non-membership"} with a filled/outlined glyph`,
    );
  }
}

function assertCellMarkers(
  group: SceneNode,
  prefix: string,
  mask: number,
  shapeCount: number,
  cellX: number,
  cellY: number,
  cellSize: number,
  markerSize: number,
): void {
  const centers = markerCenters(cellX, cellY, cellSize, markerSize, shapeCount);
  const expectedIds = new Set<string>();
  for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex += 1) {
    const id = `${prefix}-marker-${shapeIndex}`;
    expectedIds.add(id);
    const center = centers[shapeIndex];
    if (center === undefined) {
      throw new CountingRenderError(
        "INVALID_SCENE",
        `${prefix} lost marker center ${shapeIndex}`,
      );
    }
    assertMarker(
      group.kind === "group"
        ? group.children.find((child) => child.id === id)
        : undefined,
      id,
      shapeIndex,
      center,
      markerSize,
      (mask & (1 << shapeIndex)) !== 0,
    );
  }
  const markers =
    group.kind === "group"
      ? group.children.filter(
          (child) => child.id.startsWith(`${prefix}-marker-`) || child.role === "essential",
        )
      : [];
  if (markers.length !== shapeCount || markers.some((marker) => !expectedIds.has(marker.id))) {
    throw new CountingRenderError(
      "WRONG_MARKER",
      `${prefix} must contain exactly ${shapeCount} fixed membership markers`,
    );
  }
}

function assertSourceGrid(
  byId: ReadonlyMap<string, SceneNode>,
  spec: CountingSpec,
  masks: readonly (readonly number[])[],
  stemBounds: Bounds,
): void {
  const grid = byId.get("source-grid");
  if (grid === undefined || grid.kind !== "group" || grid.role !== "counting-grid") {
    throw new CountingRenderError("WRONG_GEOMETRY", "source grid is absent");
  }
  const gridBounds = requireBounds(grid, "source grid has no bounds");
  if (!boundsContain(stemBounds, gridBounds)) {
    throw new CountingRenderError("WRONG_GEOMETRY", "source grid is clipped");
  }
  const cells = collectByRole(grid, "tile-cell");
  if (cells.length !== COUNTING_GRID_SIZE * COUNTING_GRID_SIZE) {
    throw new CountingRenderError(
      "WRONG_GEOMETRY",
      `source grid must contain 25 cells, received ${cells.length}`,
    );
  }
  for (let row = 0; row < COUNTING_GRID_SIZE; row += 1) {
    for (let column = 0; column < COUNTING_GRID_SIZE; column += 1) {
      const id = `source-cell-${row}-${column}`;
      const cell = byId.get(id);
      if (cell === undefined || cell.kind !== "group" || cell.role !== "tile-cell") {
        throw new CountingRenderError("WRONG_GEOMETRY", `${id} is absent`);
      }
      const expectedX = SOURCE_GRID.x + column * COUNTING_CELL_SIZE;
      const expectedY = SOURCE_GRID.y + row * COUNTING_CELL_SIZE;
      const panel = byId.get(`${id}-panel`);
      if (panel === undefined || panel.kind !== "rect") {
        throw new CountingRenderError("WRONG_GEOMETRY", `${id} has no cell panel`);
      }
      const panelBounds = requireBounds(panel, `${id} panel has no bounds`);
      if (
        Math.abs(panelBounds.x - expectedX) > 1 ||
        Math.abs(panelBounds.y - expectedY) > 1 ||
        Math.abs(panelBounds.width - COUNTING_CELL_SIZE) > 1 ||
        Math.abs(panelBounds.height - COUNTING_CELL_SIZE) > 1
      ) {
        throw new CountingRenderError(
          "WRONG_GEOMETRY",
          `${id} is not at its fixed position`,
        );
      }
      if (panel.fill !== COUNTING_CELL_FILL) {
        throw new CountingRenderError(
          "COLOR_ONLY_ENCODING",
          `${id} uses a cell fill instead of fixed membership markers`,
        );
      }
      if (
        panel.stroke !== COUNTING_CELL_STROKE ||
        panel.strokeWidth !== COUNTING_CELL_STROKE_WIDTH
      ) {
        throw new CountingRenderError(
          "WRONG_GEOMETRY",
          `${id} does not use the fixed cell outline`,
        );
      }
      assertCellMarkers(
        cell,
        id,
        masks[row]?.[column] ?? 0,
        spec.shapes.length,
        expectedX,
        expectedY,
        COUNTING_CELL_SIZE,
        COUNTING_SOURCE_MARKER_SIZE,
      );
    }
  }
}

function assertLegend(
  byId: ReadonlyMap<string, SceneNode>,
  spec: CountingSpec,
  legendBounds: Bounds,
): void {
  const legend = byId.get("membership-legend");
  if (
    legend === undefined ||
    legend.kind !== "group" ||
    legend.role !== "membership-legend"
  ) {
    throw new CountingRenderError("MISSING_LEGEND", "membership legend is absent");
  }
  const legendGroupBounds = requireBounds(legend, "membership legend has no bounds");
  if (!boundsContain(legendBounds, legendGroupBounds)) {
    throw new CountingRenderError("MISSING_LEGEND", "membership legend is clipped");
  }
  const title = byId.get("legend-title");
  if (
    title === undefined ||
    title.kind !== "text" ||
    title.text !== "Overlap examples"
  ) {
    throw new CountingRenderError("MISSING_LEGEND", "membership legend title is wrong");
  }
  const note = byId.get("legend-note");
  if (
    note === undefined ||
    note.kind !== "text" ||
    note.text !== "Filled = member. Outline = not a member."
  ) {
    throw new CountingRenderError("MISSING_LEGEND", "membership legend note is wrong");
  }
  const maxMask = (1 << spec.shapes.length) - 1;
  const samples = collectByRole(legend, "legend-sample");
  if (samples.length !== maxMask) {
    throw new CountingRenderError(
      "MISSING_LEGEND",
      `membership legend needs ${maxMask} nonempty overlap samples`,
    );
  }
  for (let mask = 1; mask <= maxMask; mask += 1) {
    const id = `legend-sample-${mask}`;
    const sample = byId.get(id);
    if (sample === undefined || sample.kind !== "group" || sample.role !== "legend-sample") {
      throw new CountingRenderError("MISSING_LEGEND", `${id} is absent`);
    }
    const x = LEGEND_SAMPLE.x + (mask - 1) * LEGEND_SAMPLE.step;
    const y = LEGEND_SAMPLE.y;
    const panel = byId.get(`${id}-panel`);
    if (panel === undefined || panel.kind !== "rect") {
      throw new CountingRenderError("MISSING_LEGEND", `${id} has no sample cell`);
    }
    const panelBounds = requireBounds(panel, `${id} panel has no bounds`);
    if (
      Math.abs(panelBounds.x - x) > 1 ||
      Math.abs(panelBounds.y - y) > 1 ||
      Math.abs(panelBounds.width - LEGEND_SAMPLE.size) > 1 ||
      Math.abs(panelBounds.height - LEGEND_SAMPLE.size) > 1 ||
      panel.fill !== COUNTING_CELL_FILL
    ) {
      throw new CountingRenderError(
        "MISSING_LEGEND",
        `${id} is not a fixed white sample cell`,
      );
    }
    assertCellMarkers(
      sample,
      id,
      mask,
      spec.shapes.length,
      x,
      y,
      LEGEND_SAMPLE.size,
      COUNTING_LEGEND_MARKER_SIZE,
    );
    const label = byId.get(`${id}-label`);
    if (
      label === undefined ||
      label.kind !== "text" ||
      label.text !== maskLabel(mask, spec.shapes.length)
    ) {
      throw new CountingRenderError(
        "MISSING_LEGEND",
        `${id} has the wrong overlap label`,
      );
    }
  }
}

function assertStemText(
  byId: ReadonlyMap<string, SceneNode>,
  spec: CountingSpec,
): void {
  const query = byId.get("stem-query");
  if (
    query === undefined ||
    query.kind !== "text" ||
    query.text !== countingQueryText(spec.query)
  ) {
    throw new CountingRenderError(
      "WRONG_QUERY",
      `stem query must read ${countingQueryText(spec.query)}`,
    );
  }
  const shapes = byId.get("stem-shapes");
  const expectedShapes = `Shapes: ${SHAPE_LABELS.slice(0, spec.shapes.length).join(", ")}`;
  if (shapes === undefined || shapes.kind !== "text" || shapes.text !== expectedShapes) {
    throw new CountingRenderError("WRONG_GEOMETRY", `stem shapes must read ${expectedShapes}`);
  }
}

function assertOptions(
  byId: ReadonlyMap<string, SceneNode>,
  choices: readonly NormalizedCountingChoice[],
): void {
  for (const choice of choices) {
    const option = byId.get(`option-${choice.label}`);
    if (option === undefined || option.kind !== "group" || option.role !== "option") {
      throw new CountingRenderError(
        "INVALID_CHOICE",
        `option-${choice.label} is absent`,
      );
    }
    const label = byId.get(`option-${choice.label}-label`);
    if (label === undefined || label.kind !== "text" || label.text !== choice.label) {
      throw new CountingRenderError(
        "INVALID_CHOICE",
        `option-${choice.label} is not visibly labeled`,
      );
    }
    const number = byId.get(`option-${choice.label}-number`);
    if (
      number === undefined ||
      number.kind !== "text" ||
      number.text !== String(choice.answer)
    ) {
      throw new CountingRenderError(
        "WRONG_GEOMETRY",
        `option-${choice.label} does not render its stored number`,
      );
    }
  }
}

export function assertCountingScene(
  scene: Scene,
  spec: CountingSpec,
  choices: readonly CountingChoiceInput[],
): void {
  assertScene(scene);
  const parsed = CountingSpecSchema.parse(spec);
  const normalized = validateChoices(parsed, choices);
  const all = collectNodes(scene.nodes);
  const byId = new Map(all.map((node) => [node.id, node]));
  for (const critical of COUNTING_CRITICAL_GROUPS) {
    if (!byId.has(critical)) {
      if (critical === "membership-legend") {
        throw new CountingRenderError("MISSING_LEGEND", "membership legend is absent");
      }
      throw new CountingRenderError(
        "MISSING_CRITICAL_GROUP",
        `counting scene is missing critical group ${critical}`,
      );
    }
  }
  const stemPanel = requireBounds(
    requireNode(byId, "stem-panel"),
    "stem panel has no bounds",
  );
  const legendPanel = requireBounds(
    requireNode(byId, "legend-panel"),
    "legend panel has no bounds",
  );
  assertStemText(byId, parsed);
  assertSourceGrid(byId, parsed, membershipMaskGrid(parsed), stemPanel);
  assertLegend(byId, parsed, legendPanel);
  assertOptions(byId, normalized);
}

export const countingRenderer = {
  family: "counting" as const,
  version: "counting-v1",
  buildScene(spec: CountingSpec): Scene {
    return buildCountingScene(spec);
  },
};

export type CountingRenderer = typeof countingRenderer;
