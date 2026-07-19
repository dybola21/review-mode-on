import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isTimestampFresh, verifySignature } from "@/lib/render-security";

const bodySchema = z.object({
  jobId: z.string().uuid(),
  workerJobId: z.string().min(1).max(200),
  fileId: z.string().uuid(),
  nonce: z.string().min(8).max(200),
});

const RENEW_TTL_SECONDS = 60 * 60; // 1h
const BUCKET_BY_TYPE: Record<string, string> = {
  source_video: "project-inputs",
  logo: "project-assets",
  music: "project-assets",
  template_asset: "project-assets",
};
const ACTIVE_STATUSES = new Set(["queued", "processing"]);

/**
 * Worker-only endpoint. Renews the signed download URL for a single
 * input file previously sent as part of a job. Requires HMAC signature
 * over `${timestamp}.${rawBody}` using VIDEO_WORKER_WEBHOOK_SECRET, a
 * fresh timestamp (±5min) and a per-request nonce. Response NEVER
 * echoes storagePath and NEVER accepts one from the worker.
 */
export const Route = createFileRoute("/api/public/worker-renew-input")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.VIDEO_WORKER_WEBHOOK_SECRET;
        if (!secret) return new Response("Not configured", { status: 503 });

        const signature = request.headers.get("x-worker-signature");
        const timestamp = request.headers.get("x-worker-timestamp");
        if (!signature || !timestamp) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!isTimestampFresh(timestamp)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const raw = await request.text();
        if (!verifySignature(secret, timestamp, raw, signature)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }
        const parsed = bodySchema.safeParse(json);
        if (!parsed.success) {
          return new Response("Invalid payload", { status: 400 });
        }
        const { jobId, workerJobId, fileId, nonce } = parsed.data;

        let supabaseAdmin;
        try {
          ({ supabaseAdmin } = await import("@/integrations/supabase/client.server"));
        } catch (err) {
          console.error("[renew-input] admin import", err);
          return new Response("Service unavailable", { status: 503 });
        }

        // Anti-replay
        const nonceKey = `renew-input:${nonce}`;
        const { error: nErr } = await supabaseAdmin
          .from("worker_request_nonces")
          .insert({ nonce: nonceKey, purpose: "renew_input" });
        if (nErr) {
          const code = (nErr as { code?: string }).code;
          if (code === "23505") {
            return new Response("Replay", { status: 401 });
          }
          console.error("[renew-input] nonce", nErr);
          return new Response("Service unavailable", { status: 503 });
        }

        const releaseNonce = async () => {
          await supabaseAdmin.from("worker_request_nonces").delete().eq("nonce", nonceKey);
        };

        // Validate job + worker binding + active status
        const { data: job, error: jobErr } = await supabaseAdmin
          .from("render_jobs")
          .select("id, status, worker_job_id, project_id")
          .eq("id", jobId)
          .maybeSingle();
        if (jobErr) {
          await releaseNonce();
          return new Response("Service unavailable", { status: 503 });
        }
        if (!job || job.worker_job_id !== workerJobId) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!ACTIVE_STATUSES.has(job.status)) {
          return new Response("Job is closed", { status: 409 });
        }

        // File must belong to the same project as the job
        const { data: file, error: fErr } = await supabaseAdmin
          .from("project_files")
          .select("id, project_id, storage_path, file_type")
          .eq("id", fileId)
          .eq("project_id", job.project_id)
          .maybeSingle();
        if (fErr) {
          await releaseNonce();
          return new Response("Service unavailable", { status: 503 });
        }
        if (!file) {
          return new Response("Unknown file", { status: 400 });
        }
        const bucket = BUCKET_BY_TYPE[file.file_type];
        if (!bucket) {
          return new Response("Invalid file type", { status: 400 });
        }

        const { data: signed, error: sErr } = await supabaseAdmin.storage
          .from(bucket)
          .createSignedUrl(file.storage_path, RENEW_TTL_SECONDS);
        if (sErr || !signed) {
          console.error("[renew-input] sign", sErr);
          await releaseNonce();
          return new Response("Service unavailable", { status: 503 });
        }

        return new Response(
          JSON.stringify({
            fileId,
            signedUrl: signed.signedUrl,
            expiresIn: RENEW_TTL_SECONDS,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  },
});
