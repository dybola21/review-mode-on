import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { JobPayload } from "../types/contract.js";

// -----------------------------------------------------------------------
// Persistent SQLite job queue. WAL mode. All mutations are transactional.
// -----------------------------------------------------------------------

export type QueueStatus = "queued" | "processing" | "completed" | "failed" | "recovery_pending";

export type QueueStage =
  | "queued"
  | "claimed"
  | "downloading"
  | "preparing"
  | "rendering"
  | "uploading"
  | "completed"
  | "failed";

export interface QueueRow {
  worker_job_id: string;
  app_job_id: string;
  idempotency_key: string;
  status: QueueStatus;
  stage: QueueStage;
  progress: number;
  attempt_count: number;
  payload_json: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
}

export interface WebhookRow {
  id: string;
  worker_job_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  worker_job_id     TEXT PRIMARY KEY,
  app_job_id        TEXT NOT NULL UNIQUE,
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL,
  stage             TEXT NOT NULL DEFAULT 'queued',
  progress          INTEGER NOT NULL DEFAULT 0,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  payload_json      TEXT NOT NULL,
  last_error_code   TEXT,
  last_error_message TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  heartbeat_at      TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS webhooks (
  id                TEXT PRIMARY KEY,
  worker_job_id     TEXT NOT NULL,
  event_id          TEXT NOT NULL UNIQUE,
  event_type        TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  delivered_at      TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_pending_idx
  ON webhooks(delivered_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS uploaded_outputs (
  worker_job_id     TEXT NOT NULL,
  worker_output_id  TEXT NOT NULL,
  file_size         INTEGER NOT NULL,
  checksum          TEXT,
  uploaded_at       TEXT NOT NULL,
  PRIMARY KEY (worker_job_id, worker_output_id)
);
`;

export class QueueDB {
  readonly db: Database.Database;
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "queue.sqlite");
    this.db = new Database(this.file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for DBs created before stage/heartbeat_at existed. */
  private migrate(): void {
    const cols = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(jobs)`)
      .all()
      .map((r) => r.name);
    if (!cols.includes("stage")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued'`);
    }
    if (!cols.includes("heartbeat_at")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* noop */
    }
  }

  // -------------------------------------------------------------------
  // Enqueue with idempotency
  // -------------------------------------------------------------------
  enqueue(payload: JobPayload, idempotencyKey: string): QueueRow {
    const existing = this.db
      .prepare<[string, string], QueueRow>(
        `SELECT * FROM jobs WHERE app_job_id = ? OR idempotency_key = ? LIMIT 1`,
      )
      .get(payload.jobId, idempotencyKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    const row: QueueRow = {
      worker_job_id: randomUUID(),
      app_job_id: payload.jobId,
      idempotency_key: idempotencyKey,
      status: "queued",
      stage: "queued",
      progress: 0,
      attempt_count: 0,
      payload_json: JSON.stringify(payload),
      last_error_code: null,
      last_error_message: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      heartbeat_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (
          worker_job_id, app_job_id, idempotency_key, status, stage, progress, attempt_count,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?)`,
      )
      .run(
        row.worker_job_id,
        row.app_job_id,
        row.idempotency_key,
        row.status,
        row.payload_json,
        row.created_at,
        row.updated_at,
      );
    return row;
  }

  getByWorkerId(workerJobId: string): QueueRow | undefined {
    return this.db
      .prepare<[string], QueueRow>(`SELECT * FROM jobs WHERE worker_job_id = ?`)
      .get(workerJobId);
  }

  getByAppId(appJobId: string): QueueRow | undefined {
    return this.db
      .prepare<[string], QueueRow>(`SELECT * FROM jobs WHERE app_job_id = ?`)
      .get(appJobId);
  }

  /** Diagnostic lookup: both identifiers must match the same row. */
  getForDiagnostics(appJobId: string, workerJobId: string): QueueRow | undefined {
    return this.db
      .prepare<[string, string], QueueRow>(
        `SELECT * FROM jobs WHERE app_job_id = ? AND worker_job_id = ?`,
      )
      .get(appJobId, workerJobId);
  }

  claimNextQueued(): QueueRow | undefined {
    const tx = this.db.transaction((): QueueRow | undefined => {
      const row = this.db
        .prepare<[], QueueRow>(
          `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
        )
        .get();
      if (!row) return undefined;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE jobs SET status = 'processing', stage = 'claimed',
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, ?), updated_at = ?,
             heartbeat_at = ? WHERE worker_job_id = ?`,
        )
        .run(now, now, now, row.worker_job_id);
      return {
        ...row,
        status: "processing",
        stage: "claimed",
        started_at: row.started_at ?? now,
        updated_at: now,
        heartbeat_at: now,
      };
    });
    return tx();
  }

  setStage(workerJobId: string, stage: QueueStage): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET stage = ?, updated_at = ?, heartbeat_at = ? WHERE worker_job_id = ?`,
      )
      .run(stage, now, now, workerJobId);
  }

  heartbeat(workerJobId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE worker_job_id = ?`)
      .run(now, now, workerJobId);
  }

  updateProgress(workerJobId: string, progress: number): void {
    const p = Math.max(0, Math.min(100, Math.round(progress)));
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET progress = ?, updated_at = ?, heartbeat_at = ? WHERE worker_job_id = ?`,
      )
      .run(p, now, now, workerJobId);
  }

  markCompleted(workerJobId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'completed', stage = 'completed', progress = 100,
             completed_at = ?, updated_at = ?, heartbeat_at = ?
         WHERE worker_job_id = ?`,
      )
      .run(now, now, now, workerJobId);
  }

  markFailed(workerJobId: string, code: string, message: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', stage = 'failed',
             last_error_code = ?, last_error_message = ?,
             completed_at = ?, updated_at = ? WHERE worker_job_id = ?`,
      )
      .run(code, message, now, now, workerJobId);
  }

  /** On startup, jobs that were mid-processing are moved back to queued. */
  recoverInProgress(): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', stage = 'queued', updated_at = ?
           WHERE status = 'processing'`,
      )
      .run(now);
    return res.changes;
  }

  requeueForRecovery(workerJobId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', stage = 'queued', updated_at = ?
           WHERE worker_job_id = ? AND status IN ('processing','recovery_pending')`,
      )
      .run(now, workerJobId);
  }

  recordUploadedOutput(
    workerJobId: string,
    workerOutputId: string,
    fileSize: number,
    checksum: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO uploaded_outputs
           (worker_job_id, worker_output_id, file_size, checksum, uploaded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workerJobId, workerOutputId, fileSize, checksum, new Date().toISOString());
  }

  listUploadedOutputs(workerJobId: string): Array<{
    worker_output_id: string;
    file_size: number;
    checksum: string | null;
  }> {
    return this.db
      .prepare<[string], { worker_output_id: string; file_size: number; checksum: string | null }>(
        `SELECT worker_output_id, file_size, checksum FROM uploaded_outputs WHERE worker_job_id = ?`,
      )
      .all(workerJobId);
  }

  deleteUploadedOutput(workerJobId: string, workerOutputId: string): void {
    this.db
      .prepare(
        `DELETE FROM uploaded_outputs
           WHERE worker_job_id = ? AND worker_output_id = ?`,
      )
      .run(workerJobId, workerOutputId);
  }

  // -------------------------------------------------------------------
  // Diagnostics helpers
  // -------------------------------------------------------------------
  countByStatus(): { queued: number; processing: number } {
    const q = this.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued'`)
      .get();
    const p = this.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'processing'`)
      .get();
    return { queued: q?.c ?? 0, processing: p?.c ?? 0 };
  }

  /**
   * 1-based FIFO position among queued rows. Returns null if not queued.
   */
  queuePosition(workerJobId: string): number | null {
    const target = this.db
      .prepare<[string], { status: string; created_at: string }>(
        `SELECT status, created_at FROM jobs WHERE worker_job_id = ?`,
      )
      .get(workerJobId);
    if (!target || target.status !== "queued") return null;
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued' AND created_at <= ?`,
      )
      .get(target.created_at);
    return row?.c ?? null;
  }

  /** Rows currently in 'processing' — used by the scheduler watchdog. */
  listProcessing(): QueueRow[] {
    return this.db
      .prepare<[], QueueRow>(`SELECT * FROM jobs WHERE status = 'processing'`)
      .all();
  }

  // -------------------------------------------------------------------
  // Webhook queue
  // -------------------------------------------------------------------
  enqueueWebhook(
    workerJobId: string,
    eventId: string,
    eventType: string,
    payloadJson: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO webhooks
           (id, worker_job_id, event_id, event_type, payload_json, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(randomUUID(), workerJobId, eventId, eventType, payloadJson, now, now);
  }

  pendingWebhooks(limit: number, nowIso: string): WebhookRow[] {
    return this.db
      .prepare<[string, number], WebhookRow>(
        `SELECT * FROM webhooks
           WHERE delivered_at IS NULL AND next_attempt_at <= ?
           ORDER BY next_attempt_at
           LIMIT ?`,
      )
      .all(nowIso, limit);
  }

  markWebhookDelivered(id: string): void {
    this.db
      .prepare(`UPDATE webhooks SET delivered_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  bumpWebhookAttempt(id: string, nextAttemptAt: string): void {
    this.db
      .prepare(`UPDATE webhooks SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`)
      .run(nextAttemptAt, id);
  }

  isHealthy(): boolean {
    try {
      const r = this.db.prepare(`SELECT 1 AS ok`).get() as { ok: number } | undefined;
      return r?.ok === 1;
    } catch {
      return false;
    }
  }
}
