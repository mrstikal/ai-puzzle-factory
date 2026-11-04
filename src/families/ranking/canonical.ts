import {
  SolverLimitError,
  compareCanonicalStrings,
  countPermutations,
  minimizeOverPermutations,
  reduceClueCore,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  RankingSpecSchema,
  clueKey,
  itemIds,
  relabelClue,
  solveRankingPermutations,
  type RankingClue,
  type RankingSize,
  type RankingSpec,
} from "./schema.js";

const CLUE_LIST_SEPARATOR = "\u0000";

export function rankingClueListKey(clues: readonly RankingClue[]): string {
  return clues.map(clueKey).join(CLUE_LIST_SEPARATOR);
}

export function canonicalizeRankingClues(
  clues: readonly RankingClue[],
  size: RankingSize,
): readonly RankingClue[] {
  const permutations = countPermutations(size);
  const minimized = minimizeOverPermutations(
    itemIds(size),
    (permutation) => {
      const mapping = new Map<number, number>();
      for (const [oldItem, newItem] of permutation.entries()) {
        mapping.set(oldItem, newItem);
      }
      return [...clues.map((clue) => relabelClue(clue, mapping))].sort((left, right) =>
        compareCanonicalStrings(clueKey(left), clueKey(right)),
      );
    },
    (left, right) =>
      compareCanonicalStrings(rankingClueListKey(left), rankingClueListKey(right)),
    { maxResults: permutations },
  );
  if (minimized.best === null || !minimized.complete) {
    throw new SolverLimitError(permutations, minimized.visited + 1);
  }
  return minimized.best;
}

export function canonicalizeRankingSpec(spec: RankingSpec): CanonicalStructure {
  const parsed = RankingSpecSchema.parse(spec);
  const core = reduceClueCore({
    clues: parsed.clues,
    normalize: (clues) => canonicalizeRankingClues(clues, parsed.size),
    clueKey,
    solve: (clues) => {
      const solved = solveRankingPermutations(parsed.size, clues);
      return {
        solutionCount: solved.solutions.length,
        answerKey:
          solved.solutions.length === 1
            ? (solved.solutions[0] ?? []).join(",")
            : "",
      };
    },
    maxEvaluations: 32,
  });

  return CanonicalStructureSchema.parse({
    version: 1,
    family: "ranking",
    domainTokens: [`size=${parsed.size}`],
    queryKind: "full_order",
    queryTokens: [],
    relationTokens: sortedCanonicalTokens(core.retained.map(clueKey)),
    geometryTokens: [],
  });
}
