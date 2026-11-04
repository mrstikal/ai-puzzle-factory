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
  COUNTING_GRID_SIZE,
  CountingSpecSchema,
  sortCountingCells,
  type CountingCell,
  type CountingSpec,
} from "./schema.js";

const LAST = COUNTING_GRID_SIZE - 1;

function transformCell(operation: D4Operation, cell: CountingCell): CountingCell {
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

function permutations(count: number): readonly (readonly number[])[] {
  const result: number[][] = [];
  const current: number[] = [];
  const used = new Set<number>();
  const visit = (): void => {
    if (current.length === count) {
      result.push([...current]);
      return;
    }
    for (let index = 0; index < count; index += 1) {
      if (used.has(index)) {
        continue;
      }
      used.add(index);
      current.push(index);
      visit();
      current.pop();
      used.delete(index);
    }
  };
  visit();
  return result;
}

function canonicalFor(
  spec: CountingSpec,
  frame: D4Operation,
  permutation: readonly number[],
): CanonicalStructure {
  const transformedShapes = spec.shapes.map((shape) =>
    sortCountingCells(shape.cells.map((cell) => transformCell(frame, cell))),
  );
  const masks: number[][] = Array.from({ length: COUNTING_GRID_SIZE }, () =>
    Array.from({ length: COUNTING_GRID_SIZE }, () => 0),
  );
  for (let bitIndex = 0; bitIndex < permutation.length; bitIndex += 1) {
    const shapeIndex = permutation[bitIndex];
    if (shapeIndex === undefined) {
      continue;
    }
    const shape = transformedShapes[shapeIndex];
    if (shape === undefined) {
      continue;
    }
    const bit = 1 << bitIndex;
    for (const cell of shape) {
      const row = masks[cell.row];
      if (row !== undefined) {
        row[cell.column] = (row[cell.column] ?? 0) | bit;
      }
    }
  }
  const maxMask = (1 << permutation.length) - 1;
  const geometryTokens: string[] = [];
  const maskCounts = new Map<number, number>();
  for (let row = 0; row < COUNTING_GRID_SIZE; row += 1) {
    for (let column = 0; column < COUNTING_GRID_SIZE; column += 1) {
      const mask = masks[row]?.[column] ?? 0;
      geometryTokens.push(`cell:${row}:${column}:${mask}`);
      maskCounts.set(mask, (maskCounts.get(mask) ?? 0) + 1);
    }
  }
  const relationTokens: string[] = [];
  for (let mask = 1; mask <= maxMask; mask += 1) {
    relationTokens.push(`region:${mask}:${maskCounts.get(mask) ?? 0}`);
  }
  const queryTokens =
    spec.query.operation === "exactlyKShapes"
      ? [`k=${spec.query.k}`, `operation=${spec.query.operation}`]
      : [`operation=${spec.query.operation}`];
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "counting",
    domainTokens: ["grid=5x5", `shapes=${permutation.length}`],
    queryKind: "membership_count",
    queryTokens: sortedCanonicalTokens(queryTokens),
    relationTokens: sortedCanonicalTokens(relationTokens),
    geometryTokens: sortedCanonicalTokens(geometryTokens),
  });
}

export function canonicalizeCountingSpec(spec: CountingSpec): CanonicalStructure {
  const parsed = CountingSpecSchema.parse(spec);
  const candidates: CanonicalStructure[] = [];
  for (const frame of D4_OPERATIONS) {
    for (const permutation of permutations(parsed.shapes.length)) {
      candidates.push(canonicalFor(parsed, frame, permutation));
    }
  }
  return selectCanonicalStructure(candidates);
}
