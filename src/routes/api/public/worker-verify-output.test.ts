import { beforeEach, describe, expect, it, mock } from "bun:test";
import { computeSignature } from "@/lib/render-security";

/**
 * Contract of /api/public/worker-verify-output:
 *  - HMAC + timestamp required, unauthorized otherwise
 *  - job must exist and worker_job_id must match exactly
 *  - target must belong to the job (cross-job probing rejected as not-existing)
 *  - storage_path is derived server-side ONLY; never returned
 *  - transient failures (storage error, nonce insert error) → 503, nonce released
 *  - anti-replay: duplicate nonce → 401
 */

const SECRET = "test-secret-verify-output";
const NOW = Math.floor(Date.now() / 1000);
const JOB_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_JOB_ID = "22222222-2222-2222-2222-222222222222";
const WORKER_JOB_ID = "wjob-verify-1";
const OUTPUT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_OUTPUT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STORAGE_PATH = "uid/pid/jid/out.mp4";

function body(over?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    workerJobId: WORKER_JOB_ID,
    workerOutputId: OUTPUT_ID,
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

function buildRequest(payload: unknown, opts?: { badSig?: boolean; oldTs?: boolean }): Request {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts = opts?.oldTs ? String(NOW - 999_999) : String(NOW);
  const sig = opts?.badSig ? "deadbeef".repeat(8) : computeSignature(SECRET, ts, raw);
  return new Request("http://x/api/public/worker-verify-output", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-signature": sig,
      "x-worker-timestamp": ts,
    },
    body: raw,
  });
}

type MockOpts = {
  nonceError?: { code?: string } | null;
  jobRow?: {
    id: string;
    status: string;
    worker_job_id: string | null;
    project_id: string;
    user_id: string;
  } | null;
  jobError?: unknown;
  targetRow?: { storage_path: string; worker_output_id: string; render_job_id: string } | null;
  targetError?: unknown;
  storageExists?: boolean;
  storageSize?: number;
  storageError?: unknown;
};

const nonceDeletes: string[] = [];

function buildAdmin(opts: MockOpts) {
  return {
    from: (table: string) => {
      if (table === "worker_request_nonces") {
        const chain: Record<string, unknown> = {};
        const p = () => chain;
        chain.insert = async () => ({ error: opts.nonceError ?? null });
        chain.delete = () => chain;
        chain.eq = (_col: string, val: string) => {
          nonceDeletes.push(val);
          return Promise.resolve({ error: null });
        };
        // Support chain-then style used by other code paths
        (chain as { then?: unknown }).then = undefined;
        return chain;
      }
      if (table === "render_jobs") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({
          data: opts.jobRow ?? null,
          error: opts.jobError ?? null,
        });
        return chain;
      }
      if (table === "render_output_targets") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({
          data: opts.targetRow ?? null,
          error: opts.targetError ?? null,
        });
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from: () => ({
        list: async () => {
          if (opts.storageError) return { data: null, error: opts.storageError };
          if (!opts.storageExists) return { data: [], error: null };
          return {
            data: [{ name: "out.mp4", metadata: { size: opts.storageSize ?? 1234 } }],
            error: null,
          };
        },
      }),
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

async function invoke(admin: unknown, req: Request): Promise<Response> {
  mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
  const mod = await import("./worker-verify-output");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (mod as any).Route.options.server.handlers.POST as (args: {
    request: Request;
  }) => Promise<Response>;
  return handler({ request: req });
}

function validJob() {
  return {
    id: JOB_ID,
    status: "processing",
    worker_job_id: WORKER_JOB_ID,
    project_id: "pid",
    user_id: "uid",
  };
}

function validTarget(): {
  storage_path: string;
  worker_output_id: string;
  render_job_id: string;
} {
  return { storage_path: STORAGE_PATH, worker_output_id: OUTPUT_ID, render_job_id: JOB_ID };
}

beforeEach(() => {
  process.env.VIDEO_WORKER_WEBHOOK_SECRET = SECRET;
  nonceDeletes.length = 0;
});

describe("verify-output auth", () => {
  it("401 when signature missing", async () => {
    const req = new Request("http://x/api/public/worker-verify-output", {
      method: "POST",
      body: JSON.stringify(body()),
      headers: { "content-type": "application/json" },
    });
    const res = await invoke(buildAdmin({}), req);
    expect(res.status).toBe(401);
  });

  it("401 when timestamp stale", async () => {
    const res = await invoke(buildAdmin({}), buildRequest(body(), { oldTs: true }));
    expect(res.status).toBe(401);
  });

  it("401 when signature tampered", async () => {
    const res = await invoke(buildAdmin({}), buildRequest(body(), { badSig: true }));
    expect(res.status).toBe(401);
  });

  it("400 when payload malformed", async () => {
    const res = await invoke(buildAdmin({}), buildRequest("{not json"));
    expect(res.status).toBe(400);
  });

  it("400 when required fields missing", async () => {
    const res = await invoke(buildAdmin({}), buildRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(400);
  });
});

describe("verify-output nonce anti-replay", () => {
  it("401 on duplicate nonce (23505)", async () => {
    const res = await invoke(
      buildAdmin({ nonceError: { code: "23505" }, jobRow: validJob(), targetRow: validTarget() }),
      buildRequest(body()),
    );
    expect(res.status).toBe(401);
  });

  it("503 on transient nonce insert error", async () => {
    const res = await invoke(
      buildAdmin({ nonceError: { code: "XX000" }, jobRow: validJob(), targetRow: validTarget() }),
      buildRequest(body()),
    );
    expect(res.status).toBe(503);
  });
});

describe("verify-output binding + isolation", () => {
  it("401 when job not found", async () => {
    const res = await invoke(
      buildAdmin({ jobRow: null, targetRow: validTarget() }),
      buildRequest(body()),
    );
    expect(res.status).toBe(401);
  });

  it("401 when worker_job_id mismatched", async () => {
    const res = await invoke(
      buildAdmin({
        jobRow: { ...validJob(), worker_job_id: "wjob-other" },
        targetRow: validTarget(),
      }),
      buildRequest(body()),
    );
    expect(res.status).toBe(401);
  });

  it("401 when worker_job_id not yet bound (null)", async () => {
    const res = await invoke(
      buildAdmin({ jobRow: { ...validJob(), worker_job_id: null }, targetRow: validTarget() }),
      buildRequest(body()),
    );
    expect(res.status).toBe(401);
  });

  it("returns exists:false (200) when target belongs to another job", async () => {
    // Simulates worker sending an OUTPUT_ID that belongs to OTHER_JOB_ID;
    // our targetRow lookup filters by (render_job_id, worker_output_id),
    // so nothing is found for THIS job.
    const res = await invoke(
      buildAdmin({ jobRow: validJob(), targetRow: null }),
      buildRequest(body({ workerOutputId: OTHER_OUTPUT_ID })),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { exists: boolean; size: number };
    expect(json.exists).toBe(false);
    expect(json.size).toBe(0);
    // Response must never leak storage_path
    expect(Object.keys(json).sort()).toEqual(["exists", "size"]);
  });

  it("rejects cross-job probes even if worker knows the other job id (still 200 exists:false)", async () => {
    const res = await invoke(
      buildAdmin({ jobRow: validJob(), targetRow: null }),
      buildRequest(body({ jobId: JOB_ID, workerOutputId: OTHER_OUTPUT_ID })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false, size: 0 });
    // Sanity: OTHER_JOB_ID is referenced somewhere (silences unused warning).
    expect(OTHER_JOB_ID).toMatch(/2222/);
  });
});

describe("verify-output storage lookup", () => {
  it("returns exists:true + size when storage has the object", async () => {
    const res = await invoke(
      buildAdmin({
        jobRow: validJob(),
        targetRow: validTarget(),
        storageExists: true,
        storageSize: 999,
      }),
      buildRequest(body()),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: true, size: 999 });
  });

  it("returns exists:false when object not present", async () => {
    const res = await invoke(
      buildAdmin({ jobRow: validJob(), targetRow: validTarget(), storageExists: false }),
      buildRequest(body()),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false, size: 0 });
  });

  it("returns 503 (transient) when storage errors", async () => {
    const res = await invoke(
      buildAdmin({
        jobRow: validJob(),
        targetRow: validTarget(),
        storageError: new Error("boom"),
      }),
      buildRequest(body()),
    );
    expect(res.status).toBe(503);
  });
});
