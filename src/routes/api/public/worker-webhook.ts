import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isTimestampFresh, verifySignature } from "@/lib/render-security";

/** Only workerOutputId + fileSize/checksum/expiresAt are meaningful here.
 *  Server owns storage_path/file_name/mime_type via render_output_targets. */
const outputSchema = z.object({
  workerOutputId: z.string().min(1).max(200),
  fileSize: z.number().int().nonnegative().optional(),
  checksum: z.string().min(1).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
});

const webhookSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(120),
  timestamp: z.number().int().nonnegative().max(9_999_999_999),
  jobId: z.string().uuid(),
  workerJobId: z.string().min(1).max(200),
  status: z.enum(["queued", "processing", "completed", "failed", "cancelled", "expired"]),
  progress: z.number().int().min(0).max(100).optional(),
  errorCode: z.string().max(120).optional(),
  errorMessage: z.string().max(500).optional(),
  outputs: z.array(outputSchema).optional(),
});

/**
 * Only forward moves are legal. Regression (processing → queued,
 * completed → *, etc.) is silently rejected as an invalid transition.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  submitting: ["queued", "processing", "completed", "failed"],
  queued: ["queued", "processing", "completed", "failed", "cancelled"],

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

type AdminLike = {
  from: (t: string) => unknown;
  storage: {
    from: (b: string) => {
      list: (
        path: string,
        opts: { search: string },
      ) => Promise<{
        data: Array<{ name: string; metadata?: { size?: number } | null }> | null;
        error: unknown;
      }>;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

/**
 * Centralized transient-failure helper: releases the webhook nonce so the
 * worker can safely retry with the same eventId, and returns a 503.
 * Use in EVERY transient failure after nonce insert (DB, Storage, targets,
 * RPC, unexpected exceptions).
 */
async function releaseNonceAnd503(
  admin: AdminLike,
  nonceKey: string,
  where: string,
  detail?: unknown,
): Promise<Response> {
  if (detail !== undefined) console.error(`[worker-webhook] ${where}`, detail);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.from("worker_request_nonces") as any).delete().eq("nonce", nonceKey);
  } catch (err) {
    console.error("[worker-webhook] nonce release failed", err);
  }
  return new Response("Service unavailable", { status: 503 });
}

type StorageCheck = { ok: true; exists: boolean; size: number } | { ok: false; transient: true };

async function verifyStorageObject(admin: AdminLike, storagePath: string): Promise<StorageCheck> {
  const parts = storagePath.split("/");
  if (parts.length < 2) return { ok: true, exists: false, size: 0 };
  const parent = parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1]!;
  const { data, error } = await admin.storage.from("render-outputs").list(parent, { search: name });
  // Storage lookup failure is transient — NEVER "missing_upload".
  if (error) return { ok: false, transient: true };
  const found = (data ?? []).find((o) => o.name === name);
  if (!found) return { ok: true, exists: false, size: 0 };
  const size = Number(found.metadata?.size ?? 0);
  return { ok: true, exists: true, size };
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
          console.warn(
            JSON.stringify({
              event: "worker_webhook_invalid_payload",
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join("."),
                code: i.code,
              })),
            }),
          );
          return new Response("Invalid payload", { status: 400 });
        }
        const evt = parsed.data;

        // Body timestamp is informational (created at enqueue) and may differ
        // from the header timestamp (created at dispatch/retry). Freshness is
        // enforced on the header only; the body value is covered by the HMAC.



        let supabaseAdmin: AdminLike;
        try {
          const mod = await import("@/integrations/supabase/client.server");
          supabaseAdmin = mod.supabaseAdmin as unknown as AdminLike;
        } catch (err) {
          console.error("[worker-webhook] admin import", err);
          return new Response("Service unavailable", { status: 503 });
        }

        // Idempotency: record eventId first. Duplicate replay → 200.
        const nonceKey = `webhook:${evt.eventId}`;
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: nErr } = await (supabaseAdmin.from("worker_request_nonces") as any).insert(
            { nonce: nonceKey, purpose: "webhook" },
          );
          if (nErr) {
            const code = (nErr as { code?: string }).code;
            if (code === "23505") {
              return new Response("ok", { status: 200 });
            }
            console.error("[worker-webhook] nonce insert", nErr);
            return new Response("Service unavailable", { status: 503 });
          }
        }

        try {
          // Fetch job
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: job, error: jobErr } = await (supabaseAdmin.from("render_jobs") as any)
            .select("id, status, user_id, project_id, worker_job_id")
            .eq("id", evt.jobId)
            .maybeSingle();
          if (jobErr) {
            return await releaseNonceAnd503(supabaseAdmin, nonceKey, "job lookup", jobErr);
          }
          if (!job) {
            // Unknown job — do NOT leak existence, and free the nonce so
            // a legitimate retry with a fresh eventId isn't blocked.
            await releaseNonceAnd503(supabaseAdmin, nonceKey, "job unknown");
            return new Response("Unauthorized", { status: 401 });
          }

          // Worker binding.
          // - Already bound to a different id → 401.
          // - Not yet bound → conditionally bind here so the first legit
          //   webhook wins the race, then re-read the row to detect races.
          if (job.worker_job_id && job.worker_job_id !== evt.workerJobId) {
            // Nonce stays: this eventId is spoofed and must not be reusable.
            return new Response("Unauthorized", { status: 401 });
          }
          if (!job.worker_job_id) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: bound, error: bindErr } = await (supabaseAdmin.from("render_jobs") as any)
              .update({ worker_job_id: evt.workerJobId })
              .eq("id", job.id)
              .is("worker_job_id", null)
              .select("worker_job_id");
            if (bindErr) {
              return await releaseNonceAnd503(supabaseAdmin, nonceKey, "worker bind", bindErr);
            }
            // Re-check binding — if concurrent bind won and value differs → 401.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: reread, error: rrErr } = await (supabaseAdmin.from("render_jobs") as any)
              .select("worker_job_id, status")
              .eq("id", job.id)
              .maybeSingle();
            if (rrErr || !reread) {
              return await releaseNonceAnd503(
                supabaseAdmin,
                nonceKey,
                "worker rebind lookup",
                rrErr,
              );
            }
            if (reread.worker_job_id !== evt.workerJobId) {
              return new Response("Unauthorized", { status: 401 });
            }
            job.worker_job_id = reread.worker_job_id;
            job.status = reread.status;
            // Bound rows count is informational only.
            void bound;
          }

          // Already terminal? Duplicate → 200.
          if (FINAL_STATUSES.has(job.status)) {
            return new Response("ok", { status: 200 });
          }

          // Transition legality — never regress.
          const allowed = ALLOWED_TRANSITIONS[job.status] ?? [];
          if (!allowed.includes(evt.status)) {
            return new Response("Invalid transition", { status: 409 });
          }

          // ================ COMPLETED ================
          if (evt.status === "completed") {
            if (!evt.outputs || evt.outputs.length === 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { error: fjErr } = await (supabaseAdmin.from("render_jobs") as any)
                .update({
                  status: "failed",
                  error_code: "no_outputs",
                  error_message: "Processamento não retornou arquivos.",
                  completed_at: new Date().toISOString(),
                })
                .eq("id", job.id);
              if (fjErr) {
                return await releaseNonceAnd503(supabaseAdmin, nonceKey, "fail update", fjErr);
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { error: fpErr } = await (supabaseAdmin.from("projects") as any)
                .update({ status: "failed" })
                .eq("id", job.project_id)
                .not("status", "in", "(completed,failed)");
              if (fpErr) {
                return await releaseNonceAnd503(supabaseAdmin, nonceKey, "fail project", fpErr);
              }
              return new Response("ok", { status: 200 });
            }

            // Load expected targets so we can verify Storage BEFORE calling
            // the atomic RPC.
            const { data: targets, error: tErr } =
              await // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (supabaseAdmin.from("render_output_targets") as any)

                .select("worker_output_id, storage_path")
                .eq("render_job_id", job.id);
            if (tErr || !targets) {
              return await releaseNonceAnd503(supabaseAdmin, nonceKey, "targets", tErr);
            }
            const targetPathById = new Map<string, string>(
              (targets as Array<{ worker_output_id: string; storage_path: string }>).map((t) => [
                t.worker_output_id,
                t.storage_path,
              ]),
            );

            // Verify Storage for every reported output. Transient errors or
            // genuinely missing uploads both surface as 503 with the nonce
            // released — the worker keeps 4xx as terminal and drops 409, so
            // we MUST return 5xx to trigger a retry with a re-upload.
            const enriched: Array<{
              worker_output_id: string;
              file_size: number;
              checksum: string | null;
              expires_at: string | null;
            }> = [];
            for (const out of evt.outputs) {
              const targetPath = targetPathById.get(out.workerOutputId);
              if (!targetPath) {
                // Extra id — RPC would also reject; short-circuit with 400.
                return new Response("Output set mismatch", { status: 400 });
              }
              const check = await verifyStorageObject(supabaseAdmin, targetPath);
              if (!check.ok) {
                return await releaseNonceAnd503(supabaseAdmin, nonceKey, "storage check transient");
              }
              if (!check.exists) {
                // Object genuinely absent — release nonce and answer 503
                // (never 409; the worker discards 409 as terminal).
                return await releaseNonceAnd503(supabaseAdmin, nonceKey, "missing_upload");
              }

              if (check.size <= 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { error: emjErr } = await (supabaseAdmin.from("render_jobs") as any)
                  .update({
                    status: "failed",
                    error_code: "empty_upload",
                    error_message: "Resultado vazio.",
                    completed_at: new Date().toISOString(),
                  })
                  .eq("id", job.id);
                if (emjErr) {
                  return await releaseNonceAnd503(supabaseAdmin, nonceKey, "empty job", emjErr);
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { error: empErr } = await (supabaseAdmin.from("projects") as any)
                  .update({ status: "failed" })
                  .eq("id", job.project_id)
                  .not("status", "in", "(completed,failed)");
                if (empErr) {
                  return await releaseNonceAnd503(supabaseAdmin, nonceKey, "empty project", empErr);
                }
                return new Response("ok", { status: 200 });
              }
              enriched.push({
                worker_output_id: out.workerOutputId,
                file_size: check.size,
                checksum: out.checksum ?? null,
                expires_at: out.expiresAt ?? null,
              });
            }

            // Single atomic RPC: locks job, validates exact set, upserts
            // outputs and finalizes job + project — all in one transaction.
            const { data: rpc, error: rpcErr } = await supabaseAdmin.rpc("finalize_render_job", {
              _job_id: job.id,
              _worker_job_id: evt.workerJobId,
              _outputs: enriched,
            });
            if (rpcErr) {
              return await releaseNonceAnd503(supabaseAdmin, nonceKey, "finalize", rpcErr);
            }
            const result = rpc as { ok?: boolean; reason?: string } | null;
            if (!result?.ok) {
              const reason = result?.reason ?? "unknown";
              if (
                reason === "set_mismatch" ||
                reason === "duplicate_outputs" ||
                reason === "invalid_outputs"
              ) {
                return new Response("Output set mismatch", { status: 400 });
              }
              if (reason === "worker_mismatch") {
                return new Response("Unauthorized", { status: 401 });
              }
              // not_found / no_targets / terminal / anything else are
              // treated as transient from the worker's PoV — never 409,
              // since a retry cannot fix them but 5xx tells the worker to
              // stop trying and page the operator.
              return await releaseNonceAnd503(supabaseAdmin, nonceKey, `finalize:${reason}`);
            }
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
          if (evt.status === "processing" && evt.progress !== undefined) {
            patch.progress = Math.min(99, Math.max(1, evt.progress));
          } else if (evt.status === "queued") patch.progress = 0;

          if (evt.status === "failed" || evt.status === "cancelled") {
            patch.completed_at = new Date().toISOString();
            patch.error_code = sanitize(evt.errorCode, 120) ?? "worker_error";
            patch.error_message =
              sanitize(evt.errorMessage, 500) ?? "O processamento falhou. Tente novamente.";
          }

          // Race-safe update: only apply if current status is still the one
          // we validated the transition against. Otherwise, silently accept
          // — we NEVER regress a status.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: updErr, data: updated } = await (supabaseAdmin.from("render_jobs") as any)
            .update(patch)
            .eq("id", job.id)
            .eq("status", job.status)
            .select("id");
          if (updErr) {
            return await releaseNonceAnd503(supabaseAdmin, nonceKey, "job update", updErr);
          }
          // updated may be empty if a concurrent transition won; treat that
          // as OK (idempotent, non-regressing).
          void updated;

          if (evt.status === "failed" || evt.status === "cancelled") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error: pfErr } = await (supabaseAdmin.from("projects") as any)
              .update({ status: "failed" })
              .eq("id", job.project_id)
              .not("status", "in", "(completed,failed)");
            if (pfErr) {
              return await releaseNonceAnd503(supabaseAdmin, nonceKey, "project fail", pfErr);
            }
          } else if (evt.status === "processing") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error: ppErr } = await (supabaseAdmin.from("projects") as any)
              .update({ status: "processing" })
              .eq("id", job.project_id)
              .not("status", "in", "(completed,failed)");
            if (ppErr) {
              return await releaseNonceAnd503(supabaseAdmin, nonceKey, "project processing", ppErr);
            }
          }

          return new Response("ok", { status: 200 });
        } catch (err) {
          // Any unexpected exception after we've taken the nonce is transient.
          return await releaseNonceAnd503(supabaseAdmin, nonceKey, "unexpected", err);
        }
      },
    },
  },
});
