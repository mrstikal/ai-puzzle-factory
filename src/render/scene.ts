export const SCENE_SIZE = 1024;
export const PREVIEW_SIZE = 512;
export const MIN_STROKE_WIDTH = 4;
export const MIN_ESSENTIAL_SIZE = 12;
export const MIN_LABEL_FONT_SIZE = 32;
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_ESSENTIAL_CONTRAST = 3;
export const FONT_FAMILY = "DejaVu Sans";
export const SCENE_BACKGROUND = "#ffffff";
export const SCENE_INK = "#111111";
export const SCENE_PANEL = "#f2f2f2";

export type SceneValidationErrorCode =
  | "INVALID_SCENE"
  | "INVALID_COLOR"
  | "DUPLICATE_ID"
  | "OUT_OF_BOUNDS"
  | "OVERLAP"
  | "CONTRAST"
  | "MISSING_OPTION"
  | "UNSAFE_NODE";

export class SceneValidationError extends Error {
  readonly code: SceneValidationErrorCode;

  constructor(
    code: SceneValidationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SceneValidationError";
    this.code = code;
  }
}

export interface SceneNodeBase {
  readonly id: string;
  readonly role?: string;
}

export interface SceneGroup extends SceneNodeBase {
  readonly kind: "group";
  readonly children: readonly SceneNode[];
}

export interface SceneRect extends SceneNodeBase {
  readonly kind: "rect";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx?: number;
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface SceneCircle extends SceneNodeBase {
  readonly kind: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface SceneLine extends SceneNodeBase {
  readonly kind: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface ScenePolyline extends SceneNodeBase {
  readonly kind: "polyline";
  readonly points: readonly ScenePoint[];
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface ScenePolygon extends SceneNodeBase {
  readonly kind: "polygon";
  readonly points: readonly ScenePoint[];
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface ScenePath extends SceneNodeBase {
  readonly kind: "path";
  readonly d: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface SceneText extends SceneNodeBase {
  readonly kind: "text";
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly fontSize: number;
  readonly fill: string;
  readonly anchor?: "start" | "middle" | "end";
  readonly fontWeight?: "normal" | "bold";
}

export type SceneNode =
  | SceneGroup
  | SceneRect
  | SceneCircle
  | SceneLine
  | ScenePolyline
  | ScenePolygon
  | ScenePath
  | SceneText;

export interface Scene {
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly title: string;
  readonly desc: string;
  readonly nodes: readonly SceneNode[];
}

export interface ScenePoint {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ParsedPathCommand {
  readonly command: "M" | "L" | "H" | "V" | "C" | "Q" | "Z";
  readonly args: readonly number[];
}

const PATH_COMMAND_ARITY: Readonly<Record<ParsedPathCommand["command"], number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  Q: 4,
  Z: 0,
};

export function parseSafePathData(d: string): readonly ParsedPathCommand[] {
  if (d.length === 0 || d.length > 5000) {
    throw new SceneValidationError("UNSAFE_NODE", "path data is empty or too long");
  }
  const tokens: Array<{ kind: "command"; value: ParsedPathCommand["command"] } | { kind: "number"; value: number }> = [];
  let index = 0;
  while (index < d.length) {
    const character = d[index];
    if (character === undefined) {
      break;
    }
    if (character === " " || character === "," || character === "\n" || character === "\t") {
      index += 1;
      continue;
    }
    if ("MLHVCQZ".includes(character)) {
      tokens.push({ kind: "command", value: character as ParsedPathCommand["command"] });
      index += 1;
      continue;
    }
    const match = /^-?(?:\d+(?:\.\d+)?|\.\d+)/.exec(d.slice(index));
    if (match === null) {
      throw new SceneValidationError(
        "UNSAFE_NODE",
        `unsupported path token at offset ${index}`,
      );
    }
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new SceneValidationError("UNSAFE_NODE", "path contains a non-finite number");
    }
    tokens.push({ kind: "number", value });
    index += match[0].length;
  }
  if (tokens.length === 0 || tokens[0]?.kind !== "command" || tokens[0].value !== "M") {
    throw new SceneValidationError("UNSAFE_NODE", "path must start with an absolute M command");
  }

  const commands: ParsedPathCommand[] = [];
  let tokenIndex = 0;
  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    if (token === undefined || token.kind !== "command") {
      throw new SceneValidationError("UNSAFE_NODE", "path command is missing");
    }
    const arity = PATH_COMMAND_ARITY[token.value];
    const args: number[] = [];
    tokenIndex += 1;
    for (let argument = 0; argument < arity; argument += 1) {
      const next = tokens[tokenIndex];
      if (next === undefined || next.kind !== "number") {
        throw new SceneValidationError(
          "UNSAFE_NODE",
          `path command ${token.value} has the wrong argument count`,
        );
      }
      args.push(next.value);
      tokenIndex += 1;
    }
    commands.push({ command: token.value, args });
  }
  return commands;
}

export function pathBounds(d: string): Bounds | undefined {
  const commands = parseSafePathData(d);
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const command of commands) {
    const args = command.args;
    if (command.command === "M" || command.command === "L") {
      const x = args[0];
      const y = args[1];
      if (x === undefined || y === undefined) {
        throw new SceneValidationError("UNSAFE_NODE", "path coordinate is missing");
      }
      currentX = x;
      currentY = y;
      if (command.command === "M") {
        startX = x;
        startY = y;
      }
      include(x, y);
    } else if (command.command === "H") {
      const x = args[0];
      if (x === undefined) {
        throw new SceneValidationError("UNSAFE_NODE", "path coordinate is missing");
      }
      currentX = x;
      include(currentX, currentY);
    } else if (command.command === "V") {
      const y = args[0];
      if (y === undefined) {
        throw new SceneValidationError("UNSAFE_NODE", "path coordinate is missing");
      }
      currentY = y;
      include(currentX, currentY);
    } else if (command.command === "C") {
      const [x1, y1, x2, y2, x, y] = args;
      if (
        x1 === undefined ||
        y1 === undefined ||
        x2 === undefined ||
        y2 === undefined ||
        x === undefined ||
        y === undefined
      ) {
        throw new SceneValidationError("UNSAFE_NODE", "path cubic coordinates are missing");
      }
      include(x1, y1);
      include(x2, y2);
      include(x, y);
      currentX = x;
      currentY = y;
    } else if (command.command === "Q") {
      const [x1, y1, x, y] = args;
      if (x1 === undefined || y1 === undefined || x === undefined || y === undefined) {
        throw new SceneValidationError("UNSAFE_NODE", "path quadratic coordinates are missing");
      }
      include(x1, y1);
      include(x, y);
      currentX = x;
      currentY = y;
    } else {
      currentX = startX;
      currentY = startY;
      include(currentX, currentY);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return undefined;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionBounds(left: Bounds | undefined, right: Bounds | undefined): Bounds | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

export function nodeBounds(node: SceneNode): Bounds | undefined {
  switch (node.kind) {
    case "group": {
      let bounds: Bounds | undefined;
      for (const child of node.children) {
        bounds = unionBounds(bounds, nodeBounds(child));
      }
      return bounds;
    }
    case "rect":
      return { x: node.x, y: node.y, width: node.width, height: node.height };
    case "circle":
      return {
        x: node.cx - node.r,
        y: node.cy - node.r,
        width: node.r * 2,
        height: node.r * 2,
      };
    case "line": {
      const x = Math.min(node.x1, node.x2);
      const y = Math.min(node.y1, node.y2);
      return {
        x,
        y,
        width: Math.abs(node.x2 - node.x1),
        height: Math.abs(node.y2 - node.y1),
      };
    }
    case "polyline":
    case "polygon": {
      if (node.points.length === 0) {
        return undefined;
      }
      const xs = node.points.map((point) => point.x);
      const ys = node.points.map((point) => point.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      };
    }
    case "path":
      return pathBounds(node.d);
    case "text": {
      const width = Math.max(node.text.length * node.fontSize * 0.6, node.fontSize * 0.6);
      const x =
        node.anchor === "middle"
          ? node.x - width / 2
          : node.anchor === "end"
            ? node.x - width
            : node.x;
      return {
        x,
        y: node.y - node.fontSize,
        width,
        height: node.fontSize * 1.2,
      };
    }
  }
}

export function sceneBounds(scene: Scene): Bounds | undefined {
  let bounds: Bounds | undefined;
  for (const node of scene.nodes) {
    bounds = unionBounds(bounds, nodeBounds(node));
  }
  return bounds;
}

export function parseHexColor(color: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color);
  if (match === null) {
    return undefined;
  }
  const digits = match[1];
  if (digits === undefined) {
    return undefined;
  }
  const expanded =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : digits;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundColor = parseHexColor(foreground);
  const backgroundColor = parseHexColor(background);
  if (foregroundColor === undefined || backgroundColor === undefined) {
    throw new SceneValidationError("INVALID_COLOR", "contrast colors must be hex colors");
  }
  const first = relativeLuminance(foregroundColor);
  const second = relativeLuminance(backgroundColor);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function assertContrast(
  foreground: string,
  background: string,
  minimum: number,
  context: string,
): void {
  const ratio = contrastRatio(foreground, background);
  if (ratio + 1e-9 < minimum) {
    throw new SceneValidationError(
      "CONTRAST",
      `${context} contrast ${ratio.toFixed(2)} is below ${minimum}:1`,
    );
  }
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

interface PaintedRect {
  readonly bounds: Bounds;
  readonly fill: string;
}

function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function backdropsFor(
  bounds: Bounds,
  paintedRects: readonly PaintedRect[],
  inherited: readonly string[],
): readonly string[] {
  for (let index = paintedRects.length - 1; index >= 0; index -= 1) {
    const painted = paintedRects[index];
    if (painted !== undefined && boundsContains(painted.bounds, bounds)) {
      return [painted.fill];
    }
  }
  const overlapping = paintedRects.filter((painted) =>
    boundsOverlap(painted.bounds, bounds),
  );
  if (overlapping.length === 0) {
    return inherited;
  }
  return [...new Set([...inherited, ...overlapping.map((painted) => painted.fill)])];
}

function assertNode(
  node: SceneNode,
  sceneBackground: string,
  ids: Set<string>,
  backdrops: readonly string[],
  paintedRects: readonly PaintedRect[],
): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id)) {
    throw new SceneValidationError("UNSAFE_NODE", `invalid scene node id ${node.id}`);
  }
  if (ids.has(node.id)) {
    throw new SceneValidationError("DUPLICATE_ID", `duplicate scene node id ${node.id}`);
  }
  ids.add(node.id);
  if (node.role !== undefined && !/^[a-z][a-z0-9-]*$/.test(node.role)) {
    throw new SceneValidationError("UNSAFE_NODE", `invalid scene role ${node.role}`);
  }
  const bounds = nodeBounds(node);
  if (bounds === undefined) {
    throw new SceneValidationError("INVALID_SCENE", `scene node ${node.id} has no bounds`);
  }
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > SCENE_SIZE ||
    bounds.y + bounds.height > SCENE_SIZE
  ) {
    throw new SceneValidationError(
      "OUT_OF_BOUNDS",
      `scene node ${node.id} is outside the 1024x1024 viewBox`,
    );
  }
  if ("stroke" in node && node.stroke !== undefined && node.stroke !== "none") {
    if (node.strokeWidth === undefined || node.strokeWidth < MIN_STROKE_WIDTH) {
      throw new SceneValidationError(
        "UNSAFE_NODE",
        `scene node ${node.id} has a stroke narrower than ${MIN_STROKE_WIDTH}`,
      );
    }
  }
  if (node.kind === "text") {
    if (node.text.trim().length === 0) {
      throw new SceneValidationError("INVALID_SCENE", `scene text ${node.id} is empty`);
    }
    if (node.fontSize < MIN_LABEL_FONT_SIZE) {
      throw new SceneValidationError(
        "UNSAFE_NODE",
        `scene text ${node.id} is smaller than ${MIN_LABEL_FONT_SIZE}`,
      );
    }
    for (const backdrop of backdrops) {
      assertContrast(node.fill, backdrop, MIN_TEXT_CONTRAST, `text ${node.id}`);
    }
  }
  if (node.role === "essential") {
    const minimumDimension = Math.min(bounds.width, bounds.height);
    if (node.kind === "line") {
      const length = Math.hypot(node.x2 - node.x1, node.y2 - node.y1);
      if (length < MIN_ESSENTIAL_SIZE) {
        throw new SceneValidationError(
          "UNSAFE_NODE",
          `essential line ${node.id} is shorter than ${MIN_ESSENTIAL_SIZE}`,
        );
      }
    } else if (minimumDimension < MIN_ESSENTIAL_SIZE) {
      throw new SceneValidationError(
        "UNSAFE_NODE",
        `essential node ${node.id} is smaller than ${MIN_ESSENTIAL_SIZE}`,
      );
    }
    if (node.kind === "text") {
      for (const backdrop of backdrops) {
        assertContrast(node.fill, backdrop, MIN_ESSENTIAL_CONTRAST, `essential text ${node.id}`);
      }
    } else if ("fill" in node && node.fill !== undefined && node.fill !== "none") {
      for (const backdrop of backdrops) {
        assertContrast(node.fill, backdrop, MIN_ESSENTIAL_CONTRAST, `essential fill ${node.id}`);
      }
    } else if ("stroke" in node && node.stroke !== undefined && node.stroke !== "none") {
      for (const backdrop of backdrops) {
        assertContrast(node.stroke, backdrop, MIN_ESSENTIAL_CONTRAST, `essential stroke ${node.id}`);
      }
    }
  }
  if (node.kind === "group") {
    if (node.children.length === 0) {
      throw new SceneValidationError("INVALID_SCENE", `scene group ${node.id} is empty`);
    }
    const localPainted = [...paintedRects];
    for (const child of node.children) {
      const childBounds = nodeBounds(child);
      if (childBounds === undefined) {
        throw new SceneValidationError(
          "INVALID_SCENE",
          `scene node ${child.id} has no bounds`,
        );
      }
      const childBackdrops = backdropsFor(childBounds, localPainted, backdrops);
      assertNode(child, sceneBackground, ids, childBackdrops, localPainted);
      if (child.kind === "rect" && child.fill !== undefined && child.fill !== "none") {
        localPainted.push({ bounds: childBounds, fill: child.fill });
      }
    }
  }
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

export function assertScene(scene: Scene): void {
  if (scene.width !== SCENE_SIZE || scene.height !== SCENE_SIZE) {
    throw new SceneValidationError(
      "INVALID_SCENE",
      `scene must be ${SCENE_SIZE}x${SCENE_SIZE}, received ${scene.width}x${scene.height}`,
    );
  }
  if (parseHexColor(scene.background) === undefined) {
    throw new SceneValidationError("INVALID_COLOR", "scene background must be a hex color");
  }
  if (scene.title.trim().length === 0 || scene.desc.trim().length === 0) {
    throw new SceneValidationError("INVALID_SCENE", "scene title and desc are required");
  }
  if (scene.nodes.length === 0) {
    throw new SceneValidationError("INVALID_SCENE", "scene has no visible nodes");
  }
  const ids = new Set<string>();
  const topPainted: PaintedRect[] = [];
  for (const node of scene.nodes) {
    const bounds = nodeBounds(node);
    if (bounds === undefined) {
      throw new SceneValidationError("INVALID_SCENE", `scene node ${node.id} has no bounds`);
    }
    const backdrops = backdropsFor(bounds, topPainted, [scene.background]);
    assertNode(node, scene.background, ids, backdrops, topPainted);
    if (node.kind === "rect" && node.fill !== undefined && node.fill !== "none") {
      topPainted.push({ bounds, fill: node.fill });
    }
  }
  const allNodes = collectNodes(scene.nodes);
  const options = allNodes.filter((node) => node.role === "option");
  if (options.length !== 4) {
    throw new SceneValidationError(
      "MISSING_OPTION",
      `scene requires exactly four option regions, received ${options.length}`,
    );
  }
  const expectedLabels = ["A", "B", "C", "D"] as const;
  const optionBounds: Bounds[] = [];
  for (const label of expectedLabels) {
    const option = options.find((node) => node.id === `option-${label}`);
    if (option === undefined) {
      throw new SceneValidationError("MISSING_OPTION", `missing option-${label}`);
    }
    const bounds = nodeBounds(option);
    if (bounds === undefined) {
      throw new SceneValidationError("INVALID_SCENE", `option-${label} has no bounds`);
    }
    if (!collectTexts(option).some((text) => text.text === label)) {
      throw new SceneValidationError(
        "MISSING_OPTION",
        `option-${label} is not visibly labeled ${label}`,
      );
    }
    optionBounds.push(bounds);
  }
  for (let left = 0; left < optionBounds.length; left += 1) {
    for (let right = left + 1; right < optionBounds.length; right += 1) {
      const leftBounds = optionBounds[left];
      const rightBounds = optionBounds[right];
      if (leftBounds !== undefined && rightBounds !== undefined && boundsOverlap(leftBounds, rightBounds)) {
        throw new SceneValidationError("OVERLAP", "option regions overlap");
      }
    }
  }
  const stem = allNodes.find((node) => node.role === "stem");
  const legend = allNodes.find((node) => node.role === "legend");
  if (stem === undefined || legend === undefined) {
    throw new SceneValidationError("INVALID_SCENE", "scene requires stem and legend regions");
  }
  const stemBounds = nodeBounds(stem);
  const legendBounds = nodeBounds(legend);
  if (stemBounds === undefined || legendBounds === undefined) {
    throw new SceneValidationError("INVALID_SCENE", "stem or legend has no bounds");
  }
  if (boundsOverlap(stemBounds, legendBounds)) {
    throw new SceneValidationError("OVERLAP", "stem and legend regions overlap");
  }
  for (const optionBoundsValue of optionBounds) {
    if (
      boundsOverlap(stemBounds, optionBoundsValue) ||
      boundsOverlap(legendBounds, optionBoundsValue)
    ) {
      throw new SceneValidationError("OVERLAP", "stem/legend overlaps an option region");
    }
  }
}

function rect(
  id: string,
  role: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
): SceneRect {
  return { kind: "rect", id, role, x, y, width, height, fill, stroke, strokeWidth: 4 };
}

function text(
  id: string,
  role: string,
  x: number,
  y: number,
  value: string,
  fontSize: number,
  fill = SCENE_INK,
  fontWeight: "normal" | "bold" = "normal",
): SceneText {
  return { kind: "text", id, role, x, y, text: value, fontSize, fill, fontWeight };
}

function circle(id: string, role: string, cx: number, cy: number, r: number, fill: string): SceneCircle {
  return { kind: "circle", id, role, cx, cy, r, fill };
}

export function createSceneDemo(seed: string): Scene {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(seed)) {
    throw new SceneValidationError(
      "INVALID_SCENE",
      "preview seed must be 1-64 letters, digits, dots, underscores, or hyphens",
    );
  }
  const stem: SceneGroup = {
    kind: "group",
    id: "stem",
    role: "stem",
    children: [
      rect("stem-panel", "panel", 64, 64, 896, 160, SCENE_PANEL, SCENE_INK),
      text("stem-text", "label", 96, 128, "Compare four labeled options.", 40),
      text("stem-seed", "label", 96, 184, `Seed: ${seed}`, 32),
    ],
  };
  const legend: SceneGroup = {
    kind: "group",
    id: "legend",
    role: "legend",
    children: [
      rect("legend-panel", "panel", 64, 256, 896, 160, SCENE_PANEL, SCENE_INK),
      text("legend-title", "label", 96, 312, "Legend", 36, SCENE_INK, "bold"),
      text(
        "legend-text",
        "label",
        96,
        360,
        "Circle = example mark. Box = answer region.",
        32,
      ),
      circle("legend-mark", "essential", 900, 336, 20, SCENE_INK),
    ],
  };
  const labels = ["A", "B", "C", "D"] as const;
  const positions = [
    { x: 64, y: 464 },
    { x: 544, y: 464 },
    { x: 64, y: 752 },
    { x: 544, y: 752 },
  ] as const;
  const options: SceneGroup[] = labels.map((label, index) => {
    const position = positions[index];
    if (position === undefined) {
      throw new SceneValidationError("INVALID_SCENE", "missing option position");
    }
    return {
      kind: "group",
      id: `option-${label}`,
      role: "option",
      children: [
        rect(
          `option-${label}-panel`,
          "panel",
          position.x,
          position.y,
          416,
          224,
          SCENE_PANEL,
          SCENE_INK,
        ),
        text(`option-${label}-label`, "label", position.x + 24, position.y + 64, label, 48, SCENE_INK, "bold"),
        text(
          `option-${label}-caption`,
          "label",
          position.x + 24,
          position.y + 112,
          `See labeled tile ${label}`,
          32,
        ),
        circle(`option-${label}-mark`, "essential", position.x + 330, position.y + 112, 28, SCENE_INK),
      ],
    };
  });
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background: SCENE_BACKGROUND,
    title: "Scene demo",
    desc: `Safe scene demo for seed ${seed}.`,
    nodes: [stem, legend, ...options],
  };
  assertScene(scene);
  return scene;
}

export interface PreviewRenderer {
  readonly family: string;
  buildScene(seed: string): Scene;
}

export class PreviewRendererRegistry {
  private readonly renderers = new Map<string, PreviewRenderer>();

  register(renderer: PreviewRenderer): void {
    if (!/^[a-z][a-z0-9-]*$/.test(renderer.family)) {
      throw new SceneValidationError("INVALID_SCENE", `invalid preview family ${renderer.family}`);
    }
    if (this.renderers.has(renderer.family)) {
      throw new SceneValidationError(
        "INVALID_SCENE",
        `preview family ${renderer.family} is already registered`,
      );
    }
    this.renderers.set(renderer.family, renderer);
  }

  get(family: string): PreviewRenderer | undefined {
    return this.renderers.get(family);
  }

  listFamilies(): readonly string[] {
    return [...this.renderers.keys()].sort();
  }
}

export const previewRegistry = new PreviewRendererRegistry();
previewRegistry.register({ family: "scene-demo", buildScene: createSceneDemo });
