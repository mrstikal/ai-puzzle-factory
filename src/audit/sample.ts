import { FailureRecordSchema, type FailureRecord } from "../domain/candidate.js";
import {
  FAMILIES,
  LANES,
  type Difficulty,
  type Family,
  type Lane,
  type Modality,
} from "../domain/experiment.js";
import type { CandidateExportRow } from "../reporting/export.js";
import type { RunRecord } from "../storage/repository.js";
import { hashCanonicalJson, sha256Hex } from "../util/hash.js";

export const AUDIT_CORE_TARGET = 40;
export const AUDIT_MAX_TOTAL = 44;
export const AUDIT_MAJOR_VERDICTS = [
  "approved",
  "rejected",
  "inconclusive",
  "generation_error",
] as const;
export type AuditMajorVerdict = (typeof AUDIT_MAJOR_VERDICTS)[number];

export interface AuditSampleEntry {
  readonly slotId: string;
  readonly slotOrdinal: number;
  readonly family: Family;
  readonly lane: Lane;
  readonly modality: Modality;
  readonly difficulty: Difficulty;
  readonly stage: string;
  readonly presentationAvailable: boolean;
  readonly inspectable: boolean;
  readonly slotHash: string;
}

export interface AuditShortfall {
  readonly kind: "FAMILY_APPROVALS" | "LANE_TERMINAL" | "ONE_LANE_APPROVALS";
  readonly family: Family;
  readonly lane: Lane | null;
  readonly required: number;
  readonly available: number;
}

export interface AuditDenominators {
  readonly total: {
    readonly sampled: number;
    readonly inspectable: number;
  };
  readonly approved: {
    readonly sampled: number;
    readonly inspectable: number;
  };
}

export interface AuditSampleManifest {
  readonly version: 1;
  readonly runId: string;
  readonly runKind: string;
  readonly rootSeed: string;
  readonly manifestHash: string;
  readonly evidenceKind: string;
  readonly controlState: string;
  readonly production: boolean;
  readonly preview: boolean;
  readonly coreTarget: number;
  readonly core: readonly AuditSampleEntry[];
  readonly categoryAdditions: readonly AuditSampleEntry[];
  readonly shortfalls: readonly AuditShortfall[];
  readonly familyApprovalLanes: Readonly<
    Record<string, { readonly spec_first: number; readonly ai_spec: number }>
  >;
  readonly categories: {
    readonly available: readonly AuditMajorVerdict[];
    readonly core: readonly AuditMajorVerdict[];
    readonly additions: readonly AuditMajorVerdict[];
  };
  readonly denominators: AuditDenominators;
  readonly sampleHash: string;
}

export class AuditSampleError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "AuditSampleError";
  }
}

interface InternalCandidate {
  readonly row: CandidateExportRow;
  readonly slotHash: string;
  readonly sortKey: string;
  readonly presentationAvailable: boolean;
  readonly inspectable: boolean;
  readonly reviewConcern: boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function failuresOf(row: CandidateExportRow): FailureRecord[] {
  const parsed = FailureRecordSchema.array().safeParse(row.failures);
  return parsed.success ? parsed.data : [];
}

function hasReviewConcern(row: CandidateExportRow): boolean {
  const blind = objectValue(row.blindReview);
  const alignment = objectValue(row.alignmentReview);
  const codes = new Set(failuresOf(row).map((failure) => failure.code));
  return (
    blind.choiceAgreement === "disagreed" ||
    alignment.derivedOverall === "fail" ||
    codes.has("REVIEWER_DISAGREES") ||
    codes.has("REVIEWER_CANNOT_SOLVE") ||
    codes.has("VISION_REVIEW_UNCERTAIN")
  );
}

function slotHashFor(row: CandidateExportRow): string {
  return hashCanonicalJson({
    slotId: row.slotId,
    verdict: row.verdict,
    stage: row.stage,
    presentation: row.presentation,
    assets: row.assets,
    failures: row.failures,
  });
}

function toInternal(
  row: CandidateExportRow,
  hashFn: (seed: string, slotId: string) => string,
  rootSeed: string,
): InternalCandidate {
  const presentationAvailable = row.presentation !== null;
  return {
    row,
    slotHash: slotHashFor(row),
    sortKey: `${hashFn(rootSeed, row.slotId)}:${row.slotId}`,
    presentationAvailable,
    inspectable:
      presentationAvailable && (row.modality === "text" || row.assets.png),
    reviewConcern: hasReviewConcern(row),
  };
}

function entry(candidate: InternalCandidate): AuditSampleEntry {
  const row = candidate.row;
  return {
    slotId: row.slotId,
    slotOrdinal: row.slotOrdinal,
    family: row.family as Family,
    lane: row.lane as Lane,
    modality: row.modality as Modality,
    difficulty: row.difficulty as Difficulty,
    stage: row.stage,
    presentationAvailable: candidate.presentationAvailable,
    inspectable: candidate.inspectable,
    slotHash: candidate.slotHash,
  };
}

function byHash(candidates: readonly InternalCandidate[]): InternalCandidate[] {
  return [...candidates].sort((left, right) =>
    left.sortKey.localeCompare(right.sortKey),
  );
}

function denominators(
  entries: readonly AuditSampleEntry[],
  verdictBySlot: ReadonlyMap<string, string>,
): AuditDenominators {
  const approved = entries.filter(
    (item) => verdictBySlot.get(item.slotId) === "approved",
  );
  return {
    total: {
      sampled: entries.length,
      inspectable: entries.filter((item) => item.inspectable).length,
    },
    approved: {
      sampled: approved.length,
      inspectable: approved.filter((item) => item.inspectable).length,
    },
  };
}

function uniqueShortfalls(shortfalls: readonly AuditShortfall[]): AuditShortfall[] {
  const seen = new Set<string>();
  return shortfalls.filter((shortfall) => {
    const key = `${shortfall.kind}:${shortfall.family}:${shortfall.lane ?? ""}:${shortfall.required}:${shortfall.available}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function availableCategories(
  candidates: readonly InternalCandidate[],
): AuditMajorVerdict[] {
  const verdicts = new Set(candidates.map((candidate) => candidate.row.verdict));
  return AUDIT_MAJOR_VERDICTS.filter((verdict) => verdicts.has(verdict));
}

function familyApprovalLanes(
  candidates: readonly InternalCandidate[],
): Record<string, { spec_first: number; ai_spec: number }> {
  const result: Record<string, { spec_first: number; ai_spec: number }> = {};
  for (const family of FAMILIES) {
    result[family] = { spec_first: 0, ai_spec: 0 };
  }
  for (const candidate of candidates) {
    if (candidate.row.verdict === "approved") {
      result[candidate.row.family]![candidate.row.lane as Lane] += 1;
    }
  }
  return result;
}

function selectPreview(
  run: RunRecord,
  candidates: readonly InternalCandidate[],
): AuditSampleManifest {
  const terminal = candidates.filter((candidate) => candidate.row.terminal);
  const verdictBySlot = new Map(
    terminal.map((candidate) => [
      candidate.row.slotId,
      candidate.row.verdict as string,
    ]),
  );
  const entries = byHash(terminal).map((candidate) => entry(candidate));
  const manifestWithoutHash = {
    version: 1 as const,
    runId: run.runId,
    runKind: run.runKind,
    rootSeed: run.rootSeed,
    manifestHash: run.manifestHash,
    evidenceKind: run.evidenceKind,
    controlState: run.controlState,
    production: false,
    preview: true,
    coreTarget: 0,
    core: entries,
    categoryAdditions: [],
    shortfalls: [],
    familyApprovalLanes: familyApprovalLanes(terminal),
    categories: {
      available: availableCategories(terminal),
      core: [
        ...new Set(
          terminal
            .map((item) => item.row.verdict)
            .filter((verdict): verdict is AuditMajorVerdict => verdict !== null),
        ),
      ],
      additions: [],
    },
    denominators: denominators(entries, verdictBySlot),
  };
  return {
    ...manifestWithoutHash,
    sampleHash: hashCanonicalJson(manifestWithoutHash),
  };
}

export interface SelectAuditSampleInput {
  readonly run: RunRecord;
  readonly candidates: readonly CandidateExportRow[];
  readonly mode?: "production" | "preview";
  readonly hashFn?: (rootSeed: string, slotId: string) => string;
}

export function selectAuditSample(
  input: SelectAuditSampleInput,
): AuditSampleManifest {
  const mode =
    input.mode ?? (input.run.runKind === "full" ? "production" : "preview");
  if (mode === "production" && input.run.runKind !== "full") {
    throw new AuditSampleError(
      "SMOKE_PRODUCTION_AUDIT",
      "a smoke run can only produce a labeled audit preview, not a production audit",
    );
  }
  if (mode === "production" && input.run.controlState !== "completed") {
    throw new AuditSampleError(
      "RUN_NOT_COMPLETED",
      `a production audit requires a completed run, received ${input.run.controlState}`,
    );
  }
  const hashFn =
    input.hashFn ?? ((seed, slotId) => sha256Hex(`${seed}:${slotId}`));
  const internal = input.candidates.map((candidate) =>
    toInternal(candidate, hashFn, input.run.rootSeed),
  );
  if (mode === "preview") {
    return selectPreview(input.run, internal);
  }
  const terminal = internal.filter((candidate) => candidate.row.terminal);
  const verdictBySlot = new Map(
    terminal.map((candidate) => [
      candidate.row.slotId,
      candidate.row.verdict as string,
    ]),
  );
  const internalBySlot = new Map(
    terminal.map((candidate) => [candidate.row.slotId, candidate]),
  );
  const selected = new Map<string, AuditSampleEntry>();
  const shortfalls: AuditShortfall[] = [];
  const add = (candidate: InternalCandidate) => {
    if (!selected.has(candidate.row.slotId)) {
      selected.set(candidate.row.slotId, entry(candidate));
    }
  };
  const approvals = familyApprovalLanes(terminal);

  for (const family of FAMILIES) {
    const familyCandidates = terminal.filter(
      (candidate) => candidate.row.family === family,
    );
    const familyApproved = familyCandidates.filter(
      (candidate) => candidate.row.verdict === "approved",
    );
    const approvedByLane = Object.fromEntries(
      LANES.map((lane) => [
        lane,
        byHash(
          familyApproved.filter((candidate) => candidate.row.lane === lane),
        ),
      ]),
    ) as Record<Lane, InternalCandidate[]>;
    const approvingLanes = LANES.filter(
      (lane) => approvedByLane[lane].length > 0,
    );
    if (approvingLanes.length === 2) {
      for (const lane of LANES) {
        const candidate = approvedByLane[lane][0];
        if (candidate !== undefined) {
          add(candidate);
        }
      }
    } else if (approvingLanes.length === 1) {
      const lane = approvingLanes[0] as Lane;
      for (const candidate of approvedByLane[lane].slice(0, 2)) {
        add(candidate);
      }
      shortfalls.push({
        kind: "ONE_LANE_APPROVALS",
        family,
        lane: LANES.find((candidate) => candidate !== lane) ?? null,
        required: 1,
        available: 0,
      });
    }
    if (familyApproved.length < 2) {
      shortfalls.push({
        kind: "FAMILY_APPROVALS",
        family,
        lane: null,
        required: 2,
        available: familyApproved.length,
      });
    }
    for (const lane of LANES) {
      const cell = familyCandidates.filter(
        (candidate) => candidate.row.lane === lane,
      );
      if (cell.length < 2) {
        shortfalls.push({
          kind: "LANE_TERMINAL",
          family,
          lane,
          required: 2,
          available: cell.length,
        });
      }
      let capacity =
        2 -
        [...selected.values()].filter(
          (item) => item.family === family && item.lane === lane,
        ).length;
      if (capacity <= 0) {
        continue;
      }
      const buckets: InternalCandidate[][] = [
        cell.filter(
          (candidate) =>
            candidate.reviewConcern && !selected.has(candidate.row.slotId),
        ),
        cell.filter(
          (candidate) =>
            candidate.row.verdict !== "approved" &&
            candidate.presentationAvailable &&
            !candidate.reviewConcern &&
            !selected.has(candidate.row.slotId),
        ),
        cell.filter(
          (candidate) =>
            candidate.row.verdict === "approved" &&
            !selected.has(candidate.row.slotId),
        ),
        cell.filter(
          (candidate) =>
            !candidate.presentationAvailable &&
            !selected.has(candidate.row.slotId),
        ),
      ];
      for (const bucket of buckets) {
        for (const candidate of byHash(bucket)) {
          if (capacity <= 0) {
            break;
          }
          add(candidate);
          capacity -= 1;
        }
      }
    }
  }

  const core = [...selected.values()];
  const coreCategories = [
    ...new Set(
      core.map(
        (item) => internalBySlot.get(item.slotId)?.row.verdict as AuditMajorVerdict,
      ),
    ),
  ];
  const categoryAdditions: AuditSampleEntry[] = [];
  const additions: AuditMajorVerdict[] = [];
  const categories = availableCategories(terminal);
  for (const category of categories) {
    if (coreCategories.includes(category)) {
      continue;
    }
    const candidate = byHash(
      terminal.filter(
        (item) =>
          item.row.verdict === category && !selected.has(item.row.slotId),
      ),
    )[0];
    if (candidate !== undefined && categoryAdditions.length < 4) {
      const selectedEntry = entry(candidate);
      categoryAdditions.push(selectedEntry);
      additions.push(category);
      selected.set(candidate.row.slotId, selectedEntry);
    }
  }
  const allEntries = [...core, ...categoryAdditions];
  const manifestWithoutHash = {
    version: 1 as const,
    runId: input.run.runId,
    runKind: input.run.runKind,
    rootSeed: input.run.rootSeed,
    manifestHash: input.run.manifestHash,
    evidenceKind: input.run.evidenceKind,
    controlState: input.run.controlState,
    production: true,
    preview: false,
    coreTarget: AUDIT_CORE_TARGET,
    core,
    categoryAdditions,
    shortfalls: uniqueShortfalls(shortfalls),
    familyApprovalLanes: approvals,
    categories: {
      available: categories,
      core: coreCategories,
      additions,
    },
    denominators: denominators(allEntries, verdictBySlot),
  };
  return {
    ...manifestWithoutHash,
    sampleHash: hashCanonicalJson(manifestWithoutHash),
  };
}

export function auditSampleEntries(
  manifest: AuditSampleManifest,
): readonly AuditSampleEntry[] {
  return [...manifest.core, ...manifest.categoryAdditions];
}
