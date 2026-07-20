import { describe, it, expect } from "vitest";
import { buildFfmpegArgs } from "../src/render/ffmpeg.js";

/**
 * Regression: the v2 FFmpeg pipeline must never inject any of the variation
 * filters (`eq`, `colorbalance`) nor an editorial scale factor. The video
 * scale must always target the exact area under the header without any
 * per-output variation.
 */
describe("ffmpeg args (v2 — no variations)", () => {
  const base = {
    sourceVideoPath: "/tmp/src.mp4",
    headerOverlayPath: null,
    watermarkPngPath: null,
    watermarkSize: null,
    watermarkPosition: "bottom-right" as const,
    watermarkOpacity: 0.6,
    outputPath: "/tmp/out.mp4",
    targetWidth: 1080,
    targetHeight: 1920,
    headerHeight: 644,
    crf: 22,
    timeoutMs: 60_000,
    maxDurationSeconds: 30,
  };

  it("emits no `eq=`, `colorbalance=` or scale-jitter filters", () => {
    const args = buildFfmpegArgs(base, {
      hasVideo: true,
      hasAudio: true,
      durationSeconds: 5,
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
    } as never);
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc.includes("eq=")).toBe(false);
    expect(fc.includes("colorbalance")).toBe(false);
    // Video scale is fixed to the video-area, not multiplied by any variation.
    expect(fc).toContain("scale=w=1080:h=1276");
    expect(fc).toContain("crop=1080:1276");
  });

  it("preserves audio when present", () => {
    const args = buildFfmpegArgs(base, {
      hasVideo: true,
      hasAudio: true,
      durationSeconds: 5,
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
    } as never);
    expect(args).toContain("-c:a");
    expect(args).toContain("aac");
    expect(args).not.toContain("-an");
  });

  it("emits -an when source has no audio", () => {
    const args = buildFfmpegArgs(base, {
      hasVideo: true,
      hasAudio: false,
      durationSeconds: 5,
      videoCodec: "h264",
      audioCodec: null,
      width: 1920,
      height: 1080,
    } as never);
    expect(args).toContain("-an");
    expect(args).not.toContain("aac");
  });

  it("always emits H.264, yuv420p, faststart at 1080x1920", () => {
    const args = buildFfmpegArgs(base, {
      hasVideo: true,
      hasAudio: false,
      durationSeconds: 5,
      videoCodec: "h264",
      audioCodec: null,
      width: 1920,
      height: 1080,
    } as never);
    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("-pix_fmt");
    expect(args).toContain("yuv420p");
    expect(args).toContain("+faststart");
  });
});
