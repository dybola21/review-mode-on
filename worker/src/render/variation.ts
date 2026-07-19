import { createHash } from "node:crypto";
import type { VariationSettings } from "../types/contract.js";

/**
 * Deterministic per-output parameters derived from (jobId, workerOutputId,
 * variationIndex). Two runs of the same job produce identical variations
 * even after a restart.
 *
 * Ranges arrive in UI units:
 *  - brightness: -0.2..0.2
 *  - contrast:   0.8..1.2
 *  - saturation: 0.8..1.2
 *  - temperature: -15..15  (UI slider units)
 *  - scale:      1.0..1.1
 *
 * Temperature is converted linearly to the ffmpeg colorbalance range
 * (-0.1..0.1): UI -15 → -0.1, UI 0 → 0, UI 15 → 0.1.
 */

export interface VariationParams {
  brightness: number; // -0.2..0.2 (eq)
  contrast: number; // 0.8..1.2
  saturation: number; // 0.8..1.2
  temperatureShift: number; // -0.1..0.1 (ffmpeg colorbalance rs)
  scale: number; // 1.0..1.1
}

const HARD_BOUNDS = {
  brightness: [-0.2, 0.2],
  contrast: [0.8, 1.2],
  saturation: [0.8, 1.2],
  temperature: [-15, 15], // UI units
  scale: [1.0, 1.1],
} as const;

export function temperatureUiToFfmpeg(ui: number): number {
  // Linear map UI[-15, 15] -> ffmpeg[-0.1, 0.1] with clamp.
  const clamped = Math.max(-15, Math.min(15, ui));
  return round4((clamped / 15) * 0.1);
}

export function computeVariationParams(
  jobId: string,
  workerOutputId: string,
  variationIndex: number,
  v: VariationSettings,
): VariationParams {
  const b = clampRange([v.brightness.min, v.brightness.max], HARD_BOUNDS.brightness);
  const c = clampRange([v.contrast.min, v.contrast.max], HARD_BOUNDS.contrast);
  const s = clampRange([v.saturation.min, v.saturation.max], HARD_BOUNDS.saturation);
  const t = clampRange([v.temperature.min, v.temperature.max], HARD_BOUNDS.temperature);
  const sc = clampRange([v.scale.min, v.scale.max], HARD_BOUNDS.scale);

  const seed = deriveSeed(`${jobId}|${workerOutputId}|${variationIndex}|params`);
  const rng = mulberry32(seed);
  const tempUi = pick(rng(), t);
  return {
    brightness: pick(rng(), b),
    contrast: pick(rng(), c),
    saturation: pick(rng(), s),
    temperatureShift: temperatureUiToFfmpeg(tempUi),
    scale: pick(rng(), sc),
  };
}

/**
 * Deterministic small watermark offset in pixels. Returns 0/0 when jitter
 * is disabled. Bounded to `maxJitterPx` so the mark stays inside the
 * image regardless of position/size.
 */
export function computeWatermarkOffset(
  jobId: string,
  workerOutputId: string,
  variationIndex: number,
  jitterEnabled: boolean,
  maxJitterPx: number,
): { dx: number; dy: number } {
  if (!jitterEnabled || maxJitterPx <= 0) return { dx: 0, dy: 0 };
  const seed = deriveSeed(`${jobId}|${workerOutputId}|${variationIndex}|wm`);
  const rng = mulberry32(seed);
  const dx = Math.round((rng() * 2 - 1) * maxJitterPx);
  const dy = Math.round((rng() * 2 - 1) * maxJitterPx);
  return { dx, dy };
}

function clampRange(r: [number, number], bounds: readonly [number, number]): [number, number] {
  const lo = Math.max(bounds[0], Math.min(bounds[1], Math.min(r[0], r[1])));
  const hi = Math.max(bounds[0], Math.min(bounds[1], Math.max(r[0], r[1])));
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
