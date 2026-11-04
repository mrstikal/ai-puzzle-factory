import {
  D4_OPERATIONS,
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  selectCanonicalStructure,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  TransformsSpecSchema,
  applyD4Operation,
  composeD4Sequence,
  conjugateD4Operation,
  sortTransformCells,
  sourceCellsFromGrid,
  type TransformCell,
  type TransformsSpec,
} from "./schema.js";

function transformedCells(
  cells: readonly TransformCell[],
  frame: (typeof D4_OPERATIONS)[number],
): readonly TransformCell[] {
  return sortTransformCells(
    cells.map((cell) => applyD4Operation(frame, cell)),
  );
}

export function canonicalizeTransformsSpec(spec: TransformsSpec): CanonicalStructure {
  const parsed = TransformsSpecSchema.parse(spec);
  const source = sourceCellsFromGrid(parsed.source);
  const candidates: CanonicalStructure[] = [];
  for (const frame of D4_OPERATIONS) {
    const conjugatedOperations = parsed.operations.map((operation) =>
      conjugateD4Operation(frame, operation),
    );
    const net = composeD4Sequence(conjugatedOperations);
    const queryTokens = sortedCanonicalTokens([
      `steps=${conjugatedOperations.length}`,
      ...conjugatedOperations.map((operation, index) => `op${index}=${operation}`),
      `net=${net}`,
    ]);
    const geometryTokens = sortedCanonicalTokens(
      transformedCells(source, frame).map(
        (cell) => `cell:${cell.row}:${cell.column}`,
      ),
    );
    candidates.push(
      CanonicalStructureSchema.parse({
        version: 1,
        family: "transforms",
        domainTokens: ["grid=5x5"],
        queryKind: "apply_D4",
        queryTokens,
        relationTokens: [],
        geometryTokens,
      }),
    );
  }
  return selectCanonicalStructure(candidates);
}
