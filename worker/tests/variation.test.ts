import { describe, it, expect } from "vitest";
import {
  computeVariationParams,
  computeWatermarkOffset,
  temperatureUiToFfmpeg,
} from "../src/render/variation.js";
import type { VariationSettings } from "../src/types/contract.js";

const DEFAULTS: VariationSettings = {
  brightness: { min: -0.05, max: 0.05 },
  contrast: { min: 0.95, max: 1.05 },
  saturation: { min: 0.95, max: 1.05 },
  temperature: { min: -5, max: 5 },
  scale: { min: 1.0, max: 1.03 },
  watermark_position_jitter: false,
  variation_count: 3,
};

describe("variation params", () => {
  it("is deterministic for the same seed", () => {
    const a = computeVariationParams("job1", "out1", 1, DEFAULTS);
    const b = computeVariationParams("job1", "out1", 1, DEFAULTS);
    expect(a).toEqual(b);
  });

  it("differs across variation index", () => {
    const a = computeVariationParams("job1", "out1", 1, DEFAULTS);
    const b = computeVariationParams("job1", "out1", 2, DEFAULTS);
    expect(a).not.toEqual(b);
  });

  it("stays inside hard bounds even with maxed ranges", () => {
    const wide: VariationSettings = {
      brightness: { min: -0.2, max: 0.2 },
      contrast: { min: 0.8, max: 1.2 },
      saturation: { min: 0.8, max: 1.2 },
      temperature: { min: -15, max: 15 },
      scale: { min: 1.0, max: 1.1 },
      watermark_position_jitter: false,
      variation_count: 3,
    };
    for (let i = 1; i <= 20; i++) {
      const p = computeVariationParams("job", "out", i, wide);
      expect(p.brightness).toBeGreaterThanOrEqual(-0.2);
      expect(p.brightness).toBeLessThanOrEqual(0.2);
      expect(p.contrast).toBeGreaterThanOrEqual(0.8);
      expect(p.contrast).toBeLessThanOrEqual(1.2);
      expect(p.saturation).toBeGreaterThanOrEqual(0.8);
      expect(p.saturation).toBeLessThanOrEqual(1.2);
      expect(p.temperatureShift).toBeGreaterThanOrEqual(-0.1);
      expect(p.temperatureShift).toBeLessThanOrEqual(0.1);
      expect(p.scale).toBeGreaterThanOrEqual(1.0);
      expect(p.scale).toBeLessThanOrEqual(1.1);
    }
  });
});

describe("temperatureUiToFfmpeg", () => {
  it("maps 0 to 0 and endpoints to +/-0.1", () => {
    expect(temperatureUiToFfmpeg(0)).toBe(0);
    expect(temperatureUiToFfmpeg(15)).toBeCloseTo(0.1, 4);
    expect(temperatureUiToFfmpeg(-15)).toBeCloseTo(-0.1, 4);
  });
  it("is linear in between", () => {
    expect(temperatureUiToFfmpeg(7.5)).toBeCloseTo(0.05, 4);
  });
  it("clamps values outside the UI range", () => {
    expect(temperatureUiToFfmpeg(999)).toBeCloseTo(0.1, 4);
    expect(temperatureUiToFfmpeg(-999)).toBeCloseTo(-0.1, 4);
  });
});

describe("computeWatermarkOffset", () => {
  it("returns (0,0) when jitter disabled", () => {
    expect(computeWatermarkOffset("job", "out", 1, false, 40)).toEqual({ dx: 0, dy: 0 });
  });
  it("is deterministic when jitter enabled", () => {
    const a = computeWatermarkOffset("job", "out", 1, true, 40);
    const b = computeWatermarkOffset("job", "out", 1, true, 40);
    expect(a).toEqual(b);
  });
  it("varies by output and variation index", () => {
    const a = computeWatermarkOffset("job", "out1", 1, true, 40);
    const b = computeWatermarkOffset("job", "out2", 1, true, 40);
    const c = computeWatermarkOffset("job", "out1", 2, true, 40);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });
  it("respects the pixel budget", () => {
    for (let i = 1; i <= 50; i++) {
      const o = computeWatermarkOffset("job", `out${i}`, i, true, 40);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(40);
      expect(Math.abs(o.dy)).toBeLessThanOrEqual(40);
    }
  });
});
