import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { QueueDB } from "../src/queue/db.js";
import { registerJobs } from "../src/api/jobs.js";

const KEY = "x".repeat(32);
const cfg = {
  version: "test",
  isProduction: true,
  PORT: 3000,
  LOG_LEVEL: "silent",
  WORKER_API_KEY: KEY,
  WORKER_PUBLIC_URL: undefined,
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

const payload = {
  jobId: "11111111-1111-1111-1111-111111111111",
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

function makeApp(dir: string) {
  const db = new QueueDB(dir);
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  registerJobs(app, db, cfg, () => true);
  return { app, db };
}

describe("POST /jobs", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-api-"));
  });

  it("rejects missing auth with 401", async () => {
    const { app } = makeApp(dir);
    const res = await app.inject({ method: "POST", url: "/jobs", payload });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects wrong bearer with 401", async () => {
    const { app } = makeApp(dir);
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: {
        authorization: "Bearer wrong",
        "idempotency-key": "idem-key-abc",
        "content-type": "application/json",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects missing Idempotency-Key with 400", async () => {
    const { app } = makeApp(dir);
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects payload with storagePath (unknown field)", async () => {
    const { app } = makeApp(dir);
    const bad = { ...payload, storagePath: "u/p/x" };
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: {
        authorization: `Bearer ${KEY}`,
        "idempotency-key": "idem-key-abc",
        "content-type": "application/json",
      },
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects URLs pointing at non-allowed hosts", async () => {
    const { app } = makeApp(dir);
    const bad = {
      ...payload,
      inputFiles: [{ ...payload.inputFiles[0]!, signedUrl: "https://evil.example.org/src" }],
    };
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: {
        authorization: `Bearer ${KEY}`,
        "idempotency-key": "idem-key-abc",
        "content-type": "application/json",
      },
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 202 and same workerJobId when same Idempotency-Key repeated", async () => {
    const { app } = makeApp(dir);
    const headers = {
      authorization: `Bearer ${KEY}`,
      "idempotency-key": "idem-key-abc",
      "content-type": "application/json",
    };
    const a = await app.inject({ method: "POST", url: "/jobs", headers, payload });
    const b = await app.inject({ method: "POST", url: "/jobs", headers, payload });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(JSON.parse(a.body).workerJobId).toBe(JSON.parse(b.body).workerJobId);
    await app.close();
  });
});
