import { describe, it, expect } from "vitest";
import {
  isUploadExpired,
  isValidStoragePath,
  validateStorageObject,
} from "./project-files-validation";

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

  it("rejects missing mime type (empty string)", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 1024, mimetype: "" } }),
    ).toBe("mime_missing");
  });

  it("rejects missing mime type (whitespace)", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 1024, mimetype: "   " } }),
    ).toBe("mime_missing");
  });

  it("rejects missing mime type (undefined)", () => {
    expect(validateStorageObject({ ...base, found: true, meta: { size: 1024 } })).toBe(
      "mime_missing",
    );
  });

  it("accepts a matching object", () => {
    expect(
      validateStorageObject({ ...base, found: true, meta: { size: 1024, mimetype: "video/mp4" } }),
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

describe("isValidStoragePath", () => {
  const user = "11111111-1111-1111-1111-111111111111";
  const project = "22222222-2222-2222-2222-222222222222";
  const file = "33333333-3333-3333-3333-333333333333";
  const prefix = `${user}/${project}/${file}`;

  it("accepts canonical server-owned path", () => {
    expect(isValidStoragePath(`${prefix}/clip.mp4`, user, project, file)).toBe(true);
  });

  it("rejects when prefix does not match user/project/file", () => {
    expect(isValidStoragePath(`other/${project}/${file}/clip.mp4`, user, project, file)).toBe(
      false,
    );
    expect(isValidStoragePath(`${user}/${project}/other/clip.mp4`, user, project, file)).toBe(
      false,
    );
  });

  it("rejects traversal segments", () => {
    expect(isValidStoragePath(`${prefix}/../evil.mp4`, user, project, file)).toBe(false);
    expect(isValidStoragePath(`${prefix}/..`, user, project, file)).toBe(false);
  });

  it("rejects double slashes", () => {
    expect(isValidStoragePath(`${prefix}//clip.mp4`, user, project, file)).toBe(false);
  });

  it("rejects backslashes", () => {
    expect(isValidStoragePath(`${prefix}/sub\\clip.mp4`, user, project, file)).toBe(false);
  });

  it("rejects nested subdirectories under the file id", () => {
    expect(isValidStoragePath(`${prefix}/sub/clip.mp4`, user, project, file)).toBe(false);
  });

  it("rejects empty / missing filename", () => {
    expect(isValidStoragePath(`${prefix}/`, user, project, file)).toBe(false);
    expect(isValidStoragePath("", user, project, file)).toBe(false);
    expect(isValidStoragePath(null, user, project, file)).toBe(false);
  });
});
