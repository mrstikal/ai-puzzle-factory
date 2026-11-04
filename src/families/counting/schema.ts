import { z } from "zod";

export const COUNTING_GRID_SIZE = 5;
export const MIN_SHAPE_CELLS = 3;
export const MAX_SHAPE_CELLS = 8;

export const CountingCellSchema = z.strictObject({
  row: z.number().int().min(0).max(COUNTING_GRID_SIZE - 1),
  column: z.number().int().min(0).max(COUNTING_GRID_SIZE - 1),
});
export type CountingCell = z.infer<typeof CountingCellSchema>;

export function compareCountingCells(
  left: CountingCell,
  right: CountingCell,
): number {
  return left.row - right.row || left.column - right.column;
}

export function countingCellKey(cell: CountingCell): string {
  return `${cell.row}:${cell.column}`;
}

export function sortCountingCells(cells: readonly CountingCell[]): CountingCell[] {
  return [...cells].sort(compareCountingCells);
}

function isOrthogonallyConnected(cells: readonly CountingCell[]): boolean {
  if (cells.length === 0) {
    return false;
  }
  const keys = new Set(cells.map((cell) => countingCellKey(cell)));
  const first = cells[0];
  if (first === undefined) {
    return false;
  }
  const visited = new Set<string>();
  const queue: CountingCell[] = [first];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    const key = countingCellKey(current);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    for (const neighbor of [
      { row: current.row - 1, column: current.column },
      { row: current.row + 1, column: current.column },
      { row: current.row, column: current.column - 1 },
      { row: current.row, column: current.column + 1 },
    ]) {
      if (keys.has(countingCellKey(neighbor))) {
        queue.push(neighbor);
      }
    }
  }
  return visited.size === cells.length;
}

export const CountingShapeSchema = z
  .strictObject({
    cells: z
      .array(CountingCellSchema)
      .min(MIN_SHAPE_CELLS)
      .max(MAX_SHAPE_CELLS),
  })
  .superRefine((shape, ctx) => {
    const seen = new Set<string>();
    let previous: CountingCell | undefined;
    for (const [index, cell] of shape.cells.entries()) {
      const key = countingCellKey(cell);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["cells", index],
          message: `duplicate shape cell ${key}`,
        });
      }
      seen.add(key);
      if (previous !== undefined && compareCountingCells(previous, cell) >= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["cells", index],
          message: "shape cells must be sorted by row then column",
        });
      }
      previous = cell;
    }
    if (!isOrthogonallyConnected(shape.cells)) {
      ctx.addIssue({
        code: "custom",
        path: ["cells"],
        message: "shape cells must be one orthogonally connected set",
      });
    }
  });
export type CountingShape = z.infer<typeof CountingShapeSchema>;

export const CountingOperationSchema = z.enum([
  "unionCount",
  "intersectionAll",
  "exactlyOneShape",
  "exactlyKShapes",
]);
export type CountingOperation = z.infer<typeof CountingOperationSchema>;

export const CountingQuerySchema = z
  .strictObject({
    operation: CountingOperationSchema,
    k: z.union([z.literal(2), z.literal(3)]).optional(),
  })
  .superRefine((query, ctx) => {
    const hasK = query.k !== undefined;
    if (query.operation === "exactlyKShapes" && !hasK) {
      ctx.addIssue({
        code: "custom",
        path: ["k"],
        message: "exactlyKShapes requires k=2 or k=3",
      });
    }
    if (query.operation !== "exactlyKShapes" && hasK) {
      ctx.addIssue({
        code: "custom",
        path: ["k"],
        message: "k is allowed only for exactlyKShapes",
      });
    }
  });
export type CountingQuery = z.infer<typeof CountingQuerySchema>;

export const CountingAnswerSchema = z.number().int().min(0).max(25);
export type CountingAnswer = z.infer<typeof CountingAnswerSchema>;

export function shapeKey(shape: CountingShape): string {
  return shape.cells.map((cell) => countingCellKey(cell)).join("|");
}

export function shapeSet(shape: CountingShape): ReadonlySet<string> {
  return new Set(shape.cells.map((cell) => countingCellKey(cell)));
}

export function shapeMembershipCounts(spec: CountingSpec): readonly (readonly number[])[] {
  const counts: number[][] = Array.from({ length: COUNTING_GRID_SIZE }, () =>
    Array.from({ length: COUNTING_GRID_SIZE }, () => 0),
  );
  for (const shape of spec.shapes) {
    for (const cell of shape.cells) {
      const row = counts[cell.row];
      if (row !== undefined) {
        row[cell.column] = (row[cell.column] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export function membershipMaskGrid(spec: CountingSpec): readonly (readonly number[])[] {
  const masks: number[][] = Array.from({ length: COUNTING_GRID_SIZE }, () =>
    Array.from({ length: COUNTING_GRID_SIZE }, () => 0),
  );
  for (const [shapeIndex, shape] of spec.shapes.entries()) {
    const bit = 1 << shapeIndex;
    for (const cell of shape.cells) {
      const row = masks[cell.row];
      if (row !== undefined) {
        row[cell.column] = (row[cell.column] ?? 0) | bit;
      }
    }
  }
  return masks;
}

export function popcount(value: number): number {
  let count = 0;
  let remaining = value;
  while (remaining > 0) {
    count += remaining & 1;
    remaining >>>= 1;
  }
  return count;
}

export function countQueryByMembership(spec: CountingSpec): CountingAnswer {
  const masks = membershipMaskGrid(spec);
  let count = 0;
  for (const row of masks) {
    for (const mask of row) {
      switch (spec.query.operation) {
        case "unionCount":
          if (mask > 0) {
            count += 1;
          }
          break;
        case "intersectionAll":
          if (mask === (1 << spec.shapes.length) - 1) {
            count += 1;
          }
          break;
        case "exactlyOneShape":
          if (popcount(mask) === 1) {
            count += 1;
          }
          break;
        case "exactlyKShapes":
          if (popcount(mask) === (spec.query.k ?? -1)) {
            count += 1;
          }
          break;
      }
    }
  }
  return CountingAnswerSchema.parse(count);
}

export function countQueryBySets(spec: CountingSpec): CountingAnswer {
  const sets = spec.shapes.map((shape) => shapeSet(shape));
  const allCells = new Set<string>();
  for (const set of sets) {
    for (const cell of set) {
      allCells.add(cell);
    }
  }
  let count = 0;
  if (spec.query.operation === "unionCount") {
    count = allCells.size;
  } else if (spec.query.operation === "intersectionAll") {
    const first = sets[0];
    if (first !== undefined) {
      count = [...first].filter((cell) =>
        sets.every((set) => set.has(cell)),
      ).length;
    }
  } else {
    const required = spec.query.operation === "exactlyOneShape"
      ? 1
      : (spec.query.k ?? -1);
    for (let row = 0; row < COUNTING_GRID_SIZE; row += 1) {
      for (let column = 0; column < COUNTING_GRID_SIZE; column += 1) {
        const key = `${row}:${column}`;
        const membership = sets.filter((set) => set.has(key)).length;
        if (membership === required) {
          count += 1;
        }
      }
    }
  }
  return CountingAnswerSchema.parse(count);
}

export function inclusionExclusionUnion(spec: CountingSpec): number {
  const sets = spec.shapes.map((shape) => shapeSet(shape));
  const shapeCount = sets.length;
  let total = 0;
  for (let subset = 1; subset < 1 << shapeCount; subset += 1) {
    const members: ReadonlySet<string>[] = [];
    for (let index = 0; index < shapeCount; index += 1) {
      if ((subset & (1 << index)) !== 0) {
        const set = sets[index];
        if (set !== undefined) {
          members.push(set);
        }
      }
    }
    const first = members[0];
    if (first === undefined) {
      continue;
    }
    const intersectionSize = [...first].filter((cell) =>
      members.every((set) => set.has(cell)),
    ).length;
    total += members.length % 2 === 1 ? intersectionSize : -intersectionSize;
  }
  return total;
}

export function summaryCounts(spec: CountingSpec): {
  readonly union: number;
  readonly intersectionAll: number;
  readonly exactlyOne: number;
  readonly exactlyK2: number;
  readonly exactlyK3?: number;
} {
  const masks = membershipMaskGrid(spec);
  let union = 0;
  let intersectionAll = 0;
  let exactlyOne = 0;
  let exactlyK2 = 0;
  let exactlyK3 = 0;
  const allMask = (1 << spec.shapes.length) - 1;
  for (const row of masks) {
    for (const mask of row) {
      if (mask > 0) {
        union += 1;
      }
      if (mask === allMask) {
        intersectionAll += 1;
      }
      const count = popcount(mask);
      if (count === 1) {
        exactlyOne += 1;
      }
      if (count === 2) {
        exactlyK2 += 1;
      }
      if (count === 3) {
        exactlyK3 += 1;
      }
    }
  }
  return spec.shapes.length === 3
    ? { union, intersectionAll, exactlyOne, exactlyK2, exactlyK3 }
    : { union, intersectionAll, exactlyOne, exactlyK2 };
}

export function queryKey(query: CountingQuery): string {
  return query.operation === "exactlyKShapes"
    ? `${query.operation}:${query.k}`
    : query.operation;
}

export const CountingSpecSchema = z
  .strictObject({
    shapes: z.array(CountingShapeSchema).min(2).max(3),
    query: CountingQuerySchema,
  })
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    const keys = new Set<string>();
    for (const [index, shape] of spec.shapes.entries()) {
      const key = shapeKey(shape);
      if (keys.has(key)) {
        issue(["shapes", index], "counting shapes must be distinct");
      }
      keys.add(key);
    }
    const counts = shapeMembershipCounts(spec);
    let hasOverlap = false;
    let hasExclusive = false;
    for (const row of counts) {
      for (const count of row) {
        if (count >= 2) {
          hasOverlap = true;
        }
        if (count === 1) {
          hasExclusive = true;
        }
      }
    }
    if (!hasOverlap) {
      issue(["shapes"], "counting shapes require at least one overlapping cell");
    }
    if (!hasExclusive) {
      issue(["shapes"], "counting shapes require at least one exclusive cell");
    }
    if (
      spec.query.operation === "exactlyKShapes" &&
      spec.query.k !== undefined &&
      spec.query.k > spec.shapes.length
    ) {
      issue(["query", "k"], `k=${spec.query.k} exceeds shapes=${spec.shapes.length}`);
    }
  });
export type CountingSpec = z.infer<typeof CountingSpecSchema>;

export function checkCountingAnswer(
  spec: CountingSpec,
  answer: number,
): boolean {
  const parsedSpec = CountingSpecSchema.safeParse(spec);
  const parsedAnswer = CountingAnswerSchema.safeParse(answer);
  if (!parsedSpec.success || !parsedAnswer.success) {
    return false;
  }
  const byMembership = countQueryByMembership(parsedSpec.data);
  const bySets = countQueryBySets(parsedSpec.data);
  return byMembership === bySets && parsedAnswer.data === byMembership;
}
