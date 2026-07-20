import { describe, expect, it } from "bun:test";
import { isHealthyBody } from "./render.functions";

describe("isHealthyBody", () => {
  const base = { status: "ok", ffmpeg: true, queue: "ready", version: "1.0.0" };

  it("accepts a fully valid body", () => {
    expect(isHealthyBody(base)).toBe(true);
  });

  it("rejects non-object bodies", () => {
    expect(isHealthyBody(null)).toBe(false);
    expect(isHealthyBody("ok")).toBe(false);
    expect(isHealthyBody(42)).toBe(false);
    expect(isHealthyBody(undefined)).toBe(false);
  });

  it("rejects when status is not exactly 'ok'", () => {
    expect(isHealthyBody({ ...base, status: "degraded" })).toBe(false);
    expect(isHealthyBody({ ...base, status: undefined })).toBe(false);
  });

  it("rejects when ffmpeg is not strictly true", () => {
    expect(isHealthyBody({ ...base, ffmpeg: false })).toBe(false);
    expect(isHealthyBody({ ...base, ffmpeg: "true" })).toBe(false);
  });

  it("rejects when queue is not exactly 'ready'", () => {
    expect(isHealthyBody({ ...base, queue: "unavailable" })).toBe(false);
    expect(isHealthyBody({ ...base, queue: undefined })).toBe(false);
  });

  it("rejects when version is missing, empty, or non-string", () => {
    expect(isHealthyBody({ ...base, version: undefined })).toBe(false);
    expect(isHealthyBody({ ...base, version: "" })).toBe(false);
    expect(isHealthyBody({ ...base, version: "   " })).toBe(false);
    expect(isHealthyBody({ ...base, version: 1 })).toBe(false);
    expect(isHealthyBody({ ...base, version: null })).toBe(false);
  });
});
