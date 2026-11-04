import {
  SolverLimitError,
  collectPermutations,
  compareCanonicalStrings,
  minimizeOverCartesianProduct,
  reduceClueCore,
  sortedCanonicalTokens,
} from "../canonicalize.js";
import {
  CanonicalStructureSchema,
  type CanonicalStructure,
} from "../contracts.js";
import {
  SCHEDULING_EVENT_IDS,
  SCHEDULING_RESOURCE_IDS,
  SchedulingSpecSchema,
  assignmentToTable,
  clueKey,
  solveSchedulingAssignments,
  type SchedulingClue,
  type SchedulingSpec,
} from "./schema.js";

const CLUE_LIST_SEPARATOR = "\u0000";
const RELABELING_COUNT = 24 * 2;

function itemMapping(permutation: readonly number[]): ReadonlyMap<number, number> {
  const mapping = new Map<number, number>();
  for (const [oldItem, newItem] of permutation.entries()) {
    mapping.set(oldItem, newItem);
  }
  return mapping;
}

function relabelClue(
  clue: SchedulingClue,
  eventMapping: ReadonlyMap<number, number>,
  resourceMapping: ReadonlyMap<number, number>,
): SchedulingClue {
  const event = (value: number): number => {
    const mapped = eventMapping.get(value);
    if (mapped === undefined) {
      throw new RangeError(`scheduling relabeling has no target for event ${value}`);
    }
    return mapped;
  };
  const resource = (value: number): number => {
    const mapped = resourceMapping.get(value);
    if (mapped === undefined) {
      throw new RangeError(`scheduling relabeling has no target for resource ${value}`);
    }
    return mapped;
  };
  switch (clue.kind) {
    case "at":
      return { kind: "at", event: event(clue.event), slot: clue.slot };
    case "notAt":
      return { kind: "notAt", event: event(clue.event), slot: clue.slot };
    case "before":
      return { kind: "before", before: event(clue.before), after: event(clue.after) };
    case "immediatelyBefore":
      return {
        kind: "immediatelyBefore",
        before: event(clue.before),
        after: event(clue.after),
      };
    case "usesResource":
      return {
        kind: "usesResource",
        event: event(clue.event),
        resource: resource(clue.resource),
      };
    case "notResource":
      return {
        kind: "notResource",
        event: event(clue.event),
        resource: resource(clue.resource),
      };
  }
}

export function schedulingClueListKey(clues: readonly SchedulingClue[]): string {
  return clues.map(clueKey).join(CLUE_LIST_SEPARATOR);
}

function eventPermutations(): readonly (readonly number[])[] {
  const collected = collectPermutations(SCHEDULING_EVENT_IDS, { maxResults: 24 });
  if (!collected.complete || collected.visited !== 24) {
    throw new SolverLimitError(24, collected.visited + 1);
  }
  return collected.items;
}

function resourcePermutations(): readonly (readonly number[])[] {
  const collected = collectPermutations(SCHEDULING_RESOURCE_IDS, { maxResults: 2 });
  if (!collected.complete || collected.visited !== 2) {
    throw new SolverLimitError(2, collected.visited + 1);
  }
  return collected.items;
}

export function canonicalizeSchedulingClues(
  clues: readonly SchedulingClue[],
): readonly SchedulingClue[] {
  const events = eventPermutations();
  const resources = resourcePermutations();
  const minimized = minimizeOverCartesianProduct(
    [events, resources],
    (combination) => {
      const eventPermutation = combination[0];
      const resourcePermutation = combination[1];
      if (eventPermutation === undefined || resourcePermutation === undefined) {
        throw new RangeError("scheduling relabeling combination is incomplete");
      }
      const eventMapping = itemMapping(eventPermutation);
      const resourceMapping = itemMapping(resourcePermutation);
      return [...clues.map((clue) => relabelClue(clue, eventMapping, resourceMapping))].sort(
        (left, right) => compareCanonicalStrings(clueKey(left), clueKey(right)),
      );
    },
    (left, right) =>
      compareCanonicalStrings(
        schedulingClueListKey(left),
        schedulingClueListKey(right),
      ),
    { maxResults: RELABELING_COUNT },
  );
  if (minimized.best === null || !minimized.complete) {
    throw new SolverLimitError(RELABELING_COUNT, minimized.visited + 1);
  }
  return minimized.best;
}

export function canonicalizeSchedulingSpec(spec: SchedulingSpec): CanonicalStructure {
  const parsed = SchedulingSpecSchema.parse(spec);
  const core = reduceClueCore({
    clues: parsed.clues,
    normalize: canonicalizeSchedulingClues,
    clueKey,
    solve: (clues) => {
      const solved = solveSchedulingAssignments(clues);
      if (solved.solutions.length !== 1) {
        return { solutionCount: solved.solutions.length, answerKey: "" };
      }
      const solution = solved.solutions[0];
      if (solution === undefined) {
        return { solutionCount: 0, answerKey: "" };
      }
      const table = assignmentToTable(solution);
      return {
        solutionCount: 1,
        answerKey: table
          .map((row) => `${row.event}-${row.slot}-${row.resource}`)
          .join("|"),
      };
    },
    maxEvaluations: 32,
  });

  return CanonicalStructureSchema.parse({
    version: 1,
    family: "scheduling",
    domainTokens: ["capacities=2,2", "events=4", "slots=4"],
    queryKind: "full_schedule",
    queryTokens: [],
    relationTokens: sortedCanonicalTokens(core.retained.map(clueKey)),
    geometryTokens: [],
  });
}
