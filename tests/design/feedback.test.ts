import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DesignAttemptRecordSchema,
  type DesignAttemptRecord,
  type DesignerAttemptArtifactRole,
} from "../../src/design/attempts.js";
import {
  diagnoseDesignSpec,
  diagnoseGenerationError,
  diagnoseInfrastructureFailure,
  diagnoseSchemaFailure,
  diagnoseSolverLimit,
  DesignDiagnosticSchema,
  passedDownstreamEvidence,
  pendingDownstreamEvidence,
  type DesignDiagnostic,
} from "../../src/design/diagnostics.js";
import {
  DesignFeedbackError,
  buildDesignRepairInput,
  runDesignFeedbackLoop,
  type DesignAttemptCandidateResult,
  type PersistDesignAttemptInput,
} from "../../src/design/feedback.js";
import {
  DesignProtocolError,
  DesignCandidateFinalSchema,
  evaluateDesignAttempt,
  reduceDesignCandidate,
} from "../../src/design/verdict.js";
import {
  buildDesignRepairRequest,
  parseDesignRepairProposal,
} from "../../src/ai/repair-proposal.js";
import { MAX_REQUEST_TEXT_BYTES } from "../../src/ai/config.js";
import { SolverLimitError } from "../../src/families/canonicalize.js";
import { rankingEngine } from "../../src/families/ranking/engine.js";
import { matchingEngine } from "../../src/families/matching/engine.js";
import { schedulingEngine } from "../../src/families/scheduling/engine.js";
import { truthEngine } from "../../src/families/truth/engine.js";
import { arithmeticEngine } from "../../src/families/arithmetic/engine.js";
import { matrixEngine } from "../../src/families/matrix/engine.js";
import { transformsEngine } from "../../src/families/transforms/engine.js";
import { pathsEngine } from "../../src/families/paths/engine.js";
import { symmetryEngine } from "../../src/families/symmetry/engine.js";
import { countingEngine } from "../../src/families/counting/engine.js";
import type { FamilySpecByFamily } from "../../src/domain/spec.js";
import {
  DIFFICULTIES,
  FAMILIES,
  MODALITY_BY_FAMILY,
  type Difficulty,
  type Family,
} from "../../src/domain/experiment.js";
import type { DesignProposal } from "../../src/domain/design.js";
import { canonicalJson } from "../../src/util/hash.js";
import { hashArtifactBytes } from "../../src/storage/artifacts.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const BASE_TIME = "2026-11-07T00:00:00.000Z";

function uuid(index: number): string {
  return `123e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, "0")}`;
}

function ambiguousRankingSpec(): FamilySpecByFamily["ranking"] {
  return {
    size: 4,
    clues: [
      { kind: "before", before: 0, after: 1 },
      { kind: "before", before: 1, after: 2 },
      { kind: "before", before: 0, after: 2 },
    ],
  };
}

function uniqueRankingSpec(): FamilySpecByFamily["ranking"] {
  return {
    size: 4,
    clues: [
      { kind: "at", item: 0, position: 1 },
      { kind: "notAt", item: 1, position: 1 },
      { kind: "immediatelyBefore", before: 2, after: 3 },
      { kind: "before", before: 1, after: 2 },
    ],
  };
}

function proposal(
  spec: FamilySpecByFamily["ranking"],
): DesignProposal {
  return {
    family: "ranking",
    difficulty: 1,
    spec,
    designIntent: null,
    presentationSkin: null,
  };
}

const ASSIGNMENT = {
  assignmentId: "design-text-ranking-01",
  family: "ranking",
  difficulty: 1,
} as const;

function ambiguousDiagnostic(): DesignDiagnostic {
  const diagnostic = diagnoseDesignSpec("ranking", 1, ambiguousRankingSpec());
  if (diagnostic === null || diagnostic.errorCode !== "MULTIPLE_SOLUTIONS") {
    throw new Error("expected a MULTIPLE_SOLUTIONS diagnostic");
  }
  return diagnostic;
}

function attemptArtifact(
  role: DesignerAttemptArtifactRole,
  bytes: Buffer,
): {
  readonly artifact: {
    readonly artifactId: number;
    readonly contentHash: string;
    readonly kind: "json" | "raw_response";
    readonly mediaType: string;
    readonly byteLength: number;
    readonly createdAt: string;
  };
  readonly role: DesignerAttemptArtifactRole;
} {
  return {
    artifact: {
      artifactId: role === "proposal" ? 1 : 2,
      contentHash: hashArtifactBytes(bytes),
      kind: role === "proposal" ? "json" : "raw_response",
      mediaType: "application/json",
      byteLength: bytes.length,
      createdAt: BASE_TIME,
    },
    role,
  };
}

function makePersist(): (
  input: PersistDesignAttemptInput,
) => DesignAttemptRecord {
  let attemptCounter = 0;
  return (input) => {
    attemptCounter += 1;
    const artifacts = [];
    let proposalArtifactId: number | null = null;
    if (input.proposal !== null) {
      const artifact = attemptArtifact(
        "proposal",
        Buffer.from(canonicalJson(input.proposal)),
      );
      proposalArtifactId = artifact.artifact.artifactId;
      artifacts.push(artifact);
    }
    if (input.rawValue !== null) {
      artifacts.push(
        attemptArtifact(
          "raw_response",
          Buffer.from(canonicalJson(input.rawValue)),
        ),
      );
    }
    for (const extra of input.artifacts) {
      artifacts.push({
        artifact: {
          artifactId: 100 + attemptCounter,
          contentHash: hashArtifactBytes(extra.bytes),
          kind: extra.kind,
          mediaType: extra.mediaType,
          byteLength: extra.bytes.length,
          createdAt: BASE_TIME,
        },
        role: extra.role as DesignerAttemptArtifactRole,
      });
    }
    return DesignAttemptRecordSchema.parse({
      kind: "design_attempt",
      runId: RUN_ID,
      slotId: input.slotId,
      attemptIndex: input.attemptIndex,
      role: input.role,
      arm: input.arm,
      logicalCallId: input.logicalCallId,
      proposalArtifactId,
      diagnostic: input.diagnostic,
      verdict: input.verdict,
      costStatus: input.costStatus,
      costUsd: input.costUsd,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      elapsedMs: input.elapsedMs,
      createdAt: input.finishedAt,
      artifacts,
    });
  };
}

function result(
  overrides: Partial<DesignAttemptCandidateResult> & {
    readonly logicalCallId: string | null;
  },
): DesignAttemptCandidateResult {
  return {
    proposal: null,
    rawValue: null,
    diagnostic: null,
    downstream: passedDownstreamEvidence(),
    costStatus: "known",
    costUsd: "0.01",
    startedAt: BASE_TIME,
    finishedAt: "2026-11-07T00:00:01.000Z",
    elapsedMs: 1_000,
    artifacts: [],
    ...overrides,
  };
}

function generatedSpec(family: Family, difficulty: Difficulty): unknown {
  switch (family) {
    case "ranking":
      return rankingEngine.generateSpec("a".repeat(64), difficulty);
    case "matching":
      return matchingEngine.generateSpec("a".repeat(64), difficulty);
    case "scheduling":
      return schedulingEngine.generateSpec("a".repeat(64), difficulty);
    case "truth":
      return truthEngine.generateSpec("a".repeat(64), difficulty);
    case "arithmetic":
      return arithmeticEngine.generateSpec("a".repeat(64), difficulty);
    case "matrix":
      return matrixEngine.generateSpec("a".repeat(64), difficulty);
    case "transforms":
      return transformsEngine.generateSpec("a".repeat(64), difficulty);
    case "paths":
      return pathsEngine.generateSpec("a".repeat(64), difficulty);
    case "symmetry":
      return symmetryEngine.generateSpec("a".repeat(64), difficulty);
    case "counting":
      return countingEngine.generateSpec("a".repeat(64), difficulty);
  }
}

describe("designer solver diagnostics", () => {
  it("returns two independently verified ambiguity witnesses", () => {
    const diagnostic = ambiguousDiagnostic();
    expect(diagnostic.solutionCount).toBeGreaterThan(1);
    expect(diagnostic.witnesses).toHaveLength(2);
    expect(canonicalJson(diagnostic.witnesses[0])).not.toBe(
      canonicalJson(diagnostic.witnesses[1]),
    );
    for (const witness of diagnostic.witnesses) {
      expect(
        rankingEngine.verifyAnswer(ambiguousRankingSpec(), witness as never),
      ).toBe(true);
    }
  });

  it("distinguishes unsatisfiable specs from ambiguity", () => {
    const unsat = diagnoseDesignSpec("ranking", 1, {
      size: 4,
      clues: [
        { kind: "at", item: 0, position: 1 },
        { kind: "at", item: 0, position: 2 },
        { kind: "before", before: 1, after: 2 },
      ],
    });
    expect(unsat?.errorCode).toBe("UNSAT");
    expect(unsat?.solutionCount).toBe(0);
  });

  it("enforces post-solver path route length", () => {
    const longPath: FamilySpecByFamily["paths"] = {
      active: [
        { row: 0, column: 0 },
        { row: 0, column: 1 },
        { row: 0, column: 2 },
        { row: 0, column: 3 },
        { row: 1, column: 3 },
        { row: 2, column: 1 },
        { row: 2, column: 2 },
        { row: 2, column: 3 },
      ],
      edges: [
        { from: { row: 0, column: 0 }, to: { row: 0, column: 1 } },
        { from: { row: 0, column: 1 }, to: { row: 0, column: 2 } },
        { from: { row: 0, column: 2 }, to: { row: 0, column: 3 } },
        { from: { row: 0, column: 3 }, to: { row: 1, column: 3 } },
        { from: { row: 1, column: 3 }, to: { row: 2, column: 3 } },
        { from: { row: 2, column: 1 }, to: { row: 2, column: 2 } },
        { from: { row: 2, column: 2 }, to: { row: 2, column: 3 } },
      ],
      start: { row: 0, column: 0 },
      goal: { row: 2, column: 3 },
    };
    expect(diagnoseDesignSpec("paths", 1, longPath)).toBeNull();
    expect(diagnoseDesignSpec("paths", 3, longPath)?.errorCode).toBe(
      "LEVEL_RULE_FAILED",
    );
  });

  it("requires a nonredundant arithmetic inequality at level 3", () => {
    const redundant: FamilySpecByFamily["arithmetic"] = {
      allDifferent: false,
      constraints: [
        { coeffs: [1, 0, 0], op: "eq", constant: 1 },
        { coeffs: [0, 1, 0], op: "eq", constant: 2 },
        { coeffs: [0, 0, 1], op: "eq", constant: 0 },
        { coeffs: [1, 0, 0], op: "le", constant: 2 },
      ],
    };
    expect(diagnoseDesignSpec("arithmetic", 3, redundant)?.errorCode).toBe(
      "LEVEL_RULE_FAILED",
    );
    const essential: FamilySpecByFamily["arithmetic"] = {
      allDifferent: false,
      constraints: [
        { coeffs: [1, 1, 0], op: "eq", constant: 3 },
        { coeffs: [0, 0, 1], op: "eq", constant: 0 },
        { coeffs: [1, 0, 0], op: "le", constant: 1 },
        { coeffs: [0, 1, 0], op: "le", constant: 2 },
      ],
    };
    expect(diagnoseDesignSpec("arithmetic", 3, essential)).toBeNull();
  });

  it("stores every pre-solver bounds issue", () => {
    const diagnostic = diagnoseDesignSpec("truth", 1, {
      people: 4,
      exactTruthful: 2,
      statements: [
        {
          kind: "xor",
          left: { kind: "truthful", person: 0 },
          right: { kind: "truthful", person: 1 },
        },
        {
          kind: "and",
          left: { kind: "truthful", person: 2 },
          right: { kind: "truthful", person: 3 },
        },
        { kind: "not", operand: { kind: "truthful", person: 0 } },
        { kind: "truthful", person: 1 },
      ],
    });
    expect(diagnostic?.errorCode).toBe("BOUNDS_INVALID");
    expect(diagnostic?.issues.length).toBeGreaterThan(1);
  });

  it("truncates oversized schema issue lists into a typed diagnostic", () => {
    const schema = z.strictObject(
      Object.fromEntries(
        Array.from({ length: 40 }, (_value, index) => [
          `field${index}`,
          z.string(),
        ]),
      ),
    );
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected schema failure");
    }
    const diagnostic = diagnoseSchemaFailure(result.error);
    expect(diagnostic.errorCode).toBe("SCHEMA_INVALID");
    expect(diagnostic.issues).toHaveLength(32);
  });

  it("recomputes the same diagnostic from the same saved spec", () => {
    const first = ambiguousDiagnostic();
    const second = diagnoseDesignSpec("ranking", 1, ambiguousRankingSpec());
    expect(second).toEqual(first);
  });
});

describe("designer attempt evaluation", () => {
  it("accepts only after all downstream checks pass", () => {
    expect(
      evaluateDesignAttempt({
        arm: "ai_one_shot",
        attemptIndex: 0,
        responsePresent: true,
        solverDiagnostic: null,
        downstream: passedDownstreamEvidence(),
      }),
    ).toEqual({ verdict: "accepted", diagnostic: null, pendingChecks: [] });
    const pending = evaluateDesignAttempt({
      arm: "ai_one_shot",
      attemptIndex: 0,
      responsePresent: true,
      solverDiagnostic: null,
      downstream: pendingDownstreamEvidence(),
    });
    expect(pending.verdict).toBe("inconclusive");
    expect(pending.diagnostic?.errorCode).toBe("PENDING_CHECKS");
    expect(pending.pendingChecks).toEqual([
      "options",
      "render",
      "presentation",
    ]);
  });

  it("classifies an infrastructure-classified downstream failure as inconclusive", () => {
    const infrastructure = diagnoseInfrastructureFailure(
      new Error("code-owned key mapping is wrong"),
    );
    const evaluated = evaluateDesignAttempt({
      arm: "ai_one_shot",
      attemptIndex: 0,
      responsePresent: true,
      solverDiagnostic: null,
      downstream: {
        options: { status: "failed", diagnostic: infrastructure },
        render: { status: "passed", diagnostic: null },
        presentation: { status: "passed", diagnostic: null },
      },
    });
    expect(evaluated.verdict).toBe("inconclusive");
    expect(evaluated.diagnostic).toEqual(infrastructure);
  });

  it("cannot accept an attempt with no usable design response", () => {
    const evaluated = evaluateDesignAttempt({
      arm: "ai_one_shot",
      attemptIndex: 0,
      responsePresent: false,
      solverDiagnostic: null,
      downstream: passedDownstreamEvidence(),
    });
    expect(evaluated.verdict).toBe("generation_error");
    expect(evaluated.diagnostic?.errorCode).toBe("GENERATION_ERROR");
    expect(
      DesignAttemptRecordSchema.safeParse({
        kind: "design_attempt",
        runId: RUN_ID,
        slotId: "design-text-ranking-01-ai_one_shot",
        attemptIndex: 0,
        role: "design",
        arm: "ai_one_shot",
        logicalCallId: uuid(0),
        proposalArtifactId: null,
        diagnostic: null,
        verdict: "accepted",
        costStatus: "known",
        costUsd: "0.01",
        startedAt: BASE_TIME,
        finishedAt: "2026-11-07T00:00:01.000Z",
        elapsedMs: 1_000,
        createdAt: "2026-11-07T00:00:01.000Z",
        artifacts: [],
      }).success,
    ).toBe(false);
  });

  it("treats any infrastructure-classified diagnostic as inconclusive", () => {
    const infrastructurePresentation = DesignDiagnosticSchema.parse({
      errorCode: "PRESENTATION_INVALID",
      evidenceSource: "infrastructure",
      solutionCount: null,
      witnesses: [],
      features: [],
      issues: [],
      schemaPath: null,
      message: "code-owned template contradiction",
      stateCount: null,
      limit: null,
      optionDiagnostic: null,
      renderDiagnostic: {
        code: "RENDER_INVALID",
        message: "template contradiction",
        family: "ranking",
      },
      pendingChecks: [],
      allowedFixKinds: [],
    });
    const evaluated = evaluateDesignAttempt({
      arm: "ai_one_shot",
      attemptIndex: 0,
      responsePresent: true,
      solverDiagnostic: null,
      downstream: {
        options: { status: "passed", diagnostic: null },
        render: { status: "passed", diagnostic: null },
        presentation: {
          status: "failed",
          diagnostic: infrastructurePresentation,
        },
      },
    });
    expect(evaluated.verdict).toBe("inconclusive");
    expect(evaluated.diagnostic).toEqual(infrastructurePresentation);

    const infrastructureOption = DesignDiagnosticSchema.parse({
      errorCode: "DUPLICATE_OPTION",
      evidenceSource: "infrastructure",
      solutionCount: null,
      witnesses: [],
      features: [],
      issues: [],
      schemaPath: null,
      message: "code-owned option key collision",
      stateCount: null,
      limit: null,
      optionDiagnostic: {
        code: "DUPLICATE_OPTION",
        message: "option key collision",
        optionCount: 4,
        distinctCount: 3,
      },
      renderDiagnostic: null,
      pendingChecks: [],
      allowedFixKinds: [],
    });
    expect(
      evaluateDesignAttempt({
        arm: "ai_one_shot",
        attemptIndex: 0,
        responsePresent: true,
        solverDiagnostic: infrastructureOption,
        downstream: passedDownstreamEvidence(),
      }).verdict,
    ).toBe("inconclusive");
  });

  it("keeps infrastructure and generation diagnostics out of wrong verdicts", () => {
    const infrastructure = DesignDiagnosticSchema.parse({
      errorCode: "PRESENTATION_INVALID",
      evidenceSource: "infrastructure",
      solutionCount: null,
      witnesses: [],
      features: [],
      issues: [],
      schemaPath: null,
      message: "code-owned template contradiction",
      stateCount: null,
      limit: null,
      optionDiagnostic: null,
      renderDiagnostic: {
        code: "RENDER_INVALID",
        message: "template contradiction",
        family: "ranking",
      },
      pendingChecks: [],
      allowedFixKinds: [],
    });
    const base = {
      kind: "design_attempt" as const,
      runId: RUN_ID,
      slotId: "design-text-ranking-01-ai_feedback",
      attemptIndex: 0,
      role: "design" as const,
      arm: "ai_feedback" as const,
      logicalCallId: uuid(0),
      proposalArtifactId: null,
      diagnostic: infrastructure,
      verdict: "rejected" as const,
      costStatus: "known" as const,
      costUsd: "0.01",
      startedAt: BASE_TIME,
      finishedAt: "2026-11-07T00:00:01.000Z",
      elapsedMs: 1_000,
      createdAt: "2026-11-07T00:00:01.000Z",
      artifacts: [],
    };
    expect(DesignAttemptRecordSchema.safeParse(base).success).toBe(false);
    expect(
      DesignAttemptRecordSchema.safeParse({
        ...base,
        verdict: "inconclusive",
        diagnostic: diagnoseGenerationError(new Error("model failed")),
      }).success,
    ).toBe(false);
  });

  it("rejects a third repair index", () => {
    expect(() =>
      evaluateDesignAttempt({
        arm: "ai_feedback",
        attemptIndex: 3,
        responsePresent: true,
        solverDiagnostic: null,
        downstream: passedDownstreamEvidence(),
      }),
    ).toThrow(DesignProtocolError);
  });
});

describe("designer feedback loop", () => {
  it("repairs a MULTIPLE_SOLUTIONS rejection and keeps the first rejection", async () => {
    const diagnostic = ambiguousDiagnostic();
    const previous = proposal(ambiguousRankingSpec());
    const repair = async (): Promise<DesignAttemptCandidateResult> =>
      result({
        logicalCallId: uuid(1),
        proposal: proposal(uniqueRankingSpec()),
        rawValue: proposal(uniqueRankingSpec()),
        diagnostic: null,
        downstream: passedDownstreamEvidence(),
      });
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        proposal: previous,
        rawValue: previous,
        diagnostic,
      }),
      repair,
      persist: makePersist(),
    });
    expect(loop.final.finalVerdict).toBe("accepted");
    expect(loop.final.attempts).toHaveLength(2);
    expect(loop.final.firstAttempt.verdict).toBe("rejected");
    expect(loop.final.firstAttempt.diagnosticHash).not.toBeNull();
    expect(loop.final.firstAttempt).toEqual(loop.final.attempts[0]);
    expect(loop.final.stopReason).toBe("accepted");
    expect(loop.final.repairPending).toBe(false);
  });

  it("accepts a baseline attempt with zero AI cost", async () => {
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "baseline",
      first: result({
        logicalCallId: null,
        proposal: proposal(uniqueRankingSpec()),
        costStatus: "none",
        costUsd: "0",
      }),
      repair: async () => {
        throw new Error("baseline must not repair");
      },
      persist: makePersist(),
    });
    expect(loop.final.finalVerdict).toBe("accepted");
    expect(loop.final.firstAttempt.costStatus).toBe("none");
    expect(loop.final.firstAttempt.costUsd).toBe("0");
    expect(loop.final.firstAttempt.logicalCallId).toBeNull();
  });

  it("rejects a one-shot attempt without claiming a repair cap", async () => {
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_one_shot",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(ambiguousRankingSpec()),
        rawValue: proposal(ambiguousRankingSpec()),
        diagnostic: ambiguousDiagnostic(),
      }),
      repair: async () => {
        throw new Error("one-shot must not repair");
      },
      persist: makePersist(),
    });
    expect(loop.final.stopReason).toBe("deterministic_rejection");
    expect(loop.final.repairPending).toBe(false);
    expect(loop.final.attempts).toHaveLength(1);
  });

  it("accepts a unique one-shot attempt without repair", async () => {
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_one_shot",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(uniqueRankingSpec()),
        rawValue: proposal(uniqueRankingSpec()),
      }),
      repair: async () => {
        throw new Error("one-shot must not repair");
      },
      persist: makePersist(),
    });
    expect(loop.final.finalVerdict).toBe("accepted");
    expect(loop.final.attempts).toHaveLength(1);
    expect(loop.final.stopReason).toBe("accepted");
  });

  it("allows at most two repairs and stops at the cap", async () => {
    const diagnostic = ambiguousDiagnostic();
    let repairs = 0;
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(ambiguousRankingSpec()),
        rawValue: proposal(ambiguousRankingSpec()),
        diagnostic,
      }),
      repair: async () => {
        repairs += 1;
        return result({
          logicalCallId: uuid(repairs),
          proposal: proposal(ambiguousRankingSpec()),
          rawValue: proposal(ambiguousRankingSpec()),
          diagnostic,
        });
      },
      persist: makePersist(),
    });
    expect(repairs).toBe(2);
    expect(loop.final.attempts).toHaveLength(3);
    expect(loop.final.stopReason).toBe("repair_cap");
    expect(loop.final.finalVerdict).toBe("rejected");
    expect(loop.final.repairPending).toBe(false);
    expect(() =>
      reduceDesignCandidate({
        slotId: "design-text-ranking-01-ai_feedback",
        assignmentId: ASSIGNMENT.assignmentId,
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        attempts: [
          ...loop.attempts,
          {
            ...loop.attempts[2]!,
            attemptIndex: 3,
          },
        ],
      }),
    ).toThrow(DesignProtocolError);
  });

  it("stops on generation errors at every attempt index", async () => {
    const generation = diagnoseGenerationError(new Error("model failed"));
    const diagnostic = ambiguousDiagnostic();
    const first = result({
      logicalCallId: uuid(0),
      proposal: proposal(ambiguousRankingSpec()),
      rawValue: proposal(ambiguousRankingSpec()),
      diagnostic,
    });
    const loop0 = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        diagnostic: generation,
      }),
      repair: async () => {
        throw new Error("generation error must not repair");
      },
      persist: makePersist(),
    });
    expect(loop0.final.stopReason).toBe("generation_error");
    expect(loop0.final.attempts).toHaveLength(1);
    const loop1 = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first,
      repair: async () =>
        result({ logicalCallId: uuid(1), diagnostic: generation }),
      persist: makePersist(),
    });
    expect(loop1.final.stopReason).toBe("generation_error");
    expect(loop1.final.attempts).toHaveLength(2);
    const loop2 = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first,
      repair: async (request) =>
        request.repairIndex === 1
          ? result({
              logicalCallId: uuid(1),
              proposal: proposal(ambiguousRankingSpec()),
              rawValue: proposal(ambiguousRankingSpec()),
              diagnostic,
            })
          : result({ logicalCallId: uuid(2), diagnostic: generation }),
      persist: makePersist(),
    });
    expect(loop2.final.stopReason).toBe("generation_error");
    expect(loop2.final.attempts).toHaveLength(3);
  });

  it("allows a SOLVER_LIMIT repair and keeps pending checks pending", async () => {
    const solverLimit = diagnoseSolverLimit(new SolverLimitError(10, 11));
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(ambiguousRankingSpec()),
        rawValue: proposal(ambiguousRankingSpec()),
        diagnostic: solverLimit,
      }),
      repair: async () =>
        result({
          logicalCallId: uuid(1),
          proposal: proposal(uniqueRankingSpec()),
          rawValue: proposal(uniqueRankingSpec()),
          downstream: pendingDownstreamEvidence(),
        }),
      persist: makePersist(),
    });
    expect(loop.final.finalVerdict).toBe("inconclusive");
    expect(loop.final.stopReason).toBe("pending_checks");
    expect(loop.final.pendingChecks).toEqual([
      "options",
      "render",
      "presentation",
    ]);
    expect(loop.final.firstAttempt.verdict).toBe("inconclusive");
  });

  it("persists an infrastructure-classified downstream failure", async () => {
    const infrastructurePresentation = DesignDiagnosticSchema.parse({
      errorCode: "PRESENTATION_INVALID",
      evidenceSource: "infrastructure",
      solutionCount: null,
      witnesses: [],
      features: [],
      issues: [],
      schemaPath: null,
      message: "code-owned template contradiction",
      stateCount: null,
      limit: null,
      optionDiagnostic: null,
      renderDiagnostic: {
        code: "RENDER_INVALID",
        message: "template contradiction",
        family: "ranking",
      },
      pendingChecks: [],
      allowedFixKinds: [],
    });
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_one_shot",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(uniqueRankingSpec()),
        rawValue: proposal(uniqueRankingSpec()),
        downstream: {
          options: { status: "passed", diagnostic: null },
          render: { status: "passed", diagnostic: null },
          presentation: {
            status: "failed",
            diagnostic: infrastructurePresentation,
          },
        },
      }),
      repair: async () => {
        throw new Error("infrastructure must not repair");
      },
      persist: makePersist(),
    });
    expect(loop.final.stopReason).toBe("infrastructure_inconclusive");
    expect(loop.final.finalVerdict).toBe("inconclusive");
    expect(loop.final.attempts).toHaveLength(1);
  });

  it("does not repair an infrastructure inconclusive attempt", async () => {
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        diagnostic: diagnoseInfrastructureFailure(new Error("bug")),
      }),
      repair: async () => {
        throw new Error("infrastructure must not repair");
      },
      persist: makePersist(),
    });
    expect(loop.final.stopReason).toBe("infrastructure_inconclusive");
    expect(loop.final.attempts).toHaveLength(1);
  });

  it("leaves a repair pending under budget and operator pauses", async () => {
    for (const paused of ["budget", "operator"] as const) {
      const loop = await runDesignFeedbackLoop({
        assignment: ASSIGNMENT,
        arm: "ai_feedback",
        first: result({
          logicalCallId: uuid(0),
          proposal: proposal(ambiguousRankingSpec()),
          rawValue: proposal(ambiguousRankingSpec()),
          diagnostic: ambiguousDiagnostic(),
        }),
        repair: async () => {
          throw new Error("paused loop must not repair");
        },
        persist: makePersist(),
        paused,
      });
      expect(loop.final.repairPending).toBe(true);
      expect(loop.final.stopReason).toBe(`${paused}_paused`);
      expect(loop.final.attempts).toHaveLength(1);
    }
  });

  it("preserves an inconclusive solver-limit verdict on input-limit failure", async () => {
    const hugeRaw = Object.fromEntries(
      Array.from({ length: 32 }, (_value, index) => [
        `key-${index}`,
        "x".repeat(500),
      ]),
    );
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        rawValue: hugeRaw,
        diagnostic: diagnoseSolverLimit(new SolverLimitError(10, 11)),
      }),
      repair: async () => {
        throw new Error("oversized repair input must not dispatch");
      },
      persist: makePersist(),
    });
    expect(loop.final.stopReason).toBe("input_too_large");
    expect(loop.final.finalVerdict).toBe("inconclusive");
    expect(loop.final.terminalDiagnostic?.errorCode).toBe("INPUT_TOO_LARGE");
    expect(DesignCandidateFinalSchema.safeParse(loop.final).success).toBe(true);
  });

  it("records a terminal input-limit failure", async () => {
    const hugeRaw = Object.fromEntries(
      Array.from({ length: 32 }, (_value, index) => [
        `key-${index}`,
        "x".repeat(500),
      ]),
    );
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        rawValue: hugeRaw,
        diagnostic: ambiguousDiagnostic(),
      }),
      repair: async () => {
        throw new Error("oversized repair input must not dispatch");
      },
      persist: makePersist(),
    });
    expect(loop.final.stopReason).toBe("input_too_large");
    expect(loop.final.terminalDiagnostic?.errorCode).toBe("INPUT_TOO_LARGE");
    expect(loop.final.repairPending).toBe(false);
  });

  it("rejects replay disguised as a new design", () => {
    const previous = proposal(uniqueRankingSpec());
    expect(() =>
      parseDesignRepairProposal(previous, ASSIGNMENT, previous),
    ).toThrow(DesignFeedbackError);
    expect(() =>
      parseDesignRepairProposal(
        {
          ...previous,
          designIntent: "Only the provenance changed.",
        },
        ASSIGNMENT,
        previous,
      ),
    ).toThrow(DesignFeedbackError);
  });

  it("does not leak options or answers into the final evidence", async () => {
    const loop = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_feedback",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(ambiguousRankingSpec()),
        rawValue: proposal(ambiguousRankingSpec()),
        diagnostic: ambiguousDiagnostic(),
      }),
      repair: async () =>
        result({
          logicalCallId: uuid(1),
          proposal: proposal(uniqueRankingSpec()),
          rawValue: proposal(uniqueRankingSpec()),
        }),
      persist: makePersist(),
    });
    const text = JSON.stringify(loop.final);
    expect(text).not.toContain("correctAnswer");
    expect(text).not.toContain("answerKey");
    expect(text).not.toContain("options");
    expect(DesignCandidateFinalSchema.safeParse(loop.final).success).toBe(true);
  });

  it("preserves known and unknown cost snapshots", async () => {
    const known = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_one_shot",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(uniqueRankingSpec()),
        rawValue: proposal(uniqueRankingSpec()),
        costStatus: "known",
        costUsd: "0.25",
      }),
      repair: async () => {
        throw new Error("one-shot must not repair");
      },
      persist: makePersist(),
    });
    expect(known.final.firstAttempt.costStatus).toBe("known");
    expect(known.final.firstAttempt.costUsd).toBe("0.25");
    const unknown = await runDesignFeedbackLoop({
      assignment: ASSIGNMENT,
      arm: "ai_one_shot",
      first: result({
        logicalCallId: uuid(0),
        proposal: proposal(uniqueRankingSpec()),
        rawValue: proposal(uniqueRankingSpec()),
        costStatus: "unknown",
        costUsd: null,
      }),
      repair: async () => {
        throw new Error("one-shot must not repair");
      },
      persist: makePersist(),
    });
    expect(unknown.final.firstAttempt.costStatus).toBe("unknown");
    expect(unknown.final.firstAttempt.costUsd).toBeNull();
  });

  it("does not authorize repair without a saved response", () => {
    const first = DesignAttemptRecordSchema.parse({
      kind: "design_attempt",
      runId: RUN_ID,
      slotId: "design-text-ranking-01-ai_feedback",
      attemptIndex: 0,
      role: "design",
      arm: "ai_feedback",
      logicalCallId: uuid(0),
      proposalArtifactId: null,
      diagnostic: ambiguousDiagnostic(),
      verdict: "rejected",
      costStatus: "known",
      costUsd: "0.01",
      startedAt: BASE_TIME,
      finishedAt: "2026-11-07T00:00:01.000Z",
      elapsedMs: 1_000,
      createdAt: "2026-11-07T00:00:01.000Z",
      artifacts: [],
    });
    expect(() =>
      reduceDesignCandidate({
        slotId: "design-text-ranking-01-ai_feedback",
        assignmentId: ASSIGNMENT.assignmentId,
        arm: "ai_feedback",
        family: "ranking",
        difficulty: 1,
        attempts: [
          first,
          {
            ...first,
            attemptIndex: 1,
            role: "design_repair_1",
            logicalCallId: uuid(1),
          },
        ],
      }),
    ).toThrow(DesignProtocolError);
  });

  it("keeps every repair request under the request-text limit", () => {
    const diagnostic = DesignDiagnosticSchema.parse({
      errorCode: "UNSAT",
      evidenceSource: "deterministic",
      solutionCount: 0,
      witnesses: [],
      features: [],
      issues: [],
      schemaPath: null,
      message: "request-size probe",
      stateCount: null,
      limit: null,
      optionDiagnostic: null,
      renderDiagnostic: null,
      pendingChecks: [],
      allowedFixKinds: ["add_relation"],
    });
    for (const family of FAMILIES) {
      for (const difficulty of DIFFICULTIES) {
        const assignment = {
          assignmentId: `design-${MODALITY_BY_FAMILY[family]}-${family}-01`,
          family,
          difficulty,
        } as const;
        const previousProposal = {
          family,
          difficulty,
          spec: generatedSpec(family, difficulty),
          designIntent: null,
          presentationSkin: null,
        } as DesignProposal;
        const repairInput = buildDesignRepairInput({
          assignment,
          previousProposal,
          previousRawValue: null,
          diagnostic,
        });
        for (const repairIndex of [1, 2] as const) {
          const built = buildDesignRepairRequest({
            assignment,
            repairInput,
            repairIndex,
            model: "test/designer",
            outputCapField: "max_tokens",
            maxOutputTokens: 8192,
            skinEnabled: true,
          });
          const bytes = built.messages.reduce(
            (sum, message) =>
              sum + Buffer.byteLength(String(message.content), "utf8"),
            0,
          );
          expect(bytes).toBeLessThanOrEqual(MAX_REQUEST_TEXT_BYTES);
        }
      }
    }
  });

  it("rejects oversized repair inputs before dispatch", () => {
    const hugeRaw = Object.fromEntries(
      Array.from({ length: 32 }, (_value, index) => [
        `key-${index}`,
        "x".repeat(500),
      ]),
    );
    expect(() =>
      buildDesignRepairInput({
        assignment: ASSIGNMENT,
        previousProposal: null,
        previousRawValue: hugeRaw,
        diagnostic: ambiguousDiagnostic(),
      }),
    ).toThrow(DesignFeedbackError);
  });
});
