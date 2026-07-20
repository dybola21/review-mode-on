import type { FastifyInstance } from "fastify";
import { ffmpegAvailable, type Scheduler } from "../queue/scheduler.js";
import type { QueueDB } from "../queue/db.js";
import type { Config } from "../config.js";

export function registerHealth(
  app: FastifyInstance,
  db: QueueDB,
  cfg: Config,
  isReady: () => boolean,
  scheduler?: Scheduler,
): void {
  app.get("/health", async (_req, reply) => {
    const avail = await ffmpegAvailable();
    const queueOk = db.isHealthy();
    const ok = avail.ffmpeg && avail.ffprobe && queueOk && isReady();
    let queuedJobs = 0;
    let processingJobs = 0;
    try {
      const c = db.countByStatus();
      queuedJobs = c.queued;
      processingJobs = c.processing;
    } catch {
      /* ignore aggregate errors */
    }
    reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      ffmpeg: avail.ffmpeg && avail.ffprobe,
      queue: queueOk ? "ready" : "unavailable",
      version: cfg.version,
      queuedJobs,
      processingJobs,
      runningJobs: scheduler?.runningCount() ?? 0,
    });
  });
}
