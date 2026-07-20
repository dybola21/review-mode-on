import { spawn } from "node:child_process";
import type { QueueDB, QueueRow } from "../queue/db.js";
import type { Config } from "../config.js";
import { runJob } from "../render/render.js";
import { pinoLogger } from "../logger.js";

const WATCHDOG_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_AGE_MS = 90_000;
const JOB_HARD_MAX_MS = 10 * 60 * 1000;

/**
 * In-process scheduler. Polls the DB for the next queued job and runs up to
 * MAX_CONCURRENCY renders in parallel. Includes an independent watchdog that
 * aborts jobs with a stale heartbeat or that exceed the hard wall-clock cap,
 * and ALWAYS releases the running slot on failure.
 */
export class Scheduler {
  private readonly running = new Map<string, AbortController>();
  private accepting = true;
  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: QueueDB,
    private readonly cfg: Config,
  ) {}

  start(): void {
    const recovered = this.db.recoverInProgress();
    if (recovered > 0) pinoLogger.info({ recovered }, "recovered stalled jobs");
    this.schedule();
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
  }

  stopAcceptingNew(): void {
    this.accepting = false;
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.accepting = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    const deadline = Date.now() + timeoutMs;
    for (const ctrl of this.running.values()) ctrl.abort();
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
  }

  /** Snapshot of pool sizes for /health aggregates. */
  runningCount(): number {
    return this.running.size;
  }

  runningJobIds(): string[] {
    return Array.from(this.running.keys());
  }

  isRunning(workerJobId: string): boolean {
    return this.running.has(workerJobId);
  }

  private schedule(): void {
    if (!this.accepting) return;
    this.timer = setTimeout(() => this.tick(), 500);
  }

  private async tick(): Promise<void> {
    try {
      while (this.accepting && this.running.size < this.cfg.MAX_CONCURRENCY) {
        let row: QueueRow | undefined;
        try {
          row = this.db.claimNextQueued();
        } catch (err) {
          pinoLogger.error(
            { err: (err as Error)?.message, event: "scheduler_tick_failed" },
            "scheduler_tick_failed",
          );
          break;
        }
        if (!row) break;

        const waitedSec = Math.max(0, Math.round((Date.now() - Date.parse(row.created_at)) / 1000));
        const counts = safeCounts(this.db);
        pinoLogger.info(
          {
            event: "job_claimed",
            workerJobId: row.worker_job_id,
            appJobId: row.app_job_id,
            queue_wait_seconds: waitedSec,
            queuedJobs: counts.queued,
            processingJobs: counts.processing,
            runningJobs: this.running.size + 1,
          },
          "job_claimed",
        );

        const ctrl = new AbortController();
        this.running.set(row.worker_job_id, ctrl);
        // Always release the slot — even if runJob throws synchronously.
        Promise.resolve()
          .then(() => runJob(this.db, row!, this.cfg, ctrl.signal))
          .catch((err) => pinoLogger.error({ err: (err as Error)?.message }, "job crashed"))
          .finally(() => {
            this.running.delete(row!.worker_job_id);
            const after = safeCounts(this.db);
            pinoLogger.info(
              {
                event: "job_slot_released",
                workerJobId: row!.worker_job_id,
                queuedJobs: after.queued,
                processingJobs: after.processing,
                runningJobs: this.running.size,
              },
              "job_slot_released",
            );
          });
      }
    } finally {
      this.schedule();
    }
  }

  /**
   * Independent watchdog. Aborts jobs whose heartbeat is stale or whose
   * total wall-clock exceeds JOB_HARD_MAX_MS, and marks them as failed so
   * the running slot is freed even when render.ts is stuck in blocking I/O.
   */
  private watchdog(): void {
    let rows: QueueRow[] = [];
    try {
      rows = this.db.listProcessing();
    } catch (err) {
      pinoLogger.error({ err: (err as Error)?.message }, "watchdog_list_failed");
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      const hbAge = row.heartbeat_at ? now - Date.parse(row.heartbeat_at) : Infinity;
      const wall = row.started_at ? now - Date.parse(row.started_at) : 0;
      const stuckHeartbeat = hbAge > HEARTBEAT_MAX_AGE_MS;
      const overTime = wall > JOB_HARD_MAX_MS;
      if (!stuckHeartbeat && !overTime) continue;

      pinoLogger.warn(
        {
          event: "watchdog_abort",
          workerJobId: row.worker_job_id,
          heartbeatAgeMs: Number.isFinite(hbAge) ? hbAge : null,
          wallMs: wall,
          reason: overTime ? "job_timeout" : "heartbeat_stale",
        },
        "watchdog_abort",
      );

      const ctrl = this.running.get(row.worker_job_id);
      if (ctrl) ctrl.abort();
      // Force-fail and free slot even if renderer doesn't finish.
      try {
        this.db.markFailed(
          row.worker_job_id,
          overTime ? "job_timeout" : "heartbeat_stale",
          overTime ? "Job excedeu duração máxima." : "Sem heartbeat.",
        );
      } catch (err) {
        pinoLogger.error({ err: (err as Error)?.message }, "watchdog_mark_failed_failed");
      }
      this.running.delete(row.worker_job_id);
    }
  }
}

function safeCounts(db: QueueDB): { queued: number; processing: number } {
  try {
    return db.countByStatus();
  } catch {
    return { queued: 0, processing: 0 };
  }
}

// -------------------------------------------------------------------------
// Small helper: probe ffmpeg + ffprobe presence at startup / health.
// -------------------------------------------------------------------------
export async function ffmpegAvailable(): Promise<{
  ffmpeg: boolean;
  ffprobe: boolean;
  version: string | null;
}> {
  const [ff, fp] = await Promise.all([bin("ffmpeg"), bin("ffprobe")]);
  return { ffmpeg: ff.ok, ffprobe: fp.ok, version: ff.version };
}

function bin(cmd: string): Promise<{ ok: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["-version"], { shell: false });
    let out = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, version: null });
    }, 3000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(t);
      resolve({ ok: false, version: null });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      const first = out.split("\n")[0]?.trim() ?? null;
      resolve({ ok: code === 0, version: first });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
