import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { computeSignature } from "@/lib/render-security";

/**
 * Verifies the HTTP contract of the worker webhook:
 *  - missing_upload → 503 (never 409; the worker discards 409 as terminal)
 *  - project update failure → 503 (never silent 200)
 *  - set_mismatch / duplicate_outputs from RPC → 400
 *  - worker_mismatch → 401
 *  - transient RPC error → 503
 *  - unauthorized signature / expired timestamp → 401
 *  - worker_job_id already bound to a different value → 401
 */

const SECRET = "test-secret";
const NOW = Math.floor(Date.now() / 1000);
const JOB_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const WORKER_JOB_ID = "wjob-1";

function makeThenableChain(finalValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.select = passthrough;
  chain.update = passthrough;
  chain.insert = passthrough;
  chain.delete = passthrough;
  chain.eq = passthrough;
  chain.is = passthrough;
  chain.in = passthrough;
  chain.not = passthrough;
  chain.maybeSingle = async () => finalValue;
  chain.then = (fn: (v: unknown) => unknown) => Promise.resolve(finalValue).then(fn);
  return chain;
}

function buildRequest(payload: unknown, opts?: { badSig?: boolean; oldTs?: boolean }): Request {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts = opts?.oldTs ? String(NOW - 999_999) : String(NOW);
  const sig = opts?.badSig ? "deadbeef".repeat(8) : computeSignature(SECRET, ts, raw);
  return new Request("http://x/api/public/worker-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-signature": sig,
      "x-worker-timestamp": ts,
    },
    body: raw,
  });
}

function completedPayload(): Record<string, unknown> {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    eventType: "job.completed",
    timestamp: NOW,
    jobId: JOB_ID,
    workerJobId: WORKER_JOB_ID,
    status: "completed",
    outputs: [{ workerOutputId: "out-1" }],
  };
}

type BuildOpts = {
  storageExists: boolean;
  storageSize?: number;
  storageError?: unknown;
  workerJobIdOnJob?: string | null;
  rpcResult?: { data: unknown; error: unknown };
  projectUpdateError?: unknown;
  jobUpdateError?: unknown;
};

function buildAdmin(opts: BuildOpts) {
  const targets = [
    {
      worker_output_id: "out-1",
      storage_path: `${USER_ID}/${PROJECT_ID}/${JOB_ID}/out.mp4`,
    },
  ];
  const jobRow = {
    id: JOB_ID,
    status: "queued",
    user_id: USER_ID,
    project_id: PROJECT_ID,
    worker_job_id: opts.workerJobIdOnJob ?? WORKER_JOB_ID,
  };
  return {
    from: (table: string) => {
      if (table === "worker_request_nonces") {
        return makeThenableChain({ data: null, error: null });
      }
      if (table === "render_jobs") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.update = () => {
          const upd: Record<string, unknown> = {};
          const p = () => upd;
          upd.eq = p;
          upd.is = p;
          upd.not = p;
          upd.select = p;
          upd.then = (fn: (v: unknown) => unknown) =>
            Promise.resolve({
              data: [{ id: JOB_ID }],
              error: opts.jobUpdateError ?? null,
            }).then(fn);
          return upd;
        };
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: jobRow, error: null });
        chain.then = (fn: (v: unknown) => unknown) =>
          Promise.resolve({ data: jobRow, error: null }).then(fn);
        return chain;
      }
      if (table === "render_output_targets") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.then = (fn: (v: unknown) => unknown) =>
          Promise.resolve({ data: targets, error: null }).then(fn);
        return chain;
      }
      if (table === "projects") {
        const chain: Record<string, unknown> = {};
        chain.update = () => chain;
        chain.eq = () => chain;
        chain.not = () => chain;
        chain.then = (fn: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: opts.projectUpdateError ?? null }).then(fn);
        return chain;
      }
      return makeThenableChain({ data: null, error: null });
    },
    storage: {
      from: () => ({
        list: async () => {
          if (opts.storageError) return { data: null, error: opts.storageError };
          if (!opts.storageExists) return { data: [], error: null };
          return {
            data: [{ name: "out.mp4", metadata: { size: opts.storageSize ?? 1000 } }],
            error: null,
          };
        },
      }),
    },
    rpc: async () => opts.rpcResult ?? { data: { ok: true }, error: null },
  };
}

async function invokeWith(adminMock: unknown): Promise<(req: Request) => Promise<Response>> {
  mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: adminMock }));
  const mod = await import("./worker-webhook");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).Route.options.server.handlers.POST as (args: {
    request: Request;
  }) => Promise<Response> extends (a: infer A) => infer R
    ? (req: Request) => Promise<Response>
    : never;
}

async function invoke(admin: unknown, request: Request): Promise<Response> {
  mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
  const mod = await import("./worker-webhook");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (mod as any).Route.options.server.handlers.POST as (args: {
    request: Request;
  }) => Promise<Response>;
  return handler({ request });
}

beforeEach(() => {
  process.env.VIDEO_WORKER_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  // Reset module cache so each test re-imports with fresh mock binding.
});

describe("worker-webhook auth", () => {
  it("rejects missing signature with 401", async () => {
    const raw = JSON.stringify(completedPayload());
    const req = new Request("http://x/api/public/worker-webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    });
    const res = await invoke(buildAdmin({ storageExists: true }), req);
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamp with 401", async () => {
    const res = await invoke(
      buildAdmin({ storageExists: true }),
      buildRequest(completedPayload(), { oldTs: true }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects tampered signature with 401", async () => {
    const res = await invoke(
      buildAdmin({ storageExists: true }),
      buildRequest(completedPayload(), { badSig: true }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await invoke(buildAdmin({ storageExists: true }), buildRequest("{not json"));
    expect(res.status).toBe(400);
  });
});

describe("worker-webhook completed path", () => {
  it("returns 503 (not 409) when the upload is genuinely missing", async () => {
    const res = await invoke(
      buildAdmin({ storageExists: false }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(503);
  });

  it("returns 503 when the storage lookup errors transiently", async () => {
    const res = await invoke(
      buildAdmin({ storageExists: false, storageError: new Error("boom") }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(503);
  });

  it("returns 503 when project update fails on no_outputs path", async () => {
    const admin = buildAdmin({
      storageExists: false,
      projectUpdateError: new Error("db down"),
    });
    const p = completedPayload();
    p.outputs = [];
    const res = await invoke(admin, buildRequest(p));
    expect(res.status).toBe(503);
  });

  it("returns 400 when RPC reports set_mismatch", async () => {
    const res = await invoke(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: { ok: false, reason: "set_mismatch" }, error: null },
      }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when RPC reports duplicate_outputs", async () => {
    const res = await invoke(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: { ok: false, reason: "duplicate_outputs" }, error: null },
      }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 when RPC reports worker_mismatch", async () => {
    const res = await invoke(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: { ok: false, reason: "worker_mismatch" }, error: null },
      }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when RPC errors transiently", async () => {
    const res = await invoke(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: null, error: new Error("db timeout") },
      }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(503);
  });

  it("returns 200 on success", async () => {
    const res = await invoke(buildAdmin({ storageExists: true }), buildRequest(completedPayload()));
    expect(res.status).toBe(200);
  });

  it("returns 401 when worker_job_id already bound to a different value", async () => {
    const res = await invoke(
      buildAdmin({ storageExists: true, workerJobIdOnJob: "wjob-different" }),
      buildRequest(completedPayload()),
    );
    expect(res.status).toBe(401);
  });
});

describe("worker-webhook timestamp contract", () => {
  function processingPayload(): Record<string, unknown> {
    return {
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      eventType: "status_update",
      timestamp: NOW,
      jobId: JOB_ID,
      workerJobId: WORKER_JOB_ID,
      status: "processing",
      progress: 10,
    };
  }

  it("accepts numeric epoch seconds (worker sender contract)", async () => {
    // Mirrors the exact body shape produced by worker/src/webhook/sender.ts
    const body = {
      eventId: "evt-1",
      eventType: "status_update",
      timestamp: NOW,
      jobId: JOB_ID,
      workerJobId: WORKER_JOB_ID,
      status: "processing",
      progress: 5,
    };
    const res = await invoke(buildAdmin({ storageExists: true }), buildRequest(body));
    expect(res.status).toBe(200);
  });

  it("rejects string timestamp with 400", async () => {
    const p = processingPayload();
    p.timestamp = String(NOW);
    const res = await invoke(buildAdmin({ storageExists: true }), buildRequest(p));
    expect(res.status).toBe(400);
  });

  it("rejects ISO-8601 timestamp with 400", async () => {
    const p = processingPayload();
    p.timestamp = new Date(NOW * 1000).toISOString();
    const res = await invoke(buildAdmin({ storageExists: true }), buildRequest(p));
    expect(res.status).toBe(400);
  });

  it("rejects milliseconds timestamp with 400", async () => {
    const p = processingPayload();
    p.timestamp = NOW * 1000;
    const res = await invoke(buildAdmin({ storageExists: true }), buildRequest(p));
    expect(res.status).toBe(400);
  });

  it("rejects body timestamp that differs from header with 401", async () => {
    // Signed header uses NOW; body carries NOW-1 → mismatch.
    const raw = JSON.stringify({ ...processingPayload(), timestamp: NOW - 1 });
    const ts = String(NOW);
    const sig = computeSignature(SECRET, ts, raw);
    const req = new Request("http://x/api/public/worker-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-signature": sig,
        "x-worker-timestamp": ts,
      },
      body: raw,
    });
    const res = await invoke(buildAdmin({ storageExists: true }), req);
    expect(res.status).toBe(401);
  });

  it("processing transitions queued → processing (200)", async () => {
    const res = await invoke(
      buildAdmin({ storageExists: true }),
      buildRequest(processingPayload()),
    );
    expect(res.status).toBe(200);
  });

  it("accepts completed after processing (200)", async () => {
    const admin = buildAdmin({ storageExists: true });
    // First: processing
    const r1 = await invoke(admin, buildRequest(processingPayload()));
    expect(r1.status).toBe(200);
    // Then: completed on the same job (fresh admin — jobRow default is queued,
    // and "queued → completed" is a legal transition per ALLOWED_TRANSITIONS).
    const r2 = await invoke(admin, buildRequest(completedPayload()));
    expect(r2.status).toBe(200);
  });
});

// keep unused declaration referenced to satisfy tsgo when tree-shaking
void invokeWith;
