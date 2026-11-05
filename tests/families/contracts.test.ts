import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnswerContractError,
  ChoiceSetSchema,
  deepEqual,
  makeChoiceSet,
  verifyChoiceSet,
} from "../../src/domain/answers.js";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
  SVG_FAMILIES,
  type Family,
  type Modality,
  type SvgFamily,
} from "../../src/domain/experiment.js";
import {
  Bitset,
  ReducedCoreError,
  SearchCounter,
  SolverLimitError,
  canonicalStructureHash,
  canonicalStructuresEqual,
  collectCartesianProduct,
  collectPermutations,
  compareCanonicalStrings,
  compareFeatureMultisets,
  countCartesianProduct,
  countPermutations,
  extractStructureFeatures,
  minimizeOverPermutations,
  reduceClueCore,
  selectCanonicalStructure,
  serializeCanonicalStructure,
  sortedCanonicalTokens,
  type CoreSolution,
  type FeatureCount,
} from "../../src/families/canonicalize.js";
import {
  CanonicalStructureSchema,
  FactContractError,
  FactSchema,
  RULE_FACT_IDS,
  SolveResultSchema,
  VisibleRulesSchema,
  assertFactNamespace,
  assertFactReferences,
  assertKnownTransformOperation,
  assertLocalClueFactCoverage,
  assertSolveResult,
  formatFactId,
  mergeFactInventory,
  ruleFacts,
  type CanonicalStructure,
  type Fact,
  type FamilyEngine,
  type VisibleRules,
} from "../../src/families/contracts.js";
import {
  FamilyRegistry,
  RegistryError,
  type RendererContract,
} from "../../src/families/registry.js";
import { HashCounterPrng } from "../../src/util/random.js";

const SEED_A = "0".repeat(64);
const SEED_B = "1".repeat(64);
const SEED_C = "2".repeat(64);
const SEED_D = "3".repeat(64);

function thrown(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected action to throw");
}

function expectErrorCode(error: Error, code: string): void {
  expect(error).toHaveProperty("code", code);
}

function rankingStructure(
  relationTokens: readonly string[],
  size: 4 | 5 = 4,
): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "ranking",
    domainTokens: [`size=${size}`],
    queryKind: "full_order",
    queryTokens: [],
    relationTokens: sortedCanonicalTokens(relationTokens),
    geometryTokens: [],
  });
}

function matrixStructure(): CanonicalStructure {
  const geometryTokens: string[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (row === 2 && column === 2) {
        continue;
      }
      geometryTokens.push(`cell:${row}:${column}:${row + column}`);
    }
  }
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "matrix",
    domainTokens: ["glyphs=4", "grid=3x3", "missing=2,2"],
    queryKind: "xor_matrix",
    queryTokens: ["column=xor", "row=xor"],
    relationTokens: [],
    geometryTokens: sortedCanonicalTokens(geometryTokens),
  });
}

function transformsStructure(): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "transforms",
    domainTokens: ["grid=5x5"],
    queryKind: "apply_D4",
    queryTokens: ["net=rotate90", "op0=rotate90", "steps=1"],
    relationTokens: [],
    geometryTokens: ["cell:0:0", "cell:0:1", "cell:1:0", "cell:1:1"],
  });
}

function pathsStructure(): CanonicalStructure {
  const active = [
    "active:0:0",
    "active:0:1",
    "active:0:2",
    "active:1:0",
    "active:1:1",
    "active:1:2",
  ];
  const edges = [
    "open:0:0:0:1",
    "open:0:0:1:0",
    "open:0:1:0:2",
    "open:1:0:1:1",
    "open:1:1:1:2",
  ];
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "paths",
    domainTokens: ["grid=4x4"],
    queryKind: "S_to_G_route",
    queryTokens: ["goal:1:2", "start:0:0"],
    relationTokens: sortedCanonicalTokens(edges),
    geometryTokens: sortedCanonicalTokens(active),
  });
}

function symmetryStructure(): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "symmetry",
    domainTokens: ["axis=vertical", "grid=8x8", "knownSide=left"],
    queryKind: "reflect_half",
    queryTokens: [],
    relationTokens: [],
    geometryTokens: ["cell:0:0", "cell:0:1", "cell:1:0", "cell:1:1"],
  });
}

function countingStructure(k: 2 | 3, shapes: 2 | 3 = 3): CanonicalStructure {
  const maxMask = (1 << shapes) - 1;
  const geometryTokens: string[] = [];
  const maskCounts = new Map<number, number>();
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const mask = (row * 5 + column) % (maxMask + 1);
      geometryTokens.push(`cell:${row}:${column}:${mask}`);
      maskCounts.set(mask, (maskCounts.get(mask) ?? 0) + 1);
    }
  }
  const relationTokens: string[] = [];
  for (let mask = 1; mask <= maxMask; mask += 1) {
    relationTokens.push(`region:${mask}:${maskCounts.get(mask) ?? 0}`);
  }
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "counting",
    domainTokens: ["grid=5x5", `shapes=${shapes}`],
    queryKind: "membership_count",
    queryTokens: [`k=${k}`, "operation=exactlyKShapes"],
    relationTokens: sortedCanonicalTokens(relationTokens),
    geometryTokens: sortedCanonicalTokens(geometryTokens),
  });
}

function matchingStructure(): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "matching",
    domainTokens: ["categories=3", "size=4"],
    queryKind: "full_table",
    queryTokens: [],
    relationTokens: [
      "different:0.0:1.0",
      "same:0.1:1.1",
      "same:0.2:2.0",
      "same:1.2:2.1",
    ],
    geometryTokens: [],
  });
}

function schedulingStructure(): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "scheduling",
    domainTokens: ["capacities=2,2", "events=4", "slots=4"],
    queryKind: "full_schedule",
    queryTokens: [],
    relationTokens: ["at:0:1", "before:0:1", "notResource:1:0", "usesResource:0:0"],
    geometryTokens: [],
  });
}

function truthStructure(): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "truth",
    domainTokens: ["exactTruthful=1", "people=3"],
    queryKind: "full_truth_vector",
    queryTokens: [],
    relationTokens: [
      "speaker:0:truthful:1",
      "speaker:1:not(truthful:1)",
      "speaker:2:truthful:2",
    ],
    geometryTokens: [],
  });
}

function arithmeticStructure(): CanonicalStructure {
  return CanonicalStructureSchema.parse({
    version: 1,
    family: "arithmetic",
    domainTokens: ["allDifferent=false", "domain=0..12", "variables=3"],
    queryKind: "full_tuple",
    queryTokens: [],
    relationTokens: ["eq:1,1,1:3", "le:1,0,0:5"],
    geometryTokens: [],
  });
}

function featureMultiset(entries: Readonly<Record<string, number>>): readonly FeatureCount[] {
  return Object.entries(entries)
    .map(([feature, count]) => ({ feature, count }))
    .sort((left, right) => compareCanonicalStrings(left.feature, right.feature));
}

interface ToyClue {
  readonly kind: "before" | "immediatelyBefore" | "at" | "notAt";
  readonly a: number;
  readonly b: number;
}

const ToyClueSchema = z.strictObject({
  kind: z.enum(["before", "immediatelyBefore", "at", "notAt"]),
  a: z.number().int().min(0).max(4),
  b: z.number().int().min(0).max(4),
});

const ToySpecSchema = z.strictObject({
  size: z.union([z.literal(4), z.literal(5)]),
  clues: z.array(ToyClueSchema).min(3).max(12),
});

type ToySpec = z.infer<typeof ToySpecSchema>;
type ToyAnswer = readonly number[];

function toyKey(clue: ToyClue): string {
  return `${clue.kind}:${clue.a}:${clue.b}`;
}

function toyNormalize(clues: readonly ToyClue[]): readonly ToyClue[] {
  return [...clues].sort((left, right) =>
    compareCanonicalStrings(toyKey(left), toyKey(right)),
  );
}

function toySatisfies(clues: readonly ToyClue[], permutation: ToyAnswer): boolean {
  const positions = new Map<number, number>();
  for (const [index, item] of permutation.entries()) {
    positions.set(item, index + 1);
  }
  for (const clue of clues) {
    const first = positions.get(clue.a);
    const second = positions.get(clue.b);
    if (first === undefined) {
      return false;
    }
    if (clue.kind === "at" || clue.kind === "notAt") {
      if (clue.kind === "at" ? first !== clue.b : first === clue.b) {
        return false;
      }
      continue;
    }
    if (second === undefined) {
      return false;
    }
    if (clue.kind === "before" ? !(first < second) : second !== first + 1) {
      return false;
    }
  }
  return true;
}

function toySolutions(size: number, clues: readonly ToyClue[]): readonly ToyAnswer[] {
  const items = Array.from({ length: size }, (_value, index) => index);
  return collectPermutations(items).items.filter((permutation) =>
    toySatisfies(clues, permutation),
  );
}

function toySolve(size: number, clues: readonly ToyClue[]): CoreSolution {
  const solutions = toySolutions(size, clues);
  return {
    solutionCount: solutions.length,
    answerKey: solutions.length === 1 ? (solutions[0] ?? []).join(",") : "",
  };
}

function makeToyEngine(): FamilyEngine<ToySpec, ToyAnswer> {
  return {
    family: "ranking",
    modality: "text",
    schema: ToySpecSchema,
    generateSpec(seed, difficulty) {
      const witness = new HashCounterPrng(seed).shuffle([0, 1, 2, 3]);
      const clues: ToyClue[] = [];
      for (let index = 0; index < 3; index += 1) {
        const first = witness[index];
        const second = witness[index + 1];
        if (first === undefined || second === undefined) {
          throw new Error("toy witness is incomplete");
        }
        clues.push({ kind: "before", a: first, b: second });
      }
      if (difficulty >= 2) {
        const anchor = witness[0];
        if (anchor !== undefined) {
          clues.push({ kind: "at", a: anchor, b: 1 });
        }
      }
      return { size: 4, clues };
    },
    enumerateSolutions(spec) {
      const parsed = ToySpecSchema.parse(spec);
      const solutions = toySolutions(parsed.size, parsed.clues);
      const unique = solutions.length === 1 ? (solutions[0] ?? null) : null;
      return {
        solutionCount: solutions.length,
        answerCount: new Set(solutions.map((solution) => solution.join(","))).size,
        correctAnswer: unique,
        proof:
          unique === null
            ? null
            : {
                facts: [
                  {
                    factId: "s001",
                    kind: "derived",
                    text: `Unique order ${unique.join("-")}`,
                  },
                ],
                witness: unique,
              },
        enumeratedStates: countPermutations(parsed.size),
        checkerVersion: "toy-ranking-v1",
      };
    },
    verifyAnswer(spec, answer) {
      const parsed = ToySpecSchema.parse(spec);
      if (answer.length !== parsed.size) {
        return false;
      }
      const sorted = [...answer].sort((left, right) => left - right);
      if (sorted.some((value, index) => value !== index)) {
        return false;
      }
      return toySatisfies(parsed.clues, answer);
    },
    makeOptions(spec, answer, seed) {
      const parsed = ToySpecSchema.parse(spec);
      if (!toySatisfies(parsed.clues, answer)) {
        throw new Error("the supplied answer does not satisfy the toy spec");
      }
      const items = Array.from({ length: parsed.size }, (_value, index) => index);
      const wrong = collectPermutations(items).items.filter(
        (permutation) => !toySatisfies(parsed.clues, permutation),
      );
      const first = wrong[0];
      const second = wrong[1];
      const third = wrong[2];
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error("the toy spec has fewer than three false options");
      }
      return makeChoiceSet({
        correct: answer,
        distractors: [first, second, third],
        seed,
      });
    },
    visibleRules() {
      const rules: VisibleRules = {
        domain: "Four distinct items are arranged in a strict total order.",
        closedWorld: "Every item appears exactly once and no ties are allowed.",
        target: "Determine the complete left-to-right order.",
        operations: ["before", "immediatelyBefore", "at", "notAt"],
        conventions: [],
      };
      return rules;
    },
    facts(spec) {
      const parsed = ToySpecSchema.parse(spec);
      return parsed.clues.map((clue, index) => ({
        factId: formatFactId("local", index),
        kind: "local" as const,
        text: `Clue ${toyKey(clue)}`,
      }));
    },
    canonicalData(spec) {
      const parsed = ToySpecSchema.parse(spec);
      const core = reduceClueCore({
        clues: parsed.clues,
        normalize: toyNormalize,
        clueKey: toyKey,
        solve: (clues) => toySolve(parsed.size, clues),
        maxEvaluations: 32,
      });
      const labels = Array.from({ length: parsed.size }, (_value, index) => index);
      const minimized = minimizeOverPermutations(
        labels,
        (permutation) => {
          const mapping = new Map<number, number>();
          for (const [oldId, newId] of permutation.entries()) {
            mapping.set(oldId, newId);
          }
          const relationTokens = core.retained.map((clue) => {
            const first = mapping.get(clue.a);
            if (first === undefined) {
              throw new Error("toy relabeling is incomplete");
            }
            if (clue.kind === "at" || clue.kind === "notAt") {
              return `${clue.kind}:${first}:${clue.b}`;
            }
            const second = mapping.get(clue.b);
            if (second === undefined) {
              throw new Error("toy relabeling is incomplete");
            }
            return `${clue.kind}:${first}:${second}`;
          });
          return CanonicalStructureSchema.parse({
            version: 1,
            family: "ranking",
            domainTokens: [`size=${parsed.size}`],
            queryKind: "full_order",
            queryTokens: [],
            relationTokens: sortedCanonicalTokens(relationTokens),
            geometryTokens: [],
          });
        },
        (left, right) =>
          compareCanonicalStrings(
            serializeCanonicalStructure(left),
            serializeCanonicalStructure(right),
          ),
      );
      if (minimized.best === null || !minimized.complete) {
        throw new Error("toy canonicalization did not complete");
      }
      return minimized.best;
    },
    testMutations(spec) {
      const parsed = ToySpecSchema.parse(spec);
      const first = parsed.clues[0];
      if (first === undefined) {
        return [];
      }
      return [
        {
          id: "duplicate-first-clue",
          description: "append a duplicate of the first clue",
          spec: { ...parsed, clues: [...parsed.clues, first] },
        },
        {
          id: "reverse-first-clue",
          description: "reverse the first clue",
          spec: {
            ...parsed,
            clues: [{ ...first, a: first.b, b: first.a }, ...parsed.clues.slice(1)],
          },
        },
      ];
    },
  };
}

function makeDummyEngine(family: Family, modality: Modality): FamilyEngine<unknown, unknown> {
  return {
    family,
    modality,
    schema: z.unknown(),
    generateSpec: () => {
      throw new Error("dummy engine cannot generate");
    },
    enumerateSolutions: () => ({
      solutionCount: 0,
      answerCount: 0,
      correctAnswer: null,
      proof: null,
      enumeratedStates: 0,
      checkerVersion: "dummy-v1",
    }),
    verifyAnswer: () => false,
    makeOptions: () => {
      throw new Error("dummy engine cannot make options");
    },
    visibleRules: () => ({
      domain: "dummy domain",
      closedWorld: "dummy closed world",
      target: "dummy target",
      operations: ["dummy operation"],
      conventions: [],
    }),
    facts: () => [],
    canonicalData: () => {
      throw new Error("dummy engine cannot canonicalize");
    },
    testMutations: () => [],
  };
}

describe("CanonicalStructure schema", () => {
  it("accepts one strict structure for every family", () => {
    const structures: readonly CanonicalStructure[] = [
      rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]),
      matchingStructure(),
      schedulingStructure(),
      truthStructure(),
      arithmeticStructure(),
      matrixStructure(),
      transformsStructure(),
      pathsStructure(),
      symmetryStructure(),
      countingStructure(2),
    ];
    expect(structures).toHaveLength(FAMILIES.length);
    for (const structure of structures) {
      expect(() => CanonicalStructureSchema.parse(structure)).not.toThrow();
    }
  });

  it("rejects unsorted tokens, prose tokens, extra fields, and wrong query kinds", () => {
    expect(() =>
      CanonicalStructureSchema.parse({
        ...rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]),
        relationTokens: ["before:1:2", "at:0:1", "before:0:1"],
      }),
    ).toThrow();
    expect(() =>
      CanonicalStructureSchema.parse({
        ...rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]),
        relationTokens: [
          "item zero is before item one",
          "item one is before item two",
          "item zero is before item two",
        ],
      }),
    ).toThrow();
    expect(() =>
      CanonicalStructureSchema.parse({
        ...rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]),
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      CanonicalStructureSchema.parse({
        ...rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]),
        queryKind: "full_table",
      }),
    ).toThrow();
  });

  it("rejects family-specific malformed structures", () => {
    const matrix = matrixStructure();
    expect(() =>
      CanonicalStructureSchema.parse({
        ...matrix,
        geometryTokens: [
          ...matrix.geometryTokens.slice(0, 7),
          "cell:2:2:0",
        ],
      }),
    ).toThrow();

    expect(() =>
      CanonicalStructureSchema.parse({
        ...transformsStructure(),
        queryTokens: ["net=rotate90", "op0=rotate17", "steps=1"],
      }),
    ).toThrow();

    const counting = countingStructure(2);
    expect(() =>
      CanonicalStructureSchema.parse({
        ...counting,
        relationTokens: counting.relationTokens.slice(0, 6),
      }),
    ).toThrow();

    expect(() =>
      CanonicalStructureSchema.parse({
        ...pathsStructure(),
        relationTokens: pathsStructure().relationTokens.slice(0, 4),
      }),
    ).toThrow();

    expect(() =>
      CanonicalStructureSchema.parse({
        ...symmetryStructure(),
        geometryTokens: ["cell:0:4", "cell:0:5", "cell:1:4", "cell:1:5"],
      }),
    ).toThrow();
  });

  it("rejects non-canonical integer spellings and inconsistent counting region counts", () => {
    const ranking = rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]);
    const matching = matchingStructure();
    const scheduling = schedulingStructure();
    const truth = truthStructure();
    const arithmetic = arithmeticStructure();
    const matrix = matrixStructure();
    const transforms = transformsStructure();
    const paths = pathsStructure();
    const symmetry = symmetryStructure();
    const counting = countingStructure(2);

    const paddedCases: readonly CanonicalStructure[] = [
      {
        ...ranking,
        relationTokens: sortedCanonicalTokens([
          "at:00:01",
          "before:0:1",
          "immediatelyBefore:1:2",
        ]),
      },
      {
        ...matching,
        relationTokens: sortedCanonicalTokens(
          matching.relationTokens.map((token) =>
            token === "different:0.0:1.0" ? "different:00.0:1.0" : token,
          ),
        ),
      },
      {
        ...scheduling,
        relationTokens: sortedCanonicalTokens(
          scheduling.relationTokens.map((token) =>
            token === "at:0:1" ? "at:00:1" : token,
          ),
        ),
      },
      {
        ...truth,
        relationTokens: sortedCanonicalTokens(
          truth.relationTokens.map((token) =>
            token === "speaker:0:truthful:1" ? "speaker:00:truthful:1" : token,
          ),
        ),
      },
      {
        ...arithmetic,
        relationTokens: sortedCanonicalTokens([
          "eq:01,1,1:3",
          "le:1,0,0:5",
        ]),
      },
      {
        ...matrix,
        geometryTokens: sortedCanonicalTokens([
          ...matrix.geometryTokens.slice(0, 7),
          "cell:00:0:0",
        ]),
      },
      {
        ...transforms,
        queryTokens: ["net=rotate90", "op00=rotate90", "steps=1"],
      },
      {
        ...paths,
        queryTokens: ["goal:1:2", "start:00:0"],
      },
      {
        ...symmetry,
        geometryTokens: sortedCanonicalTokens(
          symmetry.geometryTokens.map((token) =>
            token === "cell:0:0" ? "cell:00:0" : token,
          ),
        ),
      },
      {
        ...counting,
        queryTokens: ["k=02", "operation=exactlyKShapes"],
      },
    ];
    for (const structure of paddedCases) {
      expect(() => CanonicalStructureSchema.parse(structure)).toThrow();
    }

    const firstRegion = counting.relationTokens[0];
    if (firstRegion === undefined) {
      throw new Error("expected a counting region token");
    }
    const [regionPrefix, maskText, countText] = firstRegion.split(":");
    if (regionPrefix !== "region" || maskText === undefined || countText === undefined) {
      throw new Error("unexpected counting region token shape");
    }
    const wrongCount = Number(countText) + 1;
    expect(() =>
      CanonicalStructureSchema.parse({
        ...counting,
        relationTokens: sortedCanonicalTokens([
          ...counting.relationTokens.slice(1),
          `region:${maskText}:${wrongCount}`,
        ]),
      }),
    ).toThrow();
  });

  it("serializes stably and selects the lexicographically smallest candidate", () => {
    const smaller = rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]);
    const larger = rankingStructure(["at:1:1", "before:0:1", "immediatelyBefore:1:2"]);
    expect(serializeCanonicalStructure(smaller)).toBe(
      serializeCanonicalStructure(
        CanonicalStructureSchema.parse(JSON.parse(JSON.stringify(smaller))),
      ),
    );
    expect(serializeCanonicalStructure(smaller) < serializeCanonicalStructure(larger)).toBe(true);
    expect(canonicalStructureHash(smaller)).not.toBe(canonicalStructureHash(larger));
    expect(canonicalStructuresEqual(smaller, larger)).toBe(false);
    expect(serializeCanonicalStructure(selectCanonicalStructure([larger, smaller]))).toBe(
      serializeCanonicalStructure(smaller),
    );
  });
});

describe("feature extraction and multiset arithmetic", () => {
  it("emits q, r, and g features while omitting family and domain tokens", () => {
    const features = extractStructureFeatures(
      rankingStructure(["at:0:1", "before:0:1", "immediatelyBefore:1:2"]),
    );
    expect(features.map((entry) => entry.feature)).toEqual([
      "r:at:0:1",
      "r:before:0:1",
      "r:immediatelyBefore:1:2",
    ]);
    expect(features.some((entry) => entry.feature.includes("size="))).toBe(false);

    const duplicated = extractStructureFeatures(
      rankingStructure(["at:0:1", "at:0:1", "before:0:1"]),
    );
    expect(duplicated.find((entry) => entry.feature === "r:at:0:1")?.count).toBe(2);
  });

  it("computes exact substitution, addition, deletion, two-edit, and empty scores", () => {
    const substitution = compareFeatureMultisets(
      featureMultiset({ x: 1 }),
      featureMultiset({ y: 1 }),
    );
    expect(substitution).toEqual({
      removed: 1,
      added: 1,
      editDistance: 1,
      intersection: 0,
      union: 2,
      jaccard: 0,
      commonFeatureCount: 0,
    });

    const addition = compareFeatureMultisets(
      featureMultiset({ x: 1 }),
      featureMultiset({ x: 1, y: 1 }),
    );
    expect(addition).toEqual({
      removed: 0,
      added: 1,
      editDistance: 1,
      intersection: 1,
      union: 2,
      jaccard: 0.5,
      commonFeatureCount: 1,
    });

    const deletion = compareFeatureMultisets(
      featureMultiset({ x: 1, y: 1 }),
      featureMultiset({ x: 1 }),
    );
    expect(deletion).toEqual({
      removed: 1,
      added: 0,
      editDistance: 1,
      intersection: 1,
      union: 2,
      jaccard: 0.5,
      commonFeatureCount: 1,
    });

    const twoEdits = compareFeatureMultisets(
      featureMultiset({ x: 1, y: 1 }),
      featureMultiset({ z: 1, w: 1 }),
    );
    expect(twoEdits).toEqual({
      removed: 2,
      added: 2,
      editDistance: 2,
      intersection: 0,
      union: 4,
      jaccard: 0,
      commonFeatureCount: 0,
    });

    const multisetSubstitution = compareFeatureMultisets(
      featureMultiset({ x: 2 }),
      featureMultiset({ x: 1, y: 1 }),
    );
    expect(multisetSubstitution).toEqual({
      removed: 1,
      added: 1,
      editDistance: 1,
      intersection: 1,
      union: 3,
      jaccard: 1 / 3,
      commonFeatureCount: 1,
    });

    expect(compareFeatureMultisets([], [])).toEqual({
      removed: 0,
      added: 0,
      editDistance: 0,
      intersection: 0,
      union: 0,
      jaccard: 1,
      commonFeatureCount: 0,
    });
    expect(compareFeatureMultisets([], featureMultiset({ x: 1 }))).toEqual({
      removed: 0,
      added: 1,
      editDistance: 1,
      intersection: 0,
      union: 1,
      jaccard: 0,
      commonFeatureCount: 0,
    });
  });

  it("reproduces the mandatory counting one-edit pair as 33/35", () => {
    const exactlyTwo = extractStructureFeatures(countingStructure(2));
    const exactlyThree = extractStructureFeatures(countingStructure(3));
    const comparison = compareFeatureMultisets(exactlyTwo, exactlyThree);
    expect(comparison.editDistance).toBe(1);
    expect(comparison.intersection).toBe(33);
    expect(comparison.union).toBe(35);
    expect(comparison.jaccard).toBe(33 / 35);
    expect(comparison.commonFeatureCount).toBe(33);
  });
});

describe("bounded search primitives", () => {
  it("counts and enumerates permutations with explicit completion state", () => {
    expect(countPermutations(0)).toBe(1);
    expect(countPermutations(4)).toBe(24);
    const all = collectPermutations([1, 2, 3]);
    expect(all.visited).toBe(6);
    expect(all.complete).toBe(true);
    expect(new Set(all.items.map((permutation) => permutation.join(","))).size).toBe(6);

    const capped = collectPermutations([1, 2, 3], { maxResults: 2 });
    expect(capped.visited).toBe(2);
    expect(capped.complete).toBe(false);

    const exactCap = collectPermutations([1, 2, 3], { maxResults: 6 });
    expect(exactCap.visited).toBe(6);
    expect(exactCap.complete).toBe(true);
  });

  it("minimizes over permutations and cartesian products deterministically", () => {
    const minimized = minimizeOverPermutations(
      ["b", "a", "c"],
      (permutation) => permutation.join(""),
      compareCanonicalStrings,
    );
    expect(minimized.best).toBe("abc");
    expect(minimized.visited).toBe(6);
    expect(minimized.complete).toBe(true);

    const combinations = collectCartesianProduct([[1, 2], [3, 4]]);
    expect(combinations.visited).toBe(4);
    expect(combinations.complete).toBe(true);
    expect(countCartesianProduct([[1, 2], [3, 4]])).toBe(4);

    const capped = collectCartesianProduct([[1, 2], [3, 4]], { maxResults: 3 });
    expect(capped.visited).toBe(3);
    expect(capped.complete).toBe(false);
  });

  it("throws a typed solver limit at the exact state boundary", () => {
    const counter = new SearchCounter(2);
    counter.consume();
    counter.consume();
    const error = thrown(() => counter.consume());
    expect(error).toBeInstanceOf(SolverLimitError);
    expect(error).toHaveProperty("code", "SOLVER_LIMIT");
    expect(error).toHaveProperty("limit", 2);
    expect(error).toHaveProperty("attempted", 3);
    expect(counter.visited).toBe(2);
    expect(counter.remaining).toBe(0);
  });

  it("supports finite bitset domain operations", () => {
    const full = Bitset.full(10);
    expect(full.count()).toBe(10);
    expect(full.indices()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const left = Bitset.fromIndices(10, [1, 3, 9]);
    const right = Bitset.fromIndices(10, [3, 4, 9]);
    expect(left.indices()).toEqual([1, 3, 9]);
    expect(left.and(right).indices()).toEqual([3, 9]);
    expect(left.or(right).indices()).toEqual([1, 3, 4, 9]);
    expect(left.equals(left.clone())).toBe(true);
    expect(left.equals(right)).toBe(false);
    expect(new Bitset(0).isEmpty()).toBe(true);
    expect(() => left.set(10)).toThrow(RangeError);
    expect(() => left.and(new Bitset(3))).toThrow(RangeError);
  });
});

describe("reduced clue core", () => {
  const before = (a: number, b: number): ToyClue => ({ kind: "before", a, b });

  it("removes a redundant transitive clue and canonicalizes the retained core", () => {
    const core = reduceClueCore({
      clues: [before(0, 1), before(1, 2), before(0, 2)],
      normalize: toyNormalize,
      clueKey: toyKey,
      solve: (clues) => toySolve(3, clues),
    });
    expect(core.retained.map(toyKey)).toEqual(["before:0:1", "before:1:2"]);
    expect(core.removedKeys).toEqual(["before:0:2"]);
    expect(core.evaluations).toBe(4);
    expect(core.baselineSolutionCount).toBe(1);
  });

  it("removes a duplicate redundant clue and keeps a nonredundant clue", () => {
    const duplicate = reduceClueCore({
      clues: [before(0, 1), before(0, 1), before(1, 2)],
      normalize: toyNormalize,
      clueKey: toyKey,
      solve: (clues) => toySolve(3, clues),
    });
    expect(duplicate.retained.map(toyKey)).toEqual(["before:0:1", "before:1:2"]);
    expect(duplicate.removedKeys).toEqual(["before:0:1"]);

    const nonredundant = reduceClueCore({
      clues: [before(0, 1), before(0, 2), before(1, 2)],
      normalize: toyNormalize,
      clueKey: toyKey,
      solve: (clues) => toySolve(3, clues),
    });
    expect(nonredundant.retained.map(toyKey)).toEqual(["before:0:1", "before:1:2"]);
    expect(nonredundant.removedKeys).toEqual(["before:0:2"]);
  });

  it("rejects nonunique baselines, empty clue sets, and exceeded evaluation caps", () => {
    const nonunique = thrown(() =>
      reduceClueCore({
        clues: [before(0, 1)],
        normalize: toyNormalize,
        clueKey: toyKey,
        solve: (clues) => toySolve(3, clues),
      }),
    );
    expect(nonunique).toBeInstanceOf(ReducedCoreError);
    expectErrorCode(nonunique, "BASELINE_NOT_UNIQUE");

    const empty = thrown(() =>
      reduceClueCore({
        clues: [],
        normalize: toyNormalize,
        clueKey: toyKey,
        solve: (clues) => toySolve(3, clues),
      }),
    );
    expect(empty).toBeInstanceOf(ReducedCoreError);
    expectErrorCode(empty, "EMPTY_CLUE_SET");

    const capped = thrown(() =>
      reduceClueCore({
        clues: [before(0, 1), before(1, 2), before(0, 2)],
        normalize: toyNormalize,
        clueKey: toyKey,
        solve: (clues) => toySolve(3, clues),
        maxEvaluations: 2,
      }),
    );
    expect(capped).toBeInstanceOf(ReducedCoreError);
    expectErrorCode(capped, "CORE_REDUCTION_LIMIT");
  });
});

describe("choice construction", () => {
  it("deep-compares nested values independent of object key order", () => {
    expect(deepEqual({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(
      true,
    );
  });

  it("builds exactly four deeply distinct choices with a value-derived key", () => {
    const correct = { value: 4 };
    const set = makeChoiceSet({
      correct,
      distractors: [{ value: 1 }, { value: 2 }, { value: 3 }],
      seed: SEED_A,
    });
    expect(set.choices).toHaveLength(4);
    expect(set.choices.map((choice) => choice.label)).toEqual(["A", "B", "C", "D"]);
    expect(() => verifyChoiceSet(set)).not.toThrow();
    const selected = set.choices.find((choice) => choice.label === set.correctLabel);
    expect(deepEqual(selected?.value, correct)).toBe(true);

    const repeated = makeChoiceSet({
      correct,
      distractors: [{ value: 1 }, { value: 2 }, { value: 3 }],
      seed: SEED_A,
    });
    expect(repeated).toEqual(set);
  });

  it("uses the seed to change the stored option order", () => {
    const orders = new Set<string>();
    for (const seed of [SEED_A, SEED_B, SEED_C, SEED_D]) {
      const set = makeChoiceSet({
        correct: "correct",
        distractors: ["wrong-1", "wrong-2", "wrong-3"],
        seed,
      });
      orders.add(set.choices.map((choice) => String(choice.value)).join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("rejects duplicate, missing, and three-choice option sets", () => {
    const duplicate = thrown(() =>
      makeChoiceSet({
        correct: "correct",
        distractors: ["wrong", "wrong", "other"],
        seed: SEED_A,
      }),
    );
    expect(duplicate).toBeInstanceOf(AnswerContractError);
    expectErrorCode(duplicate, "DUPLICATE_OPTION");

    const correctDuplicated = thrown(() =>
      makeChoiceSet({
        correct: "correct",
        distractors: ["correct", "other", "third"],
        seed: SEED_A,
      }),
    );
    expectErrorCode(correctDuplicated, "DUPLICATE_OPTION");

    const threeChoices = thrown(() =>
      makeChoiceSet({
        correct: "correct",
        distractors: ["one", "two"] as unknown as [string, string, string],
        seed: SEED_A,
      }),
    );
    expect(threeChoices).toBeInstanceOf(AnswerContractError);
    expectErrorCode(threeChoices, "INVALID_CHOICE_COUNT");

    const fiveChoices = thrown(() =>
      makeChoiceSet({
        correct: "correct",
        distractors: ["one", "two", "three", "four"] as unknown as [string, string, string],
        seed: SEED_A,
      }),
    );
    expectErrorCode(fiveChoices, "INVALID_CHOICE_COUNT");
  });

  it("validates choice sets at the schema boundary", () => {
    const valid = makeChoiceSet({
      correct: "correct",
      distractors: ["one", "two", "three"],
      seed: SEED_A,
    });
    expect(() => ChoiceSetSchema.parse(valid)).not.toThrow();
    expect(() =>
      ChoiceSetSchema.parse({
        choices: valid.choices.slice(0, 3),
        correctLabel: valid.correctLabel,
      }),
    ).toThrow();
    expect(() =>
      ChoiceSetSchema.parse({
        choices: [
          valid.choices[0],
          valid.choices[1],
          valid.choices[2],
          { label: "D", value: valid.choices[0]?.value },
        ],
        correctLabel: valid.correctLabel,
      }),
    ).toThrow();
    expect(() =>
      ChoiceSetSchema.parse({
        choices: valid.choices,
        correctLabel: "E",
      }),
    ).toThrow();
  });
});

describe("visible rules and fact namespaces", () => {
  const rules: VisibleRules = {
    domain: "A bounded domain.",
    closedWorld: "The closed world is fixed.",
    target: "Select the target.",
    operations: ["operation one", "operation two"],
    conventions: [],
  };

  it("validates nonempty code-owned rules and allows empty conventions", () => {
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(() => VisibleRulesSchema.parse({ ...rules, conventions: ["row-major"] })).not.toThrow();
    expect(() => VisibleRulesSchema.parse({ ...rules, domain: "" })).toThrow();
    expect(() => VisibleRulesSchema.parse({ ...rules, operations: [] })).toThrow();
    expect(() => VisibleRulesSchema.parse({ ...rules, extra: true })).toThrow();
  });

  it("creates fixed rule facts and namespaced local/observation/derived facts", () => {
    const facts = ruleFacts(rules);
    expect(facts.map((fact) => fact.factId)).toEqual([
      RULE_FACT_IDS.domain,
      RULE_FACT_IDS.closedWorld,
      RULE_FACT_IDS.target,
      RULE_FACT_IDS.operations,
      RULE_FACT_IDS.conventions,
    ]);
    expect(facts.every((fact) => fact.kind === "rule")).toBe(true);
    expect(facts[4]?.text).toContain("No additional coordinate");

    expect(formatFactId("local", 0)).toBe("f001");
    expect(formatFactId("local", 9)).toBe("f010");
    expect(formatFactId("local", 99)).toBe("f100");
    expect(formatFactId("observation", 0)).toBe("p001");
    expect(formatFactId("derived", 0)).toBe("s001");
    expect(() => formatFactId("local", -1)).toThrow(RangeError);
    expect(() => formatFactId("local", 1.5)).toThrow(RangeError);
    expect(() => formatFactId("local", 999999)).toThrow(RangeError);
    expect(() =>
      FactSchema.parse({ factId: "f000", kind: "local", text: "invalid zero index" }),
    ).toThrow();
  });

  it("rejects namespace mismatches and duplicate merged facts", () => {
    const local: Fact = { factId: "f001", kind: "local", text: "local clue" };
    const observation: Fact = { factId: "p001", kind: "observation", text: "observation" };
    const derived: Fact = { factId: "s001", kind: "derived", text: "derived" };
    expect(() => assertFactNamespace(local)).not.toThrow();
    expect(() => assertFactNamespace(observation)).not.toThrow();
    expect(() => assertFactNamespace(derived)).not.toThrow();
    expect(() =>
      assertFactNamespace({ factId: "p001", kind: "local", text: "wrong namespace" }),
    ).toThrow(FactContractError);
    expect(() =>
      assertFactNamespace({ factId: "r-other", kind: "rule", text: "wrong rule" }),
    ).toThrow(FactContractError);

    expect(mergeFactInventory([local], [derived]).map((fact) => fact.factId)).toEqual([
      "f001",
      "s001",
    ]);
    expect(() => mergeFactInventory([local], [local])).toThrow(FactContractError);
  });

  it("checks explainable references and exact local clue coverage", () => {
    const local: Fact[] = [
      { factId: "f001", kind: "local", text: "first" },
      { factId: "f002", kind: "local", text: "second" },
    ];
    const derived: Fact[] = [{ factId: "s001", kind: "derived", text: "proof" }];
    const inventory = mergeFactInventory(local, derived);
    expect(() => assertFactReferences(["f001", "s001"], inventory)).not.toThrow();
    expect(() => assertFactReferences(["f003"], inventory)).toThrow(FactContractError);
    expect(() => assertLocalClueFactCoverage(["f001", "f002"], local)).not.toThrow();
    expect(() => assertLocalClueFactCoverage(["f001"], local)).toThrow(FactContractError);
    expect(() => assertLocalClueFactCoverage(["f001", "f001"], local)).toThrow(
      FactContractError,
    );
  });
});

describe("family engine contract with a test-only engine", () => {
  const engine = makeToyEngine();

  it("keeps the hidden witness out of the spec and re-solves tampered specs", () => {
    const spec = engine.generateSpec(SEED_A, 1);
    expect(Object.keys(spec).sort()).toEqual(["clues", "size"]);
    const result = engine.enumerateSolutions(spec);
    expect(result.solutionCount).toBe(1);
    expect(result.correctAnswer).not.toBeNull();
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique toy answer");
    }
    expect(engine.verifyAnswer(spec, correct)).toBe(true);
    expect(engine.verifyAnswer(spec, [3, 2, 1, 0])).toBe(false);
    expect(() => ToySpecSchema.parse({ ...spec, witness: correct })).toThrow();

    const first = spec.clues[0];
    if (first === undefined) {
      throw new Error("expected a first toy clue");
    }
    const tampered: ToySpec = {
      ...spec,
      clues: [{ ...first, a: first.b, b: first.a }, ...spec.clues.slice(1)],
    };
    const tamperedResult = engine.enumerateSolutions(tampered);
    expect(tamperedResult.solutionCount).not.toBe(1);
    expect(tamperedResult.correctAnswer).toBeNull();
    expect(() => assertSolveResult(tamperedResult)).not.toThrow();
  });

  it("produces four options whose only satisfying choice is the code key", () => {
    const spec = engine.generateSpec(SEED_A, 1);
    const result = engine.enumerateSolutions(spec);
    const correct = result.correctAnswer;
    if (correct === null) {
      throw new Error("expected a unique toy answer");
    }
    const set = engine.makeOptions(spec, correct, SEED_B);
    expect(set.choices).toHaveLength(4);
    expect(() => verifyChoiceSet(set)).not.toThrow();
    for (const choice of set.choices) {
      expect(engine.verifyAnswer(spec, choice.value)).toBe(
        choice.label === set.correctLabel,
      );
    }
  });

  it("canonicalizes relabelings, ignores redundant clues, and separates different structures", () => {
    const specs = [SEED_A, SEED_B, SEED_C, SEED_D].map((seed) =>
      engine.generateSpec(seed, 1),
    );
    const baseline = specs[0];
    if (baseline === undefined) {
      throw new Error("expected a generated toy spec");
    }
    const baselineStructure = engine.canonicalData(baseline);
    for (const spec of specs) {
      expect(canonicalStructuresEqual(engine.canonicalData(spec), baselineStructure)).toBe(true);
    }

    const duplicated: ToySpec = {
      ...baseline,
      clues: [...baseline.clues, baseline.clues[0] as ToyClue],
    };
    expect(canonicalStructuresEqual(engine.canonicalData(duplicated), baselineStructure)).toBe(
      true,
    );

    const anchored: ToySpec = {
      size: 4,
      clues: [
        { kind: "at", a: 0, b: 1 },
        { kind: "at", a: 1, b: 2 },
        { kind: "at", a: 2, b: 3 },
        { kind: "at", a: 3, b: 4 },
      ],
    };
    expect(canonicalStructuresEqual(engine.canonicalData(anchored), baselineStructure)).toBe(
      false,
    );
  });

  it("exposes visible rules, local facts, and deterministic test mutations", () => {
    const spec = engine.generateSpec(SEED_A, 1);
    const rules = engine.visibleRules(spec);
    expect(() => VisibleRulesSchema.parse(rules)).not.toThrow();
    expect(rules.domain.length).toBeGreaterThan(0);
    expect(rules.operations.length).toBeGreaterThan(0);
    const facts = engine.facts(spec);
    expect(facts.map((fact) => fact.factId)).toEqual(["f001", "f002", "f003"]);
    const result = engine.enumerateSolutions(spec);
    if (result.proof === null) {
      throw new Error("expected a toy proof");
    }
    const inventory = mergeFactInventory(facts, result.proof.facts);
    expect(inventory.map((fact) => fact.factId)).toEqual(["f001", "f002", "f003", "s001"]);
    expect(() => assertFactReferences(["f001", "s001"], inventory)).not.toThrow();

    const firstMutations = engine.testMutations(spec);
    const secondMutations = engine.testMutations(spec);
    expect(firstMutations).toEqual(secondMutations);
    expect(firstMutations.map((mutation) => mutation.id)).toEqual([
      "duplicate-first-clue",
      "reverse-first-clue",
    ]);
  });

  it("validates solve-result invariants", () => {
    const spec = engine.generateSpec(SEED_A, 1);
    const result = engine.enumerateSolutions(spec);
    expect(() => SolveResultSchema.parse(result)).not.toThrow();
    expect(() =>
      SolveResultSchema.parse({
        ...result,
        proof: {
          facts: [{ factId: "f001", kind: "local", text: "not derived" }],
          witness: result.correctAnswer,
        },
      }),
    ).toThrow();
  });
});

describe("family registry", () => {
  it("registers engines and renderers separately and rejects duplicates", () => {
    const registry = new FamilyRegistry();
    expect(registry.listEngineFamilies()).toEqual([]);
    const engine = makeToyEngine();
    registry.registerEngine(engine);
    expect(registry.listEngineFamilies()).toEqual(["ranking"]);
    expect(registry.getEngine("ranking").family).toBe("ranking");
    const duplicate = thrown(() => registry.registerEngine(makeToyEngine()));
    expect(duplicate).toBeInstanceOf(RegistryError);
    expectErrorCode(duplicate, "DUPLICATE_REGISTRATION");

    const renderer: RendererContract<{ readonly value: number }, { readonly doubled: number }> = {
      family: "matrix",
      version: "test-renderer-v1",
      buildScene(spec) {
        return { doubled: spec.value * 2 };
      },
      assertScene() {
        // The toy renderer has no family scene invariants to check.
      },
    };
    registry.registerRenderer(renderer);
    expect(registry.listRendererFamilies()).toEqual(["matrix"]);
    expect(registry.getRenderer("matrix").family).toBe("matrix");
    const duplicateRenderer = thrown(() => registry.registerRenderer(renderer));
    expectErrorCode(duplicateRenderer, "DUPLICATE_REGISTRATION");
  });

  it("allows an engine and a renderer for the same SVG family", () => {
    const registry = new FamilyRegistry();
    registry.registerEngine(makeDummyEngine("matrix", "svg"));
    registry.registerRenderer({
      family: "matrix",
      version: "test-renderer-v1",
      buildScene: (spec: unknown) => spec,
      assertScene: () => undefined,
    });
    expect(registry.hasEngine("matrix")).toBe(true);
    expect(registry.hasRenderer("matrix")).toBe(true);
  });

  it("rejects invalid modality, text renderers, unknown families, and missing methods", () => {
    const registry = new FamilyRegistry();
    const wrongModality = {
      ...makeDummyEngine("ranking", "text"),
      modality: "svg" as Modality,
    };
    const modalityError = thrown(() => registry.registerEngine(wrongModality));
    expectErrorCode(modalityError, "INVALID_REGISTRATION");

    const textRenderer = {
      family: "ranking" as SvgFamily,
      version: "test-renderer-v1",
      buildScene: (spec: unknown) => spec,
      assertScene: () => undefined,
    };
    const rendererError = thrown(() => registry.registerRenderer(textRenderer));
    expectErrorCode(rendererError, "INVALID_REGISTRATION");

    const unknownFamily = {
      ...makeDummyEngine("ranking", "text"),
      family: "unknown" as Family,
    };
    const familyError = thrown(() => registry.registerEngine(unknownFamily));
    expectErrorCode(familyError, "INVALID_REGISTRATION");

    const missingMethod = {
      ...makeDummyEngine("matrix", "svg"),
      canonicalData: undefined,
    } as unknown as FamilyEngine<unknown, unknown>;
    const methodError = thrown(() => registry.registerEngine(missingMethod));
    expectErrorCode(methodError, "INVALID_REGISTRATION");
  });

  it("checks completeness of engines and optional renderers", () => {
    const registry = new FamilyRegistry();
    expect(() => registry.assertComplete()).toThrow(RegistryError);
    for (const family of FAMILIES) {
      registry.registerEngine(makeDummyEngine(family, MODALITY_BY_FAMILY[family]));
    }
    expect(() => registry.assertComplete()).not.toThrow();
    expect(() => registry.assertComplete({ requireRenderers: true })).toThrow(RegistryError);
    for (const family of SVG_FAMILIES) {
      registry.registerRenderer({
        family,
        version: "test-renderer-v1",
        buildScene: (spec: unknown) => spec,
        assertScene: () => undefined,
      });
    }
    expect(() => registry.assertComplete({ requireRenderers: true })).not.toThrow();
  });

  it("rejects arbitrary transform operations outside the D4 vocabulary", () => {
    const error = thrown(() => assertKnownTransformOperation("rotate17"));
    expect(error).toHaveProperty("code", "INVALID_TRANSFORM_OPERATION");
    expect(assertKnownTransformOperation("rotate90")).toBe("rotate90");
  });
});
