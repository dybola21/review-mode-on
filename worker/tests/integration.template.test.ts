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

function hasBin(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["-version"], { shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function ffmpegHasSvg(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-decoders"], { shell: false });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(/\bsvg\b/i.test(out)));
  });
}

async function makeSyntheticSource(dest: string) {
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      dest,
    ];
    const c = spawn("ffmpeg", args, { shell: false });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg src " + code))));
  });
}

async function makeSyntheticLogoPng(dest: string) {
  await new Promise<void>((resolve, reject) => {
    const args = [
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
    ];
    const c = spawn("ffmpeg", args, { shell: false });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg logo " + code))));
  });
}

const TEMPLATE: TemplateSettings = {
  page_name: "Meu Canal",
  identifier: "@meucanal",
  headline: "Título de teste da campanha",
  logo_file_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  background_color: "#0F0F12",
  text_color: "#FFFFFF",
  accent_color: "#FF5A1F",
  watermark_position: "bottom-right",
  watermark_opacity: 0.6,
  header_height_ratio: 0.12,
};

const VARIATION: VariationSettings = {
  brightness: { min: -0.05, max: 0.05 },
  contrast: { min: 0.95, max: 1.05 },
  saturation: { min: 0.95, max: 1.05 },
  temperature: { min: -5, max: 5 },
  scale: { min: 1.0, max: 1.02 },
  watermark_position_jitter: true,
  variation_count: 2,
};

describe("template + ffmpeg composition (skipped when ffmpeg missing)", async () => {
  const ff = await hasBin("ffmpeg");
  const fp = await hasBin("ffprobe");
  const svg = ff ? await ffmpegHasSvg() : false;
  const runIt = ff && fp && svg ? it : it.skip;

  runIt(
    "renders a 1080x1920 h264 with header, logo, headline and watermark",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-int-"));
      const src = path.join(dir, "src.mp4");
      const logo = path.join(dir, "logo.png");
      await makeSyntheticSource(src);
      await makeSyntheticLogoPng(logo);

      const assets = await buildTemplateOverlay({
        width: 1080,
        height: 1920,
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
          targetWidth: 1080,
          targetHeight: 1920,
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
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
    },
    90_000,
  );

  runIt(
    "fails cleanly when logo file cannot be loaded",
    async () => {
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
    },
    30_000,
  );
});
