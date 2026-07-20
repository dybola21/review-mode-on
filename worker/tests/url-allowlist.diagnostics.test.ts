import { describe, it, expect } from "vitest";
import { assertAllowedUrl, UrlAllowlistError } from "../src/security/url-allowlist.js";

const HOSTS = ["files.example.com"];

describe("assertAllowedUrl diagnostics", () => {
  it("attaches the rejected hostname to the error (host_not_allowed)", () => {
    try {
      assertAllowedUrl("https://evil.example.org/x", HOSTS, "download", true);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UrlAllowlistError);
      expect((err as UrlAllowlistError).code).toBe("host_not_allowed_download");
      expect((err as UrlAllowlistError).hostname).toBe("evil.example.org");
    }
  });
  it("attaches hostname for insecure (non-https) production URLs", () => {
    try {
      assertAllowedUrl("http://files.example.com/x", HOSTS, "upload", true);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as UrlAllowlistError).code).toBe("insecure_upload_url");
      expect((err as UrlAllowlistError).hostname).toBe("files.example.com");
    }
  });
  it("hostname is null for malformed URLs (nothing to log)", () => {
    try {
      assertAllowedUrl("not a url", HOSTS, "download", true);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as UrlAllowlistError).code).toBe("invalid_download_url");
      expect((err as UrlAllowlistError).hostname).toBeNull();
    }
  });
  it("accepts a valid host on the allowlist", () => {
    expect(() =>
      assertAllowedUrl("https://files.example.com/x", HOSTS, "download", true),
    ).not.toThrow();
  });
});
