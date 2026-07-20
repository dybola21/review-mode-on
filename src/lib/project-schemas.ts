import { z } from "zod";

/**
 * Zod schemas compartilhados entre client e server para template.
 * Não importar código de servidor.
 * v2: sem variações. Cada vídeo de origem gera exatamente uma saída.
 */

export const templateSettingsSchema = z.object({
  header_image_file_id: z.string().uuid().nullable().optional(),
  header_image_fit: z.enum(["cover", "contain"]).default("cover"),
  // Legados — mantidos apenas para compatibilidade com projetos antigos.
  page_name: z.string().trim().max(80).default(""),
  identifier: z.string().trim().max(60).default(""),
  headline: z.string().trim().max(160).default(""),
  logo_file_id: z.string().uuid().nullable().optional(),
  background_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Cor inválida")
    .default("#0F0F12"),
  text_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Cor inválida")
    .default("#FFFFFF"),
  accent_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Cor inválida")
    .default("#FF5A1F"),
  watermark_position: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
    .default("bottom-right"),
  watermark_opacity: z.number().min(0).max(1).default(0.6),
  header_height_ratio: z.number().min(0).max(0.4).default(0.335),
  header_image_position_x: z.number().min(0).max(1).default(0.5),
  header_image_position_y: z.number().min(0).max(1).default(0.5),
});

export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = templateSettingsSchema.parse({});

/**
 * Schema estrito para envio ao worker (contrato v2). Diferente do
 * templateSettingsSchema (rascunho), aqui `header_image_file_id`
 * é OBRIGATÓRIO e deve ser um UUID — o worker rejeita qualquer coisa
 * diferente. Use este schema em submitRenderJob, nunca em edição.
 */
export const renderTemplateSettingsSchema = templateSettingsSchema.extend({
  header_image_file_id: z.string().uuid({ message: "header_image_file_id obrigatório" }),
});

export type RenderTemplateSettings = z.infer<typeof renderTemplateSettingsSchema>;

export const CONTRACT_VERSION = 2 as const;

export const RIGHTS_CONFIRMATION_VERSION = "1.0";
export const RIGHTS_CONFIRMATION_TEXT =
  "Confirmo que possuo os direitos ou a autorização necessária para utilizar e editar todos os vídeos, imagens, logotipos e textos enviados neste projeto.";

/**
 * Sanitização de nome de arquivo. Mantém letras, números, hífen, underscore e ponto.
 * Limita comprimento a 100.
 */
export function sanitizeFileName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, "-");
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  const noLeadingDots = safe.replace(/^\.+/, "");
  const truncated = noLeadingDots.slice(0, 100);
  return truncated || "arquivo";
}

const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function extensionMatchesMime(fileName: string, mime: string): boolean {
  const expected = EXT_BY_MIME[mime];
  if (!expected) return false;
  const parts = fileName.toLowerCase().split(".");
  if (parts.length < 2) return false;
  const ext = parts[parts.length - 1];
  if (expected === "jpg") return ext === "jpg" || ext === "jpeg";
  return ext === expected;
}
