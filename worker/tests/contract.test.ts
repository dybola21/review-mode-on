import { describe, it, expect } from "vitest";
import { CONTRACT_VERSION, jobPayloadSchema } from "../src/types/contract.js";

const HEADER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const base = {
  contractVersion: CONTRACT_VERSION,
  jobId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  callbackUrl: "https://app.example.com/api/public/worker-webhook",
  inputFiles: [
    {
      fileId: "33333333-3333-3333-3333-333333333333",
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
      sourceFileId: "33333333-3333-3333-3333-333333333333",
    },
  ],
  templateSettings: {
    header_image_file_id: HEADER_ID,
    page_name: "",
    identifier: "",
    headline: "",
    logo_file_id: null,
    background_color: "#0F0F12",
    text_color: "#FFFFFF",
    accent_color: "#FF5A1F",
    watermark_position: "bottom-right" as const,
    watermark_opacity: 0.6,
    header_height_ratio: 0.335,
  },
  uploadTtlSeconds: 3600,
};

describe("jobPayloadSchema (v2)", () => {
  it("accepts a valid v2 payload", () => {
    expect(jobPayloadSchema.safeParse(base).success).toBe(true);
  });

  it("rejects payloads without contractVersion=2", () => {
    const badV1 = { ...base, contractVersion: 1 };
    expect(jobPayloadSchema.safeParse(badV1).success).toBe(false);
    const missing = { ...base } as Record<string, unknown>;
    delete missing.contractVersion;
    expect(jobPayloadSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects unknown top-level fields (no variationSettings leakage)", () => {
    const bad = { ...base, variationSettings: {} };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
    const bad2 = { ...base, variationCount: 3 };
    expect(jobPayloadSchema.safeParse(bad2).success).toBe(false);
  });

  it("rejects when outputTargets.length !== number of source_video inputs", () => {
    const bad = {
      ...base,
      inputFiles: [
        base.inputFiles[0]!,
        {
          fileId: "55555555-5555-5555-5555-555555555555",
          fileName: "src2.mp4",
          fileType: "source_video" as const,
          mimeType: "video/mp4",
          signedUrl: "https://files.example.com/src2",
        },
      ],
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when an outputTarget.sourceFileId does not match any input", () => {
    const bad = {
      ...base,
      outputTargets: [
        {
          ...base.outputTargets[0]!,
          sourceFileId: "99999999-9999-9999-9999-999999999999",
        },
      ],
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate sourceFileId across outputs (each source maps to exactly one output)", () => {
    const bad = {
      ...base,
      inputFiles: [
        base.inputFiles[0]!,
        {
          fileId: "66666666-6666-6666-6666-666666666666",
          fileName: "src2.mp4",
          fileType: "source_video" as const,
          mimeType: "video/mp4",
          signedUrl: "https://files.example.com/src2",
        },
      ],
      outputTargets: [
        base.outputTargets[0]!,
        {
          ...base.outputTargets[0]!,
          workerOutputId: "77777777-7777-7777-7777-777777777777",
          sourceFileId: base.outputTargets[0]!.sourceFileId, // duplicate
        },
      ],
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("v2 accepts 1 header art + 1 video with inputs:2 outputs:1", () => {
    const res = jobPayloadSchema.safeParse(base);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.inputFiles.length).toBe(2);
      expect(res.data.outputTargets.length).toBe(1);
      const templateAssets = res.data.inputFiles.filter((f) => f.fileType === "template_asset");
      expect(templateAssets.length).toBe(1);
      expect(templateAssets[0]!.fileId).toBe(res.data.templateSettings.header_image_file_id);
    }
  });

  it("rejects when header_image_file_id is missing", () => {
    const bad = {
      ...base,
      templateSettings: { ...base.templateSettings, header_image_file_id: undefined },
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when no template_asset input matches header_image_file_id", () => {
    const bad = {
      ...base,
      // Keep only the source_video — drop the header template_asset input.
      inputFiles: [base.inputFiles[0]!],
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when template_asset input exists but header_image_file_id points elsewhere", () => {
    const bad = {
      ...base,
      templateSettings: {
        ...base.templateSettings,
        header_image_file_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      },
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts 1 header art + 5 sources -> 5 outputs", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      fileId: `88888888-8888-8888-8888-${String(i).padStart(12, "0")}`,
      fileName: `src${i}.mp4`,
      fileType: "source_video" as const,
      mimeType: "video/mp4",
      signedUrl: `https://files.example.com/src${i}`,
    }));
    const header = {
      fileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      fileName: "header.png",
      fileType: "template_asset" as const,
      mimeType: "image/png",
      signedUrl: "https://files.example.com/header",
    };
    const targets = sources.map((s, i) => ({
      workerOutputId: `99999999-9999-9999-9999-${String(i).padStart(12, "0")}`,
      fileName: s.fileName,
      mimeType: "video/mp4",
      signedUploadUrl: `https://files.example.com/out${i}`,
      sourceFileId: s.fileId,
    }));
    const ok = {
      ...base,
      inputFiles: [header, ...sources],
      outputTargets: targets,
      templateSettings: { ...base.templateSettings, header_image_file_id: header.fileId },
    };
    expect(jobPayloadSchema.safeParse(ok).success).toBe(true);
  });

  it("caps outputTargets length at 400", () => {
    const sources = Array.from({ length: 401 }, (_, i) => ({
      fileId: `88888888-8888-8888-8888-${String(i).padStart(12, "0")}`,
      fileName: `src${i}.mp4`,
      fileType: "source_video" as const,
      mimeType: "video/mp4",
      signedUrl: `https://files.example.com/src${i}`,
    }));
    const header = {
      fileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      fileName: "header.png",
      fileType: "template_asset" as const,
      mimeType: "image/png",
      signedUrl: "https://files.example.com/header",
    };
    const targets = sources.map((s, i) => ({
      workerOutputId: `99999999-9999-9999-9999-${String(i).padStart(12, "0")}`,
      fileName: s.fileName,
      mimeType: "video/mp4",
      signedUploadUrl: `https://files.example.com/out${i}`,
      sourceFileId: s.fileId,
    }));
    const bad = {
      ...base,
      inputFiles: [header, ...sources],
      outputTargets: targets,
      templateSettings: { ...base.templateSettings, header_image_file_id: header.fileId },
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });
});
