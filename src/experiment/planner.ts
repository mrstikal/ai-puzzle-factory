import {
  DIFFICULTIES,
  FAMILIES,
  FULL_DIFFICULTY_COUNTS,
  LANES,
  MAX_TRANSPORT_ATTEMPTS_PER_CALL,
  MODALITY_BY_FAMILY,
  PROTOCOL_VERSION,
  PlanManifestSchema,
  REQUEST_ROLES,
  ROOT_SEEDS,
  SVG_FAMILIES,
  TEXT_FAMILIES,
  smokeDifficultyForFamily,
  type Difficulty,
  type DifficultyCount,
  type Family,
  type Lane,
  type Modality,
  type PlanManifest,
  type Quotas,
  type RequestEstimate,
  type RunKind,
  type SlotPlan,
} from "../domain/experiment.js";
import { hashObjectExcluding } from "../util/hash.js";
import { createStream } from "../util/random.js";

export { canonicalJson } from "../util/hash.js";

export interface BuildPlanOptions {
  readonly runKind: RunKind;
  readonly rootSeed?: string;
}

export function buildPlanManifest(options: BuildPlanOptions): PlanManifest {
  const fixedSeed = ROOT_SEEDS[options.runKind];
  const rootSeed = options.rootSeed ?? fixedSeed;
  if (rootSeed !== fixedSeed) {
    throw new Error(
      `root seed for ${options.runKind} plans is fixed to ${fixedSeed}; received ${rootSeed}`,
    );
  }
  const slots = options.runKind === "full" ? buildFullSlots(rootSeed) : buildSmokeSlots();
  const quotas = computeQuotas(slots);
  const difficultyCounts = computeDifficultyCounts(slots);
  const requestEstimate = computeRequestEstimate(slots);
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    runKind: options.runKind,
    rootSeed,
    slots,
    quotas,
    difficultyCounts,
    requestEstimate,
  };
  const planHash = computePlanHash(base);
  return PlanManifestSchema.parse({ ...base, planHash });
}

export function computePlanHash(plan: Omit<PlanManifest, "planHash"> | PlanManifest): string {
  return hashObjectExcluding(plan, "planHash");
}

export function serializePlanManifest(plan: PlanManifest): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function expandDifficultyCounts(counts: readonly [number, number, number]): Difficulty[] {
  const difficulties: Difficulty[] = [];
  for (const [index, count] of counts.entries()) {
    const difficulty = DIFFICULTIES[index];
    if (difficulty === undefined) {
      throw new Error(`No difficulty defined for tuple index ${index}`);
    }
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      difficulties.push(difficulty);
    }
  }
  return difficulties;
}

function buildFullSlots(rootSeed: string): SlotPlan[] {
  const slots: SlotPlan[] = [];
  let slotOrdinal = 0;

  for (const family of FAMILIES) {
    const modality = MODALITY_BY_FAMILY[family];
    const tuples: Array<{
      family: Family;
      modality: Modality;
      lane: Lane;
      difficulty: Difficulty;
    }> = [];

    for (const lane of LANES) {
      const counts = FULL_DIFFICULTY_COUNTS[modality][lane];
      for (const difficulty of expandDifficultyCounts(counts)) {
        tuples.push({ family, modality, lane, difficulty });
      }
    }

    const stream = createStream({
      protocolVersion: PROTOCOL_VERSION,
      rootSeed,
      slotId: family,
      purpose: "plan",
    });
    const shuffled = stream.shuffle(tuples);
    for (const [index, tuple] of shuffled.entries()) {
      slotOrdinal += 1;
      slots.push({
        slotId: `${tuple.modality}-${tuple.family}-${String(index + 1).padStart(2, "0")}`,
        slotOrdinal,
        family: tuple.family,
        modality: tuple.modality,
        lane: tuple.lane,
        difficulty: tuple.difficulty,
      });
    }
  }

  return slots;
}

function buildSmokeSlots(): SlotPlan[] {
  const slots: SlotPlan[] = [];
  let slotOrdinal = 0;

  for (const [familyIndex, family] of FAMILIES.entries()) {
    const modality = MODALITY_BY_FAMILY[family];
    const difficulties = smokeDifficultyForFamily(familyIndex);
    const laneEntries = [
      { lane: "spec_first" as const, difficulty: difficulties.specFirst },
      { lane: "ai_spec" as const, difficulty: difficulties.aiSpec },
    ];
    for (const [index, entry] of laneEntries.entries()) {
      slotOrdinal += 1;
      slots.push({
        slotId: `${modality}-${family}-${String(index + 1).padStart(2, "0")}`,
        slotOrdinal,
        family,
        modality,
        lane: entry.lane,
        difficulty: entry.difficulty,
      });
    }
  }

  return slots;
}

function computeQuotas(slots: readonly SlotPlan[]): Quotas {
  const count = (predicate: (slot: SlotPlan) => boolean): number =>
    slots.filter(predicate).length;

  const totalSlots = slots.length;
  const textSlots = count((slot) => slot.modality === "text");
  const svgSlots = count((slot) => slot.modality === "svg");
  const specFirstSlots = count((slot) => slot.lane === "spec_first");
  const aiSpecSlots = count((slot) => slot.lane === "ai_spec");
  const textSpecFirst = count((slot) => slot.modality === "text" && slot.lane === "spec_first");
  const textAiSpec = count((slot) => slot.modality === "text" && slot.lane === "ai_spec");
  const svgSpecFirst = count((slot) => slot.modality === "svg" && slot.lane === "spec_first");
  const svgAiSpec = count((slot) => slot.modality === "svg" && slot.lane === "ai_spec");

  const quotas: Quotas = {
    totalSlots,
    textSlots,
    svgSlots,
    specFirstSlots,
    aiSpecSlots,
    slotsPerFamily: totalSlots / FAMILIES.length,
    textSpecFirstPerFamily: textSpecFirst / TEXT_FAMILIES.length,
    textAiSpecPerFamily: textAiSpec / TEXT_FAMILIES.length,
    svgSpecFirstPerFamily: svgSpecFirst / SVG_FAMILIES.length,
    svgAiSpecPerFamily: svgAiSpec / SVG_FAMILIES.length,
  };

  for (const [key, value] of Object.entries(quotas)) {
    if (!Number.isInteger(value)) {
      throw new Error(`Non-integral quota ${key}: ${value}`);
    }
  }
  return quotas;
}

function computeDifficultyCounts(slots: readonly SlotPlan[]): DifficultyCount[] {
  const counts: DifficultyCount[] = [];
  for (const family of FAMILIES) {
    for (const lane of LANES) {
      for (const difficulty of DIFFICULTIES) {
        counts.push({
          family,
          lane,
          difficulty,
          count: slots.filter(
            (slot) =>
              slot.family === family && slot.lane === lane && slot.difficulty === difficulty,
          ).length,
        });
      }
    }
  }
  return counts;
}

function computeRequestEstimate(slots: readonly SlotPlan[]): RequestEstimate {
  const count = (predicate: (slot: SlotPlan) => boolean): number =>
    slots.filter(predicate).length;

  const byRole = {
    spec: count((slot) => slot.lane === "ai_spec"),
    wording: slots.length,
    blind_text: count((slot) => slot.modality === "text"),
    blind_vision: count((slot) => slot.modality === "svg"),
    alignment_text: count((slot) => slot.modality === "text"),
    alignment_vision: count((slot) => slot.modality === "svg"),
  };
  const totalLogicalCalls = REQUEST_ROLES.reduce(
    (total, role) => total + byRole[role],
    0,
  );
  return {
    byRole,
    totalLogicalCalls,
    maxTransportAttempts: totalLogicalCalls * MAX_TRANSPORT_ATTEMPTS_PER_CALL,
  };
}
