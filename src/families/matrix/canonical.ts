import {
  SolverLimitError,
  collectPermutations,
  selectCanonicalStructure,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  MATRIX_GLYPH_COUNT,
  MatrixSpecSchema,
  permuteMask,
  visibleMatrixCells,
  type MatrixSpec,
} from "./schema.js";

function glyphPermutations(): readonly (readonly number[])[] {
  const collected = collectPermutations(
    Array.from({ length: MATRIX_GLYPH_COUNT }, (_value, index) => index),
    { maxResults: 24 },
  );
  if (!collected.complete || collected.visited !== 24) {
    throw new SolverLimitError(24, collected.visited + 1);
  }
  return collected.items;
}

export function matrixGeometryTokens(
  spec: MatrixSpec,
  permutation: readonly number[],
  transpose: boolean,
): readonly string[] {
  const cells = visibleMatrixCells(spec);
  return sortedCanonicalTokens(
    cells.map((cell) => {
      const row = transpose ? cell.column : cell.row;
      const column = transpose ? cell.row : cell.column;
      return `cell:${row}:${column}:${permuteMask(cell.mask, permutation)}`;
    }),
  );
}

export function canonicalizeMatrixSpec(spec: MatrixSpec): CanonicalStructure {
  const parsed = MatrixSpecSchema.parse(spec);
  const permutations = glyphPermutations();
  const candidates: CanonicalStructure[] = [];
  for (const permutation of permutations) {
    for (const transpose of [false, true]) {
      candidates.push(
        CanonicalStructureSchema.parse({
          version: 1,
          family: "matrix",
          domainTokens: ["glyphs=4", "grid=3x3", "missing=2,2"],
          queryKind: "xor_matrix",
          queryTokens: ["column=xor", "row=xor"],
          relationTokens: [],
          geometryTokens: matrixGeometryTokens(parsed, permutation, transpose),
        }),
      );
    }
  }
  return selectCanonicalStructure(candidates);
}
