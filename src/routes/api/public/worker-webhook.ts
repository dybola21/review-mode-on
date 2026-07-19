import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isTimestampFresh, verifySignature } from "@/lib/render-security";

/** Only workerOutputId is meaningful here — server owns storagePath. */
const outputSchema = z.object({
  workerOutputId: z.string().min(1).max(200),
  fileSize: z.number().int().nonnegative().optional(),
  checksum: z.string().min(1).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
});

const webhookSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(120),
  timestamp: z.string().min(1).max(60),
  jobId: z.string().uuid(),
  workerJobId: z.string().min(1).max(200),
  status: z.enum(["queued", "processing", "completed", "failed", "cancelled", "expired"]),
  progress: z.number().int().min(0).max(100).optional(),
  errorCode: z.string().max(120).optional(),
  errorMessage: z.string().max(500).optional(),
  outputs: z.array(outputSchema).optional(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  submitting: ["queued", "processing", "failed"],
  queued: ["queued", "processing", "failed", "cancelled"],
  processing: ["processing", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);

function sanitize(str: string | undefined, max = 500): string | null {
  if (!str) return null;
  return str.replace(/[\r\n\t]+/g, " ").slice(0, max);
}

async function verifyStorageObject(
  admin: {
    storage: {
      from: (b: string) => {
        list: (
          path: string,
          opts: { search: string },
        ) => Promise<{
          data: Array<{
            name: string;
            metadata?: { size?: number } | null;
          }> | null;
          error: unknown;
        }>;
      };
    };
  },
  storagePath: string,
): Promise<{ exists: boolean; size: number }> {
  const parts = storagePath.split("/");
  if (parts.length < 2) return { exists: false, size: 0 };
  const parent = parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1];
  const { data } = await admin.storage.from("render-outputs").list(parent, { search: name });
  const found = (data ?? []).find((o) => o.name === name);
  if (!found) return { exists: false, size: 0 };
  const size = Number(found.metadata?.size ?? 0);
  return { exists: true, size };
}

export const Route = createFileRoute("/api/public/worker-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.VIDEO_WORKER_WEBHOOK_SECRET;
        if (!secret) {
          console.error("[worker-webhook] missing secret");
          return new Response("Not configured", { status: 503 });
        }

        const signature = request.headers.get("x-worker-signature");
        const timestamp = request.headers.get("x-worker-timestamp");
        if (!signature || !timestamp) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!isTimestampFresh(timestamp)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const rawBody = await request.text();
        if (!verifySignature(secret, timestamp, rawBody, signature)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payloadJson: unknown;
        try {
          payloadJson = JSON.parse(rawBody);
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }
        const parsed = webhookSchema.safeParse(payloadJson);
        if (!parsed.success) {
          return new Response("Invalid payload", { status: 400 });
        }
        const evt = parsed.data;

        let supabaseAdmin;
        try {
          ({ supabaseAdmin } = await import("@/integrations/supabase/client.server"));
        } catch (err) {
          console.error("[worker-webhook] admin import", err);
          return new Response("Service unavailable", { status: 503 });
        }

        // Idempotency: record eventId; if duplicate, ACK 200.
        const nonceKey = `webhook:${evt.eventId}`;
        {
          const { error: nErr } = await supabaseAdmin
            .from("worker_request_nonces")
            .insert({ nonce: nonceKey, purpose: "webhook" });
          if (nErr) {
            const code = (nErr as { code?: string }).code;
            if (code === "23505") {
              // Already processed
              return new Response("ok", { status: 200 });
            }
            console.error("[worker-webhook] nonce insert", nErr);
            return new Response("Service unavailable", { status: 503 });
          }
        }

        // Fetch job
        const { data: job, error: jobErr } = await supabaseAdmin
          .from("render_jobs")
          .select("id, status, user_id, project_id, worker_job_id")
          .eq("id", evt.jobId)
          .maybeSingle();
        if (jobErr) {
          console.error("[worker-webhook] job lookup", jobErr);
          return new Response("Service unavailable", { status: 503 });
        }
        if (!job) {
          // Don't leak existence, but do NOT 200-swallow silently — 401.
          return new Response("Unauthorized", { status: 401 });
        }
        if (job.worker_job_id && job.worker_job_id !== evt.workerJobId) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Already terminal? Duplicate → 200.
        if (FINAL_STATUSES.has(job.status)) {
          return new Response("ok", { status: 200 });
        }

        // Transition check → 409 if invalid.
        const allowed = ALLOWED_TRANSITIONS[job.status] ?? [];
        if (!allowed.includes(evt.status)) {
          return new Response("Invalid transition", { status: 409 });
        }

        // Compute progress
        let progress: number | undefined;
        if (evt.status === "completed") progress = 100;
        else if (evt.status === "processing" && evt.progress !== undefined) {
          progress = Math.min(99, Math.max(1, evt.progress));
        } else if (evt.status === "queued") progress = 0;

        // ================ COMPLETED ================
        if (evt.status === "completed") {
          if (!evt.outputs || evt.outputs.length === 0) {
            const { error } = await supabaseAdmin
              .from("render_jobs")
              .update({
                status: "failed",
                error_code: "no_outputs",
                error_message: "Processamento não retornou arquivos.",
                completed_at: new Date().toISOString(),
              })
              .eq("id", job.id);
            if (error) return new Response("Service unavailable", { status: 503 });
            await supabaseAdmin
              .from("projects")
              .update({ status: "failed" })
              .eq("id", job.project_id);
            return new Response("ok", { status: 200 });
          }

          // Load expected targets
          const { data: targets, error: tErr } = await supabaseAdmin
            .from("render_output_targets")
            .select("worker_output_id, file_name, storage_path, mime_type")
            .eq("render_job_id", job.id);
          if (tErr || !targets) {
            console.error("[worker-webhook] targets", tErr);
            return new Response("Service unavailable", { status: 503 });
          }

          if (evt.outputs.length > targets.length) {
            return new Response("Too many outputs", { status: 400 });
          }

          const targetMap = new Map(targets.map((t) => [t.worker_output_id, t]));

          const insertedIds: string[] = [];
          let failReason: string | null = null;

          for (const out of evt.outputs) {
            const target = targetMap.get(out.workerOutputId);
            if (!target) {
              failReason = "unknown_output";
              break;
            }
            const check = await verifyStorageObject(supabaseAdmin, target.storage_path);
            if (!check.exists) {
              failReason = "missing_upload";
              break;
            }
            if (check.size <= 0) {
              failReason = "empty_upload";
              break;
            }
            // Idempotent per target
            const { data: existing } = await supabaseAdmin
              .from("render_outputs")
              .select("id")
              .eq("render_job_id", job.id)
              .eq("worker_output_id", out.workerOutputId)
              .maybeSingle();
            if (existing) {
              insertedIds.push(existing.id);
              continue;
            }
            const { data: inserted, error: insErr } = await supabaseAdmin
              .from("render_outputs")
              .insert({
                render_job_id: job.id,
                project_id: job.project_id,
                user_id: job.user_id,
                worker_output_id: out.workerOutputId,
                file_name: target.file_name,
                storage_path: target.storage_path,
                file_size: check.size,
                mime_type: target.mime_type,
                checksum: out.checksum ?? null,
                expires_at: out.expiresAt ?? null,
              })
              .select("id")
              .single();
            if (insErr || !inserted) {
              console.error("[worker-webhook] output insert", insErr);
              // Transient DB error → let worker retry.
              if (insertedIds.length > 0) {
                await supabaseAdmin.from("render_outputs").delete().in("id", insertedIds);
              }
              // Free nonce so retry is accepted.
              await supabaseAdmin.from("worker_request_nonces").delete().eq("nonce", nonceKey);
              return new Response("Service unavailable", { status: 503 });
            }
            insertedIds.push(inserted.id);
          }

          if (failReason) {
            if (insertedIds.length > 0) {
              await supabaseAdmin.from("render_outputs").delete().in("id", insertedIds);
            }
            await supabaseAdmin
              .from("render_jobs")
              .update({
                status: "failed",
                error_code: failReason,
                error_message: "Resultado incompleto.",
                completed_at: new Date().toISOString(),
              })
              .eq("id", job.id);
            await supabaseAdmin
              .from("projects")
              .update({ status: "failed" })
              .eq("id", job.project_id);
            return new Response("ok", { status: 200 });
          }

          const { error: jobUpdErr } = await supabaseAdmin
            .from("render_jobs")
            .update({
              status: "completed",
              progress: 100,
              completed_at: new Date().toISOString(),
            })
            .eq("id", job.id);
          if (jobUpdErr) {
            console.error("[worker-webhook] job complete", jobUpdErr);
            await supabaseAdmin.from("worker_request_nonces").delete().eq("nonce", nonceKey);
            return new Response("Service unavailable", { status: 503 });
          }
          await supabaseAdmin
            .from("projects")
            .update({ status: "completed" })
            .eq("id", job.project_id);
          return new Response("ok", { status: 200 });
        }

        // ================ Non-completed transitions ================
        const patch: {
          status: typeof evt.status;
          progress?: number;
          completed_at?: string;
          error_code?: string;
          error_message?: string;
        } = { status: evt.status };
        if (progress !== undefined) patch.progress = progress;
        if (evt.status === "failed" || evt.status === "cancelled") {
          patch.completed_at = new Date().toISOString();
          patch.error_code = sanitize(evt.errorCode, 120) ?? "worker_error";
          patch.error_message =
            sanitize(evt.errorMessage, 500) ?? "O processamento falhou. Tente novamente.";
        }
        const { error: updErr } = await supabaseAdmin
          .from("render_jobs")
          .update(patch)
          .eq("id", job.id);
        if (updErr) {
          console.error("[worker-webhook] job update", updErr);
          await supabaseAdmin.from("worker_request_nonces").delete().eq("nonce", nonceKey);
          return new Response("Service unavailable", { status: 503 });
        }

        if (evt.status === "failed" || evt.status === "cancelled") {
          await supabaseAdmin
            .from("projects")
            .update({ status: "failed" })
            .eq("id", job.project_id);
        } else if (evt.status === "processing") {
          await supabaseAdmin
            .from("projects")
            .update({ status: "processing" })
            .eq("id", job.project_id);
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
