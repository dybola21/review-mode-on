import { z } from "zod";

/**
 * Zod schemas compartilhados entre client e server para template e variações.
 * Não importar código de servidor.
 */

export const templateSettingsSchema = z.object({
  // Novo layout: arte pronta no cabeçalho + vídeo abaixo.
  header_image_file_id: z.string().uuid().nullable().optional(),
  header_image_fit: z.enum(["cover", "contain"]).default("cover"),
  // Campos legados — mantidos apenas para compatibilidade com projetos
  // antigos. Ignorados sempre que header_image_file_id existir.
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
 * Cria o schema de variações usando o limite dinâmico de app_settings.
 */
export function makeVariationSettingsSchema(maxVariations: number) {
  const minMax = (min: number, max: number) =>
    z
      .object({
        min: z.number().finite().min(min).max(max),
        max: z.number().finite().min(min).max(max),
      })
      .refine((v) => v.min <= v.max, {
        message: "O valor mínimo não pode ser maior que o máximo.",
      });

  return z.object({
    brightness: minMax(-0.2, 0.2),
    contrast: minMax(0.8, 1.2),
    saturation: minMax(0.8, 1.2),
    temperature: minMax(-15, 15),
    scale: minMax(1.0, 1.1),
    watermark_position_jitter: z.boolean().default(false),
    variation_count: z
      .number()
      .int()
      .min(1)
      .max(Math.max(1, Math.min(100, maxVariations))),
  });
}

export type VariationSettings = z.infer<ReturnType<typeof makeVariationSettingsSchema>>;

export const DEFAULT_VARIATION_SETTINGS: VariationSettings = {
  brightness: { min: -0.05, max: 0.05 },
  contrast: { min: 0.95, max: 1.05 },
  saturation: { min: 0.95, max: 1.05 },
  temperature: { min: -5, max: 5 },
  scale: { min: 1.0, max: 1.03 },
  watermark_position_jitter: false,
  variation_count: 3,
};

export const RIGHTS_CONFIRMATION_VERSION = "1.0";
export const RIGHTS_CONFIRMATION_TEXT =
  "Confirmo que possuo os direitos ou a autorização necessária para utilizar e editar todos os vídeos, imagens, logotipos, textos e áudios enviados neste projeto.";

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
