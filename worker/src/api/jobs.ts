import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { QueueDB } from "../queue/db.js";
import type { Config } from "../config.js";
import type { Scheduler } from "../queue/scheduler.js";
import { CONTRACT_VERSION, jobPayloadSchema } from "../types/contract.js";
import { extractBearer, verifyBearer } from "../security/auth.js";
import { assertAllowedUrl } from "../security/url-allowlist.js";
import { pinoLogger } from "../logger.js";

export function registerJobs(
  app: FastifyInstance,
  db: QueueDB,
  cfg: Config,
  isReady: () => boolean,
  scheduler?: Scheduler,
): void {
  app.post("/jobs", async (req, reply) => {
    if (!isReady()) return reply.code(503).send({ error: "worker_restarting" });

    const bearer = extractBearer(req.headers.authorization);
    if (!verifyBearer(bearer, cfg.WORKER_API_KEY)) {
      return reply.code(401).send({ error: "invalid_auth" });
    }

    const idem = String(req.headers["idempotency-key"] ?? "").trim();
    if (!idem || idem.length < 8 || idem.length > 200) {
      return reply.code(400).send({ error: "missing_idempotency_key" });
    }

    const rawBody = req.body as { contractVersion?: unknown } | null | undefined;
    const cv = rawBody && typeof rawBody === "object" ? rawBody.contractVersion : undefined;
    if (cv !== CONTRACT_VERSION) {
      pinoLogger.warn(
        { error: "contract_version_unsupported", received: typeof cv === "number" ? cv : null },
        "rejected payload with unsupported contract version",
      );
      return reply.code(400).send({ error: "contract_version_unsupported" });
    }

    const parsed = jobPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        code: i.code,
      }));
      pinoLogger.warn({ error: "invalid_payload", issues }, "invalid job payload");
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const payload = parsed.data;

    try {
      for (const inp of payload.inputFiles) {
        assertAllowedUrl(inp.signedUrl, cfg.ALLOWED_DOWNLOAD_HOSTS, "download", cfg.isProduction);
      }
      for (const t of payload.outputTargets) {
        assertAllowedUrl(t.signedUploadUrl, cfg.ALLOWED_UPLOAD_HOSTS, "upload", cfg.isProduction);
      }
    } catch (err) {
      let host: string | null = null;
      if (err instanceof Error && "hostname" in err) {
        const h = (err as { hostname?: unknown }).hostname;
        if (typeof h === "string") host = h;
      }
      pinoLogger.warn({ error: "url_not_allowed", hostname: host }, "rejected url");
      return reply.code(400).send({ error: "url_not_allowed" });
    }

    const row = db.enqueue(payload, idem);
    return reply.code(202).send({ workerJobId: row.worker_job_id });
  });

  // ---------------------------------------------------------------------
  // Internal diagnostic endpoint. Same bearer as POST /jobs.
  // Body: { jobId, workerJobId }. Both must map to the same DB row.
  // Never returns payload, URLs, paths, or secrets.
  // ---------------------------------------------------------------------
  const statusSchema = z.object({
    jobId: z.string().min(1).max(200),
    workerJobId: z.string().min(1).max(200),
  });

  app.post("/internal/job-status", async (req, reply) => {
    const bearer = extractBearer(req.headers.authorization);
    if (!verifyBearer(bearer, cfg.WORKER_API_KEY)) {
      return reply.code(401).send({ error: "invalid_auth" });
    }
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const { jobId, workerJobId } = parsed.data;
    const row = db.getForDiagnostics(jobId, workerJobId);
    if (!row) {
      // Do not leak whether either identifier exists in isolation.
      return reply.code(404).send({ error: "not_found" });
    }
    const now = Date.now();
    const startedMs = row.started_at ? Date.parse(row.started_at) : null;
    const elapsedSeconds = startedMs ? Math.max(0, Math.round((now - startedMs) / 1000)) : 0;
    const queuePosition = row.status === "queued" ? db.queuePosition(row.worker_job_id) : null;
    return reply.code(200).send({
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      queuePosition,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      heartbeatAt: row.heartbeat_at,
      elapsedSeconds,
      lastErrorCode: row.last_error_code,
      running: scheduler?.isRunning(row.worker_job_id) ?? false,
    });
  });
}
