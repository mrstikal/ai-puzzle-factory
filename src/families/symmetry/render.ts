import type { ChoiceLabel, ChoiceSet } from "../../domain/answers.js";
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
  type SceneLine,
  type SceneNode,
  type SceneRect,
  type SceneText,
} from "../../render/scene.js";
import { symmetryEngine } from "./engine.js";
import {
  SYMMETRY_GRID_SIZE,
  SymmetryAnswerSchema,
  SymmetrySpecSchema,
  checkSymmetryAnswer,
  completeSymmetry,
  isKnownSymmetryCell,
  symmetryStateAt,
  type SymmetryAnswer,
  type SymmetryAxis,
  type SymmetryCell,
  type SymmetryCellState,
  type SymmetrySpec,
} from "./schema.js";

export const SYMMETRY_CELL_SIZE = 22;
export const SYMMETRY_RENDER_GRID_SIZE = SYMMETRY_GRID_SIZE * SYMMETRY_CELL_SIZE;
export const SYMMETRY_UNKNOWN_FILL = "#c0c0c0";
export const SYMMETRY_EMPTY_FILL = SCENE_BACKGROUND;
export const SYMMETRY_OCCUPIED_FILL = SCENE_INK;
export const SYMMETRY_CELL_STROKE = "#8a8a8a";
export const SYMMETRY_AXIS_INK = "#b00020";
export const SYMMETRY_AXIS_STROKE = 6;

const STEM_PANEL = { x: 32, y: 24, width: 960, height: 360 } as const;
const LEGEND_PANEL = { x: 32, y: 400, width: 960, height: 170 } as const;
const SOURCE_GRID = { x: 64, y: 120 } as const;
const OPTION_TILE = { width: 448, height: 210 } as const;
const OPTION_GRID_OFFSET = { x: 16, y: 24 } as const;
const OPTION_POSITIONS = [
  { x: 32, y: 580 },
  { x: 512, y: 580 },
  { x: 32, y: 798 },
  { x: 512, y: 798 },
] as const;

export const SYMMETRY_CRITICAL_GROUPS = [
  "source-tile",
  "source-axis",
  "state-legend",
  "option-A-tile",
  "option-B-tile",
  "option-C-tile",
  "option-D-tile",
] as const;
export type SymmetryCriticalGroup = (typeof SYMMETRY_CRITICAL_GROUPS)[number];

export type SymmetryRenderErrorCode =
  | "INVALID_SCENE"
  | "MISSING_CRITICAL_GROUP"
  | "WRONG_GEOMETRY"
  | "CHANGED_KNOWN_HALF"
  | "UNKNOWN_IN_OPTION"
  | "MISSING_AXIS"
  | "WRONG_AXIS"
  | "MISSING_AXIS_LABEL"
  | "MISSING_LEGEND"
  | "OPTION_NOT_DISTINCT"
  | "INVALID_CHOICE";

export class SymmetryRenderError extends Error {
  readonly code: SymmetryRenderErrorCode;

  constructor(
    code: SymmetryRenderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SymmetryRenderError";
    this.code = code;
  }
}

export interface SymmetryChoiceInput {
  readonly label: ChoiceLabel;
  readonly answer: readonly (readonly number[])[];
}

interface NormalizedSymmetryChoice {
  readonly label: ChoiceLabel;
  readonly answer: SymmetryAnswer;
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
  fill = SCENE_INK,
): SceneText {
  return {
    kind: "text",
    id,
    role,
    x,
    y,
    text,
    fontSize,
    fill,
    anchor,
    fontWeight,
  };
}

function lineNode(
  id: string,
  role: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke = SYMMETRY_AXIS_INK,
  strokeWidth = SYMMETRY_AXIS_STROKE,
): SceneLine {
  return {
    kind: "line",
    id,
    role,
    x1,
    y1,
    x2,
    y2,
    stroke,
    strokeWidth,
  };
}

function stateFill(state: SymmetryCellState): string {
  switch (state) {
    case "occupied":
      return SYMMETRY_OCCUPIED_FILL;
    case "empty":
      return SYMMETRY_EMPTY_FILL;
    case "unknown":
      return SYMMETRY_UNKNOWN_FILL;
    default:
      throw new SymmetryRenderError(
        "INVALID_SCENE",
        `unknown symmetry state ${String(state)}`,
      );
  }
}

function buildAxis(
  tileId: string,
  axis: SymmetryAxis,
  gridX: number,
  gridY: number,
  withLabel: boolean,
): SceneGroup {
  const children: SceneNode[] = [];
  const dashLength = 12;
  const gap = 8;
  const step = dashLength + gap;
  if (axis === "vertical") {
    const axisX = gridX + (SYMMETRY_GRID_SIZE / 2) * SYMMETRY_CELL_SIZE;
    for (
      let y = gridY + 4;
      y + dashLength <= gridY + SYMMETRY_RENDER_GRID_SIZE;
      y += step
    ) {
      children.push(
        lineNode(
          `${tileId}-axis-dash-${y}`,
          "axis-dash",
          axisX,
          y,
          axisX,
          y + dashLength,
        ),
      );
    }
  } else {
    const axisY = gridY + (SYMMETRY_GRID_SIZE / 2) * SYMMETRY_CELL_SIZE;
    for (
      let x = gridX + 4;
      x + dashLength <= gridX + SYMMETRY_RENDER_GRID_SIZE;
      x += step
    ) {
      children.push(
        lineNode(
          `${tileId}-axis-dash-${x}`,
          "axis-dash",
          x,
          axisY,
          x + dashLength,
          axisY,
        ),
      );
    }
  }
  if (withLabel) {
    const labelX = gridX + SYMMETRY_RENDER_GRID_SIZE + 8;
    const labelY = gridY + SYMMETRY_RENDER_GRID_SIZE / 2 - 4;
    children.push({
      kind: "group",
      id: "source-axis-label",
      role: "axis-label",
      children: [
        lineNode(
          `${tileId}-axis-sample`,
          "axis-sample",
          labelX,
          labelY,
          labelX + 20,
          labelY,
        ),
        textNode(
          `${tileId}-axis-text`,
          "axis-label-text",
          labelX + 28,
          labelY + 4,
          "axis",
          32,
          "start",
          "bold",
          SYMMETRY_AXIS_INK,
        ),
      ],
    });
  }
  const axisId = tileId === "source-tile" ? "source-axis" : tileId.replace(/-tile$/, "-axis");
  return { kind: "group", id: axisId, role: "axis", children };
}

function buildTile(
  tileId: string,
  role: "source-tile" | "option-tile",
  spec: SymmetrySpec,
  answer: SymmetryAnswer | undefined,
  gridX: number,
  gridY: number,
): SceneGroup {
  const children: SceneNode[] = [];
  for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
    for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
      const cell = { row, column };
      const state: SymmetryCellState =
        answer === undefined
          ? symmetryStateAt(spec, cell)
          : answer[row]?.[column] === 1
            ? "occupied"
            : "empty";
      children.push(
        rectNode(
          `${tileId}-cell-${row}-${column}`,
          "tile-cell",
          gridX + column * SYMMETRY_CELL_SIZE,
          gridY + row * SYMMETRY_CELL_SIZE,
          SYMMETRY_CELL_SIZE,
          SYMMETRY_CELL_SIZE,
          stateFill(state),
          SYMMETRY_CELL_STROKE,
          4,
        ),
      );
    }
  }
  children.push(
    buildAxis(tileId, spec.axis, gridX, gridY, role === "source-tile"),
  );
  return { kind: "group", id: tileId, role, children };
}

function buildStem(spec: SymmetrySpec): SceneGroup {
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
        "Complete the symmetric tile.",
        32,
        "start",
        "bold",
      ),
      textNode("source-label", "label", 64, 104, "Known + unknown"),
      buildTile(
        "source-tile",
        "source-tile",
        spec,
        undefined,
        SOURCE_GRID.x,
        SOURCE_GRID.y,
      ),
      textNode("stem-note-1", "label", 390, 104, "Each choice is a full tile."),
      textNode("stem-note-2", "label", 390, 144, "Known half stays fixed."),
      textNode("stem-note-3", "label", 390, 184, "Complete the unknown half."),
      textNode("stem-note-4", "label", 390, 224, "Gray = unknown."),
      textNode("stem-note-5", "label", 390, 264, "White = empty."),
      textNode("stem-note-6", "label", 390, 304, "Black = filled."),
      textNode("stem-note-7", "label", 390, 344, "Dashed red = axis."),
    ],
  };
}

function buildLegend(): SceneGroup {
  const swatch = (
    id: string,
    y: number,
    fill: string,
  ): SceneRect =>
    rectNode(
      `state-swatch-${id}`,
      "state-swatch",
      64,
      y,
      20,
      20,
      fill,
      SYMMETRY_CELL_STROKE,
      4,
    );
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
      {
        kind: "group",
        id: "state-legend",
        role: "state-legend",
        children: [
          textNode(
            "state-legend-title",
            "label",
            64,
            432,
            "States",
            32,
            "start",
            "bold",
          ),
          swatch("unknown", 456, SYMMETRY_UNKNOWN_FILL),
          textNode("state-legend-unknown", "label", 92, 474, "Gray = unknown"),
          swatch("empty", 498, SYMMETRY_EMPTY_FILL),
          textNode("state-legend-empty", "label", 92, 516, "White = empty"),
          swatch("occupied", 540, SYMMETRY_OCCUPIED_FILL),
          textNode("state-legend-filled", "label", 92, 558, "Black = filled"),
          lineNode("legend-axis-1", "axis-sample", 500, 474, 510, 474),
          lineNode("legend-axis-2", "axis-sample", 516, 474, 526, 474),
          lineNode("legend-axis-3", "axis-sample", 532, 474, 542, 474),
          textNode(
            "state-legend-axis",
            "label",
            548,
            474,
            "Dashed red = axis.",
          ),
          textNode(
            "state-legend-axis-position",
            "label",
            548,
            516,
            "Between central cells.",
          ),
          textNode(
            "state-legend-known",
            "label",
            548,
            558,
            "Known half unchanged.",
          ),
        ],
      },
    ],
  };
}

function buildOption(
  spec: SymmetrySpec,
  choice: NormalizedSymmetryChoice,
  index: number,
): SceneGroup {
  const position = OPTION_POSITIONS[index];
  if (position === undefined) {
    throw new SymmetryRenderError(
      "INVALID_SCENE",
      `missing symmetry option position ${index}`,
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
      buildTile(
        `option-${choice.label}-tile`,
        "option-tile",
        spec,
        choice.answer,
        position.x + OPTION_GRID_OFFSET.x,
        position.y + OPTION_GRID_OFFSET.y,
      ),
      textNode(
        `option-${choice.label}-label`,
        "label",
        position.x + 208,
        position.y + 56,
        choice.label,
        48,
        "start",
        "bold",
      ),
      textNode(
        `option-${choice.label}-caption`,
        "label",
        position.x + 208,
        position.y + 136,
        "Same half",
      ),
    ],
  };
}

function resolveChoices(
  spec: SymmetrySpec,
  choices: readonly SymmetryChoiceInput[] | undefined,
  optionsSeed?: string,
): readonly SymmetryChoiceInput[] {
  if (choices !== undefined) {
    return choices;
  }
  const correct = completeSymmetry(spec);
  const set = symmetryEngine.makeOptions(
    spec,
    correct,
    optionsSeed ?? hashCanonicalJson(spec),
  );
  return set.choices.map((choice) => ({
    label: choice.label,
    answer: choice.value,
  }));
}

function validateChoices(
  spec: SymmetrySpec,
  choices: readonly SymmetryChoiceInput[],
  validation: "full" | "calibration" = "full",
): readonly NormalizedSymmetryChoice[] {
  if (choices.length !== 4 || choices.map((choice) => choice.label).join("") !== "ABCD") {
    throw new SymmetryRenderError(
      "INVALID_CHOICE",
      "symmetry renderer requires four ordered A-D choices",
    );
  }
  const normalized: NormalizedSymmetryChoice[] = [];
  for (const choice of choices) {
    const parsed = SymmetryAnswerSchema.safeParse(choice.answer);
    if (!parsed.success) {
      throw new SymmetryRenderError(
        "INVALID_CHOICE",
        `symmetry choice ${choice.label} is not a full 8x8 completion`,
      );
    }
    for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
      for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
        const cell = { row, column };
        if (!isKnownSymmetryCell(spec.axis, cell)) {
          continue;
        }
        const expected = symmetryStateAt(spec, cell) === "occupied" ? 1 : 0;
        if (parsed.data[row]?.[column] !== expected) {
          throw new SymmetryRenderError(
            "CHANGED_KNOWN_HALF",
            `symmetry choice ${choice.label} changes the known half`,
          );
        }
      }
    }
    normalized.push({ label: choice.label, answer: parsed.data });
  }
  if (validation === "full") {
    if (
      new Set(
        normalized.map((choice) =>
          choice.answer.map((row) => row.join("")).join("|"),
        ),
      ).size !== 4
    ) {
      throw new SymmetryRenderError(
        "OPTION_NOT_DISTINCT",
        "symmetry choices must be four distinct completions",
      );
    }
    const trueChoices = normalized.filter((choice) =>
      checkSymmetryAnswer(spec, choice.answer),
    );
    if (trueChoices.length !== 1) {
      throw new SymmetryRenderError(
        "INVALID_CHOICE",
        `symmetry choices must contain exactly one valid completion, found ${trueChoices.length}`,
      );
    }
  }
  return normalized;
}

export function buildSymmetryScene(
  spec: SymmetrySpec,
  choices?: readonly SymmetryChoiceInput[],
  optionsSeed?: string,
  validation: "full" | "calibration" = "full",
): Scene {
  const parsed = SymmetrySpecSchema.parse(spec);
  const resolved = resolveChoices(parsed, choices, optionsSeed);
  const normalized = validateChoices(parsed, resolved, validation);
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background: SCENE_BACKGROUND,
    title: "Symmetry and missing part",
    desc: "Complete the missing half by reflecting every known cell across the marked axis.",
    nodes: [
      buildStem(parsed),
      buildLegend(),
      ...normalized.map((choice, index) => buildOption(parsed, choice, index)),
    ],
  };
  if (validation === "calibration") {
    assertScene(scene);
  } else {
    assertSymmetryScene(scene, parsed, normalized);
  }
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

function collectTexts(node: SceneNode): readonly SceneText[] {
  if (node.kind === "text") {
    return [node];
  }
  if (node.kind !== "group") {
    return [];
  }
  return node.children.flatMap((child) => collectTexts(child));
}

function requireNode(byId: ReadonlyMap<string, SceneNode>, id: string): SceneNode {
  const node = byId.get(id);
  if (node === undefined) {
    throw new SymmetryRenderError("INVALID_SCENE", `symmetry scene is missing ${id}`);
  }
  return node;
}

function requireBounds(node: SceneNode, message: string): Bounds {
  const bounds = nodeBounds(node);
  if (bounds === undefined) {
    throw new SymmetryRenderError("INVALID_SCENE", message);
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

function expectedCellState(
  spec: SymmetrySpec,
  answer: SymmetryAnswer | undefined,
  cell: SymmetryCell,
): SymmetryCellState {
  if (answer === undefined) {
    return symmetryStateAt(spec, cell);
  }
  return answer[cell.row]?.[cell.column] === 1 ? "occupied" : "empty";
}

function assertAxis(
  byId: ReadonlyMap<string, SceneNode>,
  tileId: string,
  spec: SymmetrySpec,
  gridX: number,
  gridY: number,
  container: Bounds,
): void {
  const axisId = tileId === "source-tile" ? "source-axis" : tileId.replace(/-tile$/, "-axis");
  const axis = byId.get(axisId);
  if (axis === undefined || axis.kind !== "group" || axis.role !== "axis") {
    throw new SymmetryRenderError("MISSING_AXIS", `${axisId} is absent`);
  }
  const axisBounds = requireBounds(axis, `${axisId} has no bounds`);
  if (!boundsContain(container, axisBounds)) {
    throw new SymmetryRenderError("MISSING_AXIS", `${axisId} is clipped`);
  }
  const dashes = collectByRole(axis, "axis-dash");
  if (dashes.length < 6) {
    throw new SymmetryRenderError("MISSING_AXIS", `${axisId} needs at least six dashes`);
  }
  const axisPosition =
    spec.axis === "vertical"
      ? gridX + (SYMMETRY_GRID_SIZE / 2) * SYMMETRY_CELL_SIZE
      : gridY + (SYMMETRY_GRID_SIZE / 2) * SYMMETRY_CELL_SIZE;
  let covered = 0;
  for (const dash of dashes) {
    if (
      dash.kind !== "line" ||
      dash.role !== "axis-dash" ||
      dash.stroke !== SYMMETRY_AXIS_INK ||
      dash.strokeWidth === undefined ||
      dash.strokeWidth < 4
    ) {
      throw new SymmetryRenderError("WRONG_AXIS", `${axisId} dash is not styled as an axis`);
    }
    if (spec.axis === "vertical") {
      if (
        Math.abs(dash.x1 - axisPosition) > 1 ||
        Math.abs(dash.x2 - axisPosition) > 1 ||
        dash.y2 <= dash.y1 ||
        dash.y1 < gridY ||
        dash.y2 > gridY + SYMMETRY_RENDER_GRID_SIZE
      ) {
        throw new SymmetryRenderError("WRONG_AXIS", `${axisId} dash is off the vertical axis`);
      }
      covered += dash.y2 - dash.y1;
    } else {
      if (
        Math.abs(dash.y1 - axisPosition) > 1 ||
        Math.abs(dash.y2 - axisPosition) > 1 ||
        dash.x2 <= dash.x1 ||
        dash.x1 < gridX ||
        dash.x2 > gridX + SYMMETRY_RENDER_GRID_SIZE
      ) {
        throw new SymmetryRenderError("WRONG_AXIS", `${axisId} dash is off the horizontal axis`);
      }
      covered += dash.x2 - dash.x1;
    }
  }
  if (covered < SYMMETRY_RENDER_GRID_SIZE * 0.6) {
    throw new SymmetryRenderError("WRONG_AXIS", `${axisId} does not span enough of the grid`);
  }
  if (tileId === "source-tile") {
    const label = byId.get("source-axis-label");
    if (label === undefined || label.kind !== "group" || label.role !== "axis-label") {
      throw new SymmetryRenderError("MISSING_AXIS_LABEL", "source axis has no label");
    }
    const texts = collectTexts(label).map((text) => text.text);
    if (!texts.includes("axis")) {
      throw new SymmetryRenderError("MISSING_AXIS_LABEL", "source axis label is missing");
    }
    const sample = collectByRole(label, "axis-sample")[0];
    if (
      sample === undefined ||
      sample.kind !== "line" ||
      sample.stroke !== SYMMETRY_AXIS_INK ||
      sample.strokeWidth === undefined ||
      sample.strokeWidth < 4
    ) {
      throw new SymmetryRenderError("MISSING_AXIS_LABEL", "source axis sample is missing");
    }
    const labelBounds = requireBounds(label, "source axis label has no bounds");
    if (!boundsContain(container, labelBounds)) {
      throw new SymmetryRenderError("MISSING_AXIS_LABEL", "source axis label is clipped");
    }
  }
}

function assertTile(
  byId: ReadonlyMap<string, SceneNode>,
  tileId: string,
  role: "source-tile" | "option-tile",
  spec: SymmetrySpec,
  answer: SymmetryAnswer | undefined,
  container: Bounds,
): void {
  const tile = byId.get(tileId);
  if (tile === undefined || tile.kind !== "group" || tile.role !== role) {
    throw new SymmetryRenderError("WRONG_GEOMETRY", `${tileId} is not a ${role}`);
  }
  const tileBounds = requireBounds(tile, `${tileId} has no bounds`);
  if (!boundsContain(container, tileBounds)) {
    throw new SymmetryRenderError("WRONG_GEOMETRY", `${tileId} is clipped`);
  }
  const firstCell = byId.get(`${tileId}-cell-0-0`);
  const firstBounds = firstCell === undefined ? undefined : nodeBounds(firstCell);
  if (firstBounds === undefined) {
    throw new SymmetryRenderError("WRONG_GEOMETRY", `${tileId} is missing its origin cell`);
  }
  const gridX = firstBounds.x;
  const gridY = firstBounds.y;
  const expectedIds = new Set<string>();
  for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
    for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
      const id = `${tileId}-cell-${row}-${column}`;
      expectedIds.add(id);
      const cell = byId.get(id);
      if (cell === undefined || cell.kind !== "rect" || cell.role !== "tile-cell") {
        throw new SymmetryRenderError("WRONG_GEOMETRY", `${tileId} is missing cell ${row},${column}`);
      }
      const bounds = requireBounds(cell, `${id} has no bounds`);
      if (
        Math.abs(bounds.x - (gridX + column * SYMMETRY_CELL_SIZE)) > 1 ||
        Math.abs(bounds.y - (gridY + row * SYMMETRY_CELL_SIZE)) > 1 ||
        Math.abs(bounds.width - SYMMETRY_CELL_SIZE) > 1 ||
        Math.abs(bounds.height - SYMMETRY_CELL_SIZE) > 1
      ) {
        throw new SymmetryRenderError("WRONG_GEOMETRY", `${id} is not at its fixed position`);
      }
      if (answer !== undefined && cell.fill === SYMMETRY_UNKNOWN_FILL) {
        throw new SymmetryRenderError(
          "UNKNOWN_IN_OPTION",
          `${id} shows unknown state in a completion`,
        );
      }
      const expectedState = expectedCellState(spec, answer, { row, column });
      if (cell.fill !== stateFill(expectedState)) {
        throw new SymmetryRenderError(
          "WRONG_GEOMETRY",
          `${id} has the wrong state fill`,
        );
      }
    }
  }
  const cells = collectByRole(tile, "tile-cell");
  if (
    cells.length !== SYMMETRY_GRID_SIZE * SYMMETRY_GRID_SIZE ||
    cells.some((cell) => !expectedIds.has(cell.id))
  ) {
    throw new SymmetryRenderError("WRONG_GEOMETRY", `${tileId} does not contain 64 fixed cells`);
  }
  assertAxis(byId, tileId, spec, gridX, gridY, container);
}

function assertStateLegend(
  byId: ReadonlyMap<string, SceneNode>,
  container: Bounds,
): void {
  const group = byId.get("state-legend");
  if (group === undefined || group.kind !== "group" || group.role !== "state-legend") {
    throw new SymmetryRenderError("MISSING_LEGEND", "state legend is absent");
  }
  const bounds = requireBounds(group, "state legend has no bounds");
  if (!boundsContain(container, bounds)) {
    throw new SymmetryRenderError("MISSING_LEGEND", "state legend is clipped");
  }
  const texts = collectTexts(group).map((text) => text.text);
  for (const required of [
    "States",
    "Gray = unknown",
    "White = empty",
    "Black = filled",
    "Dashed red = axis.",
    "Between central cells.",
    "Known half unchanged.",
  ]) {
    if (!texts.includes(required)) {
      throw new SymmetryRenderError("MISSING_LEGEND", `state legend is missing: ${required}`);
    }
  }
  const swatches = collectByRole(group, "state-swatch");
  if (swatches.length !== 3) {
    throw new SymmetryRenderError("MISSING_LEGEND", "state legend needs three swatches");
  }
  const fills = new Set(
    swatches.map((swatch) => (swatch.kind === "rect" ? swatch.fill : undefined)),
  );
  if (
    !fills.has(SYMMETRY_UNKNOWN_FILL) ||
    !fills.has(SYMMETRY_EMPTY_FILL) ||
    !fills.has(SYMMETRY_OCCUPIED_FILL)
  ) {
    throw new SymmetryRenderError("MISSING_LEGEND", "state legend swatches are wrong");
  }
  const samples = collectByRole(group, "axis-sample");
  if (
    samples.length < 1 ||
    samples.some(
      (sample) =>
        sample.kind !== "line" ||
        sample.stroke !== SYMMETRY_AXIS_INK ||
        sample.strokeWidth === undefined ||
        sample.strokeWidth < 4,
    )
  ) {
    throw new SymmetryRenderError("MISSING_LEGEND", "state legend axis sample is wrong");
  }
}

export function assertSymmetryScene(
  scene: Scene,
  spec: SymmetrySpec,
  choices: readonly SymmetryChoiceInput[],
): void {
  assertScene(scene);
  const parsed = SymmetrySpecSchema.parse(spec);
  const normalized = validateChoices(parsed, choices);
  const all = collectNodes(scene.nodes);
  const byId = new Map(all.map((node) => [node.id, node]));
  for (const critical of SYMMETRY_CRITICAL_GROUPS) {
    if (!byId.has(critical)) {
      if (critical === "source-axis") {
        throw new SymmetryRenderError("MISSING_AXIS", "source axis is absent");
      }
      if (critical === "state-legend") {
        throw new SymmetryRenderError("MISSING_LEGEND", "state legend is absent");
      }
      throw new SymmetryRenderError(
        "MISSING_CRITICAL_GROUP",
        `symmetry scene is missing critical group ${critical}`,
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
  assertTile(byId, "source-tile", "source-tile", parsed, undefined, stemPanel);
  for (const choice of normalized) {
    const panel = requireBounds(
      requireNode(byId, `option-${choice.label}-panel`),
      `option ${choice.label} panel has no bounds`,
    );
    assertTile(
      byId,
      `option-${choice.label}-tile`,
      "option-tile",
      parsed,
      choice.answer,
      panel,
    );
  }
  assertStateLegend(byId, legendPanel);
}

export const symmetryRenderer = {
  family: "symmetry" as const,
  version: "symmetry-v1",
  buildScene(spec: SymmetrySpec, optionsSeed?: string): Scene {
    return buildSymmetryScene(spec, undefined, optionsSeed);
  },
  assertScene(scene: Scene, spec: SymmetrySpec, choices: unknown): void {
    assertSymmetryScene(
      scene,
      spec,
      (choices as ChoiceSet<SymmetryAnswer>).choices.map((choice) => ({
        label: choice.label,
        answer: choice.value,
      })),
    );
  },
};

export type SymmetryRenderer = typeof symmetryRenderer;
