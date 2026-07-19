import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildTemplateOverlay } from "../src/render/template.js";
import { renderOutput } from "../src/render/ffmpeg.js";
import { computeVariationParams, computeWatermarkOffset } from "../src/render/variation.js";
import { ffprobe } from "../src/storage/download.js";
import type { TemplateSettings, VariationSettings } from "../src/types/contract.js";

// Production capability check. If any of these are missing the test MUST fail —
// the CI installs ffmpeg, ffprobe and librsvg2-bin, and production Docker does
// the same, so a missing binary is a real regression, not an environment quirk.
function requireBin(cmd: string, arg = "-version"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [arg], { shell: false });
    child.on("error", (err) => reject(new Error(`missing_bin:${cmd}:${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`bin_bad_exit:${cmd}:${code}`)),
    );
  });
}

const TEMPLATE: TemplateSettings = {
  page_name: "Meu Canal",
  identifier: "@meucanal",
  headline: "Título de teste da campanha",
  logo_file_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  background_color: "#0F0F12", // near-black header
  text_color: "#FFFFFF",
  accent_color: "#FF5A1F", // recognisable accent bar
  watermark_position: "bottom-right",
  watermark_opacity: 0.6,
  header_height_ratio: 0.12,
};

const VARIATION: VariationSettings = {
  brightness: { min: 0, max: 0 },
  contrast: { min: 1, max: 1 },
  saturation: { min: 1, max: 1 },
  temperature: { min: 0, max: 0 },
  scale: { min: 1, max: 1 },
  watermark_position_jitter: true,
  variation_count: 2,
};

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const c = spawn("ffmpeg", args, { shell: false });
    let stderr = "";
    c.stderr.on("data", (b) => (stderr += b.toString()));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code + ": " + stderr)),
    );
  });
}

async function makeSyntheticSource(dest: string) {
  // Solid green source so we can distinguish it from the header background.
  await runFfmpeg([
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x00A000:s=640x360:d=2:rate=24",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    dest,
  ]);
}

async function makeSyntheticLogoPng(dest: string) {
  await runFfmpeg([
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x120:d=0.1",
    "-frames:v",
    "1",
    dest,
  ]);
}

/**
 * Extract a single frame as raw rgb24 so we can read exact pixel colors.
 * Returns { data, width, height } where data.length === width*height*3.
 */
async function extractFrameRgb24(
  videoPath: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const raw = path.join(path.dirname(videoPath), path.basename(videoPath) + ".frame.rgb");
  await runFfmpeg([
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-ss",
    "0.5",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${width}x${height}`,
    raw,
  ]);
  const buf = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  if (buf.length !== width * height * 3) {
    throw new Error(`unexpected raw frame size ${buf.length} != ${width * height * 3}`);
  }
  return buf;
}

function pixel(frame: Buffer, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 3;
  return [frame[i], frame[i + 1], frame[i + 2]];
}

function isNear(
  actual: [number, number, number],
  target: [number, number, number],
  tolerance: number,
): boolean {
  return (
    Math.abs(actual[0] - target[0]) <= tolerance &&
    Math.abs(actual[1] - target[1]) <= tolerance &&
    Math.abs(actual[2] - target[2]) <= tolerance
  );
}

// Sample a small region and return the average color. Averaging smooths h264
// chroma subsampling noise so exact-color checks are stable.
function avgRegion(
  frame: Buffer,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const [pr, pg, pb] = pixel(frame, width, x, y);
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

describe("template + ffmpeg composition (production pipeline)", () => {
  // These MUST be present in CI and in the Docker runtime. If any is missing,
  // the whole file fails at setup — we do NOT quietly skip.
  it("has required binaries: ffmpeg, ffprobe, rsvg-convert", async () => {
    await requireBin("ffmpeg");
    await requireBin("ffprobe");
    await requireBin("rsvg-convert", "--version");
  });

  it("renders 1080x1920 h264 with header, accent, logo, headline and watermark in the configured quadrant", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-int-"));
    const src = path.join(dir, "src.mp4");
    const logo = path.join(dir, "logo.png");
    await makeSyntheticSource(src);
    await makeSyntheticLogoPng(logo);

    const W = 1080;
    const H = 1920;

    const assets = await buildTemplateOverlay({
      width: W,
      height: H,
      template: TEMPLATE,
      outDir: dir,
      jobId: "job-1",
      logoPath: logo,
      ffmpegTimeoutMs: 30_000,
    });
    expect(fs.existsSync(assets.headerOverlayPath)).toBe(true);
    expect(assets.watermarkPngPath).toBeTruthy();

    const jobId = "11111111-1111-1111-1111-111111111111";
    const outId = "22222222-2222-2222-2222-222222222222";
    const params = computeVariationParams(jobId, outId, 1, VARIATION);
    const jitter = computeWatermarkOffset(jobId, outId, 1, true, 40);
    const out = path.join(dir, "out.mp4");
    const srcProbe = await ffprobe(src);
    await renderOutput(
      {
        sourceVideoPath: src,
        headerOverlayPath: assets.headerOverlayPath,
        watermarkPngPath: assets.watermarkPngPath,
        watermarkSize: assets.watermarkSize,
        watermarkPosition: TEMPLATE.watermark_position,
        watermarkOpacity: TEMPLATE.watermark_opacity,
        watermarkJitter: jitter,
        outputPath: out,
        variation: params,
        targetWidth: W,
        targetHeight: H,
        headerHeight: assets.layout.headerHeight,
        crf: 26,
        timeoutMs: 60_000,
        maxDurationSeconds: 30,
      },
      srcProbe,
    );

    const info = await ffprobe(out);
    expect(info.hasVideo).toBe(true);
    expect(info.videoCodec).toBe("h264");
    expect(info.width).toBe(W);
    expect(info.height).toBe(H);

    // Pixel-level checks on an extracted rgb24 frame.
    const frame = await extractFrameRgb24(out, W, H);
    const headerH = assets.layout.headerHeight;
    expect(headerH).toBeGreaterThan(0);
    expect(headerH).toBeLessThan(H);

    // 1) Header band is the configured near-black background (#0F0F12).
    //    Sample a strip near the top-center that should NOT overlap the logo.
    const headerBand = avgRegion(frame, W, Math.floor(W * 0.45), 10, 40, 20);
    expect(isNear(headerBand, [0x0f, 0x0f, 0x12], 24)).toBe(true);

    // 2) Video area starts BELOW the header — sample well below the header
    //    line, near the center, and expect the synthetic green source.
    const videoBand = avgRegion(
      frame,
      W,
      Math.floor(W * 0.4),
      headerH + Math.floor((H - headerH) * 0.5),
      80,
      40,
    );
    // Green channel dominates; red and blue are small.
    expect(videoBand[1]).toBeGreaterThan(120);
    expect(videoBand[0]).toBeLessThan(80);
    expect(videoBand[2]).toBeLessThan(80);

    // 3) Accent color (#FF5A1F) appears somewhere inside the header band.
    let sawAccent = false;
    for (let y = 0; y < headerH && !sawAccent; y += 4) {
      for (let x = 0; x < W && !sawAccent; x += 8) {
        const p = pixel(frame, W, x, y);
        if (isNear(p, [0xff, 0x5a, 0x1f], 40)) sawAccent = true;
      }
    }
    expect(sawAccent).toBe(true);

    // 4) Logo (red) appears inside the header band.
    let sawLogo = false;
    for (let y = 0; y < headerH && !sawLogo; y += 3) {
      for (let x = 0; x < W && !sawLogo; x += 6) {
        const p = pixel(frame, W, x, y);
        if (p[0] > 180 && p[1] < 80 && p[2] < 80) sawLogo = true;
      }
    }
    expect(sawLogo).toBe(true);

    // 5) Watermark (red logo, faded) appears in the bottom-right quadrant
    //    below the header. Jitter shifts a few px but stays inside the frame.
    let sawWatermark = false;
    for (let y = Math.floor(H * 0.75); y < H && !sawWatermark; y += 3) {
      for (let x = Math.floor(W * 0.55); x < W && !sawWatermark; x += 4) {
        const p = pixel(frame, W, x, y);
        if (p[0] - p[1] > 25 && p[0] - p[2] > 25) sawWatermark = true;
      }
    }
    expect(sawWatermark).toBe(true);

    // 6) Watermark stays fully inside the frame — jitter bounded.
    expect(Math.abs(jitter.dx)).toBeLessThanOrEqual(40);
    expect(Math.abs(jitter.dy)).toBeLessThanOrEqual(40);
  }, 120_000);

  it("fails cleanly with template_logo_invalid when logo is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-int-nol-"));
    await expect(
      buildTemplateOverlay({
        width: 1080,
        height: 1920,
        template: TEMPLATE, // references logo_file_id
        outDir: dir,
        jobId: "job-2",
        logoPath: null,
        ffmpegTimeoutMs: 30_000,
      }),
    ).rejects.toThrow(/template_logo_invalid/);
  }, 30_000);

  it("fails cleanly with template_logo_invalid when logo file is not a valid image", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-int-badlogo-"));
    const bogus = path.join(dir, "logo.bogus");
    fs.writeFileSync(bogus, "not-an-image");
    await expect(
      buildTemplateOverlay({
        width: 1080,
        height: 1920,
        template: TEMPLATE,
        outDir: dir,
        jobId: "job-3",
        logoPath: bogus,
        ffmpegTimeoutMs: 15_000,
      }),
    ).rejects.toThrow(/template_logo_invalid/);
  }, 30_000);
});
