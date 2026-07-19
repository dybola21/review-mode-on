/**
 * Runtime guard: refuse to boot the client bundle with a Supabase key that
 * looks like a service-role / secret key. New-format Supabase keys prefix
 * secret keys with `sb_secret_`, and legacy JWT service-role keys embed the
 * literal string `"role":"service_role"` in the payload. Neither belongs
 * anywhere near the browser.
 *
 * We rely on the fact that any accidental leak would surface via
 * `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY` — the only key the client
 * bundle can read at runtime. Server code uses `process.env.*` variants
 * which are never inlined into the browser bundle.
 */
export function assertBrowserSupabaseKeyIsPublishable(): void {
  const raw = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!raw || typeof raw !== "string") return;
  if (raw.startsWith("sb_secret_")) {
    throw new Error(
      "SECURITY: VITE_SUPABASE_PUBLISHABLE_KEY looks like a secret key (sb_secret_*). Refusing to boot.",
    );
  }
  // Legacy JWT: peek at base64-decoded payload for the service_role claim.
  if (raw.split(".").length === 3) {
    try {
      const payload = raw.split(".")[1];
      const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
      const decoded =
        typeof atob === "function"
          ? atob(b64 + pad)
          : Buffer.from(b64 + pad, "base64").toString("utf8");
      if (/"role"\s*:\s*"service_role"/i.test(decoded)) {
        throw new Error(
          "SECURITY: VITE_SUPABASE_PUBLISHABLE_KEY is a service_role JWT. Refusing to boot.",
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("SECURITY:")) throw e;
      // decoding failed — treat as opaque, do not block.
    }
  }
}
