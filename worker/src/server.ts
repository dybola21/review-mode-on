import fs from "node:fs";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "./config.js";
import { QueueDB } from "./queue/db.js";
import { Scheduler } from "./queue/scheduler.js";
import { registerHealth } from "./api/health.js";
import { registerJobs } from "./api/jobs.js";
import { startWebhookDispatcher } from "./webhook/sender.js";
import { killAllRunning } from "./render/ffmpeg.js";
import { pinoLogger } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.mkdirSync(cfg.TEMP_DIR, { recursive: true });

  const db = new QueueDB(cfg.DATA_DIR);
  const scheduler = new Scheduler(db, cfg);
  scheduler.start();

  const shutdownController = new AbortController();
  startWebhookDispatcher(db, cfg, shutdownController.signal);

  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024, // 5 MiB payload cap for POST /jobs
    disableRequestLogging: true,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
  });

  let ready = true;
  registerHealth(app, db, cfg, () => ready);
  registerJobs(app, db, cfg, () => ready);

  app.setErrorHandler((err, _req, reply) => {
    const msg = err instanceof Error ? err.message : "internal";
    pinoLogger.warn({ err: msg }, "fastify error");
    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    reply.status(status).send({ error: "internal_error" });
  });

  const address = await app.listen({ host: "0.0.0.0", port: cfg.PORT });
  pinoLogger.info({ address, version: cfg.version }, "worker listening");

  if (!cfg.DISABLE_SHUTDOWN_HOOKS) {
    const shutdown = async (signal: NodeJS.Signals) => {
      pinoLogger.info({ signal }, "shutdown initiated");
      ready = false;
      scheduler.stopAcceptingNew();
      try {
        await app.close();
      } catch {
        /* noop */
      }
      shutdownController.abort();
      // Give ffmpeg a chance to exit gracefully.
      const graceful = setTimeout(() => killAllRunning("SIGKILL"), 15_000);
      await scheduler.shutdown(20_000);
      clearTimeout(graceful);
      try {
        db.close();
      } catch {
        /* noop */
      }
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("worker failed to start:", (err as Error)?.message ?? err);
  process.exit(1);
});
