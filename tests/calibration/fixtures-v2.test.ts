import { describe, expect, it } from "vitest";
import {
  assertCalibrationPack,
  buildCalibrationPack,
  buildCalibrationPackV2,
} from "../../src/calibration/fixtures.js";
import { FAMILIES } from "../../src/domain/experiment.js";

describe("version-2 calibration pack", { timeout: 180_000 }, () => {
  it("builds a disjoint 40-fixture version-2 pack", () => {
    const v2 = buildCalibrationPackV2();
    expect(v2.pack.version).toBe(2);
    expect(v2.fixtures).toHaveLength(40);
    expect(
      v2.fixtures.filter((entry) => entry.fixture.modality === "text"),
    ).toHaveLength(20);
    expect(
      v2.fixtures.filter((entry) => entry.fixture.modality === "svg"),
    ).toHaveLength(20);
    expect(
      v2.fixtures.filter((entry) => entry.fixture.variant === "sound"),
    ).toHaveLength(20);
    expect(
      v2.fixtures.filter((entry) => entry.fixture.variant === "defective"),
    ).toHaveLength(20);
    expect(new Set(v2.fixtures.map((entry) => entry.fixture.family))).toEqual(
      new Set(FAMILIES),
    );
    for (const family of FAMILIES) {
      const entries = v2.fixtures.filter(
        (entry) => entry.fixture.family === family,
      );
      expect(entries).toHaveLength(4);
      expect(
        entries.filter((entry) => entry.fixture.variant === "sound"),
      ).toHaveLength(2);
      expect(
        entries.filter((entry) => entry.fixture.variant === "defective"),
      ).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.fixture.fixtureId).toMatch(/-(0[5-8])$/);
        expect(entry.fixture.slotId).toMatch(/-(10[1-4])$/);
      }
    }

    const v1 = buildCalibrationPack();
    const v1Ids = new Set(
      v1.fixtures.map((entry) => entry.fixture.fixtureId),
    );
    const v1Slots = new Set(
      v1.fixtures.map((entry) => entry.fixture.slotId),
    );
    for (const entry of v2.fixtures) {
      expect(v1Ids.has(entry.fixture.fixtureId)).toBe(false);
      expect(v1Slots.has(entry.fixture.slotId)).toBe(false);
    }
    expect(() => assertCalibrationPack(v2.pack)).not.toThrow();
  });
});
