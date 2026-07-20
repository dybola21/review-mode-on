import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { QueueDB } from "../src/queue/db.js";
import { registerJobs } from "../src/api/jobs.js";
import { CONTRACT_VERSION } from "../src/types/contract.js";

const KEY = "x".repeat(32);
const cfg = {
  version: "test",
  isProduction: true,
  WORKER_API_KEY: KEY,
  APP_BASE_URL: "https://app.example.com",
  APP_WEBHOOK_URL: "https://app.example.com/api/public/worker-webhook",
  APP_RENEW_INPUT_URL: "https://app.example.com/api/public/worker-renew-input",
  APP_RENEW_UPLOAD_URL: "https://app.example.com/api/public/worker-renew-upload",
  APP_WEBHOOK_SECRET: "y".repeat(32),
  DATA_DIR: "/tmp",
  TEMP_DIR: "/tmp/editor-worker",
  MAX_CONCURRENCY: 1,
  MAX_INPUT_BYTES: 1024,
  MAX_OUTPUT_BYTES: 1024,
  MAX_JOB_DURATION_SECONDS: 60,
  FFMPEG_TIMEOUT_SECONDS: 60,
  ALLOWED_DOWNLOAD_HOSTS: ["files.example.com"],
  ALLOWED_UPLOAD_HOSTS: ["files.example.com"],
  DISABLE_SHUTDOWN_HOOKS: true,
  NODE_ENV: "production",
} as unknown as Parameters<typeof registerJobs>[2];

const HEADER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function payloadFor(jobId: string) {
  return {
    contractVersion: CONTRACT_VERSION,
    jobId,
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
      {
        fileId: HEADER_ID,
        fileName: "header.png",
        fileType: "template_asset",
        mimeType: "image/png",
        signedUrl: "https://files.example.com/header",
      },
    ],
    outputTargets: [
      {
        workerOutputId: "44444444-4444-4444-4444-444444444444",
        fileName: "src.mp4",
        mimeType: "video/mp4",
        signedUploadUrl: "https://files.example.com/out",
        sourceFileId: "33333333-3333-3333-3333-333333333333",
      },
    ],
    templateSettings: {
      header_image_file_id: HEADER_ID,
      page_name: "",
      identifier: "",
      headline: "",
      logo_file_id: null,
      background_color: "#0F0F12",
      text_color: "#FFFFFF",
      accent_color: "#FF5A1F",
      watermark_position: "bottom-right",
      watermark_opacity: 0.6,
      header_height_ratio: 0.335,
    },
    uploadTtlSeconds: 3600,
  };
}

function makeApp(dir: string) {
  const db = new QueueDB(dir);
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  registerJobs(app, db, cfg, () => true);
  return { app, db };
}

const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

describe("POST /internal/job-status", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
  });

  it("rejects invalid bearer with 401", async () => {
    const { app } = makeApp(dir);
    const res = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      payload: { jobId: "j", workerJobId: "w" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects invalid body with 400", async () => {
    const { app } = makeApp(dir);
    const res = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when identifiers do not match same row", async () => {
    const { app, db } = makeApp(dir);
    const row = db.enqueue(
      payloadFor("11111111-1111-1111-1111-111111111111") as never,
      "idem-1234567",
    );
    const res = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: "99999999-9999-9999-9999-999999999999", workerJobId: row.worker_job_id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("queued job returns status=queued, stage=queued, position=1", async () => {
    const { app, db } = makeApp(dir);
    const row = db.enqueue(
      payloadFor("11111111-1111-1111-1111-111111111111") as never,
      "idem-1234567",
    );
    const res = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: row.app_job_id, workerJobId: row.worker_job_id },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("queued");
    expect(body.stage).toBe("queued");
    expect(body.queuePosition).toBe(1);
    expect(body.attemptCount).toBe(0);
    expect(body.progress).toBe(0);
    expect(body.running).toBe(false);
    // Ensure no leakage
    expect(body).not.toHaveProperty("payload_json");
    expect(body).not.toHaveProperty("payload");
    await app.close();
  });

  it("claim advances stage to claimed and clears queuePosition", async () => {
    const { app, db } = makeApp(dir);
    const row = db.enqueue(
      payloadFor("11111111-1111-1111-1111-111111111111") as never,
      "idem-1234567",
    );
    db.claimNextQueued();
    const res = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: row.app_job_id, workerJobId: row.worker_job_id },
    });
    const body = JSON.parse(res.body);
    expect(body.status).toBe("processing");
    expect(body.stage).toBe("claimed");
    expect(body.queuePosition).toBe(null);
    expect(body.attemptCount).toBe(1);
    expect(body.heartbeatAt).toBeTruthy();
    await app.close();
  });

  it("second queued job reports queuePosition=2", async () => {
    const { app, db } = makeApp(dir);
    const a = db.enqueue(
      payloadFor("11111111-1111-1111-1111-111111111111") as never,
      "idem-aaaaaaa",
    );
    // small delay so created_at ordering is deterministic
    const b = db.enqueue(
      payloadFor("22222222-2222-2222-2222-222222222223") as never,
      "idem-bbbbbbb",
    );
    void a;
    const res = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: b.app_job_id, workerJobId: b.worker_job_id },
    });
    const body = JSON.parse(res.body);
    expect(body.queuePosition).toBe(2);
    await app.close();
  });

  it("heartbeat + setStage move stage and heartbeatAt forward", async () => {
    const { app, db } = makeApp(dir);
    const row = db.enqueue(
      payloadFor("11111111-1111-1111-1111-111111111111") as never,
      "idem-1234567",
    );
    db.claimNextQueued();
    const first = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: row.app_job_id, workerJobId: row.worker_job_id },
    });
    const firstBody = JSON.parse(first.body);
    // wait a tick then bump stage + heartbeat
    await new Promise((r) => setTimeout(r, 10));
    db.setStage(row.worker_job_id, "rendering");
    db.heartbeat(row.worker_job_id);
    const second = await app.inject({
      method: "POST",
      url: "/internal/job-status",
      headers: AUTH,
      payload: { jobId: row.app_job_id, workerJobId: row.worker_job_id },
    });
    const secondBody = JSON.parse(second.body);
    expect(secondBody.stage).toBe("rendering");
    expect(Date.parse(secondBody.heartbeatAt)).toBeGreaterThanOrEqual(
      Date.parse(firstBody.heartbeatAt),
    );
    await app.close();
  });
});
