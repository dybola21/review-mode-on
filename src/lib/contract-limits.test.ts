import { describe, expect, it } from "bun:test";
import { templateSettingsSchema, makeVariationSettingsSchema } from "./project-schemas";

// Canonical limits shared with the worker contract (worker/src/types/contract.ts).
// If either side changes, the paired tests here and in worker/tests/canonical-limits.test.ts
// must be updated together — no silent divergence.
const CANONICAL = {
  page_name_max: 80,
  identifier_max: 60,
  headline_max: 160,
  variation_count_max: 100,
} as const;

describe("frontend canonical contract limits", () => {
  it(`page_name accepts exactly ${CANONICAL.page_name_max} chars and rejects +1`, () => {
    expect(
      templateSettingsSchema.safeParse({ page_name: "a".repeat(CANONICAL.page_name_max) }).success,
    ).toBe(true);
    expect(
      templateSettingsSchema.safeParse({ page_name: "a".repeat(CANONICAL.page_name_max + 1) })
        .success,
    ).toBe(false);
  });

  it(`identifier accepts exactly ${CANONICAL.identifier_max} chars and rejects +1`, () => {
    expect(
      templateSettingsSchema.safeParse({ identifier: "a".repeat(CANONICAL.identifier_max) })
        .success,
    ).toBe(true);
    expect(
      templateSettingsSchema.safeParse({ identifier: "a".repeat(CANONICAL.identifier_max + 1) })
        .success,
    ).toBe(false);
  });

  it(`headline accepts exactly ${CANONICAL.headline_max} chars and rejects +1`, () => {
    expect(
      templateSettingsSchema.safeParse({ headline: "a".repeat(CANONICAL.headline_max) }).success,
    ).toBe(true);
    expect(
      templateSettingsSchema.safeParse({ headline: "a".repeat(CANONICAL.headline_max + 1) })
        .success,
    ).toBe(false);
  });

  it(`variation_count structural cap is ${CANONICAL.variation_count_max}`, () => {
    // makeVariationSettingsSchema clamps to Math.min(100, maxVariations).
    // Passing a very large maxVariations exposes the structural ceiling (100).
    const schema = makeVariationSettingsSchema(10_000);
    const base = {
      brightness: { min: 0, max: 0 },
      contrast: { min: 1, max: 1 },
      saturation: { min: 1, max: 1 },
      temperature: { min: 0, max: 0 },
      scale: { min: 1, max: 1 },
      watermark_position_jitter: false,
    };
    expect(
      schema.safeParse({ ...base, variation_count: CANONICAL.variation_count_max }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...base, variation_count: CANONICAL.variation_count_max + 1 }).success,
    ).toBe(false);
  });



  it("header_image_position_x/y default to 0.5 and are rejected outside 0..1", () => {
    const parsed = templateSettingsSchema.parse({});
    expect(parsed.header_image_position_x).toBe(0.5);
    expect(parsed.header_image_position_y).toBe(0.5);
    expect(templateSettingsSchema.safeParse({ header_image_position_x: -0.01 }).success).toBe(
      false,
    );
    expect(templateSettingsSchema.safeParse({ header_image_position_y: 1.01 }).success).toBe(false);
  });
});

