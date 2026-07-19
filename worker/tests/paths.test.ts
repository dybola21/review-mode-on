import { describe, it, expect } from "vitest";
import { assertAllowedUrl, UrlAllowlistError } from "../src/security/url-allowlist.js";
import { safeBaseName, ensureInsideDir } from "../src/storage/paths.js";

describe("url allowlist", () => {
  const hosts = ["files.example.com", "storage.supabase.co"];

  it("accepts https url on allowed host", () => {
    const u = assertAllowedUrl("https://files.example.com/x?y=1", hosts, "download", true);
    expect(u.hostname).toBe("files.example.com");
  });

  it("accepts a subdomain of an allowed host", () => {
    expect(() => assertAllowedUrl("https://a.storage.supabase.co/", hosts, "upload", true)).not.toThrow();
  });

  it("rejects unknown host", () => {
    expect(() => assertAllowedUrl("https://evil.example.org/", hosts, "download", true)).toThrow(
      UrlAllowlistError,
    );
  });

  it("rejects http in production", () => {
    expect(() => assertAllowedUrl("http://files.example.com/x", hosts, "download", true)).toThrow(
      UrlAllowlistError,
    );
  });

  it("allows localhost http in dev", () => {
    expect(() => assertAllowedUrl("http://localhost/x", ["localhost"], "download", false)).not.toThrow();
  });

  it("rejects malformed url", () => {
    expect(() => assertAllowedUrl("not a url", hosts, "download", true)).toThrow(UrlAllowlistError);
  });
});

describe("safe path helpers", () => {
  it("safeBaseName removes path separators and shell metacharacters", () => {
    expect(safeBaseName("../../etc/passwd")).toBe("__.._etc_passwd");
    expect(safeBaseName("nice file (v2).mp4")).toBe("nice_file_v2_.mp4");
    expect(safeBaseName("")).toBe("file");
    expect(safeBaseName("....")).toBe("_");
  });

  it("ensureInsideDir rejects escapes", () => {
    expect(() => ensureInsideDir("/tmp/work", "../out.mp4")).toThrow();
    expect(() => ensureInsideDir("/tmp/work", "/etc/passwd")).toThrow();
    expect(ensureInsideDir("/tmp/work", "child/out.mp4")).toBe("/tmp/work/child/out.mp4");
  });
});
