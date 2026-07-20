import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { QueueDB } from "../src/queue/db.js";
import { verifyOutputResponseSchema, verifyRemoteOutput } from "../src/webhook/verify.js";
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
      vi.fn(async () =>
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
      vi.fn(async () =>
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
    expect(db.listUploadedOutputs("wjob-1").map((o) => o.worker_output_id).sort()).toEqual([
      "out-1",
      "out-2",
    ]);

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

/**
 * Restart-recovery decision matrix, exercised as a pure function over the
 * verify-then-skip-or-reprocess policy. These simulate what the render
 * loop does when it finds a locally recorded "uploaded" mark after a
 * worker restart, without spinning up FFmpeg.
 */
function recoveryDecision(
  verify: { kind: "ok"; exists: boolean; size: number } | { kind: "auth" },
): "skip" | "reprocess" | "abort" {
  if (verify.kind === "auth") return "abort";
  if (verify.exists && verify.size > 0) return "skip";
  return "reprocess";
}

describe("restart recovery policy", () => {
  it("skips outputs that remote reports exists=true and size>0", () => {
    expect(recoveryDecision({ kind: "ok", exists: true, size: 1 })).toBe("skip");
  });
  it("reprocesses when remote reports exists=false", () => {
    expect(recoveryDecision({ kind: "ok", exists: false, size: 0 })).toBe("reprocess");
  });
  it("reprocesses when remote reports exists=true but size=0", () => {
    expect(recoveryDecision({ kind: "ok", exists: true, size: 0 })).toBe("reprocess");
  });
  it("aborts on auth failure (workerJobId incompatível)", () => {
    expect(recoveryDecision({ kind: "auth" })).toBe("abort");
  });
});
