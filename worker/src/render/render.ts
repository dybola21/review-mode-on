import fs from "node:fs/promises";
import path from "node:path";

import type { QueueDB, QueueRow } from "../queue/db.js";
import type { JobPayload, InputFile } from "../types/contract.js";
import {
  jobPayloadSchema,
  templateSettingsSchema,
  variationSettingsSchema,
} from "../types/contract.js";
import {
  downloadInput,
  ffprobe,
  assertMimeMatchesProbe,
  DownloadError,
} from "../storage/download.js";
import { uploadOutput, UploadError } from "../storage/upload.js";
import { ensureInsideDir, jobDirName, safeBaseName } from "../storage/paths.js";
import { buildTemplateOverlay, assertTemplateSafe } from "./template.js";
import { renderOutput, RenderError } from "./ffmpeg.js";
import { computeVariationParams } from "./variation.js";
import { renewInputUrl, renewUploadUrl } from "../webhook/renew.js";
import { enqueueWebhook } from "../webhook/sender.js";
import type { Config } from "../config.js";
import { pinoLogger } from "../logger.js";

const OUT_W = 1080;
const OUT_H = 1920;
const DEFAULT_CRF = 22;

/**
 * Full pipeline for one job. Idempotent per workerJobId — the caller
 * ensures we don't run twice for the same row.
 */
export async function runJob(
  db: QueueDB,
  row: QueueRow,
  cfg: Config,
  cancel: AbortSignal,
): Promise<void> {
  const log = pinoLogger.child({ workerJobId: row.worker_job_id, appJobId: row.app_job_id });

  const parsed = jobPayloadSchema.safeParse(JSON.parse(row.payload_json));
  if (!parsed.success) {
    fail(db, row, "invalid_job", "Payload persistido inválido.");
    return;
  }
  const payload = parsed.data;

  // Validate template + variation settings (opaque -> partial schema).
  const template = templateSettingsSchema.parse(payload.templateSettings ?? {});
  const variation = variationSettingsSchema.parse(payload.variationSettings ?? {});
  try {
    assertTemplateSafe(template);
  } catch {
    fail(db, row, "invalid_template", "Template inválido.");
    return;
  }

  const jobRoot = ensureInsideDir(cfg.TEMP_DIR, jobDirName(row.worker_job_id));
  const inputDir = ensureInsideDir(jobRoot, "inputs");
  const outputDir = ensureInsideDir(jobRoot, "outputs");
  const assetsDir = ensureInsideDir(jobRoot, "assets");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });

  const heartbeat = new WallClockLimit(cfg.MAX_JOB_DURATION_SECONDS * 1000);

  try {
    // 1) Download all inputs.
    const localById = new Map<string, { path: string; input: InputFile }>();
    const totalSteps = payload.inputFiles.length + payload.outputTargets.length * 2;
    let stepsDone = 0;

    for (const inp of payload.inputFiles) {
      cancel.throwIfAborted();
      heartbeat.check();
      const dl = await downloadWithRenew(inp, inputDir, payload, row.worker_job_id, cfg);
      const probe = await ffprobe(dl.localPath);
      if (inp.fileType !== "template_asset") {
        // template_asset may be an svg/png — validated via mime.
        assertMimeMatchesProbe(inp.mimeType, probe);
      }
      localById.set(inp.fileId, { path: dl.localPath, input: inp });
      stepsDone += 1;
      emitProgress(db, row, stepsDone, totalSteps);
    }

    const source = [...localById.values()].filter((v) => v.input.fileType === "source_video");
    if (source.length === 0) {
      throw new RenderError("invalid_job", "Nenhum vídeo de origem.");
    }

    const logo = template.logo_file_id ? localById.get(template.logo_file_id) : undefined;
    const music = template.music_file_id ? localById.get(template.music_file_id) : undefined;

    // 2) Build template overlay once per job (2D-only overlay).
    void logo;
    const overlay = await buildTemplateOverlay({
      width: OUT_W,
      height: OUT_H,
      template,
      outDir: assetsDir,
      workerOutputId: row.worker_job_id,
      ffmpegTimeoutMs: 60_000,
    });

    // 3) Render outputs, one at a time.
    for (const target of payload.outputTargets) {
      cancel.throwIfAborted();
      heartbeat.check();

      // Attribute each target to a source deterministically: caller sends
      // sourceCount × variationCount targets in order; we reconstruct by
      // dividing target index. The relative position is what matters.
      const idx = payload.outputTargets.indexOf(target);
      const perSource = payload.variationCount;
      const sourceIdx = Math.floor(idx / perSource) % source.length;
      const variationIdx = (idx % perSource) + 1;
      const src = source[sourceIdx];
      if (!src) throw new RenderError("invalid_job", "Fonte inválida.");

      const outLocal = ensureInsideDir(outputDir, `${safeBaseName(target.workerOutputId)}.mp4`);
      const params = computeVariationParams(
        payload.jobId,
        target.workerOutputId,
        variationIdx,
        variation,
      );
      const srcProbe = await ffprobe(src.path);
      await renderOutput(
        {
          sourceVideoPath: src.path,
          overlayPngPath: overlay.overlayPngPath,
          musicPath: music?.path ?? null,
          outputPath: outLocal,
          variation: params,
          targetWidth: OUT_W,
          targetHeight: OUT_H,
          fit: template.fit === "crop" ? "crop" : "contain",
          crf: DEFAULT_CRF,
          timeoutMs: cfg.FFMPEG_TIMEOUT_SECONDS * 1000,
          maxDurationSeconds: cfg.MAX_JOB_DURATION_SECONDS,
          cancel,
          onProgress: (p) => {
            const localFraction = (stepsDone + p / 100) / totalSteps;
            db.updateProgress(
              row.worker_job_id,
              Math.min(99, Math.max(1, Math.round(localFraction * 100))),
            );
          },
        },
        srcProbe,
      );
      stepsDone += 1;
      emitProgress(db, row, stepsDone, totalSteps);

      // Upload with renewal on 401/403.
      await uploadWithRenew(outLocal, target, payload, row.worker_job_id, cfg);
      db.recordUploadedOutput(
        row.worker_job_id,
        target.workerOutputId,
        (await fs.stat(outLocal)).size,
        null,
      );
      // Remove local output right away.
      await fs.rm(outLocal, { force: true });
      stepsDone += 1;
      emitProgress(db, row, stepsDone, totalSteps);

      // Emit processing webhook (rate-limited via enqueue).
      enqueueWebhook(db, {
        eventType: "status_update",
        jobId: payload.jobId,
        workerJobId: row.worker_job_id,
        status: "processing",
        progress: Math.min(99, Math.round((stepsDone / totalSteps) * 100)),
      });
    }

    // 4) All uploads confirmed → completed.
    const uploaded = db.listUploadedOutputs(row.worker_job_id);
    if (uploaded.length !== payload.outputTargets.length) {
      throw new RenderError("output_upload_failed", "Uploads incompletos.");
    }
    db.markCompleted(row.worker_job_id);
    enqueueWebhook(db, {
      eventType: "status_update",
      jobId: payload.jobId,
      workerJobId: row.worker_job_id,
      status: "completed",
      progress: 100,
      outputs: uploaded.map((u) => {
        const target = payload.outputTargets.find((t) => t.workerOutputId === u.worker_output_id);
        return {
          workerOutputId: u.worker_output_id,
          fileName: target?.fileName ?? "output.mp4",
          mimeType: target?.mimeType ?? "video/mp4",
          fileSize: u.file_size,
          checksum: u.checksum ?? undefined,
        };
      }),
    });
    log.info("job completed");
  } catch (err) {
    const { code, message } = classifyError(err);
    log.warn({ code }, "job failed");
    fail(db, row, code, message);
    enqueueWebhook(db, {
      eventType: "status_update",
      jobId: payload.jobId,
      workerJobId: row.worker_job_id,
      status: "failed",
      progress: 0,
      errorCode: code,
    });
  } finally {
    // Best-effort cleanup of workspace.
    try {
      await fs.rm(jobRoot, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
}

function fail(db: QueueDB, row: QueueRow, code: string, msg: string): void {
  db.markFailed(row.worker_job_id, code, msg);
}

function emitProgress(db: QueueDB, row: QueueRow, done: number, total: number): void {
  const pct = Math.min(99, Math.max(1, Math.round((done / Math.max(1, total)) * 100)));
  db.updateProgress(row.worker_job_id, pct);
}

class WallClockLimit {
  private readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }
  check(): void {
    if (Date.now() > this.deadline) {
      throw new RenderError("render_timeout", "Job excedeu duração máxima.");
    }
  }
}

async function downloadWithRenew(
  input: InputFile,
  destDir: string,
  payload: JobPayload,
  workerJobId: string,
  cfg: Config,
): Promise<{ localPath: string; bytes: number }> {
  let attempt = 0;
  let current = input;
  while (true) {
    attempt += 1;
    try {
      return await downloadInput(current, destDir, {
        maxBytes: cfg.MAX_INPUT_BYTES,
        timeoutMs: 5 * 60 * 1000,
        allowedHosts: cfg.ALLOWED_DOWNLOAD_HOSTS,
        isProduction: cfg.isProduction,
      });
    } catch (err) {
      if (err instanceof DownloadError && err.code === "input_expired" && attempt <= 2) {
        const renewed = await renewInputUrl(payload, workerJobId, input.fileId, cfg);
        current = { ...current, signedUrl: renewed };
        continue;
      }
      if (err instanceof DownloadError && err.code === "input_download_transient" && attempt <= 3) {
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function uploadWithRenew(
  localPath: string,
  target: JobPayload["outputTargets"][number],
  payload: JobPayload,
  workerJobId: string,
  cfg: Config,
): Promise<void> {
  let attempt = 0;
  let currentUrl = target.signedUploadUrl;
  while (true) {
    attempt += 1;
    try {
      await uploadOutput(localPath, currentUrl, target.mimeType, {
        maxBytes: cfg.MAX_OUTPUT_BYTES,
        timeoutMs: 15 * 60 * 1000,
        allowedHosts: cfg.ALLOWED_UPLOAD_HOSTS,
        isProduction: cfg.isProduction,
      });
      return;
    } catch (err) {
      if (err instanceof UploadError && err.code === "output_upload_expired" && attempt <= 2) {
        currentUrl = await renewUploadUrl(payload, workerJobId, target.workerOutputId, cfg);
        continue;
      }
      if (err instanceof UploadError && err.transient && attempt <= 3) {
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
  }

function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof DownloadError) return { code: err.code, message: err.message };
  if (err instanceof UploadError) return { code: err.code, message: err.message };
  if (err instanceof RenderError) return { code: err.code, message: err.message };
  if ((err as { name?: string })?.name === "AbortError") {
    return { code: "worker_restarting", message: "Worker reiniciando." };
  }
  return { code: "render_failed", message: "Falha inesperada." };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Path is used indirectly through ensureInsideDir; explicit import kept for clarity.
void path;
