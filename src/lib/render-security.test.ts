import { describe, expect, it } from "vitest";

import {
  bucketForFileType,
  buildOutputStoragePath,
  computeMaxOutputs,
  computeSignature,
  isPathUnderJob,
  isTimestampFresh,
  isValidInputStoragePath,
  MAX_WEBHOOK_AGE_SECONDS,
  mimeAllowedForFileType,
  normalizePublicAppUrl,
  publicAppUrlSchema,
  sanitizeBaseName,
  validateRenderInput,
  verifySignature,
} from "./render-security";


const SECRET = "test-secret-abc-123";

describe("publicAppUrlSchema", () => {
  it("accepts a clean https url", () => {
    const r = publicAppUrlSchema.safeParse("https://app.example.com");
    expect(r.success).toBe(true);
  });
  it("rejects urls with credentials", () => {
    const r = publicAppUrlSchema.safeParse("https://user:pass@app.example.com");
    expect(r.success).toBe(false);
  });
  it("rejects urls with a query string", () => {
    const r = publicAppUrlSchema.safeParse("https://app.example.com/?a=1");
    expect(r.success).toBe(false);
  });
  it("rejects urls with a fragment", () => {
    const r = publicAppUrlSchema.safeParse("https://app.example.com/#x");
    expect(r.success).toBe(false);
  });
  it("rejects malformed urls", () => {
    expect(publicAppUrlSchema.safeParse("not a url").success).toBe(false);
    expect(publicAppUrlSchema.safeParse("").success).toBe(false);
  });
});

describe("normalizePublicAppUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizePublicAppUrl("https://app.example.com/")).toBe("https://app.example.com");
    expect(normalizePublicAppUrl("https://app.example.com//")).toBe("https://app.example.com");
  });
  it("returns null for invalid input", () => {
    expect(normalizePublicAppUrl(undefined)).toBeNull();
    expect(normalizePublicAppUrl("")).toBeNull();
    expect(normalizePublicAppUrl("https://u:p@app.example.com")).toBeNull();
  });
});

describe("isTimestampFresh", () => {
  const now = 1_700_000_000_000;
  it("accepts current timestamp", () => {
    expect(isTimestampFresh(String(now / 1000), now)).toBe(true);
  });
  it("rejects timestamps older than 5 min", () => {
    expect(isTimestampFresh(String(now / 1000 - MAX_WEBHOOK_AGE_SECONDS - 1), now)).toBe(false);
  });
  it("rejects timestamps too far in the future", () => {
    expect(isTimestampFresh(String(now / 1000 + MAX_WEBHOOK_AGE_SECONDS + 1), now)).toBe(false);
  });
  it("rejects non-numeric or missing", () => {
    expect(isTimestampFresh(null)).toBe(false);
    expect(isTimestampFresh("abc")).toBe(false);
  });
  it("rejects ISO-8601 (contract is epoch seconds)", () => {
    expect(isTimestampFresh(new Date(now).toISOString(), now)).toBe(false);
  });
});

describe("signature verification", () => {
  it("verifies a matching signature", () => {
    const ts = "1700000000";
    const body = '{"jobId":"x"}';
    const sig = computeSignature(SECRET, ts, body);
    expect(verifySignature(SECRET, ts, body, sig)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const ts = "1700000000";
    const body = '{"jobId":"x"}';
    const sig = computeSignature(SECRET, ts, body);
    expect(verifySignature(SECRET, ts, '{"jobId":"y"}', sig)).toBe(false);
  });
  it("rejects a different timestamp", () => {
    const sig = computeSignature(SECRET, "1700000000", "b");
    expect(verifySignature(SECRET, "1700000001", "b", sig)).toBe(false);
  });
  it("rejects garbage signature", () => {
    expect(verifySignature(SECRET, "1", "b", "not-hex")).toBe(false);
  });
});

describe("storage paths", () => {
  const userId = "11111111-1111-1111-1111-111111111111";
  const projectId = "22222222-2222-2222-2222-222222222222";
  const jobId = "33333333-3333-3333-3333-333333333333";
  const wid = "output-abc_1";
  it("builds a stable server-owned path", () => {
    expect(
      buildOutputStoragePath({
        userId,
        projectId,
        jobId,
        workerOutputId: wid,
        extension: "mp4",
      }),
    ).toBe(`${userId}/${projectId}/${jobId}/${wid}.mp4`);
  });
  it("rejects worker-supplied path traversal ids", () => {
    expect(() =>
      buildOutputStoragePath({
        userId,
        projectId,
        jobId,
        workerOutputId: "../evil",
        extension: "mp4",
      }),
    ).toThrow();
  });
  it("rejects nonsense extensions", () => {
    expect(() =>
      buildOutputStoragePath({
        userId,
        projectId,
        jobId,
        workerOutputId: wid,
        extension: "mp4;rm -rf /",
      }),
    ).toThrow();
  });
  it("recognises paths under the job prefix", () => {
    const p = buildOutputStoragePath({
      userId,
      projectId,
      jobId,
      workerOutputId: wid,
      extension: "mp4",
    });
    expect(isPathUnderJob(p, userId, projectId, jobId)).toBe(true);
    expect(isPathUnderJob(p, userId, projectId, "other")).toBe(false);
    expect(
      isPathUnderJob(`${userId}/${projectId}/${jobId}/../foo.mp4`, userId, projectId, jobId),
    ).toBe(false);
  });
});

describe("computeMaxOutputs", () => {
  it("returns raw product without clamp", () => {
    expect(computeMaxOutputs(3, 4)).toBe(12);
  });
  it("allows exactly 400", () => {
    expect(computeMaxOutputs(20, 20)).toBe(400);
  });
  it("returns >400 for callers to reject up-front", () => {
    expect(computeMaxOutputs(21, 20)).toBe(420);
    expect(computeMaxOutputs(50, 50)).toBe(2500);
  });
  it("floors negatives to zero", () => {
    expect(computeMaxOutputs(-1, 5)).toBe(0);
    expect(computeMaxOutputs(5, 0)).toBe(0);
  });
});

describe("bucketForFileType", () => {
  it("maps known types to canonical buckets", () => {
    expect(bucketForFileType("source_video")).toBe("project-inputs");
    expect(bucketForFileType("logo")).toBe("project-assets");
    expect(bucketForFileType("template_asset")).toBe("project-assets");
  });
  it("returns null for unknown types", () => {
    expect(bucketForFileType("random")).toBeNull();
    expect(bucketForFileType("")).toBeNull();
  });
});

describe("mimeAllowedForFileType", () => {
  it("enforces video for source_video", () => {
    expect(mimeAllowedForFileType("source_video", "video/mp4")).toBe(true);
    expect(mimeAllowedForFileType("source_video", "image/png")).toBe(false);
    expect(mimeAllowedForFileType("source_video", null)).toBe(false);
    expect(mimeAllowedForFileType("source_video", undefined)).toBe(false);
  });
  it("enforces image for logo", () => {
    expect(mimeAllowedForFileType("logo", "image/png")).toBe(true);
    expect(mimeAllowedForFileType("logo", "video/mp4")).toBe(false);
  });
  it("allows image or video for template_asset", () => {
    expect(mimeAllowedForFileType("template_asset", "image/svg+xml")).toBe(true);
    expect(mimeAllowedForFileType("template_asset", "video/mp4")).toBe(true);
    expect(mimeAllowedForFileType("template_asset", "application/pdf")).toBe(false);
  });
});

describe("isValidInputStoragePath", () => {
  const u = "11111111-1111-1111-1111-111111111111";
  const p = "22222222-2222-2222-2222-222222222222";
  it("accepts a path with the exact prefix", () => {
    expect(isValidInputStoragePath(`${u}/${p}/abc/file.mp4`, u, p)).toBe(true);
  });
  it("rejects wrong owner or project", () => {
    expect(isValidInputStoragePath(`other/${p}/x.mp4`, u, p)).toBe(false);
    expect(isValidInputStoragePath(`${u}/other/x.mp4`, u, p)).toBe(false);
  });
  it("rejects traversal, double slash, backslash", () => {
    expect(isValidInputStoragePath(`${u}/${p}/../evil.mp4`, u, p)).toBe(false);
    expect(isValidInputStoragePath(`${u}/${p}//evil.mp4`, u, p)).toBe(false);
    expect(isValidInputStoragePath(`${u}/${p}/\\evil.mp4`, u, p)).toBe(false);
  });
  it("rejects empty and prefix-only", () => {
    expect(isValidInputStoragePath("", u, p)).toBe(false);
    expect(isValidInputStoragePath(`${u}/${p}/`, u, p)).toBe(false);
  });
});

describe("validateRenderInput", () => {
  const u = "11111111-1111-1111-1111-111111111111";
  const p = "22222222-2222-2222-2222-222222222222";
  const base = {
    id: "f1",
    user_id: u,
    project_id: p,
    status: "uploaded",
    file_type: "source_video",
    mime_type: "video/mp4",
    storage_path: `${u}/${p}/f1/vid.mp4`,
  };
  it("accepts a fully-valid input", () => {
    expect(validateRenderInput(base, u, p)).toBeNull();
  });
  it("rejects not-uploaded", () => {
    expect(validateRenderInput({ ...base, status: "pending" }, u, p)).toBe("not_uploaded");
  });
  it("rejects wrong owner and project", () => {
    expect(validateRenderInput({ ...base, user_id: "other" }, u, p)).toBe("wrong_owner");
    expect(validateRenderInput({ ...base, project_id: "other" }, u, p)).toBe("wrong_project");
  });
  it("rejects invalid file_type", () => {
    expect(validateRenderInput({ ...base, file_type: "junk" }, u, p)).toBe("invalid_type");
  });
  it("rejects invalid path", () => {
    expect(validateRenderInput({ ...base, storage_path: `other/${p}/x` }, u, p)).toBe(
      "invalid_path",
    );
  });
  it("rejects incompatible MIME", () => {
    expect(validateRenderInput({ ...base, mime_type: "image/png" }, u, p)).toBe("invalid_mime");
    expect(validateRenderInput({ ...base, mime_type: null }, u, p)).toBe("invalid_mime");
  });
});


describe("sanitizeBaseName", () => {
  it("keeps safe characters", () => {
    expect(sanitizeBaseName("my_video-01.name")).toBe("my_video-01.name");
  });
  it("replaces unsafe characters", () => {
    expect(sanitizeBaseName("foo bar/baz?.mp4")).toMatch(/^foo_bar_baz_/);
  });
  it("trims length", () => {
    expect(sanitizeBaseName("a".repeat(200), 20).length).toBeLessThanOrEqual(20);
  });
});
