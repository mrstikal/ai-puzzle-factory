import { deepEqual, makeChoiceSet, type ChoiceSet } from "../../domain/answers.js";
import type { Difficulty } from "../../domain/experiment.js";
import { HashCounterPrng } from "../../util/random.js";
import {
  formatFactId,
  type Fact,
  type FamilyEngine,
  type SolveResult,
  type TestMutation,
  type VisibleRules,
} from "../contracts.js";
import { canonicalizeSchedulingSpec } from "./canonical.js";
import {
  SCHEDULING_EVENT_IDS,
  ScheduleTableSchema,
  SchedulingSpecSchema,
  assignmentToTable,
  clueKey,
  clueSatisfied,
  clueText,
  schedulingEventLabel,
  schedulingResourceLabel,
  schedulingViolationCount,
  solveSchedulingAssignments,
  tableToAssignment,
  type ScheduleAnswer,
  type ScheduleTable,
  type SchedulingAssignment,
  type SchedulingClue,
  type SchedulingSpec,
} from "./schema.js";

const MAX_CONSTRUCTION_DRAWS = 64;
const ANCHOR_COUNT = 6;
const MIN_CLUES = 4;
const MAX_CLUES = 12;

export type SchedulingConstructionErrorCode =
  | "DRAW_LIMIT"
  | "UNIQUENESS_FAILED"
  | "INVALID_DIFFICULTY";

export class SchedulingConstructionError extends Error {
  readonly code: SchedulingConstructionErrorCode;

  constructor(
    code: SchedulingConstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchedulingConstructionError";
    this.code = code;
  }
}

export type SchedulingEngineErrorCode =
  | "INVALID_ANSWER"
  | "NOT_UNIQUE"
  | "INSUFFICIENT_DISTRACTORS"
  | "INVALID_OPTION_SET";

export class SchedulingEngineError extends Error {
  readonly code: SchedulingEngineErrorCode;

  constructor(code: SchedulingEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SchedulingEngineError";
    this.code = code;
  }
}

class DrawBudget {
  private readonly prng: HashCounterPrng;
  private draws = 0;

  constructor(prng: HashCounterPrng) {
    this.prng = prng;
  }

  get used(): number {
    return this.draws;
  }

  nextInt(maxExclusive: number): number {
    if (this.draws >= MAX_CONSTRUCTION_DRAWS) {
      throw new SchedulingConstructionError(
        "DRAW_LIMIT",
        `scheduling construction exceeded ${MAX_CONSTRUCTION_DRAWS} deterministic draws`,
      );
    }
    this.draws += 1;
    return this.prng.nextInt(maxExclusive);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextInt(index + 1);
      const current = copy[index];
      const replacement = copy[swapIndex];
      if (current === undefined || replacement === undefined) {
        throw new Error("scheduling shuffle encountered an invalid index");
      }
      copy[index] = replacement;
      copy[swapIndex] = current;
    }
    return copy;
  }

  sampleDistinct<T>(items: readonly T[], count: number): T[] {
    if (!Number.isInteger(count) || count < 0 || count > items.length) {
      throw new RangeError(`scheduling sample count ${count} is outside 0..${items.length}`);
    }
    const pool = [...items];
    const selected: T[] = [];
    for (let index = 0; index < count; index += 1) {
      const remaining = pool.length - index;
      const pick = this.nextInt(remaining);
      const chosen = pool[pick];
      const lastIndex = pool.length - 1 - index;
      const last = pool[lastIndex];
      if (chosen === undefined || last === undefined) {
        throw new Error("scheduling sample encountered an invalid index");
      }
      selected.push(chosen);
      pool[pick] = last;
      pool[lastIndex] = chosen;
    }
    return selected;
  }
}

function slotOf(assignment: SchedulingAssignment, event: number): number | undefined {
  const index = assignment.order.indexOf(event);
  return index < 0 ? undefined : index + 1;
}

function buildTruePool(assignment: SchedulingAssignment): SchedulingClue[] {
  const pool: SchedulingClue[] = [];
  for (const event of SCHEDULING_EVENT_IDS) {
    const slot = slotOf(assignment, event);
    if (slot === undefined) {
      throw new RangeError("scheduling witness is incomplete");
    }
    pool.push({ kind: "at", event, slot });
    for (let otherSlot = 1; otherSlot <= 4; otherSlot += 1) {
      if (otherSlot !== slot) {
        pool.push({ kind: "notAt", event, slot: otherSlot });
      }
    }
  }
  for (const first of SCHEDULING_EVENT_IDS) {
    for (const second of SCHEDULING_EVENT_IDS) {
      if (first === second) {
        continue;
      }
      const firstSlot = slotOf(assignment, first);
      const secondSlot = slotOf(assignment, second);
      if (
        firstSlot !== undefined &&
        secondSlot !== undefined &&
        firstSlot < secondSlot
      ) {
        pool.push({ kind: "before", before: first, after: second });
      }
    }
  }
  for (let index = 0; index + 1 < assignment.order.length; index += 1) {
    const first = assignment.order[index];
    const second = assignment.order[index + 1];
    if (first !== undefined && second !== undefined) {
      pool.push({ kind: "immediatelyBefore", before: first, after: second });
    }
  }
  for (const event of SCHEDULING_EVENT_IDS) {
    const resource = assignment.resources[event];
    if (resource === undefined) {
      throw new RangeError("scheduling witness resources are incomplete");
    }
    pool.push({ kind: "usesResource", event, resource });
    pool.push({ kind: "notResource", event, resource: 1 - resource });
  }
  return pool;
}

function anchorClues(assignment: SchedulingAssignment): SchedulingClue[] {
  const anchors: SchedulingClue[] = [];
  for (let index = 0; index + 1 < assignment.order.length; index += 1) {
    const first = assignment.order[index];
    const second = assignment.order[index + 1];
    if (first === undefined || second === undefined) {
      throw new RangeError("scheduling witness order is incomplete");
    }
    anchors.push({ kind: "before", before: first, after: second });
  }
  const zeroEvents = SCHEDULING_EVENT_IDS.filter(
    (event) => assignment.resources[event] === 0,
  );
  const oneEvents = SCHEDULING_EVENT_IDS.filter(
    (event) => assignment.resources[event] === 1,
  );
  const zeroFirst = zeroEvents[0];
  const zeroSecond = zeroEvents[1];
  const oneFirst = oneEvents[0];
  if (zeroFirst === undefined || zeroSecond === undefined || oneFirst === undefined) {
    throw new RangeError("scheduling witness resources are not capacity two");
  }
  anchors.push({ kind: "usesResource", event: zeroFirst, resource: 0 });
  anchors.push({ kind: "usesResource", event: zeroSecond, resource: 0 });
  anchors.push({ kind: "usesResource", event: oneFirst, resource: 1 });
  return anchors;
}

function sameAssignment(
  left: SchedulingAssignment,
  right: SchedulingAssignment,
): boolean {
  return (
    deepEqual(left.order, right.order) && deepEqual(left.resources, right.resources)
  );
}

export interface SchedulingConstructionTrace {
  readonly anchorCount: number;
  readonly temporalAdded: number;
  readonly resourceAdded: number;
  readonly additionalRequested: number;
  readonly additionalAdded: number;
  readonly prunedClues: number;
  readonly clueCountBeforePruning: number;
  readonly clueCountAfterPruning: number;
  readonly drawsUsed: number;
}

export interface SchedulingConstructionResult {
  readonly spec: SchedulingSpec;
  readonly trace: SchedulingConstructionTrace;
}

export function constructSchedulingSpec(
  seed: string,
  difficulty: Difficulty,
): SchedulingConstructionResult {
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
    throw new SchedulingConstructionError(
      "INVALID_DIFFICULTY",
      `scheduling difficulty must be 1, 2, or 3, received ${String(difficulty)}`,
    );
  }
  const draw = new DrawBudget(new HashCounterPrng(seed));
  const order = draw.shuffle(SCHEDULING_EVENT_IDS);
  const zeroEvents = draw.sampleDistinct(SCHEDULING_EVENT_IDS, 2);
  const resources = SCHEDULING_EVENT_IDS.map((event) =>
    zeroEvents.includes(event) ? 0 : 1,
  );
  const witness: SchedulingAssignment = { order, resources };
  const truePool = buildTruePool(witness);
  const anchors = anchorClues(witness);
  const anchorKeys = new Set(anchors.map(clueKey));

  const temporalPool = truePool.filter(
    (clue) =>
      (clue.kind === "at" ||
        clue.kind === "notAt" ||
        clue.kind === "before" ||
        clue.kind === "immediatelyBefore") &&
      !anchorKeys.has(clueKey(clue)),
  );
  const resourcePool = truePool.filter(
    (clue) =>
      (clue.kind === "usesResource" || clue.kind === "notResource") &&
      !anchorKeys.has(clueKey(clue)),
  );

  const additionalRequested = 4 + draw.nextInt(3);
  const temporal = draw.sampleDistinct(temporalPool, 1);
  const resource = draw.sampleDistinct(resourcePool, 1);
  const selectedKeys = new Set([...temporal, ...resource].map(clueKey));
  const remainingPool = truePool.filter(
    (clue) => !anchorKeys.has(clueKey(clue)) && !selectedKeys.has(clueKey(clue)),
  );
  const remaining = draw.sampleDistinct(remainingPool, additionalRequested - 2);
  let clues: SchedulingClue[] = [
    ...anchors,
    ...temporal,
    ...resource,
    ...remaining,
  ];
  const clueCountBeforePruning = clues.length;
  const floor = difficulty === 1 ? 8 : difficulty === 2 ? 6 : 4;

  const pruneOrder = draw.shuffle(clues.map((_clue, index) => index));
  const retained = new Set<number>(clues.map((_clue, index) => index));
  const removalOrder: number[] = [];
  for (const index of pruneOrder) {
    if (retained.size <= floor) {
      break;
    }
    if (!retained.has(index)) {
      continue;
    }
    const candidate = [...retained]
      .filter((candidateIndex) => candidateIndex !== index)
      .sort((left, right) => left - right)
      .map((candidateIndex) => clues[candidateIndex] as SchedulingClue);
    const solved = solveSchedulingAssignments(candidate);
    const solution = solved.solutions[0];
    if (
      solved.solutions.length === 1 &&
      solution !== undefined &&
      sameAssignment(solution, witness)
    ) {
      retained.delete(index);
      removalOrder.push(index);
    }
  }
  clues = [...retained]
    .sort((left, right) => left - right)
    .map((index) => clues[index] as SchedulingClue);

  const finalSolved = solveSchedulingAssignments(clues);
  const finalSolution = finalSolved.solutions[0];
  if (
    finalSolved.solutions.length !== 1 ||
    finalSolution === undefined ||
    !sameAssignment(finalSolution, witness)
  ) {
    throw new SchedulingConstructionError(
      "UNIQUENESS_FAILED",
      "scheduling construction did not retain the intended unique schedule",
    );
  }
  if (clues.length < MIN_CLUES || clues.length > MAX_CLUES) {
    throw new SchedulingConstructionError(
      "UNIQUENESS_FAILED",
      `scheduling construction produced ${clues.length} clues outside ${MIN_CLUES}..${MAX_CLUES}`,
    );
  }

  const spec = SchedulingSpecSchema.parse({ clues });
  return {
    spec,
    trace: {
      anchorCount: ANCHOR_COUNT,
      temporalAdded: temporal.length,
      resourceAdded: resource.length,
      additionalRequested,
      additionalAdded: temporal.length + resource.length + remaining.length,
      prunedClues: removalOrder.length,
      clueCountBeforePruning,
      clueCountAfterPruning: spec.clues.length,
      drawsUsed: draw.used,
    },
  };
}

function tableText(table: ScheduleTable): string {
  return table
    .map(
      (row) =>
        `${schedulingEventLabel(row.event)}@${row.slot}/${schedulingResourceLabel(row.resource)}`,
    )
    .join("; ");
}

function enumerateSolutions(spec: SchedulingSpec): SolveResult<ScheduleAnswer> {
  const parsed = SchedulingSpecSchema.parse(spec);
  const solved = solveSchedulingAssignments(parsed.clues);
  const solution = solved.solutions.length === 1 ? solved.solutions[0] : undefined;
  const table = solution === undefined ? null : assignmentToTable(solution);
  return {
    solutionCount: solved.solutions.length,
    answerCount: solved.solutions.length,
    correctAnswer: table,
    proof:
      table === null
        ? null
        : {
            facts: [
              {
                factId: "s001",
                kind: "derived",
                text: `The unique schedule is ${tableText(table)}.`,
              },
            ],
            witness: table,
          },
    enumeratedStates: solved.enumeratedStates,
    checkerVersion: "scheduling-v1",
  };
}

function verifyAnswer(spec: SchedulingSpec, answer: ScheduleAnswer): boolean {
  const parsed = SchedulingSpecSchema.parse(spec);
  const table = ScheduleTableSchema.safeParse(answer);
  if (!table.success) {
    return false;
  }
  const assignment = tableToAssignment(table.data);
  return parsed.clues.every((clue) => clueSatisfied(clue, assignment));
}

function makeOptions(
  spec: SchedulingSpec,
  answer: ScheduleAnswer,
  seed: string,
): ChoiceSet<ScheduleAnswer> {
  const parsed = SchedulingSpecSchema.parse(spec);
  const solvedSpec = solveSchedulingAssignments(parsed.clues);
  const uniqueAssignment =
    solvedSpec.solutions.length === 1 ? solvedSpec.solutions[0] : undefined;
  if (uniqueAssignment === undefined) {
    throw new SchedulingEngineError(
      "NOT_UNIQUE",
      `scheduling options require one full schedule, received ${solvedSpec.solutions.length}`,
    );
  }
  const correctTable = assignmentToTable(uniqueAssignment);
  const suppliedTable = ScheduleTableSchema.safeParse(answer);
  if (!suppliedTable.success || !deepEqual(suppliedTable.data, correctTable)) {
    throw new SchedulingEngineError(
      "INVALID_ANSWER",
      "scheduling options require the unique satisfying schedule",
    );
  }

  const all = solveSchedulingAssignments([]);
  const falseTables: ScheduleTable[] = [];
  for (const assignment of all.solutions) {
    if (schedulingViolationCount(parsed.clues, assignment) === 0) {
      continue;
    }
    falseTables.push(assignmentToTable(assignment));
  }
  const prng = new HashCounterPrng(seed);
  const ordered = prng.shuffle(falseTables);
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new SchedulingEngineError(
      "INSUFFICIENT_DISTRACTORS",
      "scheduling spec has fewer than three false legal schedules",
    );
  }
  const choices = makeChoiceSet({
    correct: correctTable,
    distractors: [first, second, third] as [
      ScheduleAnswer,
      ScheduleAnswer,
      ScheduleAnswer,
    ],
    seed,
  });
  let trueChoices = 0;
  for (const choice of choices.choices) {
    const table = ScheduleTableSchema.safeParse(choice.value);
    if (table.success && verifyAnswer(parsed, table.data)) {
      trueChoices += 1;
    }
  }
  if (trueChoices !== 1) {
    throw new SchedulingEngineError(
      "INVALID_OPTION_SET",
      `scheduling option set contains ${trueChoices} satisfying schedules`,
    );
  }
  return choices;
}

function visibleRules(spec: SchedulingSpec): VisibleRules {
  SchedulingSpecSchema.parse(spec);
  return {
    domain:
      "Four events E1-E4 are placed in four ordered consecutive time slots 1-4. Two capacity-2 resources R1 and R2 are each used by exactly two events.",
    closedWorld:
      "Each event occupies exactly one slot, each slot holds exactly one event, and each resource is assigned to exactly two events. No other capacity rule applies.",
    target: "Determine the complete event/time/resource table.",
    operations: [
      "at(event,slot): the event is at the given 1-based slot.",
      "notAt(event,slot): the event is not at the given 1-based slot.",
      "before(a,b): event a is in an earlier slot than event b.",
      "immediatelyBefore(a,b): event b is in the next slot after event a.",
      "usesResource(event,resource): the event uses the given resource.",
      "notResource(event,resource): the event does not use the given resource.",
    ],
    conventions: [
      "Slots are 1-based and consecutive; immediatelyBefore means the next slot.",
      "Rows are ordered by event E1-E4.",
      "Each resource has capacity two.",
    ],
  };
}

function facts(spec: SchedulingSpec): readonly Fact[] {
  const parsed = SchedulingSpecSchema.parse(spec);
  return parsed.clues.map((clue, index) => ({
    factId: formatFactId("local", index),
    kind: "local" as const,
    text: clueText(clue),
  }));
}

function testMutations(_spec: SchedulingSpec): readonly TestMutation<SchedulingSpec>[] {
  return [
    {
      id: "resource-only-ambiguity",
      description: "the time order is fixed but resources remain ambiguous",
      spec: SchedulingSpecSchema.parse({
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 3 },
          { kind: "usesResource", event: 0, resource: 0 },
        ],
      }),
    },
    {
      id: "temporal-contradiction",
      description: "a directed before cycle makes the schedule impossible",
      spec: SchedulingSpecSchema.parse({
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 0 },
          { kind: "usesResource", event: 0, resource: 0 },
        ],
      }),
    },
    {
      id: "exact-capacity",
      description: "three resource facts plus capacity fix the fourth resource",
      spec: SchedulingSpecSchema.parse({
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 3 },
          { kind: "usesResource", event: 0, resource: 0 },
          { kind: "usesResource", event: 1, resource: 0 },
          { kind: "usesResource", event: 2, resource: 1 },
        ],
      }),
    },
    {
      id: "immediately-before",
      description: "an immediate-before chain fixes the consecutive event order",
      spec: SchedulingSpecSchema.parse({
        clues: [
          { kind: "immediatelyBefore", before: 0, after: 1 },
          { kind: "immediatelyBefore", before: 1, after: 2 },
          { kind: "immediatelyBefore", before: 2, after: 3 },
          { kind: "usesResource", event: 0, resource: 0 },
          { kind: "usesResource", event: 1, resource: 0 },
          { kind: "usesResource", event: 2, resource: 1 },
        ],
      }),
    },
  ];
}

export const schedulingEngine: FamilyEngine<SchedulingSpec, ScheduleAnswer> = {
  family: "scheduling",
  modality: "text",
  schema: SchedulingSpecSchema,
  generateSpec(seed, difficulty) {
    return constructSchedulingSpec(seed, difficulty).spec;
  },
  enumerateSolutions,
  verifyAnswer,
  makeOptions,
  visibleRules,
  facts,
  canonicalData(spec) {
    return canonicalizeSchedulingSpec(spec);
  },
  testMutations,
};
