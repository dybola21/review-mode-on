import { randomUUID } from "node:crypto";
import type { QueueDB } from "../queue/db.js";
import { computeHmacHex, buildSignatureMessage } from "../security/hmac.js";
import type { Config } from "../config.js";
import { pinoLogger } from "../logger.js";

// -----------------------------------------------------------------------
// Webhook enqueue + dispatcher
// -----------------------------------------------------------------------

export interface OutputSummary {
  workerOutputId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  checksum?: string;
}

export interface WebhookEvent {
  eventType: "status_update";
  jobId: string;
  workerJobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | "expired";
  progress: number;
  errorCode?: string;
  errorMessage?: string;
  outputs?: OutputSummary[];
}

// Rate limit: at most one "processing" event per 2s per job.
const lastProcessingPerJob = new Map<string, number>();

export function enqueueWebhook(db: QueueDB, ev: WebhookEvent): void {
  if (ev.status === "processing") {
    const now = Date.now();
    const last = lastProcessingPerJob.get(ev.workerJobId) ?? 0;
    if (now - last < 2000) return;
    lastProcessingPerJob.set(ev.workerJobId, now);
  }
  const body = {
    eventId: randomUUID(),
    eventType: ev.eventType,
    timestamp: Math.floor(Date.now() / 1000),
    jobId: ev.jobId,
    workerJobId: ev.workerJobId,
    status: ev.status,
    progress: ev.progress,
    ...(ev.errorCode ? { errorCode: ev.errorCode } : {}),
    ...(ev.errorMessage ? { errorMessage: ev.errorMessage } : {}),
    ...(ev.outputs ? { outputs: ev.outputs } : {}),
  };
  db.enqueueWebhook(ev.workerJobId, body.eventId, ev.eventType, JSON.stringify(body));
}

export function startWebhookDispatcher(db: QueueDB, cfg: Config, stopSignal: AbortSignal): void {
  const tick = async () => {
    if (stopSignal.aborted) return;
    try {
      const now = new Date().toISOString();
      const pending = db.pendingWebhooks(10, now);
      for (const w of pending) {
        if (stopSignal.aborted) return;
        await dispatchOne(db, cfg, w);
      }
    } catch (err) {
      pinoLogger.warn({ err: (err as Error)?.message }, "dispatcher error");
    } finally {
      if (!stopSignal.aborted) setTimeout(tick, 1000);
    }
  };
  setTimeout(tick, 500);
}

async function dispatchOne(
  db: QueueDB,
  cfg: Config,
  w: { id: string; payload_json: string; attempts: number },
): Promise<void> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = buildSignatureMessage(timestamp, w.payload_json);
  const signature = computeHmacHex(cfg.APP_WEBHOOK_SECRET, message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(cfg.APP_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-signature": signature,
        "x-worker-timestamp": timestamp,
      },
      body: w.payload_json,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 200) {
      db.markWebhookDelivered(w.id);
      return;
    }
    if (res.status === 400 || res.status === 401 || res.status === 409) {
      // Non-retryable — mark delivered so we stop trying and log.
      pinoLogger.warn({ status: res.status, workerId: w.id }, "webhook rejected");
      db.markWebhookDelivered(w.id);
      return;
    }
    scheduleRetry(db, w);
  } catch {
    clearTimeout(timer);
    scheduleRetry(db, w);
  }
}

function scheduleRetry(db: QueueDB, w: { id: string; attempts: number }): void {
  const attempts = w.attempts + 1;
  const backoffSec = Math.min(300, Math.pow(2, Math.min(attempts, 8)));
  const next = new Date(Date.now() + backoffSec * 1000).toISOString();
  db.bumpWebhookAttempt(w.id, next);
}
