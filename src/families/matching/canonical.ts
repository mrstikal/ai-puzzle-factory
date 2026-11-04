import {
  SolverLimitError,
  collectPermutations,
  compareCanonicalStrings,
  minimizeOverCartesianProduct,
  reduceClueCore,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  MATCHING_ITEM_IDS,
  MatchingSpecSchema,
  assignmentToTable,
  clueKey,
  solveMatchingPermutations,
  type MatchingCategory,
  type MatchingClue,
  type MatchingEndpoint,
  type MatchingSpec,
} from "./schema.js";

const CLUE_LIST_SEPARATOR = "\u0000";
const RELABELING_COUNT = 24 * 24 * 24;

function itemMapping(permutation: readonly number[]): ReadonlyMap<number, number> {
  const mapping = new Map<number, number>();
  for (const [oldItem, newItem] of permutation.entries()) {
    mapping.set(oldItem, newItem);
  }
  return mapping;
}

function relabelEndpoint(
  endpoint: MatchingEndpoint,
  mappings: Readonly<Record<MatchingCategory, ReadonlyMap<number, number>>>,
): MatchingEndpoint {
  const item = mappings[endpoint.category].get(endpoint.item);
  if (item === undefined) {
    throw new RangeError(
      `matching relabeling has no target for ${endpoint.category}${endpoint.item}`,
    );
  }
  return { category: endpoint.category, item };
}

function relabelClue(
  clue: MatchingClue,
  mappings: Readonly<Record<MatchingCategory, ReadonlyMap<number, number>>>,
): MatchingClue {
  return {
    kind: clue.kind,
    left: relabelEndpoint(clue.left, mappings),
    right: relabelEndpoint(clue.right, mappings),
  };
}

export function matchingClueListKey(clues: readonly MatchingClue[]): string {
  return clues.map(clueKey).join(CLUE_LIST_SEPARATOR);
}

export function canonicalizeMatchingClues(
  clues: readonly MatchingClue[],
): readonly MatchingClue[] {
  const permutations = collectMatchingPermutations();
  const minimized = minimizeOverCartesianProduct(
    [permutations, permutations, permutations],
    (combination) => {
      const aPermutation = combination[0];
      const bPermutation = combination[1];
      const cPermutation = combination[2];
      if (
        aPermutation === undefined ||
        bPermutation === undefined ||
        cPermutation === undefined
      ) {
        throw new RangeError("matching relabeling combination is incomplete");
      }
      const mappings: Readonly<Record<MatchingCategory, ReadonlyMap<number, number>>> = {
        A: itemMapping(aPermutation),
        B: itemMapping(bPermutation),
        C: itemMapping(cPermutation),
      };
      return [...clues.map((clue) => relabelClue(clue, mappings))].sort((left, right) =>
        compareCanonicalStrings(clueKey(left), clueKey(right)),
      );
    },
    (left, right) =>
      compareCanonicalStrings(matchingClueListKey(left), matchingClueListKey(right)),
    { maxResults: RELABELING_COUNT },
  );
  if (minimized.best === null || !minimized.complete) {
    throw new SolverLimitError(RELABELING_COUNT, minimized.visited + 1);
  }
  return minimized.best;
}

function collectMatchingPermutations(): readonly (readonly number[])[] {
  const collected = collectPermutations(MATCHING_ITEM_IDS, { maxResults: 24 });
  if (!collected.complete || collected.visited !== 24) {
    throw new SolverLimitError(24, collected.visited + 1);
  }
  return collected.items;
}

export function canonicalizeMatchingSpec(spec: MatchingSpec): CanonicalStructure {
  const parsed = MatchingSpecSchema.parse(spec);
  const core = reduceClueCore({
    clues: parsed.clues,
    normalize: canonicalizeMatchingClues,
    clueKey,
    solve: (clues) => {
      const solved = solveMatchingPermutations(clues);
      if (solved.solutions.length !== 1) {
        return { solutionCount: solved.solutions.length, answerKey: "" };
      }
      const solution = solved.solutions[0];
      if (solution === undefined) {
        return { solutionCount: 0, answerKey: "" };
      }
      const table = assignmentToTable(solution);
      return {
        solutionCount: 1,
        answerKey: table.map((row) => `${row.a}-${row.b}-${row.c}`).join("|"),
      };
    },
    maxEvaluations: 32,
  });

  return CanonicalStructureSchema.parse({
    version: 1,
    family: "matching",
    domainTokens: ["categories=3", "size=4"],
    queryKind: "full_table",
    queryTokens: [],
    relationTokens: sortedCanonicalTokens(core.retained.map(clueKey)),
    geometryTokens: [],
  });
}
