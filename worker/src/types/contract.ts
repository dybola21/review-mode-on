import { z } from "zod";

// Job payload — must match src/lib/render.functions.ts / README exactly.

export const inputFileSchema = z
  .object({
    fileId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    fileType: z.enum(["source_video", "logo", "music", "template_asset"]),
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

// Loose object — server owns the schema. We reject unknown top-level fields
// but the nested template/variation objects are opaque to the worker.
export const jobPayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    callbackUrl: z.string().url(),
    inputFiles: z.array(inputFileSchema).min(1).max(200),
    outputTargets: z.array(outputTargetSchema).min(1).max(400),
    templateSettings: z.record(z.unknown()).default({}),
    variationSettings: z.record(z.unknown()).default({}),
    variationCount: z.number().int().min(1).max(50),
    uploadTtlSeconds: z.number().int().min(60).max(24 * 3600),
  })
  .strict();

export type JobPayload = z.infer<typeof jobPayloadSchema>;
export type InputFile = z.infer<typeof inputFileSchema>;
export type OutputTarget = z.infer<typeof outputTargetSchema>;

// Renew responses (from app).
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

// Template settings (optional fields the worker actually reads).
export const templateSettingsSchema = z
  .object({
    header_text: z.string().max(120).optional().nullable(),
    header_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .nullable(),
    footer_text: z.string().max(120).optional().nullable(),
    watermark_text: z.string().max(60).optional().nullable(),
    watermark_position: z
      .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
      .optional()
      .nullable(),
    background_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .nullable(),
    logo_file_id: z.string().uuid().optional().nullable(),
    music_file_id: z.string().uuid().optional().nullable(),
    fit: z.enum(["crop", "contain"]).optional().default("contain"),
  })
  .partial()
  .passthrough();

export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

export const variationSettingsSchema = z
  .object({
    brightness_range: z.tuple([z.number(), z.number()]).optional(),
    contrast_range: z.tuple([z.number(), z.number()]).optional(),
    saturation_range: z.tuple([z.number(), z.number()]).optional(),
    temperature_range: z.tuple([z.number(), z.number()]).optional(),
    scale_range: z.tuple([z.number(), z.number()]).optional(),
    // Additional editorial knobs remain opaque to the worker.
  })
  .partial()
  .passthrough();

export type VariationSettings = z.infer<typeof variationSettingsSchema>;
