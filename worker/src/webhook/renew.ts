import type { JobPayload } from "../types/contract.js";
import type { Config } from "../config.js";
import { computeHmacHex, buildSignatureMessage, newNonce } from "../security/hmac.js";
import { renewInputResponseSchema, renewUploadResponseSchema } from "../types/contract.js";

/**
 * Renew endpoints are pre-derived from APP_BASE_URL at config load time.
 * All requests carry:
 *   - x-worker-timestamp: epoch seconds (string)
 *   - x-worker-signature: HMAC-SHA256 hex over `${timestamp}.${rawBody}`
 */

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
  const timestamp = String(Math.floor(Date.now() / 1000));
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

export async function renewInputUrl(
  payload: JobPayload,
  workerJobId: string,
  fileId: string,
  cfg: Config,
): Promise<string> {
  const raw = await post<unknown>(
    cfg.APP_RENEW_INPUT_URL,
    {
      jobId: payload.jobId,
      workerJobId,
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
  workerJobId: string,
  workerOutputId: string,
  cfg: Config,
): Promise<string> {
  const raw = await post<unknown>(
    cfg.APP_RENEW_UPLOAD_URL,
    {
      jobId: payload.jobId,
      workerJobId,
      workerOutputId,
      nonce: newNonce(),
    },
    cfg,
  );
  const parsed = renewUploadResponseSchema.parse(raw);
  return parsed.signedUploadUrl;
}
