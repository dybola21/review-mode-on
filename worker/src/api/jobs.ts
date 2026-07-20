import type { FastifyInstance } from "fastify";
import type { QueueDB } from "../queue/db.js";
import type { Config } from "../config.js";
import { jobPayloadSchema } from "../types/contract.js";
import { extractBearer, verifyBearer } from "../security/auth.js";
import { assertAllowedUrl } from "../security/url-allowlist.js";
import { pinoLogger } from "../logger.js";

export function registerJobs(
  app: FastifyInstance,
  db: QueueDB,
  cfg: Config,
  isReady: () => boolean,
): void {
  app.post("/jobs", async (req, reply) => {
    if (!isReady()) return reply.code(503).send({ error: "worker_restarting" });

    // Auth
    const bearer = extractBearer(req.headers.authorization);
    if (!verifyBearer(bearer, cfg.WORKER_API_KEY)) {
      return reply.code(401).send({ error: "invalid_auth" });
    }

    // Idempotency-Key required
    const idem = String(req.headers["idempotency-key"] ?? "").trim();
    if (!idem || idem.length < 8 || idem.length > 200) {
      return reply.code(400).send({ error: "missing_idempotency_key" });
    }

    // Body validation (fastify already caps body via bodyLimit).
    const parsed = jobPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      // Log ONLY structural metadata: dotted path + zod code. Never values,
      // URLs, headers, or secrets.
      const issues = parsed.error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        code: i.code,
      }));
      pinoLogger.warn({ error: "invalid_payload", issues }, "invalid job payload");
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const payload = parsed.data;

    // Validate host allowlists BEFORE persisting.
    try {
      for (const inp of payload.inputFiles) {
        assertAllowedUrl(inp.signedUrl, cfg.ALLOWED_DOWNLOAD_HOSTS, "download", cfg.isProduction);
      }
      for (const t of payload.outputTargets) {
        assertAllowedUrl(t.signedUploadUrl, cfg.ALLOWED_UPLOAD_HOSTS, "upload", cfg.isProduction);
      }
    } catch (err) {
      // Log ONLY the rejected hostname (no URL, no query, no path).
      let host: string | null = null;
      if (err instanceof Error && "hostname" in err) {
        const h = (err as { hostname?: unknown }).hostname;
        if (typeof h === "string") host = h;
      }
      pinoLogger.warn({ error: "url_not_allowed", hostname: host }, "rejected url");
      return reply.code(400).send({ error: "url_not_allowed" });
    }

    // Enqueue (idempotent).
    const row = db.enqueue(payload, idem);
    return reply.code(202).send({ workerJobId: row.worker_job_id });
  });
}
