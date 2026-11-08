import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AiConfigError,
  AI_REQUEST_ROLES,
  buildChatRequest,
  defaultMaxOutputTokensFor,
  modelRoleForRequestRole,
  readDesignerLiveEnvironment,
  readLiveEnvironment,
  requiresImageForRole,
} from "../../src/ai/config.js";
import {
  DesignProposalError,
  buildDesignProposalRequest,
  buildDesignProposalRequestForArm,
  designProposalMetadataFor,
  parseDesignProposal,
} from "../../src/ai/design-proposal.js";
import { LedgerRoleSchema } from "../../src/ai/ledger.js";
import { MockScenarioSchema } from "../../src/ai/mock.js";
import {
  LIVE_PROBE_COUNT,
  LIVE_PROBE_ROLES,
} from "../../src/ai/preflight.js";
import {
  FAMILY_SPEC_JSON_SCHEMAS,
  StrictSchemaError,
  compileStrictJsonSchema,
  designerProposalJsonSchema,
  strictSchemaHash,
} from "../../src/ai/schemas.js";
import {
  truthSpecToRpn,
  type TruthSpec,
} from "../../src/families/truth/schema.js";
import { main as designerMain } from "../../src/cli/design.js";
import {
  DESIGNER_ROOT_SEEDS,
  DESIGNER_SKIN_ENTITY_IDS,
  DESIGNER_SKIN_LABELS,
  DESIGNER_SKIN_THEMES,
  DESIGNER_SKIN_THEME_LABELS,
  DesignerCandidateVerdictSchema,
  DesignerPlanManifestSchema,
  DesignerRunManifestSchema,
  computeDesignerPlanHash,
  computeDesignerRunManifestHash,
  designerSkinEntityIdsForDifficulty,
  designerSkinEntityIdsForSpec,
  type DesignerPlanManifest,
  type DesignerRunManifest,
  type DesignProposalSchemaOptions,
  type DesignerSkinTheme,
  type PresentationSkin,
} from "../../src/domain/design.js";
import {
  DIFFICULTIES,
  FAMILIES,
  type Difficulty,
  type Family,
} from "../../src/domain/experiment.js";
import type { FamilySpec, FamilySpecByFamily } from "../../src/domain/spec.js";
import {
  buildDesignerPlanManifest,
  deriveDesignerStreamSeed,
  serializeDesignerPlanManifest,
} from "../../src/design/assignments.js";
import {
  assertDesignerBounds,
  designerBoundsBrief,
} from "../../src/design/bounds.js";
import { hashCanonicalJson } from "../../src/util/hash.js";

const PRIMARY_PLAN = buildDesignerPlanManifest({ runKind: "design_primary" });
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function assignmentFor(
  family: Family,
  difficulty: Difficulty,
): {
  readonly assignmentId: string;
  readonly family: Family;
  readonly difficulty: Difficulty;
} {
  const assignment = PRIMARY_PLAN.assignments.find(
    (candidate) =>
      candidate.family === family && candidate.difficulty === difficulty,
  );
  if (assignment === undefined) {
    throw new Error(`no primary assignment for ${family}/${difficulty}`);
  }
  return {
    assignmentId: assignment.assignmentId,
    family,
    difficulty,
  };
}

function rankingSpec(size: 4 | 5): FamilySpecByFamily["ranking"] {
  return size === 4
    ? {
        size,
        clues: [
          { kind: "at", item: 0, position: 1 },
          { kind: "notAt", item: 1, position: 1 },
          { kind: "immediatelyBefore", before: 2, after: 3 },
          { kind: "before", before: 1, after: 2 },
        ],
      }
    : {
        size,
        clues: [
          { kind: "at", item: 0, position: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "immediatelyBefore", before: 3, after: 4 },
          { kind: "notAt", item: 2, position: 5 },
        ],
      };
}

const MATCHING_SPEC: FamilySpecByFamily["matching"] = {
  clues: [
    { kind: "same", left: { category: "A", item: 0 }, right: { category: "B", item: 0 } },
    { kind: "same", left: { category: "A", item: 1 }, right: { category: "B", item: 1 } },
    {
      kind: "different",
      left: { category: "A", item: 2 },
      right: { category: "B", item: 2 },
    },
    { kind: "same", left: { category: "A", item: 3 }, right: { category: "C", item: 3 } },
  ],
};

const SCHEDULING_SPEC: FamilySpecByFamily["scheduling"] = {
  clues: [
    { kind: "at", event: 0, slot: 1 },
    { kind: "before", before: 0, after: 1 },
    { kind: "usesResource", event: 0, resource: 0 },
    { kind: "notResource", event: 1, resource: 0 },
  ],
};

function truthSpec(difficulty: Difficulty): FamilySpecByFamily["truth"] {
  if (difficulty === 1) {
    return {
      people: 3,
      exactTruthful: 1,
      statements: [
        { kind: "truthful", person: 0 },
        { kind: "not", operand: { kind: "truthful", person: 1 } },
        { kind: "truthful", person: 2 },
      ],
    };
  }
  if (difficulty === 2) {
    return {
      people: 4,
      exactTruthful: 2,
      statements: [
        {
          kind: "and",
          left: { kind: "truthful", person: 0 },
          right: { kind: "truthful", person: 1 },
        },
        {
          kind: "or",
          left: { kind: "truthful", person: 2 },
          right: { kind: "truthful", person: 3 },
        },
        { kind: "not", operand: { kind: "truthful", person: 0 } },
        { kind: "truthful", person: 1 },
      ],
    };
  }
  return {
    people: 4,
    exactTruthful: 2,
    statements: [
      {
        kind: "xor",
        left: { kind: "truthful", person: 0 },
        right: { kind: "truthful", person: 1 },
      },
      {
        kind: "and",
        left: { kind: "truthful", person: 2 },
        right: { kind: "truthful", person: 3 },
      },
      { kind: "not", operand: { kind: "truthful", person: 0 } },
      { kind: "truthful", person: 1 },
    ],
  };
}

function arithmeticSpec(
  difficulty: Difficulty,
): FamilySpecByFamily["arithmetic"] {
  if (difficulty === 1) {
    return {
      allDifferent: true,
      constraints: [
        { coeffs: [1, 0, 0], op: "eq", constant: 2 },
        { coeffs: [0, 1, 0], op: "eq", constant: 3 },
        { coeffs: [0, 0, 1], op: "eq", constant: 4 },
      ],
    };
  }
  if (difficulty === 2) {
    return {
      allDifferent: false,
      constraints: [
        { coeffs: [2, 0, 0], op: "eq", constant: 4 },
        { coeffs: [0, 2, 0], op: "eq", constant: 6 },
      ],
    };
  }
  return {
    allDifferent: false,
    constraints: [
      { coeffs: [3, 0, 0], op: "eq", constant: 6 },
      { coeffs: [0, 2, 0], op: "le", constant: 8 },
    ],
  };
}

const MATRIX_SPEC: FamilySpecByFamily["matrix"] = {
  rule: "xor",
  cells: [
    [1, 2, 3],
    [4, 5, 1],
    [5, 7, null],
  ],
};

function transformsSpec(
  difficulty: Difficulty,
): FamilySpecByFamily["transforms"] {
  const source: FamilySpecByFamily["transforms"]["source"] = [
    [1, 0, 0, 0, 0],
    [1, 1, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];
  return {
    source,
    operations:
      difficulty === 1
        ? ["rotate90"]
        : difficulty === 2
          ? ["reflectLeftRight"]
          : ["rotate90", "reflectLeftRight"],
  };
}

const SHORT_PATH_SPEC: FamilySpecByFamily["paths"] = {
  active: [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 0, column: 2 },
    { row: 1, column: 2 },
    { row: 1, column: 3 },
    { row: 2, column: 3 },
  ],
  edges: [
    { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
    { from: { row: 0, column: 1 }, to: { row: 0, column: 2 } },
    { from: { row: 0, column: 2 }, to: { row: 1, column: 2 } },
    { from: { row: 1, column: 2 }, to: { row: 1, column: 3 } },
    { from: { row: 1, column: 3 }, to: { row: 2, column: 3 } },
  ],
  start: { row: 0, column: 0 },
  goal: { row: 2, column: 3 },
};

const LONG_PATH_SPEC: FamilySpecByFamily["paths"] = {
  active: [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 0, column: 2 },
    { row: 0, column: 3 },
    { row: 1, column: 3 },
    { row: 2, column: 1 },
    { row: 2, column: 2 },
    { row: 2, column: 3 },
  ],
  edges: [
    { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
    { from: { row: 0, column: 1 }, to: { row: 0, column: 2 } },
    { from: { row: 0, column: 2 }, to: { row: 0, column: 3 } },
    { from: { row: 0, column: 3 }, to: { row: 1, column: 3 } },
    { from: { row: 1, column: 3 }, to: { row: 2, column: 3 } },
    { from: { row: 2, column: 1 }, to: { row: 2, column: 2 } },
    { from: { row: 2, column: 2 }, to: { row: 2, column: 3 } },
  ],
  start: { row: 0, column: 0 },
  goal: { row: 2, column: 3 },
};

function symmetryGrid(
  axis: "vertical" | "horizontal",
  occupied: readonly (readonly [number, number])[],
): FamilySpecByFamily["symmetry"]["cells"] {
  const occupiedKeys = new Set(occupied.map(([row, column]) => `${row}:${column}`));
  const cells = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => "unknown" as const),
  );
  const grid: Array<Array<"occupied" | "empty" | "unknown">> = cells.map((row) =>
    row.map((state) => state),
  );
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const known = axis === "vertical" ? column < 4 : row < 4;
      if (known) {
        grid[row]![column] = occupiedKeys.has(`${row}:${column}`)
          ? "occupied"
          : "empty";
      }
    }
  }
  return grid as FamilySpecByFamily["symmetry"]["cells"];
}

function symmetrySpec(
  difficulty: Difficulty,
): FamilySpecByFamily["symmetry"] {
  if (difficulty === 1) {
    return {
      axis: "vertical",
      cells: symmetryGrid("vertical", [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    };
  }
  if (difficulty === 2) {
    return {
      axis: "horizontal",
      cells: symmetryGrid("horizontal", [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]),
    };
  }
  return {
    axis: "vertical",
    cells: symmetryGrid("vertical", [
      [0, 0],
      [0, 1],
      [4, 0],
      [4, 1],
    ]),
  };
}

function countingShape(
  cells: readonly (readonly [number, number])[],
): FamilySpecByFamily["counting"]["shapes"][number] {
  return {
    cells: cells.map(([row, column]) => ({ row, column })),
  };
}

const COUNTING_SHAPE_ONE = countingShape([
  [1, 1],
  [1, 2],
  [2, 1],
]);
const COUNTING_SHAPE_TWO = countingShape([
  [1, 2],
  [2, 2],
  [2, 3],
]);
const COUNTING_SHAPE_THREE = countingShape([
  [2, 1],
  [2, 2],
  [3, 1],
]);

function countingSpec(
  difficulty: Difficulty,
): FamilySpecByFamily["counting"] {
  if (difficulty === 1) {
    return {
      shapes: [COUNTING_SHAPE_ONE, COUNTING_SHAPE_TWO],
      query: { operation: "unionCount" },
    };
  }
  if (difficulty === 2) {
    return {
      shapes: [COUNTING_SHAPE_ONE, COUNTING_SHAPE_TWO],
      query: { operation: "intersectionAll" },
    };
  }
  return {
    shapes: [COUNTING_SHAPE_ONE, COUNTING_SHAPE_TWO, COUNTING_SHAPE_THREE],
    query: { operation: "exactlyKShapes", k: 2 },
  };
}

function validSpec(family: Family, difficulty: Difficulty): FamilySpec {
  switch (family) {
    case "ranking":
      return rankingSpec(difficulty === 1 ? 4 : 5);
    case "matching":
      return MATCHING_SPEC;
    case "scheduling":
      return SCHEDULING_SPEC;
    case "truth":
      return truthSpec(difficulty);
    case "arithmetic":
      return arithmeticSpec(difficulty);
    case "matrix":
      return MATRIX_SPEC;
    case "transforms":
      return transformsSpec(difficulty);
    case "paths":
      return difficulty === 3 ? LONG_PATH_SPEC : SHORT_PATH_SPEC;
    case "symmetry":
      return symmetrySpec(difficulty);
    case "counting":
      return countingSpec(difficulty);
  }
}

function proposalFor(
  family: Family,
  difficulty: Difficulty,
  overrides: {
    readonly designIntent?: string | null;
    readonly presentationSkin?: unknown;
  } = {},
): unknown {
  const spec = validSpec(family, difficulty);
  return {
    family,
    difficulty,
    spec:
      family === "truth"
        ? truthSpecToRpn(spec as TruthSpec)
        : spec,
    designIntent:
      overrides.designIntent === undefined ? null : overrides.designIntent,
    presentationSkin:
      overrides.presentationSkin === undefined
        ? null
        : overrides.presentationSkin,
  };
}

function validSkin(
  family: Family,
  difficulty: Difficulty,
  theme: DesignerSkinTheme = "garden",
): PresentationSkin {
  const spec = validSpec(family, difficulty);
  const entityIds = designerSkinEntityIdsForSpec(family, spec);
  const labels = DESIGNER_SKIN_THEME_LABELS[theme];
  return {
    theme,
    labels: entityIds.map((entityId, index) => {
      const label = labels[index];
      if (label === undefined) {
        throw new Error(`theme ${theme} has no label for ${entityId}`);
      }
      return { entityId, label };
    }),
  };
}

function expectProposalError(
  input: unknown,
  assignment: ReturnType<typeof assignmentFor>,
  code: DesignProposalError["code"],
  options?: DesignProposalSchemaOptions,
): DesignProposalError {
  try {
    parseDesignProposal(input, assignment, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DesignProposalError);
    const proposalError = error as DesignProposalError;
    expect(proposalError.code).toBe(code);
    return proposalError;
  }
  throw new Error(`expected DesignProposalError ${code}`);
}

function runManifest(plan: DesignerPlanManifest): DesignerRunManifest {
  const base = {
    plan,
    evidenceKind: "mock" as const,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    roles: { designer: { model: "mock/designer" } },
    routingPolicy: {
      mode: "balanced" as const,
      allowFallbacks: true as const,
      requireParameters: true as const,
    },
    routingConfirmation: {
      operator: "test-operator",
      checkedAt: "2026-11-07T00:00:00.000Z",
      providerSort: "default_balanced" as const,
      byokConfigured: false as const,
    },
    outputLimits: {
      design: 8192 as const,
      design_repair_1: 8192 as const,
      design_repair_2: 8192 as const,
    },
    concurrency: 2 as const,
    budget: {
      maxCostUsd: "10",
      reservationMethod: "fixed conservative per-role reserve",
      priceSnapshotHash: SHA_A,
    },
    capabilitySnapshot: {
      capturedAt: "2026-11-07T00:00:00.000Z",
      catalogHash: SHA_B,
      priceSnapshotHash: SHA_A,
      reservationMethod: "fixed conservative per-role reserve",
    },
    versions: {
      baselineGenerator: "p45-baseline-v1",
      structuralComparator: "p48-structure-v1",
      presentationTemplates: "p49-presentation-v1",
      metrics: "p50-metrics-v1",
      decisionEvaluator: "p50-decision-v1",
      humanSampler: "p50-human-sampler-v1",
      humanOrder: "p50-human-order-v1",
      humanRubric: "p50-human-rubric-v1",
    },
    baseline: {
      generatorVersion: "p45-baseline-v1",
      referenceCorpusHash: null,
    },
    hashes: {
      prompts: SHA_A,
      schema: SHA_B,
      source: SHA_A,
      font: SHA_B,
      reference: SHA_A,
      dependencyLock: SHA_B,
      presentationTemplates: SHA_A,
      structuralComparator: SHA_B,
      metrics: SHA_A,
      decisionEvaluator: SHA_B,
      humanRubric: SHA_A,
    },
    runtime: {
      node: "24.22.2",
      npm: "11.19.1",
      os: "linux",
      arch: "x64",
    },
    mockConfiguration: {
      synthetic: true as const,
      description: "offline synthetic designer cohort",
    },
    redacted: true as const,
    createdAt: "2026-11-07T00:00:00.000Z",
  };
  return { ...base, manifestHash: computeDesignerRunManifestHash(base) };
}

describe("designer plan manifest", () => {
  it("builds the exact 100-assignment, 300-candidate, 400-call primary plan", () => {
    expect(PRIMARY_PLAN.assignments).toHaveLength(100);
    expect(PRIMARY_PLAN.candidates).toHaveLength(300);
    expect(PRIMARY_PLAN.quotas).toEqual({
      totalAssignments: 100,
      textAssignments: 50,
      svgAssignments: 50,
      assignmentsPerFamily: 10,
      totalCandidates: 300,
      baselineCandidates: 100,
      oneShotCandidates: 100,
      feedbackCandidates: 100,
      textCandidates: 150,
      svgCandidates: 150,
      candidatesPerFamily: 30,
    });
    expect(PRIMARY_PLAN.requestEstimate).toEqual({
      byRole: {
        design: 200,
        design_repair_1: 100,
        design_repair_2: 100,
      },
      totalContentLogicalCalls: 400,
      probeLogicalCalls: 0,
      totalLogicalCalls: 400,
      baselineAiCalls: 0,
      maxTransportAttempts: 1200,
    });
    expect(PRIMARY_PLAN.assignments[0]).toMatchObject({
      assignmentId: "design-text-ranking-01",
      assignmentOrdinal: 1,
      family: "ranking",
      modality: "text",
      difficulty: 1,
    });
    expect(PRIMARY_PLAN.candidates[0]).toMatchObject({
      candidateSlotId: "design-text-ranking-01-baseline",
      candidateOrdinal: 1,
      arm: "baseline",
      slotKind: "designer",
      lane: null,
    });
    expect(PRIMARY_PLAN.candidates[1]?.arm).toBe("ai_one_shot");
    expect(PRIMARY_PLAN.candidates[2]?.arm).toBe("ai_feedback");
    for (const family of FAMILIES) {
      const familyAssignments = PRIMARY_PLAN.assignments.filter(
        (assignment) => assignment.family === family,
      );
      expect(familyAssignments).toHaveLength(10);
      expect(familyAssignments.map((assignment) => assignment.difficulty)).toEqual([
        1, 1, 1, 1, 2, 2, 2, 3, 3, 3,
      ]);
    }
  });

  it("builds the 20-assignment pilot and 100-assignment mock plans", () => {
    const pilot = buildDesignerPlanManifest({ runKind: "design_pilot" });
    expect(pilot.assignments).toHaveLength(20);
    expect(pilot.candidates).toHaveLength(60);
    expect(pilot.quotas).toMatchObject({
      totalAssignments: 20,
      textAssignments: 10,
      svgAssignments: 10,
      assignmentsPerFamily: 2,
      totalCandidates: 60,
      baselineCandidates: 20,
      oneShotCandidates: 20,
      feedbackCandidates: 20,
      textCandidates: 30,
      svgCandidates: 30,
      candidatesPerFamily: 6,
    });
    expect(pilot.requestEstimate).toEqual({
      byRole: {
        design: 40,
        design_repair_1: 20,
        design_repair_2: 20,
      },
      totalContentLogicalCalls: 80,
      probeLogicalCalls: 2,
      totalLogicalCalls: 82,
      baselineAiCalls: 0,
      maxTransportAttempts: 246,
    });
    const rankingPilot = pilot.assignments.filter(
      (assignment) => assignment.family === "ranking",
    );
    expect(rankingPilot.map((assignment) => assignment.difficulty)).toEqual([
      1, 2,
    ]);
    const mock = buildDesignerPlanManifest({ runKind: "design_mock" });
    expect(mock.rootSeed).toBe(DESIGNER_ROOT_SEEDS.design_mock);
    expect(mock.assignments).toHaveLength(100);
    expect(mock.candidates).toHaveLength(300);
    expect(mock.requestEstimate.totalLogicalCalls).toBe(400);
  });

  it("is deterministic, serializes stably, and derives shared assignment seeds", () => {
    const first = buildDesignerPlanManifest({ runKind: "design_primary" });
    const second = buildDesignerPlanManifest({ runKind: "design_primary" });
    expect(first).toEqual(second);
    expect(serializeDesignerPlanManifest(first)).toBe(
      serializeDesignerPlanManifest(second),
    );
    const seed = deriveDesignerStreamSeed({
      protocolVersion: "2.0.0",
      rootSeed: "puzzle-designer-v1",
      assignmentId: "design-text-ranking-01",
      arm: "shared",
      purpose: "options",
    });
    expect(seed).toBe(first.assignments[0]?.assignmentSeed);
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    const oneShot = deriveDesignerStreamSeed({
      protocolVersion: "2.0.0",
      rootSeed: "puzzle-designer-v1",
      assignmentId: "design-text-ranking-01",
      arm: "ai_one_shot",
      purpose: "options",
    });
    const feedback = deriveDesignerStreamSeed({
      protocolVersion: "2.0.0",
      rootSeed: "puzzle-designer-v1",
      assignmentId: "design-text-ranking-01",
      arm: "ai_feedback",
      purpose: "options",
    });
    expect(oneShot).not.toBe(seed);
    expect(feedback).not.toBe(seed);
    expect(oneShot).not.toBe(feedback);
  });

  it("rejects a non-fixed seed, tampered counts, and tampered candidate identity", () => {
    expect(() =>
      buildDesignerPlanManifest({
        runKind: "design_primary",
        rootSeed: "puzzle-poc-v1",
      }),
    ).toThrow(/fixed to puzzle-designer-v1/);
    const tamperedCounts = structuredClone(PRIMARY_PLAN);
    tamperedCounts.quotas.totalCandidates = 299;
    tamperedCounts.planHash = computeDesignerPlanHash(tamperedCounts);
    expect(DesignerPlanManifestSchema.safeParse(tamperedCounts).success).toBe(false);
    const tamperedCandidate = structuredClone(PRIMARY_PLAN);
    const firstCandidate = tamperedCandidate.candidates[0];
    if (firstCandidate === undefined) {
      throw new Error("primary plan has no candidates");
    }
    firstCandidate.arm = "ai_one_shot";
    tamperedCandidate.planHash = computeDesignerPlanHash(tamperedCandidate);
    expect(DesignerPlanManifestSchema.safeParse(tamperedCandidate).success).toBe(
      false,
    );
  });
});

describe("designer run and candidate types", () => {
  it("accepts a strict designer run manifest and rejects legacy reviewer roles", () => {
    const manifest = runManifest(PRIMARY_PLAN);
    expect(DesignerRunManifestSchema.safeParse(manifest).success).toBe(true);
    const withReviewer = structuredClone(manifest) as unknown as {
      roles: Record<string, unknown>;
      manifestHash: string;
    };
    withReviewer.roles.reviewer = { model: "mock/reviewer" };
    withReviewer.manifestHash = computeDesignerRunManifestHash(
      withReviewer as unknown as DesignerRunManifest,
    );
    expect(DesignerRunManifestSchema.safeParse(withReviewer).success).toBe(false);
    const liveWithMock = structuredClone(manifest) as unknown as {
      evidenceKind: string;
      manifestHash: string;
    };
    liveWithMock.evidenceKind = "live";
    liveWithMock.manifestHash = computeDesignerRunManifestHash(
      liveWithMock as unknown as DesignerRunManifest,
    );
    expect(DesignerRunManifestSchema.safeParse(liveWithMock).success).toBe(false);
    const tampered = structuredClone(manifest);
    tampered.manifestHash = SHA_B;
    expect(DesignerRunManifestSchema.safeParse(tampered).success).toBe(false);
  });

  it("keeps candidate verdicts to the designer vocabulary", () => {
    for (const verdict of [
      "accepted",
      "rejected",
      "inconclusive",
      "generation_error",
    ]) {
      expect(DesignerCandidateVerdictSchema.safeParse(verdict).success).toBe(true);
    }
    expect(DesignerCandidateVerdictSchema.safeParse("approved").success).toBe(false);
  });
});

describe("designer proposal contract", () => {
  it("accepts valid non-baseline proposals for every family and difficulty", () => {
    for (const family of FAMILIES) {
      for (const difficulty of DIFFICULTIES) {
        const assignment = assignmentFor(family, difficulty);
        const proposal = proposalFor(family, difficulty);
        expect(() => parseDesignProposal(proposal, assignment)).not.toThrow();
      }
    }
  });

  it("requires both optional decorative fields to be present and null when unused", () => {
    const assignment = assignmentFor("ranking", 1);
    const base = proposalFor("ranking", 1) as Record<string, unknown>;
    const withoutIntent = { ...base };
    delete withoutIntent.designIntent;
    expectProposalError(withoutIntent, assignment, "SCHEMA_INVALID");
    const withoutSkin = { ...base };
    delete withoutSkin.presentationSkin;
    expectProposalError(withoutSkin, assignment, "SCHEMA_INVALID");
    expectProposalError(
      { ...base, designIntent: 7 },
      assignment,
      "SCHEMA_INVALID",
    );
    expectProposalError(
      { ...base, designIntent: "x".repeat(401) },
      assignment,
      "SCHEMA_INVALID",
    );
    expect(
      parseDesignProposal(
        proposalFor("ranking", 1, {
          designIntent: "Use a mixed clue shape with one anchor.",
        }),
        assignment,
      ).designIntent,
    ).toBe("Use a mixed clue shape with one anchor.");
  });

  it("rejects wrong family and difficulty before family-specific parsing", () => {
    const rankingAssignment = assignmentFor("ranking", 1);
    expectProposalError(
      proposalFor("matching", 1),
      rankingAssignment,
      "WRONG_FAMILY",
    );
    expectProposalError(
      proposalFor("ranking", 2),
      rankingAssignment,
      "WRONG_DIFFICULTY",
    );
    expectProposalError(
      {
        family: "ranking",
        difficulty: 1,
        spec: validSpec("matching", 1),
        designIntent: null,
        presentationSkin: null,
      },
      rankingAssignment,
      "SCHEMA_INVALID",
    );
  });

  it("rejects answers, options, visible prose, SVG, code, and extra properties", () => {
    const assignment = assignmentFor("ranking", 1);
    const base = proposalFor("ranking", 1) as Record<string, unknown>;
    for (const extra of [
      { answer: ["A", "B", "C", "D"] },
      { options: ["A", "B", "C", "D"] },
      { question: "Which order satisfies the clues?" },
      { clueText: "A is before B." },
      { hint: "Try the first anchor." },
      { explanation: "Because the chain is forced." },
      { svg: "<svg><rect /></svg>" },
      { code: "function solve() { return 1; }" },
      { provider: { only: ["some-provider"] } },
    ]) {
      expectProposalError(
        { ...base, ...extra },
        assignment,
        "SCHEMA_INVALID",
      );
    }
    const spec = validSpec("ranking", 1) as Record<string, unknown>;
    expectProposalError(
      {
        ...base,
        spec: { ...spec, hint: "Try the first anchor." },
      },
      assignment,
      "SCHEMA_INVALID",
    );
    expectProposalError(
      proposalFor("ranking", 1, {
        designIntent: "Render this as <svg><rect /></svg>.",
      }),
      assignment,
      "FORBIDDEN_CONTENT",
    );
    expectProposalError(
      proposalFor("ranking", 1, {
        designIntent: "Fetch https://example.com for the answer.",
      }),
      assignment,
      "FORBIDDEN_CONTENT",
    );
    expect(() =>
      parseDesignProposal(
        proposalFor("ranking", 1, {
          designIntent: "Use a chain & anchor mix; prefer > 2 clues.",
        }),
        assignment,
      ),
    ).not.toThrow();
  });

  it("rejects global schema-bound violations for every family", () => {
    const cases: Array<{
      readonly family: Family;
      readonly difficulty: Difficulty;
      readonly spec: unknown;
    }> = [
      {
        family: "ranking",
        difficulty: 1,
        spec: {
          size: 6,
          clues: (validSpec("ranking", 1) as FamilySpecByFamily["ranking"]).clues,
        },
      },
      {
        family: "ranking",
        difficulty: 1,
        spec: {
          size: 4,
          clues: [
            { kind: "before", before: 0, after: 1 },
            { kind: "before", before: 1, after: 2 },
          ],
        },
      },
      {
        family: "matching",
        difficulty: 1,
        spec: {
          clues: [
            { kind: "same", left: { category: "A", item: 0 }, right: { category: "B", item: 0 } },
            { kind: "same", left: { category: "A", item: 1 }, right: { category: "B", item: 1 } },
            { kind: "same", left: { category: "A", item: 2 }, right: { category: "B", item: 2 } },
          ],
        },
      },
      {
        family: "scheduling",
        difficulty: 1,
        spec: {
          clues: [
            { kind: "before", before: 0, after: 0 },
            { kind: "at", event: 1, slot: 1 },
            { kind: "at", event: 2, slot: 2 },
            { kind: "at", event: 3, slot: 3 },
          ],
        },
      },
      {
        family: "truth",
        difficulty: 1,
        spec: truthSpecToRpn({
          people: 3,
          exactTruthful: 1,
          statements: [
            {
              kind: "not",
              operand: {
                kind: "not",
                operand: {
                  kind: "not",
                  operand: { kind: "truthful", person: 0 },
                },
              },
            },
            { kind: "truthful", person: 1 },
            { kind: "truthful", person: 2 },
          ],
        }),
      },
      {
        family: "arithmetic",
        difficulty: 1,
        spec: {
          allDifferent: false,
          constraints: [
            { coeffs: [4, 0, 0], op: "eq", constant: 4 },
            { coeffs: [0, 1, 0], op: "eq", constant: 1 },
          ],
        },
      },
      {
        family: "matrix",
        difficulty: 1,
        spec: { rule: "xor", cells: [[1, 2, 3], [4, 5, 1], [5, 16, null]] },
      },
      {
        family: "transforms",
        difficulty: 1,
        spec: {
          source: [
            [1, 1, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
          ],
          operations: ["rotate90"],
        },
      },
      {
        family: "paths",
        difficulty: 1,
        spec: {
          active: [
            { row: 0, column: 0 },
            { row: 0, column: 1 },
            { row: 0, column: 2 },
            { row: 1, column: 2 },
            { row: 1, column: 3 },
          ],
          edges: [
            { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
            { from: { row: 0, column: 1 }, to: { row: 0, column: 2 } },
            { from: { row: 0, column: 2 }, to: { row: 1, column: 2 } },
            { from: { row: 1, column: 2 }, to: { row: 1, column: 3 } },
          ],
          start: { row: 0, column: 0 },
          goal: { row: 1, column: 3 },
        },
      },
      {
        family: "symmetry",
        difficulty: 1,
        spec: {
          axis: "vertical",
          cells: symmetryGrid("vertical", [
            [0, 0],
            [1, 0],
            [2, 0],
          ]),
        },
      },
      {
        family: "counting",
        difficulty: 1,
        spec: {
          shapes: [
            countingShape([
              [1, 1],
              [1, 2],
            ]),
            COUNTING_SHAPE_TWO,
          ],
          query: { operation: "unionCount" },
        },
      },
    ];
    for (const testCase of cases) {
      const assignment = assignmentFor(testCase.family, testCase.difficulty);
      expectProposalError(
        {
          family: testCase.family,
          difficulty: testCase.difficulty,
          spec: testCase.spec,
          designIntent: null,
          presentationSkin: null,
        },
        assignment,
        "SCHEMA_INVALID",
      );
    }
  });

  it("rejects pre-solver level-boundary violations", () => {
    const cases: Array<{
      readonly family: Family;
      readonly difficulty: Difficulty;
      readonly spec: unknown;
    }> = [
      {
        family: "ranking",
        difficulty: 1,
        spec: rankingSpec(5),
      },
      {
        family: "truth",
        difficulty: 1,
        spec: truthSpecToRpn(truthSpec(3)),
      },
      {
        family: "truth",
        difficulty: 2,
        spec: truthSpecToRpn(truthSpec(3)),
      },
      {
        family: "arithmetic",
        difficulty: 1,
        spec: arithmeticSpec(2),
      },
      {
        family: "arithmetic",
        difficulty: 2,
        spec: arithmeticSpec(3),
      },
      {
        family: "arithmetic",
        difficulty: 3,
        spec: {
          allDifferent: false,
          constraints: [
            { coeffs: [3, 0, 0], op: "eq", constant: 6 },
            { coeffs: [0, 3, 0], op: "eq", constant: 6 },
          ],
        },
      },
      {
        family: "transforms",
        difficulty: 1,
        spec: {
          source: transformsSpec(1).source,
          operations: ["identity"],
        },
      },
      {
        family: "transforms",
        difficulty: 2,
        spec: {
          source: transformsSpec(2).source,
          operations: ["rotate90"],
        },
      },
      {
        family: "transforms",
        difficulty: 3,
        spec: {
          source: transformsSpec(3).source,
          operations: ["rotate180", "reflectLeftRight"],
        },
      },
      {
        family: "symmetry",
        difficulty: 1,
        spec: symmetrySpec(2),
      },
      {
        family: "symmetry",
        difficulty: 3,
        spec: {
          axis: "vertical",
          cells: symmetryGrid("vertical", [
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
          ]),
        },
      },
      {
        family: "counting",
        difficulty: 1,
        spec: countingSpec(3),
      },
      {
        family: "counting",
        difficulty: 3,
        spec: countingSpec(2),
      },
      {
        family: "counting",
        difficulty: 1,
        spec: {
          shapes: [COUNTING_SHAPE_ONE, COUNTING_SHAPE_TWO],
          query: { operation: "intersectionAll" },
        },
      },
    ];
    for (const testCase of cases) {
      const assignment = assignmentFor(testCase.family, testCase.difficulty);
      expectProposalError(
        {
          family: testCase.family,
          difficulty: testCase.difficulty,
          spec: testCase.spec,
          designIntent: null,
          presentationSkin: null,
        },
        assignment,
        "OUT_OF_BOUNDS",
      );
    }
  });

  it("does not add structural proxies to matching, scheduling, matrix, or paths", () => {
    for (const family of ["matching", "scheduling", "matrix", "paths"] as const) {
      for (const difficulty of [1, 3] as const) {
        const assignment = assignmentFor(family, difficulty);
        expect(() =>
          parseDesignProposal(
            proposalFor(family, difficulty, { presentationSkin: null }),
            assignment,
          ),
        ).not.toThrow();
      }
    }
    expect(() =>
      assertDesignerBounds("paths", 3, SHORT_PATH_SPEC),
    ).not.toThrow();
    expect(designerBoundsBrief("matching", 3).levelRules.join(" ")).toContain(
      "no additional structural admission proxy",
    );
    expect(designerBoundsBrief("scheduling", 3).levelRules.join(" ")).toContain(
      "no additional structural admission proxy",
    );
    expect(designerBoundsBrief("matrix", 3).levelRules.join(" ")).toContain(
      "no additional structural admission proxy",
    );
  });
});

describe("designer skin catalog", () => {
  it("is closed, bounded, and distinct", () => {
    expect(new Set(DESIGNER_SKIN_LABELS).size).toBe(DESIGNER_SKIN_LABELS.length);
    for (const label of DESIGNER_SKIN_LABELS) {
      expect(label.length).toBeLessThanOrEqual(32);
    }
    for (const theme of DESIGNER_SKIN_THEMES) {
      const labels = DESIGNER_SKIN_THEME_LABELS[theme];
      expect(labels).toHaveLength(12);
      expect(new Set(labels).size).toBe(12);
      expect(
        labels.every((label) => DESIGNER_SKIN_LABELS.includes(label)),
      ).toBe(true);
    }
    for (const family of FAMILIES) {
      const ids = DESIGNER_SKIN_ENTITY_IDS[family];
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("advertises exactly the spec-derived entity set for every family and difficulty", () => {
    for (const family of FAMILIES) {
      for (const difficulty of DIFFICULTIES) {
        expect(designerSkinEntityIdsForDifficulty(family, difficulty)).toEqual(
          designerSkinEntityIdsForSpec(
            family,
            validSpec(family, difficulty),
          ),
        );
      }
    }
  });

  it("maps only the entity IDs required by the parsed spec", () => {
    expect(designerSkinEntityIdsForSpec("ranking", rankingSpec(4))).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(designerSkinEntityIdsForSpec("ranking", rankingSpec(5))).toHaveLength(5);
    expect(designerSkinEntityIdsForSpec("truth", truthSpec(1))).toHaveLength(3);
    expect(designerSkinEntityIdsForSpec("truth", truthSpec(2))).toHaveLength(4);
    expect(
      designerSkinEntityIdsForSpec("transforms", transformsSpec(1)),
    ).toEqual(["tile", "operation-0"]);
    expect(
      designerSkinEntityIdsForSpec("transforms", transformsSpec(3)),
    ).toEqual(["tile", "operation-0", "operation-1"]);
    expect(designerSkinEntityIdsForSpec("counting", countingSpec(1))).toHaveLength(2);
    expect(designerSkinEntityIdsForSpec("counting", countingSpec(3))).toHaveLength(3);
  });

  it("accepts null and valid non-null decorative skins", () => {
    for (const family of FAMILIES) {
      for (const difficulty of DIFFICULTIES) {
        const assignment = assignmentFor(family, difficulty);
        expect(() =>
          parseDesignProposal(
            proposalFor(family, difficulty, { presentationSkin: null }),
            assignment,
          ),
        ).not.toThrow();
        expect(() =>
          parseDesignProposal(
            proposalFor(family, difficulty, {
              presentationSkin: validSkin(family, difficulty),
            }),
            assignment,
          ),
        ).not.toThrow();
      }
    }
    expect(
      parseDesignProposal(
        proposalFor("ranking", 1, {
          designIntent: "Provenance only.",
          presentationSkin: validSkin("ranking", 1, "space"),
        }),
        assignmentFor("ranking", 1),
      ).presentationSkin,
    ).not.toBeNull();
  });

  it("rejects missing, duplicate, extra, and cross-theme labels", () => {
    const assignment = assignmentFor("ranking", 1);
    const skin = validSkin("ranking", 1);
    const missing: unknown = {
      ...skin,
      labels: skin.labels.slice(0, 3),
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: missing }),
      assignment,
      "SCHEMA_INVALID",
    );
    const duplicate: unknown = {
      ...skin,
      labels: [skin.labels[0]!, skin.labels[0]!, skin.labels[2]!, skin.labels[3]!],
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: duplicate }),
      assignment,
      "SKIN_INVALID",
    );
    const extra: unknown = {
      ...skin,
      labels: [...skin.labels, { entityId: "item-4", label: "Cedar" as const }],
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: extra }),
      assignment,
      "SCHEMA_INVALID",
    );
    const crossFamily: unknown = {
      ...skin,
      labels: [
        ...skin.labels.slice(0, 3),
        { entityId: "person-0", label: "Cedar" as const },
      ],
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: crossFamily }),
      assignment,
      "SCHEMA_INVALID",
    );
    const crossTheme: unknown = {
      ...skin,
      labels: [
        { entityId: "item-0", label: "Mars" as const },
        skin.labels[1]!,
        skin.labels[2]!,
        skin.labels[3]!,
      ],
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: crossTheme }),
      assignment,
      "SKIN_INVALID",
    );
    const outsideCatalog: unknown = {
      ...skin,
      labels: [
        { entityId: "item-0", label: "NotALabel" },
        skin.labels[1]!,
        skin.labels[2]!,
        skin.labels[3]!,
      ],
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: outsideCatalog }),
      assignment,
      "SCHEMA_INVALID",
    );
    const badTheme: unknown = {
      ...skin,
      theme: "desert",
    };
    expectProposalError(
      proposalFor("ranking", 1, { presentationSkin: badTheme }),
      assignment,
      "SCHEMA_INVALID",
    );
  });

  it("requires null when skin proposals are disabled", () => {
    const assignment = assignmentFor("ranking", 1);
    expect(() =>
      parseDesignProposal(proposalFor("ranking", 1), assignment, {
        skinEnabled: false,
      }),
    ).not.toThrow();
    expectProposalError(
      proposalFor("ranking", 1, {
        presentationSkin: validSkin("ranking", 1),
      }),
      assignment,
      "SCHEMA_INVALID",
      { skinEnabled: false },
    );
  });
});

describe("designer request identity and prompt", () => {
  it("builds byte-identical requests for one-shot and feedback attempt 0", () => {
    const assignment = assignmentFor("ranking", 1);
    const oneShot = buildDesignProposalRequestForArm({
      assignment,
      arm: "ai_one_shot",
      model: "test/designer",
      outputCapField: "max_tokens",
      maxOutputTokens: 8192,
      skinEnabled: true,
    });
    const feedback = buildDesignProposalRequestForArm({
      assignment,
      arm: "ai_feedback",
      model: "test/designer",
      outputCapField: "max_tokens",
      maxOutputTokens: 8192,
      skinEnabled: true,
    });
    expect(feedback.body).toEqual(oneShot.body);
    expect(feedback.requestHash).toBe(oneShot.requestHash);
    expect(feedback.schemaHash).toBe(oneShot.schemaHash);
    expect(feedback.promptHash).toBe(oneShot.promptHash);
    expect(oneShot.requestHash).toBe(hashCanonicalJson(oneShot.body));
    expect(oneShot.body).toMatchObject({
      model: "test/designer",
      stream: false,
      max_tokens: 8192,
      provider: { allow_fallbacks: true, require_parameters: true },
    });
    expect(oneShot.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true, name: oneShot.metadata.schemaName },
    });
    expect("max_completion_tokens" in oneShot.body).toBe(false);
  });

  it("includes assignment, bounds, DSL schema, response schema, and skin catalog", () => {
    const assignment = assignmentFor("ranking", 1);
    const built = buildDesignProposalRequest({
      assignment,
      model: "test/designer",
      outputCapField: "max_completion_tokens",
      maxOutputTokens: 4096,
      skinEnabled: true,
    });
    expect(built.messages).toHaveLength(2);
    expect(built.messages[0]?.content).toContain("prompt_version: v2");
    expect(built.messages[0]?.content).toContain("designer");
    const payload = JSON.parse(String(built.messages[1]?.content)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual([
      "assignment",
      "bounds",
      "dslSchema",
      "responseSchema",
      "skinCatalog",
    ]);
    expect(payload.assignment).toEqual({
      assignmentId: assignment.assignmentId,
      family: "ranking",
      difficulty: 1,
    });
    expect(payload.bounds).toMatchObject({
      family: "ranking",
      difficulty: 1,
      allowedOperators: ["before", "immediatelyBefore", "at", "notAt"],
    });
    expect(payload.skinCatalog).toMatchObject({
      themes: DESIGNER_SKIN_THEMES,
      maxLabels: 4,
    });
    expect("baseline" in payload).toBe(false);
    expect("witness" in payload).toBe(false);
    expect("answer" in payload).toBe(false);
    expect("humanFeedback" in payload).toBe(false);
    expect(built.body.max_completion_tokens).toBe(4096);
    expect("max_tokens" in built.body).toBe(false);
  });

  it("changes prompt and schema hashes for family, difficulty, and skin mode", () => {
    const ranking1 = designProposalMetadataFor("ranking", 1, {
      skinEnabled: true,
    });
    const ranking2 = designProposalMetadataFor("ranking", 2, {
      skinEnabled: true,
    });
    const matching1 = designProposalMetadataFor("matching", 1, {
      skinEnabled: true,
    });
    const rankingNoSkin = designProposalMetadataFor("ranking", 1, {
      skinEnabled: false,
    });
    expect(ranking1.promptHash).not.toBe(ranking2.promptHash);
    expect(ranking1.schemaHash).not.toBe(ranking2.schemaHash);
    expect(ranking1.promptHash).not.toBe(matching1.promptHash);
    expect(ranking1.schemaHash).not.toBe(matching1.schemaHash);
    expect(ranking1.promptHash).not.toBe(rankingNoSkin.promptHash);
    expect(ranking1.schemaHash).not.toBe(rankingNoSkin.schemaHash);
    expect(
      designProposalMetadataFor("ranking", 1, { skinEnabled: true }),
    ).toEqual(ranking1);
  });

  it("does not perform network calls while building a request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    buildDesignProposalRequest({
      assignment: assignmentFor("matching", 2),
      model: "test/designer",
      outputCapField: "max_tokens",
      maxOutputTokens: 8192,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("designer configuration", () => {
  it("reads a designer-only environment without legacy reviewer variables", () => {
    const config = readDesignerLiveEnvironment({
      OPENROUTER_API_KEY: "sk-designer-test",
      DESIGNER_MODEL: "vendor/designer",
    });
    expect(config).toEqual({
      apiKey: "sk-designer-test",
      designer: { model: "vendor/designer" },
      settings: {},
      maxOutputTokens: 8192,
    });
  });

  it("parses and validates optional designer settings", () => {
    const config = readDesignerLiveEnvironment({
      OPENROUTER_API_KEY: "sk-designer-test",
      DESIGNER_MODEL: "vendor/designer",
      DESIGNER_TEMPERATURE: "0.7",
      DESIGNER_SEED: "42",
      DESIGNER_REASONING: "true",
      DESIGNER_REASONING_EFFORT: "high",
      DESIGNER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(config.settings).toEqual({
      temperature: 0.7,
      seed: 42,
      reasoning: true,
      reasoningEffort: "high",
    });
    expect(config.maxOutputTokens).toBe(4096);
    expect(() =>
      readDesignerLiveEnvironment({
        OPENROUTER_API_KEY: "sk-designer-test",
        DESIGNER_MODEL: "vendor/designer",
        DESIGNER_TEMPERATURE: "3",
      }),
    ).toThrow(AiConfigError);
    expect(() =>
      readDesignerLiveEnvironment({
        OPENROUTER_API_KEY: "sk-designer-test",
        DESIGNER_MODEL: "vendor/*",
      }),
    ).toThrow(AiConfigError);
  });

  it("requires only the designer key and model and keeps the legacy contract intact", () => {
    expect(() => readDesignerLiveEnvironment({})).toThrow(
      expect.objectContaining({ code: "MISSING_INFERENCE_KEY" }),
    );
    expect(() =>
      readDesignerLiveEnvironment({ OPENROUTER_API_KEY: "sk-designer-test" }),
    ).toThrow(expect.objectContaining({ code: "MISSING_MODEL" }));
    expect(() =>
      readLiveEnvironment({
        OPENROUTER_API_KEY: "sk-designer-test",
        DESIGNER_MODEL: "vendor/designer",
      }),
    ).toThrow(expect.objectContaining({ code: "MISSING_MODEL" }));
  });

  it("maps designer roles through the shared request builder", () => {
    expect(AI_REQUEST_ROLES).toContain("design");
    expect(defaultMaxOutputTokensFor("design")).toBe(8192);
    expect(defaultMaxOutputTokensFor("design_repair_1")).toBe(8192);
    expect(requiresImageForRole("design")).toBe(false);
    expect(modelRoleForRequestRole("design")).toBe("designer");
    expect(modelRoleForRequestRole("spec")).toBe("generator");
    const built = buildChatRequest({
      role: "design",
      model: "test/designer",
      outputCapField: "max_tokens",
      maxOutputTokens: 8192,
      messages: [{ role: "user", content: "design" }],
      responseFormat: FAMILY_SPEC_JSON_SCHEMAS.ranking,
    });
    expect(built.body.model).toBe("test/designer");
    expect(() =>
      buildChatRequest({
        role: "design",
        model: "test/designer",
        outputCapField: "max_tokens",
        maxOutputTokens: 8192,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "design" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
            ],
          },
        ],
        responseFormat: FAMILY_SPEC_JSON_SCHEMAS.ranking,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("designer role seams and strict schema failure", () => {
  it("preserves the legacy probe-role array and counts", () => {
    expect(LIVE_PROBE_COUNT).toBe(5);
    expect(LIVE_PROBE_ROLES).toEqual([
      "spec",
      "blind_text",
      "alignment_text",
      "blind_vision",
      "alignment_vision",
    ]);
    expect(LIVE_PROBE_ROLES).not.toContain("design");
  });

  it("extends ledger roles while keeping the mock parser explicit about designer roles", () => {
    expect(LedgerRoleSchema.safeParse("spec").success).toBe(true);
    expect(LedgerRoleSchema.safeParse("preflight").success).toBe(true);
    expect(LedgerRoleSchema.safeParse("design").success).toBe(true);
    expect(LedgerRoleSchema.safeParse("design_repair_1").success).toBe(true);
    expect(
      MockScenarioSchema.safeParse({
        role: "design",
        family: "ranking",
        difficulty: 1,
        seed: SHA_A,
        kind: "valid",
      }).success,
    ).toBe(false);
  });

  it("compiles every selected-family designer schema strictly", () => {
    for (const family of FAMILIES) {
      for (const difficulty of DIFFICULTIES) {
        for (const skinEnabled of [true, false]) {
          const schema = designerProposalJsonSchema(family, difficulty, {
            skinEnabled,
          });
          expect(schema.strict).toBe(true);
          expect(schema.name.length).toBeLessThanOrEqual(64);
          expect(strictSchemaHash(schema)).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
  });

  it("uses a flat RPN truth schema without recursive refs", () => {
    const schema = designerProposalJsonSchema("truth", 1, {
      skinEnabled: true,
    });
    const serialized = JSON.stringify(schema.schema);
    expect(serialized).not.toContain('"$defs"');
    expect(serialized).not.toContain('"$ref"');
    expect(serialized).toContain('"rpn"');
    expect(serialized).toContain('"truthful"');
    expect(serialized).toContain('"not"');
    expect(serialized).toContain('"and"');
    expect(serialized).toContain('"or"');
    expect(serialized).toContain('"xor"');
  });

  it("parses truth RPN into the canonical AST", () => {
    const canonical = truthSpec(1);
    const parsed = parseDesignProposal(
      {
        family: "truth",
        difficulty: 1,
        spec: truthSpecToRpn(canonical),
        designIntent: null,
        presentationSkin: null,
      },
      assignmentFor("truth", 1),
    );
    expect(parsed.spec).toEqual(canonical);
  });

  it("fails loudly on dynamic record schemas before transport", () => {
    expect(() =>
      compileStrictJsonSchema(
        "bad_dynamic_record",
        z.strictObject({
          labels: z.record(z.string(), z.string()),
        }),
      ),
    ).toThrow(StrictSchemaError);
  });
});

describe("designer CLI", () => {
  function captureStdout(action: () => Promise<number>): Promise<{
    readonly code: number;
    readonly output: string;
  }> {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const writeError = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    return action()
      .then((code) => ({
        code,
        output: write.mock.calls.map((call) => String(call[0])).join(""),
      }))
      .finally(() => {
        write.mockRestore();
        writeError.mockRestore();
      });
  }

  it("prints the deterministic primary dry-run manifest", async () => {
    const { code, output } = await captureStdout(() =>
      designerMain([
        "node",
        "designer",
        "--dry-run",
        "--seed",
        "puzzle-designer-v1",
      ]),
    );
    expect(code).toBe(0);
    const plan = JSON.parse(output) as DesignerPlanManifest;
    expect(plan.runKind).toBe("design_primary");
    expect(plan.assignments).toHaveLength(100);
    expect(plan.candidates).toHaveLength(300);
    expect(plan.requestEstimate.totalLogicalCalls).toBe(400);
    expect(plan.requestEstimate.baselineAiCalls).toBe(0);
  });

  it("selects pilot and mock dry-run plans", async () => {
    const pilot = await captureStdout(() =>
      designerMain(["node", "designer", "--dry-run", "--pilot"]),
    );
    expect(pilot.code).toBe(0);
    const pilotPlan = JSON.parse(pilot.output) as DesignerPlanManifest;
    expect(pilotPlan.runKind).toBe("design_pilot");
    expect(pilotPlan.assignments).toHaveLength(20);
    expect(pilotPlan.requestEstimate.totalLogicalCalls).toBe(82);
    const mock = await captureStdout(() =>
      designerMain(["node", "designer", "--dry-run", "--mock"]),
    );
    expect(mock.code).toBe(0);
    const mockPlan = JSON.parse(mock.output) as DesignerPlanManifest;
    expect(mockPlan.runKind).toBe("design_mock");
    expect(mockPlan.rootSeed).toBe(DESIGNER_ROOT_SEEDS.design_mock);
  });

  it("rejects bare execution, reviewer flags, calibration flags, and bad seeds", async () => {
    expect((await captureStdout(() => designerMain(["node", "designer"]))).code).toBe(
      1,
    );
    expect(
      (
        await captureStdout(() =>
          designerMain(["node", "designer", "--dry-run", "--reviewer"]),
        )
      ).code,
    ).toBe(1);
    expect(
      (
        await captureStdout(() =>
          designerMain(["node", "designer", "--dry-run", "--calibration"]),
        )
      ).code,
    ).toBe(1);
    expect(
      (
        await captureStdout(() =>
          designerMain(["node", "designer", "--dry-run", "--primary", "--pilot"]),
        )
      ).code,
    ).toBe(1);
    expect(
      (
        await captureStdout(() =>
          designerMain([
            "node",
            "designer",
            "--dry-run",
            "--seed",
            "puzzle-poc-v1",
          ]),
        )
      ).code,
    ).toBe(1);
  });
});
