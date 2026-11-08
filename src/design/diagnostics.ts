import { z } from "zod";
import { SolverLimitError } from "../families/canonicalize.js";
import {
  ArithmeticSpecSchema,
  solveArithmetic,
} from "../families/arithmetic/schema.js";
import { arithmeticEngine, diagnoseArithmeticSolutions } from "../families/arithmetic/engine.js";
import { countingEngine } from "../families/counting/engine.js";
import { diagnoseMatchingSolutions, matchingEngine } from "../families/matching/engine.js";
import { diagnoseMatrixSolutions, matrixEngine } from "../families/matrix/engine.js";
import { pathsEngine } from "../families/paths/engine.js";
import { diagnoseRankingSolutions, rankingEngine } from "../families/ranking/engine.js";
import { diagnoseSchedulingSolutions, schedulingEngine } from "../families/scheduling/engine.js";
import { symmetryEngine } from "../families/symmetry/engine.js";
import { diagnoseTruthSolutions, truthEngine } from "../families/truth/engine.js";
import { transformsEngine } from "../families/transforms/engine.js";
import type {
  FamilySolutionDiagnostics,
  SolveResult,
} from "../families/contracts.js";
import {
  DesignerBoundsError,
  assertDesignerBounds,
} from "./bounds.js";
import type { FamilySpec, FamilySpecByFamily } from "../domain/spec.js";
import type { Difficulty, Family } from "../domain/experiment.js";
import { canonicalJson, sha256Hex } from "../util/hash.js";

export const DESIGN_DIAGNOSTIC_CODES = [
  "SCHEMA_INVALID",
  "BOUNDS_INVALID",
  "FORBIDDEN_CONTENT",
  "SKIN_INVALID",
  "UNSAT",
  "MULTIPLE_SOLUTIONS",
  "MULTIPLE_ANSWERS",
  "SOLVER_LIMIT",
  "LEVEL_RULE_FAILED",
  "DUPLICATE_OPTION",
  "OPTIONS_INSUFFICIENT",
  "OPTIONS_NOT_DISTINCT",
  "SVG_RENDER_INVALID",
  "VISUAL_AMBIGUITY",
  "PRESENTATION_INVALID",
  "INPUT_TOO_LARGE",
  "BASELINE_CONSTRUCTION_FAILED",
  "GENERATION_ERROR",
  "INFRASTRUCTURE_ERROR",
  "REPAIR_REPLAY",
  "PENDING_CHECKS",
] as const;
export type DesignDiagnosticCode =
  (typeof DESIGN_DIAGNOSTIC_CODES)[number];
export const DesignDiagnosticCodeSchema = z.enum(DESIGN_DIAGNOSTIC_CODES);

export const DESIGN_FIX_KINDS = [
  "add_relation",
  "remove_relation",
  "replace_relation",
  "change_parameter",
  "change_geometry",
  "change_query",
  "change_skin",
] as const;
export type DesignFixKind = (typeof DESIGN_FIX_KINDS)[number];
export const DesignFixKindSchema = z.enum(DESIGN_FIX_KINDS);

export const DESIGN_PENDING_CHECKS = [
  "options",
  "render",
  "presentation",
] as const;
export type DesignPendingCheck = (typeof DESIGN_PENDING_CHECKS)[number];
export const DesignPendingCheckSchema = z.enum(DESIGN_PENDING_CHECKS);

export const DESIGN_EVIDENCE_SOURCES = [
  "deterministic",
  "input",
  "infrastructure",
] as const;
export type DesignEvidenceSource =
  (typeof DESIGN_EVIDENCE_SOURCES)[number];
export const DesignEvidenceSourceSchema = z.enum(DESIGN_EVIDENCE_SOURCES);

export const DesignOptionDiagnosticSchema = z.strictObject({
  code: z.enum([
    "INSUFFICIENT_OPTIONS",
    "NON_DISTINCT_OPTIONS",
    "DUPLICATE_OPTION",
  ]),
  message: z.string().min(1).max(500),
  optionCount: z.number().int().nonnegative().nullable(),
  distinctCount: z.number().int().nonnegative().nullable(),
});
export type DesignOptionDiagnostic = z.infer<
  typeof DesignOptionDiagnosticSchema
>;

export const DesignRenderDiagnosticSchema = z.strictObject({
  code: z.enum(["RENDER_INVALID", "VISUAL_AMBIGUITY"]),
  message: z.string().min(1).max(500),
  family: z.enum([
    "ranking",
    "matching",
    "scheduling",
    "truth",
    "arithmetic",
    "matrix",
    "transforms",
    "paths",
    "symmetry",
    "counting",
  ]).nullable(),
});
export type DesignRenderDiagnostic = z.infer<
  typeof DesignRenderDiagnosticSchema
>;

export const DesignDiagnosticIssueSchema = z.strictObject({
  path: z.string().min(1).max(500),
  message: z.string().min(1).max(2_000),
});
export type DesignDiagnosticIssue = z.infer<
  typeof DesignDiagnosticIssueSchema
>;

export const DesignDiagnosticFeatureSchema = z.strictObject({
  name: z.string().min(1).max(100),
  value: z.union([
    z.string().max(500),
    z.number(),
    z.boolean(),
    z.null(),
  ]),
});
export type DesignDiagnosticFeature = z.infer<
  typeof DesignDiagnosticFeatureSchema
>;

export const DesignDiagnosticSchema = z
  .strictObject({
    errorCode: DesignDiagnosticCodeSchema,
    evidenceSource: DesignEvidenceSourceSchema,
    solutionCount: z.number().int().nonnegative().nullable(),
    witnesses: z.array(z.unknown()).max(2),
    features: z.array(DesignDiagnosticFeatureSchema).max(32),
    issues: z.array(DesignDiagnosticIssueSchema).max(32),
    schemaPath: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(2_000).nullable(),
    stateCount: z.number().int().nonnegative().nullable(),
    limit: z.number().int().positive().nullable(),
    optionDiagnostic: DesignOptionDiagnosticSchema.nullable(),
    renderDiagnostic: DesignRenderDiagnosticSchema.nullable(),
    pendingChecks: z.array(DesignPendingCheckSchema).max(DESIGN_PENDING_CHECKS.length),
    allowedFixKinds: z.array(DesignFixKindSchema).max(DESIGN_FIX_KINDS.length),
  })
  .superRefine((diagnostic, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    if (new Set(diagnostic.allowedFixKinds).size !== diagnostic.allowedFixKinds.length) {
      issue(["allowedFixKinds"], "allowed fix kinds must be distinct");
    }
    if (new Set(diagnostic.pendingChecks).size !== diagnostic.pendingChecks.length) {
      issue(["pendingChecks"], "pending checks must be distinct");
    }
    if (
      new Set(diagnostic.features.map((feature) => feature.name)).size !==
      diagnostic.features.length
    ) {
      issue(["features"], "observed feature names must be distinct");
    }
    if (
      (diagnostic.errorCode === "SCHEMA_INVALID" ||
        diagnostic.errorCode === "BOUNDS_INVALID") &&
      diagnostic.issues.length === 0
    ) {
      issue(["issues"], "schema and bounds failures require at least one issue");
    }
    if (
      diagnostic.errorCode === "PENDING_CHECKS" &&
      diagnostic.pendingChecks.length === 0
    ) {
      issue(["pendingChecks"], "PENDING_CHECKS requires at least one pending check");
    }
    if (
      diagnostic.errorCode !== "PENDING_CHECKS" &&
      diagnostic.pendingChecks.length > 0
    ) {
      issue(["pendingChecks"], "only PENDING_CHECKS may carry pending checks");
    }
    switch (diagnostic.errorCode) {
      case "SCHEMA_INVALID":
      case "BOUNDS_INVALID":
        if (diagnostic.schemaPath === null || diagnostic.message === null) {
          issue(["schemaPath"], "schema and bounds failures require a path and message");
        }
        break;
      case "MULTIPLE_SOLUTIONS":
        if (
          diagnostic.solutionCount === null ||
          diagnostic.solutionCount < 2 ||
          diagnostic.witnesses.length !== 2
        ) {
          issue(
            ["witnesses"],
            "multiple solutions require a known count and exactly two witnesses",
          );
        }
        if (diagnostic.evidenceSource !== "deterministic") {
          issue(["evidenceSource"], "ambiguity evidence must be deterministic");
        }
        break;
      case "MULTIPLE_ANSWERS":
        if (
          diagnostic.solutionCount === null ||
          diagnostic.witnesses.length !== 2
        ) {
          issue(
            ["witnesses"],
            "multiple answers require a known solution count and exactly two witnesses",
          );
        }
        if (diagnostic.evidenceSource !== "deterministic") {
          issue(["evidenceSource"], "ambiguity evidence must be deterministic");
        }
        break;
      case "SOLVER_LIMIT":
        if (diagnostic.stateCount === null || diagnostic.limit === null) {
          issue(["stateCount"], "solver-limit evidence requires stateCount and limit");
        }
        break;
      case "DUPLICATE_OPTION":
      case "OPTIONS_INSUFFICIENT":
      case "OPTIONS_NOT_DISTINCT":
        if (diagnostic.optionDiagnostic === null) {
          issue(["optionDiagnostic"], "option failures require option evidence");
        }
        break;
      case "SVG_RENDER_INVALID":
      case "VISUAL_AMBIGUITY":
      case "PRESENTATION_INVALID":
        if (diagnostic.renderDiagnostic === null) {
          issue(["renderDiagnostic"], "render failures require render evidence");
        }
        break;
      case "UNSAT":
      case "LEVEL_RULE_FAILED":
        if (diagnostic.message === null) {
          issue(["message"], `${diagnostic.errorCode} requires a message`);
        }
        break;
      case "FORBIDDEN_CONTENT":
      case "SKIN_INVALID":
      case "INPUT_TOO_LARGE":
      case "BASELINE_CONSTRUCTION_FAILED":
      case "GENERATION_ERROR":
      case "INFRASTRUCTURE_ERROR":
      case "REPAIR_REPLAY":
      case "PENDING_CHECKS":
        if (diagnostic.message === null) {
          issue(["message"], "PENDING_CHECKS requires a message");
        }
        break;
    }
    if (
      (diagnostic.errorCode === "GENERATION_ERROR" ||
        diagnostic.errorCode === "INFRASTRUCTURE_ERROR" ||
        diagnostic.errorCode === "PENDING_CHECKS") &&
      diagnostic.allowedFixKinds.length > 0
    ) {
      issue(
        ["allowedFixKinds"],
        "terminal infrastructure failures cannot authorize a design repair",
      );
    }
  });

export type DesignDiagnostic = z.infer<typeof DesignDiagnosticSchema>;

export function computeDesignDiagnosticHash(
  diagnostic: DesignDiagnostic,
): string {
  return sha256Hex(canonicalJson(diagnostic));
}

export const DesignCheckStatusSchema = z.enum(["passed", "failed", "pending"]);
export type DesignCheckStatus = z.infer<typeof DesignCheckStatusSchema>;

export const DesignCheckEvidenceSchema = z
  .strictObject({
    status: DesignCheckStatusSchema,
    diagnostic: DesignDiagnosticSchema.nullable(),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.status === "failed" && evidence.diagnostic === null) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostic"],
        message: "a failed check requires a diagnostic",
      });
    }
    if (evidence.status !== "failed" && evidence.diagnostic !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostic"],
        message: "only a failed check carries a diagnostic",
      });
    }
  });
export type DesignCheckEvidence = z.infer<typeof DesignCheckEvidenceSchema>;

export const DesignDownstreamEvidenceSchema = z.strictObject({
  options: DesignCheckEvidenceSchema,
  render: DesignCheckEvidenceSchema,
  presentation: DesignCheckEvidenceSchema,
});
export type DesignDownstreamEvidence = z.infer<
  typeof DesignDownstreamEvidenceSchema
>;

export function pendingDownstreamEvidence(): DesignDownstreamEvidence {
  return {
    options: { status: "pending", diagnostic: null },
    render: { status: "pending", diagnostic: null },
    presentation: { status: "pending", diagnostic: null },
  };
}

export function passedDownstreamEvidence(): DesignDownstreamEvidence {
  return {
    options: { status: "passed", diagnostic: null },
    render: { status: "passed", diagnostic: null },
    presentation: { status: "passed", diagnostic: null },
  };
}

type DiagnosticInput = Omit<
  DesignDiagnostic,
  | "witnesses"
  | "features"
  | "issues"
  | "schemaPath"
  | "message"
  | "stateCount"
  | "limit"
  | "optionDiagnostic"
  | "renderDiagnostic"
  | "pendingChecks"
  | "allowedFixKinds"
> & {
  readonly witnesses?: readonly unknown[];
  readonly features?: readonly DesignDiagnosticFeature[];
  readonly issues?: readonly DesignDiagnosticIssue[];
  readonly schemaPath?: string | null;
  readonly message?: string | null;
  readonly stateCount?: number | null;
  readonly limit?: number | null;
  readonly optionDiagnostic?: DesignOptionDiagnostic | null;
  readonly renderDiagnostic?: DesignRenderDiagnostic | null;
  readonly pendingChecks?: readonly DesignPendingCheck[];
  readonly allowedFixKinds?: readonly DesignFixKind[];
};

function diagnostic(input: DiagnosticInput): DesignDiagnostic {
  return DesignDiagnosticSchema.parse({
    witnesses: [...(input.witnesses ?? [])],
    features: [...(input.features ?? [])],
    issues: [...(input.issues ?? [])],
    schemaPath: input.schemaPath ?? null,
    message: input.message ?? null,
    stateCount: input.stateCount ?? null,
    limit: input.limit ?? null,
    optionDiagnostic: input.optionDiagnostic ?? null,
    renderDiagnostic: input.renderDiagnostic ?? null,
    pendingChecks: [...(input.pendingChecks ?? [])],
    allowedFixKinds: [...(input.allowedFixKinds ?? [])],
    errorCode: input.errorCode,
    evidenceSource: input.evidenceSource,
    solutionCount: input.solutionCount,
  });
}

const GENERIC_REPAIR_FIXES: DesignFixKind[] = [
  "add_relation",
  "remove_relation",
  "replace_relation",
  "change_parameter",
  "change_geometry",
  "change_query",
];

export function diagnoseSchemaFailure(
  error: z.ZodError,
): DesignDiagnostic {
  const issues = error.issues.slice(0, 32).map((issue) => ({
    path:
      issue.path.length === 0 ? "<root>" : issue.path.map(String).join("."),
    message: issue.message,
  }));
  const first = issues[0];
  return diagnostic({
    errorCode: "SCHEMA_INVALID",
    evidenceSource: "input",
    solutionCount: null,
    schemaPath: first?.path ?? "<root>",
    message: first?.message ?? "schema validation failed",
    issues,
    allowedFixKinds: GENERIC_REPAIR_FIXES,
  });
}

export function diagnoseBoundsFailure(
  error: DesignerBoundsError,
): DesignDiagnostic {
  const issues = error.issues.slice(0, 32).map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));
  const first = issues[0];
  return diagnostic({
    errorCode: "BOUNDS_INVALID",
    evidenceSource: "input",
    solutionCount: null,
    schemaPath: first?.path ?? "<root>",
    message: first?.message ?? error.message,
    issues,
    allowedFixKinds: GENERIC_REPAIR_FIXES,
  });
}

export function diagnoseSolverLimit(
  error: SolverLimitError,
): DesignDiagnostic {
  return diagnostic({
    errorCode: "SOLVER_LIMIT",
    evidenceSource: "deterministic",
    solutionCount: null,
    stateCount: error.attempted,
    limit: error.limit,
    message: error.message,
    allowedFixKinds: GENERIC_REPAIR_FIXES,
  });
}

export function diagnoseInfrastructureFailure(
  error: unknown,
): DesignDiagnostic {
  return diagnostic({
    errorCode: "INFRASTRUCTURE_ERROR",
    evidenceSource: "infrastructure",
    solutionCount: null,
    message:
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "unexpected infrastructure failure",
  });
}

export function diagnoseGenerationError(
  error: unknown,
): DesignDiagnostic {
  return diagnostic({
    errorCode: "GENERATION_ERROR",
    evidenceSource: "infrastructure",
    solutionCount: null,
    message:
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "model generation failed",
  });
}

export function diagnoseInputTooLarge(message: string): DesignDiagnostic {
  return diagnostic({
    errorCode: "INPUT_TOO_LARGE",
    evidenceSource: "input",
    solutionCount: null,
    message,
  });
}

export function diagnoseProposalFailure(input: {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly string[];
}): DesignDiagnostic {
  const issues = (input.issues ?? []).slice(0, 32).map((message) => ({
    path: "<proposal>",
    message,
  }));
  switch (input.code) {
    case "OUT_OF_BOUNDS":
      return diagnostic({
        errorCode: "BOUNDS_INVALID",
        evidenceSource: "input",
        solutionCount: null,
        message: input.message,
        schemaPath: issues[0]?.path ?? "<proposal>",
        issues,
        allowedFixKinds: ["change_parameter", "change_geometry", "remove_relation"],
      });
    case "FORBIDDEN_CONTENT":
      return diagnostic({
        errorCode: "FORBIDDEN_CONTENT",
        evidenceSource: "input",
        solutionCount: null,
        message: input.message,
        issues,
        allowedFixKinds: ["remove_relation", "replace_relation", "change_geometry"],
      });
    case "SKIN_INVALID":
      return diagnostic({
        errorCode: "SKIN_INVALID",
        evidenceSource: "input",
        solutionCount: null,
        message: input.message,
        issues,
        allowedFixKinds: ["change_skin"],
      });
    case "WRONG_FAMILY":
    case "WRONG_DIFFICULTY":
    case "SCHEMA_INVALID":
    case "UNSUPPORTED_SCHEMA":
    case "INVALID_INPUT":
    default:
      return diagnostic({
        errorCode: "SCHEMA_INVALID",
        evidenceSource: "input",
        solutionCount: null,
        message: input.message,
        schemaPath: issues[0]?.path ?? "<proposal>",
        issues,
        allowedFixKinds: GENERIC_REPAIR_FIXES,
      });
  }
}

export function diagnoseBaselineConstructionFailure(
  message: string,
): DesignDiagnostic {
  return diagnostic({
    errorCode: "BASELINE_CONSTRUCTION_FAILED",
    evidenceSource: "infrastructure",
    solutionCount: null,
    message,
  });
}

export function diagnoseRepairReplay(message: string): DesignDiagnostic {
  return diagnostic({
    errorCode: "REPAIR_REPLAY",
    evidenceSource: "input",
    solutionCount: null,
    message,
    allowedFixKinds: GENERIC_REPAIR_FIXES,
  });
}

export function diagnoseOptionFailure(
  code: DesignOptionDiagnostic["code"],
  message: string,
  optionCount: number | null,
  distinctCount: number | null,
): DesignDiagnostic {
  const errorCode =
    code === "INSUFFICIENT_OPTIONS"
      ? "OPTIONS_INSUFFICIENT"
      : code === "NON_DISTINCT_OPTIONS"
        ? "OPTIONS_NOT_DISTINCT"
        : "DUPLICATE_OPTION";
  return diagnostic({
    errorCode,
    evidenceSource: "deterministic",
    solutionCount: null,
    message,
    optionDiagnostic: { code, message, optionCount, distinctCount },
    allowedFixKinds: ["change_parameter", "change_geometry", "change_query"],
  });
}

export function diagnoseRenderFailure(
  code: "RENDER_INVALID" | "VISUAL_AMBIGUITY",
  message: string,
  family: Family | null,
): DesignDiagnostic {
  return diagnostic({
    errorCode: code === "VISUAL_AMBIGUITY" ? "VISUAL_AMBIGUITY" : "SVG_RENDER_INVALID",
    evidenceSource: "deterministic",
    solutionCount: null,
    message,
    renderDiagnostic: { code, message, family },
    allowedFixKinds: ["change_geometry", "change_parameter", "replace_relation"],
  });
}

export function diagnosePresentationFailure(
  message: string,
  family: Family | null,
): DesignDiagnostic {
  return diagnostic({
    errorCode: "PRESENTATION_INVALID",
    evidenceSource: "infrastructure",
    solutionCount: null,
    message,
    renderDiagnostic: { code: "RENDER_INVALID", message, family },
  });
}

export function diagnosePendingChecks(
  pendingChecks: readonly DesignPendingCheck[],
): DesignDiagnostic {
  return diagnostic({
    errorCode: "PENDING_CHECKS",
    evidenceSource: "deterministic",
    solutionCount: null,
    message: `pending deterministic checks: ${pendingChecks.join(", ")}`,
    pendingChecks,
  });
}

function engineForFamily(family: Family): {
  verifyAnswer(spec: unknown, answer: unknown): boolean;
} {
  switch (family) {
    case "ranking":
      return rankingEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "matching":
      return matchingEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "scheduling":
      return schedulingEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "truth":
      return truthEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "arithmetic":
      return arithmeticEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "matrix":
      return matrixEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "transforms":
      return transformsEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "paths":
      return pathsEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "symmetry":
      return symmetryEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
    case "counting":
      return countingEngine as unknown as {
        verifyAnswer(spec: unknown, answer: unknown): boolean;
      };
  }
}

function fromSolveResult<A>(
  result: SolveResult<A>,
): FamilySolutionDiagnostics<unknown> {
  return {
    solutionCount: result.solutionCount,
    answerCount: result.answerCount,
    witnesses: result.correctAnswer === null ? [] : [result.correctAnswer],
    complete: true,
    enumeratedStates: result.enumeratedStates,
  };
}

export function diagnoseFamilySolutions(
  family: Family,
  spec: FamilySpec,
): FamilySolutionDiagnostics<unknown> {
  switch (family) {
    case "ranking":
      return diagnoseRankingSolutions(spec as FamilySpecByFamily["ranking"]);
    case "matching":
      return diagnoseMatchingSolutions(spec as FamilySpecByFamily["matching"]);
    case "scheduling":
      return diagnoseSchedulingSolutions(
        spec as FamilySpecByFamily["scheduling"],
      );
    case "truth":
      return diagnoseTruthSolutions(spec as FamilySpecByFamily["truth"]);
    case "arithmetic":
      return diagnoseArithmeticSolutions(
        spec as FamilySpecByFamily["arithmetic"],
      );
    case "matrix":
      return diagnoseMatrixSolutions(spec as FamilySpecByFamily["matrix"]);
    case "transforms":
      return fromSolveResult(
        transformsEngine.enumerateSolutions(
          spec as FamilySpecByFamily["transforms"],
        ),
      );
    case "paths":
      return fromSolveResult(
        pathsEngine.enumerateSolutions(spec as FamilySpecByFamily["paths"]),
      );
    case "symmetry":
      return fromSolveResult(
        symmetryEngine.enumerateSolutions(
          spec as FamilySpecByFamily["symmetry"],
        ),
      );
    case "counting":
      return fromSolveResult(
        countingEngine.enumerateSolutions(
          spec as FamilySpecByFamily["counting"],
        ),
      );
  }
}

function verifyDistinctWitnesses(
  family: Family,
  spec: FamilySpec,
  witnesses: readonly unknown[],
): readonly unknown[] {
  const engine = engineForFamily(family);
  const verified: unknown[] = [];
  const seen = new Set<string>();
  for (const witness of witnesses) {
    if (!engine.verifyAnswer(spec, witness)) {
      continue;
    }
    const key = JSON.stringify(witness);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    verified.push(witness);
    if (verified.length === 2) {
      break;
    }
  }
  return verified;
}

function arithmeticInequalityIsEssential(
  spec: FamilySpecByFamily["arithmetic"],
): boolean {
  const parsed = ArithmeticSpecSchema.parse(spec);
  for (const [index, constraint] of parsed.constraints.entries()) {
    if (constraint.op !== "lt" && constraint.op !== "le") {
      continue;
    }
    if (parsed.constraints.length <= 2) {
      continue;
    }
    const reduced = {
      ...parsed,
      constraints: parsed.constraints.filter(
        (_candidate, candidateIndex) => candidateIndex !== index,
      ),
    };
    const solved = solveArithmetic(reduced);
    if (solved.solutions.length !== 1) {
      return true;
    }
  }
  return false;
}

function postLevelDiagnostic(
  family: Family,
  difficulty: Difficulty,
  spec: FamilySpec,
  result: FamilySolutionDiagnostics<unknown>,
): DesignDiagnostic | null {
  if (family === "paths") {
    const route = result.witnesses[0];
    if (!Array.isArray(route)) {
      return diagnostic({
        errorCode: "INFRASTRUCTURE_ERROR",
        evidenceSource: "infrastructure",
        solutionCount: result.solutionCount,
        message: "paths solver did not return a route witness",
      });
    }
    const edges = route.length - 1;
    const target =
      difficulty === 1
        ? { min: 3, max: 5 }
        : difficulty === 2
          ? { min: 5, max: 7 }
          : { min: 7, max: 11 };
    if (edges < target.min || edges > target.max) {
      return diagnostic({
        errorCode: "LEVEL_RULE_FAILED",
        evidenceSource: "deterministic",
        solutionCount: result.solutionCount,
        message: `level ${difficulty} route has ${edges} edges; expected ${target.min}-${target.max}`,
        features: [
          { name: "routeEdges", value: edges },
          { name: "minRouteEdges", value: target.min },
          { name: "maxRouteEdges", value: target.max },
        ],
        allowedFixKinds: ["change_geometry", "change_parameter"],
      });
    }
  }
  if (family === "arithmetic" && difficulty === 3) {
    const arithmetic = spec as FamilySpecByFamily["arithmetic"];
    if (!arithmeticInequalityIsEssential(arithmetic)) {
      return diagnostic({
        errorCode: "LEVEL_RULE_FAILED",
        evidenceSource: "deterministic",
        solutionCount: result.solutionCount,
        message:
          "level 3 requires at least one nonredundant inequality; every inequality is redundant",
        features: [
          {
            name: "inequalityCount",
            value: arithmetic.constraints.filter(
              (constraint) => constraint.op === "lt" || constraint.op === "le",
            ).length,
          },
          { name: "essentialInequalityCount", value: 0 },
        ],
        allowedFixKinds: ["add_relation", "replace_relation", "change_parameter"],
      });
    }
  }
  return null;
}

export function diagnoseDesignSpec(
  family: Family,
  difficulty: Difficulty,
  spec: FamilySpec,
): DesignDiagnostic | null {
  try {
    assertDesignerBounds(family, difficulty, spec);
  } catch (error) {
    if (error instanceof DesignerBoundsError) {
      return diagnoseBoundsFailure(error);
    }
    throw error;
  }

  let result: FamilySolutionDiagnostics<unknown>;
  try {
    result = diagnoseFamilySolutions(family, spec);
  } catch (error) {
    if (error instanceof SolverLimitError) {
      return diagnoseSolverLimit(error);
    }
    throw error;
  }

  if (result.solutionCount === 0) {
    return diagnostic({
      errorCode: "UNSAT",
      evidenceSource: "deterministic",
      solutionCount: 0,
      message: "the proposal has no complete satisfying solution",
      allowedFixKinds: GENERIC_REPAIR_FIXES,
    });
  }
  if (result.solutionCount > 1) {
    const witnesses = verifyDistinctWitnesses(
      family,
      spec,
      result.witnesses,
    );
    if (witnesses.length !== 2) {
      return diagnostic({
        errorCode: "INFRASTRUCTURE_ERROR",
        evidenceSource: "infrastructure",
        solutionCount: result.solutionCount,
        message:
          "ambiguity was detected but two independently verified witnesses were not available",
      });
    }
    return diagnostic({
      errorCode: "MULTIPLE_SOLUTIONS",
      evidenceSource: "deterministic",
      solutionCount: result.solutionCount,
      witnesses,
      allowedFixKinds: GENERIC_REPAIR_FIXES,
    });
  }
  if (result.answerCount > 1) {
    const witnesses = verifyDistinctWitnesses(
      family,
      spec,
      result.witnesses,
    );
    if (witnesses.length !== 2) {
      return diagnostic({
        errorCode: "INFRASTRUCTURE_ERROR",
        evidenceSource: "infrastructure",
        solutionCount: result.solutionCount,
        message:
          "multiple answers were detected but two independently verified witnesses were not available",
      });
    }
    return diagnostic({
      errorCode: "MULTIPLE_ANSWERS",
      evidenceSource: "deterministic",
      solutionCount: result.solutionCount,
      witnesses,
      allowedFixKinds: GENERIC_REPAIR_FIXES,
    });
  }

  return postLevelDiagnostic(family, difficulty, spec, result);
}
