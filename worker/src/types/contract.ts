import { z } from "zod";

// Canonical schemas — must match src/lib/project-schemas.ts on the app.
// Music is intentionally NOT part of this contract in the current version.

export const inputFileSchema = z
  .object({
    fileId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    fileType: z.enum(["source_video", "logo", "template_asset"]),
    mimeType: z.string().min(1).max(127),
    signedUrl: z.string().url(),
  })
  .strict();

export const outputTargetSchema = z
  .object({
    workerOutputId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127),
    signedUploadUrl: z.string().url(),
  })
  .strict();

// Canonical template — mirrors the frontend contract exactly.
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "invalid hex color");

export const templateSettingsSchema = z
  .object({
    // Novo layout: arte pronta no cabeçalho + vídeo abaixo.
    header_image_file_id: z.string().uuid().nullable().optional(),
    header_image_fit: z.enum(["cover", "contain"]).default("cover"),
    // Campos legados — mantidos por compatibilidade, ignorados quando
    // header_image_file_id existir.
    page_name: z.string().max(80).default(""),
    identifier: z.string().max(60).default(""),
    headline: z.string().max(160).default(""),
    logo_file_id: z.string().uuid().nullable().optional(),
    background_color: hexColor.default("#0F0F12"),
    text_color: hexColor.default("#FFFFFF"),
    accent_color: hexColor.default("#FF5A1F"),
    watermark_position: z
      .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
      .default("bottom-right"),
    watermark_opacity: z.number().min(0).max(1).default(0.6),
    header_height_ratio: z.number().min(0).max(0.4).default(0.335),
    header_image_position_x: z.number().min(0).max(1).default(0.5),
    header_image_position_y: z.number().min(0).max(1).default(0.5),
  })
  .strict();

export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

// Canonical variations — {min, max} shape used by the frontend.
const minMax = (min: number, max: number) =>
  z
    .object({
      min: z.number().finite().min(min).max(max),
      max: z.number().finite().min(min).max(max),
    })
    .refine((v) => v.min <= v.max, { message: "min must be <= max" });

export const variationSettingsSchema = z
  .object({
    brightness: minMax(-0.2, 0.2),
    contrast: minMax(0.8, 1.2),
    saturation: minMax(0.8, 1.2),
    // Temperature in UI units (-15..15). Conversion to ffmpeg happens later.
    temperature: minMax(-15, 15),
    scale: minMax(1.0, 1.1),
    watermark_position_jitter: z.boolean().default(false),
    variation_count: z.number().int().min(1).max(100).default(1),
  })
  .strict();

export type VariationSettings = z.infer<typeof variationSettingsSchema>;

export const jobPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    callbackUrl: z.string().url(),
    inputFiles: z.array(inputFileSchema).min(1).max(200),
    outputTargets: z.array(outputTargetSchema).min(1).max(400),
    templateSettings: templateSettingsSchema,
    variationSettings: variationSettingsSchema,
    variationCount: z.number().int().min(1).max(100),
    uploadTtlSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 3600),
  })
  .strict()
  .refine((p) => p.variationCount === p.variationSettings.variation_count, {
    message: "variationCount must equal variationSettings.variation_count",
    path: ["variationCount"],
  });

export type JobPayload = z.infer<typeof jobPayloadSchema>;
export type InputFile = z.infer<typeof inputFileSchema>;
export type OutputTarget = z.infer<typeof outputTargetSchema>;

export const renewInputResponseSchema = z
  .object({
    fileId: z.string().uuid(),
    signedUrl: z.string().url(),
    expiresIn: z.number().int().positive(),
  })
  .strict();

export const renewUploadResponseSchema = z
  .object({
    workerOutputId: z.string().uuid(),
    signedUploadUrl: z.string().url(),
    expiresInSeconds: z.number().int().positive(),
  })
  .strict();
