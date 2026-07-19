import { spawn } from "node:child_process";
import type { QueueDB } from "../queue/db.js";
import type { Config } from "../config.js";
import { runJob } from "../render/render.js";
import { pinoLogger } from "../logger.js";

/**
 * Simple in-process scheduler. Polls the DB for the next queued job and
 * runs up to MAX_CONCURRENCY renders in parallel. Recovery: any job that
 * was `processing` at shutdown is moved back to `queued` on startup.
 */
export class Scheduler {
  private readonly running = new Map<string, AbortController>();
  private accepting = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: QueueDB,
    private readonly cfg: Config,
  ) {}

  start(): void {
    const recovered = this.db.recoverInProgress();
    if (recovered > 0) pinoLogger.info({ recovered }, "recovered stalled jobs");
    this.schedule();
  }

  stopAcceptingNew(): void {
    this.accepting = false;
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.accepting = false;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + timeoutMs;
    for (const ctrl of this.running.values()) ctrl.abort();
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
  }

  private schedule(): void {
    if (!this.accepting) return;
    this.timer = setTimeout(() => this.tick(), 500);
  }

  private async tick(): Promise<void> {
    try {
      while (this.accepting && this.running.size < this.cfg.MAX_CONCURRENCY) {
        const row = this.db.claimNextQueued();
        if (!row) break;
        const ctrl = new AbortController();
        this.running.set(row.worker_job_id, ctrl);
        // Fire-and-await in background.
        runJob(this.db, row, this.cfg, ctrl.signal)
          .catch((err) => pinoLogger.error({ err: (err as Error)?.message }, "job crashed"))
          .finally(() => this.running.delete(row.worker_job_id));
      }
    } finally {
      this.schedule();
    }
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
