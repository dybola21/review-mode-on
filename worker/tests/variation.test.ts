import { describe, it, expect } from "vitest";
import { computeVariationParams } from "../src/render/variation.js";

describe("variation params", () => {
  it("is deterministic for same seed", () => {
    const a = computeVariationParams("job1", "out1", 1, {});
    const b = computeVariationParams("job1", "out1", 1, {});
    expect(a).toEqual(b);
  });

  it("differs across variation index", () => {
    const a = computeVariationParams("job1", "out1", 1, {});
    const b = computeVariationParams("job1", "out1", 2, {});
    expect(a).not.toEqual(b);
  });

  it("stays inside hard bounds even with abusive ranges", () => {
    const p = computeVariationParams("job", "out", 3, {
      brightness_range: [-999, 999],
      contrast_range: [-999, 999],
      saturation_range: [-999, 999],
      temperature_range: [-999, 999],
      scale_range: [-999, 999],
    });
    expect(p.brightness).toBeGreaterThanOrEqual(-0.2);
    expect(p.brightness).toBeLessThanOrEqual(0.2);
    expect(p.contrast).toBeGreaterThanOrEqual(0.5);
    expect(p.contrast).toBeLessThanOrEqual(1.5);
    expect(p.saturation).toBeGreaterThanOrEqual(0.5);
    expect(p.saturation).toBeLessThanOrEqual(1.5);
    expect(p.temperatureShift).toBeGreaterThanOrEqual(-0.1);
    expect(p.temperatureShift).toBeLessThanOrEqual(0.1);
    expect(p.scale).toBeGreaterThanOrEqual(0.9);
    expect(p.scale).toBeLessThanOrEqual(1.1);
  });
});
