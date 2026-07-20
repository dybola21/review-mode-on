import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSignature } from "@/lib/render-security";

/**
 * Verifies the HTTP contract of the worker webhook:
 *  - missing_upload → 503 (never 409; the worker discards 409 as terminal)
 *  - project update failure → 503 (never silent 200)
 *  - unknown outputs / duplicates / set mismatch surfaces from the RPC → 400
 *  - transient RPC error → 503
 *  - unauthorized signature / expired timestamp → 401
 */

const SECRET = "test-secret";
const NOW = Math.floor(Date.now() / 1000);
const JOB_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const WORKER_JOB_ID = "wjob-1";

type FromResult = {
  select?: () => FromResult;
  update?: (patch: unknown) => FromResult;
  insert?: (v: unknown) => FromResult;
  delete?: () => FromResult;
  eq?: (k: string, v: unknown) => FromResult;
  is?: (k: string, v: unknown) => FromResult;
  in?: (k: string, v: unknown) => FromResult;
  not?: (k: string, op: string, v: unknown) => FromResult;
  maybeSingle?: () => Promise<{ data: unknown; error: unknown }>;
  then?: (fn: (v: unknown) => unknown) => Promise<unknown>;
};

type AdminMock = {
  from: ReturnType<typeof vi.fn>;
  storage: { from: ReturnType<typeof vi.fn> };
  rpc: ReturnType<typeof vi.fn>;
};

function makeSuccessfulChain(returnValue: { data: unknown; error: unknown }): FromResult {
  const chain: FromResult = {};
  chain.select = () => chain;
  chain.update = () => chain;
  chain.insert = () => chain;
  chain.delete = () => chain;
  chain.eq = () => chain;
  chain.is = () => chain;
  chain.in = () => chain;
  chain.not = () => chain;
  chain.maybeSingle = async () => returnValue;
  chain.then = (fn) => Promise.resolve(returnValue).then(fn);
  return chain;
}

function buildRequest(payload: unknown, opts?: { badSig?: boolean; oldTs?: boolean }): Request {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts = opts?.oldTs ? String(NOW - 999_999) : String(NOW);
  const sig = opts?.badSig
    ? "deadbeef".repeat(8)
    : computeSignature(SECRET, ts, raw);
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
    timestamp: String(NOW),
    jobId: JOB_ID,
    workerJobId: WORKER_JOB_ID,
    status: "completed",
    outputs: [{ workerOutputId: "out-1" }],
  };
}

async function invoke(request: Request): Promise<Response> {
  const mod = await import("./worker-webhook");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (mod as any).Route.options.server.handlers.POST as (args: {
    request: Request;
  }) => Promise<Response>;
  return handler({ request });
}

beforeEach(() => {
  process.env.VIDEO_WORKER_WEBHOOK_SECRET = SECRET;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker-webhook auth", () => {
  it("rejects missing signature with 401", async () => {
    const raw = JSON.stringify(completedPayload());
    const req = new Request("http://x/api/public/worker-webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    });
    const res = await invoke(req);
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamp with 401", async () => {
    const res = await invoke(buildRequest(completedPayload(), { oldTs: true }));
    expect(res.status).toBe(401);
  });

  it("rejects tampered signature with 401", async () => {
    const res = await invoke(buildRequest(completedPayload(), { badSig: true }));
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with 400", async () => {
    const req = buildRequest("{not json");
    const res = await invoke(req);
    expect(res.status).toBe(400);
  });
});

/**
 * Small admin-mock builder for the "completed" path. Each variant plugs a
 * different behavior at the point we want to observe.
 */
function buildAdmin(opts: {
  storageExists: boolean;
  storageSize?: number;
  storageError?: unknown;
  workerJobIdOnJob?: string | null;
  rpcResult?: { data: unknown; error: unknown };
  projectUpdateError?: unknown;
  jobUpdateError?: unknown;
  bindReread?: string | null; // what re-read returns after bind attempt
}): AdminMock {
  const targets = [{ worker_output_id: "out-1", storage_path: `${USER_ID}/${PROJECT_ID}/${JOB_ID}/out.mp4` }];
  const jobRow = {
    id: JOB_ID,
    status: "queued",
    user_id: USER_ID,
    project_id: PROJECT_ID,
    worker_job_id: opts.workerJobIdOnJob ?? WORKER_JOB_ID,
  };
  const admin: AdminMock = {
    from: vi.fn((table: string) => {
      if (table === "worker_request_nonces") {
        return makeSuccessfulChain({ data: null, error: null });
      }
      if (table === "render_jobs") {
        const chain: FromResult = {};
        chain.select = () => chain;
        chain.update = () => {
          const upd: FromResult = {};
          upd.eq = () => upd;
          upd.is = () => upd;
          upd.not = () => upd;
          upd.select = () => upd;
          upd.then = (fn) =>
            Promise.resolve({
              data: opts.bindReread ? [{ worker_job_id: opts.bindReread }] : [{ id: JOB_ID }],
              error: opts.jobUpdateError ?? null,
            }).then(fn);
          return upd;
        };
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: jobRow, error: null });
        chain.then = (fn) => Promise.resolve({ data: jobRow, error: null }).then(fn);
        return chain;
      }
      if (table === "render_output_targets") {
        const chain: FromResult = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.then = (fn) => Promise.resolve({ data: targets, error: null }).then(fn);
        return chain;
      }
      if (table === "projects") {
        const chain: FromResult = {};
        chain.update = () => chain;
        chain.eq = () => chain;
        chain.not = () => chain;
        chain.then = (fn) =>
          Promise.resolve({ data: null, error: opts.projectUpdateError ?? null }).then(fn);
        return chain;
      }
      return makeSuccessfulChain({ data: null, error: null });
    }),
    storage: {
      from: vi.fn(() => ({
        list: async () => {
          if (opts.storageError) return { data: null, error: opts.storageError };
          if (!opts.storageExists) return { data: [], error: null };
          return {
            data: [{ name: "out.mp4", metadata: { size: opts.storageSize ?? 1000 } }],
            error: null,
          };
        },
      })),
    },
    rpc: vi.fn(async () =>
      opts.rpcResult ?? { data: { ok: true }, error: null },
    ),
  };
  return admin;
}

function mockAdmin(admin: AdminMock) {
  vi.doMock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
}

describe("worker-webhook completed path", () => {
  it("returns 503 (not 409) when the upload is genuinely missing", async () => {
    mockAdmin(buildAdmin({ storageExists: false }));
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(503);
  });

  it("returns 503 when the storage lookup errors transiently", async () => {
    mockAdmin(buildAdmin({ storageExists: false, storageError: new Error("boom") }));
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(503);
  });

  it("returns 503 when project update fails on no_outputs path", async () => {
    mockAdmin(
      buildAdmin({
        storageExists: false, // unused — no outputs
        projectUpdateError: new Error("db down"),
      }),
    );
    const p = completedPayload();
    p.outputs = [];
    const res = await invoke(buildRequest(p));
    expect(res.status).toBe(503);
  });

  it("returns 400 when RPC reports set_mismatch", async () => {
    mockAdmin(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: { ok: false, reason: "set_mismatch" }, error: null },
      }),
    );
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(400);
  });

  it("returns 400 when RPC reports duplicate_outputs", async () => {
    mockAdmin(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: { ok: false, reason: "duplicate_outputs" }, error: null },
      }),
    );
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(400);
  });

  it("returns 401 when RPC reports worker_mismatch", async () => {
    mockAdmin(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: { ok: false, reason: "worker_mismatch" }, error: null },
      }),
    );
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(401);
  });

  it("returns 503 when RPC errors transiently", async () => {
    mockAdmin(
      buildAdmin({
        storageExists: true,
        rpcResult: { data: null, error: new Error("db timeout") },
      }),
    );
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(503);
  });

  it("returns 200 on success", async () => {
    mockAdmin(buildAdmin({ storageExists: true }));
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(200);
  });

  it("returns 401 when worker_job_id already bound to a different value", async () => {
    mockAdmin(buildAdmin({ storageExists: true, workerJobIdOnJob: "wjob-different" }));
    const res = await invoke(buildRequest(completedPayload()));
    expect(res.status).toBe(401);
  });
});
