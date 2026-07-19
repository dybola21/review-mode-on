import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

const outputSchema = z.object({
  workerOutputId: z.string().min(1).max(200).optional(),
  fileName: z.string().min(1).max(255),
  storagePath: z.string().min(1).max(500).optional(),
  fileSize: z.number().int().nonnegative().optional(),
  mimeType: z.string().min(1).max(120).optional(),
  checksum: z.string().min(1).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
});

const webhookSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(120),
  timestamp: z.string().min(1).max(60),
  jobId: z.string().uuid(),
  workerJobId: z.string().min(1).max(200),
  status: z.enum([
    "queued",
    "processing",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ]),
  progress: z.number().int().min(0).max(100).optional(),
  errorCode: z.string().max(120).optional(),
  errorMessage: z.string().max(500).optional(),
  outputs: z.array(outputSchema).optional(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  submitting: ["queued", "failed"],
  queued: ["processing", "failed", "cancelled"],
  processing: ["processing", "completed", "failed", "cancelled"],
  completed: ["expired"],
  failed: [],
  cancelled: [],
  expired: [],
};

function sanitize(str: string | undefined, max = 500): string | null {
  if (!str) return null;
  return str.replace(/[\r\n\t]+/g, " ").slice(0, max);
}

async function verifyStoragePath(
  admin: {
    storage: {
      from: (b: string) => {
        list: (
          path: string,
          opts: { search: string },
        ) => Promise<{ data: Array<{ name: string }> | null; error: unknown }>;
      };
    };
  },
  storagePath: string,
): Promise<boolean> {
  const parts = storagePath.split("/");
  if (parts.length < 2) return false;
  const parent = parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1];
  const { data } = await admin.storage
    .from("render-outputs")
    .list(parent, { search: name });
  return (data ?? []).some((o) => o.name === name);
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

        const tsNum = Number(timestamp);
        if (!Number.isFinite(tsNum)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const ageSeconds = Math.abs(Date.now() / 1000 - tsNum);
        if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
          return new Response("Unauthorized", { status: 401 });
        }

        const rawBody = await request.text();
        const expected = createHmac("sha256", secret)
          .update(`${timestamp}.${rawBody}`)
          .digest("hex");

        const sigBuf = Buffer.from(signature, "utf8");
        const expBuf = Buffer.from(expected, "utf8");
        if (
          sigBuf.length !== expBuf.length ||
          !timingSafeEqual(sigBuf, expBuf)
        ) {
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

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        // Busca job pelo jobId + workerJobId
        const { data: job, error: jobErr } = await supabaseAdmin
          .from("render_jobs")
          .select("id, status, user_id, project_id, worker_job_id")
          .eq("id", evt.jobId)
          .maybeSingle();
        if (jobErr || !job) {
          return new Response("ok", { status: 200 }); // não vazar existência
        }
        if (job.worker_job_id && job.worker_job_id !== evt.workerJobId) {
          return new Response("ok", { status: 200 });
        }

        // Idempotência simples: se já no status final, ignora
        if (
          ["completed", "failed", "cancelled", "expired"].includes(job.status)
        ) {
          return new Response("ok", { status: 200 });
        }

        // Transição válida?
        const allowed = ALLOWED_TRANSITIONS[job.status] ?? [];
        if (!allowed.includes(evt.status)) {
          console.warn("[worker-webhook] invalid transition", {
            from: job.status,
            to: evt.status,
          });
          return new Response("ok", { status: 200 });
        }

        // Progresso
        let progress: number | undefined;
        if (evt.status === "completed") progress = 100;
        else if (evt.status === "processing" && evt.progress !== undefined) {
          progress = Math.min(99, Math.max(1, evt.progress));
        } else if (evt.status === "queued") progress = 0;

        // Outputs somente em completed
        if (evt.status === "completed") {
          if (!evt.outputs || evt.outputs.length === 0) {
            await supabaseAdmin
              .from("render_jobs")
              .update({
                status: "failed",
                error_code: "no_outputs",
                error_message: "Processamento não retornou arquivos.",
                completed_at: new Date().toISOString(),
              })
              .eq("id", job.id);
            await supabaseAdmin
              .from("projects")
              .update({ status: "failed" })
              .eq("id", job.project_id);
            return new Response("ok", { status: 200 });
          }

          const insertedIds: string[] = [];
          let failedOutput = false;
          for (const out of evt.outputs) {
            const expectedPrefix = `${job.user_id}/${job.project_id}/${job.id}/`;
            const storagePath = out.storagePath;
            if (!storagePath || !storagePath.startsWith(expectedPrefix)) {
              failedOutput = true;
              break;
            }
            const exists = await verifyStoragePath(supabaseAdmin, storagePath);
            if (!exists) {
              failedOutput = true;
              break;
            }
            // Idempotente: on conflict do nothing
            const { data: existing } = out.workerOutputId
              ? await supabaseAdmin
                  .from("render_outputs")
                  .select("id")
                  .eq("render_job_id", job.id)
                  .eq("worker_output_id", out.workerOutputId)
                  .maybeSingle()
              : { data: null as { id: string } | null };
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
                worker_output_id: out.workerOutputId ?? null,
                file_name: out.fileName,
                storage_path: storagePath,
                file_size: out.fileSize ?? null,
                mime_type: out.mimeType ?? "video/mp4",
                checksum: out.checksum ?? null,
                expires_at: out.expiresAt ?? null,
              })
              .select("id")
              .single();
            if (insErr || !inserted) {
              failedOutput = true;
              break;
            }
            insertedIds.push(inserted.id);
          }

          if (failedOutput) {
            // Rollback outputs parciais desse job
            if (insertedIds.length > 0) {
              await supabaseAdmin
                .from("render_outputs")
                .delete()
                .in("id", insertedIds);
            }
            await supabaseAdmin
              .from("render_jobs")
              .update({
                status: "failed",
                error_code: "partial_outputs",
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

          await supabaseAdmin
            .from("render_jobs")
            .update({
              status: "completed",
              progress: 100,
              completed_at: new Date().toISOString(),
            })
            .eq("id", job.id);
          await supabaseAdmin
            .from("projects")
            .update({ status: "completed" })
            .eq("id", job.project_id);
          return new Response("ok", { status: 200 });
        }

        // Demais transições
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
            sanitize(evt.errorMessage, 500) ??
            "O processamento falhou. Tente novamente.";
        }
        await supabaseAdmin.from("render_jobs").update(patch).eq("id", job.id);

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
