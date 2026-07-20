import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadOutput, UploadError } from "../src/storage/upload.js";

/**
 * Regression: an upload fetch that never responds must terminate with
 * `output_upload_timeout` (transient=true) once the per-attempt deadline is
 * hit. The job loop above interprets a repeated timeout as a `failed` job,
 * never a stuck `processing` one.
 */

const OPTS = {
  maxBytes: 1_000_000,
  timeoutMs: 200,
  allowedHosts: ["files.example.com"] as const,
  isProduction: true,
} as const;

describe("uploadOutput timeout", () => {
  let tmp: string;
  let file: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upload-timeout-"));
    file = path.join(tmp, "out.mp4");
    fs.writeFileSync(file, Buffer.from("fake-video-bytes"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    vi.restoreAllMocks();
  });

  it("aborts and throws output_upload_timeout when the server never responds", async () => {
    // Fetch that only resolves when its AbortSignal fires — mirrors a stalled
    // upstream server (accept-and-hang).
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never resolves
        const onAbort = () => {
          const err = new Error("aborted");
          (err as { name: string }).name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof globalThis.fetch;

    const started = Date.now();
    await expect(
      uploadOutput(file, "https://files.example.com/out", "video/mp4", OPTS),
    ).rejects.toMatchObject({
      name: "UploadError",
      code: "output_upload_timeout",
      transient: true,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("respects an external cancel signal even before the per-attempt timeout", async () => {
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => {
          const err = new Error("aborted");
          (err as { name: string }).name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof globalThis.fetch;

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    const promise = uploadOutput(file, "https://files.example.com/out", "video/mp4", {
      ...OPTS,
      timeoutMs: 30_000,
      cancel: ctrl.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(UploadError);
  });
});
