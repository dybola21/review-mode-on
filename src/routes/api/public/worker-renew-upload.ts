import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isTimestampFresh, verifySignature } from "@/lib/render-security";

const bodySchema = z.object({
  jobId: z.string().uuid(),
  workerJobId: z.string().min(1).max(200),
  workerOutputId: z.string().min(1).max(200),
  nonce: z.string().min(8).max(200),
});

const RENEW_TTL_SECONDS = 60 * 60; // 1h

/**
 * Worker-only endpoint. Renews the signed upload URL for a specific
 * output target. Requires HMAC signature over `${timestamp}.${rawBody}`
 * using the shared VIDEO_WORKER_WEBHOOK_SECRET, a fresh timestamp
 * (±5min) and a per-request nonce persisted for replay protection.
 * Response NEVER echoes secrets and never persists the signed URL.
 */
export const Route = createFileRoute("/api/public/worker-renew-upload")({
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
        const { jobId, workerJobId, workerOutputId, nonce } = parsed.data;

        let supabaseAdmin;
        try {
          ({ supabaseAdmin } = await import("@/integrations/supabase/client.server"));
        } catch (err) {
          console.error("[renew-upload] admin import", err);
          return new Response("Service unavailable", { status: 503 });
        }

        // Anti-replay
        const nonceKey = `renew:${nonce}`;
        const { error: nErr } = await supabaseAdmin
          .from("worker_request_nonces")
          .insert({ nonce: nonceKey, purpose: "renew_upload" });
        if (nErr) {
          const code = (nErr as { code?: string }).code;
          if (code === "23505") {
            return new Response("Replay", { status: 401 });
          }
          console.error("[renew-upload] nonce", nErr);
          return new Response("Service unavailable", { status: 503 });
        }

        // Validate job/worker binding
        const { data: job, error: jobErr } = await supabaseAdmin
          .from("render_jobs")
          .select("id, status, worker_job_id")
          .eq("id", jobId)
          .maybeSingle();
        if (jobErr) return new Response("Service unavailable", { status: 503 });
        if (!job || job.worker_job_id !== workerJobId) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (["completed", "failed", "cancelled", "expired"].includes(job.status)) {
          return new Response("Job is closed", { status: 409 });
        }

        // Find the target
        const { data: target, error: tErr } = await supabaseAdmin
          .from("render_output_targets")
          .select("storage_path")
          .eq("render_job_id", jobId)
          .eq("worker_output_id", workerOutputId)
          .maybeSingle();
        if (tErr) return new Response("Service unavailable", { status: 503 });
        if (!target) return new Response("Unknown output", { status: 400 });

        const { data: signed, error: sErr } = await supabaseAdmin.storage
          .from("render-outputs")
          .createSignedUploadUrl(target.storage_path);
        if (sErr || !signed) {
          console.error("[renew-upload] sign", sErr);
          return new Response("Service unavailable", { status: 503 });
        }

        return new Response(
          JSON.stringify({
            workerOutputId,
            signedUploadUrl: signed.signedUrl,
            expiresInSeconds: RENEW_TTL_SECONDS,
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
