import { z } from "zod";
import type { Config } from "../config.js";
import { computeHmacHex, buildSignatureMessage, newNonce } from "../security/hmac.js";

export const verifyOutputResponseSchema = z
  .object({
    exists: z.boolean(),
    size: z.number().int().nonnegative(),
  })
  .strict();

export type VerifyOutputResult =
  { kind: "ok"; exists: boolean; size: number } | { kind: "transient" } | { kind: "auth" };

/**
 * Ask the app whether a workerOutputId that we recorded locally as
 * "uploaded" is actually present in Storage. Used after restart to
 * avoid re-rendering outputs that succeeded, and to detect false
 * positives that must be reprocessed.
 *
 * NEVER surfaces storage paths — server owns that.
 */
export async function verifyRemoteOutput(
  cfg: Config,
  jobId: string,
  workerJobId: string,
  workerOutputId: string,
): Promise<VerifyOutputResult> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = { jobId, workerJobId, workerOutputId, nonce: newNonce() };
  const raw = JSON.stringify(body);
  const signature = computeHmacHex(cfg.APP_WEBHOOK_SECRET, buildSignatureMessage(timestamp, raw));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(cfg.APP_VERIFY_OUTPUT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-signature": signature,
        "x-worker-timestamp": timestamp,
      },
      body: raw,
      signal: controller.signal,
    });
    if (res.status === 401) return { kind: "auth" };
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      return { kind: "transient" };
    }
    if (!res.ok) return { kind: "transient" };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { kind: "transient" };
    }
    const parsed = verifyOutputResponseSchema.safeParse(json);
    if (!parsed.success) return { kind: "transient" };
    return { kind: "ok", exists: parsed.data.exists, size: parsed.data.size };
  } catch {
    return { kind: "transient" };
  } finally {
    clearTimeout(timer);
  }
}
