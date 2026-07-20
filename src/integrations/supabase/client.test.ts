/**
 * Verify the browser-visible Supabase client refuses a leaked secret key.
 * We check two things:
 *  1. The generated client actually calls assertSupabaseKeyIsPublishable
 *     on the effectively-selected key (source-level invariant, so refactors
 *     can't silently drop the guard).
 *  2. When the module is instantiated with a sb_secret_* / service_role
 *     JWT in the env, first use of the client throws with SECURITY.
 *
 * We only exercise the runtime path once per module instance because the
 * client uses a lazy Proxy singleton and bun's test runner does not expose
 * a module-cache reset. The invariant test covers the other rejection
 * shapes; assertSupabaseKeyIsPublishable itself is unit-tested in
 * ./../../lib/supabase-key-guard.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  path.resolve(process.cwd(), "src/integrations/supabase/client.ts"),
  "utf8",
);

describe("createSupabaseClient integrates the key guard", () => {
  it("imports and calls assertSupabaseKeyIsPublishable on the selected key", () => {
    expect(SRC).toContain(
      'import { assertSupabaseKeyIsPublishable } from "@/lib/supabase-key-guard"',
    );
    expect(SRC).toMatch(/assertSupabaseKeyIsPublishable\(SUPABASE_PUBLISHABLE_KEY/);
  });

  it("guard runs after the env is selected (including SSR fallback)", () => {
    const selectIdx = SRC.indexOf("|| process.env.SUPABASE_PUBLISHABLE_KEY");
    const guardIdx = SRC.indexOf("assertSupabaseKeyIsPublishable(SUPABASE_PUBLISHABLE_KEY");
    expect(selectIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(selectIdx);
  });

  it("throws at first use when the publishable env holds a sb_secret_* value", async () => {
    const prev = {
      url: process.env.VITE_SUPABASE_URL,
      key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      urlSSR: process.env.SUPABASE_URL,
      keySSR: process.env.SUPABASE_PUBLISHABLE_KEY,
    };
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "sb_secret_leak";
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_secret_leak";
    try {
      const mod = await import(`./client?leak=${Date.now()}`);
      expect(() =>
        (mod.supabase as unknown as { from: (t: string) => unknown }).from("projects"),
      ).toThrow(/SECURITY/);
    } finally {
      process.env.VITE_SUPABASE_URL = prev.url;
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY = prev.key;
      process.env.SUPABASE_URL = prev.urlSSR;
      process.env.SUPABASE_PUBLISHABLE_KEY = prev.keySSR;
    }
  });
});
