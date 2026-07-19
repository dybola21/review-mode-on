import type { FastifyInstance } from "fastify";
import { ffmpegAvailable } from "../queue/scheduler.js";
import type { QueueDB } from "../queue/db.js";
import type { Config } from "../config.js";

export function registerHealth(
  app: FastifyInstance,
  db: QueueDB,
  cfg: Config,
  isReady: () => boolean,
): void {
  app.get("/health", async (_req, reply) => {
    const avail = await ffmpegAvailable();
    const queueOk = db.isHealthy();
    const ok = avail.ffmpeg && avail.ffprobe && queueOk && isReady();
    reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      ffmpeg: avail.ffmpeg && avail.ffprobe,
      queue: queueOk ? "ready" : "unavailable",
      version: cfg.version,
    });
  });
}
