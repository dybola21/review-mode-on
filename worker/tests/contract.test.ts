import { describe, it, expect } from "vitest";
import { jobPayloadSchema } from "../src/types/contract.js";

const base = {
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
  ],
  outputTargets: [
    {
      workerOutputId: "44444444-4444-4444-4444-444444444444",
      fileName: "src_v1.mp4",
      mimeType: "video/mp4",
      signedUploadUrl: "https://files.example.com/out",
    },
  ],
  templateSettings: {
    page_name: "",
    identifier: "",
    headline: "",
    logo_file_id: null,
    background_color: "#0F0F12",
    text_color: "#FFFFFF",
    accent_color: "#FF5A1F",
    watermark_position: "bottom-right" as const,
    watermark_opacity: 0.6,
    header_height_ratio: 0.12,
  },
  variationSettings: {
    brightness: { min: -0.05, max: 0.05 },
    contrast: { min: 0.95, max: 1.05 },
    saturation: { min: 0.95, max: 1.05 },
    temperature: { min: -5, max: 5 },
    scale: { min: 1.0, max: 1.03 },
    watermark_position_jitter: false,
    variation_count: 3,
  },
  variationCount: 3,
  uploadTtlSeconds: 3600,
};

describe("jobPayloadSchema", () => {
  it("accepts a valid payload", () => {
    expect(jobPayloadSchema.safeParse(base).success).toBe(true);
  });
  it("rejects unknown top-level fields (no storagePath leakage)", () => {
    const bad = { ...base, storagePath: "user/proj/xyz" };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects invalid fileType", () => {
    const bad = {
      ...base,
      inputFiles: [{ ...base.inputFiles[0]!, fileType: "malware" }],
    };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("caps outputTargets length", () => {
    const many = Array.from({ length: 401 }, (_, i) => ({
      ...base.outputTargets[0]!,
      workerOutputId: `44444444-4444-4444-4444-${String(i).padStart(12, "0")}`,
    }));
    const bad = { ...base, outputTargets: many };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects non-url signedUrl", () => {
    const bad = { ...base, inputFiles: [{ ...base.inputFiles[0]!, signedUrl: "not a url" }] };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects mismatched variationCount vs variationSettings.variation_count", () => {
    const bad = { ...base, variationCount: 2 };
    expect(jobPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("enforces canonical string limits (identifier<=60, headline<=160, page_name<=80)", () => {
    const overIdent = {
      ...base,
      templateSettings: { ...base.templateSettings, identifier: "a".repeat(61) },
    };
    expect(jobPayloadSchema.safeParse(overIdent).success).toBe(false);
    const overHead = {
      ...base,
      templateSettings: { ...base.templateSettings, headline: "b".repeat(161) },
    };
    expect(jobPayloadSchema.safeParse(overHead).success).toBe(false);
    const overPage = {
      ...base,
      templateSettings: { ...base.templateSettings, page_name: "c".repeat(81) },
    };
    expect(jobPayloadSchema.safeParse(overPage).success).toBe(false);
  });
  it("accepts variation_count up to 100", () => {
    const ok = {
      ...base,
      variationSettings: { ...base.variationSettings, variation_count: 100 },
      variationCount: 100,
    };
    expect(jobPayloadSchema.safeParse(ok).success).toBe(true);
  });
});
