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
  TruthSpecSchema,
  canonicalizeAst,
  predicateKey,
  solveTruthPredicates,
  truthVectorKey,
  type TruthAst,
  type TruthPeople,
  type TruthPredicate,
  type TruthSpec,
} from "./schema.js";

const PREDICATE_LIST_SEPARATOR = "\u0000";

function peopleIds(people: TruthPeople): readonly number[] {
  return Array.from({ length: people }, (_value, index) => index);
}

export function truthPredicateListKey(
  predicates: readonly TruthPredicate[],
): string {
  return predicates.map(predicateKey).join(PREDICATE_LIST_SEPARATOR);
}

export function canonicalizeTruthPredicates(
  predicates: readonly TruthPredicate[],
  people: TruthPeople,
): readonly TruthPredicate[] {
  const permutations = countPermutations(people);
  const minimized = minimizeOverPermutations(
    peopleIds(people),
    (permutation) => {
      const mapping = new Map<number, number>();
      for (const [oldPerson, newPerson] of permutation.entries()) {
        mapping.set(oldPerson, newPerson);
      }
      const mapped: TruthPredicate[] = predicates.map((predicate) => {
        const speaker = mapping.get(predicate.speaker);
        if (speaker === undefined) {
          throw new RangeError(
            `truth relabeling has no target for speaker ${predicate.speaker}`,
          );
        }
        return { speaker, ast: canonicalizeAst(predicate.ast, mapping) };
      });
      return mapped.sort((left, right) =>
        compareCanonicalStrings(predicateKey(left), predicateKey(right)),
      );
    },
    (left, right) =>
      compareCanonicalStrings(
        truthPredicateListKey(left),
        truthPredicateListKey(right),
      ),
    { maxResults: permutations },
  );
  if (minimized.best === null || !minimized.complete) {
    throw new SolverLimitError(permutations, minimized.visited + 1);
  }
  return minimized.best;
}

export function canonicalizeTruthSpec(spec: TruthSpec): CanonicalStructure {
  const parsed = TruthSpecSchema.parse(spec);
  const predicates: TruthPredicate[] = parsed.statements.map((ast, speaker) => ({
    speaker,
    ast,
  }));
  const core = reduceClueCore({
    clues: predicates,
    normalize: (clues) => canonicalizeTruthPredicates(clues, parsed.people),
    clueKey: predicateKey,
    solve: (clues) => {
      const solved = solveTruthPredicates(
        parsed.people,
        parsed.exactTruthful,
        clues,
      );
      if (solved.solutions.length !== 1) {
        return { solutionCount: solved.solutions.length, answerKey: "" };
      }
      const solution = solved.solutions[0];
      return {
        solutionCount: 1,
        answerKey: solution === undefined ? "" : truthVectorKey(solution),
      };
    },
    maxEvaluations: 16,
  });

  return CanonicalStructureSchema.parse({
    version: 1,
    family: "truth",
    domainTokens: [
      `exactTruthful=${parsed.exactTruthful}`,
      `people=${parsed.people}`,
    ],
    queryKind: "full_truth_vector",
    queryTokens: [],
    relationTokens: sortedCanonicalTokens(core.retained.map(predicateKey)),
    geometryTokens: [],
  });
}

export function truthAstsForPeople(
  predicates: readonly TruthPredicate[],
): readonly TruthAst[] {
  return predicates.map((predicate) => predicate.ast);
}
