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

const httpsUrl = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .url(`${name} must be a valid URL`)
    .refine((u) => {
      try {
        const p = new URL(u);
        // Allow http only for localhost/development.
        if (p.protocol === "https:") return true;
        if (
          p.protocol === "http:" &&
          (p.hostname === "localhost" || p.hostname === "127.0.0.1")
        ) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }, `${name} must be https://`);

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("production"),
  PORT: int(1, 65535, 3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional()
    .default("info"),

  WORKER_API_KEY: secret("WORKER_API_KEY"),
  WORKER_PUBLIC_URL: z.string().url().optional(),

  APP_WEBHOOK_URL: httpsUrl("APP_WEBHOOK_URL"),
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
  cached = Object.freeze({
    ...data,
    version: process.env.WORKER_VERSION ?? "0.1.0",
    isProduction: (data.NODE_ENV ?? "production") === "production",
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
