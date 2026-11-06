import { deepEqual, type ChoiceSet } from "../domain/answers.js";
import { MODALITY_BY_FAMILY, type Family } from "../domain/experiment.js";
import {
  VisiblePresentationSchema,
  type VisiblePresentation,
} from "../domain/presentation.js";
import { productionRegistry } from "../families/registry.js";
import {
  MatrixSpecSchema,
  checkMatrixCompletion,
  solveMatrix,
  type MatrixSpec,
} from "../families/matrix/schema.js";
import { buildMatrixScene } from "../families/matrix/render.js";
import {
  PathsSpecSchema,
  findTreeRoute,
  sortPathEdges,
  type PathRoute,
  type PathsSpec,
} from "../families/paths/schema.js";
import { PATH_WALL_STROKE, buildPathsScene } from "../families/paths/render.js";
import {
  TransformsSpecSchema,
  sourceCellsFromGrid,
  transformCells,
  type TransformAnswer,
  type TransformsSpec,
} from "../families/transforms/schema.js";
import { buildTransformsScene } from "../families/transforms/render.js";
import {
  SymmetrySpecSchema,
  type SymmetryAnswer,
  type SymmetrySpec,
} from "../families/symmetry/schema.js";
import { buildSymmetryScene } from "../families/symmetry/render.js";
import {
  CountingSpecSchema,
  type CountingAnswer,
  type CountingSpec,
} from "../families/counting/schema.js";
import { buildCountingScene } from "../families/counting/render.js";
import { formatOptionText } from "../presentation/assemble.js";
import { makeFixtureWording } from "../presentation/wording.js";
import {
  SCENE_INK,
  SCENE_SIZE,
  type Scene,
  type SceneLine,
  type SceneNode,
  type SceneRect,
} from "../render/scene.js";
import { assertPngNoTextMetadata, hashPng, renderScenePng } from "../render/png.js";
import { serializeScene } from "../render/svg.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";
import type {
  CalibrationArtifacts,
  CalibrationExpected,
  CalibrationField,
  CalibrationMutation,
  CalibrationMutationResult,
  CalibrationOriginal,
  CalibrationSoundBase,
} from "./fixtures.js";

type ValidationMode = "full" | "calibration";

interface VisualBuild {
  readonly svg: string;
  readonly png: Buffer;
  readonly svgHash: string;
  readonly pngHash: string;
}

function originalFromBase(base: CalibrationSoundBase): CalibrationOriginal {
  return {
    spec: base.spec,
    solveResult: base.solveResult,
    choices: base.choices,
    visible: base.visible,
    reveal: base.reveal,
    contentHash: base.hashes.contentHash,
    pngHash: base.hashes.pngHash,
    svgHash: base.hashes.svgHash,
  };
}

function originalArtifacts(base: CalibrationSoundBase): CalibrationArtifacts["original"] {
  return { svg: base.svg, png: base.png };
}

function buildVisual(
  base: CalibrationSoundBase,
  spec: unknown,
  choices: ChoiceSet<unknown>,
  validation: ValidationMode,
): VisualBuild {
  let scene: Scene;
  switch (base.family) {
    case "matrix":
      scene = buildMatrixScene(
        spec as MatrixSpec,
        choices.choices.map((choice) => ({
          label: choice.label,
          mask: choice.value as number,
        })),
        base.optionsSeed,
        validation,
      );
      break;
    case "transforms":
      scene = buildTransformsScene(
        spec as TransformsSpec,
        choices.choices.map((choice) => ({
          label: choice.label,
          cells: choice.value as TransformAnswer,
        })),
        base.optionsSeed,
        validation,
      );
      break;
    case "paths":
      scene = buildPathsScene(
        spec as PathsSpec,
        choices.choices.map((choice) => ({
          label: choice.label,
          route: choice.value as PathRoute,
        })),
        base.optionsSeed,
        validation,
      );
      break;
    case "symmetry":
      scene = buildSymmetryScene(
        spec as SymmetrySpec,
        choices.choices.map((choice) => ({
          label: choice.label,
          answer: choice.value as SymmetryAnswer,
        })),
        base.optionsSeed,
        validation,
      );
      break;
    case "counting":
      scene = buildCountingScene(
        spec as CountingSpec,
        choices.choices.map((choice) => ({
          label: choice.label,
          answer: choice.value as CountingAnswer,
        })),
        base.optionsSeed,
        validation,
      );
      break;
    default:
      throw new Error(`visual calibration fixture requires an SVG family, received ${base.family}`);
  }
  const svg = serializeScene(scene);
  const png = renderScenePng(scene, SCENE_SIZE);
  assertPngNoTextMetadata(png);
  return { svg, png, svgHash: sha256Hex(svg), pngHash: hashPng(png) };
}

function replaceChoiceValue(
  choices: ChoiceSet<unknown>,
  desiredValues: readonly unknown[],
  preserveLabel: string,
): ChoiceSet<unknown> {
  const values = choices.choices.map((choice) => ({ ...choice }));
  const labels = new Map<string, string>();
  for (const desired of desiredValues) {
    const existing = values.find((choice) => deepEqual(choice.value, desired));
    if (existing !== undefined) {
      labels.set(hashCanonicalJson(desired), existing.label);
      continue;
    }
    const replacement = values.find(
      (choice) =>
        choice.label !== preserveLabel &&
        ![...labels.values()].includes(choice.label),
    );
    if (replacement === undefined) {
      throw new Error("calibration mutation cannot place all desired visible choices");
    }
    replacement.value = desired;
    labels.set(hashCanonicalJson(desired), replacement.label);
  }
  return {
    choices: values as unknown as ChoiceSet<unknown>["choices"],
    correctLabel: choices.correctLabel,
  };
}

function changedFactIds(
  original: readonly { readonly factId: string; readonly text: string }[],
  mutated: readonly { readonly factId: string; readonly text: string }[],
): string[] {
  const originalMap = new Map(original.map((fact) => [fact.factId, fact.text]));
  const mutatedMap = new Map(mutated.map((fact) => [fact.factId, fact.text]));
  const ids = new Set([...originalMap.keys(), ...mutatedMap.keys()]);
  return [...ids]
    .filter((factId) => originalMap.get(factId) !== mutatedMap.get(factId))
    .sort();
}

function samePathEdge(
  left: { readonly from: PathRoute[number]; readonly to: PathRoute[number] },
  right: { readonly from: PathRoute[number]; readonly to: PathRoute[number] },
): boolean {
  return (
    (deepEqual(left.from, right.from) && deepEqual(left.to, right.to)) ||
    (deepEqual(left.from, right.to) && deepEqual(left.to, right.from))
  );
}

function expectedDefect(
  code: CalibrationExpected["blind"]["acceptedDefectCodes"][number],
  fields: CalibrationExpected["alignment"]["acceptedFailingFields"],
  factIds: readonly string[] = [],
): CalibrationExpected {
  return {
    blind: {
      result: ["NO_VALID_OFFERED_SOLUTION", "CONTRADICTORY_XOR_EXAMPLE", "CLOSED_ROUTE_EDGE"].includes(code)
        ? "no_unique"
        : "defect",
      correctLabel: null,
      acceptedDefectCodes: [code],
    },
    alignment: {
      result: "fail",
      acceptedFailingFields: [...fields],
      acceptedFactIds: [...factIds],
    },
  };
}

export function buildDuplicateDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  const correct = base.choices.choices.find(
    (choice) => choice.label === base.choices.correctLabel,
  );
  const target = base.choices.choices.find(
    (choice) => choice.label !== base.choices.correctLabel,
  );
  if (correct === undefined || target === undefined) {
    throw new Error("sound base is missing its correct or distractor choice");
  }
  const mutatedChoices: ChoiceSet<unknown> = {
    choices: base.choices.choices.map((choice) =>
      choice.label === target.label ? { ...choice, value: correct.value } : choice,
    ) as unknown as ChoiceSet<unknown>["choices"],
    correctLabel: base.choices.correctLabel,
  };
  const regeneratedOptions = mutatedChoices.choices.map((choice) => ({
    label: choice.label,
    text: formatOptionText(base.family, choice.label, choice.value),
  }));
  const optionsChanged =
    hashCanonicalJson(regeneratedOptions) !== hashCanonicalJson(base.visible.options);
  let visible: VisiblePresentation;
  let visibleArtifacts: CalibrationArtifacts["visible"];
  if (base.modality === "text") {
    visible = VisiblePresentationSchema.parse({
      ...base.visible,
      options: regeneratedOptions,
    });
    visibleArtifacts = { svg: null, png: null };
  } else {
    const visual = buildVisual(base, base.spec, mutatedChoices, "calibration");
    visible = VisiblePresentationSchema.parse({
      ...base.visible,
      options: regeneratedOptions,
      assets: { svgHash: visual.svgHash, pngHash: visual.pngHash },
    });
    visibleArtifacts = { svg: visual.svg, png: visual.png };
  }
  const changedFields: CalibrationField[] = base.modality === "text"
    ? ["options"]
    : optionsChanged
      ? ["assets", "options"]
      : ["assets"];
  const mutation: CalibrationMutation = {
    kind: "duplicate_correct_option",
    description: `Option ${target.label} duplicates the visible correct option ${correct.label}.`,
    changedFields,
    affectedFactIds: [],
    details: {
      duplicatedLabel: target.label,
      correctLabel: correct.label,
      duplicatedOptionText: formatOptionText(base.family, correct.label, correct.value),
      duplicatedValueHash: hashCanonicalJson(correct.value),
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect("DUPLICATE_CORRECT_OPTION", changedFields),
    artifacts: { visible: visibleArtifacts, original: originalArtifacts(base) },
    original: originalFromBase(base),
  };
}

export function buildTextPrimitiveDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  if (base.modality !== "text") {
    throw new Error("text primitive mutation requires a text base");
  }
  const engine = productionRegistry.getEngine(base.family);
  const candidates = engine.testMutations(base.spec);
  let selected:
    | {
        readonly spec: unknown;
        readonly solutionCount: number;
        readonly offeredValidLabels: string[];
        readonly description: string;
        readonly factIds: string[];
      }
    | undefined;
  let bestChangedFactCount = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let solutionCount: number;
    try {
      solutionCount = engine.enumerateSolutions(candidate.spec).solutionCount;
    } catch {
      continue;
    }
    const offeredValidLabels = base.choices.choices
      .filter((choice) => engine.verifyAnswer(candidate.spec, choice.value))
      .map((choice) => choice.label);
    if (offeredValidLabels.length !== 0 && offeredValidLabels.length < 2) {
      continue;
    }
    const factIds = changedFactIds(
      engine.facts(base.spec),
      engine.facts(candidate.spec),
    );
    if (factIds.length < bestChangedFactCount) {
      bestChangedFactCount = factIds.length;
      selected = {
        spec: candidate.spec,
        solutionCount,
        offeredValidLabels,
        description: candidate.description,
        factIds,
      };
    }
  }
  if (selected === undefined) {
    throw new Error(`no visible text mutation produces no or multiple offered solutions for ${base.family}`);
  }
  const wording = makeFixtureWording(engine, selected.spec);
  const rules = engine.visibleRules(selected.spec);
  const clues = wording.response.clueTexts;
  const changedFields: Array<"question" | "rules" | "clues" | "options" | "assets"> = [];
  if (hashCanonicalJson(rules) !== hashCanonicalJson(base.visible.rules)) {
    changedFields.push("rules");
  }
  if (hashCanonicalJson(clues) !== hashCanonicalJson(base.visible.clues)) {
    changedFields.push("clues");
  }
  if (changedFields.length === 0) {
    throw new Error(`text mutation for ${base.family} does not change visible rules or clues`);
  }
  const factIds = selected.factIds;
  const visible = VisiblePresentationSchema.parse({
    ...base.visible,
    question: wording.response.question,
    rules,
    clues,
    assets: { svgHash: null, pngHash: null },
  });
  const code =
    selected.offeredValidLabels.length === 0
      ? "NO_VALID_OFFERED_SOLUTION"
      : "MULTIPLE_OFFERED_SOLUTIONS";
  const mutation: CalibrationMutation = {
    kind: "visible_primitive_mutation",
    description: `Visible primitive mutation: ${selected.description}`,
    changedFields,
    affectedFactIds: factIds,
    details: {
      mutationDescription: selected.description,
      mutatedSpec: selected.spec,
      solutionCount: selected.solutionCount,
      offeredValidLabels: selected.offeredValidLabels,
      changedFactIds: factIds,
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect(code, changedFields, factIds),
    artifacts: {
      visible: { svg: null, png: null },
      original: originalArtifacts(base),
    },
    original: originalFromBase(base),
  };
}

export function buildMatrixDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  const engine = productionRegistry.getEngine(base.family);
  const candidate = engine
    .testMutations(base.spec)
    .find((mutation) => solveMatrix(mutation.spec as MatrixSpec).length === 0);
  if (candidate === undefined) {
    throw new Error("matrix base has no inconsistent-visible-row mutation");
  }
  const mutatedSpec = MatrixSpecSchema.parse(candidate.spec);
  const offeredValidLabels = base.choices.choices
    .filter((choice) => checkMatrixCompletion(mutatedSpec, choice.value as number))
    .map((choice) => choice.label);
  if (offeredValidLabels.length > 0) {
    throw new Error("matrix defect still leaves a valid offered mask");
  }
  const wording = makeFixtureWording(engine, mutatedSpec);
  const visual = buildVisual(base, mutatedSpec, base.choices, "calibration");
  const visible = VisiblePresentationSchema.parse({
    ...base.visible,
    question: wording.response.question,
    rules: engine.visibleRules(mutatedSpec),
    assets: { svgHash: visual.svgHash, pngHash: visual.pngHash },
  });
  const mutation: CalibrationMutation = {
    kind: "contradictory_matrix_example",
    description: "One visible XOR example is contradicted; no missing mask can satisfy the displayed rows and columns.",
    changedFields: ["assets"],
    affectedFactIds: [],
    details: {
      mutationDescription: candidate.description,
      mutatedSpec,
      solutionCount: 0,
      offeredValidLabels,
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect("CONTRADICTORY_XOR_EXAMPLE", ["assets"]),
    artifacts: {
      visible: { svg: visual.svg, png: visual.png },
      original: originalArtifacts(base),
    },
    original: originalFromBase(base),
  };
}

function findNodeById(node: SceneNode, id: string): SceneNode | undefined {
  if (node.id === id) {
    return node;
  }
  if (node.kind !== "group") {
    return undefined;
  }
  for (const child of node.children) {
    const found = findNodeById(child, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function findRect(scene: Scene, id: string): SceneRect {
  const node = findNodeById(
    { kind: "group", id: "root", children: scene.nodes },
    id,
  );
  if (node === undefined || node.kind !== "rect") {
    throw new Error(`path scene is missing cell rect ${id}`);
  }
  return node;
}

function wallForMaze(
  scene: Scene,
  mazeId: string,
  from: PathRoute[number],
  to: PathRoute[number],
): SceneLine {
  const fromRect = findRect(scene, `${mazeId}-cell-${from.row}-${from.column}`);
  const toRect = findRect(scene, `${mazeId}-cell-${to.row}-${to.column}`);
  const id = `${mazeId}-calibration-wall-${from.row}-${from.column}-${to.row}-${to.column}`;
  if (from.row === to.row) {
    const left = fromRect.x <= toRect.x ? fromRect : toRect;
    const x = left.x + left.width;
    return {
      kind: "line",
      id,
      role: "wall",
      x1: x,
      y1: left.y,
      x2: x,
      y2: left.y + left.height,
      stroke: SCENE_INK,
      strokeWidth: PATH_WALL_STROKE,
    };
  }
  if (from.column === to.column) {
    const top = fromRect.y <= toRect.y ? fromRect : toRect;
    const y = top.y + top.height;
    return {
      kind: "line",
      id,
      role: "wall",
      x1: top.x,
      y1: y,
      x2: top.x + top.width,
      y2: y,
      stroke: SCENE_INK,
      strokeWidth: PATH_WALL_STROKE,
    };
  }
  throw new Error("path route edge is not orthogonally adjacent");
}

function addWallToMaze(node: SceneNode, mazeId: string, wall: SceneLine): SceneNode {
  if (node.kind !== "group") {
    return node;
  }
  if (node.id === mazeId) {
    return {
      ...node,
      children: node.children.map((child) =>
        child.kind === "group" && child.role === "walls"
          ? { ...child, children: [...child.children, wall] }
          : child,
      ),
    };
  }
  return {
    ...node,
    children: node.children.map((child) => addWallToMaze(child, mazeId, wall)),
  };
}

function addCalibrationWall(
  scene: Scene,
  from: PathRoute[number],
  to: PathRoute[number],
): Scene {
  const mazeIds = [
    "source-maze",
    ...["A", "B", "C", "D"].map((label) => `option-${label}-maze`),
  ];
  let nodes = scene.nodes;
  for (const mazeId of mazeIds) {
    nodes = nodes.map((node) =>
      addWallToMaze(node, mazeId, wallForMaze(scene, mazeId, from, to)),
    );
  }
  return { ...scene, nodes };
}

export function buildPathsDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  const parsed = PathsSpecSchema.parse(base.spec);
  if (base.scene === null) {
    throw new Error("paths defect requires a rendered sound scene");
  }
  const route = findTreeRoute(parsed.active, parsed.edges, parsed.start, parsed.goal);
  if (route === undefined) {
    throw new Error("paths base has no unique route");
  }
  let visibleEdges: PathsSpec["edges"] | undefined;
  let removedEdge:
    | { readonly from: PathRoute[number]; readonly to: PathRoute[number] }
    | undefined;
  let routeEdgeIndex = -1;
  for (let index = 0; index + 1 < route.length; index += 1) {
    const from = route[index];
    const to = route[index + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    const edge = { from, to };
    const edges = sortPathEdges(
      parsed.edges.filter((candidate) => !samePathEdge(candidate, edge)),
    );
    if (findTreeRoute(parsed.active, edges, parsed.start, parsed.goal) === undefined) {
      visibleEdges = edges;
      removedEdge = edge;
      routeEdgeIndex = index;
      break;
    }
  }
  if (visibleEdges === undefined || removedEdge === undefined) {
    throw new Error("paths base route cannot be closed by removing one edge");
  }
  const scene = addCalibrationWall(base.scene, removedEdge.from, removedEdge.to);
  const svg = serializeScene(scene);
  const png = renderScenePng(scene, SCENE_SIZE);
  assertPngNoTextMetadata(png);
  const svgHash = sha256Hex(svg);
  const pngHash = hashPng(png);
  const visible = VisiblePresentationSchema.parse({
    ...base.visible,
    assets: { svgHash, pngHash },
  });
  const mutation: CalibrationMutation = {
    kind: "closed_route_edge",
    description: "A wall closes an edge of the only valid route; all four offered routes now fail against the visible graph.",
    changedFields: ["assets"],
    affectedFactIds: [],
    details: {
      removedEdge,
      routeEdgeIndex,
      visibleEdges,
      solutionCount: 0,
      offeredValidLabels: [],
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect("CLOSED_ROUTE_EDGE", ["assets"]),
    artifacts: {
      visible: { svg, png },
      original: originalArtifacts(base),
    },
    original: originalFromBase(base),
  };
}

export function buildTransformsDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  const parsed = TransformsSpecSchema.parse(base.spec);
  const rotation = parsed.operations.find(
    (operation) => operation === "rotate90" || operation === "rotate270",
  );
  if (rotation === undefined) {
    throw new Error("transform defect requires a base with a 90/270 rotation");
  }
  const opposite = rotation === "rotate90" ? "rotate270" : "rotate90";
  const rotationLabel = rotation === "rotate90" ? "R90" : "R270";
  const source = sourceCellsFromGrid(parsed.source);
  const clockwise = transformCells(source, [rotation]);
  const counterclockwise = transformCells(source, [opposite]);
  if (deepEqual(clockwise, counterclockwise)) {
    throw new Error("transform base has identical clockwise and counterclockwise results");
  }
  const mutatedChoices = replaceChoiceValue(
    base.choices,
    [clockwise, counterclockwise],
    base.choices.correctLabel,
  );
  const clockwiseChoice = mutatedChoices.choices.find((choice) =>
    deepEqual(choice.value, clockwise),
  );
  const counterclockwiseChoice = mutatedChoices.choices.find((choice) =>
    deepEqual(choice.value, counterclockwise),
  );
  if (clockwiseChoice === undefined || counterclockwiseChoice === undefined) {
    throw new Error("transform defect did not place both direction results");
  }
  const visual = buildVisual(base, parsed, mutatedChoices, "calibration");
  const rules = {
    ...base.visible.rules,
    operations: [
      ...base.visible.rules.operations,
      `Conflicting direction rule: ${rotationLabel} is both clockwise and counterclockwise; both resulting patterns are offered and either reading is allowed.`,
    ],
  };
  const visible = VisiblePresentationSchema.parse({
    ...base.visible,
    rules,
    assets: { svgHash: visual.svgHash, pngHash: visual.pngHash },
  });
  const mutation: CalibrationMutation = {
    kind: "contradictory_transform_instructions",
    description: `The visible instructions allow both clockwise and counterclockwise ${rotationLabel}, and both different results are offered.`,
    changedFields: ["rules", "assets"],
    affectedFactIds: ["r-operations"],
    details: {
      rotation: rotationLabel,
      instructedDirections: ["clockwise", "counterclockwise"],
      clockwiseLabel: clockwiseChoice.label,
      counterclockwiseLabel: counterclockwiseChoice.label,
      offeredLabels: [clockwiseChoice.label, counterclockwiseChoice.label],
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect(
      "CONTRADICTORY_TRANSFORM_INSTRUCTIONS",
      ["rules", "assets"],
      ["r-operations"],
    ),
    artifacts: {
      visible: { svg: visual.svg, png: visual.png },
      original: originalArtifacts(base),
    },
    original: originalFromBase(base),
  };
}

export function buildSymmetryDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  const parsed = SymmetrySpecSchema.parse(base.spec);
  const instructedAxis = parsed.axis === "vertical" ? "horizontal" : "vertical";
  const rules = {
    ...base.visible.rules,
    operations: [
      ...base.visible.rules.operations,
      `Conflicting axis rule: the marked ${parsed.axis} axis must be read as a ${instructedAxis} axis.`,
    ],
  };
  const visible = VisiblePresentationSchema.parse({
    ...base.visible,
    rules,
    assets: base.visible.assets,
  });
  const mutation: CalibrationMutation = {
    kind: "contradictory_symmetry_axis",
    description: `The public rule contradicts the displayed ${parsed.axis} axis and asks for a ${instructedAxis} reflection.`,
    changedFields: ["rules"],
    affectedFactIds: ["r-operations"],
    details: {
      displayedAxis: parsed.axis,
      instructedAxis,
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect(
      "CONTRADICTORY_SYMMETRY_AXIS",
      ["rules"],
      ["r-operations"],
    ),
    artifacts: {
      visible: { svg: base.svg, png: base.png },
      original: originalArtifacts(base),
    },
    original: originalFromBase(base),
  };
}

export function buildCountingDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  const parsed = CountingSpecSchema.parse(base.spec);
  if (parsed.query.operation !== "unionCount") {
    throw new Error("counting defect requires a unionCount base");
  }
  const unionCount = productionRegistry
    .getEngine("counting")
    .enumerateSolutions(parsed).correctAnswer;
  if (typeof unionCount !== "number") {
    throw new Error("counting base has no unique union count");
  }
  const overlapCount = parsed.shapes.reduce(
    (sum, shape) => sum + shape.cells.length,
    0,
  );
  if (unionCount === overlapCount) {
    throw new Error("counting base has equal union and overlap counts");
  }
  const mutatedChoices = replaceChoiceValue(
    base.choices,
    [unionCount, overlapCount],
    base.choices.correctLabel,
  );
  const unionChoice = mutatedChoices.choices.find(
    (choice) => choice.value === unionCount,
  );
  const overlapChoice = mutatedChoices.choices.find(
    (choice) => choice.value === overlapCount,
  );
  if (unionChoice === undefined || overlapChoice === undefined) {
    throw new Error("counting defect did not place both count values");
  }
  const visual = buildVisual(base, parsed, mutatedChoices, "calibration");
  const rules = {
    ...base.visible.rules,
    conventions: [
      ...base.visible.rules.conventions,
      "Conflicting counting convention: count each overlap once overall (union) and also once per shape; both distinct totals are offered and either convention is allowed.",
    ],
  };
  const visible = VisiblePresentationSchema.parse({
    ...base.visible,
    rules,
    options: mutatedChoices.choices.map((choice) => ({
      label: choice.label,
      text: String(choice.value),
    })),
    assets: { svgHash: visual.svgHash, pngHash: visual.pngHash },
  });
  const mutation: CalibrationMutation = {
    kind: "conflicting_counting_conventions",
    description: "The visible rules allow union-once and overlap-once-per-shape counting, and both distinct totals are offered.",
    changedFields: ["rules", "options", "assets"],
    affectedFactIds: ["r-conventions"],
    details: {
      unionCount,
      overlapCount,
      unionLabel: unionChoice.label,
      overlapLabel: overlapChoice.label,
      offeredCounts: [unionCount, overlapCount],
    },
  };
  return {
    visible,
    mutation,
    expected: expectedDefect(
      "CONFLICTING_COUNTING_CONVENTIONS",
      ["rules", "options", "assets"],
      ["r-conventions"],
    ),
    artifacts: {
      visible: { svg: visual.svg, png: visual.png },
      original: originalArtifacts(base),
    },
    original: originalFromBase(base),
  };
}

export function buildFamilyDefect(
  base: CalibrationSoundBase,
): CalibrationMutationResult {
  switch (base.family) {
    case "ranking":
    case "matching":
    case "scheduling":
    case "truth":
    case "arithmetic":
      return buildTextPrimitiveDefect(base);
    case "matrix":
      return buildMatrixDefect(base);
    case "transforms":
      return buildTransformsDefect(base);
    case "paths":
      return buildPathsDefect(base);
    case "symmetry":
      return buildSymmetryDefect(base);
    case "counting":
      return buildCountingDefect(base);
    default: {
      const exhaustive: never = base.family;
      throw new Error(`unsupported calibration family ${String(exhaustive)}`);
    }
  }
}

export { MODALITY_BY_FAMILY, type Family };
