import { z } from "zod";

// Canonical schemas — must match src/lib/project-schemas.ts on the app.
// Contract v2: 1 header art + N source videos -> N outputs (1:1). No variations.

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
    // v2: each output is bound to exactly one source_video input.
    sourceFileId: z.string().uuid(),
  })
  .strict();

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "invalid hex color");

export const templateSettingsSchema = z
  .object({
    header_image_file_id: z.string().uuid().nullable().optional(),
    header_image_fit: z.enum(["cover", "contain"]).default("cover"),
    // Legacy — accepted for backward compat, ignored when header art is set.
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

export const CONTRACT_VERSION = 2 as const;

export const jobPayloadSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    callbackUrl: z.string().url(),
    inputFiles: z.array(inputFileSchema).min(1).max(600),
    outputTargets: z.array(outputTargetSchema).min(1).max(400),
    templateSettings: templateSettingsSchema,
    uploadTtlSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 3600),
  })
  .strict()
  .superRefine((p, ctx) => {
    const sourceIds = new Set(
      p.inputFiles.filter((f) => f.fileType === "source_video").map((f) => f.fileId),
    );
    if (sourceIds.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one source_video required",
        path: ["inputFiles"],
      });
      return;
    }
    if (p.outputTargets.length !== sourceIds.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outputTargets.length must equal number of source_video inputs",
        path: ["outputTargets"],
      });
    }
    const seenSources = new Set<string>();
    for (let i = 0; i < p.outputTargets.length; i++) {
      const t = p.outputTargets[i]!;
      if (!sourceIds.has(t.sourceFileId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "sourceFileId must reference an input source_video",
          path: ["outputTargets", i, "sourceFileId"],
        });
      }
      if (seenSources.has(t.sourceFileId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "each source_video must map to exactly one output",
          path: ["outputTargets", i, "sourceFileId"],
        });
      }
      seenSources.add(t.sourceFileId);
    }
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
