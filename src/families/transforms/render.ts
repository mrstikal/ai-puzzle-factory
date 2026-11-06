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
  type ScenePoint,
  type ScenePolygon,
  type ScenePolyline,
  type SceneRect,
  type SceneText,
} from "../../render/scene.js";
import type { D4Operation } from "../contracts.js";
import { transformOrbit, transformsEngine } from "./engine.js";
import {
  TRANSFORM_GRID_SIZE,
  TransformAnswerSchema,
  TransformsSpecSchema,
  checkTransformAnswer,
  sameTransformMask,
  solveTransforms,
  sourceCellsFromGrid,
  transformMaskKey,
  type TransformAnswer,
  type TransformCell,
  type TransformsSpec,
} from "./schema.js";

export const TRANSFORM_CELL_SIZE = 28;
export const TRANSFORM_CELL_GAP = 5;
export const TRANSFORM_CELL_STRIDE = TRANSFORM_CELL_SIZE + TRANSFORM_CELL_GAP;
export const TRANSFORM_RENDER_GRID_SIZE =
  TRANSFORM_GRID_SIZE * TRANSFORM_CELL_SIZE +
  (TRANSFORM_GRID_SIZE - 1) * TRANSFORM_CELL_GAP;

const STEM_PANEL = { x: 32, y: 24, width: 960, height: 380 } as const;
const LEGEND_PANEL = { x: 32, y: 420, width: 960, height: 180 } as const;
const SOURCE_GRID = { x: 64, y: 132 } as const;
const OPERATION_CARD = { width: 320, height: 240, y: 140 } as const;
const OPERATION_POSITIONS_TWO = [280, 620] as const;
const OPERATION_POSITION_ONE = 450 as const;
const OPERATION_ICON = { x: 80, y: 195, radius: 32 } as const;
const AXIS_ARROW = { x: 900, y: 530, radius: 30 } as const;
const OPTION_TILE = { width: 448, height: 196 } as const;
const OPTION_GRID_OFFSET = { x: 16, y: 28 } as const;
const OPTION_POSITIONS = [
  { x: 32, y: 612 },
  { x: 512, y: 612 },
  { x: 32, y: 820 },
  { x: 512, y: 820 },
] as const;

export const TRANSFORMS_CRITICAL_GROUPS = [
  "source-grid",
  "operation-sequence",
  "axis-legend",
  "option-A-grid",
  "option-B-grid",
  "option-C-grid",
  "option-D-grid",
] as const;
export type TransformsCriticalGroup = (typeof TRANSFORMS_CRITICAL_GROUPS)[number];

export type TransformsRenderErrorCode =
  | "INVALID_SCENE"
  | "MISSING_CRITICAL_GROUP"
  | "MISSING_AXIS"
  | "MISSING_ORIENTATION"
  | "INVISIBLE_MARKER"
  | "OFF_CENTER_PIVOT"
  | "WRONG_GEOMETRY"
  | "WRONG_AXIS"
  | "REVERSED_ARROW"
  | "REVERSED_ORDER"
  | "DECORATIVE_ROTATION"
  | "CLIPPED_GRID"
  | "OVERLAP"
  | "OPTION_NOT_DISTINCT"
  | "MISSING_OPERATION";

export class TransformsRenderError extends Error {
  readonly code: TransformsRenderErrorCode;

  constructor(
    code: TransformsRenderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransformsRenderError";
    this.code = code;
  }
}

export interface TransformsChoiceInput {
  readonly label: ChoiceLabel;
  readonly cells: readonly TransformCell[];
}

interface NormalizedTransformsChoice {
  readonly label: ChoiceLabel;
  readonly cells: TransformAnswer;
}

type OperationVisual =
  | {
      readonly kind: "rotation";
      readonly title: string;
      readonly subtitle: string;
      readonly angle: 90 | 180 | 270;
    }
  | {
      readonly kind: "reflection";
      readonly title: string;
      readonly subtitle: string;
      readonly operation: D4Operation;
    }
  | {
      readonly kind: "identity";
      readonly title: string;
      readonly subtitle: string;
    };

function operationVisual(operation: D4Operation): OperationVisual {
  switch (operation) {
    case "rotate90":
      return { kind: "rotation", title: "R90", subtitle: "90° clockwise", angle: 90 };
    case "rotate180":
      return { kind: "rotation", title: "R180", subtitle: "180° clockwise", angle: 180 };
    case "rotate270":
      return { kind: "rotation", title: "R270", subtitle: "270° clockwise", angle: 270 };
    case "reflectLeftRight":
      return {
        kind: "reflection",
        title: "Mirror",
        subtitle: "left-right axis",
        operation,
      };
    case "reflectTopBottom":
      return {
        kind: "reflection",
        title: "Mirror",
        subtitle: "top-bottom axis",
        operation,
      };
    case "reflectMainDiagonal":
      return {
        kind: "reflection",
        title: "Mirror",
        subtitle: "main diagonal",
        operation,
      };
    case "reflectAntiDiagonal":
      return {
        kind: "reflection",
        title: "Mirror",
        subtitle: "anti-diagonal",
        operation,
      };
    case "identity":
      return { kind: "identity", title: "Identity", subtitle: "no change" };
    default:
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `unknown transform operation ${String(operation)}`,
      );
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
  return {
    kind: "rect",
    id,
    role,
    x,
    y,
    width,
    height,
    fill,
    stroke,
    strokeWidth: 4,
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

function lineNode(
  id: string,
  role: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SceneLine {
  return {
    kind: "line",
    id,
    role,
    x1,
    y1,
    x2,
    y2,
    stroke: SCENE_INK,
    strokeWidth: 4,
  };
}

function polylineNode(
  id: string,
  role: string,
  points: readonly ScenePoint[],
): ScenePolyline {
  return {
    kind: "polyline",
    id,
    role,
    points,
    fill: "none",
    stroke: SCENE_INK,
    strokeWidth: 4,
  };
}

function polygonNode(
  id: string,
  role: string,
  points: readonly ScenePoint[],
  fill = SCENE_INK,
): ScenePolygon {
  return { kind: "polygon", id, role, points, fill };
}

function clockwiseArrow(
  id: string,
  cx: number,
  cy: number,
  radius: number,
  angleDegrees: 90 | 180 | 270,
): SceneGroup {
  const segments = Math.max(4, Math.ceil(angleDegrees / 22.5));
  const points: ScenePoint[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const theta = ((-90 + (angleDegrees * index) / segments) * Math.PI) / 180;
    points.push({
      x: cx + radius * Math.cos(theta),
      y: cy + radius * Math.sin(theta),
    });
  }
  const end = points[points.length - 1];
  if (end === undefined) {
    throw new TransformsRenderError("INVALID_SCENE", "rotation arrow has no end point");
  }
  const endTheta = ((-90 + angleDegrees) * Math.PI) / 180;
  const tangent = { x: -Math.sin(endTheta), y: Math.cos(endTheta) };
  const normal = { x: -tangent.y, y: tangent.x };
  const tip = { x: end.x + tangent.x * 10, y: end.y + tangent.y * 10 };
  const baseCenter = { x: end.x - tangent.x * 2, y: end.y - tangent.y * 2 };
  const baseOne = {
    x: baseCenter.x + normal.x * 7,
    y: baseCenter.y + normal.y * 7,
  };
  const baseTwo = {
    x: baseCenter.x - normal.x * 7,
    y: baseCenter.y - normal.y * 7,
  };
  return {
    kind: "group",
    id,
    role: "rotation-arrow",
    children: [
      polylineNode(`${id}-arc`, "arrow-arc", points),
      polygonNode(`${id}-head`, "arrow-head", [tip, baseOne, baseTwo]),
    ],
  };
}

function mirrorAxis(
  id: string,
  cx: number,
  cy: number,
  halfLength: number,
  operation: D4Operation,
): SceneLine {
  switch (operation) {
    case "reflectLeftRight":
      return lineNode(id, "mirror-axis", cx, cy - halfLength, cx, cy + halfLength);
    case "reflectTopBottom":
      return lineNode(id, "mirror-axis", cx - halfLength, cy, cx + halfLength, cy);
    case "reflectMainDiagonal":
      return lineNode(
        id,
        "mirror-axis",
        cx - halfLength,
        cy - halfLength,
        cx + halfLength,
        cy + halfLength,
      );
    case "reflectAntiDiagonal":
      return lineNode(
        id,
        "mirror-axis",
        cx - halfLength,
        cy + halfLength,
        cx + halfLength,
        cy - halfLength,
      );
    default:
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `operation ${operation} is not a reflection`,
      );
  }
}

function buildGrid(
  id: string,
  role: string,
  x: number,
  y: number,
  cells: readonly TransformCell[],
): SceneGroup {
  const occupied = new Set(cells.map((cell) => `${cell.row}:${cell.column}`));
  const children: SceneNode[] = [];
  for (let row = 0; row < TRANSFORM_GRID_SIZE; row += 1) {
    for (let column = 0; column < TRANSFORM_GRID_SIZE; column += 1) {
      const filled = occupied.has(`${row}:${column}`);
      children.push(
        rectNode(
          `${id}-cell-${row}-${column}`,
          "grid-cell",
          x + column * TRANSFORM_CELL_STRIDE,
          y + row * TRANSFORM_CELL_STRIDE,
          TRANSFORM_CELL_SIZE,
          TRANSFORM_CELL_SIZE,
          filled ? SCENE_INK : SCENE_PANEL,
        ),
      );
    }
  }
  const centerX = x + TRANSFORM_RENDER_GRID_SIZE / 2;
  const centerY = y + TRANSFORM_RENDER_GRID_SIZE / 2;
  children.push({
    kind: "group",
    id: `${id}-pivot`,
    role: "pivot",
    children: [
      {
        kind: "circle",
        id: `${id}-pivot-halo`,
        role: "pivot-halo",
        cx: centerX,
        cy: centerY,
        r: 10,
        fill: SCENE_BACKGROUND,
      },
      {
        kind: "circle",
        id: `${id}-pivot-ring`,
        role: "pivot-ring",
        cx: centerX,
        cy: centerY,
        r: 7,
        fill: "none",
        stroke: SCENE_INK,
        strokeWidth: 4,
      },
    ],
  });
  children.push(
    polygonNode(`${id}-orientation`, "orientation", [
      { x: centerX, y: y - 18 },
      { x: centerX - 8, y: y - 4 },
      { x: centerX + 8, y: y - 4 },
    ]),
  );
  return { kind: "group", id, role, children };
}

function buildOperationCard(
  index: number,
  operation: D4Operation,
  x: number,
  y: number,
): SceneGroup {
  const id = `operation-op${index}`;
  const visual = operationVisual(operation);
  const children: SceneNode[] = [
    rectNode(
      `${id}-panel`,
      "panel",
      x,
      y,
      OPERATION_CARD.width,
      OPERATION_CARD.height,
    ),
    textNode(
      `${id}-order-number`,
      "label",
      x + 16,
      y + 48,
      String(index + 1),
      40,
      "start",
      "bold",
    ),
    textNode(
      `${id}-order-word`,
      "label",
      x + 64,
      y + 48,
      index === 0 ? "First" : "Then",
    ),
    textNode(`${id}-title`, "label", x + 16, y + 96, visual.title, 32, "start", "bold"),
    textNode(`${id}-subtitle`, "label", x + 16, y + 136, visual.subtitle),
  ];
  if (visual.kind === "rotation") {
    children.push(
      clockwiseArrow(
        `${id}-rotation-arrow`,
        x + OPERATION_ICON.x,
        y + OPERATION_ICON.y,
        OPERATION_ICON.radius,
        visual.angle,
      ),
    );
  } else if (visual.kind === "reflection") {
    children.push(
      mirrorAxis(
        `${id}-mirror-axis`,
        x + OPERATION_ICON.x,
        y + OPERATION_ICON.y,
        36,
        visual.operation,
      ),
    );
  } else {
    children.push(
      textNode(
        `${id}-identity-mark`,
        "identity-mark",
        x + OPERATION_ICON.x,
        y + OPERATION_ICON.y + 16,
        "=",
        48,
        "middle",
        "bold",
      ),
    );
  }
  return { kind: "group", id, role: "operation", children };
}

function buildOperationSequence(operations: readonly D4Operation[]): SceneGroup {
  const children: SceneNode[] = [
    textNode(
      "operations-label",
      "label",
      280,
      104,
      "Operations apply in order.",
      32,
      "start",
      "bold",
    ),
  ];
  const positions =
    operations.length === 2 ? OPERATION_POSITIONS_TWO : [OPERATION_POSITION_ONE];
  for (const [index, operation] of operations.entries()) {
    const x = positions[index];
    if (x === undefined) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `missing operation card position ${index}`,
      );
    }
    children.push(buildOperationCard(index, operation, x, OPERATION_CARD.y));
  }
  return { kind: "group", id: "operation-sequence", role: "operation-sequence", children };
}

function buildStem(spec: TransformsSpec, source: readonly TransformCell[]): SceneGroup {
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
      ),
      textNode(
        "stem-title",
        "label",
        64,
        72,
        "Apply the ordered operations.",
        32,
        "start",
        "bold",
      ),
      textNode("source-label", "label", 64, 104, "Source", 32, "start", "bold"),
      buildGrid("source-grid", "source-grid", SOURCE_GRID.x, SOURCE_GRID.y, source),
      textNode(
        "source-pivot-note",
        "label",
        64,
        332,
        "Pivot: center cell (2,2).",
      ),
      textNode(
        "source-orientation-note",
        "label",
        64,
        372,
        "Top marker = viewer up.",
      ),
      buildOperationSequence(spec.operations),
    ],
  };
}

function buildLegend(): SceneGroup {
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
      ),
      {
        kind: "group",
        id: "axis-legend",
        role: "axis-legend",
        children: [
          textNode(
            "axis-title",
            "label",
            64,
            468,
            "Viewer-relative axes and clockwise direction.",
            32,
            "start",
            "bold",
          ),
          textNode("axis-line-1", "label", 64, 510, "Axes: top = up, right = right."),
          textNode(
            "axis-line-2",
            "label",
            64,
            552,
            "Clockwise: top, right, bottom, left.",
          ),
          textNode(
            "axis-line-3",
            "label",
            64,
            592,
            "Pivot: center (2,2); top marker = up.",
          ),
          clockwiseArrow(
            "axis-clockwise-arrow",
            AXIS_ARROW.x,
            AXIS_ARROW.y,
            AXIS_ARROW.radius,
            270,
          ),
        ],
      },
    ],
  };
}

function buildOption(
  choice: NormalizedTransformsChoice,
  index: number,
): SceneGroup {
  const position = OPTION_POSITIONS[index];
  if (position === undefined) {
    throw new TransformsRenderError(
      "INVALID_SCENE",
      `missing option position ${index}`,
    );
  }
  return {
    kind: "group",
    id: `option-${choice.label}`,
    role: "option",
    children: [
      rectNode(
        `option-${choice.label}-tile`,
        "panel",
        position.x,
        position.y,
        OPTION_TILE.width,
        OPTION_TILE.height,
      ),
      buildGrid(
        `option-${choice.label}-grid`,
        "option-grid",
        position.x + OPTION_GRID_OFFSET.x,
        position.y + OPTION_GRID_OFFSET.y,
        choice.cells,
      ),
      textNode(
        `option-${choice.label}-label`,
        "label",
        position.x + 200,
        position.y + 64,
        choice.label,
        48,
        "start",
        "bold",
      ),
      textNode(
        `option-${choice.label}-caption`,
        "label",
        position.x + 200,
        position.y + 120,
        "Same scale",
      ),
    ],
  };
}

function resolveChoices(
  spec: TransformsSpec,
  choices: readonly TransformsChoiceInput[] | undefined,
  optionsSeed?: string,
): readonly TransformsChoiceInput[] {
  if (choices !== undefined) {
    return choices;
  }
  const correct = solveTransforms(spec);
  const set = transformsEngine.makeOptions(
    spec,
    correct,
    optionsSeed ?? hashCanonicalJson(spec),
  );
  return set.choices.map((choice) => ({
    label: choice.label,
    cells: choice.value,
  }));
}

function validateChoices(
  spec: TransformsSpec,
  choices: readonly TransformsChoiceInput[],
  validation: "full" | "calibration" = "full",
): readonly NormalizedTransformsChoice[] {
  if (choices.length !== 4 || choices.map((choice) => choice.label).join("") !== "ABCD") {
    throw new TransformsRenderError(
      "INVALID_SCENE",
      "transform renderer requires four ordered A-D choices",
    );
  }
  const source = sourceCellsFromGrid(spec.source);
  const orbit = transformOrbit(source);
  const normalized: NormalizedTransformsChoice[] = [];
  for (const choice of choices) {
    const parsed = TransformAnswerSchema.safeParse(choice.cells);
    if (!parsed.success) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `transform choice ${choice.label} is not a complete sorted mask`,
      );
    }
    if (parsed.data.length !== source.length) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `transform choice ${choice.label} has the wrong cell count`,
      );
    }
    if (!orbit.some((candidate) => sameTransformMask(candidate, parsed.data))) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `transform choice ${choice.label} is not in the source D4 orbit`,
      );
    }
    normalized.push({ label: choice.label, cells: parsed.data });
  }
  if (
    validation === "full" &&
    new Set(normalized.map((choice) => transformMaskKey(choice.cells))).size !== 4
  ) {
    throw new TransformsRenderError(
      "OPTION_NOT_DISTINCT",
      "transform choices must be four distinct occupied-cell masks",
    );
  }
  if (validation === "full") {
    const correct = solveTransforms(spec);
    const trueChoices = normalized.filter((choice) =>
      checkTransformAnswer(spec, choice.cells),
    );
    if (
      trueChoices.length !== 1 ||
      !sameTransformMask(trueChoices[0]?.cells ?? [], correct)
    ) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        "transform choices must contain exactly one correct complete mask",
      );
    }
  }
  return normalized;
}

export function buildTransformsScene(
  spec: TransformsSpec,
  choices?: readonly TransformsChoiceInput[],
  optionsSeed?: string,
  validation: "full" | "calibration" = "full",
): Scene {
  const parsed = TransformsSpecSchema.parse(spec);
  const resolved = resolveChoices(parsed, choices, optionsSeed);
  const normalized = validateChoices(parsed, resolved, validation);
  const source = sourceCellsFromGrid(parsed.source);
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background: SCENE_BACKGROUND,
    title: "Rotation and reflection",
    desc: "Apply the ordered transforms to the source and choose the complete result.",
    nodes: [
      buildStem(parsed, source),
      buildLegend(),
      ...normalized.map((choice, index) => buildOption(choice, index)),
    ],
  };
  if (validation === "calibration") {
    assertScene(scene);
  } else {
    assertTransformsScene(scene, parsed, normalized);
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

function collectTexts(node: SceneNode): readonly SceneText[] {
  if (node.kind === "text") {
    return [node];
  }
  if (node.kind !== "group") {
    return [];
  }
  return node.children.flatMap((child) => collectTexts(child));
}

function collectByRole(node: SceneNode, role: string): readonly SceneNode[] {
  const collected: SceneNode[] = [];
  const visit = (candidate: SceneNode): void => {
    if (candidate.role === role) {
      collected.push(candidate);
    }
    if (candidate.kind === "group") {
      for (const child of candidate.children) {
        visit(child);
      }
    }
  };
  visit(node);
  return collected;
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

function pointInBounds(point: ScenePoint, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function distance(left: ScenePoint, right: ScenePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function requireBounds(node: SceneNode, message: string): Bounds {
  const bounds = nodeBounds(node);
  if (bounds === undefined) {
    throw new TransformsRenderError("INVALID_SCENE", message);
  }
  return bounds;
}

function requireNode(byId: ReadonlyMap<string, SceneNode>, id: string): SceneNode {
  const node = byId.get(id);
  if (node === undefined) {
    throw new TransformsRenderError("INVALID_SCENE", `transform scene is missing ${id}`);
  }
  return node;
}

function gridPixelSize(
  byId: ReadonlyMap<string, SceneNode>,
  gridId: string,
): { readonly width: number; readonly height: number } {
  const first = byId.get(`${gridId}-cell-0-0`);
  const last = byId.get(`${gridId}-cell-4-4`);
  if (first === undefined || last === undefined) {
    throw new TransformsRenderError(
      "WRONG_GEOMETRY",
      `${gridId} is missing a corner cell`,
    );
  }
  const firstBounds = requireBounds(first, `${gridId} corner cell has no bounds`);
  const lastBounds = requireBounds(last, `${gridId} corner cell has no bounds`);
  return {
    width: lastBounds.x + lastBounds.width - firstBounds.x,
    height: lastBounds.y + lastBounds.height - firstBounds.y,
  };
}

function assertGridGeometry(
  byId: ReadonlyMap<string, SceneNode>,
  gridId: string,
  cells: readonly TransformCell[],
  container: Bounds,
): void {
  const grid = requireNode(byId, gridId);
  if (grid.kind !== "group") {
    throw new TransformsRenderError("WRONG_GEOMETRY", `${gridId} is not a group`);
  }
  const gridBounds = requireBounds(grid, `${gridId} has no bounds`);
  if (!boundsContain(container, gridBounds)) {
    throw new TransformsRenderError("CLIPPED_GRID", `${gridId} is clipped by its panel`);
  }
  const first = byId.get(`${gridId}-cell-0-0`);
  const last = byId.get(`${gridId}-cell-4-4`);
  if (first === undefined || last === undefined) {
    throw new TransformsRenderError(
      "WRONG_GEOMETRY",
      `${gridId} is missing a corner cell`,
    );
  }
  const firstBounds = requireBounds(first, `${gridId} corner cell has no bounds`);
  const gridX = firstBounds.x;
  const gridY = firstBounds.y;
  const size = gridPixelSize(byId, gridId);
  if (
    Math.abs(size.width - TRANSFORM_RENDER_GRID_SIZE) > 1 ||
    Math.abs(size.height - TRANSFORM_RENDER_GRID_SIZE) > 1
  ) {
    throw new TransformsRenderError(
      "WRONG_GEOMETRY",
      `${gridId} does not use the fixed 160px grid scale`,
    );
  }
  const occupied = new Set(cells.map((cell) => `${cell.row}:${cell.column}`));
  const expectedIds = new Set<string>();
  for (let row = 0; row < TRANSFORM_GRID_SIZE; row += 1) {
    for (let column = 0; column < TRANSFORM_GRID_SIZE; column += 1) {
      const id = `${gridId}-cell-${row}-${column}`;
      expectedIds.add(id);
      const cell = byId.get(id);
      if (cell === undefined || cell.kind !== "rect" || cell.role !== "grid-cell") {
        throw new TransformsRenderError(
          "WRONG_GEOMETRY",
          `${gridId} is missing grid cell ${row},${column}`,
        );
      }
      const bounds = requireBounds(cell, `${id} has no bounds`);
      const expectedX = gridX + column * TRANSFORM_CELL_STRIDE;
      const expectedY = gridY + row * TRANSFORM_CELL_STRIDE;
      if (
        Math.abs(bounds.x - expectedX) > 1 ||
        Math.abs(bounds.y - expectedY) > 1 ||
        Math.abs(bounds.width - TRANSFORM_CELL_SIZE) > 1 ||
        Math.abs(bounds.height - TRANSFORM_CELL_SIZE) > 1
      ) {
        throw new TransformsRenderError(
          "WRONG_GEOMETRY",
          `${gridId} cell ${row},${column} is not at its fixed position`,
        );
      }
      if (!boundsContain(gridBounds, bounds)) {
        throw new TransformsRenderError("CLIPPED_GRID", `${id} is clipped`);
      }
      const expectedFill = occupied.has(`${row}:${column}`)
        ? SCENE_INK
        : SCENE_PANEL;
      if (cell.fill !== expectedFill) {
        throw new TransformsRenderError(
          "WRONG_GEOMETRY",
          `${gridId} cell ${row},${column} has the wrong occupancy`,
        );
      }
    }
  }
  const gridCells = collectByRole(grid, "grid-cell");
  if (
    gridCells.length !== TRANSFORM_GRID_SIZE * TRANSFORM_GRID_SIZE ||
    gridCells.some((cell) => !expectedIds.has(cell.id))
  ) {
    throw new TransformsRenderError(
      "WRONG_GEOMETRY",
      `${gridId} does not contain exactly 25 fixed cells`,
    );
  }
  const pivots = collectByRole(grid, "pivot");
  const pivot = pivots[0];
  if (pivots.length !== 1 || pivot === undefined || pivot.id !== `${gridId}-pivot`) {
    throw new TransformsRenderError(
      "OFF_CENTER_PIVOT",
      `${gridId} must have exactly one center pivot marker`,
    );
  }
  const pivotBounds = requireBounds(pivot, `${gridId} pivot has no bounds`);
  if (pivot.kind !== "group") {
    throw new TransformsRenderError(
      "OFF_CENTER_PIVOT",
      `${gridId} pivot marker is not a group`,
    );
  }
  const pivotCenter = {
    x: pivotBounds.x + pivotBounds.width / 2,
    y: pivotBounds.y + pivotBounds.height / 2,
  };
  const expectedPivotCenter = {
    x: gridX + TRANSFORM_RENDER_GRID_SIZE / 2,
    y: gridY + TRANSFORM_RENDER_GRID_SIZE / 2,
  };
  if (distance(pivotCenter, expectedPivotCenter) > 2) {
    throw new TransformsRenderError(
      "OFF_CENTER_PIVOT",
      `${gridId} pivot is not at the center cell`,
    );
  }
  const halos = collectByRole(pivot, "pivot-halo");
  const rings = collectByRole(pivot, "pivot-ring");
  const halo = halos[0];
  const ring = rings[0];
  if (
    halos.length !== 1 ||
    halo === undefined ||
    halo.kind !== "circle" ||
    halo.fill !== SCENE_BACKGROUND
  ) {
    throw new TransformsRenderError(
      "INVISIBLE_MARKER",
      `${gridId} pivot halo is missing or invisible`,
    );
  }
  if (
    rings.length !== 1 ||
    ring === undefined ||
    ring.kind !== "circle" ||
    ring.stroke !== SCENE_INK ||
    ring.strokeWidth === undefined ||
    ring.strokeWidth < 4
  ) {
    throw new TransformsRenderError(
      "INVISIBLE_MARKER",
      `${gridId} pivot ring is missing or invisible`,
    );
  }
  if (
    distance({ x: halo.cx, y: halo.cy }, expectedPivotCenter) > 2 ||
    distance({ x: ring.cx, y: ring.cy }, expectedPivotCenter) > 2
  ) {
    throw new TransformsRenderError(
      "OFF_CENTER_PIVOT",
      `${gridId} pivot circles are not at the center cell`,
    );
  }
  const haloIndex = pivot.children.findIndex((child) => child.id === halo.id);
  const ringIndex = pivot.children.findIndex((child) => child.id === ring.id);
  if (haloIndex < 0 || ringIndex < 0 || ringIndex <= haloIndex) {
    throw new TransformsRenderError(
      "INVISIBLE_MARKER",
      `${gridId} pivot ring must be painted after its halo`,
    );
  }
  const orientations = collectByRole(grid, "orientation");
  const orientation = orientations[0];
  if (
    orientations.length !== 1 ||
    orientation === undefined ||
    orientation.id !== `${gridId}-orientation` ||
    orientation.kind !== "polygon"
  ) {
    throw new TransformsRenderError(
      "MISSING_ORIENTATION",
      `${gridId} must have exactly one top orientation marker`,
    );
  }
  const orientationBounds = requireBounds(
    orientation,
    `${gridId} orientation marker has no bounds`,
  );
  if (orientation.fill !== SCENE_INK) {
    throw new TransformsRenderError(
      "INVISIBLE_MARKER",
      `${gridId} orientation marker is invisible`,
    );
  }
  if (
    Math.abs(
      orientationBounds.x + orientationBounds.width / 2 -
        (gridX + TRANSFORM_RENDER_GRID_SIZE / 2),
    ) > 2 ||
    Math.abs(orientationBounds.y + orientationBounds.height - (gridY - 4)) > 2
  ) {
    throw new TransformsRenderError(
      "MISSING_ORIENTATION",
      `${gridId} orientation marker is not at the top center`,
    );
  }
  const points = orientation.points;
  if (points.length !== 3) {
    throw new TransformsRenderError(
      "MISSING_ORIENTATION",
      `${gridId} orientation marker has the wrong shape`,
    );
  }
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const apex = points.filter((point) => point.y === minY);
  if (maxY - minY < 8 || apex.length !== 1 || apex[0] === undefined) {
    throw new TransformsRenderError(
      "MISSING_ORIENTATION",
      `${gridId} orientation marker does not point up`,
    );
  }
  if (
    Math.abs(apex[0].x - (gridX + TRANSFORM_RENDER_GRID_SIZE / 2)) > 2 ||
    apex[0].y >= maxY
  ) {
    throw new TransformsRenderError(
      "MISSING_ORIENTATION",
      `${gridId} orientation marker does not point up`,
    );
  }
  if (!boundsContain(container, orientationBounds)) {
    throw new TransformsRenderError("CLIPPED_GRID", `${gridId} orientation marker is clipped`);
  }
}

function assertSameGridScale(
  byId: ReadonlyMap<string, SceneNode>,
  choices: readonly NormalizedTransformsChoice[],
): void {
  const source = gridPixelSize(byId, "source-grid");
  for (const choice of choices) {
    const option = gridPixelSize(byId, `option-${choice.label}-grid`);
    if (
      Math.abs(option.width - source.width) > 1 ||
      Math.abs(option.height - source.height) > 1
    ) {
      throw new TransformsRenderError(
        "WRONG_GEOMETRY",
        "source and option grids must use the same scale",
      );
    }
  }
}

function assertClockwiseArrowGeometry(
  arrow: SceneNode,
  center: ScenePoint,
  radius: number,
  angleDegrees: 90 | 180 | 270,
  container: Bounds,
): void {
  if (arrow.kind !== "group" || arrow.role !== "rotation-arrow") {
    throw new TransformsRenderError("REVERSED_ARROW", "rotation arrow is not a group");
  }
  const arc = collectByRole(arrow, "arrow-arc")[0];
  const head = collectByRole(arrow, "arrow-head")[0];
  if (
    arc === undefined ||
    arc.kind !== "polyline" ||
    head === undefined ||
    head.kind !== "polygon"
  ) {
    throw new TransformsRenderError("MISSING_OPERATION", "rotation arrow is incomplete");
  }
  const points = arc.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 3) {
    throw new TransformsRenderError("REVERSED_ARROW", "rotation arrow has no arc");
  }
  const expectedStart = { x: center.x, y: center.y - radius };
  const endTheta = ((-90 + angleDegrees) * Math.PI) / 180;
  const expectedEnd = {
    x: center.x + radius * Math.cos(endTheta),
    y: center.y + radius * Math.sin(endTheta),
  };
  if (
    distance(first, expectedStart) > 6 ||
    distance(last, expectedEnd) > 6
  ) {
    throw new TransformsRenderError(
      "REVERSED_ARROW",
      "rotation arrow does not follow the declared clockwise angle",
    );
  }
  let swept = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (current === undefined || next === undefined) {
      throw new TransformsRenderError("REVERSED_ARROW", "rotation arrow has a broken arc");
    }
    if (Math.abs(distance(current, center) - radius) > 1.5) {
      throw new TransformsRenderError(
        "REVERSED_ARROW",
        "rotation arrow leaves its declared radius",
      );
    }
    const currentVector = {
      x: current.x - center.x,
      y: current.y - center.y,
    };
    const nextVector = {
      x: next.x - center.x,
      y: next.y - center.y,
    };
    const cross =
      currentVector.x * nextVector.y - currentVector.y * nextVector.x;
    const dot =
      currentVector.x * nextVector.x + currentVector.y * nextVector.y;
    const step = Math.atan2(cross, dot);
    if (step <= 0 || step > Math.PI / 6 + 1e-9) {
      throw new TransformsRenderError(
        "REVERSED_ARROW",
        "rotation arrow does not follow the declared clockwise arc",
      );
    }
    swept += step;
  }
  if (Math.abs(distance(last, center) - radius) > 1.5) {
    throw new TransformsRenderError(
      "REVERSED_ARROW",
      "rotation arrow leaves its declared radius",
    );
  }
  const expectedSweep = (angleDegrees * Math.PI) / 180;
  if (Math.abs(swept - expectedSweep) > (5 * Math.PI) / 180) {
    throw new TransformsRenderError(
      "REVERSED_ARROW",
      "rotation arrow does not cover the declared angle",
    );
  }
  const headBounds = requireBounds(head, "rotation arrow head has no bounds");
  const headCenter = {
    x: headBounds.x + headBounds.width / 2,
    y: headBounds.y + headBounds.height / 2,
  };
  if (distance(headCenter, expectedEnd) > 16) {
    throw new TransformsRenderError(
      "REVERSED_ARROW",
      "rotation arrow head is at the wrong end",
    );
  }
  const tangent = { x: -Math.sin(endTheta), y: Math.cos(endTheta) };
  const expectedTip = {
    x: last.x + tangent.x * 10,
    y: last.y + tangent.y * 10,
  };
  let tip: ScenePoint | undefined;
  let tipDistance = -1;
  for (const point of head.points) {
    const candidateDistance = distance(point, last);
    if (candidateDistance > tipDistance) {
      tip = point;
      tipDistance = candidateDistance;
    }
  }
  if (tip === undefined || distance(tip, expectedTip) > 4) {
    throw new TransformsRenderError(
      "REVERSED_ARROW",
      "rotation arrow head points backwards",
    );
  }
  for (const point of points) {
    if (!pointInBounds(point, container)) {
      throw new TransformsRenderError("CLIPPED_GRID", "rotation arrow is clipped");
    }
  }
  if (!boundsContain(container, headBounds)) {
    throw new TransformsRenderError("CLIPPED_GRID", "rotation arrow head is clipped");
  }
}

function assertMirrorAxis(
  axis: SceneNode,
  cardBounds: Bounds,
  operation: D4Operation,
): void {
  if (
    axis.kind !== "line" ||
    axis.role !== "mirror-axis" ||
    axis.stroke !== SCENE_INK ||
    axis.strokeWidth === undefined ||
    axis.strokeWidth < 4
  ) {
    throw new TransformsRenderError("WRONG_AXIS", "mirror axis is missing or styled wrong");
  }
  const midpoint = {
    x: (axis.x1 + axis.x2) / 2,
    y: (axis.y1 + axis.y2) / 2,
  };
  if (
    distance(midpoint, {
      x: cardBounds.x + OPERATION_ICON.x,
      y: cardBounds.y + OPERATION_ICON.y,
    }) > 8
  ) {
    throw new TransformsRenderError("WRONG_AXIS", "mirror axis is not centered in its card");
  }
  const dx = axis.x2 - axis.x1;
  const dy = axis.y2 - axis.y1;
  const vertical = Math.abs(dx) <= 2 && Math.abs(dy) >= 40;
  const horizontal = Math.abs(dy) <= 2 && Math.abs(dx) >= 40;
  const mainDiagonal =
    Math.abs(dx) >= 40 && Math.abs(dy) >= 40 && dx * dy > 0;
  const antiDiagonal =
    Math.abs(dx) >= 40 && Math.abs(dy) >= 40 && dx * dy < 0;
  const matches =
    (operation === "reflectLeftRight" && vertical) ||
    (operation === "reflectTopBottom" && horizontal) ||
    (operation === "reflectMainDiagonal" && mainDiagonal) ||
    (operation === "reflectAntiDiagonal" && antiDiagonal);
  if (!matches) {
    throw new TransformsRenderError(
      "WRONG_AXIS",
      `mirror axis does not match ${operation}`,
    );
  }
  if (
    !pointInBounds({ x: axis.x1, y: axis.y1 }, cardBounds) ||
    !pointInBounds({ x: axis.x2, y: axis.y2 }, cardBounds)
  ) {
    throw new TransformsRenderError("CLIPPED_GRID", "mirror axis is clipped");
  }
}

function assertOperationSequence(
  byId: ReadonlyMap<string, SceneNode>,
  operations: readonly D4Operation[],
  container: Bounds,
): void {
  const group = byId.get("operation-sequence");
  if (group === undefined) {
    throw new TransformsRenderError("MISSING_OPERATION", "operation sequence is absent");
  }
  const groupBounds = requireBounds(group, "operation sequence has no bounds");
  if (!boundsContain(container, groupBounds)) {
    throw new TransformsRenderError("CLIPPED_GRID", "operation sequence is clipped");
  }
  const texts = collectTexts(group).map((text) => text.text);
  if (!texts.includes("Operations apply in order.")) {
    throw new TransformsRenderError(
      "MISSING_OPERATION",
      "operation sequence does not state its order",
    );
  }
  const cards = collectByRole(group, "operation");
  if (cards.length < operations.length) {
    throw new TransformsRenderError("MISSING_OPERATION", "an operation card is absent");
  }
  if (cards.length > operations.length) {
    throw new TransformsRenderError(
      "INVALID_SCENE",
      "operation sequence contains an extra card",
    );
  }
  const cardBoundsList: Bounds[] = [];
  for (const [index, operation] of operations.entries()) {
    const id = `operation-op${index}`;
    const card = byId.get(id);
    if (card === undefined) {
      throw new TransformsRenderError("MISSING_OPERATION", `operation ${id} is absent`);
    }
    const cardBounds = requireBounds(card, `${id} has no bounds`);
    if (!boundsContain(container, cardBounds)) {
      throw new TransformsRenderError("CLIPPED_GRID", `${id} is clipped`);
    }
    cardBoundsList.push(cardBounds);
    const cardTexts = collectTexts(card).map((text) => text.text);
    const expectedNumber = String(index + 1);
    const expectedWord = index === 0 ? "First" : "Then";
    const wrongWord = index === 0 ? "Then" : "First";
    if (
      !cardTexts.includes(expectedNumber) ||
      !cardTexts.includes(expectedWord) ||
      cardTexts.includes(wrongWord)
    ) {
      throw new TransformsRenderError(
        "REVERSED_ORDER",
        `${id} does not show its declared order`,
      );
    }
    const visual = operationVisual(operation);
    if (!cardTexts.includes(visual.title) || !cardTexts.includes(visual.subtitle)) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `${id} does not state its operation clearly`,
      );
    }
    if (visual.kind === "rotation") {
      const arrow = byId.get(`${id}-rotation-arrow`);
      if (arrow === undefined) {
        throw new TransformsRenderError(
          "MISSING_OPERATION",
          `${id} has no rotation arrow`,
        );
      }
      assertClockwiseArrowGeometry(
        arrow,
        {
          x: cardBounds.x + OPERATION_ICON.x,
          y: cardBounds.y + OPERATION_ICON.y,
        },
        OPERATION_ICON.radius,
        visual.angle,
        cardBounds,
      );
      if (byId.has(`${id}-mirror-axis`) || byId.has(`${id}-identity-mark`)) {
        throw new TransformsRenderError(
          "DECORATIVE_ROTATION",
          `${id} mixes rotation with another operation icon`,
        );
      }
    } else if (visual.kind === "reflection") {
      const axis = byId.get(`${id}-mirror-axis`);
      if (axis === undefined) {
        throw new TransformsRenderError(
          "MISSING_OPERATION",
          `${id} has no mirror axis`,
        );
      }
      assertMirrorAxis(axis, cardBounds, visual.operation);
      if (byId.has(`${id}-rotation-arrow`) || byId.has(`${id}-identity-mark`)) {
        throw new TransformsRenderError(
          "DECORATIVE_ROTATION",
          `${id} mixes a mirror with another operation icon`,
        );
      }
    } else {
      const mark = byId.get(`${id}-identity-mark`);
      if (mark === undefined || mark.kind !== "text" || mark.text !== "=") {
        throw new TransformsRenderError(
          "MISSING_OPERATION",
          `${id} has no identity mark`,
        );
      }
      if (byId.has(`${id}-rotation-arrow`) || byId.has(`${id}-mirror-axis`)) {
        throw new TransformsRenderError(
          "DECORATIVE_ROTATION",
          `${id} mixes identity with another operation icon`,
        );
      }
    }
  }
  for (let left = 0; left < cardBoundsList.length; left += 1) {
    for (let right = left + 1; right < cardBoundsList.length; right += 1) {
      const first = cardBoundsList[left];
      const second = cardBoundsList[right];
      if (first !== undefined && second !== undefined && boundsOverlap(first, second)) {
        throw new TransformsRenderError("OVERLAP", "operation cards overlap");
      }
    }
  }
}

function assertAxisLegend(
  byId: ReadonlyMap<string, SceneNode>,
  container: Bounds,
): void {
  const group = byId.get("axis-legend");
  if (group === undefined) {
    throw new TransformsRenderError("MISSING_AXIS", "axis legend is absent");
  }
  const groupBounds = requireBounds(group, "axis legend has no bounds");
  if (!boundsContain(container, groupBounds)) {
    throw new TransformsRenderError("CLIPPED_GRID", "axis legend is clipped");
  }
  const texts = collectTexts(group).map((text) => text.text);
  for (const required of [
    "Viewer-relative axes and clockwise direction.",
    "Axes: top = up, right = right.",
    "Clockwise: top, right, bottom, left.",
    "Pivot: center (2,2); top marker = up.",
  ]) {
    if (!texts.includes(required)) {
      throw new TransformsRenderError(
        "MISSING_AXIS",
        `axis legend is missing: ${required}`,
      );
    }
  }
  const arrows = collectByRole(group, "rotation-arrow");
  const arrow = arrows[0];
  if (arrows.length !== 1 || arrow === undefined || arrow.id !== "axis-clockwise-arrow") {
    throw new TransformsRenderError(
      "MISSING_AXIS",
      "axis legend must contain one clockwise arrow",
    );
  }
  assertClockwiseArrowGeometry(
    arrow,
    { x: AXIS_ARROW.x, y: AXIS_ARROW.y },
    AXIS_ARROW.radius,
    270,
    container,
  );
}

function assertNoDecorativeTransforms(
  nodes: readonly SceneNode[],
  operations: readonly D4Operation[],
): void {
  const allowed = new Set<string>(["axis-clockwise-arrow"]);
  for (const [index, operation] of operations.entries()) {
    const visual = operationVisual(operation);
    if (visual.kind === "rotation") {
      allowed.add(`operation-op${index}-rotation-arrow`);
    } else if (visual.kind === "reflection") {
      allowed.add(`operation-op${index}-mirror-axis`);
    } else {
      allowed.add(`operation-op${index}-identity-mark`);
    }
  }
  for (const node of nodes) {
    if (
      (node.role === "rotation-arrow" ||
        node.role === "mirror-axis" ||
        node.role === "identity-mark") &&
      !allowed.has(node.id)
    ) {
      throw new TransformsRenderError(
        "DECORATIVE_ROTATION",
        `decorative transform icon ${node.id} is outside the formal operation`,
      );
    }
  }
}

export function assertTransformsScene(
  scene: Scene,
  spec: TransformsSpec,
  choices: readonly TransformsChoiceInput[],
): void {
  assertScene(scene);
  const parsed = TransformsSpecSchema.parse(spec);
  const normalized = validateChoices(parsed, choices);
  const all = collectNodes(scene.nodes);
  const byId = new Map(all.map((node) => [node.id, node]));
  for (const critical of TRANSFORMS_CRITICAL_GROUPS) {
    if (!byId.has(critical)) {
      if (critical === "axis-legend") {
        throw new TransformsRenderError("MISSING_AXIS", "axis legend is absent");
      }
      throw new TransformsRenderError(
        "MISSING_CRITICAL_GROUP",
        `transform scene is missing critical group ${critical}`,
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
  const source = sourceCellsFromGrid(parsed.source);
  assertGridGeometry(byId, "source-grid", source, stemPanel);
  assertOperationSequence(byId, parsed.operations, stemPanel);
  assertAxisLegend(byId, legendPanel);
  assertNoDecorativeTransforms(all, parsed.operations);
  for (const choice of normalized) {
    const tile = byId.get(`option-${choice.label}-tile`);
    if (tile === undefined) {
      throw new TransformsRenderError(
        "INVALID_SCENE",
        `option ${choice.label} has no tile`,
      );
    }
    const tileBounds = requireBounds(tile, `option ${choice.label} tile has no bounds`);
    assertGridGeometry(
      byId,
      `option-${choice.label}-grid`,
      choice.cells,
      tileBounds,
    );
  }
  assertSameGridScale(byId, normalized);
}

export const transformsRenderer = {
  family: "transforms" as const,
  version: "transforms-v1",
  buildScene(spec: TransformsSpec, optionsSeed?: string): Scene {
    return buildTransformsScene(spec, undefined, optionsSeed);
  },
  assertScene(scene: Scene, spec: TransformsSpec, choices: unknown): void {
    assertTransformsScene(
      scene,
      spec,
      (choices as ChoiceSet<TransformAnswer>).choices.map((choice) => ({
        label: choice.label,
        cells: choice.value,
      })),
    );
  },
};

export type TransformsRenderer = typeof transformsRenderer;
