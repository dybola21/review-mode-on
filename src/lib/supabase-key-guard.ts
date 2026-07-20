/**
 * Runtime guard: refuse to accept a Supabase key that looks like a
 * service-role / secret key on any client-side path.
 *
 * New-format Supabase keys prefix secret keys with `sb_secret_`, and legacy
 * JWT service-role keys embed the literal string `"role":"service_role"` in
 * the payload. Neither belongs anywhere near the browser.
 */

export type KeyGuardResult = { ok: true } | { ok: false; reason: "sb_secret" | "service_role_jwt" };

function decodeJwtPayload(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    if (typeof atob === "function") return atob(b64 + pad);
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Inspect a raw key string. Pure — safe to unit-test.
 */
export function inspectSupabaseKey(raw: unknown): KeyGuardResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: true };
  if (raw.startsWith("sb_secret_")) return { ok: false, reason: "sb_secret" };
  const payload = decodeJwtPayload(raw);
  if (payload && /"role"\s*:\s*"service_role"/i.test(payload)) {
    return { ok: false, reason: "service_role_jwt" };
  }
  return { ok: true };
}

/**
 * Assert that a specific key value is safe for browser use. Throws with a
 * SECURITY-prefixed message when the key is a secret / service-role key.
 */
export function assertSupabaseKeyIsPublishable(raw: unknown, source = "supabase key"): void {
  const result = inspectSupabaseKey(raw);
  if (result.ok) return;
  if (result.reason === "sb_secret") {
    throw new Error(`SECURITY: ${source} looks like a secret key (sb_secret_*). Refusing to boot.`);
  }
  throw new Error(`SECURITY: ${source} is a service_role JWT. Refusing to boot.`);
}

/**
 * Boot-time guard for the browser bundle. Reads the only client-visible
 * Supabase key (VITE_SUPABASE_PUBLISHABLE_KEY) and refuses to continue when
 * it looks like a secret. Called from src/routes/__root.tsx.
 */
export function assertBrowserSupabaseKeyIsPublishable(): void {
  const raw = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  assertSupabaseKeyIsPublishable(raw, "VITE_SUPABASE_PUBLISHABLE_KEY");
}
