import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, migrate } from "../../src/storage/database.js";
import { createDesignerRun } from "../../src/storage/repository.js";
import {
  buildDesignEvaluationSample,
  renderDesignEvaluationSolveGallery,
  type DesignSampleCandidate,
} from "../../src/audit/design-sample.js";
import {
  DESIGN_EVALUATION_LABEL_HEADER,
  type DESIGN_EVALUATION_SOLVE_TIMES,
  buildDesignEvaluationLabelsCsv,
  computeDesignEvaluationLabelContentHash,
  importDesignEvaluationRows,
  loadDesignEvaluationSummary,
  parseDesignEvaluationLabelsCsv,
  storeDesignEvaluationSample,
} from "../../src/audit/design-labels.js";
import { buildDesignerPlanManifest } from "../../src/design/assignments.js";
import { buildBaselineOutcome } from "../../src/design/baseline.js";
import { productionRegistry } from "../../src/families/registry.js";
import { buildDesignView } from "../../src/presentation/design-view.js";
import type { DesignerArm, DesignerAssignment } from "../../src/domain/design.js";

const PLAN = buildDesignerPlanManifest({ runKind: "design_primary" });
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_SEED = PLAN.rootSeed;
const PROTOCOL_VERSION = PLAN.protocolVersion;

function familyAssignments(family: string): DesignerAssignment[] {
  return PLAN.assignments.filter((entry) => entry.family === family);
}

function assignment(family: string, index = 0): DesignerAssignment {
  const found = familyAssignments(family)[index];
  if (found === undefined) {
    throw new Error(`missing ${family} assignment index ${index}`);
  }
  return found;
}

function candidate(input: {
  readonly assignment: DesignerAssignment;
  readonly arm: DesignerArm;
  readonly attemptCount?: number;
  readonly finalNovelty?: DesignSampleCandidate["finalNovelty"];
}): DesignSampleCandidate {
  const slotId = `${input.assignment.assignmentId}-${input.arm}`;
  const outcome = buildBaselineOutcome({
    source: "cohort",
    sourceIndex: input.assignment.assignmentOrdinal,
    assignmentId: input.assignment.assignmentId,
    family: input.assignment.family,
    difficulty: input.assignment.difficulty,
    seed: input.assignment.assignmentSeed,
  });
  if (outcome.status !== "constructed" || outcome.spec === null) {
    throw new Error(`baseline construction failed for ${slotId}`);
  }
  const engine = productionRegistry.getEngine(input.assignment.family);
  const spec = engine.schema.parse(outcome.spec) as never;
  const solve = engine.enumerateSolutions(spec);
  if (solve.correctAnswer === null) {
    throw new Error(`missing answer for ${slotId}`);
  }
  const choices = engine.makeOptions(
    spec,
    solve.correctAnswer,
    input.assignment.assignmentSeed,
  );
  const built = buildDesignView({
    viewId: slotId,
    engine,
    spec,
    solveResult: solve as never,
    choices: choices as never,
    difficulty: input.assignment.difficulty,
    skin: null,
    ...(engine.modality === "svg"
      ? { choicesSeed: input.assignment.assignmentSeed }
      : {}),
  });
  return {
    slotId,
    assignmentId: input.assignment.assignmentId,
    assignmentOrdinal: input.assignment.assignmentOrdinal,
    arm: input.arm,
    family: input.assignment.family,
    difficulty: input.assignment.difficulty,
    finalVerdict: "accepted",
    attemptCount: input.attemptCount ?? 1,
    finalNovelty: input.finalNovelty ?? "novel",
    view: built.view,
    svg: built.svg,
    certificateHash: built.view.certificate.certificateHash,
  };
}

function sample(candidates: DesignSampleCandidate[], options: {
  readonly maxTriplets?: number;
  readonly maxAdditions?: number;
  readonly maxCandidates?: number;
} = {}) {
  return buildDesignEvaluationSample({
    runId: RUN_ID,
    planHash: PLAN.planHash,
    protocolVersion: PROTOCOL_VERSION,
    rootSeed: ROOT_SEED,
    createdAt: "2026-01-01T00:00:00.000Z",
    candidates,
    ...options,
  });
}

describe("P50.3 blinded sampler", () => {
  it("builds an assignment-matched complete triplet and keeps metadata out of the public bundle", () => {
    const ranking = assignment("ranking", 1);
    const candidates = (["baseline", "ai_one_shot", "ai_feedback"] as const).map(
      (arm) => candidate({ assignment: ranking, arm }),
    );
    const result = sample(candidates);
    expect(result.publicBundle.triplets).toHaveLength(1);
    expect(result.publicBundle.triplets[0]?.memberIds).toHaveLength(3);
    expect(result.privateBundle.triplets[0]).toMatchObject({
      family: "ranking",
      kind: "assignment_matched",
      absentArms: [],
    });
    expect(result.selection.assignmentMatchedTriplets).toBe(1);
    expect(result.selection.missingFamilies).toHaveLength(9);

    const publicJson = JSON.stringify(result.publicBundle);
    const html = renderDesignEvaluationSolveGallery(result);
    for (const forbidden of [
      "ai_feedback",
      "ai_one_shot",
      "baseline",
      "repair",
      "novel",
      "design-text-ranking-01",
      "assignmentId",
      "slotId",
    ]) {
      expect(publicJson).not.toContain(forbidden);
      expect(html).not.toContain(forbidden);
    }
    expect(publicJson).not.toContain("shortfall");
    expect(publicJson).not.toContain("reason");
  });

  it("falls back to a family/difficulty-matched triplet and records absent arms", () => {
    const matching = assignment("matching");
    const candidates = [
      candidate({ assignment: matching, arm: "baseline" }),
      candidate({ assignment: matching, arm: "ai_one_shot" }),
    ];
    const result = sample(candidates);
    expect(result.publicBundle.triplets).toHaveLength(1);
    expect(result.privateBundle.triplets[0]).toMatchObject({
      family: "matching",
      kind: "family_difficulty_matched",
      absentArms: ["ai_feedback"],
    });
    expect(result.selection.fallbackTriplets).toBe(1);
    expect(result.selection.absentArms["triplet-01"]).toEqual([
      "ai_feedback",
    ]);
    expect(result.selection.shortfalls).toContain(
      "triplet_absent_arms:triplet-01:ai_feedback",
    );
  });

  it("records missing families instead of inventing members", () => {
    const ranking = assignment("ranking", 1);
    const result = sample([
      candidate({ assignment: ranking, arm: "baseline" }),
      candidate({ assignment: ranking, arm: "ai_one_shot" }),
      candidate({ assignment: ranking, arm: "ai_feedback" }),
    ]);
    expect(result.selection.missingFamilies).toContain("counting");
    expect(result.selection.shortfalls).toContain(
      "family_no_accepted_candidates:counting",
    );
    expect(
      result.publicBundle.puzzles.some((puzzle) => puzzle.title.includes("Counting")),
    ).toBe(false);
  });

  it("prioritizes repaired, novel, and near-baseline additions once, then fills by representation", () => {
    const families = ["ranking", "matching", "scheduling", "truth", "arithmetic"] as const;
    const candidates: DesignSampleCandidate[] = [];
    for (const family of families) {
      const found = familyAssignments(family)[0];
      const second = familyAssignments(family)[1];
      if (found === undefined || second === undefined) {
        continue;
      }
      candidates.push(
        candidate({ assignment: found, arm: "baseline" }),
        candidate({ assignment: found, arm: "ai_one_shot" }),
        candidate({
          assignment: found,
          arm: "ai_feedback",
          attemptCount: 2,
          finalNovelty: "novel",
        }),
        candidate({
          assignment: second,
          arm: "baseline",
          attemptCount: 2,
          finalNovelty: "near_baseline",
        }),
        candidate({
          assignment: second,
          arm: "ai_one_shot",
          attemptCount: 2,
          finalNovelty: "novel",
        }),
        candidate({
          assignment: second,
          arm: "ai_feedback",
          attemptCount: 2,
          finalNovelty: "baseline_duplicate",
        }),
      );
    }
    const result = sample(candidates, { maxAdditions: 4 });
    expect(result.publicBundle.additions.length).toBeLessThanOrEqual(4);
    const reasons = result.privateBundle.additions.map((addition) => addition.reason);
    expect(reasons[0]).toBe("repaired");
    expect(reasons).toContain("novel");
    expect(reasons).toContain("near_baseline");
    const coreIds = new Set(result.publicBundle.triplets.flatMap((triplet) => triplet.memberIds));
    for (const addition of result.publicBundle.additions) {
      expect(coreIds.has(addition)).toBe(false);
    }
    expect(result.selection.totalCandidates).toBeLessThanOrEqual(40);
    expect(new Set(result.selection.categoriesCovered).size).toBeGreaterThanOrEqual(2);
    const csv = buildDesignEvaluationLabelsCsv(result);
    for (const evaluationId of result.publicBundle.additions) {
      expect(csv).toContain(`member_pre:${evaluationId}`);
      expect(csv).toContain(`member_post:${evaluationId}`);
    }
  });

  it("does not mutate candidate views while sampling", () => {
    const ranking = assignment("ranking", 1);
    const candidates = (["baseline", "ai_one_shot", "ai_feedback"] as const).map(
      (arm) => candidate({ assignment: ranking, arm }),
    );
    const before = JSON.stringify(candidates);
    sample(candidates);
    expect(JSON.stringify(candidates)).toBe(before);
  });
});

describe("P50.3 labels and provenance", () => {
  function database(): Database.Database {
    const db = openDatabase(":memory:");
    migrate(db);
    return db;
  }

  function preparedSample() {
    const rankings = familyAssignments("ranking").slice(0, 2);
    const candidates = rankings.flatMap((ranking, index) =>
      (["baseline", "ai_one_shot", "ai_feedback"] as const).map((arm) =>
        candidate({
          assignment: ranking,
          arm,
          ...(index === 1 && arm === "ai_feedback"
            ? { attemptCount: 2, finalNovelty: "novel" as const }
            : {}),
        }),
      ),
    );
    return sample(candidates, { maxAdditions: 1 });
  }

  it("writes a pending CSV with the fixed schema and visibly marks synthetic test mode", () => {
    const prepared = preparedSample();
    const pending = buildDesignEvaluationLabelsCsv(prepared);
    expect(pending.split("\n")[0]).toBe(
      DESIGN_EVALUATION_LABEL_HEADER.join(","),
    );
    const synthetic = buildDesignEvaluationLabelsCsv(prepared, {
      syntheticTestOnly: true,
    });
    expect(synthetic.startsWith("# synthetic_test_only=true")).toBe(true);
    expect(synthetic).toContain(",true,");
  });

  it("imports genuine append-only revisions and validates provenance", () => {
    const db = database();
    createDesignerRun(db, {
      runId: RUN_ID,
      plan: PLAN,
      evidenceKind: "mock",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const prepared = preparedSample();
    storeDesignEvaluationSample(db, prepared);
    const evaluationId = prepared.publicBundle.triplets[0]?.memberIds[0];
    expect(evaluationId).toBeDefined();
    const tripletId = prepared.publicBundle.triplets[0]?.tripletId as string;
    const base = {
      sample_hash: prepared.sampleHash,
      unit_key: `member_pre:${evaluationId}`,
      unit_type: "member_pre" as const,
      triplet_id: tripletId,
      evaluation_id: evaluationId as string,
      paired_vs: null,
      paired_metric: null,
      revision: 1,
      previous_revision: null,
      auditor: "human-auditor",
      recorded_at: "2026-01-01T00:10:00.000Z",
      pre_reveal: true,
      synthetic: false,
      correct: null,
      clarity: 5,
      interest: 4,
      difficulty: 3,
      solve_time: "61-180s" as const,
      preference: null,
      reason: "clear wording",
      defect_notes: "",
    };
    const contentHash = computeDesignEvaluationLabelContentHash(base);
    const csv = [
      DESIGN_EVALUATION_LABEL_HEADER.join(","),
      [
        base.sample_hash,
        base.unit_key,
        base.unit_type,
        base.triplet_id,
        base.evaluation_id,
        "",
        "",
        base.revision,
        "",
        base.auditor,
        base.recorded_at,
        "true",
        "false",
        "",
        base.clarity,
        base.interest,
        base.difficulty,
        base.solve_time,
        "",
        base.reason,
        base.defect_notes,
        contentHash,
      ].join(","),
    ].join("\n") + "\n";
    const parsed = parseDesignEvaluationLabelsCsv({
      text: csv,
      sample: prepared,
      syntheticTestOnly: false,
      now: new Date("2026-01-01T00:20:00.000Z"),
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.synthetic).toBe(false);
    const imported = importDesignEvaluationRows(db, prepared, parsed.rows);
    expect(imported.inserted).toBe(1);
    expect(() =>
      db.prepare("UPDATE design_evaluations SET unit_key = 'x'").run(),
    ).toThrow(/append-only/);

    const next = {
      ...base,
      revision: 2,
      previous_revision: 1,
      clarity: 4,
    };
    const nextHash = computeDesignEvaluationLabelContentHash(next);
    const nextCsv = [
      DESIGN_EVALUATION_LABEL_HEADER.join(","),
      [
        next.sample_hash,
        next.unit_key,
        next.unit_type,
        next.triplet_id,
        next.evaluation_id,
        "",
        "",
        next.revision,
        next.previous_revision,
        next.auditor,
        next.recorded_at,
        "true",
        "false",
        "",
        next.clarity,
        next.interest,
        next.difficulty,
        next.solve_time,
        "",
        next.reason,
        next.defect_notes,
        nextHash,
      ].join(","),
    ].join("\n") + "\n";
    const parsedNext = parseDesignEvaluationLabelsCsv({
      text: nextCsv,
      sample: prepared,
      syntheticTestOnly: false,
      now: new Date("2026-01-01T00:30:00.000Z"),
    });
    expect(importDesignEvaluationRows(db, prepared, parsedNext.rows).inserted).toBe(1);
  });

  it("computes fixed human denominators from the latest append-only revisions", () => {
    const db = database();
    createDesignerRun(db, {
      runId: RUN_ID,
      plan: PLAN,
      evidenceKind: "mock",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const prepared = preparedSample();
    storeDesignEvaluationSample(db, prepared);
    const triplet = prepared.privateBundle.triplets[0];
    expect(triplet).toBeDefined();
    const members = prepared.privateBundle.members.filter((member) =>
      triplet?.memberIds.includes(member.evaluationId),
    );
    const additionId = prepared.publicBundle.additions[0];
    expect(additionId).toBeDefined();
    const feedback = members.find((member) => member.arm === "ai_feedback");
    const baseline = members.find((member) => member.arm === "baseline");
    expect(feedback).toBeDefined();
    expect(baseline).toBeDefined();
    const makeRow = (
      unitKey: string,
      unitType: "member_pre" | "member_post" | "pairwise",
      evaluationId: string,
      overrides: Partial<{
        clarity: number;
        interest: number;
        difficulty: number;
        solveTime: (typeof DESIGN_EVALUATION_SOLVE_TIMES)[number];
        correct: boolean;
        preference: "left" | "right" | "tie";
        pairedVs: string;
        pairedMetric: "interest" | "clarity" | "difficulty";
      }> = {},
    ) => {
      const body = {
        sample_hash: prepared.sampleHash,
        unit_key: unitKey,
        unit_type: unitType,
        triplet_id: triplet?.tripletId as string,
        evaluation_id: evaluationId,
        paired_vs: overrides.pairedVs ?? null,
        paired_metric: overrides.pairedMetric ?? null,
        revision: 1,
        previous_revision: null,
        auditor: "human-auditor",
        recorded_at: "2026-01-01T00:10:00.000Z",
        pre_reveal: unitType !== "member_post",
        synthetic: true,
        correct: unitType === "member_post" ? (overrides.correct ?? true) : null,
        clarity: unitType === "member_pre" ? (overrides.clarity ?? 4) : null,
        interest: unitType === "member_pre" ? (overrides.interest ?? 4) : null,
        difficulty: unitType === "member_pre" ? (overrides.difficulty ?? 3) : null,
        solve_time: unitType === "member_pre" ? (overrides.solveTime ?? "<=60s") : null,
        preference: unitType === "pairwise" ? (overrides.preference ?? "tie") : null,
        reason: "",
        defect_notes: "",
      };
      return {
        ...body,
        content_hash: computeDesignEvaluationLabelContentHash(body),
      };
    };
    const ordered = triplet?.memberIds as [string, string, string];
    let pairLeft: string | null = null;
    let pairRight: string | null = null;
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        const leftArm = members.find(
          (member) => member.evaluationId === ordered[left],
        )?.arm;
        const rightArm = members.find(
          (member) => member.evaluationId === ordered[right],
        )?.arm;
        if (
          (leftArm === "ai_feedback" && rightArm === "baseline") ||
          (leftArm === "baseline" && rightArm === "ai_feedback")
        ) {
          pairLeft = ordered[left] ?? null;
          pairRight = ordered[right] ?? null;
        }
      }
    }
    expect(pairLeft).not.toBeNull();
    expect(pairRight).not.toBeNull();
    const feedbackIsLeft =
      members.find((member) => member.evaluationId === pairLeft)?.arm ===
      "ai_feedback";
    const rows = [
      makeRow(`member_pre:${feedback?.evaluationId}`, "member_pre", feedback?.evaluationId as string, {
        clarity: 5,
        interest: 4,
        difficulty: 3,
        solveTime: "<=60s",
      }),
      makeRow(`member_post:${feedback?.evaluationId}`, "member_post", feedback?.evaluationId as string),
      makeRow(`member_pre:${baseline?.evaluationId}`, "member_pre", baseline?.evaluationId as string, {
        clarity: 3,
        interest: 2,
        difficulty: 2,
        solveTime: ">180s",
      }),
      makeRow(`member_post:${baseline?.evaluationId}`, "member_post", baseline?.evaluationId as string, {
        correct: false,
      }),
      makeRow(`member_post:${additionId}`, "member_post", additionId as string, {
        correct: false,
      }),
      makeRow(
        `pairwise:${triplet?.tripletId}:${pairLeft}:${pairRight}:interest`,
        "pairwise",
        pairLeft as string,
        {
          pairedVs: pairRight as string,
          pairedMetric: "interest",
          preference: feedbackIsLeft ? "left" : "right",
        },
      ),
    ];
    importDesignEvaluationRows(db, prepared, rows);
    const summary = loadDesignEvaluationSummary(db, prepared.sampleHash);
    expect(summary.synthetic).toBe(true);
    expect(summary.corePlanned).toBe(30);
    expect(summary.coreInspected).toBe(2);
    expect(summary.aiCorePlanned).toBe(20);
    expect(summary.aiCoreClearSolved).toBe(1);
    expect(summary.correctnessDefects).toBe(2);
    expect(summary.pairedInterest).toEqual({
      wins: 1,
      ties: 0,
      losses: 0,
      denominator: 10,
    });
    expect(summary.pairedClarity).toEqual({
      wins: 0,
      ties: 0,
      losses: 1,
      denominator: 10,
    });
  });

  it("rejects unknown sample hashes, synthetic mismatches, and skipped revisions", () => {
    const prepared = preparedSample();
    const evaluationId = prepared.publicBundle.triplets[0]?.memberIds[0] as string;
    const tripletId = prepared.publicBundle.triplets[0]?.tripletId as string;
    const base = {
      sample_hash: prepared.sampleHash,
      unit_key: `member_pre:${evaluationId}`,
      unit_type: "member_pre" as const,
      triplet_id: tripletId,
      evaluation_id: evaluationId,
      paired_vs: null,
      paired_metric: null,
      revision: 1,
      previous_revision: null,
      auditor: "human-auditor",
      recorded_at: "2026-01-01T00:10:00.000Z",
      pre_reveal: true,
      synthetic: false,
      correct: null,
      clarity: 5,
      interest: 4,
      difficulty: 3,
      solve_time: "<=60s" as const,
      preference: null,
      reason: "",
      defect_notes: "",
    };
    const header = DESIGN_EVALUATION_LABEL_HEADER.join(",");
    const line = (overrides: Partial<typeof base> & { hash?: string }) => {
      const merged = { ...base, ...overrides };
      const computedHash = computeDesignEvaluationLabelContentHash(merged);
      return [
        overrides.sample_hash ?? base.sample_hash,
        overrides.unit_key ?? base.unit_key,
        overrides.unit_type ?? base.unit_type,
        overrides.triplet_id ?? base.triplet_id,
        overrides.evaluation_id ?? base.evaluation_id,
        "",
        "",
        overrides.revision ?? base.revision,
        overrides.previous_revision ?? "",
        overrides.auditor ?? base.auditor,
        overrides.recorded_at ?? base.recorded_at,
        "true",
        overrides.synthetic === undefined
          ? "false"
          : overrides.synthetic
            ? "true"
            : "false",
        "",
        overrides.clarity ?? base.clarity,
        overrides.interest ?? base.interest,
        overrides.difficulty ?? base.difficulty,
        overrides.solve_time ?? base.solve_time,
        "",
        overrides.reason ?? base.reason,
        overrides.defect_notes ?? base.defect_notes,
        overrides.hash ?? computedHash,
      ].join(",");
    };
    expect(() =>
      parseDesignEvaluationLabelsCsv({
        text: `${header}\n${line({ sample_hash: "b".repeat(64) })}\n`,
        sample: prepared,
        syntheticTestOnly: false,
        now: new Date("2026-01-01T00:20:00.000Z"),
      }),
    ).toThrow(/sample hash/);
    expect(() =>
      parseDesignEvaluationLabelsCsv({
        text: `${header}\n${line({ synthetic: true })}\n`,
        sample: prepared,
        syntheticTestOnly: false,
        now: new Date("2026-01-01T00:20:00.000Z"),
      }),
    ).toThrow(/synthetic=false/);
    expect(() =>
      parseDesignEvaluationLabelsCsv({
        text: `${header}\n${line({ revision: 2, previous_revision: null })}\n`,
        sample: prepared,
        syntheticTestOnly: false,
        now: new Date("2026-01-01T00:20:00.000Z"),
      }),
    ).toThrow(/previous_revision/);
  });
});
