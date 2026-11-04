import { z } from "zod";

export const SYMMETRY_GRID_SIZE = 8;
export const SYMMETRY_HALF_SIZE = SYMMETRY_GRID_SIZE / 2;
export const MIN_KNOWN_OCCUPIED = 4;
export const MAX_KNOWN_OCCUPIED = 10;

export const SymmetryAxisSchema = z.enum(["vertical", "horizontal"]);
export type SymmetryAxis = z.infer<typeof SymmetryAxisSchema>;

export const SymmetryCellStateSchema = z.enum(["occupied", "empty", "unknown"]);
export type SymmetryCellState = z.infer<typeof SymmetryCellStateSchema>;

export const SymmetryCellSchema = z.strictObject({
  row: z.number().int().min(0).max(SYMMETRY_GRID_SIZE - 1),
  column: z.number().int().min(0).max(SYMMETRY_GRID_SIZE - 1),
});
export type SymmetryCell = z.infer<typeof SymmetryCellSchema>;

export function compareSymmetryCells(
  left: SymmetryCell,
  right: SymmetryCell,
): number {
  return left.row - right.row || left.column - right.column;
}

export function sameSymmetryCell(left: SymmetryCell, right: SymmetryCell): boolean {
  return left.row === right.row && left.column === right.column;
}

export function symmetryCellKey(cell: SymmetryCell): string {
  return `${cell.row}:${cell.column}`;
}

export function isKnownSymmetryCell(axis: SymmetryAxis, cell: SymmetryCell): boolean {
  return axis === "vertical"
    ? cell.column < SYMMETRY_HALF_SIZE
    : cell.row < SYMMETRY_HALF_SIZE;
}

export function mirrorSymmetryCell(
  axis: SymmetryAxis,
  cell: SymmetryCell,
): SymmetryCell {
  return axis === "vertical"
    ? { row: cell.row, column: SYMMETRY_GRID_SIZE - 1 - cell.column }
    : { row: SYMMETRY_GRID_SIZE - 1 - cell.row, column: cell.column };
}

export function knownSymmetryCells(axis: SymmetryAxis): readonly SymmetryCell[] {
  const cells: SymmetryCell[] = [];
  for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
    for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
      const cell = { row, column };
      if (isKnownSymmetryCell(axis, cell)) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

export function missingSymmetryCells(axis: SymmetryAxis): readonly SymmetryCell[] {
  const cells: SymmetryCell[] = [];
  for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
    for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
      const cell = { row, column };
      if (!isKnownSymmetryCell(axis, cell)) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

const symmetryStateRowSchema = z
  .array(SymmetryCellStateSchema)
  .length(SYMMETRY_GRID_SIZE);

export const SymmetryGridSchema = z
  .array(symmetryStateRowSchema)
  .length(SYMMETRY_GRID_SIZE);
export type SymmetryGrid = z.infer<typeof SymmetryGridSchema>;

const symmetryBitSchema = z.union([z.literal(0), z.literal(1)]);
const symmetryAnswerRowSchema = z
  .array(symmetryBitSchema)
  .length(SYMMETRY_GRID_SIZE);

export const SymmetryAnswerSchema = z
  .array(symmetryAnswerRowSchema)
  .length(SYMMETRY_GRID_SIZE);
export type SymmetryAnswer = z.infer<typeof SymmetryAnswerSchema>;

export const SymmetrySpecSchema = z
  .strictObject({
    axis: SymmetryAxisSchema,
    cells: SymmetryGridSchema,
  })
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    let occupied = 0;
    for (let row = 0; row < SYMMETRY_GRID_SIZE; row += 1) {
      for (let column = 0; column < SYMMETRY_GRID_SIZE; column += 1) {
        const cell = { row, column };
        const state = spec.cells[row]?.[column];
        if (state === undefined) {
          continue;
        }
        if (isKnownSymmetryCell(spec.axis, cell)) {
          if (state === "unknown") {
            issue(
              ["cells", row, column],
              "known-half cells must be occupied or explicitly empty",
            );
          }
          if (state === "occupied") {
            occupied += 1;
          }
        } else if (state !== "unknown") {
          issue(
            ["cells", row, column],
            "missing-half cells must use the unknown state",
          );
        }
      }
    }
    if (occupied < MIN_KNOWN_OCCUPIED || occupied > MAX_KNOWN_OCCUPIED) {
      issue(
        ["cells"],
        `known half requires ${MIN_KNOWN_OCCUPIED} to ${MAX_KNOWN_OCCUPIED} occupied cells, received ${occupied}`,
      );
    }
  });

export type SymmetrySpec = z.infer<typeof SymmetrySpecSchema>;

export function symmetryStateAt(spec: SymmetrySpec, cell: SymmetryCell): SymmetryCellState {
  const state = spec.cells[cell.row]?.[cell.column];
  if (state === undefined) {
    throw new RangeError(`symmetry cell ${symmetryCellKey(cell)} is outside the grid`);
  }
  return state;
}

export function knownOccupiedCells(spec: SymmetrySpec): readonly SymmetryCell[] {
  const cells: SymmetryCell[] = [];
  for (const cell of knownSymmetryCells(spec.axis)) {
    if (symmetryStateAt(spec, cell) === "occupied") {
      cells.push(cell);
    }
  }
  return cells;
}

export function knownEmptyCells(spec: SymmetrySpec): readonly SymmetryCell[] {
  const cells: SymmetryCell[] = [];
  for (const cell of knownSymmetryCells(spec.axis)) {
    if (symmetryStateAt(spec, cell) === "empty") {
      cells.push(cell);
    }
  }
  return cells;
}

export function symmetryAnswerKey(answer: readonly (readonly number[])[]): string {
  return answer.map((row) => row.join("")).join("|");
}

export function cloneSymmetryAnswer(answer: SymmetryAnswer): SymmetryAnswer {
  return SymmetryAnswerSchema.parse(answer.map((row) => [...row]));
}

export function completeSymmetry(spec: SymmetrySpec): SymmetryAnswer {
  const parsed = SymmetrySpecSchema.parse(spec);
  const grid: Array<Array<0 | 1>> = Array.from(
    { length: SYMMETRY_GRID_SIZE },
    () => Array.from({ length: SYMMETRY_GRID_SIZE }, () => 0 as const),
  );
  for (const cell of knownOccupiedCells(parsed)) {
    const row = grid[cell.row];
    if (row === undefined) {
      throw new RangeError(`symmetry row ${cell.row} is outside the grid`);
    }
    row[cell.column] = 1;
    const mirror = mirrorSymmetryCell(parsed.axis, cell);
    const mirrorRow = grid[mirror.row];
    if (mirrorRow === undefined) {
      throw new RangeError(`symmetry row ${mirror.row} is outside the grid`);
    }
    mirrorRow[mirror.column] = 1;
  }
  return SymmetryAnswerSchema.parse(grid);
}

export function checkSymmetryAnswer(
  spec: SymmetrySpec,
  answer: readonly (readonly number[])[],
): boolean {
  const parsedSpec = SymmetrySpecSchema.safeParse(spec);
  const parsedAnswer = SymmetryAnswerSchema.safeParse(answer);
  if (!parsedSpec.success || !parsedAnswer.success) {
    return false;
  }
  for (const cell of knownSymmetryCells(parsedSpec.data.axis)) {
    const expected =
      symmetryStateAt(parsedSpec.data, cell) === "occupied" ? 1 : 0;
    if (parsedAnswer.data[cell.row]?.[cell.column] !== expected) {
      return false;
    }
  }
  for (const cell of missingSymmetryCells(parsedSpec.data.axis)) {
    const mirror = mirrorSymmetryCell(parsedSpec.data.axis, cell);
    if (
      parsedAnswer.data[cell.row]?.[cell.column] !==
      parsedAnswer.data[mirror.row]?.[mirror.column]
    ) {
      return false;
    }
  }
  return true;
}

export function symmetryKnownComponents(
  axis: SymmetryAxis,
  occupied: readonly SymmetryCell[],
): number {
  const occupiedKeys = new Set(occupied.map((cell) => symmetryCellKey(cell)));
  const visited = new Set<string>();
  let components = 0;
  for (const start of occupied) {
    const startKey = symmetryCellKey(start);
    if (visited.has(startKey)) {
      continue;
    }
    components += 1;
    const queue: SymmetryCell[] = [start];
    visited.add(startKey);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      for (const neighbor of [
        { row: current.row - 1, column: current.column },
        { row: current.row + 1, column: current.column },
        { row: current.row, column: current.column - 1 },
        { row: current.row, column: current.column + 1 },
      ]) {
        if (
          neighbor.row < 0 ||
          neighbor.row >= SYMMETRY_GRID_SIZE ||
          neighbor.column < 0 ||
          neighbor.column >= SYMMETRY_GRID_SIZE ||
          !isKnownSymmetryCell(axis, neighbor)
        ) {
          continue;
        }
        const key = symmetryCellKey(neighbor);
        if (occupiedKeys.has(key) && !visited.has(key)) {
          visited.add(key);
          queue.push(neighbor);
        }
      }
    }
  }
  return components;
}
