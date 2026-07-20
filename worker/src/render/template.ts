import fs from "node:fs";
import { spawn } from "node:child_process";
import { ensureInsideDir, safeBaseName } from "../storage/paths.js";
import type { TemplateSettings } from "../types/contract.js";

/**
 * Render the template overlay layers as transparent PNGs. Everything is
 * rasterised via ffmpeg from a freshly-generated SVG so we never rely on
 * external font/asset resolution. Colors are regex-checked and all text
 * is XML-escaped before being written to the SVG.
 *
 * Two overlays are produced:
 *   - header PNG: covers the full frame (transparent below the header band)
 *     and contains the top band, page name, identifier, logo (if any) and
 *     the headline placed in the lower portion of the video area.
 *   - watermark PNG (optional): a small logo-based mark. Position is
 *     applied later via the ffmpeg `overlay` filter so per-output jitter
 *     can be added without rebuilding this PNG.
 */

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function escapeXml(s: string): string {
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
  jobId: string;
  /** Absolute path to the logo file on disk, when the template selects one. */
  logoPath: string | null;
  /** Absolute path to the header-art image on disk, when template.header_image_file_id is set. */
  headerImagePath: string | null;
  /** Natural dimensions of the header-art image, required in cover mode to
   * reproduce the exact framing chosen in the UI. */
  headerImageNaturalSize?: { w: number; h: number } | null;
  ffmpegTimeoutMs: number;
}

export interface TemplateAssets {
  headerOverlayPath: string;
  watermarkPngPath: string | null;
  watermarkSize: { w: number; h: number } | null;
  layout: {
    width: number;
    height: number;
    headerHeight: number;
    videoAreaHeight: number;
  };
}


export async function buildTemplateOverlay(args: BuildTemplateArgs): Promise<TemplateAssets> {
  const t = args.template;
  const width = args.width;
  const height = args.height;
  const headerHeight = Math.max(0, Math.round(height * t.header_height_ratio));
  const videoAreaHeight = height - headerHeight;

  const pageName = safeText(t.page_name, 80);
  const identifier = safeText(t.identifier, 60);
  const headline = safeText(t.headline, 160);
  const bg = safeColor(t.background_color, "#0F0F12");
  const fg = safeColor(t.text_color, "#FFFFFF");
  const accent = safeColor(t.accent_color, "#FF5A1F");

  const logoDataUri = args.logoPath ? loadImageAsDataUri(args.logoPath) : null;
  if (t.logo_file_id && !logoDataUri) {
    throw new Error("template_logo_invalid");
  }

  // Novo modo "arte pronta": a header_image_file_id define uma imagem que
  // ocupa toda a faixa superior; nenhum texto/logo legado é renderizado.
  const useHeaderArt = Boolean(t.header_image_file_id);
  if (useHeaderArt && !args.headerImagePath) {
    throw new Error("header_image_invalid");
  }
  const headerImageDataUri = args.headerImagePath ? loadImageAsDataUri(args.headerImagePath) : null;
  if (useHeaderArt && !headerImageDataUri) {
    throw new Error("header_image_invalid");
  }

  const svg = useHeaderArt
    ? buildHeaderArtSvg({
        width,
        height,
        headerHeight,
        fit: t.header_image_fit,
        imageDataUri: headerImageDataUri as string,
        naturalSize: args.headerImageNaturalSize ?? null,
        positionX: clamp01(t.header_image_position_x ?? 0.5),
        positionY: clamp01(t.header_image_position_y ?? 0.5),
      })
    : buildHeaderSvg({
        width,
        height,
        headerHeight,
        videoAreaHeight,
        pageName,
        identifier,
        headline,
        bg,
        fg,
        accent,
        logoDataUri,
      });


  const base = safeBaseName(args.jobId);
  const svgPath = ensureInsideDir(args.outDir, `overlay_header_${base}.svg`);
  const headerPng = ensureInsideDir(args.outDir, `overlay_header_${base}.png`);
  fs.writeFileSync(svgPath, svg, "utf8");
  await rasterizeSvg(svgPath, headerPng, args.ffmpegTimeoutMs);
  try {
    fs.unlinkSync(svgPath);
  } catch {
    /* noop */
  }

  let watermarkPngPath: string | null = null;
  let watermarkSize: { w: number; h: number } | null = null;
  if (logoDataUri) {
    const wmW = Math.round(width * 0.15);
    const wmH = Math.round(wmW * 0.75); // preserved with preserveAspectRatio
    const wmSvg = buildWatermarkSvg(wmW, wmH, logoDataUri);
    const wmSvgPath = ensureInsideDir(args.outDir, `overlay_wm_${base}.svg`);
    const wmPngPath = ensureInsideDir(args.outDir, `overlay_wm_${base}.png`);
    fs.writeFileSync(wmSvgPath, wmSvg, "utf8");
    await rasterizeSvg(wmSvgPath, wmPngPath, args.ffmpegTimeoutMs);
    try {
      fs.unlinkSync(wmSvgPath);
    } catch {
      /* noop */
    }
    watermarkPngPath = wmPngPath;
    watermarkSize = { w: wmW, h: wmH };
  }

  return {
    headerOverlayPath: headerPng,
    watermarkPngPath,
    watermarkSize,
    layout: { width, height, headerHeight, videoAreaHeight },
  };
}

interface HeaderArtSvgArgs {
  width: number;
  height: number;
  headerHeight: number;
  fit: "cover" | "contain";
  imageDataUri: string;
}

function buildHeaderArtSvg(o: HeaderArtSvgArgs): string {
  // "cover" preenche e corta centralmente (slice); "contain" mostra tudo
  // com letterboxing preto (meet + fundo preto na faixa).
  const preserve = o.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet";
  const bgRect =
    o.fit === "contain"
      ? `<rect x="0" y="0" width="${o.width}" height="${o.headerHeight}" fill="#000000"/>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${o.width}" height="${o.height}" viewBox="0 0 ${o.width} ${o.height}">
${bgRect}
<image href="${o.imageDataUri}" x="0" y="0" width="${o.width}" height="${o.headerHeight}" preserveAspectRatio="${preserve}"/>
</svg>`;
}

interface HeaderSvgArgs {
  width: number;
  height: number;
  headerHeight: number;
  videoAreaHeight: number;
  pageName: string;
  identifier: string;
  headline: string;
  bg: string;
  fg: string;
  accent: string;
  logoDataUri: string | null;
}

function buildHeaderSvg(o: HeaderSvgArgs): string {
  const {
    width,
    height,
    headerHeight,
    pageName,
    identifier,
    headline,
    bg,
    fg,
    accent,
    logoDataUri,
  } = o;

  const pad = Math.round(width * 0.03);
  const logoBoxW = Math.round(headerHeight * 0.75);
  const logoBoxH = Math.round(headerHeight * 0.6);
  const logoX = pad;
  const logoY = Math.round((headerHeight - logoBoxH) / 2);

  const textX = logoDataUri ? logoX + logoBoxW + pad : pad;
  const pageFont = Math.round(headerHeight * 0.34);
  const identFont = Math.round(headerHeight * 0.22);

  const headlineFont = Math.max(28, Math.round(width * 0.045));
  const headlineY = headerHeight + Math.round(o.videoAreaHeight * 0.86);

  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${headerHeight}" fill="${bg}"/>`,
    `<rect x="0" y="${headerHeight - 4}" width="${width}" height="4" fill="${accent}"/>`,
  );
  if (logoDataUri) {
    parts.push(
      `<image href="${logoDataUri}" x="${logoX}" y="${logoY}" width="${logoBoxW}" height="${logoBoxH}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  }
  if (pageName) {
    parts.push(
      `<text x="${textX}" y="${Math.round(headerHeight * 0.5)}" font-family="DejaVu Sans, sans-serif" font-size="${pageFont}" font-weight="700" fill="${fg}">${escapeXml(pageName)}</text>`,
    );
  }
  if (identifier) {
    parts.push(
      `<text x="${textX}" y="${Math.round(headerHeight * 0.82)}" font-family="DejaVu Sans, sans-serif" font-size="${identFont}" fill="${fg}" fill-opacity="0.75">${escapeXml(identifier)}</text>`,
    );
  }
  if (headline) {
    // Simple two-line wrap heuristic: split on the last space near the middle
    // when the string is long, otherwise keep single-line.
    const lines = wrapText(headline, 42);
    const lineHeight = Math.round(headlineFont * 1.2);
    const totalH = lineHeight * lines.length;
    const startY = headlineY - totalH;
    const stroke = Math.max(2, Math.round(headlineFont * 0.08));
    lines.forEach((ln, idx) => {
      const y = startY + lineHeight * (idx + 1);
      parts.push(
        `<text x="${Math.round(width / 2)}" y="${y}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${headlineFont}" font-weight="800" fill="${fg}" stroke="${bg}" stroke-width="${stroke}" paint-order="stroke fill">${escapeXml(ln)}</text>`,
      );
    });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join("\n")}
</svg>`;
}

function buildWatermarkSvg(w: number, h: number, logoDataUri: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image href="${logoDataUri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>
</svg>`;
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  if (text.length <= maxCharsPerLine) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
      continue;
    }
    if (cur.length + 1 + w.length <= maxCharsPerLine) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length >= 2) break;
    }
  }
  if (cur && lines.length < 3) lines.push(cur);
  return lines.slice(0, 3);
}

function loadImageAsDataUri(absPath: string): string | null {
  try {
    const buf = fs.readFileSync(absPath);
    const mime = guessImageMime(absPath, buf);
    if (!mime) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function guessImageMime(absPath: string, buf: Buffer): string | null {
  const lower = absPath.toLowerCase();
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (lower.endsWith(".webp") && buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF")
    return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

/**
 * Rasterize SVG to PNG using `rsvg-convert` (librsvg2-bin).
 * We depend on librsvg explicitly — Debian's default ffmpeg build does NOT
 * include SVG decoder support, so relying on `ffmpeg -i in.svg out.png`
 * silently degrades in production. The Dockerfile and CI both install
 * `librsvg2-bin` and assert its presence at build time.
 */
function rasterizeSvg(svgPath: string, pngPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["--format=png", "--output", pngPath, svgPath];
    const child = spawn("rsvg-convert", args, { shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("template_rasterize_timeout"));
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("template_rasterize_spawn_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error("template_rasterize_failed"));
    });
  });
}

/**
 * Rejects template settings that would smuggle unsafe values. Colors are
 * already validated by Zod at ingress; this is a belt-and-braces check.
 */
export function assertTemplateSafe(t: TemplateSettings): void {
  for (const key of ["background_color", "text_color", "accent_color"] as const) {
    const v = t[key];
    if (typeof v === "string" && v !== "" && !COLOR_RE.test(v)) {
      throw new Error(`invalid_${key}`);
    }
  }
  for (const key of Object.keys(t)) {
    const v = (t as Record<string, unknown>)[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) {
      throw new Error("template_external_url_forbidden");
    }
  }
}
