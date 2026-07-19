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
  overlayPngPath: string | null;
  musicPath: string | null; // present only if user uploaded AND template selected
  outputPath: string;
  variation: VariationParams;
  targetWidth: number;
  targetHeight: number;
  fit: "crop" | "contain";
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

  const w = a.targetWidth;
  const h = a.targetHeight;
  const scaleFactor = a.variation.scale;
  const scaledW = Math.round(w * scaleFactor);
  const scaledH = Math.round(h * scaleFactor);

  // Video filter chain. Uses `,` for graph and never interpolates
  // user-supplied strings (numbers are formatted via toFixed).
  const videoFit =
    a.fit === "crop"
      ? `scale=w=${scaledW}:h=${scaledH}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      : `scale=w=${scaledW}:h=${scaledH}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;

  const eq =
    `eq=brightness=${fmt(a.variation.brightness)}:` +
    `contrast=${fmt(a.variation.contrast)}:` +
    `saturation=${fmt(a.variation.saturation)}`;

  const tempShift = fmt(a.variation.temperatureShift);
  const colorAdjust = `colorbalance=rs=${tempShift}:bs=${fmt(-a.variation.temperatureShift)}`;

  const base = `[0:v]${videoFit},${eq},${colorAdjust},format=yuv420p[vbase]`;
  const filters: string[] = [base];
  let lastVideoLabel = "[vbase]";
  const inputs: string[] = ["-i", a.sourceVideoPath];

  if (a.overlayPngPath) {
    inputs.push("-i", a.overlayPngPath);
    filters.push(`[vbase][1:v]overlay=0:0:format=auto[vout]`);
    lastVideoLabel = "[vout]";
  }

  // Audio wiring.
  let audioArgs: string[] = [];
  const audioMapLabel = "[aout]";
  if (a.musicPath) {
    inputs.push("-i", a.musicPath);
    const musicIndex = a.overlayPngPath ? 2 : 1;
    if (sourceProbe.hasAudio) {
      filters.push(
        `[0:a]volume=1.0[a0];[${musicIndex}:a]volume=0.35[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2${audioMapLabel}`,
      );
    } else {
      filters.push(`[${musicIndex}:a]volume=0.7${audioMapLabel}`);
    }
    audioArgs = ["-map", audioMapLabel, "-c:a", "aac", "-b:a", "160k", "-shortest"];
  } else if (sourceProbe.hasAudio) {
    audioArgs = ["-map", "0:a?", "-c:a", "aac", "-b:a", "160k"];
  } else {
    audioArgs = ["-an"];
  }

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
