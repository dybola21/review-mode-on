import { describe, it, expect } from "vitest";
import { assertBrowserSupabaseKeyIsPublishable } from "./supabase-key-guard";

/**
 * We can't reassign import.meta.env in a portable way, so we test the guard
 * by using vi.stubEnv from the browser vitest env. When VITE_… is absent
 * this must be a no-op.
 */
describe("supabase-key-guard", () => {
  it("does not throw when the publishable key is absent", () => {
    expect(() => assertBrowserSupabaseKeyIsPublishable()).not.toThrow();
  });
});
