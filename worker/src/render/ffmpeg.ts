import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ffprobe, type ProbeInfo } from "../storage/download.js";

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
  outputPath: string;
  targetWidth: number;
  targetHeight: number;
  headerHeight: number;
  crf: number;
  timeoutMs: number;
  maxDurationSeconds: number;
  onProgress?: (progress: number) => void;
  cancel?: AbortSignal;
}

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

/**
 * Build the ffmpeg argv for a single source→output render. Exported so tests
 * can assert that no variation filters (`eq`, `colorbalance`, jitter) appear.
 * The video is scaled and center-cropped to exactly fill the area under the
 * header. Audio is preserved when present, dropped when absent.
 */
export function buildFfmpegArgs(a: RenderArgs, sourceProbe: ProbeInfo): string[] {
  const W = a.targetWidth;
  const H = a.targetHeight;
  const headerH = Math.max(0, Math.min(H, a.headerHeight));
  const videoH = H - headerH;

  // Scale + centered crop to fully cover the remaining video area — no
  // letterboxing, no per-output variation.
  const videoFit =
    `scale=w=${W}:h=${videoH}:force_original_aspect_ratio=increase,` + `crop=${W}:${videoH}`;
  const padOp = headerH > 0 ? `,pad=${W}:${H}:0:${headerH}:color=black` : "";

  const base = `[0:v]${videoFit}${padOp},format=yuv420p[vbase]`;
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
    x = clampInt(x, 0, W - wm.w);
    y = clampInt(y, headerH, H - wm.h);
    const opacity = Math.max(0, Math.min(1, a.watermarkOpacity));
    filters.push(`[${nextInputIdx}:v]format=rgba,colorchannelmixer=aa=${fmt(opacity)}[wmop]`);
    filters.push(`${lastVideoLabel}[wmop]overlay=${x}:${y}:format=auto[vout]`);
    lastVideoLabel = "[vout]";
    nextInputIdx++;
  }

  // Preserve audio when present; otherwise emit a video-only file.
  const audioArgs = sourceProbe.hasAudio
    ? ["-map", "0:a?", "-c:a", "aac", "-b:a", "160k"]
    : ["-an"];

  const filterComplex = filters.join(";");
  const duration = Math.min(
    sourceProbe.durationSeconds || a.maxDurationSeconds,
    a.maxDurationSeconds,
  );

  return [
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
    String(duration),
    a.outputPath,
  ];
}

export async function renderOutput(a: RenderArgs, sourceProbe: ProbeInfo): Promise<void> {
  fs.mkdirSync(path.dirname(a.outputPath), { recursive: true });
  const args = buildFfmpegArgs(a, sourceProbe);

  await runFfmpeg(args, {
    timeoutMs: a.timeoutMs,
    onProgress: a.onProgress,
    durationSeconds: sourceProbe.durationSeconds,
    cancel: a.cancel,
  });

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
      if (signal === "SIGKILL") return;
      if (code === 0) resolve();
      else reject(new RenderError("render_failed", "Render falhou."));
    });

    function cleanup() {
      clearTimeout(timer);
      RUNNING.delete(child);
      opts.cancel?.removeEventListener("abort", abortHandler);
      void errTail;
    }
  });
}
