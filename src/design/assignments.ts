import { createHash } from "node:crypto";
import {
  DESIGNER_ARMS,
  DESIGNER_PROTOCOL_VERSION,
  DESIGNER_ROOT_SEEDS,
  DesignerPlanManifestSchema,
  computeDesignerPlanHash,
  pilotDifficultyForFamily,
  primaryDifficultyForWithinFamily,
  type DesignerArm,
  type DesignerAssignment,
  type DesignerCandidateSlot,
  type DesignerDifficultyCount,
  type DesignerPlanManifest,
  type DesignerQuotas,
  type DesignerRequestEstimate,
  type DesignerRunKind,
} from "../domain/design.js";
import {
  DIFFICULTIES,
  FAMILIES,
  MAX_TRANSPORT_ATTEMPTS_PER_CALL,
  MODALITY_BY_FAMILY,
  type Difficulty,
} from "../domain/experiment.js";
import { HashCounterPrng } from "../util/random.js";

export const DESIGNER_STREAM_PURPOSES = [
  "options",
  "layout",
  "baseline",
  "dispatch-order",
  "human-order",
] as const;
export type DesignerStreamPurpose =
  (typeof DESIGNER_STREAM_PURPOSES)[number];

export type DesignerStreamScope = DesignerArm | "shared";

export interface DesignerStreamDescriptor {
  readonly protocolVersion: string;
  readonly rootSeed: string;
  readonly assignmentId: string;
  readonly arm: DesignerStreamScope;
  readonly purpose: DesignerStreamPurpose;
}

export function deriveDesignerStreamSeed(
  descriptor: DesignerStreamDescriptor,
): string {
  const payload = JSON.stringify([
    descriptor.protocolVersion,
    descriptor.rootSeed,
    descriptor.assignmentId,
    descriptor.arm,
    descriptor.purpose,
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function createDesignerStream(
  descriptor: DesignerStreamDescriptor,
): HashCounterPrng {
  return new HashCounterPrng(deriveDesignerStreamSeed(descriptor));
}

export interface BuildDesignerPlanOptions {
  readonly runKind: DesignerRunKind;
  readonly rootSeed?: string;
}

export function buildDesignerAssignments(
  runKind: DesignerRunKind,
  rootSeed: string,
): DesignerAssignment[] {
  const perFamily = runKind === "design_pilot" ? 2 : 10;
  const assignments: DesignerAssignment[] = [];
  let assignmentOrdinal = 0;
  for (const [familyIndex, family] of FAMILIES.entries()) {
    const modality = MODALITY_BY_FAMILY[family];
    const pilot = pilotDifficultyForFamily(familyIndex);
    for (let within = 0; within < perFamily; within += 1) {
      const difficulty: Difficulty | undefined =
        runKind === "design_pilot"
          ? pilot[within]
          : primaryDifficultyForWithinFamily(within);
      if (difficulty === undefined) {
        throw new Error(
          `no ${runKind} difficulty is defined for ${family} assignment ${within + 1}`,
        );
      }
      const assignmentId = `design-${modality}-${family}-${String(within + 1).padStart(2, "0")}`;
      assignmentOrdinal += 1;
      assignments.push({
        assignmentId,
        assignmentOrdinal,
        family,
        modality,
        difficulty,
        assignmentSeed: deriveDesignerStreamSeed({
          protocolVersion: DESIGNER_PROTOCOL_VERSION,
          rootSeed,
          assignmentId,
          arm: "shared",
          purpose: "options",
        }),
      });
    }
  }
  return assignments;
}

export function buildDesignerCandidates(
  assignments: readonly DesignerAssignment[],
): DesignerCandidateSlot[] {
  const candidates: DesignerCandidateSlot[] = [];
  let candidateOrdinal = 0;
  for (const assignment of assignments) {
    for (const arm of DESIGNER_ARMS) {
      candidateOrdinal += 1;
      candidates.push({
        candidateSlotId: `${assignment.assignmentId}-${arm}`,
        candidateOrdinal,
        assignmentId: assignment.assignmentId,
        assignmentOrdinal: assignment.assignmentOrdinal,
        arm,
        family: assignment.family,
        modality: assignment.modality,
        difficulty: assignment.difficulty,
        slotKind: "designer",
        lane: null,
        assignmentSeed: assignment.assignmentSeed,
      });
    }
  }
  return candidates;
}

function computeDesignerQuotas(
  assignments: readonly DesignerAssignment[],
  candidates: readonly DesignerCandidateSlot[],
): DesignerQuotas {
  const textAssignments = assignments.filter(
    (assignment) => assignment.modality === "text",
  ).length;
  const textCandidates = candidates.filter(
    (candidate) => candidate.modality === "text",
  ).length;
  const assignmentsPerFamily = assignments.length / FAMILIES.length;
  return {
    totalAssignments: assignments.length,
    textAssignments,
    svgAssignments: assignments.length - textAssignments,
    assignmentsPerFamily,
    totalCandidates: candidates.length,
    baselineCandidates: candidates.filter(
      (candidate) => candidate.arm === "baseline",
    ).length,
    oneShotCandidates: candidates.filter(
      (candidate) => candidate.arm === "ai_one_shot",
    ).length,
    feedbackCandidates: candidates.filter(
      (candidate) => candidate.arm === "ai_feedback",
    ).length,
    textCandidates,
    svgCandidates: candidates.length - textCandidates,
    candidatesPerFamily: candidates.length / FAMILIES.length,
  };
}

function computeDesignerDifficultyCounts(
  candidates: readonly DesignerCandidateSlot[],
): DesignerDifficultyCount[] {
  const counts: DesignerDifficultyCount[] = [];
  for (const family of FAMILIES) {
    for (const arm of DESIGNER_ARMS) {
      for (const difficulty of DIFFICULTIES) {
        counts.push({
          family,
          arm,
          difficulty,
          count: candidates.filter(
            (candidate) =>
              candidate.family === family &&
              candidate.arm === arm &&
              candidate.difficulty === difficulty,
          ).length,
        });
      }
    }
  }
  return counts;
}

function computeDesignerRequestEstimate(
  runKind: DesignerRunKind,
  assignmentCount: number,
): DesignerRequestEstimate {
  const design = assignmentCount * 2;
  const repairs = assignmentCount;
  const totalContentLogicalCalls = design + repairs * 2;
  const probeLogicalCalls = runKind === "design_pilot" ? 2 : 0;
  const totalLogicalCalls = totalContentLogicalCalls + probeLogicalCalls;
  return {
    byRole: {
      design,
      design_repair_1: repairs,
      design_repair_2: repairs,
    },
    totalContentLogicalCalls,
    probeLogicalCalls,
    totalLogicalCalls,
    baselineAiCalls: 0,
    maxTransportAttempts:
      totalLogicalCalls * MAX_TRANSPORT_ATTEMPTS_PER_CALL,
  };
}

export function buildDesignerPlanManifest(
  options: BuildDesignerPlanOptions,
): DesignerPlanManifest {
  const fixedSeed = DESIGNER_ROOT_SEEDS[options.runKind];
  const rootSeed = options.rootSeed ?? fixedSeed;
  if (rootSeed !== fixedSeed) {
    throw new Error(
      `root seed for ${options.runKind} plans is fixed to ${fixedSeed}; received ${rootSeed}`,
    );
  }
  const assignments = buildDesignerAssignments(options.runKind, rootSeed);
  const candidates = buildDesignerCandidates(assignments);
  const base = {
    protocolVersion: DESIGNER_PROTOCOL_VERSION,
    runKind: options.runKind,
    rootSeed,
    assignments,
    candidates,
    quotas: computeDesignerQuotas(assignments, candidates),
    difficultyCounts: computeDesignerDifficultyCounts(candidates),
    requestEstimate: computeDesignerRequestEstimate(
      options.runKind,
      assignments.length,
    ),
  };
  return DesignerPlanManifestSchema.parse({
    ...base,
    planHash: computeDesignerPlanHash(base),
  });
}

export function serializeDesignerPlanManifest(
  plan: DesignerPlanManifest,
): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
