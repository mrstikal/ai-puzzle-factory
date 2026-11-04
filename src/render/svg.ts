import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import {
  FONT_FAMILY,
  SCENE_SIZE,
  SceneValidationError,
  assertScene,
  parseHexColor,
  parseSafePathData,
  type Scene,
  type SceneCircle,
  type SceneLine,
  type SceneNode,
  type ScenePath,
  type ScenePoint,
  type ScenePolygon,
  type ScenePolyline,
  type SceneRect,
  type SceneText,
} from "./scene.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const MAX_SVG_BYTES = 200_000;
const NUMBER_PATTERN = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

export type SvgSafetyErrorCode =
  | "UNSAFE_XML"
  | "UNSAFE_TAG"
  | "UNSAFE_ATTRIBUTE"
  | "UNSAFE_VALUE"
  | "INVALID_STRUCTURE"
  | "TOO_LARGE";

export class SvgSafetyError extends Error {
  readonly code: SvgSafetyErrorCode;

  constructor(code: SvgSafetyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SvgSafetyError";
    this.code = code;
  }
}

const ROOT_ATTRIBUTES = new Set([
  "viewBox",
  "width",
  "height",
  "role",
  "data-background",
]);

const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  g: new Set(["id", "data-role"]),
  rect: new Set([
    "id",
    "data-role",
    "x",
    "y",
    "width",
    "height",
    "rx",
    "fill",
    "stroke",
    "stroke-width",
  ]),
  circle: new Set([
    "id",
    "data-role",
    "cx",
    "cy",
    "r",
    "fill",
    "stroke",
    "stroke-width",
  ]),
  line: new Set([
    "id",
    "data-role",
    "x1",
    "y1",
    "x2",
    "y2",
    "stroke",
    "stroke-width",
  ]),
  polyline: new Set([
    "id",
    "data-role",
    "points",
    "fill",
    "stroke",
    "stroke-width",
  ]),
  polygon: new Set([
    "id",
    "data-role",
    "points",
    "fill",
    "stroke",
    "stroke-width",
  ]),
  path: new Set([
    "id",
    "data-role",
    "d",
    "fill",
    "stroke",
    "stroke-width",
  ]),
  text: new Set([
    "id",
    "data-role",
    "x",
    "y",
    "font-size",
    "fill",
    "font-family",
    "font-weight",
    "text-anchor",
  ]),
};

const ALLOWED_TAGS = new Set([
  "svg",
  "title",
  "desc",
  "g",
  "rect",
  "circle",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
]);

export function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SvgSafetyError("UNSAFE_VALUE", "scene contains a non-finite number");
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  const text = String(value);
  if (!/[eE]/.test(text)) {
    return text;
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (match === null) {
    throw new SvgSafetyError("UNSAFE_VALUE", `cannot serialize number ${text}`);
  }
  const sign = match[1] ?? "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  let plain: string;
  if (decimalIndex <= 0) {
    plain = `0.${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    plain = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    plain = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }
  if (plain.includes(".")) {
    plain = plain.replace(/0+$/, "").replace(/\.$/, "");
  }
  return `${sign}${plain}`;
}

function commonAttributes(node: SceneNode): string[] {
  const attributes = [`id="${escapeXmlAttribute(node.id)}"`];
  if (node.role !== undefined) {
    attributes.push(`data-role="${escapeXmlAttribute(node.role)}"`);
  }
  return attributes;
}

function presentationAttributes(
  node: {
    readonly fill?: string;
    readonly stroke?: string;
    readonly strokeWidth?: number;
  },
): string[] {
  const attributes: string[] = [];
  if (node.fill !== undefined) {
    attributes.push(`fill="${escapeXmlAttribute(node.fill)}"`);
  }
  if (node.stroke !== undefined) {
    attributes.push(`stroke="${escapeXmlAttribute(node.stroke)}"`);
  }
  if (node.strokeWidth !== undefined) {
    attributes.push(`stroke-width="${formatNumber(node.strokeWidth)}"`);
  }
  return attributes;
}

function serializeNode(node: SceneNode, depth: number): string {
  const indent = "  ".repeat(depth);
  switch (node.kind) {
    case "group": {
      const children = node.children.map((child) => serializeNode(child, depth + 1)).join("\n");
      return `${indent}<g ${commonAttributes(node).join(" ")}>\n${children}\n${indent}</g>`;
    }
    case "rect": {
      const attributes = [
        ...commonAttributes(node),
        `x="${formatNumber(node.x)}"`,
        `y="${formatNumber(node.y)}"`,
        `width="${formatNumber(node.width)}"`,
        `height="${formatNumber(node.height)}"`,
        ...(node.rx === undefined ? [] : [`rx="${formatNumber(node.rx)}"`]),
        ...presentationAttributes(node),
      ];
      return `${indent}<rect ${attributes.join(" ")}/>`;
    }
    case "circle": {
      const attributes = [
        ...commonAttributes(node),
        `cx="${formatNumber(node.cx)}"`,
        `cy="${formatNumber(node.cy)}"`,
        `r="${formatNumber(node.r)}"`,
        ...presentationAttributes(node),
      ];
      return `${indent}<circle ${attributes.join(" ")}/>`;
    }
    case "line": {
      const attributes = [
        ...commonAttributes(node),
        `x1="${formatNumber(node.x1)}"`,
        `y1="${formatNumber(node.y1)}"`,
        `x2="${formatNumber(node.x2)}"`,
        `y2="${formatNumber(node.y2)}"`,
        ...presentationAttributes(node),
      ];
      return `${indent}<line ${attributes.join(" ")}/>`;
    }
    case "polyline":
    case "polygon": {
      const points = node.points
        .map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`)
        .join(" ");
      const attributes = [
        ...commonAttributes(node),
        `points="${escapeXmlAttribute(points)}"`,
        ...presentationAttributes(node),
      ];
      return `${indent}<${node.kind} ${attributes.join(" ")}/>`;
    }
    case "path": {
      const attributes = [
        ...commonAttributes(node),
        `d="${escapeXmlAttribute(node.d)}"`,
        ...presentationAttributes(node),
      ];
      return `${indent}<path ${attributes.join(" ")}/>`;
    }
    case "text": {
      const attributes = [
        ...commonAttributes(node),
        `x="${formatNumber(node.x)}"`,
        `y="${formatNumber(node.y)}"`,
        `font-size="${formatNumber(node.fontSize)}"`,
        `fill="${escapeXmlAttribute(node.fill)}"`,
        `font-family="${escapeXmlAttribute(FONT_FAMILY)}"`,
        ...(node.anchor === undefined ? [] : [`text-anchor="${node.anchor}"`]),
        ...(node.fontWeight === undefined ? [] : [`font-weight="${node.fontWeight}"`]),
      ];
      return `${indent}<text ${attributes.join(" ")}>${escapeXmlText(node.text)}</text>`;
    }
  }
}

export function serializeScene(scene: Scene): string {
  assertScene(scene);
  const lines = [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${SCENE_SIZE} ${SCENE_SIZE}" width="${SCENE_SIZE}" height="${SCENE_SIZE}" role="img" data-background="${escapeXmlAttribute(scene.background)}">`,
    `  <title>${escapeXmlText(scene.title)}</title>`,
    `  <desc>${escapeXmlText(scene.desc)}</desc>`,
    ...scene.nodes.map((node) => serializeNode(node, 1)),
    "</svg>",
  ];
  return `${lines.join("\n")}\n`;
}

function attributeMap(
  tag: SaxesTagNS,
  allowed: ReadonlySet<string>,
  allowXmlns = false,
): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const attribute of Object.values(tag.attributes) as SaxesAttributeNS[]) {
    if (allowXmlns && attribute.local === "xmlns" && attribute.uri === XMLNS_NS) {
      if (attribute.value !== SVG_NS) {
        throw new SvgSafetyError("UNSAFE_VALUE", "default xmlns must be the SVG namespace");
      }
      continue;
    }
    if (attribute.uri !== "") {
      throw new SvgSafetyError(
        "UNSAFE_ATTRIBUTE",
        `namespaced attribute ${attribute.name} is not allowed`,
      );
    }
    if (!allowed.has(attribute.local)) {
      throw new SvgSafetyError(
        "UNSAFE_ATTRIBUTE",
        `attribute ${attribute.local} is not allowed on ${tag.local}`,
      );
    }
    if (attributes.has(attribute.local)) {
      throw new SvgSafetyError(
        "UNSAFE_ATTRIBUTE",
        `duplicate attribute ${attribute.local}`,
      );
    }
    attributes.set(attribute.local, attribute.value);
  }
  return attributes;
}

function requiredAttribute(attributes: ReadonlyMap<string, string>, name: string): string {
  const value = attributes.get(name);
  if (value === undefined || value.trim() === "") {
    throw new SvgSafetyError("INVALID_STRUCTURE", `missing required attribute ${name}`);
  }
  return value;
}

function numberAttribute(
  attributes: ReadonlyMap<string, string>,
  name: string,
  options: { readonly required?: boolean; readonly positive?: boolean } = {},
): number | undefined {
  const value = attributes.get(name);
  if (value === undefined) {
    if (options.required === true) {
      throw new SvgSafetyError("INVALID_STRUCTURE", `missing required attribute ${name}`);
    }
    return undefined;
  }
  if (!NUMBER_PATTERN.test(value)) {
    throw new SvgSafetyError("UNSAFE_VALUE", `attribute ${name} is not a safe number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new SvgSafetyError("UNSAFE_VALUE", `attribute ${name} is not finite`);
  }
  if (options.positive === true && parsed <= 0) {
    throw new SvgSafetyError("UNSAFE_VALUE", `attribute ${name} must be positive`);
  }
  return parsed;
}

function colorAttribute(
  attributes: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  const value = attributes.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "none" && parseHexColor(value) === undefined) {
    throw new SvgSafetyError("UNSAFE_VALUE", `attribute ${name} must be a hex color or none`);
  }
  return value;
}

function idAndRole(attributes: ReadonlyMap<string, string>): { id: string; role?: string } {
  const id = requiredAttribute(attributes, "id");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    throw new SvgSafetyError("UNSAFE_VALUE", `invalid id ${id}`);
  }
  const role = attributes.get("data-role");
  if (role !== undefined && !/^[a-z][a-z0-9-]*$/.test(role)) {
    throw new SvgSafetyError("UNSAFE_VALUE", `invalid data-role ${role}`);
  }
  return role === undefined ? { id } : { id, role };
}

function parsePoints(value: string): readonly ScenePoint[] {
  const tokens = value.trim().split(/[\s,]+/).filter((token) => token.length > 0);
  if (tokens.length < 4 || tokens.length % 2 !== 0) {
    throw new SvgSafetyError("UNSAFE_VALUE", "points must contain coordinate pairs");
  }
  const points: ScenePoint[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const xText = tokens[index];
    const yText = tokens[index + 1];
    if (xText === undefined || yText === undefined) {
      throw new SvgSafetyError("UNSAFE_VALUE", "points are incomplete");
    }
    if (!NUMBER_PATTERN.test(xText) || !NUMBER_PATTERN.test(yText)) {
      throw new SvgSafetyError("UNSAFE_VALUE", "points contain an unsafe number");
    }
    points.push({ x: Number(xText), y: Number(yText) });
  }
  return points;
}

function parseRect(attributes: ReadonlyMap<string, string>): SceneRect {
  const common = idAndRole(attributes);
  const x = numberAttribute(attributes, "x", { required: true }) ?? 0;
  const y = numberAttribute(attributes, "y", { required: true }) ?? 0;
  const width = numberAttribute(attributes, "width", { required: true, positive: true }) ?? 1;
  const height = numberAttribute(attributes, "height", { required: true, positive: true }) ?? 1;
  const rx = numberAttribute(attributes, "rx");
  const fill = colorAttribute(attributes, "fill");
  const stroke = colorAttribute(attributes, "stroke");
  const strokeWidth = numberAttribute(attributes, "stroke-width");
  return {
    kind: "rect",
    ...common,
    x,
    y,
    width,
    height,
    ...(rx === undefined ? {} : { rx }),
    ...(fill === undefined ? {} : { fill }),
    ...(stroke === undefined ? {} : { stroke }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  };
}

function parseCircle(attributes: ReadonlyMap<string, string>): SceneCircle {
  const common = idAndRole(attributes);
  const cx = numberAttribute(attributes, "cx", { required: true }) ?? 0;
  const cy = numberAttribute(attributes, "cy", { required: true }) ?? 0;
  const r = numberAttribute(attributes, "r", { required: true, positive: true }) ?? 1;
  const fill = colorAttribute(attributes, "fill");
  const stroke = colorAttribute(attributes, "stroke");
  const strokeWidth = numberAttribute(attributes, "stroke-width");
  return {
    kind: "circle",
    ...common,
    cx,
    cy,
    r,
    ...(fill === undefined ? {} : { fill }),
    ...(stroke === undefined ? {} : { stroke }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  };
}

function parseLine(attributes: ReadonlyMap<string, string>): SceneLine {
  const common = idAndRole(attributes);
  const x1 = numberAttribute(attributes, "x1", { required: true }) ?? 0;
  const y1 = numberAttribute(attributes, "y1", { required: true }) ?? 0;
  const x2 = numberAttribute(attributes, "x2", { required: true }) ?? 0;
  const y2 = numberAttribute(attributes, "y2", { required: true }) ?? 0;
  const stroke = colorAttribute(attributes, "stroke");
  const strokeWidth = numberAttribute(attributes, "stroke-width");
  return {
    kind: "line",
    ...common,
    x1,
    y1,
    x2,
    y2,
    ...(stroke === undefined ? {} : { stroke }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  };
}

function parsePoly(attributes: ReadonlyMap<string, string>, kind: "polyline" | "polygon"): ScenePolyline | ScenePolygon {
  const common = idAndRole(attributes);
  const points = parsePoints(requiredAttribute(attributes, "points"));
  const fill = colorAttribute(attributes, "fill");
  const stroke = colorAttribute(attributes, "stroke");
  const strokeWidth = numberAttribute(attributes, "stroke-width");
  return {
    kind,
    ...common,
    points,
    ...(fill === undefined ? {} : { fill }),
    ...(stroke === undefined ? {} : { stroke }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  };
}

function parsePath(attributes: ReadonlyMap<string, string>): ScenePath {
  const common = idAndRole(attributes);
  const d = requiredAttribute(attributes, "d");
  parseSafePathData(d);
  const fill = colorAttribute(attributes, "fill");
  const stroke = colorAttribute(attributes, "stroke");
  const strokeWidth = numberAttribute(attributes, "stroke-width");
  return {
    kind: "path",
    ...common,
    d,
    ...(fill === undefined ? {} : { fill }),
    ...(stroke === undefined ? {} : { stroke }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  };
}

function parseTextBase(attributes: ReadonlyMap<string, string>): Omit<SceneText, "text"> {
  const common = idAndRole(attributes);
  const x = numberAttribute(attributes, "x", { required: true }) ?? 0;
  const y = numberAttribute(attributes, "y", { required: true }) ?? 0;
  const fontSize = numberAttribute(attributes, "font-size", {
    required: true,
    positive: true,
  }) ?? 1;
  const fill = requiredAttribute(attributes, "fill");
  if (parseHexColor(fill) === undefined) {
    throw new SvgSafetyError("UNSAFE_VALUE", "text fill must be a hex color");
  }
  const fontFamily = requiredAttribute(attributes, "font-family");
  if (fontFamily !== FONT_FAMILY) {
    throw new SvgSafetyError("UNSAFE_VALUE", `font-family must be ${FONT_FAMILY}`);
  }
  const anchor = attributes.get("text-anchor");
  if (anchor !== undefined && anchor !== "start" && anchor !== "middle" && anchor !== "end") {
    throw new SvgSafetyError("UNSAFE_VALUE", "unsupported text-anchor");
  }
  const fontWeight = attributes.get("font-weight");
  if (fontWeight !== undefined && fontWeight !== "normal" && fontWeight !== "bold") {
    throw new SvgSafetyError("UNSAFE_VALUE", "unsupported font-weight");
  }
  return {
    kind: "text",
    ...common,
    x,
    y,
    fontSize,
    fill,
    ...(anchor === undefined ? {} : { anchor }),
    ...(fontWeight === undefined ? {} : { fontWeight }),
  };
}

interface GroupBuilder {
  readonly kind: "group";
  readonly tag: "g";
  readonly base: { readonly id: string; readonly role?: string };
  readonly children: SceneNode[];
}

interface TextBuilder {
  readonly kind: "text";
  readonly tag: "text";
  readonly base: Omit<SceneText, "text">;
  content: string;
}

type Builder = GroupBuilder | TextBuilder;

export function parseScene(svg: string): Scene {
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
    throw new SvgSafetyError("TOO_LARGE", `SVG exceeds ${MAX_SVG_BYTES} bytes`);
  }
  const parser = new SaxesParser({ xmlns: true });
  const rootChildren: SceneNode[] = [];
  const stack: Builder[] = [];
  let rootOpen = false;
  let rootClosed = false;
  let title: string | undefined;
  let desc: string | undefined;
  let background = "#ffffff";
  let textTarget: "title" | "desc" | "text" | null = null;
  let textContent = "";
  let parseError: Error | undefined;

  const fail = (message: string): never => {
    throw new SvgSafetyError("UNSAFE_XML", message);
  };

  const append = (node: SceneNode): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (!rootOpen) {
        fail("scene node outside svg root");
      }
      rootChildren.push(node);
      return;
    }
    if (parent.kind !== "group") {
      fail("scene node nested inside text");
      return;
    }
    parent.children.push(node);
  };

  parser.on("xmldecl", () => fail("XML declarations are not allowed"));
  parser.on("doctype", () => fail("DOCTYPE is not allowed"));
  parser.on("processinginstruction", () => fail("processing instructions are not allowed"));
  parser.on("comment", () => fail("comments are not allowed"));
  parser.on("cdata", () => fail("CDATA is not allowed"));
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.on("opentag", (tag) => {
    const local = tag.local;
    if (local === undefined || tag.prefix !== "" || tag.uri !== SVG_NS) {
      fail(`unsupported namespace or prefixed tag ${tag.name}`);
    }
    if (!ALLOWED_TAGS.has(local)) {
      throw new SvgSafetyError("UNSAFE_TAG", `tag ${local} is not allowed`);
    }
    if (local === "svg") {
      if (rootOpen || rootClosed) {
        fail("multiple svg roots");
      }
      const attributes = attributeMap(tag, ROOT_ATTRIBUTES, true);
      if (attributes.get("viewBox") !== `0 0 ${SCENE_SIZE} ${SCENE_SIZE}`) {
        fail("viewBox must be 0 0 1024 1024");
      }
      if (attributes.get("width") !== String(SCENE_SIZE) || attributes.get("height") !== String(SCENE_SIZE)) {
        fail("svg width and height must be 1024");
      }
      if (attributes.get("role") !== "img") {
        fail("svg role must be img");
      }
      const sceneBackground = attributes.get("data-background");
      if (sceneBackground !== undefined && parseHexColor(sceneBackground) === undefined) {
        throw new SvgSafetyError("UNSAFE_VALUE", "data-background must be a hex color");
      }
      background = sceneBackground ?? "#ffffff";
      rootOpen = true;
      return;
    }
    if (!rootOpen) {
      fail("svg root is required");
    }
    if (textTarget !== null) {
      fail(`${textTarget} cannot contain child elements`);
    }
    if (stack[stack.length - 1]?.kind === "text") {
      fail("text elements cannot contain child elements");
    }
    if (local === "title" || local === "desc") {
      if (stack.length !== 0 || textTarget !== null) {
        fail(`${local} is allowed only directly under svg`);
      }
      if (local === "title" && title !== undefined) {
        fail("duplicate title");
      }
      if (local === "desc" && desc !== undefined) {
        fail("duplicate desc");
      }
      const attributes = attributeMap(tag, new Set());
      if (attributes.size > 0) {
        fail(`${local} cannot carry attributes`);
      }
      textTarget = local;
      textContent = "";
      return;
    }
    if (local === "g") {
      const attributes = attributeMap(tag, TAG_ATTRIBUTES.g ?? new Set());
      const base = idAndRole(attributes);
      stack.push({ kind: "group", tag: "g", base, children: [] });
      return;
    }
    if (local === "text") {
      const attributes = attributeMap(tag, TAG_ATTRIBUTES.text ?? new Set());
      const base = parseTextBase(attributes);
      stack.push({ kind: "text", tag: "text", base, content: "" });
      return;
    }
    const allowed = TAG_ATTRIBUTES[local];
    if (allowed === undefined) {
      throw new SvgSafetyError("UNSAFE_TAG", `tag ${local} is not allowed`);
    }
    const attributes = attributeMap(tag, allowed);
    if (local === "rect") {
      append(parseRect(attributes));
    } else if (local === "circle") {
      append(parseCircle(attributes));
    } else if (local === "line") {
      append(parseLine(attributes));
    } else if (local === "polyline") {
      append(parsePoly(attributes, "polyline"));
    } else if (local === "polygon") {
      append(parsePoly(attributes, "polygon"));
    } else if (local === "path") {
      append(parsePath(attributes));
    }
  });
  parser.on("text", (value) => {
    if (textTarget !== null) {
      textContent += value;
      return;
    }
    const top = stack[stack.length - 1];
    if (top?.kind === "text") {
      top.content += value;
      return;
    }
    if (value.trim() !== "") {
      fail("unexpected text content outside a text element");
    }
  });
  parser.on("closetag", (tag) => {
    const local = tag.local;
    if (local === undefined) {
      fail("closing tag has no local name");
    }
    if (local === "svg") {
      if (stack.length !== 0) {
        fail("svg closed before its children");
      }
      rootOpen = false;
      rootClosed = true;
      return;
    }
    if (
      tag.isSelfClosing &&
      (local === "rect" ||
        local === "circle" ||
        local === "line" ||
        local === "polyline" ||
        local === "polygon" ||
        local === "path")
    ) {
      return;
    }
    if (local === "title" || local === "desc") {
      if (textTarget !== local) {
        fail(`unexpected ${local} close`);
      }
      if (local === "title") {
        title = textContent;
      } else {
        desc = textContent;
      }
      textTarget = null;
      textContent = "";
      return;
    }
    const top = stack.pop();
    if (top === undefined) {
      fail(`unexpected close tag ${local}`);
      return;
    }
    if (top.tag !== local) {
      fail(`mismatched close tag ${local}`);
      return;
    }
    if (top.kind === "text") {
      append({ ...top.base, text: top.content });
      return;
    }
    append({
      kind: "group",
      id: top.base.id,
      ...(top.base.role === undefined ? {} : { role: top.base.role }),
      children: top.children,
    });
  });
  try {
    parser.write(svg).close();
  } catch (error) {
    if (error instanceof SvgSafetyError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new SvgSafetyError("UNSAFE_XML", error.message, { cause: error });
    }
    throw error;
  }
  if (parseError !== undefined) {
    throw new SvgSafetyError("UNSAFE_XML", parseError.message, { cause: parseError });
  }
  if (!rootClosed) {
    fail("svg root is missing or unclosed");
  }
  const sceneTitle = title ?? fail("title and desc are required");
  const sceneDesc = desc ?? fail("title and desc are required");
  const scene: Scene = {
    width: SCENE_SIZE,
    height: SCENE_SIZE,
    background,
    title: sceneTitle,
    desc: sceneDesc,
    nodes: rootChildren,
  };
  try {
    assertScene(scene);
  } catch (error) {
    if (error instanceof SceneValidationError) {
      throw new SvgSafetyError("INVALID_STRUCTURE", error.message, { cause: error });
    }
    throw error;
  }
  return scene;
}
