import fs from "node:fs/promises";
import path from "node:path";

import type { QueueDB, QueueRow } from "../queue/db.js";
import type { JobPayload, InputFile } from "../types/contract.js";
import { jobPayloadSchema, templateSettingsSchema } from "../types/contract.js";
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
import { renewInputUrl, renewUploadUrl } from "../webhook/renew.js";
import { verifyRemoteOutput } from "../webhook/verify.js";

import { enqueueWebhook } from "../webhook/sender.js";
import type { Config } from "../config.js";
import { pinoLogger } from "../logger.js";

const OUT_W = 1080;
const OUT_H = 1920;
const DEFAULT_CRF = 22;

/**
 * v2 pipeline: sequential 1 header art + N source videos → N outputs.
 * Every output is tied to exactly one sourceFileId. No variation filters.
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

  const templateResult = templateSettingsSchema.safeParse(payload.templateSettings);
  if (!templateResult.success) {
    fail(db, row, "invalid_template", "Template inválido.");
    return;
  }
  const template = templateResult.data;
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

  log.info(
    { inputs: payload.inputFiles.length, outputs: payload.outputTargets.length },
    "job_claimed",
  );

  // Signal "processing" immediately so the app updates the UI.
  enqueueWebhook(db, {
    eventType: "status_update",
    jobId: payload.jobId,
    workerJobId: row.worker_job_id,
    status: "processing",
    progress: 1,
  });

  try {
    const localById = new Map<string, { path: string; input: InputFile }>();

    for (const inp of payload.inputFiles) {
      cancel.throwIfAborted();
      heartbeat.check();
      const dl = await downloadWithRenew(inp, inputDir, payload, row.worker_job_id, cfg);
      const probe = await ffprobe(dl.localPath);
      if (inp.fileType !== "template_asset") {
        assertMimeMatchesProbe(inp.mimeType, probe);
      }
      localById.set(inp.fileId, { path: dl.localPath, input: inp });
    }

    const sourceList = [...localById.values()].filter((v) => v.input.fileType === "source_video");
    if (sourceList.length === 0) {
      throw new RenderError("invalid_job", "Nenhum vídeo de origem.");
    }

    let logoPath: string | null = null;
    if (template.logo_file_id) {
      const logoEntry = localById.get(template.logo_file_id);
      if (!logoEntry) {
        throw new RenderError("template_logo_invalid", "Logo do template não foi enviado.");
      }
      if (!logoEntry.input.mimeType.startsWith("image/")) {
        throw new RenderError("template_logo_invalid", "Logo do template não é uma imagem.");
      }
      logoPath = logoEntry.path;
    }

    let headerImagePath: string | null = null;
    let headerImageNaturalSize: { w: number; h: number } | null = null;
    if (template.header_image_file_id) {
      const headerEntry = localById.get(template.header_image_file_id);
      if (!headerEntry) {
        throw new RenderError("header_image_invalid", "Arte do cabeçalho não foi enviada.");
      }
      if (!headerEntry.input.mimeType.startsWith("image/")) {
        throw new RenderError("header_image_invalid", "Arte do cabeçalho não é uma imagem.");
      }
      headerImagePath = headerEntry.path;
      try {
        const probe = await ffprobe(headerImagePath);
        if (probe.width && probe.height && probe.width > 0 && probe.height > 0) {
          headerImageNaturalSize = { w: probe.width, h: probe.height };
        }
      } catch {
        headerImageNaturalSize = null;
      }
    }

    const overlay = await buildTemplateOverlay({
      width: OUT_W,
      height: OUT_H,
      template,
      outDir: assetsDir,
      jobId: row.worker_job_id,
      logoPath,
      headerImagePath,
      headerImageNaturalSize,
      ffmpegTimeoutMs: 60_000,
    });

    // Skip outputs already uploaded in a previous run (with remote check).
    const alreadyUploaded = new Set(
      db.listUploadedOutputs(row.worker_job_id).map((o) => o.worker_output_id),
    );

    const totalTargets = payload.outputTargets.length;
    let processedCount = 0;

    for (const target of payload.outputTargets) {
      cancel.throwIfAborted();
      heartbeat.check();

      if (alreadyUploaded.has(target.workerOutputId)) {
        const verified = await verifyRemoteOutputWithRetry(
          cfg,
          payload.jobId,
          row.worker_job_id,
          target.workerOutputId,
          cancel,
        );
        const action = decideRecoveryAction(verified);
        if (action === "abort") {
          throw new RenderError("verify_output_unauthorized", "Verificação de output negada.");
        }
        if (action === "defer") {
          throw new RecoveryDeferError(target.workerOutputId);
        }
        if (action === "skip") {
          processedCount += 1;
          emitProgress(db, row, processedCount, totalTargets);
          continue;
        }
        db.deleteUploadedOutput(row.worker_job_id, target.workerOutputId);
        alreadyUploaded.delete(target.workerOutputId);
      }

      const src = localById.get(target.sourceFileId);
      if (!src || src.input.fileType !== "source_video") {
        throw new RenderError("invalid_job", "sourceFileId não encontrado nos inputs.");
      }

      log.info({ sourceFileId: target.sourceFileId }, "input_started");

      const outLocal = ensureInsideDir(outputDir, `${safeBaseName(target.workerOutputId)}.mp4`);
      const srcProbe = await ffprobe(src.path);
      await renderOutput(
        {
          sourceVideoPath: src.path,
          headerOverlayPath: overlay.headerOverlayPath,
          watermarkPngPath: overlay.watermarkPngPath,
          watermarkSize: overlay.watermarkSize,
          watermarkPosition: template.watermark_position,
          watermarkOpacity: template.watermark_opacity,
          outputPath: outLocal,
          targetWidth: OUT_W,
          targetHeight: OUT_H,
          headerHeight: overlay.layout.headerHeight,
          crf: DEFAULT_CRF,
          timeoutMs: cfg.FFMPEG_TIMEOUT_SECONDS * 1000,
          maxDurationSeconds: cfg.MAX_JOB_DURATION_SECONDS,
          cancel,
          onProgress: (p) => {
            const fraction = (processedCount + p / 100) / totalTargets;
            db.updateProgress(
              row.worker_job_id,
              Math.min(99, Math.max(1, Math.round(fraction * 100))),
            );
          },
        },
        srcProbe,
      );

      await uploadWithRenew(outLocal, target, payload, row.worker_job_id, cfg);
      db.recordUploadedOutput(
        row.worker_job_id,
        target.workerOutputId,
        (await fs.stat(outLocal)).size,
        null,
      );
      await fs.rm(outLocal, { force: true });

      processedCount += 1;
      emitProgress(db, row, processedCount, totalTargets);

      log.info(
        { sourceFileId: target.sourceFileId, done: processedCount, total: totalTargets },
        "input_completed",
      );

      enqueueWebhook(db, {
        eventType: "status_update",
        jobId: payload.jobId,
        workerJobId: row.worker_job_id,
        status: "processing",
        progress: Math.min(99, Math.round((processedCount / totalTargets) * 100)),
      });
    }

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
    log.info("job_completed");
  } catch (err) {
    if (err instanceof RecoveryDeferError) {
      log.warn(
        { workerOutputId: err.workerOutputId },
        "recovery verification transient — requeueing job without failing",
      );
      db.requeueForRecovery(row.worker_job_id);
      return;
    }
    const { code, message } = classifyError(err);
    log.warn({ code }, "job_failed");
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

export class RecoveryDeferError extends Error {
  readonly code = "recovery_deferred";
  constructor(readonly workerOutputId: string) {
    super(`verification transient for output ${workerOutputId}; deferring recovery`);
  }
}

export type VerifyRetryResult =
  { kind: "ok"; exists: boolean; size: number } | { kind: "auth" } | { kind: "transient" };

export function decideRecoveryAction(
  v: VerifyRetryResult,
): "skip" | "reprocess" | "abort" | "defer" {
  if (v.kind === "auth") return "abort";
  if (v.kind === "transient") return "defer";
  if (v.exists && v.size > 0) return "skip";
  return "reprocess";
}

export async function verifyRemoteOutputWithRetry(
  cfg: Config,
  jobId: string,
  workerJobId: string,
  workerOutputId: string,
  cancel: AbortSignal,
): Promise<VerifyRetryResult> {
  const delays = [0, 500, 1500, 4000];
  for (let i = 0; i < delays.length; i += 1) {
    cancel.throwIfAborted();
    const d = delays[i] ?? 0;
    if (d > 0) await sleep(d);
    const r = await verifyRemoteOutput(cfg, jobId, workerJobId, workerOutputId);
    if (r.kind === "ok") return r;
    if (r.kind === "auth") return r;
  }
  return { kind: "transient" };
}

void path;
