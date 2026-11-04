import { z } from "zod";

export const MATRIX_RULE = "xor" as const;
export const MATRIX_SIZE = 3;
export const MATRIX_MISSING_CELL = { row: 2, column: 2 } as const;
export const MATRIX_GLYPH_COUNT = 4;
export const MATRIX_MASK_COUNT = 16;
export const EMPTY_MASK_CONVENTION =
  "Mask 0 is drawn as an empty four-position mini-grid with a visible cell outline.";

const maskSchema = z.number().int().min(0).max(15);
const fullRowSchema = z.tuple([maskSchema, maskSchema, maskSchema]);
const missingRowSchema = z.tuple([maskSchema, maskSchema, z.null()]);

export const MatrixSpecSchema = z.strictObject({
  rule: z.literal(MATRIX_RULE),
  cells: z.tuple([fullRowSchema, fullRowSchema, missingRowSchema]),
});
export type MatrixSpec = z.infer<typeof MatrixSpecSchema>;

export const MatrixAnswerSchema = z.number().int().min(0).max(15);
export type MatrixAnswer = z.infer<typeof MatrixAnswerSchema>;

export interface MatrixCell {
  readonly row: number;
  readonly column: number;
  readonly mask: number;
}

export function maskPopcount(mask: number): number {
  let value = mask;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

export function maskGlyphs(mask: number): readonly number[] {
  const glyphs: number[] = [];
  for (let glyph = 0; glyph < MATRIX_GLYPH_COUNT; glyph += 1) {
    if ((mask & (1 << glyph)) !== 0) {
      glyphs.push(glyph);
    }
  }
  return glyphs;
}

export function maskText(mask: number): string {
  const glyphs = maskGlyphs(mask);
  if (glyphs.length === 0) {
    return "empty";
  }
  return `glyphs ${glyphs.map((glyph) => glyph + 1).join(", ")}`;
}

export function xorMask(left: number, right: number): number {
  return (left ^ right) & 0x0f;
}

export function permuteMask(mask: number, permutation: readonly number[]): number {
  let result = 0;
  for (let oldGlyph = 0; oldGlyph < MATRIX_GLYPH_COUNT; oldGlyph += 1) {
    const newGlyph = permutation[oldGlyph];
    if (newGlyph === undefined) {
      throw new RangeError("matrix glyph permutation is incomplete");
    }
    if ((mask & (1 << oldGlyph)) !== 0) {
      result |= 1 << newGlyph;
    }
  }
  return result;
}

export function matrixCell(spec: MatrixSpec, row: number, column: number): number | null {
  const rowValue = spec.cells[row];
  if (rowValue === undefined) {
    throw new RangeError(`matrix row ${row} is outside 0..2`);
  }
  const value = rowValue[column];
  if (value === undefined) {
    throw new RangeError(`matrix column ${column} is outside 0..2`);
  }
  return value;
}

export function visibleMatrixCells(spec: MatrixSpec): readonly MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (let row = 0; row < MATRIX_SIZE; row += 1) {
    for (let column = 0; column < MATRIX_SIZE; column += 1) {
      if (row === MATRIX_MISSING_CELL.row && column === MATRIX_MISSING_CELL.column) {
        continue;
      }
      const mask = matrixCell(spec, row, column);
      if (mask === null) {
        throw new RangeError("matrix has a null outside the fixed missing cell");
      }
      cells.push({ row, column, mask });
    }
  }
  return cells;
}

export function checkMatrixCompletion(spec: MatrixSpec, candidateMask: number): boolean {
  if (!Number.isInteger(candidateMask) || candidateMask < 0 || candidateMask > 15) {
    return false;
  }
  const c00 = matrixCell(spec, 0, 0);
  const c01 = matrixCell(spec, 0, 1);
  const c02 = matrixCell(spec, 0, 2);
  const c10 = matrixCell(spec, 1, 0);
  const c11 = matrixCell(spec, 1, 1);
  const c12 = matrixCell(spec, 1, 2);
  const c20 = matrixCell(spec, 2, 0);
  const c21 = matrixCell(spec, 2, 1);
  if (
    c00 === null ||
    c01 === null ||
    c02 === null ||
    c10 === null ||
    c11 === null ||
    c12 === null ||
    c20 === null ||
    c21 === null
  ) {
    return false;
  }
  return (
    c02 === xorMask(c00, c01) &&
    c12 === xorMask(c10, c11) &&
    candidateMask === xorMask(c20, c21) &&
    c20 === xorMask(c00, c10) &&
    c21 === xorMask(c01, c11) &&
    candidateMask === xorMask(c02, c12)
  );
}

export function solveMatrix(spec: MatrixSpec): readonly MatrixAnswer[] {
  const parsed = MatrixSpecSchema.parse(spec);
  const solutions: MatrixAnswer[] = [];
  for (let mask = 0; mask < MATRIX_MASK_COUNT; mask += 1) {
    if (checkMatrixCompletion(parsed, mask)) {
      solutions.push(mask);
    }
  }
  return solutions;
}

export interface MatrixGlyphPosition {
  readonly glyph: number;
  readonly x: number;
  readonly y: number;
}

export const MATRIX_GLYPH_POSITIONS: readonly MatrixGlyphPosition[] = [
  { glyph: 0, x: 0.25, y: 0.25 },
  { glyph: 1, x: 0.75, y: 0.25 },
  { glyph: 2, x: 0.25, y: 0.75 },
  { glyph: 3, x: 0.75, y: 0.75 },
];

export interface MatrixChoiceInput {
  readonly label: "A" | "B" | "C" | "D";
  readonly mask: number;
}

export interface MatrixSceneInput {
  readonly rule: "xor";
  readonly cells: readonly (
    | MatrixCell
    | { readonly row: 2; readonly column: 2; readonly mask: null }
  )[];
  readonly missingCell: { readonly row: 2; readonly column: 2 };
  readonly glyphPositions: readonly MatrixGlyphPosition[];
  readonly emptyMaskConvention: string;
  readonly choices: readonly MatrixChoiceInput[];
}

export function buildMatrixSceneInput(
  spec: MatrixSpec,
  choices: readonly MatrixChoiceInput[],
): MatrixSceneInput {
  const parsed = MatrixSpecSchema.parse(spec);
  const cells: Array<MatrixCell | { readonly row: 2; readonly column: 2; readonly mask: null }> = [];
  for (let row = 0; row < MATRIX_SIZE; row += 1) {
    for (let column = 0; column < MATRIX_SIZE; column += 1) {
      const mask = matrixCell(parsed, row, column);
      if (mask === null) {
        cells.push({ row: 2, column: 2, mask: null });
      } else {
        cells.push({ row, column, mask });
      }
    }
  }
  return {
    rule: "xor",
    cells,
    missingCell: { row: 2, column: 2 },
    glyphPositions: MATRIX_GLYPH_POSITIONS,
    emptyMaskConvention: EMPTY_MASK_CONVENTION,
    choices,
  };
}
