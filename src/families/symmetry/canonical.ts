import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  selectCanonicalStructure,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  SymmetrySpecSchema,
  knownOccupiedCells,
  type SymmetryCell,
  type SymmetrySpec,
} from "./schema.js";

const LAST = 7;

function normalizedVerticalCells(spec: SymmetrySpec): readonly SymmetryCell[] {
  const occupied = knownOccupiedCells(spec);
  if (spec.axis === "vertical") {
    return occupied;
  }
  return occupied.map((cell) => ({ row: cell.column, column: cell.row }));
}

function reversedAlongAxis(cells: readonly SymmetryCell[]): readonly SymmetryCell[] {
  return cells.map((cell) => ({ row: LAST - cell.row, column: cell.column }));
}

function canonicalFor(cells: readonly SymmetryCell[]): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "symmetry",
    domainTokens: ["axis=vertical", "grid=8x8", "knownSide=left"],
    queryKind: "reflect_half",
    queryTokens: [],
    relationTokens: [],
    geometryTokens: sortedCanonicalTokens(
      cells.map((cell) => `cell:${cell.row}:${cell.column}`),
    ),
  });
}

export function canonicalizeSymmetrySpec(spec: SymmetrySpec): CanonicalStructure {
  const parsed = SymmetrySpecSchema.parse(spec);
  const normalized = normalizedVerticalCells(parsed);
  return selectCanonicalStructure([
    canonicalFor(normalized),
    canonicalFor(reversedAlongAxis(normalized)),
  ]);
}
