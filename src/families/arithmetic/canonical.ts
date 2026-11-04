import {
  SolverLimitError,
  compareCanonicalStrings,
  minimizeOverPermutations,
  reduceClueCore,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  ArithmeticSpecSchema,
  normalizedConstraintKey,
  relabelConstraint,
  solveArithmetic,
  tupleKey,
  type ArithmeticConstraint,
  type ArithmeticSpec,
} from "./schema.js";

const CONSTRAINT_LIST_SEPARATOR = "\u0000";

export function arithmeticConstraintListKey(
  constraints: readonly ArithmeticConstraint[],
): string {
  return constraints.map(normalizedConstraintKey).join(CONSTRAINT_LIST_SEPARATOR);
}

export function canonicalizeArithmeticConstraints(
  constraints: readonly ArithmeticConstraint[],
): readonly ArithmeticConstraint[] {
  const minimized = minimizeOverPermutations(
    [0, 1, 2],
    (permutation) =>
      [...constraints.map((constraint) => relabelConstraint(constraint, permutation))].sort(
        (left, right) =>
          compareCanonicalStrings(
            normalizedConstraintKey(left),
            normalizedConstraintKey(right),
          ),
      ),
    (left, right) =>
      compareCanonicalStrings(
        arithmeticConstraintListKey(left),
        arithmeticConstraintListKey(right),
      ),
    { maxResults: 6 },
  );
  if (minimized.best === null || !minimized.complete) {
    throw new SolverLimitError(6, minimized.visited + 1);
  }
  return minimized.best;
}

export function canonicalizeArithmeticSpec(spec: ArithmeticSpec): CanonicalStructure {
  const parsed = ArithmeticSpecSchema.parse(spec);
  const core = reduceClueCore({
    clues: parsed.constraints,
    normalize: canonicalizeArithmeticConstraints,
    clueKey: normalizedConstraintKey,
    solve: (constraints) => {
      const solved = solveArithmetic({
        allDifferent: parsed.allDifferent,
        constraints: [...constraints],
      });
      if (solved.solutions.length !== 1) {
        return { solutionCount: solved.solutions.length, answerKey: "" };
      }
      const solution = solved.solutions[0];
      return {
        solutionCount: 1,
        answerKey: solution === undefined ? "" : tupleKey(solution),
      };
    },
    maxEvaluations: 16,
  });

  return CanonicalStructureSchema.parse({
    version: 1,
    family: "arithmetic",
    domainTokens: [
      `allDifferent=${parsed.allDifferent ? "true" : "false"}`,
      "domain=0..12",
      "variables=3",
    ],
    queryKind: "full_tuple",
    queryTokens: [],
    relationTokens: sortedCanonicalTokens(
      core.retained.map(normalizedConstraintKey),
    ),
    geometryTokens: [],
  });
}
