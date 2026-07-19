import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { QueueDB } from "../src/queue/db.js";
import type { JobPayload } from "../src/types/contract.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worker-queue-"));
}

function samplePayload(id = "11111111-1111-1111-1111-111111111111"): JobPayload {
  return {
    jobId: id,
    projectId: "22222222-2222-2222-2222-222222222222",
    callbackUrl: "https://app.example.com/api/public/worker-webhook",
    inputFiles: [
      {
        fileId: "33333333-3333-3333-3333-333333333333",
        fileName: "src.mp4",
        fileType: "source_video",
        mimeType: "video/mp4",
        signedUrl: "https://files.example.com/src",
      },
    ],
    outputTargets: [
      {
        workerOutputId: "44444444-4444-4444-4444-444444444444",
        fileName: "src_v1.mp4",
        mimeType: "video/mp4",
        signedUploadUrl: "https://files.example.com/out",
      },
    ],
    templateSettings: {},
    variationSettings: {},
    variationCount: 1,
    uploadTtlSeconds: 3600,
  };
}

describe("queue db", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });

  it("is idempotent on app_job_id and idempotency-key", () => {
    const db = new QueueDB(dir);
    const p = samplePayload();
    const a = db.enqueue(p, "idem-1");
    const b = db.enqueue(p, "idem-1");
    const c = db.enqueue(p, "idem-2"); // same app_job_id
    expect(a.worker_job_id).toBe(b.worker_job_id);
    expect(a.worker_job_id).toBe(c.worker_job_id);
    db.close();
  });

  it("distinct jobs get distinct workerJobIds", () => {
    const db = new QueueDB(dir);
    const a = db.enqueue(samplePayload("11111111-1111-1111-1111-111111111111"), "k1");
    const b = db.enqueue(samplePayload("55555555-5555-5555-5555-555555555555"), "k2");
    expect(a.worker_job_id).not.toBe(b.worker_job_id);
    db.close();
  });

  it("claims queued jobs FIFO and marks processing", () => {
    const db = new QueueDB(dir);
    db.enqueue(samplePayload("11111111-1111-1111-1111-111111111111"), "k1");
    const claimed = db.claimNextQueued();
    expect(claimed?.status).toBe("processing");
    const again = db.claimNextQueued();
    expect(again).toBeUndefined();
    db.close();
  });

  it("recoverInProgress moves processing rows back to queued after restart", () => {
    const db = new QueueDB(dir);
    db.enqueue(samplePayload("11111111-1111-1111-1111-111111111111"), "k1");
    db.claimNextQueued(); // now processing
    db.close();

    const db2 = new QueueDB(dir);
    const moved = db2.recoverInProgress();
    expect(moved).toBe(1);
    const next = db2.claimNextQueued();
    expect(next?.status).toBe("processing");
    db2.close();
  });

  it("webhooks enqueue and dedupe by eventId", () => {
    const db = new QueueDB(dir);
    db.enqueueWebhook("w1", "ev1", "status_update", "{}");
    db.enqueueWebhook("w1", "ev1", "status_update", "{}"); // duplicate ignored
    const pending = db.pendingWebhooks(10, new Date(Date.now() + 60_000).toISOString());
    expect(pending.length).toBe(1);
    db.close();
  });
});
