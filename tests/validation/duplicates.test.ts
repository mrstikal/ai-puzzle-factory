import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/util/hash.js";
import {
  CandidateBarrierInputSchema,
  CandidateFingerprintSchema,
  DuplicateBarrierResultSchema,
  FingerprintContentSchema,
  type CandidateBarrierInput,
  type CandidateFingerprint,
  type FingerprintContent,
  type RenderHashes,
} from "../../src/domain/candidate.js";
import {
  FAMILIES,
  MODALITY_BY_FAMILY,
  SlotPlanSchema,
  type Family,
  type Lane,
  type SlotPlan,
} from "../../src/domain/experiment.js";
import {
  canonicalStructureHash,
  extractStructureFeatures,
} from "../../src/families/canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
  type Fact,
  type VisibleRules,
} from "../../src/families/contracts.js";
import { countingEngine } from "../../src/families/counting/engine.js";
import {
  CountingSpecSchema,
  sortCountingCells,
  type CountingCell,
  type CountingSpec,
} from "../../src/families/counting/schema.js";
import { matrixEngine } from "../../src/families/matrix/engine.js";
import { MatrixSpecSchema, type MatrixSpec } from "../../src/families/matrix/schema.js";
import { rankingEngine } from "../../src/families/ranking/engine.js";
import {
  RankingSpecSchema,
  type RankingClue,
  type RankingSpec,
} from "../../src/families/ranking/schema.js";
import { transformsEngine } from "../../src/families/transforms/engine.js";
import {
  TransformsSpecSchema,
  gridFromCells,
  type TransformCell,
  type TransformsSpec,
} from "../../src/families/transforms/schema.js";
import {
  DuplicateBarrierError,
  evaluateNearPair,
  runDuplicateBarrier,
} from "../../src/validation/duplicates.js";
import {
  FingerprintError,
  assertFingerprintConsistency,
  computeCanonicalSpecHash,
  computeContentHash,
  computeStructureFingerprint,
  fingerprintCandidate,
  type FingerprintEngine,
} from "../../src/validation/fingerprints.js";

interface TestEngine<S> extends FingerprintEngine<S> {
  visibleRules(spec: S): VisibleRules;
  facts(spec: S): readonly Fact[];
}

function slot(family: Family, ordinal: number, lane: Lane): SlotPlan {
  return SlotPlanSchema.parse({
    slotId: `${MODALITY_BY_FAMILY[family]}-${family}-${String(ordinal).padStart(2, "0")}`,
    slotOrdinal: ordinal,
    family,
    modality: MODALITY_BY_FAMILY[family],
    lane,
    difficulty: 1,
  });
}

function contentFor<S>(
  engine: TestEngine<S>,
  spec: S,
  question: string,
): FingerprintContent {
  const facts = engine.facts(spec);
  return FingerprintContentSchema.parse({
    version: 1,
    question,
    rules: engine.visibleRules(spec),
    clues:
      engine.modality === "text"
        ? facts.map((fact) => ({ factId: fact.factId, text: fact.text }))
        : [],
    options: ["A", "B", "C", "D"].map((label) => ({
      label,
      text: `Option ${label}`,
    })),
    hint: "Use the stated rules.",
    explanation: [],
  });
}

function renderHashes(seed: string): RenderHashes {
  return {
    svg: sha256Hex(`svg:${seed}`),
    png: sha256Hex(`png:${seed}`),
  };
}

function readyCandidateWithContent<S>(
  plan: SlotPlan,
  engine: TestEngine<S>,
  spec: S,
  content: FingerprintContent,
  hashes?: RenderHashes,
): CandidateBarrierInput {
  return CandidateBarrierInputSchema.parse({
    slotId: plan.slotId,
    slotOrdinal: plan.slotOrdinal,
    family: plan.family,
    modality: plan.modality,
    lane: plan.lane,
    preparationStatus: "ready",
    presentationCheckPassed: true,
    formalPassed: true,
    terminalVerdict: null,
    fingerprint: fingerprintCandidate({
      engine,
      spec,
      content,
      renderHashes: hashes,
    }),
  });
}

function readyCandidate<S>(
  plan: SlotPlan,
  engine: TestEngine<S>,
  spec: S,
  question: string,
  hashes?: RenderHashes,
): CandidateBarrierInput {
  return readyCandidateWithContent(
    plan,
    engine,
    spec,
    contentFor(engine, spec, question),
    hashes,
  );
}

function earlyCandidate<S>(
  plan: SlotPlan,
  engine: TestEngine<S>,
  spec: S,
  options: {
    readonly question?: string;
    readonly hashes?: RenderHashes;
    readonly terminalVerdict?: "generation_error" | "rejected";
  } = {},
): CandidateBarrierInput {
  return CandidateBarrierInputSchema.parse({
    slotId: plan.slotId,
    slotOrdinal: plan.slotOrdinal,
    family: plan.family,
    modality: plan.modality,
    lane: plan.lane,
    preparationStatus: "early_failure",
    presentationCheckPassed: false,
    formalPassed: true,
    terminalVerdict: options.terminalVerdict ?? "generation_error",
    fingerprint: fingerprintCandidate({
      engine,
      spec,
      content:
        options.question === undefined
          ? undefined
          : contentFor(engine, spec, options.question),
      renderHashes: options.hashes,
    }),
  });
}

function barrier(
  plannedSlots: readonly SlotPlan[],
  candidates: readonly CandidateBarrierInput[],
) {
  return runDuplicateBarrier({ plannedSlots, candidates });
}

function assessmentOf(
  result: ReturnType<typeof runDuplicateBarrier>,
  slotId: string,
) {
  const assessment = result.assessments.find((entry) => entry.slotId === slotId);
  if (assessment === undefined) {
    throw new Error(`missing assessment ${slotId}`);
  }
  return assessment;
}

const immediatelyBefore = (first: number, second: number): RankingClue => ({
  kind: "immediatelyBefore",
  before: first,
  after: second,
});

const at = (item: number, position: number): RankingClue => ({
  kind: "at",
  item,
  position,
});

const RANKING_CHAIN: RankingSpec = RankingSpecSchema.parse({
  size: 4,
  clues: [
    immediatelyBefore(0, 1),
    immediatelyBefore(1, 2),
    immediatelyBefore(2, 3),
  ],
});

const RANKING_REDUNDANT: RankingSpec = RankingSpecSchema.parse({
  size: 4,
  clues: [
    immediatelyBefore(0, 1),
    immediatelyBefore(1, 2),
    immediatelyBefore(2, 3),
    immediatelyBefore(0, 1),
  ],
});

const RANKING_ANCHORED: RankingSpec = RankingSpecSchema.parse({
  size: 4,
  clues: [at(0, 1), at(1, 2), at(2, 3), at(3, 4)],
});

function countingCells(indices: readonly number[]): CountingCell[] {
  return sortCountingCells(
    indices.map((index) => ({
      row: Math.floor(index / 5),
      column: index % 5,
    })),
  );
}

const COUNTING_SHAPES = [
  { cells: countingCells([1, 6, 7, 8]) },
  { cells: countingCells([2, 6, 7, 8]) },
  { cells: countingCells([3, 6, 7, 8]) },
] as const;

function countingSpec(k: 2 | 3): CountingSpec {
  return CountingSpecSchema.parse({
    shapes: COUNTING_SHAPES,
    query: { operation: "exactlyKShapes", k },
  });
}

const COUNTING_TWO_EDIT_A: CountingSpec = CountingSpecSchema.parse({
  shapes: [
    { cells: countingCells([18, 19, 23]) },
    { cells: countingCells([17, 18, 19, 23]) },
  ],
  query: { operation: "unionCount" },
});

const COUNTING_TWO_EDIT_B: CountingSpec = CountingSpecSchema.parse({
  shapes: [
    { cells: countingCells([11, 16, 21, 22]) },
    { cells: countingCells([16, 21, 22]) },
  ],
  query: { operation: "unionCount" },
});

const TRANSFORM_SOURCE: readonly TransformCell[] = [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 1, column: 1 },
  { row: 2, column: 1 },
];

function transformSpec(operations: readonly ("rotate90" | "rotate180")[]): TransformsSpec {
  return TransformsSpecSchema.parse({
    source: gridFromCells(TRANSFORM_SOURCE),
    operations,
  });
}

const MATRIX_SPEC: MatrixSpec = MatrixSpecSchema.parse({
  rule: "xor",
  cells: [
    [1, 2, 3],
    [4, 3, 7],
    [5, 1, null],
  ],
});

describe("candidate fingerprints", () => {
  it("separates content, canonical spec, structure, and render hashes", () => {
    const content = contentFor(rankingEngine, RANKING_CHAIN, "Question one.");
    const otherContent = contentFor(rankingEngine, RANKING_CHAIN, "Question two.");
    const chain = fingerprintCandidate({
      engine: rankingEngine,
      spec: RANKING_CHAIN,
      content,
    });
    const redundant = fingerprintCandidate({
      engine: rankingEngine,
      spec: RANKING_REDUNDANT,
      content,
    });
    const anchored = fingerprintCandidate({
      engine: rankingEngine,
      spec: RANKING_ANCHORED,
      content,
    });
    const changedContent = fingerprintCandidate({
      engine: rankingEngine,
      spec: RANKING_CHAIN,
      content: otherContent,
    });
    const relabeled = fingerprintCandidate({
      engine: rankingEngine,
      spec: RankingSpecSchema.parse({
        size: 4,
        clues: [
          immediatelyBefore(2, 0),
          immediatelyBefore(0, 3),
          immediatelyBefore(3, 1),
        ],
      }),
      content,
    });
    expect(chain.specHash).toBe(computeCanonicalSpecHash(rankingEngine, RANKING_CHAIN));
    expect(chain.structureHash).toBe(
      computeStructureFingerprint(rankingEngine, RANKING_CHAIN).structureHash,
    );
    expect(chain.contentHash).toBe(computeContentHash(content));
    expect(chain.specHash).not.toBe(redundant.specHash);
    expect(chain.structureHash).toBe(redundant.structureHash);
    expect(chain.contentHash).toBe(redundant.contentHash);
    expect(chain.structureHash).not.toBe(anchored.structureHash);
    expect(relabeled.structureHash).toBe(chain.structureHash);
    expect(relabeled.specHash).not.toBe(chain.specHash);
    expect(chain.contentHash).not.toBe(changedContent.contentHash);
    expect(chain.renderHashes).toEqual({ svg: null, png: null });
    expect(chain.features.length).toBeGreaterThan(0);
    expect(() => assertFingerprintConsistency(chain)).not.toThrow();
  });

  it("rejects text render hashes, malformed content, and inconsistent structure data", () => {
    const content = contentFor(rankingEngine, RANKING_CHAIN, "Question one.");
    expect(() =>
      fingerprintCandidate({
        engine: rankingEngine,
        spec: RANKING_CHAIN,
        content,
        renderHashes: renderHashes("text"),
      }),
    ).toThrow(FingerprintError);
    expect(() =>
      computeContentHash({
        ...content,
        options: [
          { label: "A", text: "one" },
          { label: "A", text: "two" },
          { label: "C", text: "three" },
          { label: "D", text: "four" },
        ],
      }),
    ).toThrow();
    expect(() =>
      computeContentHash({
        ...content,
        clues: [
          { factId: "f001", text: "one" },
          { factId: "f001", text: "two" },
        ],
      }),
    ).toThrow();
    expect(() =>
      fingerprintCandidate({
        engine: rankingEngine,
        spec: RANKING_CHAIN,
        content: {
          ...content,
          clues: [{ factId: "r-domain", text: "domain rule" }],
        },
      }),
    ).toThrow(FingerprintError);
    expect(() =>
      fingerprintCandidate({
        engine: countingEngine,
        spec: countingSpec(2),
        content: {
          ...contentFor(countingEngine, countingSpec(2), "Counting question."),
          clues: [{ factId: "f001", text: "not allowed in svg" }],
        },
        renderHashes: renderHashes("scope"),
      }),
    ).toThrow(FingerprintError);

    const valid = fingerprintCandidate({
      engine: rankingEngine,
      spec: RANKING_CHAIN,
      content,
    });
    expect(() =>
      assertFingerprintConsistency({ ...valid, structureHash: sha256Hex("wrong") }),
    ).toThrow(FingerprintError);

  });
});

describe("deterministic duplicate barrier", () => {
  it("assigns exact, spec, and structural duplicates to the lowest eligible ordinal across lanes", () => {
    const slots = [
      slot("ranking", 1, "spec_first"),
      slot("ranking", 2, "ai_spec"),
      slot("ranking", 3, "spec_first"),
      slot("ranking", 4, "ai_spec"),
    ];
    const candidates = [
      readyCandidate(slots[0]!, rankingEngine, RANKING_CHAIN, "Question one."),
      readyCandidate(slots[1]!, rankingEngine, RANKING_REDUNDANT, "Question two."),
      readyCandidate(slots[2]!, rankingEngine, RANKING_CHAIN, "Question three."),
      readyCandidate(slots[3]!, rankingEngine, RANKING_ANCHORED, "Question four."),
    ];
    const result = barrier(slots, candidates);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assessments)).toBe(true);
    expect(Object.isFrozen(result.assessments[0])).toBe(true);
    expect(Object.isFrozen(result.assessments[0]?.features)).toBe(true);
    expect(assessmentOf(result, slots[0]!.slotId).structureHash).not.toBeNull();
    expect(assessmentOf(result, slots[0]!.slotId).features.length).toBeGreaterThan(0);
    expect(assessmentOf(result, slots[0]!.slotId)).toMatchObject({
      outcome: "owner",
      groupOwner: true,
      ownerSlotId: null,
      duplicateKind: null,
      eligible: true,
    });
    expect(assessmentOf(result, slots[1]!.slotId)).toMatchObject({
      outcome: "structural_duplicate",
      ownerSlotId: slots[0]!.slotId,
      duplicateKind: "structural",
      failureCodes: ["STRUCTURAL_DUPLICATE"],
    });
    expect(assessmentOf(result, slots[2]!.slotId)).toMatchObject({
      outcome: "spec_duplicate",
      ownerSlotId: slots[0]!.slotId,
      duplicateKind: "canonical_spec",
      failureCodes: ["EXACT_DUPLICATE"],
    });
    expect(assessmentOf(result, slots[3]!.slotId)).toMatchObject({
      outcome: "unique",
      groupOwner: false,
    });
    expect(result.summary).toMatchObject({
      plannedSlots: 4,
      preparedSlots: 4,
      eligibleCandidates: 4,
      exactGroups: 0,
      specGroups: 1,
      structuralGroups: 1,
      exactDuplicates: 0,
      specDuplicates: 1,
      structuralDuplicates: 1,
      nearPairs: 0,
      nearSuspectedCandidates: 0,
      replacements: 0,
      terminalFailuresRewritten: 0,
    });
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs.map((pair) => pair.kind).sort()).toEqual([
      "canonical_spec",
      "structural",
    ]);
  });

  it("gives exact content precedence and keeps the lowest ordinal owner under shuffled completion order", () => {
    const slots = [slot("ranking", 1, "ai_spec"), slot("ranking", 2, "spec_first")];
    const sharedContent = contentFor(rankingEngine, RANKING_CHAIN, "Shared question.");
    const first = readyCandidateWithContent(
      slots[0]!,
      rankingEngine,
      RANKING_ANCHORED,
      sharedContent,
    );
    const second = readyCandidateWithContent(
      slots[1]!,
      rankingEngine,
      RANKING_CHAIN,
      sharedContent,
    );
    const result = barrier(slots, [second, first]);
    expect(assessmentOf(result, slots[0]!.slotId)).toMatchObject({
      outcome: "owner",
      groupOwner: true,
    });
    expect(assessmentOf(result, slots[1]!.slotId)).toMatchObject({
      outcome: "exact_duplicate",
      ownerSlotId: slots[0]!.slotId,
      duplicateKind: "exact_content",
      failureCodes: ["EXACT_DUPLICATE"],
    });
    expect(DuplicateBarrierResultSchema.safeParse({
      ...result,
      resultHash: sha256Hex("tampered"),
    }).success).toBe(false);
    expect(result.summary.exactGroups).toBe(1);
    expect(result.summary.exactDuplicates).toBe(1);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      kind: "exact_content",
      leftSlotId: slots[0]!.slotId,
      rightSlotId: slots[1]!.slotId,
      eligible: true,
      diagnostic: false,
    });
  });

  it("is byte-identical for the same cohort in different completion orders", () => {
    const slots = [
      slot("ranking", 1, "spec_first"),
      slot("ranking", 2, "ai_spec"),
      slot("ranking", 3, "spec_first"),
      slot("ranking", 4, "ai_spec"),
    ];
    const candidates = [
      readyCandidate(slots[0]!, rankingEngine, RANKING_CHAIN, "Question one."),
      readyCandidate(slots[1]!, rankingEngine, RANKING_REDUNDANT, "Question two."),
      readyCandidate(slots[2]!, rankingEngine, RANKING_CHAIN, "Question three."),
      readyCandidate(slots[3]!, rankingEngine, RANKING_ANCHORED, "Question four."),
    ];
    const forward = barrier(slots, candidates);
    const reversed = barrier(slots, [...candidates].reverse());
    const rotated = barrier(slots, [candidates[2]!, candidates[3]!, candidates[0]!, candidates[1]!]);
    expect(reversed.resultHash).toBe(forward.resultHash);
    expect(rotated.resultHash).toBe(forward.resultHash);
    expect(reversed.assessments).toEqual(forward.assessments);
    expect(reversed.pairs).toEqual(forward.pairs);
  });

  it("flags both members of the mandatory counting one-edit pair with 33/35 Jaccard", () => {
    const slots = [slot("counting", 1, "spec_first"), slot("counting", 2, "ai_spec")];
    const firstSpec = countingSpec(2);
    const secondSpec = countingSpec(3);
    const first = readyCandidate(
      slots[0]!,
      countingEngine,
      firstSpec,
      "Count the two-membership cells.",
      renderHashes("counting-two"),
    );
    const second = readyCandidate(
      slots[1]!,
      countingEngine,
      secondSpec,
      "Count the three-membership cells.",
      renderHashes("counting-three"),
    );
    const result = barrier(slots, [second, first]);
    expect(assessmentOf(result, slots[0]!.slotId)).toMatchObject({
      outcome: "near_suspected",
      ownerSlotId: null,
      duplicateKind: null,
      nearPairSlotIds: [slots[1]!.slotId],
      failureCodes: ["NEAR_DUPLICATE_SUSPECTED"],
    });
    expect(assessmentOf(result, slots[1]!.slotId)).toMatchObject({
      outcome: "near_suspected",
      nearPairSlotIds: [slots[0]!.slotId],
      failureCodes: ["NEAR_DUPLICATE_SUSPECTED"],
    });
    expect(result.summary.nearPairs).toBe(1);
    expect(result.summary.nearSuspectedCandidates).toBe(2);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      kind: "near",
      diagnostic: false,
      eligible: true,
    });
    expect(result.pairs[0]?.comparison).toMatchObject({
      removed: 1,
      added: 1,
      editDistance: 1,
      intersection: 33,
      union: 35,
    });
    expect(result.pairs[0]?.comparison?.jaccard).toBeCloseTo(33 / 35, 12);
    if (first.fingerprint === null || second.fingerprint === null) {
      throw new Error("expected fingerprints");
    }
    const evaluation = evaluateNearPair(first.fingerprint, second.fingerprint);
    expect(evaluation.near).toBe(true);
    expect(evaluation.comparison?.editDistance).toBe(1);
    expect(evaluation.comparison?.jaccard).toBeCloseTo(33 / 35, 12);
    const reverse = evaluateNearPair(second.fingerprint, first.fingerprint);
    expect(reverse.near).toBe(true);
    expect(reverse.comparison).toEqual(evaluation.comparison);
  });

  it("rejects two-edit, zero-overlap, and different-scope near comparisons", () => {
    const slots = [slot("counting", 1, "spec_first"), slot("counting", 2, "ai_spec")];
    const first = readyCandidate(
      slots[0]!,
      countingEngine,
      COUNTING_TWO_EDIT_A,
      "Question A.",
      renderHashes("counting-a"),
    );
    const second = readyCandidate(
      slots[1]!,
      countingEngine,
      COUNTING_TWO_EDIT_B,
      "Question B.",
      renderHashes("counting-b"),
    );
    const result = barrier(slots, [first, second]);
    expect(result.summary.nearPairs).toBe(0);
    expect(result.assessments.every((assessment) => assessment.outcome === "unique")).toBe(
      true,
    );
    if (first.fingerprint === null || second.fingerprint === null) {
      throw new Error("expected fingerprints");
    }
    const evaluation = evaluateNearPair(first.fingerprint, second.fingerprint);
    expect(evaluation.near).toBe(false);
    expect(evaluation.comparison?.editDistance).toBe(2);

    const leftStructure = CanonicalStructureSchema.parse({
      version: 1,
      family: "ranking",
      domainTokens: ["size=4"],
      queryKind: "full_order",
      queryTokens: [],
      relationTokens: ["before:0:1", "before:1:2", "before:2:3"],
      geometryTokens: [],
    });
    const rightStructure = CanonicalStructureSchema.parse({
      version: 1,
      family: "ranking",
      domainTokens: ["size=4"],
      queryKind: "full_order",
      queryTokens: [],
      relationTokens: ["at:0:1", "at:1:2", "at:2:3"],
      geometryTokens: [],
    });
    const synthetic = (structure: CanonicalStructure, specSeed: string): CandidateFingerprint =>
      CandidateFingerprintSchema.parse({
        version: 1,
        family: "ranking",
        modality: "text",
        specHash: sha256Hex(specSeed),
        structureHash: canonicalStructureHash(structure),
        contentHash: null,
        renderHashes: { svg: null, png: null },
        canonicalStructure: structure,
        features: extractStructureFeatures(structure),
      });
    const zeroOverlap = evaluateNearPair(
      synthetic(leftStructure, "left"),
      synthetic(rightStructure, "right"),
    );
    expect(zeroOverlap.comparable).toBe(true);
    expect(zeroOverlap.near).toBe(false);
    expect(zeroOverlap.reason).toContain("no common structural feature");
    const emptyFeatures = {
      ...synthetic(leftStructure, "empty"),
      features: [],
    } as CandidateFingerprint;
    expect(() =>
      evaluateNearPair(emptyFeatures, synthetic(rightStructure, "right")),
    ).toThrow(DuplicateBarrierError);

    const otherScope = CanonicalStructureSchema.parse({
      version: 1,
      family: "ranking",
      domainTokens: ["size=5"],
      queryKind: "full_order",
      queryTokens: [],
      relationTokens: ["before:0:1", "before:1:2", "before:2:3"],
      geometryTokens: [],
    });
    const differentScope = evaluateNearPair(
      synthetic(leftStructure, "left"),
      synthetic(otherScope, "other"),
    );
    expect(differentScope.comparable).toBe(false);
    expect(differentScope.near).toBe(false);
  });

  it("treats identical canonical data with unequal hashes as an implementation error", () => {
    const structure = CanonicalStructureSchema.parse({
      version: 1,
      family: "ranking",
      domainTokens: ["size=4"],
      queryKind: "full_order",
      queryTokens: [],
      relationTokens: ["before:0:1", "before:1:2", "before:2:3"],
      geometryTokens: [],
    });
    const fingerprint = (hash: string): CandidateFingerprint =>
      CandidateFingerprintSchema.parse({
        version: 1,
        family: "ranking",
        modality: "text",
        specHash: sha256Hex(hash),
        structureHash: hash,
        contentHash: null,
        renderHashes: { svg: null, png: null },
        canonicalStructure: structure,
        features: extractStructureFeatures(structure),
      });
    expect(() =>
      evaluateNearPair(fingerprint(sha256Hex("one")), fingerprint(sha256Hex("two"))),
    ).toThrow(DuplicateBarrierError);
  });

  it("retains distinct transform step sequences instead of collapsing to the net effect", () => {
    const slots = [slot("transforms", 1, "spec_first"), slot("transforms", 2, "ai_spec")];
    const twoStep = transformSpec(["rotate90", "rotate90"]);
    const oneStep = transformSpec(["rotate180"]);
    const first = readyCandidate(
      slots[0]!,
      transformsEngine,
      twoStep,
      "Question A.",
      renderHashes("transform-two"),
    );
    const second = readyCandidate(
      slots[1]!,
      transformsEngine,
      oneStep,
      "Question B.",
      renderHashes("transform-one"),
    );
    const result = barrier(slots, [first, second]);
    expect(result.assessments.map((assessment) => assessment.outcome)).toEqual([
      "unique",
      "unique",
    ]);
    expect(result.summary.nearPairs).toBe(0);
    if (first.fingerprint === null || second.fingerprint === null) {
      throw new Error("expected fingerprints");
    }
    expect(first.fingerprint.canonicalStructure?.queryTokens).toContain("steps=2");
    expect(second.fingerprint.canonicalStructure?.queryTokens).toContain("steps=1");
    expect(first.fingerprint.structureHash).not.toBe(second.fingerprint.structureHash);
  });

  it("does not let an early failure own or suppress a usable candidate, but retains diagnostic pairs", () => {
    const slots = [slot("ranking", 1, "spec_first"), slot("ranking", 2, "ai_spec")];
    const failed = earlyCandidate(slots[0]!, rankingEngine, RANKING_REDUNDANT, {
      terminalVerdict: "generation_error",
    });
    const usable = readyCandidate(
      slots[1]!,
      rankingEngine,
      RANKING_CHAIN,
      "Usable question.",
    );
    const result = barrier(slots, [usable, failed]);
    expect(assessmentOf(result, slots[0]!.slotId)).toMatchObject({
      eligible: false,
      fingerprintable: true,
      outcome: "ineligible",
      terminalVerdict: "generation_error",
      ownerSlotId: null,
      duplicateKind: null,
      failureCodes: [],
    });
    expect(assessmentOf(result, slots[1]!.slotId)).toMatchObject({
      outcome: "unique",
      groupOwner: false,
    });
    expect(result.summary.structuralDuplicates).toBe(0);
    expect(result.summary.terminalFailuresRewritten).toBe(0);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      kind: "structural",
      diagnostic: true,
      eligible: false,
      leftSlotId: slots[0]!.slotId,
      rightSlotId: slots[1]!.slotId,
    });
  });

  it("keeps a formally failed early failure without a diagnostic fingerprint", () => {
    const slots = [slot("ranking", 1, "spec_first"), slot("ranking", 2, "ai_spec")];
    const failed = CandidateBarrierInputSchema.parse({
      slotId: slots[0]!.slotId,
      slotOrdinal: slots[0]!.slotOrdinal,
      family: slots[0]!.family,
      modality: slots[0]!.modality,
      lane: slots[0]!.lane,
      preparationStatus: "early_failure",
      presentationCheckPassed: false,
      formalPassed: false,
      terminalVerdict: "generation_error",
      fingerprint: null,
    });
    const usable = readyCandidate(
      slots[1]!,
      rankingEngine,
      RANKING_CHAIN,
      "Usable question.",
    );
    const result = barrier(slots, [usable, failed]);
    expect(assessmentOf(result, slots[0]!.slotId)).toMatchObject({
      eligible: false,
      fingerprintable: false,
      outcome: "ineligible",
      terminalVerdict: "generation_error",
      structureHash: null,
      features: [],
    });
    expect(result.summary.fingerprintableCandidates).toBe(1);
    expect(result.summary.diagnosticPairs).toBe(0);
  });

  it("reports cross-family visual exact PNG matches as diagnostic only", () => {
    const slots = [slot("matrix", 1, "spec_first"), slot("counting", 2, "ai_spec")];
    const sharedPng = renderHashes("shared-visual");
    const matrix = readyCandidate(
      slots[0]!,
      matrixEngine,
      MATRIX_SPEC,
      "Matrix question.",
      { svg: sha256Hex("matrix-svg"), png: sharedPng.png },
    );
    const counting = readyCandidate(
      slots[1]!,
      countingEngine,
      countingSpec(2),
      "Counting question.",
      { svg: sha256Hex("counting-svg"), png: sharedPng.png },
    );
    const result = barrier(slots, [counting, matrix]);
    expect(result.assessments.every((assessment) => assessment.outcome === "unique")).toBe(
      true,
    );
    expect(result.summary.visualExactDiagnosticPairs).toBe(1);
    expect(result.summary.diagnosticPairs).toBe(1);
    expect(result.pairs[0]).toMatchObject({
      kind: "visual_exact",
      family: null,
      diagnostic: true,
      eligible: true,
    });
  });

  it("refuses missing or budget-paused preparation and never replaces a slot", () => {
    const slots = [slot("ranking", 1, "spec_first"), slot("ranking", 2, "ai_spec")];
    const first = readyCandidate(slots[0]!, rankingEngine, RANKING_CHAIN, "Question one.");
    let missingError: unknown;
    try {
      barrier(slots, [first]);
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(DuplicateBarrierError);
    expect((missingError as DuplicateBarrierError).code).toBe("INCOMPLETE_PREPARATION");

    const incomplete = CandidateBarrierInputSchema.parse({
      slotId: slots[1]!.slotId,
      slotOrdinal: slots[1]!.slotOrdinal,
      family: slots[1]!.family,
      modality: slots[1]!.modality,
      lane: slots[1]!.lane,
      preparationStatus: "incomplete",
      presentationCheckPassed: false,
      formalPassed: false,
      terminalVerdict: null,
      fingerprint: null,
    });
    let pausedError: unknown;
    try {
      barrier(slots, [first, incomplete]);
    } catch (error) {
      pausedError = error;
    }
    expect(pausedError).toBeInstanceOf(DuplicateBarrierError);
    expect((pausedError as DuplicateBarrierError).code).toBe("INCOMPLETE_PREPARATION");

    const result = barrier(slots, [
      first,
      readyCandidate(slots[1]!, rankingEngine, RANKING_ANCHORED, "Question two."),
    ]);
    expect(result.summary.replacements).toBe(0);
    expect(result.assessments).toHaveLength(2);
    expect(result.assessments.map((assessment) => assessment.slotId).sort()).toEqual(
      slots.map((entry) => entry.slotId).sort(),
    );
  });

  it("requires matching PNG content before calling same-family visual candidates exact duplicates", () => {
    const slots = [slot("counting", 1, "spec_first"), slot("counting", 2, "ai_spec")];
    const sharedQuestion = "Same visible shell.";
    const first = readyCandidate(
      slots[0]!,
      countingEngine,
      COUNTING_TWO_EDIT_A,
      sharedQuestion,
      renderHashes("visual-a"),
    );
    const second = readyCandidate(
      slots[1]!,
      countingEngine,
      COUNTING_TWO_EDIT_B,
      sharedQuestion,
      renderHashes("visual-b"),
    );
    expect(first.fingerprint?.contentHash).toBe(second.fingerprint?.contentHash);
    expect(first.fingerprint?.renderHashes.png).not.toBe(
      second.fingerprint?.renderHashes.png,
    );
    const result = barrier(slots, [first, second]);
    expect(result.summary.exactGroups).toBe(0);
    expect(result.summary.exactDuplicates).toBe(0);
    expect(result.assessments.every((assessment) => assessment.outcome === "unique")).toBe(
      true,
    );
  });

  it("emits every diagnostic pair between an early failure and its structural group", () => {
    const slots = [
      slot("ranking", 1, "spec_first"),
      slot("ranking", 2, "ai_spec"),
      slot("ranking", 3, "spec_first"),
    ];
    const first = readyCandidate(slots[0]!, rankingEngine, RANKING_CHAIN, "Question one.");
    const second = readyCandidate(
      slots[1]!,
      rankingEngine,
      RANKING_REDUNDANT,
      "Question two.",
    );
    const failed = earlyCandidate(slots[2]!, rankingEngine, RANKING_CHAIN, {
      terminalVerdict: "generation_error",
    });
    const result = barrier(slots, [first, second, failed]);
    expect(assessmentOf(result, slots[1]!.slotId).outcome).toBe("structural_duplicate");
    const diagnosticPairs = result.pairs.filter(
      (pair) => pair.diagnostic && pair.kind === "structural",
    );
    expect(diagnosticPairs).toHaveLength(2);
    expect(
      diagnosticPairs.some(
        (pair) =>
          pair.leftSlotId === slots[1]!.slotId &&
          pair.rightSlotId === slots[2]!.slotId,
      ),
    ).toBe(true);
    expect(result.summary.diagnosticPairs).toBe(3);
  });

  it("rejects a formal-passed fingerprint without a canonical structure", () => {
    const plan = slot("ranking", 1, "spec_first");
    const base = fingerprintCandidate({
      engine: rankingEngine,
      spec: RANKING_CHAIN,
    });
    const noStructure = CandidateFingerprintSchema.parse({
      ...base,
      canonicalStructure: null,
      structureHash: null,
      features: [],
    });
    const parsed = CandidateBarrierInputSchema.safeParse({
      slotId: plan.slotId,
      slotOrdinal: plan.slotOrdinal,
      family: plan.family,
      modality: plan.modality,
      lane: plan.lane,
      preparationStatus: "early_failure",
      presentationCheckPassed: false,
      formalPassed: true,
      terminalVerdict: "generation_error",
      fingerprint: noStructure,
    });
    expect(parsed.success).toBe(false);
  });

  it("covers every family and modality in the registered cohort shape", () => {
    expect(FAMILIES).toHaveLength(10);
    const result = barrier(
      [slot("counting", 1, "spec_first")],
      [
        readyCandidate(
          slot("counting", 1, "spec_first"),
          countingEngine,
          countingSpec(2),
          "Question.",
          renderHashes("only"),
        ),
      ],
    );
    expect(result.summary.eligibleCandidates).toBe(1);
    expect(result.summary.uniqueCandidates).toBe(1);
    expect(result.summary.plannedSlots).toBe(1);
  });
});
