import type { JobPayload } from "../types/contract.js";
import type { Config } from "../config.js";
import { computeHmacHex, buildSignatureMessage, newNonce } from "../security/hmac.js";
import { renewInputResponseSchema, renewUploadResponseSchema } from "../types/contract.js";

/**
 * Renew endpoints live on the same Lovable app under /api/public/. We
 * derive their URLs by swapping the trailing path of APP_WEBHOOK_URL.
 */
function renewUrl(cfg: Config, name: "worker-renew-input" | "worker-renew-upload"): string {
  const u = new URL(cfg.APP_WEBHOOK_URL);
  u.pathname = u.pathname.replace(/worker-webhook$/, name);
  return u.toString();
}

interface RenewCommon {
  jobId: string;
  workerJobId: string;
  nonce: string;
}

async function post<T>(
  url: string,
  body: RenewCommon & Record<string, unknown>,
  cfg: Config,
): Promise<T> {
  const timestamp = new Date().toISOString();
  const raw = JSON.stringify(body);
  const signature = computeHmacHex(cfg.APP_WEBHOOK_SECRET, buildSignatureMessage(timestamp, raw));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-signature": signature,
        "x-worker-timestamp": timestamp,
      },
      body: raw,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`renew_http_${res.status}`);
    const json = (await res.json()) as T;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function renewInputUrl(payload: JobPayload, fileId: string, cfg: Config): Promise<string> {
  const raw = await post<unknown>(
    renewUrl(cfg, "worker-renew-input"),
    {
      jobId: payload.jobId,
      workerJobId: payload.jobId, // not the worker-side id — app matches by jobId
      fileId,
      nonce: newNonce(),
    },
    cfg,
  );
  const parsed = renewInputResponseSchema.parse(raw);
  return parsed.signedUrl;
}

export async function renewUploadUrl(
  payload: JobPayload,
  workerOutputId: string,
  cfg: Config,
): Promise<string> {
  const raw = await post<unknown>(
    renewUrl(cfg, "worker-renew-upload"),
    {
      jobId: payload.jobId,
      workerJobId: payload.jobId,
      workerOutputId,
      nonce: newNonce(),
    },
    cfg,
  );
  const parsed = renewUploadResponseSchema.parse(raw);
  return parsed.signedUploadUrl;
}
