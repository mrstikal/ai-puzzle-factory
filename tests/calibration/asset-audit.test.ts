import { describe, expect, it } from "vitest";
import type { ChoiceSet } from "../../src/domain/answers.js";
import type { PathRoute, PathsSpec } from "../../src/families/paths/schema.js";
import { auditPathsAsset } from "../../src/calibration/asset-audit.js";
import { buildCalibrationPilotPack, buildPathsPilotPackV2 } from "../../src/calibration/fixtures.js";

describe("paths asset audit", { timeout: 180_000 }, () => {
  it("passes the sound asset and rejects both deliberate paths mutations", () => {
    const pilot = buildCalibrationPilotPack();
    const audit = (fixtureId: string) => {
      const entry = pilot.fixtures.find(
        (candidate) => candidate.fixture.fixtureId === fixtureId,
      );
      if (entry === undefined) {
        throw new Error(`missing ${fixtureId}`);
      }
      const svg = entry.artifacts.visible.svg;
      const png = entry.artifacts.visible.png;
      if (svg === null || png === null) {
        throw new Error(`${fixtureId} has no visible asset`);
      }
      return auditPathsAsset({
        svg,
        png,
        spec: entry.fixture.original.spec as PathsSpec,
        choices: entry.fixture.original.choices as ChoiceSet<PathRoute>,
        expected: entry.fixture.expected,
        ...(entry.fixture.mutation === null
          ? {}
          : { mutation: entry.fixture.mutation }),
      });
    };

    const sound = audit("cal-paths-97");
    expect(sound).toMatchObject({
      status: "pass",
      sceneError: null,
      rasterEquivalent: true,
      rasterError: null,
      distinctOptionCount: 4,
      duplicateOptionGroups: [],
      validOptionCount: 1,
      checks: {
        scene: true,
        raster: true,
        optionDistinctness: true,
        singleValidOption: true,
      },
    });

    const closed = audit("cal-paths-98");
    expect(closed).toMatchObject({
      status: "fail",
      sceneError: { code: "UNEXPECTED_WALL" },
      rasterEquivalent: true,
      distinctOptionCount: 4,
      duplicateOptionGroups: [],
      validOptionCount: 0,
      checks: {
        scene: false,
        raster: true,
        optionDistinctness: true,
        singleValidOption: false,
      },
    });

    const duplicate = audit("cal-paths-99");
    expect(duplicate).toMatchObject({
      status: "fail",
      sceneError: { code: "WRONG_ROUTE" },
      rasterEquivalent: true,
      distinctOptionCount: 3,
      validOptionCount: 2,
      checks: {
        scene: false,
        raster: true,
        optionDistinctness: false,
        singleValidOption: false,
      },
    });
    expect(duplicate.duplicateOptionGroups).toEqual([["A", "B"]]);
  });

  it("audits the new paths-medium cases with the same deterministic invariant", () => {
    const pilot = buildPathsPilotPackV2();
    const audit = (fixtureId: string) => {
      const entry = pilot.fixtures.find(
        (candidate) => candidate.fixture.fixtureId === fixtureId,
      );
      if (entry === undefined) {
        throw new Error(`missing ${fixtureId}`);
      }
      const svg = entry.artifacts.visible.svg;
      const png = entry.artifacts.visible.png;
      if (svg === null || png === null) {
        throw new Error(`${fixtureId} has no visible asset`);
      }
      return auditPathsAsset({
        svg,
        png,
        spec: entry.fixture.original.spec as PathsSpec,
        choices: entry.fixture.original.choices as ChoiceSet<PathRoute>,
        expected: entry.fixture.expected,
        ...(entry.fixture.mutation === null
          ? {}
          : { mutation: entry.fixture.mutation }),
      });
    };

    expect(audit("cal-paths-12")).toMatchObject({
      status: "pass",
      sceneError: null,
      rasterEquivalent: true,
      distinctOptionCount: 4,
      duplicateOptionGroups: [],
      validOptionCount: 1,
    });
    expect(audit("cal-paths-13")).toMatchObject({
      status: "fail",
      sceneError: { code: "UNEXPECTED_WALL" },
      rasterEquivalent: true,
      distinctOptionCount: 4,
      validOptionCount: 0,
    });
    const duplicate = audit("cal-paths-14");
    expect(duplicate).toMatchObject({
      status: "fail",
      sceneError: { code: "WRONG_ROUTE" },
      rasterEquivalent: true,
      distinctOptionCount: 3,
      validOptionCount: 2,
    });
    expect(duplicate.duplicateOptionGroups).toHaveLength(1);
    expect(duplicate.duplicateOptionGroups[0]).toHaveLength(2);
  });
});
