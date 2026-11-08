import { z } from "zod";
import {
  DESIGNER_CANDIDATE_SLOT_ID_PATTERN,
  type DesignProposal,
  type DesignerArm,
} from "../domain/design.js";
import {
  DifficultySchema,
  FamilySchema,
  type Difficulty,
  type Family,
} from "../domain/experiment.js";
import { productionRegistry } from "../families/registry.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";
import { diagnoseDesignSpec } from "./diagnostics.js";
import {
  truthSpecToRpn,
  type TruthSpec,
} from "../families/truth/schema.js";

export const DESIGNER_MOCK_SCENARIO_VERSION = "p50.1-mock-v1" as const;

export const DESIGNER_MOCK_SCENARIO_KINDS = [
  "first_accepted",
  "repair_multiple_solutions",
  "repair_unsat",
  "repair_schema_invalid",
  "all_repairs_fail",
  "repair_twice_then_accepted",
  "solver_limit",
  "render_failure",
  "generation_error",
] as const;
export type DesignerMockScenarioKind =
  (typeof DESIGNER_MOCK_SCENARIO_KINDS)[number];
export const DesignerMockScenarioKindSchema = z.enum(
  DESIGNER_MOCK_SCENARIO_KINDS,
);

export const DESIGNER_MOCK_SIMULATIONS = [
  "solver_limit",
  "render_failure",
] as const;
export type DesignerMockSimulation =
  (typeof DESIGNER_MOCK_SIMULATIONS)[number];
export const DesignerMockSimulationSchema = z.enum(DESIGNER_MOCK_SIMULATIONS);

export const DesignerMockScenarioSchema = z
  .strictObject({
    version: z.literal(DESIGNER_MOCK_SCENARIO_VERSION),
    assignmentId: z.string().min(1).max(200),
    family: FamilySchema,
    difficulty: DifficultySchema,
    arm: z.enum(["ai_one_shot", "ai_feedback"]),
    attemptIndex: z.number().int().min(0).max(2),
    kind: DesignerMockScenarioKindSchema,
    simulation: DesignerMockSimulationSchema.nullable(),
  })
  .superRefine((scenario, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (scenario.arm === "ai_one_shot" && scenario.attemptIndex !== 0) {
      issue(["attemptIndex"], "one-shot mock scenarios use attempt 0 only");
    }
    if (scenario.simulation === "solver_limit" && scenario.kind !== "solver_limit") {
      issue(["simulation"], "solver_limit simulation requires the solver_limit kind");
    }
    if (scenario.simulation === "render_failure" && scenario.kind !== "render_failure") {
      issue(["simulation"], "render_failure simulation requires the render_failure kind");
    }
    if (scenario.kind === "solver_limit" && scenario.simulation === null) {
      issue(["simulation"], "solver_limit scenarios must declare their simulation");
    }
    if (scenario.kind === "render_failure" && scenario.simulation === null) {
      issue(["simulation"], "render_failure scenarios must declare their simulation");
    }
  });
export type DesignerMockScenario = z.infer<typeof DesignerMockScenarioSchema>;

export const DesignerMockFailureSchema = z.strictObject({
  kind: z.enum(["generation_error"]),
});
export type DesignerMockFailure = z.infer<typeof DesignerMockFailureSchema>;

export interface DesignerMockAssignment {
  readonly assignmentId: string;
  readonly assignmentOrdinal: number;
  readonly family: Family;
  readonly difficulty: Difficulty;
}

export interface BuiltDesignerMockResponse {
  readonly scenario: DesignerMockScenario;
  readonly proposal: unknown | null;
  readonly failure: DesignerMockFailure | null;
}

function supportsAmbiguity(family: Family): boolean {
  return (
    family === "ranking" ||
    family === "matching" ||
    family === "scheduling" ||
    family === "truth" ||
    family === "arithmetic"
  );
}

function supportsUnsat(family: Family): boolean {
  return (
    family === "ranking" ||
    family === "matching" ||
    family === "scheduling" ||
    family === "arithmetic" ||
    family === "matrix"
  );
}

function isSvgFamily(family: Family): boolean {
  return family === "matrix" ||
    family === "transforms" ||
    family === "paths" ||
    family === "symmetry" ||
    family === "counting";
}

function baseKindForOrdinal(ordinal: number): DesignerMockScenarioKind {
  const slot = ordinal % 20;
  switch (slot) {
    case 1:
      return "repair_multiple_solutions";
    case 2:
      return "all_repairs_fail";
    case 3:
      return "repair_unsat";
    case 4:
      return "repair_schema_invalid";
    case 5:
      return "solver_limit";
    case 6:
      return "render_failure";
    case 7:
      return "generation_error";
    case 8:
      return "render_failure";
    case 9:
      return "repair_twice_then_accepted";
    case 11:
      return "generation_error";
    case 12:
      return "render_failure";
    case 13:
      return "repair_unsat";
    default:
      return "first_accepted";
  }
}

function supportedKind(
  kind: DesignerMockScenarioKind,
  family: Family,
): DesignerMockScenarioKind {
  if (
    (kind === "repair_multiple_solutions" || kind === "all_repairs_fail") &&
    !supportsAmbiguity(family)
  ) {
    return "repair_schema_invalid";
  }
  if (
    (kind === "repair_unsat" || kind === "repair_twice_then_accepted") &&
    !supportsUnsat(family)
  ) {
    return "repair_schema_invalid";
  }
  if (kind === "render_failure" && !isSvgFamily(family)) {
    return "repair_schema_invalid";
  }
  return kind;
}

function scenarioKindFor(
  assignment: DesignerMockAssignment,
  arm: Extract<DesignerArm, "ai_one_shot" | "ai_feedback">,
  attemptIndex: 0 | 1 | 2,
): DesignerMockScenarioKind {
  const base = supportedKind(
    baseKindForOrdinal(assignment.assignmentOrdinal),
    assignment.family,
  );
  if (base === "first_accepted" || base === "generation_error") {
    return base;
  }
  if (base === "all_repairs_fail") {
    return attemptIndex === 1 ? "repair_unsat" : "all_repairs_fail";
  }
  if (base === "repair_twice_then_accepted") {
    return attemptIndex === 0
      ? "repair_multiple_solutions"
      : attemptIndex === 1
        ? "repair_unsat"
        : "first_accepted";
  }
  if (arm === "ai_one_shot") {
    return base;
  }
  return attemptIndex === 0 ? base : "first_accepted";
}

export function designerMockScenarioFor(
  assignment: DesignerMockAssignment,
  arm: DesignerArm,
  attemptIndex: number,
): DesignerMockScenario | null {
  if (arm === "baseline") {
    return null;
  }
  if (attemptIndex !== 0 && attemptIndex !== 1 && attemptIndex !== 2) {
    throw new RangeError(`designer mock attempt index must be 0..2, received ${attemptIndex}`);
  }
  const kind = scenarioKindFor(assignment, arm, attemptIndex);
  const simulation =
    kind === "solver_limit"
      ? "solver_limit"
      : kind === "render_failure"
        ? "render_failure"
        : null;
  return DesignerMockScenarioSchema.parse({
    version: DESIGNER_MOCK_SCENARIO_VERSION,
    assignmentId: assignment.assignmentId,
    family: assignment.family,
    difficulty: assignment.difficulty,
    arm,
    attemptIndex,
    kind,
    simulation,
  });
}

function validProposal(
  assignment: DesignerMockAssignment,
  arm: DesignerArm,
  attemptIndex: number,
): DesignProposal {
  const engine = productionRegistry.getEngine(assignment.family);
  for (let counter = 0; counter < 64; counter += 1) {
    const seed = sha256Hex(
      canonicalJson([
        "designer-mock-valid",
        assignment.assignmentId,
        arm,
        attemptIndex,
        counter,
      ]),
    );
    let spec: unknown;
    try {
      spec = engine.generateSpec(seed, assignment.difficulty);
    } catch {
      continue;
    }
    if (
      diagnoseDesignSpec(assignment.family, assignment.difficulty, spec as never) ===
      null
    ) {
      return {
        family: assignment.family,
        difficulty: assignment.difficulty,
        spec:
          assignment.family === "truth"
            ? truthSpecToRpn(spec as TruthSpec)
            : spec,
        designIntent: null,
        presentationSkin: null,
      } as DesignProposal;
    }
  }
  throw new Error(
    `designer mock could not generate an accepted ${assignment.family} difficulty ${assignment.difficulty} proposal`,
  );
}

function ambiguousSpec(family: Family, difficulty: Difficulty): unknown {
  switch (family) {
    case "ranking":
      return {
        size: difficulty === 1 ? 4 : 5,
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          {
            kind: "notAt",
            item: difficulty === 1 ? 3 : 4,
            position: 2,
          },
        ],
      };
    case "matching":
      return {
        clues: [
          {
            kind: "same",
            left: { category: "A", item: 0 },
            right: { category: "B", item: 0 },
          },
          {
            kind: "same",
            left: { category: "A", item: 1 },
            right: { category: "B", item: 1 },
          },
          {
            kind: "same",
            left: { category: "A", item: 2 },
            right: { category: "B", item: 2 },
          },
          {
            kind: "same",
            left: { category: "A", item: 3 },
            right: { category: "B", item: 3 },
          },
        ],
      };
    case "scheduling":
      return {
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 3 },
          { kind: "usesResource", event: 0, resource: 0 },
        ],
      };
    case "truth": {
      const people = difficulty === 1 ? 3 : 4;
      return {
        people,
        exactTruthful: 1,
        statements: Array.from({ length: people }, (_value, person) => ({
          kind: "truthful",
          person,
        })),
      };
    }
    case "arithmetic":
      return {
        allDifferent: false,
        constraints: [
          { coeffs: [1, 1, 0], op: "eq", constant: 5 },
          { coeffs: [1, -1, 0], op: "eq", constant: 1 },
          { coeffs: [1, 0, 0], op: "eq", constant: 3 },
          ...(difficulty === 3
            ? [{ coeffs: [0, 0, 1], op: "lt", constant: 5 }]
            : []),
        ],
      };
    default:
      throw new Error(`no ambiguous designer mock fixture exists for ${family}`);
  }
}

function unsatSpec(family: Family, difficulty: Difficulty): unknown {
  switch (family) {
    case "ranking":
      return {
        size: difficulty === 1 ? 4 : 5,
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 0 },
        ],
      };
    case "matching":
      return {
        clues: [
          {
            kind: "different",
            left: { category: "A", item: 0 },
            right: { category: "B", item: 0 },
          },
          {
            kind: "different",
            left: { category: "A", item: 0 },
            right: { category: "B", item: 1 },
          },
          {
            kind: "different",
            left: { category: "A", item: 0 },
            right: { category: "B", item: 2 },
          },
          {
            kind: "different",
            left: { category: "A", item: 0 },
            right: { category: "B", item: 3 },
          },
        ],
      };
    case "scheduling":
      return {
        clues: [
          { kind: "before", before: 0, after: 1 },
          { kind: "before", before: 1, after: 2 },
          { kind: "before", before: 2, after: 0 },
          { kind: "usesResource", event: 0, resource: 0 },
        ],
      };
    case "arithmetic":
      return {
        allDifferent: false,
        constraints: [
          { coeffs: [1, 0, 0], op: "eq", constant: 0 },
          { coeffs: [1, 0, 0], op: "eq", constant: 1 },
          { coeffs: [1, 0, 0], op: "eq", constant: 2 },
          ...(difficulty === 3
            ? [{ coeffs: [0, 0, 1], op: "lt", constant: 5 }]
            : []),
        ],
      };
    case "matrix":
      return {
        rule: "xor",
        cells: [
          [1, 2, 0],
          [4, 3, 7],
          [5, 1, null],
        ],
      };
    default:
      throw new Error(`no unsatisfiable designer mock fixture exists for ${family}`);
  }
}

function schemaInvalidProposal(assignment: DesignerMockAssignment): unknown {
  return {
    family: assignment.family,
    difficulty: assignment.difficulty,
    spec: {},
    designIntent: null,
    presentationSkin: null,
  };
}

export function buildDesignerMockResponse(
  scenario: DesignerMockScenario,
): BuiltDesignerMockResponse {
  const assignment: DesignerMockAssignment = {
    assignmentId: scenario.assignmentId,
    assignmentOrdinal: 0,
    family: scenario.family,
    difficulty: scenario.difficulty,
  };
  switch (scenario.kind) {
    case "generation_error":
      return {
        scenario,
        proposal: null,
        failure: { kind: "generation_error" },
      };
    case "first_accepted":
      return {
        scenario,
        proposal: validProposal(
          assignment,
          scenario.arm,
          scenario.attemptIndex,
        ),
        failure: null,
      };
    case "repair_schema_invalid":
      return {
        scenario,
        proposal: schemaInvalidProposal(assignment),
        failure: null,
      };
    case "repair_multiple_solutions":
    case "all_repairs_fail":
      return {
        scenario,
        proposal: {
          family: assignment.family,
          difficulty: assignment.difficulty,
          spec:
            assignment.family === "truth"
              ? truthSpecToRpn(
                  ambiguousSpec(assignment.family, assignment.difficulty) as TruthSpec,
                )
              : ambiguousSpec(assignment.family, assignment.difficulty),
          designIntent: null,
          presentationSkin: null,
        },
        failure: null,
      };
    case "repair_unsat":
      return {
        scenario,
        proposal: {
          family: assignment.family,
          difficulty: assignment.difficulty,
          spec:
            assignment.family === "truth"
              ? truthSpecToRpn(
                  unsatSpec(assignment.family, assignment.difficulty) as TruthSpec,
                )
              : unsatSpec(assignment.family, assignment.difficulty),
          designIntent: null,
          presentationSkin: null,
        },
        failure: null,
      };
    case "repair_twice_then_accepted":
      return {
        scenario,
        proposal: {
          family: assignment.family,
          difficulty: assignment.difficulty,
          spec:
            assignment.family === "truth"
              ? truthSpecToRpn(
                  unsatSpec(assignment.family, assignment.difficulty) as TruthSpec,
                )
              : unsatSpec(assignment.family, assignment.difficulty),
          designIntent: null,
          presentationSkin: null,
        },
        failure: null,
      };
    case "solver_limit":
    case "render_failure":
      return {
        scenario,
        proposal: validProposal(
          assignment,
          scenario.arm,
          scenario.attemptIndex,
        ),
        failure: null,
      };
  }
}

export function designerMockScenarioKey(scenario: DesignerMockScenario): string {
  return [
    scenario.assignmentId,
    scenario.arm,
    String(scenario.attemptIndex),
  ].join(":");
}

export function designerMockSlotIdForScenario(
  scenario: DesignerMockScenario,
): string {
  const slotId = `${scenario.assignmentId}-${scenario.arm}`;
  if (!DESIGNER_CANDIDATE_SLOT_ID_PATTERN.test(slotId)) {
    throw new Error(`designer mock scenario has an invalid slot ID: ${slotId}`);
  }
  return slotId;
}
