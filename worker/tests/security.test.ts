import { describe, it, expect } from "vitest";
import {
  computeHmacHex,
  verifyHmacHex,
  timingSafeEqualString,
  isTimestampFresh,
  buildSignatureMessage,
} from "../src/security/hmac.js";
import { extractBearer, verifyBearer } from "../src/security/auth.js";

describe("hmac", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("computes and verifies a matching hex signature", () => {
    const msg = buildSignatureMessage("2026-07-19T00:00:00Z", '{"a":1}');
    const sig = computeHmacHex(secret, msg);
    expect(verifyHmacHex(secret, msg, sig)).toBe(true);
  });

  it("rejects tampered signature", () => {
    const msg = buildSignatureMessage("2026-07-19T00:00:00Z", '{"a":1}');
    const sig = computeHmacHex(secret, msg);
    const bad = sig.replace(/.$/, sig.endsWith("0") ? "1" : "0");
    expect(verifyHmacHex(secret, msg, bad)).toBe(false);
  });

  it("rejects length mismatch without throwing", () => {
    expect(verifyHmacHex(secret, "x", "abc")).toBe(false);
    expect(verifyHmacHex(secret, "x", "")).toBe(false);
  });

  it("timing-safe string comparison rejects length mismatches", () => {
    expect(timingSafeEqualString("aaa", "aaaa")).toBe(false);
    expect(timingSafeEqualString("secret", "secret")).toBe(true);
  });

  it("validates ±5min timestamp window on epoch seconds", () => {
    const now = Date.now();
    const s = (ms: number) => String(Math.floor(ms / 1000));
    expect(isTimestampFresh(s(now), now)).toBe(true);
    expect(isTimestampFresh(s(now - 4 * 60 * 1000), now)).toBe(true);
    expect(isTimestampFresh(s(now - 6 * 60 * 1000), now)).toBe(false);
    expect(isTimestampFresh(s(now + 6 * 60 * 1000), now)).toBe(false);
    expect(isTimestampFresh("not a date", now)).toBe(false);
    // ISO-8601 and millisecond timestamps are rejected by the unified contract.
    expect(isTimestampFresh(new Date(now).toISOString(), now)).toBe(false);
    expect(isTimestampFresh(String(now), now)).toBe(false);
  });
});

describe("bearer auth", () => {
  const key = "x".repeat(32);
  it("extracts a bearer token", () => {
    expect(extractBearer(`Bearer ${key}`)).toBe(key);
    expect(extractBearer(`bearer ${key}`)).toBe(key);
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
  });
  it("verifies with timing-safe compare", () => {
    expect(verifyBearer(key, key)).toBe(true);
    expect(verifyBearer("nope", key)).toBe(false);
    expect(verifyBearer("", key)).toBe(false);
    expect(verifyBearer(null, key)).toBe(false);
  });
});
