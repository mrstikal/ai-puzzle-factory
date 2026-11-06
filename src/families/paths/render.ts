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
  type SceneCircle,
  type SceneGroup,
  type SceneLine,
  type SceneNode,
  type ScenePoint,
  type ScenePolyline,
  type SceneRect,
  type SceneText,
} from "../../render/scene.js";
import { pathsEngine } from "./engine.js";
import {
  PATH_GRID_SIZE,
  PathRouteSchema,
  PathsSpecSchema,
  checkPathAnswer,
  findTreeRoute,
  openEdgeKey,
  pathCellKey,
  pathEdgeKey,
  pathRouteKey,
  routeUsesClosedCorridor,
  samePathCell,
  type PathCell,
  type PathRoute,
  type PathsSpec,
} from "./schema.js";

export const PATH_CELL_SIZE = 40;
export const PATH_RENDER_GRID_SIZE = PATH_GRID_SIZE * PATH_CELL_SIZE;
export const PATH_BLOCKED_FILL = "#cfcfcf";
export const PATH_BLOCKED_INK = "#666666";
export const PATH_ROUTE_INK = "#0055cc";
export const PATH_WALL_STROKE = 8;
export const PATH_ROUTE_STROKE = 8;
export const PATH_ROUTE_HALO_STROKE = 16;
export const PATH_MARKER_RADIUS = 18;

const STEM_PANEL = { x: 32, y: 24, width: 960, height: 380 } as const;
const LEGEND_PANEL = { x: 32, y: 420, width: 960, height: 180 } as const;
const SOURCE_GRID = { x: 64, y: 132 } as const;
const OPTION_TILE = { width: 448, height: 196 } as const;
const OPTION_GRID_OFFSET = { x: 16, y: 28 } as const;
const OPTION_POSITIONS = [
  { x: 32, y: 612 },
  { x: 512, y: 612 },
  { x: 32, y: 820 },
  { x: 512, y: 820 },
] as const;

export const PATHS_CRITICAL_GROUPS = [
  "source-maze",
  "wall-legend",
  "option-A-maze",
  "option-B-maze",
  "option-C-maze",
  "option-D-maze",
] as const;
export type PathsCriticalGroup = (typeof PATHS_CRITICAL_GROUPS)[number];

export type PathsRenderErrorCode =
  | "INVALID_SCENE"
  | "MISSING_CRITICAL_GROUP"
  | "MISSING_WALL"
  | "UNEXPECTED_WALL"
  | "WALL_PAINT_ORDER"
  | "WRONG_GEOMETRY"
  | "CHANGED_MAZE"
  | "MISSING_ENDPOINT"
  | "WRONG_ENDPOINT"
  | "CLIPPED_ENDPOINT"
  | "MISSING_ROUTE"
  | "WRONG_ROUTE"
  | "ILLEGAL_DIAGONAL"
  | "CLIPPED_ROUTE"
  | "OPTION_NOT_DISTINCT"
  | "MISSING_LEGEND";

export class PathsRenderError extends Error {
  readonly code: PathsRenderErrorCode;

  constructor(code: PathsRenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathsRenderError";
    this.code = code;
  }
}

export interface PathsChoiceInput {
  readonly label: ChoiceLabel;
  readonly route: readonly PathCell[];
}

interface NormalizedPathsChoice {
  readonly label: ChoiceLabel;
  readonly route: PathRoute;
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
  const node: SceneRect = {
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
  return node;
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
  stroke = SCENE_INK,
  strokeWidth = PATH_WALL_STROKE,
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

function polylineNode(
  id: string,
  role: string,
  points: readonly ScenePoint[],
  stroke: string,
  strokeWidth: number,
): ScenePolyline {
  return {
    kind: "polyline",
    id,
    role,
    points,
    fill: "none",
    stroke,
    strokeWidth,
  };
}

function circleNode(
  id: string,
  role: string,
  cx: number,
  cy: number,
  radius: number,
  fill: string,
  stroke?: string,
  strokeWidth?: number,
): SceneCircle {
  const node: SceneCircle = {
    kind: "circle",
    id,
    role,
    cx,
    cy,
    r: radius,
    fill,
    ...(stroke !== undefined
      ? { stroke, strokeWidth: strokeWidth ?? 4 }
      : {}),
  };
  return node;
}

function cellCenter(gridX: number, gridY: number, cell: PathCell): ScenePoint {
  return {
    x: gridX + cell.column * PATH_CELL_SIZE + PATH_CELL_SIZE / 2,
    y: gridY + cell.row * PATH_CELL_SIZE + PATH_CELL_SIZE / 2,
  };
}

function buildEndpointMarker(
  mazeId: string,
  kind: "start" | "goal",
  cell: PathCell,
  gridX: number,
  gridY: number,
): SceneGroup {
  const center = cellCenter(gridX, gridY, cell);
  const id = `${mazeId}-${kind}-marker`;
  return {
    kind: "group",
    id,
    role: "endpoint-marker",
    children: [
      circleNode(
        `${id}-halo`,
        "endpoint-halo",
        center.x,
        center.y,
        PATH_MARKER_RADIUS,
        SCENE_BACKGROUND,
        SCENE_INK,
        4,
      ),
      textNode(
        `${id}-label`,
        "endpoint-label",
        center.x,
        center.y + 13,
        kind === "start" ? "S" : "G",
        32,
        "middle",
        "bold",
      ),
    ],
  };
}

function buildWalls(
  mazeId: string,
  activeKeys: ReadonlySet<string>,
  openEdges: ReadonlySet<string>,
  gridX: number,
  gridY: number,
): SceneGroup {
  const children: SceneNode[] = [
    rectNode(
      `${mazeId}-outer-wall`,
      "wall",
      gridX,
      gridY,
      PATH_RENDER_GRID_SIZE,
      PATH_RENDER_GRID_SIZE,
      "none",
      SCENE_INK,
      PATH_WALL_STROKE,
    ),
  ];
  for (let row = 0; row < PATH_GRID_SIZE; row += 1) {
    for (let column = 0; column < PATH_GRID_SIZE; column += 1) {
      if (column < PATH_GRID_SIZE - 1) {
        const left = { row, column };
        const right = { row, column: column + 1 };
        const open =
          activeKeys.has(pathCellKey(left)) &&
          activeKeys.has(pathCellKey(right)) &&
          openEdges.has(openEdgeKey(left, right));
        if (!open) {
          children.push(
            lineNode(
              `${mazeId}-wall-v-${row}-${column}`,
              "wall",
              gridX + (column + 1) * PATH_CELL_SIZE,
              gridY + row * PATH_CELL_SIZE,
              gridX + (column + 1) * PATH_CELL_SIZE,
              gridY + (row + 1) * PATH_CELL_SIZE,
            ),
          );
        }
      }
      if (row < PATH_GRID_SIZE - 1) {
        const top = { row, column };
        const bottom = { row: row + 1, column };
        const open =
          activeKeys.has(pathCellKey(top)) &&
          activeKeys.has(pathCellKey(bottom)) &&
          openEdges.has(openEdgeKey(top, bottom));
        if (!open) {
          children.push(
            lineNode(
              `${mazeId}-wall-h-${row}-${column}`,
              "wall",
              gridX + column * PATH_CELL_SIZE,
              gridY + (row + 1) * PATH_CELL_SIZE,
              gridX + (column + 1) * PATH_CELL_SIZE,
              gridY + (row + 1) * PATH_CELL_SIZE,
            ),
          );
        }
      }
    }
  }
  return { kind: "group", id: `${mazeId}-walls`, role: "walls", children };
}

function buildMaze(
  mazeId: string,
  role: "source-maze" | "option-maze",
  spec: PathsSpec,
  route: PathRoute | undefined,
  gridX: number,
  gridY: number,
): SceneGroup {
  const activeKeys = new Set(spec.active.map((cell) => pathCellKey(cell)));
  const openEdges = new Set(spec.edges.map((edge) => pathEdgeKey(edge)));
  const children: SceneNode[] = [];
  for (let row = 0; row < PATH_GRID_SIZE; row += 1) {
    for (let column = 0; column < PATH_GRID_SIZE; column += 1) {
      const x = gridX + column * PATH_CELL_SIZE;
      const y = gridY + row * PATH_CELL_SIZE;
      const active = activeKeys.has(`${row}:${column}`);
      children.push(
        rectNode(
          `${mazeId}-cell-${row}-${column}`,
          "maze-cell",
          x,
          y,
          PATH_CELL_SIZE,
          PATH_CELL_SIZE,
          active ? SCENE_PANEL : PATH_BLOCKED_FILL,
        ),
      );
      if (!active) {
        children.push(
          lineNode(
            `${mazeId}-hatch-${row}-${column}-a`,
            "blocked-hatch",
            x + 6,
            y + 6,
            x + PATH_CELL_SIZE - 6,
            y + PATH_CELL_SIZE - 6,
            PATH_BLOCKED_INK,
            4,
          ),
          lineNode(
            `${mazeId}-hatch-${row}-${column}-b`,
            "blocked-hatch",
            x + PATH_CELL_SIZE - 6,
            y + 6,
            x + 6,
            y + PATH_CELL_SIZE - 6,
            PATH_BLOCKED_INK,
            4,
          ),
        );
      }
    }
  }
  if (route !== undefined) {
    const points = route.map((cell) => cellCenter(gridX, gridY, cell));
    children.push({
      kind: "group",
      id: `${mazeId}-route`,
      role: "route",
      children: [
        polylineNode(
          `${mazeId}-route-halo`,
          "route-halo",
          points,
          SCENE_BACKGROUND,
          PATH_ROUTE_HALO_STROKE,
        ),
        polylineNode(
          `${mazeId}-route-line`,
          "route-line",
          points,
          PATH_ROUTE_INK,
          PATH_ROUTE_STROKE,
        ),
      ],
    });
  }
  children.push(buildWalls(mazeId, activeKeys, openEdges, gridX, gridY));
  children.push({
    kind: "group",
    id: `${mazeId}-markers`,
    role: "markers",
    children: [
      buildEndpointMarker(mazeId, "start", spec.start, gridX, gridY),
      buildEndpointMarker(mazeId, "goal", spec.goal, gridX, gridY),
    ],
  });
  return { kind: "group", id: mazeId, role, children };
}

function buildStem(spec: PathsSpec): SceneGroup {
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
        72,
        "Use only open corridors.",
        32,
        "start",
        "bold",
      ),
      textNode("source-label", "label", 64, 104, "Maze", 32, "start", "bold"),
      buildMaze(
        "source-maze",
        "source-maze",
        spec,
        undefined,
        SOURCE_GRID.x,
        SOURCE_GRID.y,
      ),
      textNode("source-note-1", "label", 64, 332, "S = start; G = goal."),
      textNode(
        "source-note-2",
        "label",
        64,
        372,
        "Thick black lines are walls.",
      ),
      textNode(
        "stem-note-1",
        "label",
        280,
        104,
        "Each choice uses the same maze.",
      ),
      textNode(
        "stem-note-2",
        "label",
        280,
        144,
        "One route is highlighted in blue.",
      ),
      textNode(
        "stem-note-3",
        "label",
        280,
        184,
        "Walls are drawn over routes.",
      ),
      textNode(
        "stem-note-4",
        "label",
        280,
        224,
        "Only gaps are open corridors.",
      ),
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
        SCENE_PANEL,
        SCENE_INK,
        4,
      ),
      {
        kind: "group",
        id: "wall-legend",
        role: "wall-legend",
        children: [
          textNode(
            "wall-legend-title",
            "label",
            64,
            468,
            "Wall and route convention",
            32,
            "start",
            "bold",
          ),
          textNode(
            "wall-legend-line-1",
            "label",
            64,
            510,
            "Thick black lines = walls.",
          ),
          textNode(
            "wall-legend-line-2",
            "label",
            64,
            552,
            "Gaps between cells = open corridors.",
          ),
          textNode(
            "wall-legend-line-3",
            "label",
            64,
            592,
            "Blue route; walls cover blocked crossings.",
          ),
        ],
      },
    ],
  };
}

function buildOption(
  spec: PathsSpec,
  choice: NormalizedPathsChoice,
  index: number,
): SceneGroup {
  const position = OPTION_POSITIONS[index];
  if (position === undefined) {
    throw new PathsRenderError(
      "INVALID_SCENE",
      `missing path option position ${index}`,
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
        SCENE_PANEL,
        SCENE_INK,
        4,
      ),
      buildMaze(
        `option-${choice.label}-maze`,
        "option-maze",
        spec,
        choice.route,
        position.x + OPTION_GRID_OFFSET.x,
        position.y + OPTION_GRID_OFFSET.y,
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
        "Same maze",
      ),
    ],
  };
}

function resolveChoices(
  spec: PathsSpec,
  choices: readonly PathsChoiceInput[] | undefined,
  optionsSeed?: string,
): readonly PathsChoiceInput[] {
  if (choices !== undefined) {
    return choices;
  }
  const correct = findTreeRoute(spec.active, spec.edges, spec.start, spec.goal);
  if (correct === undefined) {
    throw new PathsRenderError(
      "INVALID_SCENE",
      "path renderer could not recover the unique tree route",
    );
  }
  const set = pathsEngine.makeOptions(
    spec,
    correct,
    optionsSeed ?? hashCanonicalJson(spec),
  );
  return set.choices.map((choice) => ({
    label: choice.label,
    route: choice.value,
  }));
}

function validateChoices(
  spec: PathsSpec,
  choices: readonly PathsChoiceInput[],
  validation: "full" | "calibration" = "full",
): readonly NormalizedPathsChoice[] {
  if (choices.length !== 4 || choices.map((choice) => choice.label).join("") !== "ABCD") {
    throw new PathsRenderError(
      "INVALID_SCENE",
      "path renderer requires four ordered A-D choices",
    );
  }
  const normalized: NormalizedPathsChoice[] = [];
  for (const choice of choices) {
    const parsed = PathRouteSchema.safeParse(choice.route);
    if (!parsed.success) {
      throw new PathsRenderError(
        "INVALID_SCENE",
        `path choice ${choice.label} is not a simple orthogonally adjacent route`,
      );
    }
    const start = parsed.data[0];
    const goal = parsed.data[parsed.data.length - 1];
    if (
      start === undefined ||
      goal === undefined ||
      !samePathCell(start, spec.start) ||
      !samePathCell(goal, spec.goal)
    ) {
      throw new PathsRenderError(
        "WRONG_ROUTE",
        `path choice ${choice.label} does not start at S and end at G`,
      );
    }
    normalized.push({ label: choice.label, route: parsed.data });
  }
  if (validation === "full") {
    if (
      new Set(normalized.map((choice) => pathRouteKey(choice.route))).size !== 4
    ) {
      throw new PathsRenderError(
        "OPTION_NOT_DISTINCT",
        "path choices must be four distinct routes",
      );
    }
    const trueChoices = normalized.filter((choice) =>
      checkPathAnswer(spec, choice.route),
    );
    if (trueChoices.length !== 1) {
      throw new PathsRenderError(
        "INVALID_SCENE",
        `path choices must contain exactly one valid route, found ${trueChoices.length}`,
      );
    }
    for (const choice of normalized) {
      if (
        !checkPathAnswer(spec, choice.route) &&
        !routeUsesClosedCorridor(spec, choice.route)
      ) {
        throw new PathsRenderError(
          "INVALID_SCENE",
          `path choice ${choice.label} is neither valid nor visibly blocked`,
        );
      }
    }
  }
  return normalized;
}

export function buildPathsScene(
  spec: PathsSpec,
  choices?: readonly PathsChoiceInput[],
  optionsSeed?: string,
  validation: "full" | "calibration" = "full",
): Scene {
  const parsed = PathsSpecSchema.parse(spec);
  const resolved = resolveChoices(parsed, choices, optionsSeed);
  const normalized = validateChoices(parsed, resolved, validation);
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background: SCENE_BACKGROUND,
    title: "Paths and reachability",
    desc: "Use only open corridors and choose the complete start-to-goal route.",
    nodes: [
      buildStem(parsed),
      buildLegend(),
      ...normalized.map((choice, index) => buildOption(parsed, choice, index)),
    ],
  };
  if (validation === "calibration") {
    assertScene(scene);
  } else {
    assertPathsScene(scene, parsed, normalized);
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
    throw new PathsRenderError("INVALID_SCENE", `path scene is missing ${id}`);
  }
  return node;
}

function requireBounds(node: SceneNode, message: string): Bounds {
  const bounds = nodeBounds(node);
  if (bounds === undefined) {
    throw new PathsRenderError("INVALID_SCENE", message);
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

function expectedWalls(
  mazeId: string,
  spec: PathsSpec,
  gridX: number,
  gridY: number,
): ReadonlyMap<string, SceneLine> {
  const activeKeys = new Set(spec.active.map((cell) => pathCellKey(cell)));
  const openEdges = new Set(spec.edges.map((edge) => pathEdgeKey(edge)));
  const walls = new Map<string, SceneLine>();
  for (let row = 0; row < PATH_GRID_SIZE; row += 1) {
    for (let column = 0; column < PATH_GRID_SIZE; column += 1) {
      if (column < PATH_GRID_SIZE - 1) {
        const left = { row, column };
        const right = { row, column: column + 1 };
        const open =
          activeKeys.has(pathCellKey(left)) &&
          activeKeys.has(pathCellKey(right)) &&
          openEdges.has(openEdgeKey(left, right));
        if (!open) {
          const id = `${mazeId}-wall-v-${row}-${column}`;
          walls.set(
            id,
            lineNode(
              id,
              "wall",
              gridX + (column + 1) * PATH_CELL_SIZE,
              gridY + row * PATH_CELL_SIZE,
              gridX + (column + 1) * PATH_CELL_SIZE,
              gridY + (row + 1) * PATH_CELL_SIZE,
            ),
          );
        }
      }
      if (row < PATH_GRID_SIZE - 1) {
        const top = { row, column };
        const bottom = { row: row + 1, column };
        const open =
          activeKeys.has(pathCellKey(top)) &&
          activeKeys.has(pathCellKey(bottom)) &&
          openEdges.has(openEdgeKey(top, bottom));
        if (!open) {
          const id = `${mazeId}-wall-h-${row}-${column}`;
          walls.set(
            id,
            lineNode(
              id,
              "wall",
              gridX + column * PATH_CELL_SIZE,
              gridY + (row + 1) * PATH_CELL_SIZE,
              gridX + (column + 1) * PATH_CELL_SIZE,
              gridY + (row + 1) * PATH_CELL_SIZE,
            ),
          );
        }
      }
    }
  }
  return walls;
}

function assertMarker(
  byId: ReadonlyMap<string, SceneNode>,
  mazeId: string,
  kind: "start" | "goal",
  cell: PathCell,
  gridX: number,
  gridY: number,
  gridBounds: Bounds,
): void {
  const markerId = `${mazeId}-${kind}-marker`;
  const marker = byId.get(markerId);
  if (marker === undefined || marker.kind !== "group") {
    throw new PathsRenderError("MISSING_ENDPOINT", `${mazeId} is missing its ${kind} marker`);
  }
  const halo = byId.get(`${markerId}-halo`);
  if (
    halo === undefined ||
    halo.kind !== "circle" ||
    halo.role !== "endpoint-halo"
  ) {
    throw new PathsRenderError("MISSING_ENDPOINT", `${markerId} has no halo`);
  }
  const expectedCenter = cellCenter(gridX, gridY, cell);
  if (
    distance({ x: halo.cx, y: halo.cy }, expectedCenter) > 1 ||
    Math.abs(halo.r - PATH_MARKER_RADIUS) > 1
  ) {
    throw new PathsRenderError("WRONG_ENDPOINT", `${markerId} is not at its cell center`);
  }
  if (
    halo.fill !== SCENE_BACKGROUND ||
    halo.stroke !== SCENE_INK ||
    halo.strokeWidth === undefined ||
    halo.strokeWidth < 4
  ) {
    throw new PathsRenderError("WRONG_ENDPOINT", `${markerId} halo is not visible`);
  }
  const label = byId.get(`${markerId}-label`);
  const expectedText = kind === "start" ? "S" : "G";
  if (
    label === undefined ||
    label.kind !== "text" ||
    label.role !== "endpoint-label" ||
    label.text !== expectedText ||
    label.fontSize < 32
  ) {
    throw new PathsRenderError("MISSING_ENDPOINT", `${markerId} has no ${expectedText} label`);
  }
  if (
    label.anchor !== "middle" ||
    distance(
      { x: label.x, y: label.y },
      { x: expectedCenter.x, y: expectedCenter.y + 13 },
    ) > 1
  ) {
    throw new PathsRenderError(
      "WRONG_ENDPOINT",
      `${markerId} label is not centered in its cell`,
    );
  }
  const markerBounds = requireBounds(marker, `${markerId} has no bounds`);
  if (!boundsContain(gridBounds, markerBounds)) {
    throw new PathsRenderError(
      "CLIPPED_ENDPOINT",
      `${markerId} extends outside the maze grid`,
    );
  }
}

function assertRoute(
  byId: ReadonlyMap<string, SceneNode>,
  mazeId: string,
  route: PathRoute,
  gridX: number,
  gridY: number,
  gridBounds: Bounds,
  wallsIndex: number,
  maze: SceneGroup,
): void {
  const routeGroup = byId.get(`${mazeId}-route`);
  if (routeGroup === undefined || routeGroup.kind !== "group") {
    throw new PathsRenderError("MISSING_ROUTE", `${mazeId} has no route overlay`);
  }
  const routeIndex = maze.children.findIndex((child) => child.id === routeGroup.id);
  if (routeIndex < 0 || routeIndex >= wallsIndex) {
    throw new PathsRenderError(
      "WALL_PAINT_ORDER",
      `${mazeId} walls must be painted after the route`,
    );
  }
  const lines = collectByRole(routeGroup, "route-line");
  const halos = collectByRole(routeGroup, "route-halo");
  const line = lines[0];
  const halo = halos[0];
  if (
    lines.length !== 1 ||
    line === undefined ||
    line.kind !== "polyline" ||
    halos.length !== 1 ||
    halo === undefined ||
    halo.kind !== "polyline"
  ) {
    throw new PathsRenderError("WRONG_ROUTE", `${mazeId} route overlay is incomplete`);
  }
  if (
    line.stroke !== PATH_ROUTE_INK ||
    line.strokeWidth === undefined ||
    line.strokeWidth < PATH_ROUTE_STROKE ||
    halo.stroke !== SCENE_BACKGROUND ||
    halo.strokeWidth === undefined ||
    halo.strokeWidth < PATH_ROUTE_HALO_STROKE
  ) {
    throw new PathsRenderError("WRONG_ROUTE", `${mazeId} route styling is wrong`);
  }
  const expectedPoints = route.map((cell) => cellCenter(gridX, gridY, cell));
  if (halo.points.length !== line.points.length) {
    throw new PathsRenderError("WRONG_ROUTE", `${mazeId} route halo is misaligned`);
  }
  for (let index = 0; index < line.points.length - 1; index += 1) {
    const current = line.points[index];
    const next = line.points[index + 1];
    if (current === undefined || next === undefined) {
      throw new PathsRenderError("WRONG_ROUTE", `${mazeId} route has a broken segment`);
    }
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    if (dx !== 0 && dy !== 0) {
      throw new PathsRenderError(
        "ILLEGAL_DIAGONAL",
        `${mazeId} route contains a diagonal segment`,
      );
    }
    if (Math.abs(dx) + Math.abs(dy) !== PATH_CELL_SIZE) {
      throw new PathsRenderError(
        "WRONG_ROUTE",
        `${mazeId} route segment does not connect adjacent cell centers`,
      );
    }
  }
  if (line.points.length !== expectedPoints.length) {
    throw new PathsRenderError("WRONG_ROUTE", `${mazeId} route point count is wrong`);
  }
  for (const [index, point] of line.points.entries()) {
    const expected = expectedPoints[index];
    if (expected === undefined || distance(point, expected) > 1) {
      throw new PathsRenderError(
        "WRONG_ROUTE",
        `${mazeId} route point ${index} is not a cell center`,
      );
    }
    if (!pointInBounds(point, gridBounds)) {
      throw new PathsRenderError("CLIPPED_ROUTE", `${mazeId} route is clipped`);
    }
  }
  for (const [index, haloPoint] of halo.points.entries()) {
    const routePoint = line.points[index];
    if (routePoint === undefined || distance(haloPoint, routePoint) > 1) {
      throw new PathsRenderError(
        "WRONG_ROUTE",
        `${mazeId} route halo is not aligned with the route`,
      );
    }
  }
}

function assertMazeGeometry(
  byId: ReadonlyMap<string, SceneNode>,
  mazeId: string,
  spec: PathsSpec,
  route: PathRoute | undefined,
  container: Bounds,
): void {
  const maze = requireNode(byId, mazeId);
  if (maze.kind !== "group") {
    throw new PathsRenderError("WRONG_GEOMETRY", `${mazeId} is not a group`);
  }
  const mazeBounds = requireBounds(maze, `${mazeId} has no bounds`);
  if (!boundsContain(container, mazeBounds)) {
    throw new PathsRenderError("WRONG_GEOMETRY", `${mazeId} is clipped by its panel`);
  }
  const firstCell = requireNode(byId, `${mazeId}-cell-0-0`);
  const firstBounds = requireBounds(firstCell, `${mazeId} has no first cell`);
  const gridX = firstBounds.x;
  const gridY = firstBounds.y;
  const gridBounds: Bounds = {
    x: gridX,
    y: gridY,
    width: PATH_RENDER_GRID_SIZE,
    height: PATH_RENDER_GRID_SIZE,
  };
  const activeKeys = new Set(spec.active.map((cell) => pathCellKey(cell)));
  const expectedCellIds = new Set<string>();
  for (let row = 0; row < PATH_GRID_SIZE; row += 1) {
    for (let column = 0; column < PATH_GRID_SIZE; column += 1) {
      const id = `${mazeId}-cell-${row}-${column}`;
      expectedCellIds.add(id);
      const cell = byId.get(id);
      if (
        cell === undefined ||
        cell.kind !== "rect" ||
        cell.role !== "maze-cell"
      ) {
        throw new PathsRenderError("WRONG_GEOMETRY", `${mazeId} is missing cell ${row},${column}`);
      }
      const bounds = requireBounds(cell, `${id} has no bounds`);
      if (
        Math.abs(bounds.x - (gridX + column * PATH_CELL_SIZE)) > 1 ||
        Math.abs(bounds.y - (gridY + row * PATH_CELL_SIZE)) > 1 ||
        Math.abs(bounds.width - PATH_CELL_SIZE) > 1 ||
        Math.abs(bounds.height - PATH_CELL_SIZE) > 1
      ) {
        throw new PathsRenderError("WRONG_GEOMETRY", `${id} is not at its fixed position`);
      }
      const active = activeKeys.has(`${row}:${column}`);
      const expectedFill = active ? SCENE_PANEL : PATH_BLOCKED_FILL;
      if (cell.fill !== expectedFill) {
        throw new PathsRenderError("WRONG_GEOMETRY", `${id} has the wrong occupancy`);
      }
      const hatchA = byId.get(`${mazeId}-hatch-${row}-${column}-a`);
      const hatchB = byId.get(`${mazeId}-hatch-${row}-${column}-b`);
      if (active) {
        if (hatchA !== undefined || hatchB !== undefined) {
          throw new PathsRenderError("WRONG_GEOMETRY", `${id} has blocked hatching`);
        }
      } else if (
        hatchA === undefined ||
        hatchA.kind !== "line" ||
        hatchA.role !== "blocked-hatch" ||
        hatchA.stroke !== PATH_BLOCKED_INK ||
        hatchA.strokeWidth === undefined ||
        hatchA.strokeWidth < 4 ||
        hatchB === undefined ||
        hatchB.kind !== "line" ||
        hatchB.role !== "blocked-hatch"
      ) {
        throw new PathsRenderError("WRONG_GEOMETRY", `${id} is missing blocked hatching`);
      }
    }
  }
  const cells = collectByRole(maze, "maze-cell");
  if (
    cells.length !== PATH_GRID_SIZE * PATH_GRID_SIZE ||
    cells.some((cell) => !expectedCellIds.has(cell.id))
  ) {
    throw new PathsRenderError("WRONG_GEOMETRY", `${mazeId} does not contain 16 fixed cells`);
  }
  const outerWall = byId.get(`${mazeId}-outer-wall`);
  if (
    outerWall === undefined ||
    outerWall.kind !== "rect" ||
    outerWall.role !== "wall" ||
    outerWall.fill !== "none" ||
    outerWall.stroke !== SCENE_INK ||
    outerWall.strokeWidth === undefined ||
    outerWall.strokeWidth < PATH_WALL_STROKE
  ) {
    throw new PathsRenderError("MISSING_WALL", `${mazeId} outer wall is missing or invisible`);
  }
  const outerBounds = requireBounds(outerWall, `${mazeId} outer wall has no bounds`);
  if (
    Math.abs(outerBounds.x - gridX) > 1 ||
    Math.abs(outerBounds.y - gridY) > 1 ||
    Math.abs(outerBounds.width - PATH_RENDER_GRID_SIZE) > 1 ||
    Math.abs(outerBounds.height - PATH_RENDER_GRID_SIZE) > 1
  ) {
    throw new PathsRenderError("MISSING_WALL", `${mazeId} outer wall has the wrong geometry`);
  }
  const expected = expectedWalls(mazeId, spec, gridX, gridY);
  const actualWallLines = collectByRole(maze, "wall").filter(
    (node): node is SceneLine => node.kind === "line",
  );
  for (const [id, expectedWall] of expected) {
    const actual = byId.get(id);
    if (
      actual === undefined ||
      actual.kind !== "line" ||
      actual.role !== "wall" ||
      actual.stroke !== SCENE_INK ||
      actual.strokeWidth === undefined ||
      actual.strokeWidth < PATH_WALL_STROKE
    ) {
      throw new PathsRenderError("MISSING_WALL", `${id} is missing or invisible`);
    }
    if (
      distance({ x: actual.x1, y: actual.y1 }, { x: expectedWall.x1, y: expectedWall.y1 }) > 1 ||
      distance({ x: actual.x2, y: actual.y2 }, { x: expectedWall.x2, y: expectedWall.y2 }) > 1
    ) {
      throw new PathsRenderError("MISSING_WALL", `${id} has the wrong geometry`);
    }
  }
  for (const actual of actualWallLines) {
    if (!expected.has(actual.id)) {
      throw new PathsRenderError("UNEXPECTED_WALL", `${actual.id} is not a closed edge`);
    }
  }
  const wallsGroup = byId.get(`${mazeId}-walls`);
  if (wallsGroup === undefined || wallsGroup.kind !== "group") {
    throw new PathsRenderError("MISSING_WALL", `${mazeId} walls group is absent`);
  }
  const wallsIndex = maze.children.findIndex((child) => child.id === wallsGroup.id);
  if (wallsIndex < 0) {
    throw new PathsRenderError("MISSING_WALL", `${mazeId} walls group is misplaced`);
  }
  assertMarker(byId, mazeId, "start", spec.start, gridX, gridY, gridBounds);
  assertMarker(byId, mazeId, "goal", spec.goal, gridX, gridY, gridBounds);
  if (route === undefined) {
    if (byId.has(`${mazeId}-route`)) {
      throw new PathsRenderError("INVALID_SCENE", `${mazeId} must not have a route overlay`);
    }
  } else {
    assertRoute(byId, mazeId, route, gridX, gridY, gridBounds, wallsIndex, maze);
  }
}

function mazeSignature(
  byId: ReadonlyMap<string, SceneNode>,
  mazeId: string,
): string {
  const firstCell = byId.get(`${mazeId}-cell-0-0`);
  const firstBounds =
    firstCell === undefined ? undefined : nodeBounds(firstCell);
  if (firstBounds === undefined) {
    throw new PathsRenderError(
      "WRONG_GEOMETRY",
      `${mazeId} is missing its origin cell`,
    );
  }
  const gridX = firstBounds.x;
  const gridY = firstBounds.y;
  const cells: string[] = [];
  for (let row = 0; row < PATH_GRID_SIZE; row += 1) {
    for (let column = 0; column < PATH_GRID_SIZE; column += 1) {
      const cell = byId.get(`${mazeId}-cell-${row}-${column}`);
      cells.push(
        `${row}:${column}:${cell !== undefined && cell.kind === "rect" ? cell.fill : "missing"}`,
      );
    }
  }
  const walls = collectByRole(requireNode(byId, mazeId), "wall")
    .map((wall) => {
      const relativeId = wall.id.startsWith(`${mazeId}-`)
        ? wall.id.slice(mazeId.length + 1)
        : wall.id;
      if (wall.kind === "line") {
        return `${relativeId}:${wall.x1 - gridX},${wall.y1 - gridY},${wall.x2 - gridX},${wall.y2 - gridY}`;
      }
      if (wall.kind === "rect") {
        return `${relativeId}:${wall.x - gridX},${wall.y - gridY},${wall.width},${wall.height}`;
      }
      return `${relativeId}:${wall.kind}`;
    })
    .sort();
  const markers = (["start", "goal"] as const).map((kind) => {
    const markerId = `${mazeId}-${kind}-marker`;
    const halo = byId.get(`${markerId}-halo`);
    const label = byId.get(`${markerId}-label`);
    const haloPosition =
      halo !== undefined && halo.kind === "circle"
        ? `${halo.cx - gridX},${halo.cy - gridY}`
        : "missing";
    const labelPosition =
      label !== undefined && label.kind === "text"
        ? `${label.x - gridX},${label.y - gridY},${label.anchor ?? "missing"}`
        : "missing";
    return `${kind}:${haloPosition}:${
      label !== undefined && label.kind === "text" ? label.text : "missing"
    }:${labelPosition}`;
  });
  return JSON.stringify({ cells, walls, markers });
}

function assertWallLegend(
  byId: ReadonlyMap<string, SceneNode>,
  container: Bounds,
): void {
  const group = byId.get("wall-legend");
  if (group === undefined || group.kind !== "group") {
    throw new PathsRenderError("MISSING_LEGEND", "wall legend is absent");
  }
  const bounds = requireBounds(group, "wall legend has no bounds");
  if (!boundsContain(container, bounds)) {
    throw new PathsRenderError("MISSING_LEGEND", "wall legend is clipped");
  }
  const texts = collectTexts(group).map((text) => text.text);
  for (const required of [
    "Wall and route convention",
    "Thick black lines = walls.",
    "Gaps between cells = open corridors.",
    "Blue route; walls cover blocked crossings.",
  ]) {
    if (!texts.includes(required)) {
      throw new PathsRenderError("MISSING_LEGEND", `wall legend is missing: ${required}`);
    }
  }
}

export function assertPathsScene(
  scene: Scene,
  spec: PathsSpec,
  choices: readonly PathsChoiceInput[],
): void {
  assertScene(scene);
  const parsed = PathsSpecSchema.parse(spec);
  const normalized = validateChoices(parsed, choices);
  const all = collectNodes(scene.nodes);
  const byId = new Map(all.map((node) => [node.id, node]));
  for (const critical of PATHS_CRITICAL_GROUPS) {
    if (!byId.has(critical)) {
      if (critical === "wall-legend") {
        throw new PathsRenderError("MISSING_LEGEND", "wall legend is absent");
      }
      throw new PathsRenderError(
        "MISSING_CRITICAL_GROUP",
        `path scene is missing critical group ${critical}`,
      );
    }
  }
  const stemPanel = requireBounds(requireNode(byId, "stem-panel"), "stem panel has no bounds");
  const legendPanel = requireBounds(
    requireNode(byId, "legend-panel"),
    "legend panel has no bounds",
  );
  assertMazeGeometry(byId, "source-maze", parsed, undefined, stemPanel);
  const sourceSignature = mazeSignature(byId, "source-maze");
  for (const choice of normalized) {
    const tile = requireBounds(
      requireNode(byId, `option-${choice.label}-tile`),
      `option ${choice.label} tile has no bounds`,
    );
    const mazeId = `option-${choice.label}-maze`;
    if (mazeSignature(byId, mazeId) !== sourceSignature) {
      throw new PathsRenderError(
        "CHANGED_MAZE",
        `option ${choice.label} does not reuse the source maze`,
      );
    }
    assertMazeGeometry(byId, mazeId, parsed, choice.route, tile);
  }
  assertWallLegend(byId, legendPanel);
}

export const pathsRenderer = {
  family: "paths" as const,
  version: "paths-v1",
  buildScene(spec: PathsSpec, optionsSeed?: string): Scene {
    return buildPathsScene(spec, undefined, optionsSeed);
  },
  assertScene(scene: Scene, spec: PathsSpec, choices: unknown): void {
    assertPathsScene(
      scene,
      spec,
      (choices as ChoiceSet<PathRoute>).choices.map((choice) => ({
        label: choice.label,
        route: choice.value,
      })),
    );
  },
};

export type PathsRenderer = typeof pathsRenderer;
