import { describe, it, expect, beforeEach } from "vitest";
import {
  loadConfig,
  normaliseAppBaseUrl,
  buildAppUrl,
  APP_WEBHOOK_PATH,
  APP_RENEW_INPUT_PATH,
  APP_RENEW_UPLOAD_PATH,
  APP_VERIFY_OUTPUT_PATH,
  _resetConfigForTests,
} from "../src/config.js";


const SECRET = "x".repeat(32);
const baseEnv = (over: Record<string, string | undefined>) =>
  ({
    NODE_ENV: "production",
    WORKER_API_KEY: SECRET,
    APP_WEBHOOK_SECRET: SECRET,
    APP_BASE_URL: "https://app.example.com",
    ALLOWED_DOWNLOAD_HOSTS: "files.example.com",
    ALLOWED_UPLOAD_HOSTS: "files.example.com",
    ...over,
  }) as unknown as NodeJS.ProcessEnv;

beforeEach(() => _resetConfigForTests());

describe("normaliseAppBaseUrl", () => {
  it("accepts https and strips trailing slash", () => {
    expect(normaliseAppBaseUrl("https://app.example.com/", true)).toBe("https://app.example.com");
  });
  it("strips path component", () => {
    expect(normaliseAppBaseUrl("https://app.example.com/foo/bar", true)).toBe(
      "https://app.example.com",
    );
  });
  it("rejects http in production", () => {
    expect(() => normaliseAppBaseUrl("http://app.example.com", true)).toThrow(/https/);
  });
  it("rejects query string", () => {
    expect(() => normaliseAppBaseUrl("https://app.example.com/?a=1", true)).toThrow(/query/);
  });
  it("rejects fragment", () => {
    expect(() => normaliseAppBaseUrl("https://app.example.com/#x", true)).toThrow(/fragment/);
  });
  it("rejects credentials", () => {
    expect(() => normaliseAppBaseUrl("https://user:pass@app.example.com", true)).toThrow(
      /credentials/,
    );
  });
  it("rejects localhost in production", () => {
    expect(() => normaliseAppBaseUrl("https://localhost", true)).toThrow(/localhost/);
  });
  it("allows http://localhost outside production", () => {
    expect(normaliseAppBaseUrl("http://localhost:3000/", false)).toBe("http://localhost:3000");
  });
  it("rejects malformed URL", () => {
    expect(() => normaliseAppBaseUrl("not-a-url", true)).toThrow();
  });
});

describe("buildAppUrl", () => {
  it("joins base with a leading-slash path", () => {
    expect(buildAppUrl("https://app.example.com", APP_WEBHOOK_PATH)).toBe(
      "https://app.example.com/api/public/worker-webhook",
    );
  });
  it("requires leading slash", () => {
    expect(() => buildAppUrl("https://app.example.com", "api/x")).toThrow();
  });
});

describe("loadConfig", () => {
  it("derives all three endpoint URLs", () => {
    const cfg = loadConfig(baseEnv({}));
    expect(cfg.APP_WEBHOOK_URL).toBe(`https://app.example.com${APP_WEBHOOK_PATH}`);
    expect(cfg.APP_RENEW_INPUT_URL).toBe(`https://app.example.com${APP_RENEW_INPUT_PATH}`);
    expect(cfg.APP_RENEW_UPLOAD_URL).toBe(`https://app.example.com${APP_RENEW_UPLOAD_PATH}`);
  });
  it("strips trailing slash from APP_BASE_URL before building endpoints", () => {
    const cfg = loadConfig(baseEnv({ APP_BASE_URL: "https://app.example.com/" }));
    expect(cfg.APP_WEBHOOK_URL).toBe("https://app.example.com/api/public/worker-webhook");
  });
  it("fails when APP_BASE_URL is missing in production", () => {
    expect(() => loadConfig(baseEnv({ APP_BASE_URL: undefined }))).toThrow(/APP_BASE_URL/);
  });
  it("rejects legacy APP_WEBHOOK_URL to avoid conflicting configuration", () => {
    expect(() =>
      loadConfig(baseEnv({ APP_WEBHOOK_URL: "https://app.example.com/api/public/worker-webhook" })),
    ).toThrow(/APP_WEBHOOK_URL/);
  });
});
