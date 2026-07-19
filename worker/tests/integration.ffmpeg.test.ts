import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

/**
 * Integration test: renders a 2s synthetic video via the ffmpeg CLI and
 * confirms ffprobe can validate it. Skipped if ffmpeg is not installed
 * in the current environment (Lovable sandbox usually lacks it — Docker
 * image installs it).
 */

function hasBin(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["-version"], { shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

describe("ffmpeg integration (skipped when ffmpeg missing)", async () => {
  const ff = await hasBin("ffmpeg");
  const fp = await hasBin("ffprobe");
  const runIt = ff && fp ? it : it.skip;

  runIt(
    "renders a 2s synthetic mp4",
    async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-int-"));
      const out = path.join(dir, "out.mp4");
      await new Promise<void>((resolve, reject) => {
        const args = [
          "-y",
          "-nostdin",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=24:duration=2",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          out,
        ];
        const c = spawn("ffmpeg", args, { shell: false });
        c.on("error", reject);
        c.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code)),
        );
      });
      const { ffprobe } = await import("../src/storage/download.js");
      const info = await ffprobe(out);
      expect(info.hasVideo).toBe(true);
      expect(info.durationSeconds).toBeGreaterThan(1);
    },
    30_000,
  );
});
