import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ffprobe, type ProbeInfo } from "../storage/download.js";
import type { VariationParams } from "./variation.js";

export class RenderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderArgs {
  sourceVideoPath: string;
  headerOverlayPath: string | null;
  watermarkPngPath: string | null;
  watermarkSize: { w: number; h: number } | null;
  watermarkPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  watermarkOpacity: number; // 0..1
  watermarkJitter: { dx: number; dy: number };
  outputPath: string;
  variation: VariationParams;
  targetWidth: number;
  targetHeight: number;
  headerHeight: number;
  crf: number;
  timeoutMs: number;
  maxDurationSeconds: number;
  onProgress?: (progress: number) => void;
  cancel?: AbortSignal;
}

// Track running children so shutdown can kill them.
const RUNNING = new Set<ChildProcess>();
export function killAllRunning(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const c of RUNNING) {
    try {
      c.kill(signal);
    } catch {
      /* noop */
    }
  }
}

export async function renderOutput(a: RenderArgs, sourceProbe: ProbeInfo): Promise<void> {
  fs.mkdirSync(path.dirname(a.outputPath), { recursive: true });

  const W = a.targetWidth;
  const H = a.targetHeight;
  const headerH = Math.max(0, Math.min(H, a.headerHeight));
  const videoH = H - headerH;
  const scaleFactor = a.variation.scale;

  // Scale + crop the source so it fully covers the video area, then zoom
  // slightly using scaleFactor. No letterboxing — matches the preview.
  const scaledW = Math.round(W * scaleFactor);
  const scaledVideoH = Math.round(videoH * scaleFactor);
  const videoFit =
    `scale=w=${scaledW}:h=${scaledVideoH}:force_original_aspect_ratio=increase,` +
    `crop=${W}:${videoH}`;

  const eq =
    `eq=brightness=${fmt(a.variation.brightness)}:` +
    `contrast=${fmt(a.variation.contrast)}:` +
    `saturation=${fmt(a.variation.saturation)}`;

  const tempShift = fmt(a.variation.temperatureShift);
  const colorAdjust = `colorbalance=rs=${tempShift}:bs=${fmt(-a.variation.temperatureShift)}`;

  // Add header space above the video (transparent — real header text/logo
  // comes from the overlay PNG rendered on top).
  const padOp = headerH > 0 ? `,pad=${W}:${H}:0:${headerH}:color=black` : "";

  const base = `[0:v]${videoFit},${eq},${colorAdjust}${padOp},format=yuv420p[vbase]`;
  const filters: string[] = [base];
  let lastVideoLabel = "[vbase]";
  const inputs: string[] = ["-i", a.sourceVideoPath];
  let nextInputIdx = 1;

  if (a.headerOverlayPath) {
    inputs.push("-i", a.headerOverlayPath);
    filters.push(`[vbase][${nextInputIdx}:v]overlay=0:0:format=auto[vhdr]`);
    lastVideoLabel = "[vhdr]";
    nextInputIdx++;
  }

  if (a.watermarkPngPath && a.watermarkSize) {
    inputs.push("-i", a.watermarkPngPath);
    const wm = a.watermarkSize;
    const margin = Math.round(W * 0.03);
    let x: number;
    let y: number;
    switch (a.watermarkPosition) {
      case "top-left":
        x = margin;
        y = headerH + margin;
        break;
      case "top-right":
        x = W - wm.w - margin;
        y = headerH + margin;
        break;
      case "bottom-left":
        x = margin;
        y = H - wm.h - margin;
        break;
      default:
        x = W - wm.w - margin;
        y = H - wm.h - margin;
        break;
    }
    x = clampInt(x + a.watermarkJitter.dx, 0, W - wm.w);
    y = clampInt(y + a.watermarkJitter.dy, headerH, H - wm.h);
    const opacity = Math.max(0, Math.min(1, a.watermarkOpacity));
    filters.push(`[${nextInputIdx}:v]format=rgba,colorchannelmixer=aa=${fmt(opacity)}[wmop]`);
    filters.push(`${lastVideoLabel}[wmop]overlay=${x}:${y}:format=auto[vout]`);
    lastVideoLabel = "[vout]";
    nextInputIdx++;
  }

  // Audio: music is intentionally NOT part of this contract version.
  const audioArgs = sourceProbe.hasAudio
    ? ["-map", "0:a?", "-c:a", "aac", "-b:a", "160k"]
    : ["-an"];

  const filterComplex = filters.join(";");

  const args: string[] = [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    lastVideoLabel,
    ...audioArgs,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(clampInt(a.crf, 18, 32)),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    String(Math.min(sourceProbe.durationSeconds || a.maxDurationSeconds, a.maxDurationSeconds)),
    a.outputPath,
  ];

  await runFfmpeg(args, {
    timeoutMs: a.timeoutMs,
    onProgress: a.onProgress,
    durationSeconds: sourceProbe.durationSeconds,
    cancel: a.cancel,
  });

  // Verify output
  let outProbe: ProbeInfo;
  try {
    outProbe = await ffprobe(a.outputPath);
  } catch {
    safeUnlink(a.outputPath);
    throw new RenderError("output_invalid", "Falha ao validar resultado.");
  }
  if (!outProbe.hasVideo || outProbe.videoCodec !== "h264") {
    safeUnlink(a.outputPath);
    throw new RenderError("output_invalid", "Codec inesperado no resultado.");
  }
  const stat = fs.statSync(a.outputPath);
  if (stat.size === 0) {
    safeUnlink(a.outputPath);
    throw new RenderError("output_invalid", "Resultado vazio.");
  }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : "0";
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.round(n);
  return Math.max(lo, Math.min(hi, x));
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* noop */
  }
}

interface RunOpts {
  timeoutMs: number;
  durationSeconds: number;
  onProgress?: (p: number) => void;
  cancel?: AbortSignal;
}

function runFfmpeg(args: string[], opts: RunOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    // Never build FFmpeg command as string; args array + shell: false.
    const child = spawn("ffmpeg", args, { shell: false });
    RUNNING.add(child);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RenderError("render_timeout", "Tempo esgotado no render."));
    }, opts.timeoutMs);

    const abortHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    };
    opts.cancel?.addEventListener("abort", abortHandler);

    let lastEmit = 0;
    child.stdout.on("data", (buf: Buffer) => {
      const s = buf.toString();
      // ffmpeg -progress emits key=value lines. We only care about out_time_ms.
      const m = s.match(/out_time_ms=(\d+)/g);
      if (!m || !opts.durationSeconds || !opts.onProgress) return;
      const last = m[m.length - 1];
      if (!last) return;
      const ms = Number(last.slice("out_time_ms=".length));
      if (!Number.isFinite(ms)) return;
      const pct = Math.min(99, Math.max(1, Math.round((ms / 1000 / opts.durationSeconds) * 100)));
      const now = Date.now();
      if (now - lastEmit >= 1500) {
        lastEmit = now;
        opts.onProgress(pct);
      }
    });

    let errTail = "";
    child.stderr.on("data", (d) => (errTail = (errTail + d.toString()).slice(-4096)));

    child.on("error", () => {
      cleanup();
      reject(new RenderError("render_failed", "Falha ao iniciar ffmpeg."));
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (signal === "SIGKILL") return; // timeout already rejected
      if (code === 0) resolve();
      else reject(new RenderError("render_failed", "Render falhou."));
    });

    function cleanup() {
      clearTimeout(timer);
      RUNNING.delete(child);
      opts.cancel?.removeEventListener("abort", abortHandler);
      // Keep errTail for internal logging; do NOT surface raw output.
      void errTail;
    }
  });
}
