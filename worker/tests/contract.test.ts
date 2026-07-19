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
  templateSettings: {},
  variationSettings: {},
  variationCount: 1,
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
});
