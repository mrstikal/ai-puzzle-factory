import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertCalibrationFixture,
  buildCalibrationPack,
  type BuiltCalibrationPack,
  type CalibrationFixture,
} from "../../src/calibration/fixtures.js";
import { writeCalibrationPack } from "../../src/calibration/pack.js";
import {
  PROTOCOL_VERSION,
  ROOT_SEEDS,
} from "../../src/domain/experiment.js";
import { buildPlanManifest } from "../../src/experiment/planner.js";
import { hashPng } from "../../src/render/png.js";
import { hashCanonicalJson, sha256Hex } from "../../src/util/hash.js";
import { deriveStreamSeed } from "../../src/util/random.js";

let built: BuiltCalibrationPack;
let tempDirectory: string;

function fixture(fixtureId: string): CalibrationFixture {
  const found = built.pack.fixtures.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (found === undefined) {
    throw new Error(`missing fixture ${fixtureId}`);
  }
  return found;
}

function fixtureCore(value: CalibrationFixture): Record<string, unknown> {
  const core: Record<string, unknown> = { ...value };
  delete core.fixtureHash;
  delete core.humanVerified;
  delete core.auditor;
  delete core.auditorTime;
  return core;
}

beforeAll(() => {
  built = buildCalibrationPack();
  tempDirectory = mkdtempSync(join(tmpdir(), "puzzle-p40-"));
}, 120_000);

afterAll(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("held-out calibration fixture pack", { timeout: 120_000 }, () => {
  it("contains exactly 40 fixtures with the required family and modality balance", () => {
    expect(built.pack.fixtures).toHaveLength(40);
    expect(
      built.pack.fixtures.filter((entry) => entry.variant === "sound"),
    ).toHaveLength(20);
    expect(
      built.pack.fixtures.filter((entry) => entry.variant === "defective"),
    ).toHaveLength(20);
    expect(
      built.pack.fixtures.filter((entry) => entry.modality === "text"),
    ).toHaveLength(20);
    expect(
      built.pack.fixtures.filter((entry) => entry.modality === "svg"),
    ).toHaveLength(20);
    for (const family of [
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
    ] as const) {
      const familyFixtures = built.pack.fixtures.filter(
        (entry) => entry.family === family,
      );
      expect(
        familyFixtures.filter((entry) => entry.variant === "sound"),
      ).toHaveLength(2);
      expect(
        familyFixtures.filter((entry) => entry.variant === "defective"),
      ).toHaveLength(2);
    }
    expect(new Set(built.pack.fixtures.map((entry) => entry.fixtureId)).size).toBe(40);
    expect(new Set(built.pack.fixtures.map((entry) => entry.slotId)).size).toBe(40);
  });

  it("uses disjoint fixed seeds outside the primary and smoke plans", () => {
    const primarySeeds = new Set<string>();
    for (const runKind of ["full", "smoke"] as const) {
      const plan = buildPlanManifest({ runKind });
      for (const slot of plan.slots) {
        primarySeeds.add(
          deriveStreamSeed({
            protocolVersion: PROTOCOL_VERSION,
            rootSeed: ROOT_SEEDS[runKind],
            slotId: slot.slotId,
            purpose: "spec",
          }),
        );
      }
    }
    const fixtureSeeds = built.pack.fixtures.map((entry) => entry.seed);
    expect(new Set(fixtureSeeds).size).toBe(40);
    for (const seed of fixtureSeeds) {
      expect(seed).toMatch(/^[0-9a-f]{64}$/);
      expect(primarySeeds.has(seed)).toBe(false);
    }
    for (const entry of built.pack.fixtures) {
      if (entry.variant === "defective") {
        expect(entry.sourceFixtureId).not.toBeNull();
        const source = built.pack.fixtures.find(
          (candidate) => candidate.fixtureId === entry.sourceFixtureId,
        );
        expect(source?.family).toBe(entry.family);
        expect(source?.variant).toBe("sound");
      }
    }
  });

  it("keeps every fixture pending human verification and hash-consistent", () => {
    for (const entry of built.pack.fixtures) {
      expect(entry.humanVerified).toBe(false);
      expect(entry.auditor).toBeNull();
      expect(entry.auditorTime).toBeNull();
      expect(entry.fixtureHash).toBe(hashCanonicalJson(fixtureCore(entry)));
      expect(entry.contentHash).toBe(hashCanonicalJson(entry.visible));
      expect(entry.originalContentHash).toBe(
        hashCanonicalJson(entry.original.visible),
      );
      expect(entry.visible.assets.pngHash).toBe(entry.pngHash);
      expect(entry.visible.assets.svgHash).toBe(entry.svgHash);
    }
    expect(
      hashCanonicalJson({
        version: built.pack.version,
        rootSeed: built.pack.rootSeed,
        fixtures: built.pack.fixtures,
      }),
    ).toBe(built.pack.packHash);
  });

  it("keeps sound fixtures solvable and defective fixtures visibly defective", () => {
    for (const entry of built.pack.fixtures) {
      if (entry.variant === "sound") {
        expect(entry.mutation).toBeNull();
        expect(entry.expected.blind.result).toBe("correct");
        expect(entry.expected.blind.correctLabel).not.toBeNull();
        expect(entry.expected.blind.acceptedDefectCodes).toEqual([]);
        expect(entry.expected.alignment.result).toBe("pass");
      } else {
        expect(entry.mutation).not.toBeNull();
        expect(entry.expected.blind.result).not.toBe("correct");
        expect(entry.expected.blind.correctLabel).toBeNull();
        expect(entry.expected.blind.acceptedDefectCodes.length).toBeGreaterThan(0);
        expect(entry.expected.alignment.result).toBe("fail");
        expect(entry.expected.alignment.acceptedFailingFields.length).toBeGreaterThan(0);
      }
    }
  });

  it("proves the duplicate corruption in visible options or rendered tiles", () => {
    for (const entry of built.pack.fixtures.filter(
      (candidate) => candidate.mutation?.kind === "duplicate_correct_option",
    )) {
      expect(entry.expected.blind.acceptedDefectCodes).toContain(
        "DUPLICATE_CORRECT_OPTION",
      );
      if (entry.modality === "text" || entry.family === "counting") {
        const counts = new Map<string, number>();
        for (const option of entry.visible.options) {
          counts.set(option.text, (counts.get(option.text) ?? 0) + 1);
        }
        expect([...counts.values()].some((count) => count >= 2)).toBe(true);
      }
      if (entry.modality !== "text") {
        expect(entry.pngHash).not.toBe(entry.originalPngHash);
      }
    }
  });

  it("proves text, matrix, path, transform, symmetry, and counting consequences", () => {
    for (const entry of built.pack.fixtures.filter(
      (candidate) => candidate.mutation?.kind === "visible_primitive_mutation",
    )) {
      const offered = entry.mutation?.details.offeredValidLabels;
      expect(Array.isArray(offered)).toBe(true);
      expect(offered).not.toHaveLength(1);
      expect(entry.expected.alignment.acceptedFactIds.length).toBeGreaterThan(0);
    }
    const countingDuplicate = fixture("cal-counting-03");
    expect(countingDuplicate.expected.alignment.acceptedFailingFields).toContain(
      "options",
    );
    expect(countingDuplicate.visible.options.map((option) => option.text)).toContain(
      countingDuplicate.mutation?.details.duplicatedOptionText,
    );

    const matrix = fixture("cal-matrix-04");
    expect(matrix.mutation?.details.solutionCount).toBe(0);
    expect(matrix.mutation?.details.offeredValidLabels).toEqual([]);
    expect(matrix.pngHash).not.toBe(matrix.originalPngHash);

    const paths = fixture("cal-paths-04");
    expect(paths.mutation?.details.offeredValidLabels).toEqual([]);
    expect(paths.pngHash).not.toBe(paths.originalPngHash);
    const visibleEdges = paths.mutation?.details.visibleEdges;
    expect(Array.isArray(visibleEdges)).toBe(true);

    const transforms = fixture("cal-transforms-04");
    expect(transforms.mutation?.details.offeredLabels).toHaveLength(2);
    expect(transforms.mutation?.details.instructedDirections).toEqual(
      expect.arrayContaining(["clockwise", "counterclockwise"]),
    );
    expect(transforms.visible.rules.operations.at(-1)).toContain("clockwise");
    expect(transforms.visible.rules.operations.at(-1)).toContain(
      "counterclockwise",
    );

    const symmetry = fixture("cal-symmetry-04");
    expect(symmetry.mutation?.details.displayedAxis).not.toBe(
      symmetry.mutation?.details.instructedAxis,
    );
    expect(symmetry.expected.blind.acceptedDefectCodes).toContain(
      "CONTRADICTORY_SYMMETRY_AXIS",
    );

    const counting = fixture("cal-counting-04");
    expect(counting.mutation?.details.unionCount).not.toBe(
      counting.mutation?.details.overlapCount,
    );
    expect(counting.mutation?.details.offeredCounts).toEqual(
      expect.arrayContaining([
        counting.mutation?.details.unionCount,
        counting.mutation?.details.overlapCount,
      ]),
    );
    expect(counting.visible.options.map((option) => Number(option.text))).toEqual(
      expect.arrayContaining([
        counting.mutation?.details.unionCount,
        counting.mutation?.details.overlapCount,
      ]),
    );
  });

  it("renders real local PNG/SVG artifacts with matching hashes", () => {
    for (const entry of built.fixtures) {
      if (entry.fixture.modality !== "svg") {
        continue;
      }
      expect(entry.artifacts.visible.png).not.toBeNull();
      expect(entry.artifacts.visible.svg).not.toBeNull();
      if (entry.artifacts.visible.png !== null) {
        expect(hashPng(entry.artifacts.visible.png)).toBe(entry.fixture.pngHash);
      }
      if (entry.artifacts.visible.svg !== null) {
        expect(sha256Hex(entry.artifacts.visible.svg)).toBe(
          entry.fixture.svgHash,
        );
      }
      if (entry.fixture.variant === "defective") {
        expect(entry.artifacts.original.png).not.toBeNull();
        expect(entry.artifacts.original.svg).not.toBeNull();
      }
    }
  });

  it("writes a stable pack, pending label template, and answer-free gallery", () => {
    const first = writeCalibrationPack(built, join(tempDirectory, "calibration"));
    const second = writeCalibrationPack(built, join(tempDirectory, "calibration"));
    expect(second.packHash).toBe(first.packHash);
    expect(existsSync(first.packPath)).toBe(true);
    expect(existsSync(first.labelsPath)).toBe(true);
    expect(existsSync(first.galleryPath)).toBe(true);
    expect(existsSync(first.imagesDirectory)).toBe(true);

    const pack = JSON.parse(readFileSync(first.packPath, "utf8")) as {
      packHash: string;
      fixtures: CalibrationFixture[];
    };
    expect(pack.packHash).toBe(built.pack.packHash);
    expect(pack.fixtures).toHaveLength(40);

    const labels = readFileSync(first.labelsPath, "utf8").trimEnd().split("\n");
    expect(labels).toHaveLength(41);
    expect(labels[0] as string).toContain("fixture_id");
    expect(labels[0] as string).toContain("human_verified");
    for (const row of labels.slice(1)) {
      expect(row.endsWith(",false,,,")).toBe(true);
    }

    const gallery = readFileSync(first.galleryPath, "utf8");
    expect(gallery.match(/class="card"/g)).toHaveLength(40);
    expect(gallery).not.toContain("data-variant");
    expect(gallery).not.toContain("acceptedDefectCodes");
    expect(gallery).not.toContain("mutation_kind");
    expect(gallery.match(/src="images\/[^"]+\.png"/g)).toHaveLength(20);
    expect(gallery).toContain("PENDING HUMAN VERIFICATION");

    expect(readdirSync(first.imagesDirectory)).toHaveLength(60);
  });

  it("rejects a defective fixture that still leaves one clear valid offered answer", () => {
    const source = fixture("cal-ranking-01");
    const fake: CalibrationFixture = {
      ...source,
      variant: "defective",
      mutation: {
        kind: "visible_primitive_mutation",
        description: "deliberately invalid test mutation",
        changedFields: ["clues"],
        affectedFactIds: [],
        details: {
          solutionCount: 1,
          offeredValidLabels: ["A"],
        },
      },
      expected: {
        blind: {
          result: "no_unique",
          correctLabel: null,
          acceptedDefectCodes: ["NO_VALID_OFFERED_SOLUTION"],
        },
        alignment: {
          result: "fail",
          acceptedFailingFields: ["clues"],
          acceptedFactIds: [],
        },
      },
    };
    const withHash: CalibrationFixture = {
      ...fake,
      fixtureHash: hashCanonicalJson(fixtureCore(fake)),
    };
    expect(() => assertCalibrationFixture(withHash)).toThrow(
      /one clear valid offered answer/,
    );
  });

  it("is byte-stable across independent builds", () => {
    const again = buildCalibrationPack();
    expect(again.pack.packHash).toBe(built.pack.packHash);
    expect(JSON.stringify(again.pack.fixtures)).toBe(
      JSON.stringify(built.pack.fixtures),
    );
  });
});
