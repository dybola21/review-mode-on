import { describe, it, expect } from "vitest";
import { isUploadExpired, validateStorageObject } from "./project-files-validation";

describe("validateStorageObject", () => {
  const base = { expectedSize: 1024, expectedMime: "video/mp4" };

  it("rejects when object is absent", () => {
    expect(validateStorageObject({ ...base, found: false, meta: null })).toBe("not_found");
  });

  it("rejects when object is empty", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 0, mimetype: "video/mp4" } }),
    ).toBe("empty");
  });

  it("rejects size mismatch", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 999, mimetype: "video/mp4" } }),
    ).toBe("size_mismatch");
  });

  it("rejects mime mismatch", () => {
    expect(
      validateStorageObject({
        ...base,
        found: true,
        meta: { size: 1024, mimetype: "application/pdf" },
      }),
    ).toBe("mime_mismatch");
  });

  it("accepts a matching object", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 1024, mimetype: "video/mp4" } }),
    ).toBeNull();
  });

  it("accepts when storage does not report a mime type", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 1024, mimetype: "" } }),
    ).toBeNull();
  });
});

describe("isUploadExpired", () => {
  const now = new Date("2026-07-20T12:00:00Z").getTime();

  it("returns false when no expiry", () => {
    expect(isUploadExpired(null, now)).toBe(false);
    expect(isUploadExpired(undefined, now)).toBe(false);
  });

  it("returns true when expiry is in the past", () => {
    expect(isUploadExpired("2026-07-20T11:00:00Z", now)).toBe(true);
  });

  it("returns false when expiry is in the future", () => {
    expect(isUploadExpired("2026-07-20T12:15:00Z", now)).toBe(false);
  });
});
