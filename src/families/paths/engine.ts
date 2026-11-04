import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import {
  formatFactId,
  type Fact,
  type FamilyEngine,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizePathsSpec } from "./canonical.js";
import {
  MAX_ROUTE_EDGES,
  MIN_ROUTE_EDGES,
  PATH_GRID_SIZE,
  PathsSpecSchema,
  buildPathAdjacency,
  checkPathAnswer,
  comparePathCells,
  enumerateFullGridSimpleRoutes,
  findTreeRoute,
  pathCellKey,
  pathNeighbors,
  pathRouteKey,
  routeUsesClosedCorridor,
  samePathCell,
  sortPathCells,
  sortPathEdge,
  sortPathEdges,
  treeDistance,
  type PathCell,
  type PathEdge,
  type PathRoute,
  type PathsSpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const MAX_CONSTRUCTION_ATTEMPTS = 16;

interface SizeRange {
  readonly min: number;
  readonly max: number;
}

const ACTIVE_SIZE_BY_DIFFICULTY: Readonly<Record<Difficulty, SizeRange>> = {
  1: { min: 6, max: 8 },
  2: { min: 7, max: 10 },
  3: { min: 9, max: 12 },
};

const ROUTE_RANGE_BY_DIFFICULTY: Readonly<Record<Difficulty, SizeRange>> = {
  1: { min: 3, max: 5 },
  2: { min: 5, max: 7 },
  3: { min: 7, max: 11 },
};

export type PathsConstructionErrorCode =
  | "DRAW_LIMIT"
  | "CONSTRAINTS_FAILED"
  | "INVALID_DIFFICULTY";

export class PathsConstructionError extends Error {
  readonly code: PathsConstructionErrorCode;

  constructor(
    code: PathsConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PathsConstructionError";
    this.code = code;
  }
}

export type PathsEngineErrorCode =
  | "INVALID_ANSWER"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class PathsEngineError extends Error {
  readonly code: PathsEngineErrorCode;

  constructor(code: PathsEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathsEngineError";
    this.code = code;
  }
}

class DrawBudget {
  private readonly prng: HashCounterPrng;
  private draws = 0;

  constructor(prng: HashCounterPrng) {
    this.prng = prng;
  }

  get used(): number {
    return this.draws;
  }

  nextInt(maxExclusive: number): number {
    if (this.draws >= MAX_CONSTRUCTION_DRAWS) {
      throw new PathsConstructionError(
        "DRAW_LIMIT",
        `path construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }
}

function pick<T>(draw: DrawBudget, items: readonly T[], description: string): T {
  const selected = items[draw.nextInt(items.length)];
  if (selected === undefined) {
    throw new PathsConstructionError(
      "CONSTRAINTS_FAILED",
      `path construction could not draw ${description}`,
    );
  }
  return selected;
}

function isInsideGrid(cell: PathCell): boolean {
  return (
    cell.row >= 0 &&
    cell.row < PATH_GRID_SIZE &&
    cell.column >= 0 &&
    cell.column < PATH_GRID_SIZE
  );
}

function drawConnectedActive(
  draw: DrawBudget,
  difficulty: Difficulty,
): readonly PathCell[] {
  const range = ACTIVE_SIZE_BY_DIFFICULTY[difficulty];
  const targetSize = range.min + draw.nextInt(range.max - range.min + 1);
  const startIndex = draw.nextInt(PATH_GRID_SIZE * PATH_GRID_SIZE);
  const occupied = new Set<number>([startIndex]);
  while (occupied.size < targetSize) {
    const frontier = new Set<number>();
    for (const index of occupied) {
      const cell = {
        row: Math.floor(index / PATH_GRID_SIZE),
        column: index % PATH_GRID_SIZE,
      };
      for (const neighbor of pathNeighbors(cell)) {
        if (!isInsideGrid(neighbor)) {
          continue;
        }
        const neighborIndex = neighbor.row * PATH_GRID_SIZE + neighbor.column;
        if (!occupied.has(neighborIndex)) {
          frontier.add(neighborIndex);
        }
      }
    }
    const candidates = [...frontier].sort((left, right) => left - right);
    if (candidates.length === 0) {
      throw new PathsConstructionError(
        "CONSTRAINTS_FAILED",
        "connected path growth has no available neighbor",
      );
    }
    const selected = candidates[draw.nextInt(candidates.length)];
    if (selected === undefined) {
      throw new PathsConstructionError(
        "CONSTRAINTS_FAILED",
        "connected path growth failed to select a neighbor",
      );
    }
    occupied.add(selected);
  }
  return sortPathCells(
    [...occupied].map((index) => ({
      row: Math.floor(index / PATH_GRID_SIZE),
      column: index % PATH_GRID_SIZE,
    })),
  );
}

function drawSpanningTree(
  draw: DrawBudget,
  active: readonly PathCell[],
): readonly PathEdge[] {
  const activeKeys = new Set(active.map((cell) => pathCellKey(cell)));
  const start = pick(draw, active, "a spanning-tree root");
  const visited = new Set<string>([pathCellKey(start)]);
  const stack: PathCell[] = [start];
  const edges: PathEdge[] = [];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    if (current === undefined) {
      break;
    }
    const candidates = pathNeighbors(current)
      .filter((neighbor) => isInsideGrid(neighbor))
      .filter((neighbor) => activeKeys.has(pathCellKey(neighbor)))
      .filter((neighbor) => !visited.has(pathCellKey(neighbor)))
      .sort(comparePathCells);
    if (candidates.length === 0) {
      stack.pop();
      continue;
    }
    const next = pick(draw, candidates, "a spanning-tree child");
    edges.push(sortPathEdge({ from: current, to: next }));
    visited.add(pathCellKey(next));
    stack.push(next);
  }
  if (visited.size !== active.length) {
    throw new PathsConstructionError(
      "CONSTRAINTS_FAILED",
      "seeded spanning tree did not reach every active cell",
    );
  }
  return sortPathEdges(edges);
}

interface EndpointChoice {
  readonly start: PathCell;
  readonly goal: PathCell;
  readonly distance: number;
}

function chooseEndpoints(
  draw: DrawBudget,
  active: readonly PathCell[],
  edges: readonly PathEdge[],
  range: SizeRange,
): EndpointChoice | undefined {
  const candidates: EndpointChoice[] = [];
  for (const start of active) {
    for (const goal of active) {
      if (samePathCell(start, goal)) {
        continue;
      }
      const distance = treeDistance(active, edges, start, goal);
      if (
        distance !== undefined &&
        distance >= range.min &&
        distance <= range.max
      ) {
        candidates.push({ start, goal, distance });
      }
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  return pick(draw, candidates, "start and goal endpoints");
}

function falseRoutesFor(spec: PathsSpec): readonly PathRoute[] {
  const correct = findTreeRoute(spec.active, spec.edges, spec.start, spec.goal);
  const correctKey = correct === undefined ? undefined : pathRouteKey(correct);
  return enumerateFullGridSimpleRoutes(spec.start, spec.goal)
    .filter((route) => pathRouteKey(route) !== correctKey)
    .filter((route) => routeUsesClosedCorridor(spec, route))
    .sort((left, right) => {
      const leftKey = pathRouteKey(left);
      const rightKey = pathRouteKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

export interface PathsConstructionTrace {
  readonly difficulty: Difficulty;
  readonly attempts: number;
  readonly activeSize: number;
  readonly routeLength: number;
  readonly falseRouteCount: number;
  readonly drawsUsed: number;
}

export interface PathsConstructionResult {
  readonly spec: PathsSpec;
  readonly trace: PathsConstructionTrace;
}

export function constructPathsSpec(
  seed: string,
  difficulty: Difficulty,
): PathsConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new PathsConstructionError(
      "INVALID_DIFFICULTY",
      `path difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const routeRange = ROUTE_RANGE_BY_DIFFICULTY[difficulty];
  let attempts = 0;
  while (attempts < MAX_CONSTRUCTION_ATTEMPTS) {
    attempts += 1;
    const active = drawConnectedActive(draw, difficulty);
    const edges = drawSpanningTree(draw, active);
    const endpoints = chooseEndpoints(draw, active, edges, routeRange);
    if (endpoints === undefined) {
      continue;
    }
    const spec = PathsSpecSchema.parse({
      active,
      edges,
      start: endpoints.start,
      goal: endpoints.goal,
    });
    const falseRoutes = falseRoutesFor(spec);
    if (falseRoutes.length < 3) {
      continue;
    }
    return {
      spec,
      trace: {
        difficulty,
        attempts,
        activeSize: active.length,
        routeLength: endpoints.distance,
        falseRouteCount: falseRoutes.length,
        drawsUsed: draw.used,
      },
    };
  }
  throw new PathsConstructionError(
    "CONSTRAINTS_FAILED",
    `path construction failed after ${attempts} bounded attempts`,
  );
}

function solvePath(spec: PathsSpec): PathRoute | undefined {
  const parsed = PathsSpecSchema.parse(spec);
  return findTreeRoute(parsed.active, parsed.edges, parsed.start, parsed.goal);
}

function enumerateSolutions(spec: PathsSpec): SolveResult<PathRoute> {
  const parsed = PathsSpecSchema.parse(spec);
  const route = findTreeRoute(parsed.active, parsed.edges, parsed.start, parsed.goal);
  if (route === undefined) {
    return {
      solutionCount: 0,
      answerCount: 0,
      correctAnswer: null,
      proof: null,
      enumeratedStates: parsed.active.length,
      checkerVersion: "paths-v1",
    };
  }
  return {
    solutionCount: 1,
    answerCount: 1,
    correctAnswer: route,
    proof: {
      facts: [
        {
          factId: "s001",
          kind: "derived",
          text: `The unique tree route has ${route.length - 1} open edges: ${route
            .map((cell) => `(${cell.row + 1},${cell.column + 1})`)
            .join(" -> ")}.`,
        },
      ],
      witness: route,
    },
    enumeratedStates: parsed.active.length,
    checkerVersion: "paths-v1",
  };
}

function verifyAnswer(spec: PathsSpec, answer: PathRoute): boolean {
  return checkPathAnswer(spec, answer);
}

function makeOptions(
  spec: PathsSpec,
  answer: PathRoute,
  seed: string,
): ChoiceSet<PathRoute> {
  const parsed = PathsSpecSchema.parse(spec);
  const correct = solvePath(parsed);
  if (correct === undefined || !deepEqual(correct, answer)) {
    throw new PathsEngineError(
      "INVALID_ANSWER",
      "path options require the unique tree route",
    );
  }
  const falseRoutes = falseRoutesFor(parsed);
  if (falseRoutes.length < 3) {
    throw new PathsEngineError(
      "INSUFFICIENT_DISTRACTORS",
      `path full-grid pool has only ${falseRoutes.length} false routes`,
    );
  }
  const shuffled = new HashCounterPrng(seed).shuffle(falseRoutes);
  const first = shuffled[0];
  const second = shuffled[1];
  const third = shuffled[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new PathsEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "path option construction lost a false route",
    );
  }
  const choices = makeChoiceSet({
    correct,
    distractors: [first, second, third],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    if (verifyAnswer(parsed, choice.value)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new PathsEngineError(
      "INVALID_OPTION_SET",
      `path option set contains ${trueChoices} satisfying routes`,
    );
  }
  return choices;
}

function visibleRules(spec: PathsSpec): VisibleRules {
  PathsSpecSchema.parse(spec);
  return {
    domain:
      "A 4x4 grid contains 6 to 12 active cells connected by open orthogonal corridors; the active graph is a tree with distinct start and goal cells.",
    closedWorld:
      "Movement is only between orthogonally adjacent cell centers through drawn open corridors. Diagonal moves, corner cuts, closed corridors, and cells outside the active tree are not traversable. All choices use the same maze.",
    target:
      "Choose the complete start-to-goal route that uses only open corridors and visits no cell twice.",
    operations: [
      "A route lists cell centers from S to G in order.",
      "Consecutive route cells must share a drawn open corridor.",
      "No cell may appear twice in a route.",
      "The active graph is a tree, so exactly one valid S-to-G route exists.",
      "Start and goal are distinct and marked S and G.",
    ],
    conventions: [
      "Rows and columns in the text are 1-based from the top-left; S marks the start and G marks the goal.",
      "Open corridors are undirected; a closed edge is a wall.",
      "All four choices use the same maze and the same cell centers.",
    ],
  };
}

function facts(spec: PathsSpec): readonly Fact[] {
  const parsed = PathsSpecSchema.parse(spec);
  const observations: string[] = [];
  for (const cell of parsed.active) {
    observations.push(
      `Cell row ${cell.row + 1}, column ${cell.column + 1} is active.`,
    );
  }
  for (const edge of parsed.edges) {
    observations.push(
      `Open corridor between row ${edge.from.row + 1}, column ${
        edge.from.column + 1
      } and row ${edge.to.row + 1}, column ${edge.to.column + 1}.`,
    );
  }
  observations.push(
    `Start marker S is at row ${parsed.start.row + 1}, column ${
      parsed.start.column + 1
    }.`,
  );
  observations.push(
    `Goal marker G is at row ${parsed.goal.row + 1}, column ${
      parsed.goal.column + 1
    }.`,
  );
  return observations.map((text, index) => ({
    factId: formatFactId("observation", index),
    kind: "observation" as const,
    text,
  }));
}

function testMutations(spec: PathsSpec): readonly TestMutation<PathsSpec>[] {
  const parsed = PathsSpecSchema.parse(spec);
  const mutations: TestMutation<PathsSpec>[] = [
    {
      id: "swapped-endpoints",
      description: "the start and goal markers are exchanged",
      spec: PathsSpecSchema.parse({
        active: parsed.active,
        edges: parsed.edges,
        start: parsed.goal,
        goal: parsed.start,
      }),
    },
  ];
  const alternateGoals = parsed.active
    .filter(
      (cell) =>
        !samePathCell(cell, parsed.start) && !samePathCell(cell, parsed.goal),
    )
    .map((cell) => ({
      cell,
      distance: treeDistance(parsed.active, parsed.edges, parsed.start, cell),
    }))
    .filter(
      (
        candidate,
      ): candidate is { readonly cell: PathCell; readonly distance: number } =>
        candidate.distance !== undefined &&
        candidate.distance >= MIN_ROUTE_EDGES &&
        candidate.distance <= MAX_ROUTE_EDGES,
    )
    .sort((left, right) => comparePathCells(left.cell, right.cell));
  const alternate = alternateGoals[0];
  if (alternate !== undefined) {
    mutations.push({
      id: "relocated-goal",
      description: "the goal marker moves to another active cell",
      spec: PathsSpecSchema.parse({
        active: parsed.active,
        edges: parsed.edges,
        start: parsed.start,
        goal: alternate.cell,
      }),
    });
  }
  return mutations;
}

export const pathsEngine: FamilyEngine<PathsSpec, PathRoute> = {
  family: "paths",
  modality: "svg",
  schema: PathsSpecSchema,
  generateSpec(seed, difficulty) {
    return constructPathsSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizePathsSpec(spec);
  },
  testMutations,
};

export {
  buildPathAdjacency,
  enumerateFullGridSimpleRoutes,
  findTreeRoute,
  routeUsesClosedCorridor,
  treeDistance,
  type PathCell,
  type PathEdge,
  type PathRoute,
  type PathsSpec,
};
