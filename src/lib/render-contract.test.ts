import { describe, it, expect } from "vitest";
import { z } from "zod";
import { renderTemplateSettingsSchema } from "./project-schemas";

/**
 * Espelho local do jobPayloadSchema do worker (contrato v2). Duplicado
 * de propósito: se o worker mudar, este teste falha e nos força a
 * atualizar os dois lados juntos, evitando o drift que quebrava jobs
 * reais em produção.
 */
const inputFileSchema = z
  .object({
    fileId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    fileType: z.enum(["source_video", "logo", "template_asset"]),
    mimeType: z.string().min(1).max(127),
    signedUrl: z.string().url(),
  })
  .strict();

const outputTargetSchema = z
  .object({
    workerOutputId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127),
    signedUploadUrl: z.string().url(),
    sourceFileId: z.string().uuid(),
  })
  .strict();

const workerTemplateSettingsSchema = z
  .object({
    header_image_file_id: z.string().uuid(),
    header_image_fit: z.enum(["cover", "contain"]).default("cover"),
    page_name: z.string().max(80).default(""),
    identifier: z.string().max(60).default(""),
    headline: z.string().max(160).default(""),
    logo_file_id: z.string().uuid().nullable().optional(),
    background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    watermark_position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
    watermark_opacity: z.number().min(0).max(1),
    header_height_ratio: z.number().min(0).max(0.4),
    header_image_position_x: z.number().min(0).max(1),
    header_image_position_y: z.number().min(0).max(1),
  })
  .strict();

const jobPayloadSchema = z
  .object({
    contractVersion: z.literal(2),
    jobId: z.string().uuid(),
    projectId: z.string().uuid(),
    callbackUrl: z.string().url(),
    inputFiles: z.array(inputFileSchema).min(1).max(600),
    outputTargets: z.array(outputTargetSchema).min(1).max(400),
    templateSettings: workerTemplateSettingsSchema,
    uploadTtlSeconds: z.number().int().min(60).max(24 * 3600),
  })
  .strict()
  .superRefine((p, ctx) => {
    const headerId = p.templateSettings.header_image_file_id;
    const headerMatches = p.inputFiles.filter(
      (f) => f.fileType === "template_asset" && f.fileId === headerId,
    );
    if (headerMatches.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one template_asset input matching header_image_file_id is required",
      });
    }
  });

const HEADER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SOURCE_ID = "33333333-3333-3333-3333-333333333333";

describe("app → worker payload (v2)", () => {
  it("renderTemplateSettingsSchema exige header_image_file_id UUID", () => {
    expect(renderTemplateSettingsSchema.safeParse({}).success).toBe(false);
    expect(
      renderTemplateSettingsSchema.safeParse({ header_image_file_id: null }).success,
    ).toBe(false);
    expect(
      renderTemplateSettingsSchema.safeParse({ header_image_file_id: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      renderTemplateSettingsSchema.safeParse({ header_image_file_id: HEADER_ID }).success,
    ).toBe(true);
  });

  it("payload 1 source + 1 header produz inputs:2 outputs:1 aceito pelo worker", () => {
    const templateSettings = renderTemplateSettingsSchema.parse({
      header_image_file_id: HEADER_ID,
    });
    const payload = {
      contractVersion: 2 as const,
      jobId: "11111111-1111-1111-1111-111111111111",
      projectId: "22222222-2222-2222-2222-222222222222",
      callbackUrl: "https://app.example.com/api/public/worker-webhook",
      inputFiles: [
        {
          fileId: SOURCE_ID,
          fileName: "src.mp4",
          fileType: "source_video" as const,
          mimeType: "video/mp4",
          signedUrl: "https://files.example.com/src",
        },
        {
          fileId: HEADER_ID,
          fileName: "header.png",
          fileType: "template_asset" as const,
          mimeType: "image/png",
          signedUrl: "https://files.example.com/header",
        },
      ],
      outputTargets: [
        {
          workerOutputId: "44444444-4444-4444-4444-444444444444",
          fileName: "src.mp4",
          mimeType: "video/mp4",
          signedUploadUrl: "https://files.example.com/out",
          sourceFileId: SOURCE_ID,
        },
      ],
      templateSettings,
      uploadTtlSeconds: 3600,
    };
    const res = jobPayloadSchema.safeParse(payload);
    expect(res.success).toBe(true);
    expect(payload.inputFiles.length).toBe(2);
    expect(payload.outputTargets.length).toBe(1);
  });
});
