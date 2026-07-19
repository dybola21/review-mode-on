/**
 * Pure, unit-testable security helpers for the worker integration.
 * No side-effects, no Node globals beyond `crypto` (Web Crypto is used
 * in the browser but these helpers are server-only).
 */
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

// -----------------------------------------------------------------------
// Public app URL validation
// -----------------------------------------------------------------------
export const publicAppUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .transform((raw) => raw.trim())
  .superRefine((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL is not a valid URL",
      });
      return;
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL must not contain credentials",
      });
    }
    if (url.search) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL must not contain a query string",
      });
    }
    if (url.hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL must not contain a fragment",
      });
    }
    const isProd =
      (process.env.NODE_ENV ?? "development") === "production" ||
      process.env.APP_ENV === "production";
    if (isProd && url.protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL must use HTTPS in production",
      });
    }
    if (!isProd && !["http:", "https:"].includes(url.protocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL must be http(s)",
      });
    }
  });

/** Normalizes and validates PUBLIC_APP_URL. Returns URL without trailing slash. */
export function normalizePublicAppUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = publicAppUrlSchema.safeParse(raw);
  if (!parsed.success) return null;
  const trimmed = parsed.data.replace(/\/+$/, "");
  return trimmed;
}

// -----------------------------------------------------------------------
// Timestamp check (± 5 minutes)
// -----------------------------------------------------------------------
export const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;

export function isTimestampFresh(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!headerValue) return false;
  const ts = Number(headerValue);
  if (!Number.isFinite(ts)) return false;
  const nowSec = nowMs / 1000;
  return Math.abs(nowSec - ts) <= MAX_WEBHOOK_AGE_SECONDS;
}

// -----------------------------------------------------------------------
// HMAC signature
// -----------------------------------------------------------------------
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

export function verifySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  provided: string,
): boolean {
  const expected = computeSignature(secret, timestamp, rawBody);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Storage path helpers
// -----------------------------------------------------------------------
const SAFE_NAME_RE = /[^a-zA-Z0-9._-]+/g;

/** Sanitize a user-provided base name into an alnum/._- token. */
export function sanitizeBaseName(input: string, max = 80): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(SAFE_NAME_RE, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "file").slice(0, max);
}

/** Server-owned output path: userId/projectId/jobId/workerOutputId.ext */
export function buildOutputStoragePath(args: {
  userId: string;
  projectId: string;
  jobId: string;
  workerOutputId: string;
  extension: string;
}): string {
  const ext = args.extension.replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) {
    throw new Error("invalid extension");
  }
  const wid = args.workerOutputId;
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(wid)) {
    throw new Error("invalid workerOutputId");
  }
  return `${args.userId}/${args.projectId}/${args.jobId}/${wid}.${ext}`;
}

/** Enforces "<userId>/<projectId>/<jobId>/..." prefix. */
export function isPathUnderJob(
  path: string,
  userId: string,
  projectId: string,
  jobId: string,
): boolean {
  const prefix = `${userId}/${projectId}/${jobId}/`;
  return (
    typeof path === "string" &&
    path.startsWith(prefix) &&
    !path.includes("..") &&
    !path.includes("//")
  );
}

// -----------------------------------------------------------------------
// Output limits
// -----------------------------------------------------------------------
/**
 * Max outputs a job may declare = sources × variations, hard-capped.
 * Callers use this to reject any worker payload that exceeds the total.
 */
export function computeMaxOutputs(
  sourceCount: number,
  variationCount: number,
  hardCap = 400,
): number {
  const n = Math.max(0, Math.floor(sourceCount)) *
    Math.max(0, Math.floor(variationCount));
  return Math.min(n, hardCap);
}
