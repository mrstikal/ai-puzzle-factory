import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CandidateEnvelopeSchema,
  FailureRecordSchema,
  StageResultEnvelopeSchema,
} from "../../src/domain/candidate.js";
import {
  CALIBRATION_ROOT_SEED,
  DIFFICULTIES,
  FAMILIES,
  FULL_DIFFICULTY_COUNTS,
  LANES,
  MODALITY_BY_FAMILY,
  PlanManifestSchema,
  REQUEST_ROLES,
  ROOT_SEEDS,
  RunManifestSchema,
  SVG_FAMILIES,
  TEXT_FAMILIES,
  THRESHOLDS,
  computeRunManifestHash,
  smokeDifficultyForFamily,
  type PlanManifest,
} from "../../src/domain/experiment.js";
import {
  buildPlanManifest,
  canonicalJson,
  computePlanHash,
  serializePlanManifest,
} from "../../src/experiment/planner.js";
import {
  HashCounterPrng,
  STREAM_PURPOSES,
  deriveStreamSeed,
} from "../../src/util/random.js";

const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");
const FULL_PLAN_HASH =
  "e7dbe198a948731eb4fd5b030a5d30dcf96aa8b7dfa639cbb6a5f38c4226e273";

const DRY_RUN_PROBE = `
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";

let calls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  calls += 1;
  return originalFetch(...args);
};
for (const module of [http, https]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = function (...args) {
      calls += 1;
      return original.apply(this, args);
    };
  }
}
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  calls += 1;
  return originalSocketConnect.apply(this, args);
};
const originalConnect = net.connect;
net.connect = function (...args) {
  calls += 1;
  return originalConnect.apply(this, args);
};

(async () => {
  const before = existsSync("data") ? readdirSync("data").sort().join(",") : "";
  const { main } = await import(pathToFileURL(process.cwd() + "/src/cli/experiment.ts").href);
  const code = await main(["node", "experiment", "--dry-run", "--seed", "puzzle-poc-v1"]);
  const after = existsSync("data") ? readdirSync("data").sort().join(",") : "";
  if (calls !== 0) {
    console.error("network-calls:" + calls);
    process.exit(3);
  }
  if (before !== after) {
    console.error("data-directory-changed");
    process.exit(4);
  }
  if (code !== 0) {
    console.error("exit-code:" + code);
    process.exit(5);
  }
})();
`;

function countSlots(plan: PlanManifest, predicate: (slot: PlanManifest["slots"][number]) => boolean): number {
  return plan.slots.filter(predicate).length;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeRunManifest(plan: PlanManifest): unknown {
  const manifest = {
    plan,
    evidenceKind: "mock",
    runId: "123e4567-e89b-12d3-a456-426614174000",
    roles: {
      generator: { model: "mock/generator" },
      textReviewer: { model: "mock/text-reviewer" },
      visionReviewer: { model: "mock/vision-reviewer" },
    },
    routingPolicy: {
      mode: "balanced",
      allowFallbacks: true,
      requireParameters: true,
    },
    routingConfirmation: {
      operator: "test-operator",
      checkedAt: "2026-11-06T00:00:00.000Z",
      providerSort: "default_balanced",
      byokConfigured: false,
    },
    outputLimits: { spec: 8192, wording: 8192, review: 4096 },
    concurrency: 2,
    budget: {
      maxCostUsd: "10",
      reservationMethod: "fixed conservative per-role reserve",
      priceSnapshotHash: "a".repeat(64),
    },
    hashes: {
      prompts: "b".repeat(64),
      schema: "c".repeat(64),
      source: "d".repeat(64),
      font: "e".repeat(64),
      dependencyLock: "f".repeat(64),
    },
    runtime: { node: "24.22.2", npm: "11.19.1", os: "linux", arch: "x64" },
    thresholds: { ...THRESHOLDS },
    calibrationReference: null,
    mockConfiguration: { synthetic: true, description: "synthetic fixture" },
    redacted: true,
    createdAt: "2026-11-03T22:00:00Z",
    manifestHash: "0".repeat(64),
  };
  manifest.manifestHash = computeRunManifestHash(manifest);
  return manifest;
}

describe("full plan", () => {
  const plan = buildPlanManifest({ runKind: "full" });

  it("allocates exactly 200 slots with the fixed quotas and root seed", () => {
    expect(plan.protocolVersion).toBe("1.0.0");
    expect(plan.runKind).toBe("full");
    expect(plan.rootSeed).toBe(ROOT_SEEDS.full);
    expect(plan.slots).toHaveLength(200);
    expect(plan.quotas).toEqual({
      totalSlots: 200,
      textSlots: 100,
      svgSlots: 100,
      specFirstSlots: 120,
      aiSpecSlots: 80,
      slotsPerFamily: 20,
      textSpecFirstPerFamily: 10,
      textAiSpecPerFamily: 10,
      svgSpecFirstPerFamily: 14,
      svgAiSpecPerFamily: 6,
    });
  });

  it("contains 20 slots per family with the 10/10 and 14/6 lane split", () => {
    for (const family of TEXT_FAMILIES) {
      const familySlots = plan.slots.filter((slot) => slot.family === family);
      expect(familySlots).toHaveLength(20);
      expect(familySlots.filter((slot) => slot.lane === "spec_first")).toHaveLength(10);
      expect(familySlots.filter((slot) => slot.lane === "ai_spec")).toHaveLength(10);
    }
    for (const family of SVG_FAMILIES) {
      const familySlots = plan.slots.filter((slot) => slot.family === family);
      expect(familySlots).toHaveLength(20);
      expect(familySlots.filter((slot) => slot.lane === "spec_first")).toHaveLength(14);
      expect(familySlots.filter((slot) => slot.lane === "ai_spec")).toHaveLength(6);
    }
  });

  it("uses the fixed difficulty tuples and 7/7/6 family totals", () => {
    for (const family of FAMILIES) {
      const modality = MODALITY_BY_FAMILY[family];
      for (const lane of LANES) {
        const counts = DIFFICULTIES.map(
          (difficulty) =>
            countSlots(
              plan,
              (slot) =>
                slot.family === family && slot.lane === lane && slot.difficulty === difficulty,
            ),
        );
        expect(counts).toEqual([...FULL_DIFFICULTY_COUNTS[modality][lane]]);
        for (const difficulty of DIFFICULTIES) {
          const entry = plan.difficultyCounts.find(
            (candidate) =>
              candidate.family === family &&
              candidate.lane === lane &&
              candidate.difficulty === difficulty,
          );
          expect(entry?.count).toBe(
            countSlots(
              plan,
              (slot) =>
                slot.family === family && slot.lane === lane && slot.difficulty === difficulty,
            ),
          );
        }
      }

      const totals = DIFFICULTIES.map((difficulty) =>
        countSlots(plan, (slot) => slot.family === family && slot.difficulty === difficulty),
      );
      expect(totals).toEqual([7, 7, 6]);
    }
  });

  it("has stable contiguous ordinals and slot IDs in family order", () => {
    expect(new Set(plan.slots.map((slot) => slot.slotId)).size).toBe(200);
    for (const [index, slot] of plan.slots.entries()) {
      expect(slot.slotOrdinal).toBe(index + 1);
      expect(slot.family).toBe(FAMILIES[Math.floor(index / 20)]);
      expect(slot.modality).toBe(MODALITY_BY_FAMILY[slot.family]);
      expect(slot.slotId).toBe(
        `${slot.modality}-${slot.family}-${String((index % 20) + 1).padStart(2, "0")}`,
      );
    }
  });

  it("matches the golden plan hash and recomputes it canonically", () => {
    expect(plan.planHash).toBe(FULL_PLAN_HASH);
    expect(computePlanHash(plan)).toBe(plan.planHash);
    const changed = clone(plan);
    changed.slots[0] = { ...changed.slots[0]!, difficulty: 3 };
    expect(computePlanHash(changed)).not.toBe(plan.planHash);
  });

  it("serializes as stable JSON that round-trips through the schema", () => {
    const serialized = serializePlanManifest(plan);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(PlanManifestSchema.parse(JSON.parse(serialized))).toEqual(plan);
  });
});

describe("smoke plan", () => {
  const plan = buildPlanManifest({ runKind: "smoke" });

  it("allocates 20 slots with a 50/50 SVG lane split", () => {
    expect(plan.runKind).toBe("smoke");
    expect(plan.rootSeed).toBe(ROOT_SEEDS.smoke);
    expect(plan.slots).toHaveLength(20);
    expect(plan.quotas).toEqual({
      totalSlots: 20,
      textSlots: 10,
      svgSlots: 10,
      specFirstSlots: 10,
      aiSpecSlots: 10,
      slotsPerFamily: 2,
      textSpecFirstPerFamily: 1,
      textAiSpecPerFamily: 1,
      svgSpecFirstPerFamily: 1,
      svgAiSpecPerFamily: 1,
    });
    expect(countSlots(plan, (slot) => slot.modality === "text")).toBe(10);
    expect(countSlots(plan, (slot) => slot.modality === "svg")).toBe(10);
  });

  it("assigns one slot per family and lane by family ordinal modulo three", () => {
    for (const [familyIndex, family] of FAMILIES.entries()) {
      const specSlots = plan.slots.filter(
        (slot) => slot.family === family && slot.lane === "spec_first",
      );
      const aiSlots = plan.slots.filter(
        (slot) => slot.family === family && slot.lane === "ai_spec",
      );
      expect(specSlots).toHaveLength(1);
      expect(aiSlots).toHaveLength(1);
      const expected = smokeDifficultyForFamily(familyIndex);
      expect(specSlots[0]?.difficulty).toBe(expected.specFirst);
      expect(aiSlots[0]?.difficulty).toBe(expected.aiSpec);
      expect(specSlots[0]?.slotId).toBe(
        `${MODALITY_BY_FAMILY[family]}-${family}-01`,
      );
      expect(aiSlots[0]?.slotId).toBe(
        `${MODALITY_BY_FAMILY[family]}-${family}-02`,
      );
    }
    for (const difficulty of DIFFICULTIES) {
      expect(countSlots(plan, (slot) => slot.difficulty === difficulty)).toBeGreaterThan(0);
    }
  });
});

describe("request estimates", () => {
  it("uses the fixed no-early-failure ceilings for the full cohort", () => {
    const plan = buildPlanManifest({ runKind: "full" });
    expect(plan.requestEstimate).toEqual({
      byRole: {
        spec: 80,
        wording: 200,
        blind_text: 100,
        blind_vision: 100,
        alignment_text: 100,
        alignment_vision: 100,
      },
      totalLogicalCalls: 680,
      maxTransportAttempts: 2040,
    });
  });

  it("uses the fixed no-early-failure ceilings for the smoke cohort", () => {
    const plan = buildPlanManifest({ runKind: "smoke" });
    expect(plan.requestEstimate).toEqual({
      byRole: {
        spec: 10,
        wording: 20,
        blind_text: 10,
        blind_vision: 10,
        alignment_text: 10,
        alignment_vision: 10,
      },
      totalLogicalCalls: 70,
      maxTransportAttempts: 210,
    });
    expect(
      REQUEST_ROLES.reduce((total, role) => total + plan.requestEstimate.byRole[role], 0),
    ).toBe(70);
  });
});

describe("deterministic streams and PRNG", () => {
  const base = {
    protocolVersion: "1.0.0",
    rootSeed: "puzzle-poc-v1",
    slotId: "text-ranking-01",
  } as const;

  it("derives independent streams per purpose, slot, and root seed", () => {
    const seeds = STREAM_PURPOSES.map((purpose) => deriveStreamSeed({ ...base, purpose }));
    expect(new Set(seeds).size).toBe(STREAM_PURPOSES.length);
    expect(deriveStreamSeed({ ...base, purpose: "spec" })).toBe(
      "d96dc0ef369f87da923e7570c15de896ee4351949a840d4874bf90805ed41cc4",
    );
    expect(deriveStreamSeed({ ...base, purpose: "options" })).toBe(
      "b830175855400799c605a0406a5ce121eda971a60e7db5e379b6844211755e59",
    );
    expect(deriveStreamSeed({ ...base, purpose: "layout" })).toBe(
      "f392a30cad64b58306482f06240682d1a98e668bb2de5f47665ca99d090d2852",
    );
    expect(deriveStreamSeed({ ...base, slotId: "text-ranking-02", purpose: "spec" })).not.toBe(
      deriveStreamSeed({ ...base, purpose: "spec" }),
    );
    expect(deriveStreamSeed({ ...base, rootSeed: "other", purpose: "spec" })).not.toBe(
      deriveStreamSeed({ ...base, purpose: "spec" }),
    );
  });

  it("matches the hash-counter golden vectors", () => {
    const seed = "00".repeat(32);
    const rng = new HashCounterPrng(seed);
    expect(Array.from({ length: 6 }, () => rng.nextUint32())).toEqual([
      741658141, 148898406, 2539025610, 548879576, 2468076581, 4249671215,
    ]);

    const bounded = new HashCounterPrng(seed);
    expect(Array.from({ length: 10 }, () => bounded.nextInt(6))).toEqual([
      1, 0, 0, 2, 5, 5, 2, 3, 2, 0,
    ]);

    const shuffler = new HashCounterPrng(seed);
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const shuffled = shuffler.shuffle(values);
    expect(shuffled).toEqual([9, 7, 8, 4, 6, 5, 0, 2, 3, 1]);
    expect([...shuffled].sort((left, right) => left - right)).toEqual(values);
  });

  it("keeps bounded integers in range and rejects invalid bounds or seeds", () => {
    const seed = "00".repeat(32);
    expect(new HashCounterPrng(seed).nextInt(1)).toBe(0);
    expect(new HashCounterPrng(seed).nextInt(0x100000000)).toBe(741658141);
    for (let draw = 0; draw < 100; draw += 1) {
      const value = new HashCounterPrng(seed).nextInt(6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
    }
    expect(() => new HashCounterPrng(seed).nextInt(0)).toThrow(RangeError);
    expect(() => new HashCounterPrng(seed).nextInt(-1)).toThrow(RangeError);
    expect(() => new HashCounterPrng(seed).nextInt(1.5)).toThrow(RangeError);
    expect(() => new HashCounterPrng(seed).nextInt(0x100000001)).toThrow(RangeError);
    expect(() => new HashCounterPrng("not-a-seed")).toThrow(/32-byte lowercase hexadecimal/);
  });

  it("keeps the fixed root seeds and rejects overrides, including the calibration seed", () => {
    const first = buildPlanManifest({ runKind: "full", rootSeed: ROOT_SEEDS.full });
    const second = buildPlanManifest({ runKind: "full" });
    expect(first).toEqual(second);
    expect(first.planHash).toBe(second.planHash);
    expect(() => buildPlanManifest({ runKind: "full", rootSeed: "puzzle-poc-v2" })).toThrow(
      /fixed to puzzle-poc-v1/,
    );
    expect(() =>
      buildPlanManifest({ runKind: "full", rootSeed: CALIBRATION_ROOT_SEED }),
    ).toThrow(/fixed to puzzle-poc-v1/);
    expect(() => buildPlanManifest({ runKind: "smoke", rootSeed: ROOT_SEEDS.full })).toThrow(
      /fixed to puzzle-smoke-v1/,
    );
  });
});

describe("strict schemas", () => {
  const plan = buildPlanManifest({ runKind: "smoke" });

  it("rejects inconsistent or extra plan manifest fields", () => {
    expect(PlanManifestSchema.safeParse(plan).success).toBe(true);
    expect(PlanManifestSchema.safeParse({ ...plan, extra: true }).success).toBe(false);

    const wrongQuota = clone(plan);
    wrongQuota.quotas.totalSlots = 19;
    expect(PlanManifestSchema.safeParse(wrongQuota).success).toBe(false);

    const wrongDifficulty = clone(plan);
    wrongDifficulty.difficultyCounts[0] = {
      ...wrongDifficulty.difficultyCounts[0]!,
      count: 99,
    };
    expect(PlanManifestSchema.safeParse(wrongDifficulty).success).toBe(false);

    const duplicateId = clone(plan);
    duplicateId.slots[1] = { ...duplicateId.slots[1]!, slotId: duplicateId.slots[0]!.slotId };
    expect(PlanManifestSchema.safeParse(duplicateId).success).toBe(false);

    expect(PlanManifestSchema.safeParse({ ...plan, planHash: "nope" }).success).toBe(false);
    expect(PlanManifestSchema.safeParse({ ...plan, rootSeed: "" }).success).toBe(false);

    const staleHash = clone(plan);
    staleHash.planHash = "0".repeat(64);
    expect(PlanManifestSchema.safeParse(staleHash).success).toBe(false);

    const wrongSeed = clone(plan);
    wrongSeed.rootSeed = CALIBRATION_ROOT_SEED;
    wrongSeed.planHash = computePlanHash(wrongSeed);
    expect(PlanManifestSchema.safeParse(wrongSeed).success).toBe(false);
  });

  it("canonicalizes JSON with sorted object keys and preserved array order", () => {
    expect(canonicalJson({ b: 1, a: [3, 2] })).toBe('{"a":[3,2],"b":1}');
    expect(canonicalJson("value")).toBe('"value"');
    expect(canonicalJson(1.5)).toBe("1.5");
  });

  it("enforces RunManifest role separation and explicit synthetic mock configuration", () => {
    const manifest = makeRunManifest(plan);
    expect(RunManifestSchema.safeParse(manifest).success).toBe(true);
    expect((manifest as { manifestHash: string }).manifestHash).toBe(
      computeRunManifestHash(manifest as object),
    );

    const wrongHash = clone(manifest) as { manifestHash: string };
    wrongHash.manifestHash = "0".repeat(64);
    expect(RunManifestSchema.safeParse(wrongHash).success).toBe(false);

    const sharedGenerator = clone(manifest) as ReturnType<typeof makeRunManifest> & {
      roles: { generator: { model: string }; textReviewer: { model: string } };
    };
    sharedGenerator.roles.textReviewer.model = sharedGenerator.roles.generator.model;
    expect(RunManifestSchema.safeParse(sharedGenerator).success).toBe(false);

    const liveWithMock = clone(manifest);
    (liveWithMock as { evidenceKind: string }).evidenceKind = "live";
    expect(RunManifestSchema.safeParse(liveWithMock).success).toBe(false);

    const mockWithoutConfig = clone(manifest) as { mockConfiguration: unknown };
    mockWithoutConfig.mockConfiguration = null;
    expect(RunManifestSchema.safeParse(mockWithoutConfig).success).toBe(false);

    const providerPinned = clone(manifest) as {
      roles: { generator: { model: string; provider?: string } };
    };
    providerPinned.roles.generator.provider = "fixture-provider";
    expect(RunManifestSchema.safeParse(providerPinned).success).toBe(false);

    const conflictingSort = clone(manifest) as {
      routingConfirmation: { providerSort: string };
    };
    conflictingSort.routingConfirmation.providerSort = "price";
    expect(RunManifestSchema.safeParse(conflictingSort).success).toBe(false);

    const byok = clone(manifest) as {
      routingConfirmation: { byokConfigured: boolean };
    };
    byok.routingConfirmation.byokConfigured = true;
    expect(RunManifestSchema.safeParse(byok).success).toBe(false);
  });

  it("enforces terminal candidate verdicts and paired stage durations", () => {
    const terminal = {
      runId: "123e4567-e89b-12d3-a456-426614174000",
      slotId: "text-ranking-01",
      stage: "terminal",
      verdict: "approved",
      failures: [],
      createdAt: "2026-11-03T22:00:00Z",
      updatedAt: "2026-11-03T22:01:00Z",
    };
    expect(CandidateEnvelopeSchema.safeParse(terminal).success).toBe(true);

    const nonTerminalWithVerdict = { ...terminal, stage: "planned" };
    expect(CandidateEnvelopeSchema.safeParse(nonTerminalWithVerdict).success).toBe(false);

    const terminalWithoutVerdict = { ...terminal, verdict: null };
    expect(CandidateEnvelopeSchema.safeParse(terminalWithoutVerdict).success).toBe(false);

    expect(CandidateEnvelopeSchema.safeParse({ ...terminal, extra: true }).success).toBe(false);
    expect(
      FailureRecordSchema.safeParse({
        code: "SCHEMA_INVALID",
        stage: "planned",
        severity: "high",
        source: "deterministic",
        evidence: null,
      }).success,
    ).toBe(true);
    expect(
      FailureRecordSchema.safeParse({
        code: "NOT_A_CODE",
        stage: "planned",
        severity: "high",
        source: "deterministic",
        evidence: null,
      }).success,
    ).toBe(false);

    const stage = {
      runId: "123e4567-e89b-12d3-a456-426614174000",
      slotId: "text-ranking-01",
      stage: "planned",
      version: 1,
      startedAt: "2026-11-03T22:00:00Z",
      finishedAt: null,
      elapsedMs: null,
      payloadHash: "a".repeat(64),
      artifactHashes: [],
    };
    expect(StageResultEnvelopeSchema.safeParse(stage).success).toBe(true);
    expect(
      StageResultEnvelopeSchema.safeParse({ ...stage, finishedAt: "2026-11-03T22:01:00Z" })
        .success,
    ).toBe(false);
    expect(StageResultEnvelopeSchema.safeParse({ ...stage, elapsedMs: 10 }).success).toBe(false);
  });
});

describe("CLI dry-run", () => {
  it("prints a deterministic manifest without changing the data directory or using the network", () => {
    const dataDirectory = join(process.cwd(), "data");
    const before = existsSync(dataDirectory) ? readdirSync(dataDirectory).sort() : [];
    const result = spawnSync(TSX_BIN, ["--eval", DRY_RUN_PROBE], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const plan = PlanManifestSchema.parse(JSON.parse(result.stdout));
    expect(plan).toEqual(buildPlanManifest({ runKind: "full" }));
    expect(computePlanHash(plan)).toBe(plan.planHash);
    expect(existsSync(dataDirectory) ? readdirSync(dataDirectory).sort() : []).toEqual(before);
  });

  it("rejects conflicting, unavailable, or missing execution modes explicitly", () => {
    const cases: Array<{ args: string[]; message: RegExp }> = [
      {
        args: ["--dry-run", "--full", "--smoke"],
        message: /--full and --smoke are mutually exclusive/,
      },
      {
        args: ["--dry-run", "--mock", "--live"],
        message: /--mock and --live are mutually exclusive/,
      },
      {
        args: ["--dry-run", "--live"],
        message: /live execution requires --allow-paid/,
      },
      {
        args: ["--seed", "puzzle-poc-v1"],
        message: /mock execution requires an explicit --full or --smoke cohort/,
      },
      {
        args: ["--dry-run", "--seed", CALIBRATION_ROOT_SEED],
        message: /fixed to puzzle-poc-v1/,
      },
      {
        args: ["--dry-run", "--smoke", "--seed", "puzzle-poc-v1"],
        message: /fixed to puzzle-smoke-v1/,
      },
    ];
    for (const testCase of cases) {
      const result = spawnSync(TSX_BIN, ["src/cli/experiment.ts", ...testCase.args], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(testCase.message);
    }
  });

  it("uses the run-kind default seed when --seed is omitted", () => {
    const full = spawnSync(TSX_BIN, ["src/cli/experiment.ts", "--dry-run"], {
      encoding: "utf8",
    });
    expect(full.status).toBe(0);
    expect(PlanManifestSchema.parse(JSON.parse(full.stdout)).rootSeed).toBe(ROOT_SEEDS.full);

    const smoke = spawnSync(
      TSX_BIN,
      ["src/cli/experiment.ts", "--dry-run", "--smoke"],
      { encoding: "utf8" },
    );
    expect(smoke.status).toBe(0);
    expect(PlanManifestSchema.parse(JSON.parse(smoke.stdout)).rootSeed).toBe(ROOT_SEEDS.smoke);
  });
});
