import { describe, it, expect } from "vitest";
import {
  assertBrowserSupabaseKeyIsPublishable,
  assertSupabaseKeyIsPublishable,
  inspectSupabaseKey,
} from "./supabase-key-guard";

// Build a fake JWT with a given payload.
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe("supabase-key-guard", () => {
  it("no-ops when the browser key is absent", () => {
    expect(() => assertBrowserSupabaseKeyIsPublishable()).not.toThrow();
  });

  it("accepts a publishable-style opaque key", () => {
    expect(inspectSupabaseKey("sb_publishable_abcdef")).toEqual({ ok: true });
    expect(() => assertSupabaseKeyIsPublishable("sb_publishable_abcdef")).not.toThrow();
  });

  it("accepts a legacy anon JWT", () => {
    const jwt = makeJwt({ role: "anon", iss: "supabase" });
    expect(inspectSupabaseKey(jwt)).toEqual({ ok: true });
    expect(() => assertSupabaseKeyIsPublishable(jwt)).not.toThrow();
  });

  it("rejects sb_secret_* keys", () => {
    const res = inspectSupabaseKey("sb_secret_leak");
    expect(res).toEqual({ ok: false, reason: "sb_secret" });
    expect(() => assertSupabaseKeyIsPublishable("sb_secret_leak")).toThrow(/SECURITY/);
  });

  it("rejects service_role legacy JWTs", () => {
    const jwt = makeJwt({ role: "service_role", iss: "supabase" });
    const res = inspectSupabaseKey(jwt);
    expect(res).toEqual({ ok: false, reason: "service_role_jwt" });
    expect(() => assertSupabaseKeyIsPublishable(jwt)).toThrow(/service_role/);
  });

  it("ignores non-string values", () => {
    expect(inspectSupabaseKey(undefined)).toEqual({ ok: true });
    expect(inspectSupabaseKey(null)).toEqual({ ok: true });
    expect(inspectSupabaseKey(123 as unknown)).toEqual({ ok: true });
  });
});
