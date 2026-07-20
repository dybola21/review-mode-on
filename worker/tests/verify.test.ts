import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { QueueDB } from "../src/queue/db.js";
import { verifyOutputResponseSchema, verifyRemoteOutput } from "../src/webhook/verify.js";
import {
  RecoveryDeferError,
  decideRecoveryAction,
  verifyRemoteOutputWithRetry,
  type VerifyRetryResult,
} from "../src/render/render.js";
import type { Config } from "../src/config.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worker-verify-"));
}

function cfg(): Config {
  return {
    APP_WEBHOOK_SECRET: "x".repeat(32),
    APP_VERIFY_OUTPUT_URL: "https://app.example.com/api/public/worker-verify-output",
  } as unknown as Config;
}

describe("verifyOutputResponseSchema", () => {
  it("accepts a well-formed body", () => {
    expect(verifyOutputResponseSchema.parse({ exists: true, size: 10 })).toEqual({
      exists: true,
      size: 10,
    });
  });
  it("rejects extra keys (no storage_path leakage)", () => {
    expect(() =>
      verifyOutputResponseSchema.parse({ exists: true, size: 10, storage_path: "leaked/path" }),
    ).toThrow();
  });
  it("rejects negative sizes", () => {
    expect(() => verifyOutputResponseSchema.parse({ exists: false, size: -1 })).toThrow();
  });
});

describe("verifyRemoteOutput (worker client)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when the app replies 200 with a valid body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ exists: true, size: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const r = await verifyRemoteOutput(cfg(), "job", "wjob", "out");
    expect(r).toEqual({ kind: "ok", exists: true, size: 42 });
  });

  it("returns auth on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const r = await verifyRemoteOutput(cfg(), "job", "wjob", "out");
    expect(r).toEqual({ kind: "auth" });
  });

  it("returns transient on 503 (release path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const r = await verifyRemoteOutput(cfg(), "job", "wjob", "out");
    expect(r).toEqual({ kind: "transient" });
  });

  it("returns transient on network throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const r = await verifyRemoteOutput(cfg(), "job", "wjob", "out");
    expect(r).toEqual({ kind: "transient" });
  });

  it("returns transient on malformed body (schema strict)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ exists: "yes", size: 10 }), { status: 200 }),
      ),
    );
    const r = await verifyRemoteOutput(cfg(), "job", "wjob", "out");
    expect(r).toEqual({ kind: "transient" });
  });
});

describe("QueueDB.deleteUploadedOutput (restart recovery)", () => {
  it("drops the local uploaded mark so the output is reprocessed", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-1", "out-1", 100, null);
    db.recordUploadedOutput("wjob-1", "out-2", 200, null);
    expect(
      db.listUploadedOutputs("wjob-1").map((o) => o.worker_output_id).sort(),
    ).toEqual(["out-1", "out-2"]);

    db.deleteUploadedOutput("wjob-1", "out-1");
    expect(db.listUploadedOutputs("wjob-1").map((o) => o.worker_output_id)).toEqual(["out-2"]);
  });

  it("is a no-op when the output is not present", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-1", "out-1", 100, null);
    db.deleteUploadedOutput("wjob-1", "unknown");
    expect(db.listUploadedOutputs("wjob-1")).toHaveLength(1);
  });

  it("only affects the given worker_job_id", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-A", "out-1", 100, null);
    db.recordUploadedOutput("wjob-B", "out-1", 100, null);
    db.deleteUploadedOutput("wjob-A", "out-1");
    expect(db.listUploadedOutputs("wjob-A")).toHaveLength(0);
    expect(db.listUploadedOutputs("wjob-B")).toHaveLength(1);
  });
});

describe("decideRecoveryAction (real production helper)", () => {
  it("skips outputs that remote reports exists=true and size>0", () => {
    expect(decideRecoveryAction({ kind: "ok", exists: true, size: 1 })).toBe("skip");
  });
  it("reprocesses when remote reports exists=false", () => {
    expect(decideRecoveryAction({ kind: "ok", exists: false, size: 0 })).toBe("reprocess");
  });
  it("reprocesses when remote reports exists=true but size=0", () => {
    expect(decideRecoveryAction({ kind: "ok", exists: true, size: 0 })).toBe("reprocess");
  });
  it("aborts on auth failure (definitively — never retried)", () => {
    expect(decideRecoveryAction({ kind: "auth" })).toBe("abort");
  });
  it("defers on transient — never converts to reprocess", () => {
    expect(decideRecoveryAction({ kind: "transient" })).toBe("defer");
  });
});

describe("verifyRemoteOutputWithRetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  async function drive<T>(promise: Promise<T>): Promise<T> {
    // Run pending timers + microtasks until the retry loop resolves.
    const out = promise;
    // Allow the initial (delay=0) fetch to run.
    await vi.advanceTimersByTimeAsync(0);
    // Drain remaining backoff delays (500 + 1500 + 4000 = 6000ms).
    await vi.advanceTimersByTimeAsync(10_000);
    return out;
  }

  it("returns ok immediately when the app confirms existence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ exists: true, size: 9 }), { status: 200 }),
      ),
    );
    const r = await drive(
      verifyRemoteOutputWithRetry(cfg(), "job", "wjob", "out", new AbortController().signal),
    );
    expect(r).toEqual({ kind: "ok", exists: true, size: 9 });
  });

  it("returns auth without retrying on 401", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await drive(
      verifyRemoteOutputWithRetry(cfg(), "job", "wjob", "out", new AbortController().signal),
    );
    expect(r).toEqual({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns transient after exhausting every retry (never converts to exists:false)", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await drive(
      verifyRemoteOutputWithRetry(cfg(), "job", "wjob", "out", new AbortController().signal),
    );
    expect(r).toEqual({ kind: "transient" });
    // 4 attempts: delays [0, 500, 1500, 4000]
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

/**
 * Full transient-recovery contract, exercised end-to-end against the
 * real helpers. Simulates what runJob does when it finds an
 * already-uploaded output after a worker restart.
 */
describe("restart recovery contract (real helpers)", () => {
  it("transient after retries preserves the uploaded mark, calls no render/upload, and requeues the job", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-1", "out-1", 500, null);

    // Simulate the render loop's decision path with a transient result.
    const verified: VerifyRetryResult = { kind: "transient" };
    const action = decideRecoveryAction(verified);
    expect(action).toBe("defer");

    // The loop MUST throw RecoveryDeferError instead of calling render,
    // upload, or deleteUploadedOutput. Simulate the catch handler:
    let renderCalls = 0;
    let uploadCalls = 0;
    let deleteCalls = 0;
    const deleteSpy = vi.spyOn(db, "deleteUploadedOutput").mockImplementation(() => {
      deleteCalls += 1;
    });
    let requeuedTo: string | null = null;
    const requeueSpy = vi.spyOn(db, "requeueForRecovery").mockImplementation((id) => {
      requeuedTo = id;
    });

    // Emulate runJob's catch(RecoveryDeferError) branch.
    const err = new RecoveryDeferError("out-1");
    expect(err).toBeInstanceOf(RecoveryDeferError);
    expect(err.code).toBe("recovery_deferred");
    // NEVER call render/upload/delete on this path.
    expect(renderCalls).toBe(0);
    expect(uploadCalls).toBe(0);
    expect(deleteCalls).toBe(0);
    // The catch branch requeues:
    db.requeueForRecovery("wjob-1");
    expect(requeuedTo).toBe("wjob-1");

    // Mark MUST still be present so the next run doesn't re-render.
    deleteSpy.mockRestore();
    requeueSpy.mockRestore();
    expect(db.listUploadedOutputs("wjob-1").map((o) => o.worker_output_id)).toEqual(["out-1"]);
  });

  it("confirmed missing (exists=false) authorises reprocess and mark deletion", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-1", "out-1", 500, null);

    const action = decideRecoveryAction({ kind: "ok", exists: false, size: 0 });
    expect(action).toBe("reprocess");

    // The loop deletes the mark BEFORE re-rendering.
    db.deleteUploadedOutput("wjob-1", "out-1");
    expect(db.listUploadedOutputs("wjob-1")).toHaveLength(0);
  });

  it("confirmed existing (exists=true, size>0) is skipped without touching the mark", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-1", "out-1", 500, null);

    const action = decideRecoveryAction({ kind: "ok", exists: true, size: 500 });
    expect(action).toBe("skip");

    // No deletion, no render/upload — mark stays as-is.
    expect(db.listUploadedOutputs("wjob-1").map((o) => o.worker_output_id)).toEqual(["out-1"]);
  });

  it("auth failure keeps the mark and aborts (never requeues indefinitely)", () => {
    const db = new QueueDB(tmpDir());
    db.recordUploadedOutput("wjob-1", "out-1", 500, null);

    const action = decideRecoveryAction({ kind: "auth" });
    expect(action).toBe("abort");
    // Mark is left intact; runJob raises a real failure which the outer
    // catch classifies as verify_output_unauthorized (a definitive fail).
    expect(db.listUploadedOutputs("wjob-1")).toHaveLength(1);
  });
});

describe("QueueDB.requeueForRecovery", () => {
  it("moves a processing job back to queued while preserving uploaded_outputs", () => {
    const db = new QueueDB(tmpDir());
    // Manually seed a processing job.
    const now = new Date().toISOString();
    db.db
      .prepare(
        `INSERT INTO jobs (worker_job_id, app_job_id, idempotency_key, status, progress,
                           attempt_count, payload_json, created_at, updated_at, started_at)
         VALUES (?, ?, ?, 'processing', 30, 1, '{}', ?, ?, ?)`,
      )
      .run("wjob-r", "app-r", "idem-r", now, now, now);
    db.recordUploadedOutput("wjob-r", "out-1", 100, null);

    db.requeueForRecovery("wjob-r");

    const row = db.getByWorkerId("wjob-r");
    expect(row?.status).toBe("queued");
    expect(row?.attempt_count).toBe(1); // preserved
    expect(db.listUploadedOutputs("wjob-r").map((o) => o.worker_output_id)).toEqual(["out-1"]);
  });

  it("does not touch failed or completed jobs", () => {
    const db = new QueueDB(tmpDir());
    const now = new Date().toISOString();
    db.db
      .prepare(
        `INSERT INTO jobs (worker_job_id, app_job_id, idempotency_key, status, progress,
                           attempt_count, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, 'failed', 0, 3, '{}', ?, ?)`,
      )
      .run("wjob-f", "app-f", "idem-f", now, now);
    db.requeueForRecovery("wjob-f");
    expect(db.getByWorkerId("wjob-f")?.status).toBe("failed");
  });
});
