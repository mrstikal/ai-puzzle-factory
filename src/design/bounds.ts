import {
  D4_OPERATIONS,
  type D4Operation,
} from "../families/contracts.js";
import {
  knownOccupiedCells,
  symmetryKnownComponents,
} from "../families/symmetry/schema.js";
import { composeD4Sequence } from "../families/transforms/schema.js";
import {
  containsBinary,
  containsXor,
} from "../families/truth/schema.js";
import type { FamilySpec, FamilySpecByFamily } from "../domain/spec.js";
import type { Difficulty, Family } from "../domain/experiment.js";

export interface DesignerBoundsIssue {
  readonly path: string;
  readonly message: string;
}

export class DesignerBoundsError extends Error {
  readonly code = "OUT_OF_BOUNDS" as const;
  readonly issues: readonly DesignerBoundsIssue[];

  constructor(issues: readonly DesignerBoundsIssue[]) {
    super(
      issues.length === 0
        ? "designer bounds are invalid"
        : `designer bounds are invalid: ${issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")}`,
    );
    this.name = "DesignerBoundsError";
    this.issues = issues;
  }
}

export interface DesignerBoundsBrief {
  readonly family: Family;
  readonly difficulty: Difficulty;
  readonly globalBounds: readonly string[];
  readonly levelRules: readonly string[];
  readonly allowedOperators: readonly string[];
}

const GLOBAL_BOUNDS: Readonly<Record<Family, readonly string[]>> = {
  ranking: [
    "size is 4 or 5",
    "3-12 clues",
    "item IDs are 0..size-1",
    "positions are 1..size",
    "no self-relations",
  ],
  matching: [
    "three typed categories A/B/C with four items each",
    "4-12 same/different clues between different categories",
    "no duplicate or contradictory clue pairs",
  ],
  scheduling: [
    "four events, four ordered consecutive slots",
    "two resources used exactly twice each",
    "4-12 clues",
    "no duplicate or contradictory clues",
  ],
  truth: [
    "3 or 4 people",
    "one statement per person",
    "exactTruthful is 1..N-1",
    "AST depth at most 2, at most 3 leaves, at most 7 nodes",
  ],
  arithmetic: [
    "x, y, z are integers in 0..12",
    "2-5 linear constraints",
    "coefficients -3..3 and not all zero",
    "constants -108..108",
    "explicit allDifferent boolean",
  ],
  matrix: [
    "3x3 matrix of four-bit masks 0..15",
    "bottom-right cell is absent",
    "rule is xor",
    "eight visible cells",
  ],
  transforms: [
    "5x5 binary source",
    "4-8 orthogonally connected occupied cells",
    "one or two D4 operations",
  ],
  paths: [
    "4x4 grid",
    "6-12 active cells",
    "exactly activeCells-1 open orthogonal edges",
    "connected tree",
    "distinct start and goal",
  ],
  symmetry: [
    "8x8 binary tile",
    "axis is vertical or horizontal",
    "known half has 4-10 occupied cells",
    "missing half uses the unknown state",
  ],
  counting: [
    "5x5 universe",
    "2-3 distinct orthogonally connected shapes of 3-8 cells",
    "at least one overlap and one exclusive cell",
    "query operation and k within the shape count",
  ],
};

const ALLOWED_OPERATORS: Readonly<Record<Family, readonly string[]>> = {
  ranking: ["before", "immediatelyBefore", "at", "notAt"],
  matching: ["same", "different"],
  scheduling: [
    "at",
    "notAt",
    "before",
    "immediatelyBefore",
    "usesResource",
    "notResource",
  ],
  truth: ["truthful(person)", "not", "and", "or", "xor"],
  arithmetic: ["eq", "lt", "le"],
  matrix: ["xor"],
  transforms: D4_OPERATIONS,
  paths: ["active cell", "open edge", "start", "goal"],
  symmetry: ["vertical", "horizontal", "occupied", "empty", "unknown"],
  counting: [
    "unionCount",
    "intersectionAll",
    "exactlyOneShape",
    "exactlyKShapes(k)",
  ],
};

const LEVEL_ONE_ROTATIONS = new Set<D4Operation>([
  "rotate90",
  "rotate180",
  "rotate270",
]);
const QUARTER_TURNS = new Set<D4Operation>(["rotate90", "rotate270"]);
const REFLECTIONS = new Set<D4Operation>([
  "reflectLeftRight",
  "reflectTopBottom",
  "reflectMainDiagonal",
  "reflectAntiDiagonal",
]);

function levelRulesFor(
  family: Family,
  difficulty: Difficulty,
): readonly string[] {
  switch (family) {
    case "ranking":
      return difficulty === 1
        ? ["size 4", "no anchor recipe or clue-count floor beyond the global 3-12"]
        : ["size 5", "no anchor recipe or clue-count floor beyond the global 3-12"];
    case "matching":
      return [
        "all levels use the same three-category, four-item structure and the global 4-12 clue bound",
        "difficulty is a requested target; no additional structural admission proxy is applied",
      ];
    case "scheduling":
      return [
        "all levels use the same four events, four slots, two resources, and the global 4-12 clue bound",
        "difficulty is a requested target; no additional structural admission proxy is applied",
      ];
    case "truth":
      return difficulty === 1
        ? [
            "3 people",
            "at most one statement containing a binary operator",
            "xor is forbidden",
          ]
        : difficulty === 2
          ? ["4 people", "and/or are allowed", "xor is forbidden"]
          : ["4 people", "and/or/xor are allowed"];
    case "arithmetic":
      return difficulty === 1
        ? ["maximum absolute coefficient 1"]
        : difficulty === 2
          ? ["maximum absolute coefficient 2"]
          : [
              "maximum absolute coefficient 3",
              "at least one inequality (lt/le) must be present",
              "inequality nonredundancy is checked after solving",
            ];
    case "matrix":
      return [
        "global XOR/mask/observation bounds apply at every level",
        "difficulty is a requested target; no additional structural admission proxy is applied",
      ];
    case "transforms":
      return difficulty === 1
        ? ["exactly one nonidentity rotation"]
        : difficulty === 2
          ? ["exactly one reflection"]
          : [
              "exactly two ordered operations",
              "one quarter-turn rotation and one reflection",
              "the two operations must not commute",
            ];
    case "paths":
      return [
        "active cells remain 6-12 at every level",
        `the independently solved route target is ${
          difficulty === 1 ? "3-5" : difficulty === 2 ? "5-7" : "7-11"
        } edges`,
        "route length is checked after solving",
      ];
    case "symmetry":
      return difficulty === 1
        ? ["vertical axis"]
        : difficulty === 2
          ? ["horizontal axis"]
          : [
              "either axis",
              "at least two distinct orthogonal-connectivity components in the known occupied cells",
            ];
    case "counting":
      return difficulty === 1
        ? ["two shapes", "unionCount"]
        : difficulty === 2
          ? ["two shapes", "intersectionAll or exactlyOneShape"]
          : ["three shapes", "intersectionAll or exactlyKShapes"];
  }
}

export function designerBoundsBrief(
  family: Family,
  difficulty: Difficulty,
): DesignerBoundsBrief {
  return {
    family,
    difficulty,
    globalBounds: GLOBAL_BOUNDS[family],
    levelRules: levelRulesFor(family, difficulty),
    allowedOperators: ALLOWED_OPERATORS[family],
  };
}

function pushIssue(
  issues: DesignerBoundsIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

export function assertDesignerBounds(
  family: Family,
  difficulty: Difficulty,
  spec: FamilySpec,
): void {
  const issues: DesignerBoundsIssue[] = [];
  switch (family) {
    case "ranking": {
      const ranking = spec as FamilySpecByFamily["ranking"];
      const expectedSize = difficulty === 1 ? 4 : 5;
      if (ranking.size !== expectedSize) {
        pushIssue(
          issues,
          "size",
          `level ${difficulty} requires size ${expectedSize}, received ${ranking.size}`,
        );
      }
      break;
    }
    case "matching":
      break;
    case "scheduling":
      break;
    case "truth": {
      const truth = spec as FamilySpecByFamily["truth"];
      const expectedPeople = difficulty === 1 ? 3 : 4;
      if (truth.people !== expectedPeople) {
        pushIssue(
          issues,
          "people",
          `level ${difficulty} requires ${expectedPeople} people, received ${truth.people}`,
        );
      }
      if (difficulty === 1) {
        const binaryStatements = truth.statements.filter((statement) =>
          containsBinary(statement),
        ).length;
        if (binaryStatements > 1) {
          pushIssue(
            issues,
            "statements",
            `level 1 permits at most one binary statement, received ${binaryStatements}`,
          );
        }
      }
      if (difficulty !== 3) {
        const xorStatements = truth.statements.filter((statement) =>
          containsXor(statement),
        ).length;
        if (xorStatements > 0) {
          pushIssue(
            issues,
            "statements",
            `level ${difficulty} forbids xor, received ${xorStatements} xor statements`,
          );
        }
      }
      break;
    }
    case "arithmetic": {
      const arithmetic = spec as FamilySpecByFamily["arithmetic"];
      const maxCoefficient = Math.max(
        ...arithmetic.constraints.flatMap((constraint) =>
          constraint.coeffs.map((coefficient) => Math.abs(coefficient)),
        ),
      );
      if (maxCoefficient > difficulty) {
        pushIssue(
          issues,
          "constraints",
          `level ${difficulty} permits maximum absolute coefficient ${difficulty}, received ${maxCoefficient}`,
        );
      }
      if (
        difficulty === 3 &&
        !arithmetic.constraints.some(
          (constraint) => constraint.op === "lt" || constraint.op === "le",
        )
      ) {
        pushIssue(
          issues,
          "constraints",
          "level 3 requires at least one inequality (lt/le)",
        );
      }
      break;
    }
    case "matrix":
      break;
    case "transforms": {
      const transforms = spec as FamilySpecByFamily["transforms"];
      if (difficulty === 1) {
        if (transforms.operations.length !== 1) {
          pushIssue(
            issues,
            "operations",
            `level 1 requires exactly one operation, received ${transforms.operations.length}`,
          );
        } else {
          const operation = transforms.operations[0];
          if (operation === undefined || !LEVEL_ONE_ROTATIONS.has(operation)) {
            pushIssue(
              issues,
              "operations",
              `level 1 requires a nonidentity rotation, received ${String(operation)}`,
            );
          }
        }
      } else if (difficulty === 2) {
        if (transforms.operations.length !== 1) {
          pushIssue(
            issues,
            "operations",
            `level 2 requires exactly one operation, received ${transforms.operations.length}`,
          );
        } else {
          const operation = transforms.operations[0];
          if (operation === undefined || !REFLECTIONS.has(operation)) {
            pushIssue(
              issues,
              "operations",
              `level 2 requires a reflection, received ${String(operation)}`,
            );
          }
        }
      } else {
        if (transforms.operations.length !== 2) {
          pushIssue(
            issues,
            "operations",
            `level 3 requires exactly two operations, received ${transforms.operations.length}`,
          );
        } else {
          const first = transforms.operations[0];
          const second = transforms.operations[1];
          if (
            first === undefined ||
            second === undefined ||
            !(
              (QUARTER_TURNS.has(first) && REFLECTIONS.has(second)) ||
              (REFLECTIONS.has(first) && QUARTER_TURNS.has(second))
            )
          ) {
            pushIssue(
              issues,
              "operations",
              "level 3 requires one quarter-turn rotation and one reflection",
            );
          } else if (
            composeD4Sequence([first, second]) ===
            composeD4Sequence([second, first])
          ) {
            pushIssue(
              issues,
              "operations",
              "level 3 operations must not commute",
            );
          }
        }
      }
      break;
    }
    case "paths":
      break;
    case "symmetry": {
      const symmetry = spec as FamilySpecByFamily["symmetry"];
      if (difficulty === 1 && symmetry.axis !== "vertical") {
        pushIssue(
          issues,
          "axis",
          `level 1 requires the vertical axis, received ${symmetry.axis}`,
        );
      }
      if (difficulty === 2 && symmetry.axis !== "horizontal") {
        pushIssue(
          issues,
          "axis",
          `level 2 requires the horizontal axis, received ${symmetry.axis}`,
        );
      }
      if (difficulty === 3) {
        const components = symmetryKnownComponents(
          symmetry.axis,
          knownOccupiedCells(symmetry),
        );
        if (components < 2) {
          pushIssue(
            issues,
            "cells",
            `level 3 requires at least two known occupied components, received ${components}`,
          );
        }
      }
      break;
    }
    case "counting": {
      const counting = spec as FamilySpecByFamily["counting"];
      const expectedShapes = difficulty === 3 ? 3 : 2;
      if (counting.shapes.length !== expectedShapes) {
        pushIssue(
          issues,
          "shapes",
          `level ${difficulty} requires ${expectedShapes} shapes, received ${counting.shapes.length}`,
        );
      }
      const allowed =
        difficulty === 1
          ? new Set(["unionCount"])
          : difficulty === 2
            ? new Set(["intersectionAll", "exactlyOneShape"])
            : new Set(["intersectionAll", "exactlyKShapes"]);
      if (!allowed.has(counting.query.operation)) {
        pushIssue(
          issues,
          "query.operation",
          `level ${difficulty} does not allow ${counting.query.operation}`,
        );
      }
      break;
    }
  }
  if (issues.length > 0) {
    throw new DesignerBoundsError(issues);
  }
}
