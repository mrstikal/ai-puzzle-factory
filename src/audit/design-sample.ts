import { z } from "zod";
import {
  DESIGNER_CANDIDATE_SLOT_ID_PATTERN,
  DesignerArmSchema,
} from "../domain/design.js";
import {
  DIFFICULTIES,
  FAMILIES,
  FamilySchema,
  type Difficulty,
  type Family,
} from "../domain/experiment.js";
import { DesignViewSchema } from "../presentation/design-view.js";
import { createDesignerStream } from "../design/assignments.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const DESIGN_EVALUATION_SAMPLE_VERSION = "p50.3-design-sample-v1" as const;

export const DESIGN_EVALUATION_RUBRIC = Object.freeze({
  version: "p50.3-rubric-v1" as const,
  clarity: {
    min: 1,
    max: 5,
    clearFrom: 4,
    labels: ["1 unclear", "2 weak", "3 acceptable", "4 clear", "5 very clear"],
  },
  interest: {
    min: 1,
    max: 5,
    labels: [
      "1 repetitive/unengaging",
      "2 weak",
      "3 acceptable",
      "4 engaging",
      "5 engaging/original within stated rules",
    ],
  },
  difficulty: {
    min: 1,
    max: 5,
    labels: ["1 trivial", "2 easy", "3 moderate", "4 hard", "5 very hard"],
  },
  solveTime: [
    "<=60s",
    "61-180s",
    ">180s",
    "not_solved",
    "not_inspectable",
  ] as const,
  maxCoreCandidates: 30,
  maxAdditions: 10,
  maxCandidates: 40,
});

export const DESIGN_EVALUATION_ADDITION_CATEGORIES = [
  "repaired",
  "novel",
  "near_baseline",
  "least_represented_family",
  "least_represented_arm",
] as const;
export type DesignEvaluationAdditionCategory =
  (typeof DESIGN_EVALUATION_ADDITION_CATEGORIES)[number];

export const DesignSampleCandidateSchema = z.strictObject({
  slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  assignmentId: z.string().min(1),
  assignmentOrdinal: z.number().int().positive(),
  arm: DesignerArmSchema,
  family: FamilySchema,
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  finalVerdict: z.literal("accepted"),
  attemptCount: z.number().int().min(1).max(3),
  finalNovelty: z.enum([
    "baseline_duplicate",
    "near_baseline",
    "novel",
    "novelty_unknown",
  ]),
  view: DesignViewSchema,
  svg: z.string().nullable(),
  certificateHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignSampleCandidate = z.infer<
  typeof DesignSampleCandidateSchema
>;

export const DesignPublicPuzzleSchema = z.strictObject({
  evaluationId: z.string().regex(/^ev-[0-9a-f]{24}$/),
  title: z.string().min(1).max(120),
  question: z.string().min(1).max(400),
  rules: z.array(z.string().min(1)),
  clues: z.array(z.string().min(1)),
  options: z.array(
    z.strictObject({
      label: z.enum(["A", "B", "C", "D"]),
      text: z.string().min(1),
    }),
  ),
  assets: z.strictObject({
    svgHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    pngHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }),
  svg: z.string().nullable(),
  publicHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignPublicPuzzle = z.infer<typeof DesignPublicPuzzleSchema>;

export const DesignEvaluationTripletSchema = z.strictObject({
  tripletId: z.string().regex(/^triplet-\d{2}$/),
  memberIds: z.array(z.string().regex(/^ev-[0-9a-f]{24}$/)).min(1).max(3),
});
export type DesignEvaluationTriplet = z.infer<
  typeof DesignEvaluationTripletSchema
>;

export const DesignEvaluationAdditionSchema = z.strictObject({
  evaluationId: z.string().regex(/^ev-[0-9a-f]{24}$/),
  reason: z.enum(DESIGN_EVALUATION_ADDITION_CATEGORIES),
  categories: z.array(z.enum(DESIGN_EVALUATION_ADDITION_CATEGORIES)),
});
export type DesignEvaluationAddition = z.infer<
  typeof DesignEvaluationAdditionSchema
>;

export const DesignEvaluationPublicBundleSchema = z.strictObject({
  version: z.literal(DESIGN_EVALUATION_SAMPLE_VERSION),
  kind: z.literal("design_evaluation_public_bundle"),
  sampleHash: z.string().regex(/^[0-9a-f]{64}$/),
  rubric: z.literal("p50.3-rubric-v1"),
  triplets: z.array(DesignEvaluationTripletSchema).max(10),
  additions: z.array(z.string().regex(/^ev-[0-9a-f]{24}$/)).max(10),
  puzzles: z.array(DesignPublicPuzzleSchema).max(40),
  publicHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignEvaluationPublicBundle = z.infer<
  typeof DesignEvaluationPublicBundleSchema
>;

export const DesignEvaluationPrivateMemberSchema = z.strictObject({
  evaluationId: z.string().regex(/^ev-[0-9a-f]{24}$/),
  slotId: z.string().regex(DESIGNER_CANDIDATE_SLOT_ID_PATTERN),
  assignmentId: z.string().min(1),
  assignmentOrdinal: z.number().int().positive(),
  arm: DesignerArmSchema,
  family: FamilySchema,
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  attemptCount: z.number().int().min(1).max(3),
  finalNovelty: z.enum([
    "baseline_duplicate",
    "near_baseline",
    "novel",
    "novelty_unknown",
  ]),
  certificateHash: z.string().regex(/^[0-9a-f]{64}$/),
  reveal: z.strictObject({
    correctLabel: z.enum(["A", "B", "C", "D"]),
    correctValue: z.unknown(),
    hint: z.string().min(1),
    explanationSteps: z.array(z.unknown()),
    proofTrace: z.unknown(),
  }),
});
export type DesignEvaluationPrivateMember = z.infer<
  typeof DesignEvaluationPrivateMemberSchema
>;

export const DesignEvaluationPrivateBundleSchema = z.strictObject({
  version: z.literal(DESIGN_EVALUATION_SAMPLE_VERSION),
  kind: z.literal("design_evaluation_private_bundle"),
  sampleHash: z.string().regex(/^[0-9a-f]{64}$/),
  members: z.array(DesignEvaluationPrivateMemberSchema),
  triplets: z.array(
    z.strictObject({
      tripletId: z.string().regex(/^triplet-\d{2}$/),
      family: FamilySchema,
      kind: z.enum(["assignment_matched", "family_difficulty_matched"]),
      matchedDifficulty: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .nullable(),
      absentArms: z.array(DesignerArmSchema),
      matchedAssignmentIds: z.array(z.string().min(1)),
      memberIds: z.array(z.string().regex(/^ev-[0-9a-f]{24}$/)).min(1).max(3),
    }),
  ),
  additions: z.array(
    z.strictObject({
      evaluationId: z.string().regex(/^ev-[0-9a-f]{24}$/),
      reason: z.enum(DESIGN_EVALUATION_ADDITION_CATEGORIES),
      categories: z.array(z.enum(DESIGN_EVALUATION_ADDITION_CATEGORIES)),
    }),
  ),
  privateHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DesignEvaluationPrivateBundle = z.infer<
  typeof DesignEvaluationPrivateBundleSchema
>;

export const DesignSelectionSummarySchema = z.strictObject({
  coreCandidates: z.number().int().nonnegative(),
  additionCandidates: z.number().int().nonnegative(),
  totalCandidates: z.number().int().nonnegative(),
  assignmentMatchedTriplets: z.number().int().nonnegative(),
  fallbackTriplets: z.number().int().nonnegative(),
  missingFamilies: z.array(z.enum(FAMILIES)),
  absentArms: z.record(z.string(), z.array(DesignerArmSchema)),
  categoriesCovered: z.array(z.enum(DESIGN_EVALUATION_ADDITION_CATEGORIES)),
  categoriesMissing: z.array(z.enum(DESIGN_EVALUATION_ADDITION_CATEGORIES)),
  shortfalls: z.array(z.string().min(1)),
});
export type DesignSelectionSummary = z.infer<
  typeof DesignSelectionSummarySchema
>;

export const DesignEvaluationSampleSchema = z.strictObject({
  version: z.literal(DESIGN_EVALUATION_SAMPLE_VERSION),
  kind: z.literal("design_evaluation_sample"),
  sampleHash: z.string().regex(/^[0-9a-f]{64}$/),
  runId: z.string().min(1),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  rootSeed: z.string().min(1),
  createdAt: z.iso.datetime(),
  publicBundle: DesignEvaluationPublicBundleSchema,
  privateBundle: DesignEvaluationPrivateBundleSchema,
  selection: DesignSelectionSummarySchema,
});
export type DesignEvaluationSample = z.infer<
  typeof DesignEvaluationSampleSchema
>;

export interface BuildDesignEvaluationSampleInput {
  readonly runId: string;
  readonly planHash: string;
  readonly protocolVersion: string;
  readonly rootSeed: string;
  readonly createdAt: string;
  readonly candidates: readonly DesignSampleCandidate[];
  readonly maxTriplets?: number;
  readonly maxAdditions?: number;
  readonly maxCandidates?: number;
}

function candidateTieHash(rootSeed: string, slotId: string): string {
  return sha256Hex(canonicalJson(["p50.3-candidate", rootSeed, slotId]));
}

function evaluationIdFor(input: {
  readonly runId: string;
  readonly planHash: string;
  readonly rootSeed: string;
  readonly slotId: string;
  readonly certificateHash: string;
}): string {
  return `ev-${sha256Hex(
    canonicalJson([
      "p50.3-evaluation-id",
      input.runId,
      input.planHash,
      input.rootSeed,
      input.slotId,
      input.certificateHash,
    ]),
  ).slice(0, 24)}`;
}

function publicPuzzleFor(input: {
  readonly evaluationId: string;
  readonly candidate: DesignSampleCandidate;
}): DesignPublicPuzzle {
  const visible = input.candidate.view.visible;
  const body = {
    evaluationId: input.evaluationId,
    title: visible.title,
    question: visible.question,
    rules: [
      visible.rules.domain,
      visible.rules.closedWorld,
      visible.rules.target,
      ...visible.rules.operations,
      ...visible.rules.conventions,
    ],
    clues: visible.clues.map((clue) => clue.text),
    options: visible.options,
    assets: visible.assets,
    svg: input.candidate.svg,
  };
  return DesignPublicPuzzleSchema.parse({
    ...body,
    publicHash: sha256Hex(canonicalJson(body)),
  });
}

function privateMemberFor(input: {
  readonly evaluationId: string;
  readonly candidate: DesignSampleCandidate;
}): DesignEvaluationPrivateMember {
  return DesignEvaluationPrivateMemberSchema.parse({
    evaluationId: input.evaluationId,
    slotId: input.candidate.slotId,
    assignmentId: input.candidate.assignmentId,
    assignmentOrdinal: input.candidate.assignmentOrdinal,
    arm: input.candidate.arm,
    family: input.candidate.family,
    difficulty: input.candidate.difficulty,
    attemptCount: input.candidate.attemptCount,
    finalNovelty: input.candidate.finalNovelty,
    certificateHash: input.candidate.certificateHash,
    reveal: {
      correctLabel: input.candidate.view.reveal.correctLabel,
      correctValue: input.candidate.view.reveal.correctValue,
      hint: input.candidate.view.reveal.hint,
      explanationSteps: input.candidate.view.reveal.explanationSteps,
      proofTrace: input.candidate.view.reveal.proofTrace,
    },
  });
}

function groupByAssignment(
  candidates: readonly DesignSampleCandidate[],
): Map<string, Map<string, DesignSampleCandidate>> {
  const result = new Map<string, Map<string, DesignSampleCandidate>>();
  for (const candidate of candidates) {
    const byArm = result.get(candidate.assignmentId) ?? new Map();
    byArm.set(candidate.arm, candidate);
    result.set(candidate.assignmentId, byArm);
  }
  return result;
}

function chooseCoreTriplet(input: {
  readonly family: Family;
  readonly byAssignment: Map<string, Map<string, DesignSampleCandidate>>;
  readonly rootSeed: string;
  readonly protocolVersion: string;
}): {
  readonly members: DesignSampleCandidate[];
  readonly kind: "assignment_matched" | "family_difficulty_matched";
  readonly difficulty: Difficulty | null;
  readonly absentArms: Array<DesignSampleCandidate["arm"]>;
  readonly matchedAssignmentIds: string[];
  readonly orderSeedId: string;
} | null {
  const assignments = [...input.byAssignment.entries()]
    .map(([assignmentId, byArm]) => ({
      assignmentId,
      byArm,
      tieHash: candidateTieHash(input.rootSeed, assignmentId),
    }))
    .sort((left, right) => left.tieHash.localeCompare(right.tieHash));
  for (const assignment of assignments) {
    const members = (["baseline", "ai_one_shot", "ai_feedback"] as const)
      .map((arm) => assignment.byArm.get(arm))
      .filter((candidate): candidate is DesignSampleCandidate => candidate !== undefined);
    if (members.length === 3) {
      return {
        members,
        kind: "assignment_matched",
        difficulty: null,
        absentArms: [],
        matchedAssignmentIds: [assignment.assignmentId],
        orderSeedId: assignment.assignmentId,
      };
    }
  }
  let bestDifficulty: Difficulty | null = null;
  let bestCount = 0;
  let bestTie = "";
  for (const difficulty of DIFFICULTIES) {
    const arms = new Set<DesignSampleCandidate["arm"]>();
    for (const assignment of assignments) {
      for (const [arm, candidate] of assignment.byArm) {
        if (candidate.difficulty === difficulty) {
          arms.add(arm as DesignSampleCandidate["arm"]);
        }
      }
    }
    if (arms.size > bestCount) {
      bestDifficulty = difficulty;
      bestCount = arms.size;
      bestTie = sha256Hex(
        canonicalJson(["p50.3-difficulty", input.rootSeed, input.family, difficulty]),
      );
    } else if (arms.size === bestCount && arms.size > 0) {
      const tie = sha256Hex(
        canonicalJson(["p50.3-difficulty", input.rootSeed, input.family, difficulty]),
      );
      if (tie.localeCompare(bestTie) < 0) {
        bestDifficulty = difficulty;
        bestTie = tie;
      }
    }
  }
  if (bestDifficulty === null || bestCount === 0) {
    return null;
  }
  const candidatesForDifficulty = assignments
    .flatMap((assignment) =>
      [...assignment.byArm.values()].filter(
        (candidate) => candidate.difficulty === bestDifficulty,
      ),
    )
    .sort((left, right) =>
      candidateTieHash(input.rootSeed, left.slotId).localeCompare(
        candidateTieHash(input.rootSeed, right.slotId),
      ),
    );
  const byArm = new Map<DesignSampleCandidate["arm"], DesignSampleCandidate>();
  for (const candidate of candidatesForDifficulty) {
    if (!byArm.has(candidate.arm)) {
      byArm.set(candidate.arm, candidate);
    }
  }
  if (byArm.size === 0) {
    return null;
  }
  const orderSeedId = `family:${input.family}:difficulty:${bestDifficulty}`;
  return {
    members: [...byArm.values()],
    kind: "family_difficulty_matched",
    difficulty: bestDifficulty,
    absentArms: (["baseline", "ai_one_shot", "ai_feedback"] as const).filter(
      (arm) => !byArm.has(arm),
    ),
    matchedAssignmentIds: [...new Set([...byArm.values()].map((c) => c.assignmentId))],
    orderSeedId,
  };
}

function categoryFor(
  candidate: DesignSampleCandidate,
): DesignEvaluationAdditionCategory[] {
  const categories: DesignEvaluationAdditionCategory[] = [];
  if (candidate.attemptCount > 1) {
    categories.push("repaired");
  }
  if (candidate.finalNovelty === "novel") {
    categories.push("novel");
  }
  if (candidate.finalNovelty === "near_baseline") {
    categories.push("near_baseline");
  }
  return categories;
}

function leastRepresented(
  values: readonly string[],
  selected: readonly DesignSampleCandidate[],
  selector: (candidate: DesignSampleCandidate) => string,
): string | null {
  let best: string | null = null;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const count = selected.filter((candidate) => selector(candidate) === value).length;
    if (count < bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function buildDesignEvaluationSample(
  input: BuildDesignEvaluationSampleInput,
): DesignEvaluationSample {
  const maxTriplets = input.maxTriplets ?? 10;
  const maxAdditions = input.maxAdditions ?? 10;
  const maxCandidates = input.maxCandidates ?? 40;
  if (maxTriplets < 1 || maxTriplets > 10) {
    throw new Error("maxTriplets must be 1..10");
  }
  if (maxAdditions < 0 || maxAdditions > 10) {
    throw new Error("maxAdditions must be 0..10");
  }
  if (maxCandidates < 1 || maxCandidates > 40) {
    throw new Error("maxCandidates must be 1..40");
  }
  const candidates = input.candidates.map((candidate) =>
    DesignSampleCandidateSchema.parse(candidate),
  );
  const byAssignment = groupByAssignment(candidates);
  const byFamily = new Map<Family, Map<string, Map<string, DesignSampleCandidate>>>();
  for (const [assignmentId, byArm] of byAssignment) {
    const first = [...byArm.values()][0];
    if (first === undefined) {
      continue;
    }
    const familyMap = byFamily.get(first.family) ?? new Map();
    familyMap.set(assignmentId, byArm);
    byFamily.set(first.family, familyMap);
  }

  const triplets: Array<{
    readonly public: DesignEvaluationTriplet;
    readonly private: DesignEvaluationPrivateBundle["triplets"][number];
    readonly members: DesignSampleCandidate[];
  }> = [];
  const shortfalls: string[] = [];
  const missingFamilies: Family[] = [];
  const absentArmsRecord: Record<string, Array<DesignSampleCandidate["arm"]>> = {};
  const publicPuzzles: DesignPublicPuzzle[] = [];
  const privateMembers: DesignEvaluationPrivateMember[] = [];
  const seenEvaluationIds = new Set<string>();

  const addMember = (candidate: DesignSampleCandidate): string => {
    const evaluationId = evaluationIdFor({
      runId: input.runId,
      planHash: input.planHash,
      rootSeed: input.rootSeed,
      slotId: candidate.slotId,
      certificateHash: candidate.certificateHash,
    });
    if (!seenEvaluationIds.has(evaluationId)) {
      seenEvaluationIds.add(evaluationId);
      publicPuzzles.push(publicPuzzleFor({ evaluationId, candidate }));
      privateMembers.push(privateMemberFor({ evaluationId, candidate }));
    }
    return evaluationId;
  };

  for (const family of FAMILIES) {
    if (triplets.length >= maxTriplets) {
      break;
    }
    const familyAssignments = byFamily.get(family);
    if (familyAssignments === undefined) {
      missingFamilies.push(family);
      shortfalls.push(`family_no_accepted_candidates:${family}`);
      continue;
    }
    const core = chooseCoreTriplet({
      family,
      byAssignment: familyAssignments,
      rootSeed: input.rootSeed,
      protocolVersion: input.protocolVersion,
    });
    if (core === null) {
      missingFamilies.push(family);
      shortfalls.push(`family_no_accepted_candidates:${family}`);
      continue;
    }
    const evaluationIds = core.members.map(addMember);
    const orderedIds = createDesignerStream({
      protocolVersion: input.protocolVersion,
      rootSeed: input.rootSeed,
      assignmentId: core.orderSeedId,
      arm: "shared",
      purpose: "human-order",
    }).shuffle(evaluationIds);
    const tripletId = `triplet-${String(triplets.length + 1).padStart(2, "0")}`;
    if (core.absentArms.length > 0) {
      absentArmsRecord[tripletId] = core.absentArms;
      shortfalls.push(
        `triplet_absent_arms:${tripletId}:${core.absentArms.join(",")}`,
      );
    }
    triplets.push({
      public: { tripletId, memberIds: orderedIds },
      private: {
        tripletId,
        family,
        kind: core.kind,
        matchedDifficulty: core.difficulty,
        absentArms: core.absentArms,
        matchedAssignmentIds: core.matchedAssignmentIds,
        memberIds: orderedIds,
      },
      members: core.members,
    });
  }

  const coreIds = new Set(
    triplets.flatMap((triplet) => triplet.public.memberIds),
  );
  const coreCandidates = candidates.filter((candidate) =>
    coreIds.has(
      evaluationIdFor({
        runId: input.runId,
        planHash: input.planHash,
        rootSeed: input.rootSeed,
        slotId: candidate.slotId,
        certificateHash: candidate.certificateHash,
      }),
    ),
  );
  const selected: DesignSampleCandidate[] = [...coreCandidates];
  const additions: DesignEvaluationAddition[] = [];
  const categoriesCovered = new Set<DesignEvaluationAdditionCategory>();
  const candidateById = new Map<string, DesignSampleCandidate>();
  for (const candidate of candidates) {
    candidateById.set(
      evaluationIdFor({
        runId: input.runId,
        planHash: input.planHash,
        rootSeed: input.rootSeed,
        slotId: candidate.slotId,
        certificateHash: candidate.certificateHash,
      }),
      candidate,
    );
  }
  const available = candidates
    .filter((candidate) => !selected.includes(candidate))
    .sort((left, right) =>
      candidateTieHash(input.rootSeed, left.slotId).localeCompare(
        candidateTieHash(input.rootSeed, right.slotId),
      ),
    );
  const addCandidate = (
    candidate: DesignSampleCandidate,
    reason: DesignEvaluationAdditionCategory,
    categories: DesignEvaluationAdditionCategory[],
  ): void => {
    selected.push(candidate);
    for (const category of categories) {
      categoriesCovered.add(category);
    }
    const evaluationId = addMember(candidate);
    additions.push({ evaluationId, reason, categories });
  };
  for (const category of ["repaired", "novel", "near_baseline"] as const) {
    if (additions.length >= maxAdditions) {
      break;
    }
    const representative = available.find(
      (candidate) =>
        !selected.includes(candidate) &&
        categoryFor(candidate).includes(category),
    );
    if (representative === undefined) {
      shortfalls.push(`category_missing:${category}`);
      continue;
    }
    addCandidate(
      representative,
      category,
      categoryFor(representative),
    );
  }
  while (
    additions.length < maxAdditions &&
    selected.length < maxCandidates
  ) {
    const remaining = available.filter((candidate) => !selected.includes(candidate));
    if (remaining.length === 0) {
      break;
    }
    const family = leastRepresented(
      FAMILIES,
      selected,
      (candidate) => candidate.family,
    );
    let representative = remaining.find((candidate) => candidate.family === family);
    let reason: DesignEvaluationAdditionCategory = "least_represented_family";
    if (representative === undefined) {
      const arm = leastRepresented(
        ["baseline", "ai_one_shot", "ai_feedback"],
        selected,
        (candidate) => candidate.arm,
      );
      representative = remaining.find((candidate) => candidate.arm === arm);
      reason = "least_represented_arm";
    }
    if (representative === undefined) {
      break;
    }
    addCandidate(representative, reason, categoryFor(representative));
  }
  const categoriesMissing = DESIGN_EVALUATION_ADDITION_CATEGORIES.filter(
    (category) =>
      !categoriesCovered.has(category) &&
      ((category === "repaired" ||
        category === "novel" ||
        category === "near_baseline")),
  );
  for (const category of categoriesMissing) {
    shortfalls.push(`category_missing:${category}`);
  }

  const publicBody = {
    version: DESIGN_EVALUATION_SAMPLE_VERSION,
    kind: "design_evaluation_public_bundle" as const,
    sampleHash: "0".repeat(64),
    rubric: DESIGN_EVALUATION_RUBRIC.version,
    triplets: triplets.map((triplet) => triplet.public),
    additions: additions.map((addition) => addition.evaluationId),
    puzzles: publicPuzzles,
    publicHash: "0".repeat(64),
  };
  const sampleHash = sha256Hex(
    canonicalJson({
      runId: input.runId,
      planHash: input.planHash,
      rootSeed: input.rootSeed,
      publicBody,
      privateMembers,
      triplets: triplets.map((triplet) => triplet.private),
    }),
  );
  const publicBase: Record<string, unknown> = { ...publicBody };
  delete publicBase.publicHash;
  const publicBundle = DesignEvaluationPublicBundleSchema.parse({
    ...publicBody,
    sampleHash,
    publicHash: sha256Hex(canonicalJson({ ...publicBase, sampleHash })),
  });
  const privateBody = {
    version: DESIGN_EVALUATION_SAMPLE_VERSION,
    kind: "design_evaluation_private_bundle" as const,
    sampleHash,
    members: privateMembers,
    triplets: triplets.map((triplet) => triplet.private),
    additions,
    privateHash: "0".repeat(64),
  };
  const privateBase: Record<string, unknown> = { ...privateBody };
  delete privateBase.privateHash;
  const privateBundle = DesignEvaluationPrivateBundleSchema.parse({
    ...privateBody,
    privateHash: sha256Hex(canonicalJson(privateBase)),
  });
  const selection: DesignSelectionSummary = {
    coreCandidates: coreIds.size,
    additionCandidates: additions.length,
    totalCandidates: coreIds.size + additions.length,
    assignmentMatchedTriplets: triplets.filter(
      (triplet) => triplet.private.kind === "assignment_matched",
    ).length,
    fallbackTriplets: triplets.filter(
      (triplet) => triplet.private.kind === "family_difficulty_matched",
    ).length,
    missingFamilies,
    absentArms: absentArmsRecord,
    categoriesCovered: [...categoriesCovered],
    categoriesMissing,
    shortfalls,
  };
  return DesignEvaluationSampleSchema.parse({
    version: DESIGN_EVALUATION_SAMPLE_VERSION,
    kind: "design_evaluation_sample",
    sampleHash,
    runId: input.runId,
    planHash: input.planHash,
    rootSeed: input.rootSeed,
    createdAt: input.createdAt,
    publicBundle,
    privateBundle,
    selection,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineSvg(svg: string): string {
  return svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
}

function assertSafeSvg(svg: string): void {
  const withoutNamespaces = svg.replace(
    /xmlns(?::xlink)?="http:\/\/www\.w3\.org\/[^"]*"/g,
    "",
  );
  const forbidden =
    /(?:https?:)?\/\/(?!www\.w3\.org\/)|@import|url\s*\(\s*['"]?(?!#)|on[a-z]+\s*=|javascript:/i;
  if (forbidden.test(withoutNamespaces)) {
    throw new Error("design evaluation SVG contains an external or active reference");
  }
}

function renderPuzzleCard(
  puzzle: DesignPublicPuzzle,
  index: number,
): string {
  if (puzzle.svg !== null) {
    assertSafeSvg(puzzle.svg);
  }
  const clues = puzzle.clues
    .map((clue) => `<li>${escapeHtml(clue)}</li>`)
    .join("");
  const options = puzzle.options
    .map(
      (option) =>
        `<li><strong>${escapeHtml(option.label)}.</strong> ${escapeHtml(option.text)}</li>`,
    )
    .join("");
  const rules = puzzle.rules
    .map((rule) => `<li>${escapeHtml(rule)}</li>`)
    .join("");
  return `<article class="puzzle" data-evaluation-id="${escapeHtml(puzzle.evaluationId)}" aria-label="Evaluation item ${index}">
  <h2>${escapeHtml(puzzle.title)}</h2>
  <p>${escapeHtml(puzzle.question)}</p>
  <h3>Rules</h3><ul>${rules}</ul>
  <h3>Clues</h3><ul>${clues}</ul>
  ${puzzle.svg === null ? "" : `<div class="asset" role="img" aria-label="Evaluation item ${index} image">${inlineSvg(puzzle.svg)}</div>`}
  <h3>Options</h3><ul>${options}</ul>
</article>`;
}

export function renderDesignEvaluationSolveGallery(
  sample: DesignEvaluationSample,
): string {
  const byId = new Map(
    sample.publicBundle.puzzles.map((puzzle) => [puzzle.evaluationId, puzzle]),
  );
  const sections = sample.publicBundle.triplets
    .map((triplet, tripletIndex) => {
      const cards = triplet.memberIds
        .map((evaluationId, index) => {
          const puzzle = byId.get(evaluationId);
          if (puzzle === undefined) {
            throw new Error(`missing public puzzle ${evaluationId}`);
          }
          return renderPuzzleCard(puzzle, index + 1);
        })
        .join("\n");
      return `<section aria-label="Set ${tripletIndex + 1}"><h2>Set ${tripletIndex + 1}</h2>${cards}</section>`;
    })
    .join("\n");
  const additions = sample.publicBundle.additions
    .map((evaluationId, index) => {
      const puzzle = byId.get(evaluationId);
      if (puzzle === undefined) {
        throw new Error(`missing addition puzzle ${evaluationId}`);
      }
      return renderPuzzleCard(puzzle, index + 1);
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<title>Design evaluation</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px;background:#f7f7f5;color:#161616}h1,h2,h3{line-height:1.2}section{margin-block:32px}.puzzle{background:#fff;border:1px solid #d8d8d2;border-radius:12px;padding:16px;margin-block:16px}.asset svg{max-width:100%;height:auto}ul{padding-left:20px}@media(max-width:600px){body{padding:10px}.puzzle{padding:12px}}</style>
</head>
<body>
<header><h1>Design evaluation</h1><p>Solve each puzzle and record your observations before using the reveal view.</p></header>
${sections}
${additions === "" ? "" : `<section aria-label="Additional items"><h2>Additional items</h2>${additions}</section>`}
<footer><p><a href="reveal.html">Reveal observations</a></p></footer>
</body>
</html>`;
}

export function renderDesignEvaluationRevealGallery(
  sample: DesignEvaluationSample,
): string {
  const publicById = new Map(
    sample.publicBundle.puzzles.map((puzzle) => [puzzle.evaluationId, puzzle]),
  );
  const privateById = new Map(
    sample.privateBundle.members.map((member) => [member.evaluationId, member]),
  );
  const cards = sample.privateBundle.members
    .map((member, index) => {
      const puzzle = publicById.get(member.evaluationId);
      const pub = privateById.get(member.evaluationId);
      if (puzzle === undefined || pub === undefined) {
        throw new Error(`missing reveal member ${member.evaluationId}`);
      }
      const steps = pub.reveal.explanationSteps
        .map((step) => `<li><pre>${escapeHtml(JSON.stringify(step, null, 2))}</pre></li>`)
        .join("");
      return `<article class="puzzle" data-evaluation-id="${escapeHtml(member.evaluationId)}" aria-label="Reveal item ${index + 1}">
  <h2>${escapeHtml(puzzle.title)}</h2>
  <p><strong>Private arm:</strong> ${escapeHtml(member.arm)} · <strong>Assignment:</strong> ${escapeHtml(member.assignmentId)} · <strong>Repairs:</strong> ${member.attemptCount - 1} · <strong>Novelty:</strong> ${escapeHtml(member.finalNovelty)}</p>
  <p><strong>Correct option:</strong> ${escapeHtml(member.reveal.correctLabel)}</p>
  <pre>${escapeHtml(JSON.stringify(member.reveal.correctValue, null, 2))}</pre>
  <p><strong>Hint:</strong> ${escapeHtml(member.reveal.hint)}</p>
  <ol>${steps}</ol>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<title>Design evaluation reveal</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px;background:#fff8f0;color:#161616}.puzzle{background:#fff;border:1px solid #d8d8d2;border-radius:12px;padding:16px;margin-block:16px}pre{white-space:pre-wrap;word-break:break-word}@media(max-width:600px){body{padding:10px}.puzzle{padding:12px}}</style>
</head>
<body>
<header><h1>Reveal observations</h1><p>Use only after recording the pre-reveal observations. This page intentionally contains private arm and answer metadata.</p></header>
${cards}
</body>
</html>`;
}
