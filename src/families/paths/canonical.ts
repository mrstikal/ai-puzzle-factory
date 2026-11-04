import {
  CanonicalStructureSchema,
  D4_OPERATIONS,
  type CanonicalStructure,
  type D4Operation,
} from "../contracts.js";
import {
  selectCanonicalStructure,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  PATH_GRID_SIZE,
  PathsSpecSchema,
  sortPathCells,
  sortPathEdge,
  sortPathEdges,
  type PathCell,
  type PathsSpec,
} from "./schema.js";

const LAST = PATH_GRID_SIZE - 1;

function transformPathCell(operation: D4Operation, cell: PathCell): PathCell {
  const { row, column } = cell;
  switch (operation) {
    case "identity":
      return { row, column };
    case "rotate90":
      return { row: column, column: LAST - row };
    case "rotate180":
      return { row: LAST - row, column: LAST - column };
    case "rotate270":
      return { row: LAST - column, column: row };
    case "reflectLeftRight":
      return { row, column: LAST - column };
    case "reflectTopBottom":
      return { row: LAST - row, column };
    case "reflectMainDiagonal":
      return { row: column, column: row };
    case "reflectAntiDiagonal":
      return { row: LAST - column, column: LAST - row };
    default:
      throw new Error(`unknown D4 operation ${String(operation)}`);
  }
}

export function canonicalizePathsSpec(spec: PathsSpec): CanonicalStructure {
  const parsed = PathsSpecSchema.parse(spec);
  const candidates: CanonicalStructure[] = [];
  for (const frame of D4_OPERATIONS) {
    const transformedActive = parsed.active.map((cell) =>
      transformPathCell(frame, cell),
    );
    const minRow = Math.min(...transformedActive.map((cell) => cell.row));
    const minColumn = Math.min(...transformedActive.map((cell) => cell.column));
    const normalize = (cell: PathCell): PathCell => ({
      row: cell.row - minRow,
      column: cell.column - minColumn,
    });
    const active = sortPathCells(transformedActive.map(normalize));
    const start = normalize(transformPathCell(frame, parsed.start));
    const goal = normalize(transformPathCell(frame, parsed.goal));
    const edges = sortPathEdges(
      parsed.edges.map((edge) =>
        sortPathEdge({
          from: normalize(transformPathCell(frame, edge.from)),
          to: normalize(transformPathCell(frame, edge.to)),
        }),
      ),
    );
    candidates.push(
      CanonicalStructureSchema.parse({
        version: 1,
        family: "paths",
        domainTokens: ["grid=4x4"],
        queryKind: "S_to_G_route",
        queryTokens: sortedCanonicalTokens([
          `goal:${goal.row}:${goal.column}`,
          `start:${start.row}:${start.column}`,
        ]),
        relationTokens: sortedCanonicalTokens(
          edges.map(
            (edge) =>
              `open:${edge.from.row}:${edge.from.column}:${edge.to.row}:${edge.to.column}`,
          ),
        ),
        geometryTokens: sortedCanonicalTokens(
          active.map((cell) => `active:${cell.row}:${cell.column}`),
        ),
      }),
    );
  }
  return selectCanonicalStructure(candidates);
}
