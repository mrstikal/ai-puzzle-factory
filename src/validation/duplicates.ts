import { canonicalJson, sha256Hex } from "../util/hash.js";
import {
  DuplicateBarrierInputSchema,
  DuplicateBarrierResultSchema,
  type CandidateBarrierInput,
  type CandidateDuplicateAssessment,
  type CandidateFingerprint,
  type DuplicateBarrierInput,
  type DuplicateBarrierResult,
  type DuplicateKind,
  type DuplicateOutcome,
  type DuplicatePair,
  type DuplicatePairKind,
  type FailureCode,
  type FeatureComparison,
} from "../domain/candidate.js";
import { canonicalStructureSerialization } from "../families/canonicalize.js";
import { compareFeatureMultisets } from "../families/canonicalize.js";
import { assertFingerprintConsistency } from "./fingerprints.js";

export type DuplicateBarrierErrorCode =
  | "INCOMPLETE_PREPARATION"
  | "PLANNED_SLOT_MISMATCH"
  | "INVALID_FINGERPRINT"
  | "EMPTY_FEATURES"
  | "IDENTICAL_STRUCTURE_DIFFERENT_HASH"
  | "STRUCTURE_HASH_COLLISION";

export class DuplicateBarrierError extends Error {
  readonly code: DuplicateBarrierErrorCode;

  constructor(
    code: DuplicateBarrierErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DuplicateBarrierError";
    this.code = code;
  }
}

export interface NearPairEvaluation {
  readonly comparable: boolean;
  readonly near: boolean;
  readonly comparison: FeatureComparison | null;
  readonly reason: string;
}

function structureScopeKey(structure: CandidateFingerprint["canonicalStructure"]): string {
  if (structure === null) {
    return "";
  }
  return `${structure.family}\u0000${structure.queryKind}\u0000${structure.domainTokens.join("\u0000")}`;
}

export function evaluateNearPair(
  left: CandidateFingerprint,
  right: CandidateFingerprint,
): NearPairEvaluation {
  if (left.canonicalStructure === null || right.canonicalStructure === null) {
    return {
      comparable: false,
      near: false,
      comparison: null,
      reason: "both candidates need canonical structures",
    };
  }
  if (structureScopeKey(left.canonicalStructure) !== structureScopeKey(right.canonicalStructure)) {
    return {
      comparable: false,
      near: false,
      comparison: null,
      reason: "near comparison requires the same family, domain, and query kind",
    };
  }
  if (left.features.length === 0 || right.features.length === 0) {
    throw new DuplicateBarrierError(
      "EMPTY_FEATURES",
      "near comparison requires nonempty feature multisets",
    );
  }
  const comparison = compareFeatureMultisets(left.features, right.features);
  if (left.structureHash === right.structureHash) {
    return {
      comparable: true,
      near: false,
      comparison,
      reason: "identical structural fingerprint",
    };
  }
  if (
    canonicalStructureSerialization(left.canonicalStructure) ===
    canonicalStructureSerialization(right.canonicalStructure)
  ) {
    throw new DuplicateBarrierError(
      "IDENTICAL_STRUCTURE_DIFFERENT_HASH",
      "unequal structural hashes cannot describe identical complete canonical data",
    );
  }
  if (comparison.commonFeatureCount === 0) {
    return {
      comparable: true,
      near: false,
      comparison,
      reason: "no common structural feature",
    };
  }
  if (comparison.editDistance !== 1) {
    return {
      comparable: true,
      near: false,
      comparison,
      reason: `multiset edit distance is ${comparison.editDistance}, not one`,
    };
  }
  return {
    comparable: true,
    near: true,
    comparison,
    reason: "one feature edit with nonempty overlap",
  };
}

interface MutableAssessment {
  slotId: string;
  slotOrdinal: number;
  family: CandidateBarrierInput["family"];
  modality: CandidateBarrierInput["modality"];
  lane: CandidateBarrierInput["lane"];
  eligible: boolean;
  fingerprintable: boolean;
  groupOwner: boolean;
  outcome: DuplicateOutcome;
  ownerSlotId: string | null;
  duplicateKind: DuplicateKind | null;
  nearPairSlotIds: string[];
  failureCodes: FailureCode[];
  terminalVerdict: CandidateBarrierInput["terminalVerdict"];
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

function sortedByOrdinal<T extends { readonly slotOrdinal: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) => left.slotOrdinal - right.slotOrdinal);
}

function makePair(
  kind: DuplicatePairKind,
  left: CandidateBarrierInput,
  right: CandidateBarrierInput,
  options: {
    readonly family: CandidateBarrierInput["family"] | null;
    readonly eligible: boolean;
    readonly diagnostic: boolean;
    readonly comparison: FeatureComparison | null;
    readonly evidence: string;
  },
): DuplicatePair {
  const [first, second] =
    left.slotOrdinal < right.slotOrdinal ? [left, right] : [right, left];
  return {
    kind,
    leftSlotId: first.slotId,
    rightSlotId: second.slotId,
    leftSlotOrdinal: first.slotOrdinal,
    rightSlotOrdinal: second.slotOrdinal,
    family: options.family,
    eligible: options.eligible,
    diagnostic: options.diagnostic,
    comparison: options.comparison,
    evidence: options.evidence,
  };
}

function setDuplicate(
  assessment: MutableAssessment,
  owner: CandidateBarrierInput,
  duplicateKind: DuplicateKind,
  failureCode: FailureCode,
): void {
  assessment.outcome =
    duplicateKind === "exact_content"
      ? "exact_duplicate"
      : duplicateKind === "canonical_spec"
        ? "spec_duplicate"
        : "structural_duplicate";
  assessment.ownerSlotId = owner.slotId;
  assessment.duplicateKind = duplicateKind;
  assessment.nearPairSlotIds = [];
  assessment.failureCodes = [failureCode];
}

function setNear(assessment: MutableAssessment, otherSlotId: string): void {
  assessment.outcome = "near_suspected";
  assessment.ownerSlotId = null;
  assessment.duplicateKind = null;
  if (!assessment.nearPairSlotIds.includes(otherSlotId)) {
    assessment.nearPairSlotIds.push(otherSlotId);
    assessment.nearPairSlotIds.sort();
  }
  if (!assessment.failureCodes.includes("NEAR_DUPLICATE_SUSPECTED")) {
    assessment.failureCodes = ["NEAR_DUPLICATE_SUSPECTED"];
  }
}

function checkStructureGroupConsistency(group: readonly CandidateBarrierInput[]): void {
  const serializations = new Set(
    group.map((candidate) =>
      candidate.fingerprint?.canonicalStructure === null ||
      candidate.fingerprint?.canonicalStructure === undefined
        ? ""
        : canonicalStructureSerialization(candidate.fingerprint.canonicalStructure),
    ),
  );
  if (serializations.size > 1) {
    throw new DuplicateBarrierError(
      "STRUCTURE_HASH_COLLISION",
      "one structural hash maps to different complete canonical structures",
    );
  }
}

const PAIR_KIND_ORDER: Readonly<Record<DuplicatePairKind, number>> = {
  exact_content: 0,
  canonical_spec: 1,
  structural: 2,
  near: 3,
  visual_exact: 4,
};

function sortPairs(pairs: readonly DuplicatePair[]): DuplicatePair[] {
  return [...pairs].sort(
    (left, right) =>
      left.leftSlotOrdinal - right.leftSlotOrdinal ||
      left.rightSlotOrdinal - right.rightSlotOrdinal ||
      PAIR_KIND_ORDER[left.kind] - PAIR_KIND_ORDER[right.kind],
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function runDuplicateBarrier(input: unknown): DuplicateBarrierResult {
  const parsed: DuplicateBarrierInput = DuplicateBarrierInputSchema.parse(input);
  const candidateById = new Map(
    parsed.candidates.map((candidate) => [candidate.slotId, candidate]),
  );
  const missing = parsed.plannedSlots.filter((slot) => !candidateById.has(slot.slotId));
  if (missing.length > 0) {
    throw new DuplicateBarrierError(
      "INCOMPLETE_PREPARATION",
      `duplicate barrier requires every planned slot, missing ${missing
        .map((slot) => slot.slotId)
        .join(", ")}`,
    );
  }
  const incomplete = parsed.candidates.filter(
    (candidate) => candidate.preparationStatus === "incomplete",
  );
  if (incomplete.length > 0) {
    throw new DuplicateBarrierError(
      "INCOMPLETE_PREPARATION",
      `duplicate barrier refuses budget-paused or unfinished slots: ${incomplete
        .map((candidate) => candidate.slotId)
        .join(", ")}`,
    );
  }

  const candidates = sortedByOrdinal(parsed.candidates);
  for (const candidate of candidates) {
    if (candidate.fingerprint !== null) {
      if (
        candidate.formalPassed &&
        candidate.fingerprint.canonicalStructure === null
      ) {
        throw new DuplicateBarrierError(
          "INVALID_FINGERPRINT",
          `formal-passed candidate ${candidate.slotId} requires a canonical structure`,
        );
      }
      try {
        assertFingerprintConsistency(candidate.fingerprint);
      } catch (error) {
        throw new DuplicateBarrierError(
          "INVALID_FINGERPRINT",
          `candidate ${candidate.slotId} has an inconsistent fingerprint`,
          { cause: error },
        );
      }
    }
  }

  const assessments = new Map<string, MutableAssessment>();
  for (const candidate of candidates) {
    const eligible = candidate.preparationStatus === "ready";
    assessments.set(candidate.slotId, {
      slotId: candidate.slotId,
      slotOrdinal: candidate.slotOrdinal,
      family: candidate.family,
      modality: candidate.modality,
      lane: candidate.lane,
      eligible,
      fingerprintable:
        candidate.formalPassed &&
        candidate.fingerprint !== null &&
        candidate.fingerprint.canonicalStructure !== null,
      groupOwner: false,
      outcome: eligible ? "unique" : "ineligible",
      ownerSlotId: null,
      duplicateKind: null,
      nearPairSlotIds: [],
      failureCodes: [],
      terminalVerdict: candidate.terminalVerdict,
    });
  }
  const eligible = candidates.filter((candidate) => candidate.preparationStatus === "ready");
  const fingerprintable = candidates.filter(
    (candidate) =>
      candidate.formalPassed &&
      candidate.fingerprint !== null &&
      candidate.fingerprint.canonicalStructure !== null,
  );
  const surviving = new Set(eligible.map((candidate) => candidate.slotId));
  const pairs: DuplicatePair[] = [];

  const exactGroups = groupBy(
    eligible.filter(
      (candidate) =>
        candidate.fingerprint !== null && candidate.fingerprint.contentHash !== null,
    ),
    (candidate) => {
      const contentHash = candidate.fingerprint?.contentHash ?? "";
      if (candidate.modality === "svg") {
        return `${candidate.family}\u0000${contentHash}\u0000${candidate.fingerprint?.renderHashes.png ?? ""}`;
      }
      return `${candidate.family}\u0000${contentHash}`;
    },
  );
  let exactGroupCount = 0;
  for (const group of exactGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    exactGroupCount += 1;
    const ordered = sortedByOrdinal(group);
    const owner = ordered[0];
    if (owner === undefined) {
      continue;
    }
    const ownerAssessment = assessments.get(owner.slotId);
    if (ownerAssessment !== undefined) {
      ownerAssessment.groupOwner = true;
    }
    for (const duplicate of ordered.slice(1)) {
      const assessment = assessments.get(duplicate.slotId);
      if (assessment !== undefined) {
        setDuplicate(assessment, owner, "exact_content", "EXACT_DUPLICATE");
      }
      surviving.delete(duplicate.slotId);
      pairs.push(
        makePair("exact_content", owner, duplicate, {
          family: owner.family,
          eligible: true,
          diagnostic: false,
          comparison: null,
          evidence:
            owner.modality === "svg"
              ? "identical content hash and PNG render hash over the visible presentation"
              : "identical content hash over the visible presentation and options",
        }),
      );
    }
  }

  const specGroups = groupBy(
    eligible.filter(
      (candidate) =>
        surviving.has(candidate.slotId) &&
        candidate.fingerprint !== null &&
        candidate.fingerprint.specHash !== null,
    ),
    (candidate) =>
      `${candidate.family}\u0000${candidate.fingerprint?.specHash ?? ""}`,
  );
  let specGroupCount = 0;
  for (const group of specGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    specGroupCount += 1;
    const ordered = sortedByOrdinal(group);
    const owner = ordered[0];
    if (owner === undefined) {
      continue;
    }
    const ownerAssessment = assessments.get(owner.slotId);
    if (ownerAssessment !== undefined) {
      ownerAssessment.groupOwner = true;
    }
    for (const duplicate of ordered.slice(1)) {
      const assessment = assessments.get(duplicate.slotId);
      if (assessment !== undefined) {
        setDuplicate(assessment, owner, "canonical_spec", "EXACT_DUPLICATE");
      }
      surviving.delete(duplicate.slotId);
      pairs.push(
        makePair("canonical_spec", owner, duplicate, {
          family: owner.family,
          eligible: true,
          diagnostic: false,
          comparison: null,
          evidence: "identical canonical spec hash over the complete parsed DSL",
        }),
      );
    }
  }

  const structuralGroups = groupBy(
    eligible.filter(
      (candidate) =>
        surviving.has(candidate.slotId) &&
        candidate.fingerprint !== null &&
        candidate.fingerprint.structureHash !== null,
    ),
    (candidate) =>
      `${candidate.family}\u0000${candidate.fingerprint?.structureHash ?? ""}`,
  );
  let structuralGroupCount = 0;
  for (const group of structuralGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    structuralGroupCount += 1;
    checkStructureGroupConsistency(group);
    const ordered = sortedByOrdinal(group);
    const owner = ordered[0];
    if (owner === undefined) {
      continue;
    }
    const ownerAssessment = assessments.get(owner.slotId);
    if (ownerAssessment !== undefined) {
      ownerAssessment.groupOwner = true;
    }
    for (const duplicate of ordered.slice(1)) {
      const assessment = assessments.get(duplicate.slotId);
      if (assessment !== undefined) {
        setDuplicate(assessment, owner, "structural", "STRUCTURAL_DUPLICATE");
      }
      surviving.delete(duplicate.slotId);
      pairs.push(
        makePair("structural", owner, duplicate, {
          family: owner.family,
          eligible: true,
          diagnostic: false,
          comparison: null,
          evidence: "identical reduced structural fingerprint",
        }),
      );
    }
  }

  const survivors = sortedByOrdinal(
    eligible.filter((candidate) => surviving.has(candidate.slotId)),
  );
  let nearPairCount = 0;
  for (let leftIndex = 0; leftIndex < survivors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < survivors.length; rightIndex += 1) {
      const left = survivors[leftIndex];
      const right = survivors[rightIndex];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (left.fingerprint === null || right.fingerprint === null) {
        continue;
      }
      const evaluation = evaluateNearPair(left.fingerprint, right.fingerprint);
      if (!evaluation.near || evaluation.comparison === null) {
        continue;
      }
      nearPairCount += 1;
      const leftAssessment = assessments.get(left.slotId);
      const rightAssessment = assessments.get(right.slotId);
      if (leftAssessment !== undefined) {
        setNear(leftAssessment, right.slotId);
      }
      if (rightAssessment !== undefined) {
        setNear(rightAssessment, left.slotId);
      }
      pairs.push(
        makePair("near", left, right, {
          family: left.family,
          eligible: true,
          diagnostic: false,
          comparison: evaluation.comparison,
          evidence: evaluation.reason,
        }),
      );
    }
  }
  for (const candidate of survivors) {
    const assessment = assessments.get(candidate.slotId);
    if (assessment === undefined || assessment.outcome === "near_suspected") {
      continue;
    }
    assessment.outcome = assessment.groupOwner ? "owner" : "unique";
  }

  const diagnosticPairs: DuplicatePair[] = [];
  const allSpecGroups = groupBy(
    fingerprintable.filter(
      (candidate) =>
        candidate.fingerprint !== null && candidate.fingerprint.specHash !== null,
    ),
    (candidate) =>
      `${candidate.family}\u0000${candidate.fingerprint?.specHash ?? ""}`,
  );
  for (const group of allSpecGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    const ordered = sortedByOrdinal(group);
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const first = ordered[leftIndex];
        const other = ordered[rightIndex];
        if (first === undefined || other === undefined) {
          continue;
        }
        if (first.preparationStatus === "ready" && other.preparationStatus === "ready") {
          continue;
        }
        diagnosticPairs.push(
          makePair("canonical_spec", first, other, {
            family: first.family,
            eligible: false,
            diagnostic: true,
            comparison: null,
            evidence: "diagnostic canonical spec match involving an early failure",
          }),
        );
      }
    }
  }
  const allStructuralGroups = groupBy(
    fingerprintable.filter(
      (candidate) =>
        candidate.fingerprint !== null && candidate.fingerprint.structureHash !== null,
    ),
    (candidate) =>
      `${candidate.family}\u0000${candidate.fingerprint?.structureHash ?? ""}`,
  );
  for (const group of allStructuralGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    checkStructureGroupConsistency(group);
    const ordered = sortedByOrdinal(group);
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const first = ordered[leftIndex];
        const other = ordered[rightIndex];
        if (first === undefined || other === undefined) {
          continue;
        }
        if (first.preparationStatus === "ready" && other.preparationStatus === "ready") {
          continue;
        }
        diagnosticPairs.push(
          makePair("structural", first, other, {
            family: first.family,
            eligible: false,
            diagnostic: true,
            comparison: null,
            evidence: "diagnostic structural match involving an early failure",
          }),
        );
      }
    }
  }
  for (let leftIndex = 0; leftIndex < fingerprintable.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < fingerprintable.length;
      rightIndex += 1
    ) {
      const left = fingerprintable[leftIndex];
      const right = fingerprintable[rightIndex];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (left.fingerprint === null || right.fingerprint === null) {
        continue;
      }
      if (left.preparationStatus === "ready" && right.preparationStatus === "ready") {
        continue;
      }
      const evaluation = evaluateNearPair(left.fingerprint, right.fingerprint);
      if (!evaluation.near || evaluation.comparison === null) {
        continue;
      }
      diagnosticPairs.push(
        makePair("near", left, right, {
          family: left.family,
          eligible: false,
          diagnostic: true,
          comparison: evaluation.comparison,
          evidence: "diagnostic near pair involving an early failure",
        }),
      );
    }
  }

  const visualGroups = groupBy(
    fingerprintable.filter(
      (candidate) =>
        candidate.modality === "svg" &&
        candidate.fingerprint !== null &&
        candidate.fingerprint.renderHashes.png !== null,
    ),
    (candidate) => candidate.fingerprint?.renderHashes.png ?? "",
  );
  let visualExactDiagnosticPairs = 0;
  for (const group of visualGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    const ordered = sortedByOrdinal(group);
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const first = ordered[leftIndex];
        const other = ordered[rightIndex];
        if (first === undefined || other === undefined) {
          continue;
        }
        if (first.family === other.family) {
          continue;
        }
        visualExactDiagnosticPairs += 1;
        diagnosticPairs.push(
          makePair("visual_exact", first, other, {
            family: null,
            eligible:
              first.preparationStatus === "ready" &&
              other.preparationStatus === "ready",
            diagnostic: true,
            comparison: null,
            evidence: "identical PNG hash across visual families (diagnostic only)",
          }),
        );
      }
    }
  }

  const allPairs = sortPairs([...pairs, ...diagnosticPairs]);
  const sortedAssessments: CandidateDuplicateAssessment[] = sortedByOrdinal(
    [...assessments.values()],
  ).map((assessment) => {
    const fingerprint = candidateById.get(assessment.slotId)?.fingerprint ?? null;
    return {
    slotId: assessment.slotId,
    slotOrdinal: assessment.slotOrdinal,
    family: assessment.family,
    modality: assessment.modality,
    lane: assessment.lane,
    eligible: assessment.eligible,
    fingerprintable: assessment.fingerprintable,
    groupOwner: assessment.groupOwner,
    outcome: assessment.outcome,
    ownerSlotId: assessment.ownerSlotId,
    duplicateKind: assessment.duplicateKind,
    nearPairSlotIds: assessment.nearPairSlotIds,
    failureCodes: assessment.failureCodes,
    terminalVerdict: assessment.terminalVerdict,
    specHash: fingerprint?.specHash ?? null,
    structureHash: fingerprint?.structureHash ?? null,
    contentHash: fingerprint?.contentHash ?? null,
    renderHashes: fingerprint?.renderHashes ?? { svg: null, png: null },
    canonicalStructure: fingerprint?.canonicalStructure ?? null,
    features: fingerprint?.features ?? [],
    };
  });
  const base: Omit<DuplicateBarrierResult, "resultHash"> = {
    version: 1,
    assessments: sortedAssessments,
    pairs: allPairs,
    summary: {
      plannedSlots: parsed.plannedSlots.length,
      preparedSlots: candidates.length,
      readyCandidates: candidates.filter(
        (candidate) => candidate.preparationStatus === "ready",
      ).length,
      earlyFailures: candidates.filter(
        (candidate) => candidate.preparationStatus === "early_failure",
      ).length,
      eligibleCandidates: eligible.length,
      fingerprintableCandidates: fingerprintable.length,
      ineligibleCandidates: candidates.length - eligible.length,
      owners: sortedAssessments.filter((assessment) => assessment.groupOwner).length,
      uniqueCandidates: sortedAssessments.filter(
        (assessment) => assessment.outcome === "unique",
      ).length,
      exactGroups: exactGroupCount,
      specGroups: specGroupCount,
      structuralGroups: structuralGroupCount,
      exactDuplicates: sortedAssessments.filter(
        (assessment) => assessment.outcome === "exact_duplicate",
      ).length,
      specDuplicates: sortedAssessments.filter(
        (assessment) => assessment.outcome === "spec_duplicate",
      ).length,
      structuralDuplicates: sortedAssessments.filter(
        (assessment) => assessment.outcome === "structural_duplicate",
      ).length,
      nearPairs: nearPairCount,
      nearSuspectedCandidates: sortedAssessments.filter(
        (assessment) => assessment.outcome === "near_suspected",
      ).length,
      diagnosticPairs: allPairs.filter((pair) => pair.diagnostic).length,
      visualExactDiagnosticPairs,
      replacements: 0,
      terminalFailuresRewritten: 0,
    },
  };
  const result = DuplicateBarrierResultSchema.parse({
    ...base,
    resultHash: sha256Hex(canonicalJson(base)),
  });
  return deepFreeze(result);
}
