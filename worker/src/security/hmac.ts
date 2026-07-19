import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

/** Build canonical HMAC message: `${timestamp}.${rawBody}`. */
export function buildSignatureMessage(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function computeHmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** Constant-time compare of two hex strings. Returns false on length mismatch. */
export function verifyHmacHex(secret: string, message: string, provided: string): boolean {
  const expected = computeHmacHex(secret, message);
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time compare of two ASCII/UTF-8 strings of equal length. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** ±5 minute freshness on ISO-8601 or epoch seconds/millis. */
export function isTimestampFresh(timestamp: string, nowMs: number = Date.now()): boolean {
  if (!timestamp || typeof timestamp !== "string") return false;
  let t: number;
  if (/^\d+$/.test(timestamp)) {
    const n = Number(timestamp);
    t = n < 1e12 ? n * 1000 : n; // seconds vs millis
  } else {
    t = Date.parse(timestamp);
  }
  if (!Number.isFinite(t)) return false;
  return Math.abs(nowMs - t) <= 5 * 60 * 1000;
}

export function newNonce(): string {
  return randomUUID();
}
