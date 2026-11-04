import { z } from "zod";
import { collectPermutations, SolverLimitError } from "../canonicalize.js";

export const SCHEDULING_EVENT_IDS = [0, 1, 2, 3] as const;
export const SCHEDULING_SLOT_IDS = [1, 2, 3, 4] as const;
export const SCHEDULING_RESOURCE_IDS = [0, 1] as const;

export type SchedulingEvent = (typeof SCHEDULING_EVENT_IDS)[number];
export type SchedulingSlot = (typeof SCHEDULING_SLOT_IDS)[number];
export type SchedulingResource = (typeof SCHEDULING_RESOURCE_IDS)[number];

const eventSchema = z.number().int().min(0).max(3);
const slotSchema = z.number().int().min(1).max(4);
const resourceSchema = z.number().int().min(0).max(1);

export const SchedulingClueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("at"),
    event: eventSchema,
    slot: slotSchema,
  }),
  z.strictObject({
    kind: z.literal("notAt"),
    event: eventSchema,
    slot: slotSchema,
  }),
  z.strictObject({
    kind: z.literal("before"),
    before: eventSchema,
    after: eventSchema,
  }),
  z.strictObject({
    kind: z.literal("immediatelyBefore"),
    before: eventSchema,
    after: eventSchema,
  }),
  z.strictObject({
    kind: z.literal("usesResource"),
    event: eventSchema,
    resource: resourceSchema,
  }),
  z.strictObject({
    kind: z.literal("notResource"),
    event: eventSchema,
    resource: resourceSchema,
  }),
]);
export type SchedulingClue = z.infer<typeof SchedulingClueSchema>;

export const SchedulingSpecSchema = z
  .strictObject({
    clues: z.array(SchedulingClueSchema).min(4).max(12),
  })
  .superRefine((spec, ctx) => {
    const pairs = new Map<string, SchedulingClue["kind"]>();
    for (const [index, clue] of spec.clues.entries()) {
      if (
        (clue.kind === "before" || clue.kind === "immediatelyBefore") &&
        clue.before === clue.after
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["clues", index],
          message: "a scheduling order relation cannot point an event at itself",
        });
        continue;
      }
      let pair: string | undefined;
      if (clue.kind === "at" || clue.kind === "notAt") {
        pair = `time:${clue.event}:${clue.slot}`;
      } else if (clue.kind === "usesResource" || clue.kind === "notResource") {
        pair = `resource:${clue.event}:${clue.resource}`;
      } else {
        pair = `order:${clue.kind}:${clue.before}:${clue.after}`;
      }
      const existing = pairs.get(pair);
      if (existing !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["clues", index],
          message:
            existing === clue.kind
              ? "duplicate scheduling clue"
              : "contradictory scheduling clue",
        });
        continue;
      }
      pairs.set(pair, clue.kind);
    }
  });
export type SchedulingSpec = z.infer<typeof SchedulingSpecSchema>;

export const ScheduleRowSchema = z.strictObject({
  event: eventSchema,
  slot: slotSchema,
  resource: resourceSchema,
});
export type ScheduleRow = z.infer<typeof ScheduleRowSchema>;

export const ScheduleTableSchema = z
  .tuple([ScheduleRowSchema, ScheduleRowSchema, ScheduleRowSchema, ScheduleRowSchema])
  .superRefine((rows, ctx) => {
    const slots = new Set<number>();
    const resourceCounts = new Map<number, number>([
      [0, 0],
      [1, 0],
    ]);
    for (const [index, row] of rows.entries()) {
      if (row.event !== index) {
        ctx.addIssue({
          code: "custom",
          path: [index, "event"],
          message: "schedule rows must be ordered by event 0..3",
        });
      }
      if (slots.has(row.slot)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "slot"],
          message: `duplicate slot ${row.slot}`,
        });
      }
      slots.add(row.slot);
      resourceCounts.set(row.resource, (resourceCounts.get(row.resource) ?? 0) + 1);
    }
    if (slots.size !== 4) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "a schedule must use every slot 1..4 exactly once",
      });
    }
    for (const resource of SCHEDULING_RESOURCE_IDS) {
      if ((resourceCounts.get(resource) ?? 0) !== 2) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: `resource ${resource} must be used by exactly two events`,
        });
      }
    }
  });
export type ScheduleTable = z.infer<typeof ScheduleTableSchema>;
export type ScheduleAnswer = ScheduleTable;

export interface SchedulingAssignment {
  readonly order: readonly number[];
  readonly resources: readonly number[];
}

export function schedulingEventLabel(event: number): string {
  if (!Number.isInteger(event) || event < 0 || event > 3) {
    throw new RangeError(`scheduling event ${event} is outside 0..3`);
  }
  return `E${event + 1}`;
}

export function schedulingResourceLabel(resource: number): string {
  if (!Number.isInteger(resource) || resource < 0 || resource > 1) {
    throw new RangeError(`scheduling resource ${resource} is outside 0..1`);
  }
  return `R${resource + 1}`;
}

export function schedulingSlotLabel(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    throw new RangeError(`scheduling slot ${slot} is outside 1..4`);
  }
  return String(slot);
}

export function clueKey(clue: SchedulingClue): string {
  switch (clue.kind) {
    case "at":
      return `at:${clue.event}:${clue.slot}`;
    case "notAt":
      return `notAt:${clue.event}:${clue.slot}`;
    case "before":
      return `before:${clue.before}:${clue.after}`;
    case "immediatelyBefore":
      return `immediatelyBefore:${clue.before}:${clue.after}`;
    case "usesResource":
      return `usesResource:${clue.event}:${clue.resource}`;
    case "notResource":
      return `notResource:${clue.event}:${clue.resource}`;
  }
}

export function clueText(clue: SchedulingClue): string {
  switch (clue.kind) {
    case "at":
      return `${schedulingEventLabel(clue.event)} is at slot ${schedulingSlotLabel(clue.slot)}.`;
    case "notAt":
      return `${schedulingEventLabel(clue.event)} is not at slot ${schedulingSlotLabel(clue.slot)}.`;
    case "before":
      return `${schedulingEventLabel(clue.before)} is before ${schedulingEventLabel(clue.after)}.`;
    case "immediatelyBefore":
      return `${schedulingEventLabel(clue.before)} is immediately before ${schedulingEventLabel(clue.after)}.`;
    case "usesResource":
      return `${schedulingEventLabel(clue.event)} uses ${schedulingResourceLabel(clue.resource)}.`;
    case "notResource":
      return `${schedulingEventLabel(clue.event)} does not use ${schedulingResourceLabel(clue.resource)}.`;
  }
}

export function assignmentToTable(assignment: SchedulingAssignment): ScheduleTable {
  const rows: ScheduleRow[] = [];
  for (const event of SCHEDULING_EVENT_IDS) {
    const slotIndex = assignment.order.indexOf(event);
    const resource = assignment.resources[event];
    if (slotIndex < 0 || resource === undefined) {
      throw new RangeError(`scheduling assignment is incomplete for event ${event}`);
    }
    rows.push({ event, slot: slotIndex + 1, resource });
  }
  return ScheduleTableSchema.parse(rows);
}

export function tableToAssignment(table: ScheduleTable): SchedulingAssignment {
  const parsed = ScheduleTableSchema.parse(table);
  const order = Array.from<number | undefined>({ length: 4 }).fill(undefined);
  const resources = Array.from<number | undefined>({ length: 4 }).fill(undefined);
  for (const row of parsed) {
    order[row.slot - 1] = row.event;
    resources[row.event] = row.resource;
  }
  return {
    order: order.map((value) => {
      if (value === undefined) {
        throw new RangeError("schedule table does not define every slot");
      }
      return value;
    }),
    resources: resources.map((value) => {
      if (value === undefined) {
        throw new RangeError("schedule table does not define every event");
      }
      return value;
    }),
  };
}

export function clueSatisfied(
  clue: SchedulingClue,
  assignment: SchedulingAssignment,
): boolean {
  const slotOf = new Map<number, number>();
  for (const [index, event] of assignment.order.entries()) {
    slotOf.set(event, index + 1);
  }
  switch (clue.kind) {
    case "at":
      return slotOf.get(clue.event) === clue.slot;
    case "notAt": {
      const slot = slotOf.get(clue.event);
      return slot !== undefined && slot !== clue.slot;
    }
    case "before": {
      const first = slotOf.get(clue.before);
      const second = slotOf.get(clue.after);
      return first !== undefined && second !== undefined && first < second;
    }
    case "immediatelyBefore": {
      const first = slotOf.get(clue.before);
      const second = slotOf.get(clue.after);
      return first !== undefined && second !== undefined && second === first + 1;
    }
    case "usesResource":
      return assignment.resources[clue.event] === clue.resource;
    case "notResource": {
      const resource = assignment.resources[clue.event];
      return resource !== undefined && resource !== clue.resource;
    }
  }
}

export function schedulingViolationCount(
  clues: readonly SchedulingClue[],
  assignment: SchedulingAssignment,
): number {
  let violations = 0;
  for (const clue of clues) {
    if (!clueSatisfied(clue, assignment)) {
      violations += 1;
    }
  }
  return violations;
}

export interface SchedulingSolutions {
  readonly solutions: readonly SchedulingAssignment[];
  readonly enumeratedStates: number;
}

const RESOURCE_ZERO_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

export function solveSchedulingAssignments(
  clues: readonly SchedulingClue[],
): SchedulingSolutions {
  const perms = collectPermutations(SCHEDULING_EVENT_IDS, { maxResults: 24 });
  if (!perms.complete || perms.visited !== 24) {
    throw new SolverLimitError(24, perms.visited + 1);
  }
  const solutions: SchedulingAssignment[] = [];
  for (const order of perms.items) {
    for (const pair of RESOURCE_ZERO_PAIRS) {
      const resources: number[] = [1, 1, 1, 1];
      resources[pair[0]] = 0;
      resources[pair[1]] = 0;
      const assignment: SchedulingAssignment = { order, resources };
      if (clues.every((clue) => clueSatisfied(clue, assignment))) {
        solutions.push(assignment);
      }
    }
  }
  return { solutions, enumeratedStates: perms.visited * RESOURCE_ZERO_PAIRS.length };
}
