import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment schema
// ---------------------------------------------------------------------------

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : v === "true" || v === "1"));

const int = (min: number, max: number, def?: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v == null || v === "") {
        if (def == null) {
          ctx.addIssue({ code: "custom", message: "required" });
          return z.NEVER;
        }
        return def;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be integer in [${min}, ${max}]` });
        return z.NEVER;
      }
      return n;
    });

const hostList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const secret = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`);

/**
 * Normalise APP_BASE_URL. Rules:
 *  - Must be a valid URL.
 *  - HTTPS only in production. http://localhost or http://127.0.0.1 allowed
 *    outside production.
 *  - localhost/127.0.0.1 rejected in production.
 *  - No userinfo (credentials).
 *  - No query string.
 *  - No fragment.
 *  - Trailing slash stripped; only the origin is kept (path is discarded so
 *    endpoint URLs are built deterministically).
 */
export function normaliseAppBaseUrl(raw: string, isProduction: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("APP_BASE_URL must be a valid URL");
  }
  const isLocalhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:") {
    if (!(u.protocol === "http:" && !isProduction && isLocalhost)) {
      throw new Error(
        "APP_BASE_URL must be https:// (http://localhost allowed only outside production)",
      );
    }
  }
  if (isProduction && isLocalhost) {
    throw new Error("APP_BASE_URL cannot be localhost in production");
  }
  if (u.username || u.password) {
    throw new Error("APP_BASE_URL must not contain credentials");
  }
  if (u.search) {
    throw new Error("APP_BASE_URL must not contain a query string");
  }
  if (u.hash) {
    throw new Error("APP_BASE_URL must not contain a fragment");
  }
  return u.origin; // no trailing slash, no path
}

export const APP_WEBHOOK_PATH = "/api/public/worker-webhook";
export const APP_RENEW_INPUT_PATH = "/api/public/worker-renew-input";
export const APP_RENEW_UPLOAD_PATH = "/api/public/worker-renew-upload";
export const APP_VERIFY_OUTPUT_PATH = "/api/public/worker-verify-output";

export function buildAppUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("app path must start with '/'");
  }
  return `${baseUrl}${path}`;
}

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("production"),
  PORT: int(1, 65535, 3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional()
    .default("info"),

  WORKER_API_KEY: secret("WORKER_API_KEY"),
  WORKER_PUBLIC_URL: z.string().url().optional(),

  APP_BASE_URL: z.string().optional(),
  APP_WEBHOOK_SECRET: secret("APP_WEBHOOK_SECRET"),

  DATA_DIR: z.string().min(1).default("/data"),
  TEMP_DIR: z.string().min(1).default("/tmp/editor-worker"),

  MAX_CONCURRENCY: int(1, 8, 1),
  MAX_INPUT_BYTES: int(1024, 5_000_000_000, 500 * 1024 * 1024),
  MAX_OUTPUT_BYTES: int(1024, 5_000_000_000, 500 * 1024 * 1024),
  MAX_JOB_DURATION_SECONDS: int(30, 6 * 60 * 60, 1800),
  FFMPEG_TIMEOUT_SECONDS: int(10, 6 * 60 * 60, 900),

  ALLOWED_DOWNLOAD_HOSTS: hostList,
  ALLOWED_UPLOAD_HOSTS: hostList,

  DISABLE_SHUTDOWN_HOOKS: bool(false),
});

export type Config = Readonly<z.infer<typeof envSchema>> & {
  readonly version: string;
  readonly isProduction: boolean;
  readonly APP_BASE_URL: string;
  readonly APP_WEBHOOK_URL: string;
  readonly APP_RENEW_INPUT_URL: string;
  readonly APP_RENEW_UPLOAD_URL: string;
  readonly APP_VERIFY_OUTPUT_URL: string;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const flat = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    // Do NOT print raw env values.
    throw new Error(`Invalid worker configuration: ${flat}`);
  }
  const data = parsed.data;
  if (data.ALLOWED_DOWNLOAD_HOSTS.length === 0 || data.ALLOWED_UPLOAD_HOSTS.length === 0) {
    throw new Error(
      "ALLOWED_DOWNLOAD_HOSTS and ALLOWED_UPLOAD_HOSTS must list at least one hostname.",
    );
  }
  const isProduction = (data.NODE_ENV ?? "production") === "production";

  // Reject legacy APP_WEBHOOK_URL to prevent conflicting configuration.
  if (env.APP_WEBHOOK_URL != null && env.APP_WEBHOOK_URL !== "") {
    throw new Error(
      "APP_WEBHOOK_URL is no longer supported. Set APP_BASE_URL (e.g. https://app.example.com) instead.",
    );
  }

  if (!data.APP_BASE_URL || data.APP_BASE_URL === "") {
    throw new Error("APP_BASE_URL is required");
  }
  const baseUrl = normaliseAppBaseUrl(data.APP_BASE_URL, isProduction);

  cached = Object.freeze({
    ...data,
    APP_BASE_URL: baseUrl,
    APP_WEBHOOK_URL: buildAppUrl(baseUrl, APP_WEBHOOK_PATH),
    APP_RENEW_INPUT_URL: buildAppUrl(baseUrl, APP_RENEW_INPUT_PATH),
    APP_RENEW_UPLOAD_URL: buildAppUrl(baseUrl, APP_RENEW_UPLOAD_PATH),
    APP_VERIFY_OUTPUT_URL: buildAppUrl(baseUrl, APP_VERIFY_OUTPUT_PATH),
    version: process.env.WORKER_VERSION ?? "0.1.0",
    isProduction,
  }) as Config;

  return cached;
}

export function getConfig(): Config {
  if (!cached) return loadConfig();
  return cached;
}

/** Testing only — reset the memoised config so subsequent loads re-read env. */
export function _resetConfigForTests(): void {
  cached = null;
}
