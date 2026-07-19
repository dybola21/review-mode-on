import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureInsideDir, safeBaseName } from "../storage/paths.js";
import type { TemplateSettings } from "../types/contract.js";

/**
 * Render a template overlay as a transparent PNG at the target size using
 * ffmpeg's own text/svg support. We DO NOT execute a shell — everything
 * happens through `spawn` with argv arrays.
 *
 * The MVP builds a simple SVG with the header/footer/watermark text and
 * rasterises it via ffmpeg's `-i pipe:0`. Colors and text are validated
 * before being written to the SVG (colors regex-checked, text escaped).
 */

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeColor(c: string | null | undefined, fallback: string): string {
  return c && COLOR_RE.test(c) ? c : fallback;
}

function safeText(s: string | null | undefined, maxLen: number): string {
  if (!s) return "";
  const oneLine = s.replace(/[\r\n\t]+/g, " ").trim();
  return oneLine.slice(0, maxLen);
}

export interface BuildTemplateArgs {
  width: number;
  height: number;
  template: TemplateSettings;
  outDir: string;
  workerOutputId: string;
  ffmpegTimeoutMs: number;
}

export interface TemplateAssets {
  overlayPngPath: string | null;
}

export async function buildTemplateOverlay(args: BuildTemplateArgs): Promise<TemplateAssets> {
  const t = args.template ?? {};
  const header = safeText(t.header_text, 80);
  const footer = safeText(t.footer_text, 80);
  const watermark = safeText(t.watermark_text, 40);
  if (!header && !footer && !watermark) return { overlayPngPath: null };

  const headerColor = safeColor(t.header_color, "#ffffff");
  const bgColor = safeColor(t.background_color, "#000000");
  const wmPos = ["top-left", "top-right", "bottom-left", "bottom-right"].includes(
    (t.watermark_position as string) ?? "",
  )
    ? (t.watermark_position as string)
    : "bottom-right";

  const svg = buildSvg({
    width: args.width,
    height: args.height,
    header,
    footer,
    watermark,
    headerColor,
    bgColor,
    wmPos,
  });

  const svgPath = ensureInsideDir(args.outDir, `overlay_${safeBaseName(args.workerOutputId)}.svg`);
  const pngPath = ensureInsideDir(args.outDir, `overlay_${safeBaseName(args.workerOutputId)}.png`);
  fs.writeFileSync(svgPath, svg, "utf8");

  await runFfmpegOverlaySvgToPng(svgPath, pngPath, args.ffmpegTimeoutMs);
  try {
    fs.unlinkSync(svgPath);
  } catch {
    /* noop */
  }
  return { overlayPngPath: pngPath };
}

function buildSvg(o: {
  width: number;
  height: number;
  header: string;
  footer: string;
  watermark: string;
  headerColor: string;
  bgColor: string;
  wmPos: string;
}): string {
  const { width, height, header, footer, watermark, headerColor, bgColor, wmPos } = o;
  const headerH = header ? Math.round(height * 0.09) : 0;
  const footerH = footer ? Math.round(height * 0.08) : 0;
  const wmSize = Math.round(height * 0.028);
  const pad = Math.round(height * 0.02);
  const wmX = wmPos === "top-left" || wmPos === "bottom-left" ? pad : width - pad;
  const wmY = wmPos === "top-left" || wmPos === "top-right" ? pad + wmSize : height - pad;
  const wmAnchor = wmPos === "top-right" || wmPos === "bottom-right" ? "end" : "start";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${
    header
      ? `<rect x="0" y="0" width="${width}" height="${headerH}" fill="${bgColor}" fill-opacity="0.6"/>
         <text x="${width / 2}" y="${headerH * 0.62}" text-anchor="middle"
               font-family="DejaVu Sans, sans-serif" font-size="${Math.round(headerH * 0.5)}"
               font-weight="700" fill="${headerColor}">${escapeXml(header)}</text>`
      : ""
  }
  ${
    footer
      ? `<rect x="0" y="${height - footerH}" width="${width}" height="${footerH}" fill="${bgColor}" fill-opacity="0.6"/>
         <text x="${width / 2}" y="${height - footerH * 0.35}" text-anchor="middle"
               font-family="DejaVu Sans, sans-serif" font-size="${Math.round(footerH * 0.45)}"
               fill="${headerColor}">${escapeXml(footer)}</text>`
      : ""
  }
  ${
    watermark
      ? `<text x="${wmX}" y="${wmY}" text-anchor="${wmAnchor}"
               font-family="DejaVu Sans, sans-serif" font-size="${wmSize}"
               fill="${headerColor}" fill-opacity="0.75">${escapeXml(watermark)}</text>`
      : ""
  }
</svg>`;
}

function runFfmpegOverlaySvgToPng(
  svgPath: string,
  pngPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-nostdin", "-loglevel", "error", "-i", svgPath, pngPath];
    const child = spawn("ffmpeg", args, { shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("template_ffmpeg_timeout"));
    }, timeoutMs);
    let errTail = "";
    child.stderr.on("data", (d) => (errTail = (errTail + d.toString()).slice(-2048)));
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("template_ffmpeg_spawn_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // Do not surface raw ffmpeg output to callers.
      reject(new Error("template_ffmpeg_failed"));
    });
  });
}

/**
 * Helpers for the render pipeline — reject template settings that try to
 * smuggle unsafe values.
 */
export function assertTemplateSafe(t: TemplateSettings): void {
  for (const key of ["header_color", "background_color"] as const) {
    const v = (t as Record<string, unknown>)[key];
    if (v != null && typeof v === "string" && v !== "" && !COLOR_RE.test(v)) {
      throw new Error(`invalid_${key}`);
    }
  }
  // No external URLs in template settings — assets come via fileIds only.
  for (const key of Object.keys(t ?? {})) {
    const v = (t as Record<string, unknown>)[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) {
      throw new Error("template_external_url_forbidden");
    }
  }
  // Unused reference to path to keep this function self-contained.
  void path;
}
