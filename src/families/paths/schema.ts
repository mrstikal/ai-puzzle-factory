import { z } from "zod";
import { SearchCounter } from "../canonicalize.js";

export const PATH_GRID_SIZE = 4;
export const MIN_ACTIVE_CELLS = 6;
export const MAX_ACTIVE_CELLS = 12;
export const MIN_ROUTE_EDGES = 3;
export const MAX_ROUTE_EDGES = 11;
export const MAX_ROUTE_STATES = 200_000;

export const PathCellSchema = z.strictObject({
  row: z.number().int().min(0).max(PATH_GRID_SIZE - 1),
  column: z.number().int().min(0).max(PATH_GRID_SIZE - 1),
});

export type PathCell = z.infer<typeof PathCellSchema>;

export function comparePathCells(left: PathCell, right: PathCell): number {
  return left.row - right.row || left.column - right.column;
}

export function samePathCell(left: PathCell, right: PathCell): boolean {
  return left.row === right.row && left.column === right.column;
}

export function pathCellKey(cell: PathCell): string {
  return `${cell.row}:${cell.column}`;
}

export function sortPathCells(cells: readonly PathCell[]): PathCell[] {
  return [...cells].sort(comparePathCells);
}

export function pathNeighbors(cell: PathCell): readonly PathCell[] {
  return [
    { row: cell.row - 1, column: cell.column },
    { row: cell.row, column: cell.column - 1 },
    { row: cell.row, column: cell.column + 1 },
    { row: cell.row + 1, column: cell.column },
  ];
}

export function isOrthogonallyAdjacent(left: PathCell, right: PathCell): boolean {
  return Math.abs(left.row - right.row) + Math.abs(left.column - right.column) === 1;
}

export const PathRouteSchema = z
  .array(PathCellSchema)
  .min(2)
  .max(PATH_GRID_SIZE * PATH_GRID_SIZE)
  .superRefine((route, ctx) => {
    const seen = new Set<string>();
    for (const [index, cell] of route.entries()) {
      const key = pathCellKey(cell);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `route revisits cell ${key}`,
        });
      }
      seen.add(key);
      if (index > 0) {
        const previous = route[index - 1];
        if (previous !== undefined && !isOrthogonallyAdjacent(previous, cell)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: "route steps must connect orthogonally adjacent cells",
          });
        }
      }
    }
  });

export type PathRoute = z.infer<typeof PathRouteSchema>;

export function pathRouteKey(route: readonly PathCell[]): string {
  return route.map((cell) => pathCellKey(cell)).join("|");
}

export function samePathRoute(left: readonly PathCell[], right: readonly PathCell[]): boolean {
  return pathRouteKey(left) === pathRouteKey(right);
}

export function pathEdgeKey(edge: PathEdge): string {
  return `${pathCellKey(edge.from)}:${pathCellKey(edge.to)}`;
}

export function openEdgeKey(left: PathCell, right: PathCell): string {
  const sorted = comparePathCells(left, right) <= 0 ? [left, right] : [right, left];
  const first = sorted[0];
  const second = sorted[1];
  if (first === undefined || second === undefined) {
    throw new Error("open edge requires two endpoints");
  }
  return `${pathCellKey(first)}:${pathCellKey(second)}`;
}

export function sortPathEdge(edge: PathEdge): PathEdge {
  return comparePathCells(edge.from, edge.to) <= 0
    ? edge
    : { from: edge.to, to: edge.from };
}

export function comparePathEdges(left: PathEdge, right: PathEdge): number {
  return (
    comparePathCells(left.from, right.from) ||
    comparePathCells(left.to, right.to)
  );
}

export function sortPathEdges(edges: readonly PathEdge[]): PathEdge[] {
  return edges.map(sortPathEdge).sort(comparePathEdges);
}

export const PathEdgeSchema = z
  .strictObject({
    from: PathCellSchema,
    to: PathCellSchema,
  })
  .superRefine((edge, ctx) => {
    if (comparePathCells(edge.from, edge.to) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "edge endpoints must be sorted and distinct",
      });
    }
    if (!isOrthogonallyAdjacent(edge.from, edge.to)) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "path edges must connect orthogonally adjacent cells",
      });
    }
  });

export type PathEdge = z.infer<typeof PathEdgeSchema>;

export function buildPathAdjacency(
  active: readonly PathCell[],
  edges: readonly PathEdge[],
): ReadonlyMap<string, readonly PathCell[]> {
  const activeKeys = new Set(active.map((cell) => pathCellKey(cell)));
  const byKey = new Map<string, PathCell>();
  for (const cell of active) {
    byKey.set(pathCellKey(cell), cell);
  }
  const adjacency = new Map<string, PathCell[]>();
  for (const key of activeKeys) {
    adjacency.set(key, []);
  }
  for (const edge of edges) {
    const fromKey = pathCellKey(edge.from);
    const toKey = pathCellKey(edge.to);
    const from = byKey.get(fromKey);
    const to = byKey.get(toKey);
    if (from === undefined || to === undefined) {
      continue;
    }
    adjacency.get(fromKey)?.push(to);
    adjacency.get(toKey)?.push(from);
  }
  for (const [key, neighbors] of adjacency) {
    adjacency.set(key, sortPathCells(neighbors));
  }
  return adjacency;
}

export function findTreeRoute(
  active: readonly PathCell[],
  edges: readonly PathEdge[],
  start: PathCell,
  goal: PathCell,
): PathRoute | undefined {
  const adjacency = buildPathAdjacency(active, edges);
  const startKey = pathCellKey(start);
  const goalKey = pathCellKey(goal);
  const parent = new Map<string, string | undefined>();
  const queue: PathCell[] = [start];
  parent.set(startKey, undefined);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    const currentKey = pathCellKey(current);
    if (currentKey === goalKey) {
      break;
    }
    for (const neighbor of adjacency.get(currentKey) ?? []) {
      const neighborKey = pathCellKey(neighbor);
      if (!parent.has(neighborKey)) {
        parent.set(neighborKey, currentKey);
        queue.push(neighbor);
      }
    }
  }
  if (!parent.has(goalKey)) {
    return undefined;
  }
  const reversed: PathCell[] = [];
  let currentKey: string | undefined = goalKey;
  while (currentKey !== undefined) {
    const [rowText, columnText] = currentKey.split(":");
    const row = Number(rowText);
    const column = Number(columnText);
    reversed.push({ row, column });
    currentKey = parent.get(currentKey);
  }
  const route = reversed.reverse();
  return PathRouteSchema.parse(route);
}

export function treeDistance(
  active: readonly PathCell[],
  edges: readonly PathEdge[],
  start: PathCell,
  goal: PathCell,
): number | undefined {
  const route = findTreeRoute(active, edges, start, goal);
  return route === undefined ? undefined : route.length - 1;
}

function isInsideGrid(cell: PathCell): boolean {
  return (
    cell.row >= 0 &&
    cell.row < PATH_GRID_SIZE &&
    cell.column >= 0 &&
    cell.column < PATH_GRID_SIZE
  );
}

export function enumerateFullGridSimpleRoutes(
  start: PathCell,
  goal: PathCell,
  limit: number = MAX_ROUTE_STATES,
): readonly PathRoute[] {
  const counter = new SearchCounter(limit);
  const routes: PathRoute[] = [];
  const visited = new Set<string>();
  const currentRoute: PathCell[] = [];
  const visit = (current: PathCell): void => {
    counter.consume();
    const key = pathCellKey(current);
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    currentRoute.push(current);
    if (samePathCell(current, goal)) {
      routes.push(PathRouteSchema.parse([...currentRoute]));
    } else {
      for (const neighbor of pathNeighbors(current)) {
        if (isInsideGrid(neighbor) && !visited.has(pathCellKey(neighbor))) {
          visit(neighbor);
        }
      }
    }
    currentRoute.pop();
    visited.delete(key);
  };
  visit(start);
  return routes;
}

export function routeUsesClosedCorridor(
  spec: PathsSpec,
  route: readonly PathCell[],
): boolean {
  const activeKeys = new Set(spec.active.map((cell) => pathCellKey(cell)));
  for (const cell of route) {
    if (!activeKeys.has(pathCellKey(cell))) {
      return true;
    }
  }
  const openEdges = new Set(spec.edges.map((edge) => pathEdgeKey(edge)));
  for (let index = 0; index < route.length - 1; index += 1) {
    const current = route[index];
    const next = route[index + 1];
    if (current === undefined || next === undefined) {
      return true;
    }
    if (!openEdges.has(openEdgeKey(current, next))) {
      return true;
    }
  }
  return false;
}

export function checkPathAnswer(spec: PathsSpec, route: readonly PathCell[]): boolean {
  const parsedSpec = PathsSpecSchema.safeParse(spec);
  const parsedRoute = PathRouteSchema.safeParse(route);
  if (!parsedSpec.success || !parsedRoute.success) {
    return false;
  }
  const start = parsedRoute.data[0];
  const goal = parsedRoute.data[parsedRoute.data.length - 1];
  if (
    start === undefined ||
    goal === undefined ||
    !samePathCell(start, parsedSpec.data.start) ||
    !samePathCell(goal, parsedSpec.data.goal)
  ) {
    return false;
  }
  if (routeUsesClosedCorridor(parsedSpec.data, parsedRoute.data)) {
    return false;
  }
  const expected = findTreeRoute(
    parsedSpec.data.active,
    parsedSpec.data.edges,
    parsedSpec.data.start,
    parsedSpec.data.goal,
  );
  return expected !== undefined && samePathRoute(expected, parsedRoute.data);
}

export const PathsSpecSchema = z
  .strictObject({
    active: z.array(PathCellSchema).min(MIN_ACTIVE_CELLS).max(MAX_ACTIVE_CELLS),
    edges: z.array(PathEdgeSchema).min(MIN_ACTIVE_CELLS - 1).max(MAX_ACTIVE_CELLS - 1),
    start: PathCellSchema,
    goal: PathCellSchema,
  })
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    const activeKeys = new Set<string>();
    let previousCell: PathCell | undefined;
    for (const [index, cell] of spec.active.entries()) {
      const key = pathCellKey(cell);
      if (activeKeys.has(key)) {
        issue(["active", index], `duplicate active cell ${key}`);
      }
      activeKeys.add(key);
      if (previousCell !== undefined && comparePathCells(previousCell, cell) >= 0) {
        issue(["active", index], "active cells must be sorted by row then column");
      }
      previousCell = cell;
    }
    if (spec.edges.length !== spec.active.length - 1) {
      issue(["edges"], "a path tree requires exactly activeCells-1 open edges");
    }
    const edgeKeys = new Set<string>();
    let previousEdge: PathEdge | undefined;
    for (const [index, edge] of spec.edges.entries()) {
      const key = pathEdgeKey(edge);
      if (edgeKeys.has(key)) {
        issue(["edges", index], `duplicate path edge ${key}`);
      }
      edgeKeys.add(key);
      if (previousEdge !== undefined && comparePathEdges(previousEdge, edge) >= 0) {
        issue(["edges", index], "path edges must be sorted by endpoint");
      }
      previousEdge = edge;
      if (
        !activeKeys.has(pathCellKey(edge.from)) ||
        !activeKeys.has(pathCellKey(edge.to))
      ) {
        issue(["edges", index], "path edge endpoints must be active cells");
      }
    }
    if (!activeKeys.has(pathCellKey(spec.start))) {
      issue(["start"], "start must be an active cell");
    }
    if (!activeKeys.has(pathCellKey(spec.goal))) {
      issue(["goal"], "goal must be an active cell");
    }
    if (samePathCell(spec.start, spec.goal)) {
      issue(["goal"], "start and goal must be distinct");
    }
    const firstActive = spec.active[0];
    if (firstActive !== undefined) {
      const adjacency = buildPathAdjacency(spec.active, spec.edges);
      const visited = new Set<string>([pathCellKey(firstActive)]);
      const queue: PathCell[] = [firstActive];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) {
          continue;
        }
        for (const neighbor of adjacency.get(pathCellKey(current)) ?? []) {
          const key = pathCellKey(neighbor);
          if (!visited.has(key)) {
            visited.add(key);
            queue.push(neighbor);
          }
        }
      }
      if (visited.size !== spec.active.length) {
        issue(["edges"], "active cells must form one connected tree");
      }
    }
    if (
      !samePathCell(spec.start, spec.goal) &&
      activeKeys.has(pathCellKey(spec.start)) &&
      activeKeys.has(pathCellKey(spec.goal))
    ) {
      const route = findTreeRoute(spec.active, spec.edges, spec.start, spec.goal);
      if (route === undefined) {
        issue(["goal"], "start and goal must be connected by open edges");
      } else {
        const routeLength = route.length - 1;
        if (routeLength < MIN_ROUTE_EDGES || routeLength > MAX_ROUTE_EDGES) {
          issue(
            ["goal"],
            `start-to-goal route must have ${MIN_ROUTE_EDGES} to ${MAX_ROUTE_EDGES} edges`,
          );
        }
      }
    }
  });

export type PathsSpec = z.infer<typeof PathsSpecSchema>;

export function activeCellsFromSpec(spec: PathsSpec): readonly PathCell[] {
  return sortPathCells(spec.active);
}
