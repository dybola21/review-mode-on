import { describe, expect, it } from "bun:test";
import {
  buildOutputStoragePath,
  computeMaxOutputs,
  computeSignature,
  isPathUnderJob,
  isTimestampFresh,
  MAX_WEBHOOK_AGE_SECONDS,
  normalizePublicAppUrl,
  publicAppUrlSchema,
  sanitizeBaseName,
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
  it("multiplies files by variations", () => {
    expect(computeMaxOutputs(3, 4)).toBe(12);
  });
  it("caps at the hard maximum", () => {
    expect(computeMaxOutputs(50, 50, 400)).toBe(400);
  });
  it("floors negatives to zero", () => {
    expect(computeMaxOutputs(-1, 5)).toBe(0);
    expect(computeMaxOutputs(5, 0)).toBe(0);
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
