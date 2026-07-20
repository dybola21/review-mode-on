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
export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
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
 * Raw product of sources × variations, WITHOUT a clamp.
 * Callers MUST reject `> HARD_MAX_OUTPUTS` before creating a job, targets
 * or signed URLs. 400 is permitted; 401+ must be rejected up-front so we
 * never persist a job that will inevitably fail on the exact-set check.
 */
export function computeMaxOutputs(sourceCount: number, variationCount: number): number {
  const s = Math.max(0, Math.floor(sourceCount));
  const v = Math.max(0, Math.floor(variationCount));
  return s * v;
}

// -----------------------------------------------------------------------
// Render input validation (server-side, pre-signing)
// -----------------------------------------------------------------------
export type RenderFileType = "source_video" | "logo" | "template_asset";

const BUCKET_BY_TYPE: Record<RenderFileType, string> = {
  source_video: "project-inputs",
  logo: "project-assets",
  template_asset: "project-assets",
};

/** Server-canonical bucket for a given file_type. Returns null if unknown. */
export function bucketForFileType(fileType: string): string | null {
  if (fileType === "source_video" || fileType === "logo" || fileType === "template_asset") {
    return BUCKET_BY_TYPE[fileType];
  }
  return null;
}

/**
 * MIME compatibility per file_type:
 *  - source_video: must start with video/
 *  - logo: must start with image/
 *  - template_asset: image/ or video/ (asset overlays)
 */
export function mimeAllowedForFileType(fileType: string, mimeType: string | null | undefined): boolean {
  if (!mimeType || typeof mimeType !== "string") return false;
  const m = mimeType.toLowerCase();
  if (fileType === "source_video") return m.startsWith("video/");
  if (fileType === "logo") return m.startsWith("image/");
  if (fileType === "template_asset") return m.startsWith("image/") || m.startsWith("video/");
  return false;
}

/**
 * Server invariant for input storage_path:
 *  - must be a non-empty string
 *  - must start EXACTLY with `${userId}/${projectId}/`
 *  - must NOT contain `..`, `//`, or backslash
 */
export function isValidInputStoragePath(path: string, userId: string, projectId: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("..") || path.includes("//") || path.includes("\\")) return false;
  const prefix = `${userId}/${projectId}/`;
  return path.startsWith(prefix) && path.length > prefix.length;
}

export type RenderInputCandidate = {
  id: string;
  user_id?: string | null;
  project_id?: string | null;
  status?: string | null;
  file_type: string;
  mime_type: string | null;
  storage_path: string;
};

export type RenderInputRejection =
  | "not_uploaded"
  | "wrong_owner"
  | "wrong_project"
  | "invalid_type"
  | "invalid_path"
  | "invalid_mime";

/**
 * Validates a project_files row before we sign its input URL. Returns null
 * on success or a stable rejection code. Callers translate that into a
 * safe client error and refuse to proceed with the render.
 */
export function validateRenderInput(
  file: RenderInputCandidate,
  userId: string,
  projectId: string,
): RenderInputRejection | null {
  if (file.status !== "uploaded") return "not_uploaded";
  if (file.user_id && file.user_id !== userId) return "wrong_owner";
  if (file.project_id && file.project_id !== projectId) return "wrong_project";
  if (!bucketForFileType(file.file_type)) return "invalid_type";
  if (!isValidInputStoragePath(file.storage_path, userId, projectId)) return "invalid_path";
  if (!mimeAllowedForFileType(file.file_type, file.mime_type)) return "invalid_mime";
  return null;
}

