import { z } from "zod";
import {
  D4_OPERATIONS,
  D4OperationSchema,
  type D4Operation,
} from "../contracts.js";

export const TRANSFORM_GRID_SIZE = 5;
export const MIN_TRANSFORM_CELLS = 4;
export const MAX_TRANSFORM_CELLS = 8;

export const TransformCellSchema = z.strictObject({
  row: z.number().int().min(0).max(TRANSFORM_GRID_SIZE - 1),
  column: z.number().int().min(0).max(TRANSFORM_GRID_SIZE - 1),
});

export type TransformCell = z.infer<typeof TransformCellSchema>;

export function compareTransformCells(left: TransformCell, right: TransformCell): number {
  return left.row - right.row || left.column - right.column;
}

export function sortTransformCells(cells: readonly TransformCell[]): TransformCell[] {
  return [...cells].sort(compareTransformCells);
}

export function transformMaskKey(cells: readonly TransformCell[]): string {
  return sortTransformCells(cells)
    .map((cell) => `${cell.row}:${cell.column}`)
    .join("|");
}

export function sameTransformMask(
  left: readonly TransformCell[],
  right: readonly TransformCell[],
): boolean {
  return transformMaskKey(left) === transformMaskKey(right);
}

const transformBitSchema = z.union([z.literal(0), z.literal(1)]);
const transformGridRowSchema = z.tuple([
  transformBitSchema,
  transformBitSchema,
  transformBitSchema,
  transformBitSchema,
  transformBitSchema,
]);

export const TransformSourceSchema = z.tuple([
  transformGridRowSchema,
  transformGridRowSchema,
  transformGridRowSchema,
  transformGridRowSchema,
  transformGridRowSchema,
]);

export type TransformSource = z.infer<typeof TransformSourceSchema>;

export const TransformAnswerSchema = z
  .array(TransformCellSchema)
  .min(1)
  .max(TRANSFORM_GRID_SIZE * TRANSFORM_GRID_SIZE)
  .superRefine((cells, ctx) => {
    let previous: TransformCell | undefined;
    const seen = new Set<string>();
    for (const [index, cell] of cells.entries()) {
      const key = `${cell.row}:${cell.column}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate transform answer cell ${key}`,
        });
      }
      seen.add(key);
      if (previous !== undefined && compareTransformCells(previous, cell) >= 0) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "transform answer cells must be sorted by row then column",
        });
      }
      previous = cell;
    }
  });

export type TransformAnswer = z.infer<typeof TransformAnswerSchema>;

export const TransformsSpecSchema = z
  .strictObject({
    source: TransformSourceSchema,
    operations: z.array(D4OperationSchema).min(1).max(2),
  })
  .superRefine((spec, ctx) => {
    const cells = sourceCellsFromGrid(spec.source);
    if (cells.length < MIN_TRANSFORM_CELLS || cells.length > MAX_TRANSFORM_CELLS) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: `transform sources require ${MIN_TRANSFORM_CELLS} to ${MAX_TRANSFORM_CELLS} occupied cells, received ${cells.length}`,
      });
    }
    if (!isOrthogonallyConnected(cells)) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "transform source occupied cells must be orthogonally connected",
      });
    }
  });

export type TransformsSpec = z.infer<typeof TransformsSpecSchema>;

export function sourceCellsFromGrid(source: TransformSource): TransformCell[] {
  const cells: TransformCell[] = [];
  for (let row = 0; row < TRANSFORM_GRID_SIZE; row += 1) {
    const gridRow = source[row];
    if (gridRow === undefined) {
      continue;
    }
    for (let column = 0; column < TRANSFORM_GRID_SIZE; column += 1) {
      if (gridRow[column] === 1) {
        cells.push({ row, column });
      }
    }
  }
  return cells;
}

export function gridFromCells(cells: readonly TransformCell[]): TransformSource {
  const rows: Array<Array<0 | 1>> = Array.from(
    { length: TRANSFORM_GRID_SIZE },
    () => Array.from({ length: TRANSFORM_GRID_SIZE }, () => 0 as const),
  );
  const seen = new Set<string>();
  for (const cell of cells) {
    if (
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      cell.row < 0 ||
      cell.row >= TRANSFORM_GRID_SIZE ||
      cell.column < 0 ||
      cell.column >= TRANSFORM_GRID_SIZE
    ) {
      throw new RangeError(`transform cell ${cell.row},${cell.column} is outside the 5x5 grid`);
    }
    const key = `${cell.row}:${cell.column}`;
    if (seen.has(key)) {
      throw new RangeError(`transform cell ${key} appears more than once`);
    }
    seen.add(key);
    const row = rows[cell.row];
    if (row === undefined) {
      throw new RangeError(`transform row ${cell.row} is outside the 5x5 grid`);
    }
    row[cell.column] = 1;
  }
  return TransformSourceSchema.parse(rows);
}

export function isOrthogonallyConnected(cells: readonly TransformCell[]): boolean {
  if (cells.length === 0) {
    return false;
  }
  const keys = new Set(cells.map((cell) => `${cell.row}:${cell.column}`));
  if (keys.size !== cells.length) {
    return false;
  }
  const first = cells[0];
  if (first === undefined) {
    return false;
  }
  const visited = new Set<string>();
  const queue: TransformCell[] = [first];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    const key = `${current.row}:${current.column}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    for (const neighbor of orthogonalNeighbors(current)) {
      if (keys.has(`${neighbor.row}:${neighbor.column}`)) {
        queue.push(neighbor);
      }
    }
  }
  return visited.size === cells.length;
}

function orthogonalNeighbors(cell: TransformCell): readonly TransformCell[] {
  return [
    { row: cell.row - 1, column: cell.column },
    { row: cell.row + 1, column: cell.column },
    { row: cell.row, column: cell.column - 1 },
    { row: cell.row, column: cell.column + 1 },
  ];
}

export function applyD4Operation(operation: D4Operation, cell: TransformCell): TransformCell {
  const { row, column } = cell;
  const last = TRANSFORM_GRID_SIZE - 1;
  switch (operation) {
    case "identity":
      return { row, column };
    case "rotate90":
      return { row: column, column: last - row };
    case "rotate180":
      return { row: last - row, column: last - column };
    case "rotate270":
      return { row: last - column, column: row };
    case "reflectLeftRight":
      return { row, column: last - column };
    case "reflectTopBottom":
      return { row: last - row, column };
    case "reflectMainDiagonal":
      return { row: column, column: row };
    case "reflectAntiDiagonal":
      return { row: last - column, column: last - row };
    default:
      throw new Error(`unknown D4 operation ${String(operation)}`);
  }
}

const D4_REFERENCE_POINTS = [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 1, column: 0 },
] as const;

function d4Signature(
  map: (row: number, column: number) => TransformCell,
): string {
  return D4_REFERENCE_POINTS.map((point) => {
    const cell = map(point.row, point.column);
    return `${cell.row}:${cell.column}`;
  }).join("|");
}

const D4_SIGNATURE_LOOKUP = new Map<string, D4Operation>(
  D4_OPERATIONS.map((operation) => [
    d4Signature((row, column) => applyD4Operation(operation, { row, column })),
    operation,
  ]),
);

export function composeD4Operations(
  first: D4Operation,
  second: D4Operation,
): D4Operation {
  const signature = d4Signature((row, column) => {
    const afterFirst = applyD4Operation(first, { row, column });
    return applyD4Operation(second, afterFirst);
  });
  const result = D4_SIGNATURE_LOOKUP.get(signature);
  if (result === undefined) {
    throw new Error(`composition of ${first} and ${second} is not a D4 operation`);
  }
  return result;
}

export function composeD4Sequence(operations: readonly D4Operation[]): D4Operation {
  const first = operations[0];
  if (first === undefined) {
    throw new Error("a transform sequence requires at least one operation");
  }
  let net = first;
  for (let index = 1; index < operations.length; index += 1) {
    const next = operations[index];
    if (next === undefined) {
      throw new Error("a transform sequence contains an undefined operation");
    }
    net = composeD4Operations(net, next);
  }
  return net;
}

export function inverseD4Operation(operation: D4Operation): D4Operation {
  for (const candidate of D4_OPERATIONS) {
    if (composeD4Operations(operation, candidate) === "identity") {
      return candidate;
    }
  }
  throw new Error(`D4 operation ${operation} has no inverse`);
}

export function conjugateD4Operation(
  frame: D4Operation,
  operation: D4Operation,
): D4Operation {
  return composeD4Operations(
    composeD4Operations(inverseD4Operation(frame), operation),
    frame,
  );
}

export function transformCells(
  cells: readonly TransformCell[],
  operations: readonly D4Operation[],
): TransformAnswer {
  let current = sortTransformCells(cells);
  for (const operation of operations) {
    current = sortTransformCells(
      current.map((cell) => applyD4Operation(operation, cell)),
    );
  }
  return TransformAnswerSchema.parse(current);
}

export function checkTransformAnswer(
  spec: TransformsSpec,
  answer: readonly TransformCell[],
): boolean {
  const parsed = TransformsSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return false;
  }
  const parsedAnswer = TransformAnswerSchema.safeParse(answer);
  if (!parsedAnswer.success) {
    return false;
  }
  const expected = transformCells(
    sourceCellsFromGrid(parsed.data.source),
    parsed.data.operations,
  );
  return sameTransformMask(expected, parsedAnswer.data);
}

export function solveTransforms(spec: TransformsSpec): TransformAnswer {
  const parsed = TransformsSpecSchema.parse(spec);
  return transformCells(
    sourceCellsFromGrid(parsed.source),
    parsed.operations,
  );
}
