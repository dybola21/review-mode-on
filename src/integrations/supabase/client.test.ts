import { describe, it, expect, beforeEach, vi } from "vitest";

describe("createSupabaseClient key guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects a sb_secret_* value used as the publishable key", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_secret_leak");
    const mod = await import("./client");
    expect(() =>
      // Force the proxy to instantiate the client.
      (mod.supabase as unknown as { from: (t: string) => unknown }).from("projects"),
    ).toThrow(/SECURITY/);
  });

  it("rejects a service_role legacy JWT used as the publishable key", async () => {
    const b64 = (s: string) =>
      Buffer.from(s, "utf8")
        .toString("base64")
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const jwt = `${b64('{"alg":"HS256"}')}.${b64('{"role":"service_role"}')}.sig`;

    vi.stubEnv("VITE_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", jwt);
    const mod = await import("./client");
    expect(() =>
      (mod.supabase as unknown as { from: (t: string) => unknown }).from("projects"),
    ).toThrow(/service_role/);
  });

  it("accepts a publishable-style opaque key", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_ok");
    const mod = await import("./client");
    expect(() =>
      (mod.supabase as unknown as { from: (t: string) => unknown }).from("projects"),
    ).not.toThrow();
  });
});
