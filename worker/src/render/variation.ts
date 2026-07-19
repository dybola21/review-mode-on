import { createHash } from "node:crypto";

/**
 * Deterministic per-output parameters derived from (jobId, workerOutputId,
 * variationIndex). Guarantees that two runs of the same job produce the
 * same visual variations, even after a restart.
 */

export interface VariationParams {
  brightness: number; // -1..1 (ffmpeg eq)
  contrast: number; // 0..2
  saturation: number; // 0..2
  temperatureShift: number; // -0.1..0.1 additive to red channel
  scale: number; // 0.9..1.1
}

interface Ranges {
  brightness_range?: [number, number];
  contrast_range?: [number, number];
  saturation_range?: [number, number];
  temperature_range?: [number, number];
  scale_range?: [number, number];
}

const DEFAULTS: Required<Ranges> = {
  brightness_range: [-0.05, 0.05],
  contrast_range: [0.95, 1.1],
  saturation_range: [0.95, 1.1],
  temperature_range: [-0.03, 0.03],
  scale_range: [0.98, 1.02],
};

const HARD_BOUNDS = {
  brightness: [-0.2, 0.2],
  contrast: [0.5, 1.5],
  saturation: [0.5, 1.5],
  temperature: [-0.1, 0.1],
  scale: [0.9, 1.1],
} as const;

export function computeVariationParams(
  jobId: string,
  workerOutputId: string,
  variationIndex: number,
  ranges: Ranges,
): VariationParams {
  const merged: Required<Ranges> = {
    brightness_range: clampRange(ranges.brightness_range ?? DEFAULTS.brightness_range, HARD_BOUNDS.brightness),
    contrast_range: clampRange(ranges.contrast_range ?? DEFAULTS.contrast_range, HARD_BOUNDS.contrast),
    saturation_range: clampRange(ranges.saturation_range ?? DEFAULTS.saturation_range, HARD_BOUNDS.saturation),
    temperature_range: clampRange(ranges.temperature_range ?? DEFAULTS.temperature_range, HARD_BOUNDS.temperature),
    scale_range: clampRange(ranges.scale_range ?? DEFAULTS.scale_range, HARD_BOUNDS.scale),
  };
  const seed = deriveSeed(`${jobId}|${workerOutputId}|${variationIndex}`);
  const rng = mulberry32(seed);
  return {
    brightness: pick(rng(), merged.brightness_range),
    contrast: pick(rng(), merged.contrast_range),
    saturation: pick(rng(), merged.saturation_range),
    temperatureShift: pick(rng(), merged.temperature_range),
    scale: pick(rng(), merged.scale_range),
  };
}

function clampRange(r: [number, number], bounds: readonly [number, number]): [number, number] {
  const lo = Math.max(bounds[0], Math.min(r[0], r[1]));
  const hi = Math.min(bounds[1], Math.max(r[0], r[1]));
  return [lo, hi];
}

function pick(u: number, range: [number, number]): number {
  const [lo, hi] = range;
  return round4(lo + u * (hi - lo));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function deriveSeed(input: string): number {
  const h = createHash("sha256").update(input).digest();
  // Use first 4 bytes as unsigned int
  return h.readUInt32BE(0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
