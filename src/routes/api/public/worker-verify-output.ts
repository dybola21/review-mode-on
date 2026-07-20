import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isTimestampFresh, verifySignature } from "@/lib/render-security";

const bodySchema = z.object({
  jobId: z.string().uuid(),
  workerJobId: z.string().min(1).max(200),
  workerOutputId: z.string().min(1).max(200),
  nonce: z.string().min(8).max(200),
});

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
};

async function releaseNonceAnd503(
  admin: AdminLike,
  nonceKey: string,
  where: string,
  detail?: unknown,
): Promise<Response> {
  if (detail !== undefined) console.error(`[verify-output] ${where}`, detail);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.from("worker_request_nonces") as any).delete().eq("nonce", nonceKey);
  } catch (err) {
    console.error("[verify-output] nonce release failed", err);
  }
  return new Response("Service unavailable", { status: 503 });
}

/**
 * Worker-only endpoint. Lets the worker verify whether an output it
 * previously recorded as "uploaded" in its local SQLite is actually
 * present in Storage. Used after a worker restart to avoid re-rendering
 * outputs that succeeded before the crash — and to detect false-positive
 * marks that must be reprocessed.
 *
 * Contract:
 *  - HMAC + timestamp + nonce (same envelope as webhook / renew).
 *  - Server derives storage_path ONLY from render_output_targets, never
 *    trusts a path from the worker and NEVER returns storage_path.
 *  - Transient errors: nonce released, HTTP 503.
 *  - Successful reply: `{ exists: boolean, size: number }` only.
 */
export const Route = createFileRoute("/api/public/worker-verify-output")({
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

        let supabaseAdmin: AdminLike;
        try {
          supabaseAdmin = (
            (await import("@/integrations/supabase/client.server")) as unknown as {
              supabaseAdmin: AdminLike;
            }
          ).supabaseAdmin;
        } catch (err) {
          console.error("[verify-output] admin import", err);
          return new Response("Service unavailable", { status: 503 });
        }

        // Anti-replay nonce (fail-closed on transient DB errors).
        const nonceKey = `verify-output:${nonce}`;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: nErr } = (await (supabaseAdmin.from("worker_request_nonces") as any)
            .insert({ nonce: nonceKey, purpose: "verify_output" })) as { error: unknown };
          if (nErr) {
            const code = (nErr as { code?: string }).code;
            if (code === "23505") {
              return new Response("Replay", { status: 401 });
            }
            console.error("[verify-output] nonce", nErr);
            return new Response("Service unavailable", { status: 503 });
          }
        } catch (err) {
          console.error("[verify-output] nonce insert threw", err);
          return new Response("Service unavailable", { status: 503 });
        }

        // Validate job + worker binding.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const jobQ = (supabaseAdmin.from("render_jobs") as any)
          .select("id, status, worker_job_id, project_id, user_id")
          .eq("id", jobId)
          .maybeSingle();
        const { data: job, error: jobErr } = (await jobQ) as {
          data: {
            id: string;
            status: string;
            worker_job_id: string | null;
            project_id: string;
            user_id: string;
          } | null;
          error: unknown;
        };
        if (jobErr) {
          return await releaseNonceAnd503(supabaseAdmin, nonceKey, "job", jobErr);
        }
        // No job at all → auth failure (don't leak existence).
        if (!job) {
          return new Response("Unauthorized", { status: 401 });
        }
        // If worker_job_id is bound, it must match exactly. If NULL,
        // reject: verification is only meaningful once the job is bound.
        if (!job.worker_job_id || job.worker_job_id !== workerJobId) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Target must belong to THIS job. That's the only way we accept a
        // workerOutputId. This blocks cross-job probing.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tQ = (supabaseAdmin.from("render_output_targets") as any)
          .select("storage_path, worker_output_id, render_job_id")
          .eq("render_job_id", jobId)
          .eq("worker_output_id", workerOutputId)
          .maybeSingle();
        const { data: target, error: tErr } = (await tQ) as {
          data: { storage_path: string; worker_output_id: string; render_job_id: string } | null;
          error: unknown;
        };
        if (tErr) {
          return await releaseNonceAnd503(supabaseAdmin, nonceKey, "target", tErr);
        }
        if (!target) {
          // Unknown output for this job — behave like "does not exist"
          // (200 with exists=false) so the worker treats it as missing
          // and reprocesses, but never leaks whether it exists elsewhere.
          return jsonResponse({ exists: false, size: 0 });
        }

        // Derive storage path ONLY from the DB.
        const parts = target.storage_path.split("/");
        if (parts.length < 2) {
          return jsonResponse({ exists: false, size: 0 });
        }
        const parent = parts.slice(0, -1).join("/");
        const name = parts[parts.length - 1]!;
        const { data, error: sErr } = await supabaseAdmin.storage
          .from("render-outputs")
          .list(parent, { search: name });
        if (sErr) {
          // Storage lookup failure is transient — release nonce.
          return await releaseNonceAnd503(supabaseAdmin, nonceKey, "storage", sErr);
        }
        const found = (data ?? []).find((o) => o.name === name);
        if (!found) return jsonResponse({ exists: false, size: 0 });
        const size = Number(found.metadata?.size ?? 0);
        return jsonResponse({ exists: true, size: Number.isFinite(size) ? size : 0 });
      },
    },
  },
});

function jsonResponse(body: { exists: boolean; size: number }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
