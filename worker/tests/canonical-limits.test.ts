import { describe, it, expect } from "vitest";
import { templateSettingsSchema } from "../src/types/contract.js";

// Canonical limits shared with the frontend contract (src/lib/project-schemas.ts).
// If these diverge, both this test and the sibling frontend test must be updated together.
const CANONICAL = {
  page_name_max: 80,
  identifier_max: 60,
  headline_max: 160,
} as const;

const validTemplate = {
  header_image_file_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
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
};

describe("worker canonical contract limits", () => {
  it(`page_name accepts exactly ${CANONICAL.page_name_max} chars and rejects +1`, () => {
    expect(
      templateSettingsSchema.safeParse({
        ...validTemplate,
        page_name: "a".repeat(CANONICAL.page_name_max),
      }).success,
    ).toBe(true);
    expect(
      templateSettingsSchema.safeParse({
        ...validTemplate,
        page_name: "a".repeat(CANONICAL.page_name_max + 1),
      }).success,
    ).toBe(false);
  });

  it(`identifier accepts exactly ${CANONICAL.identifier_max} chars and rejects +1`, () => {
    expect(
      templateSettingsSchema.safeParse({
        ...validTemplate,
        identifier: "a".repeat(CANONICAL.identifier_max),
      }).success,
    ).toBe(true);
    expect(
      templateSettingsSchema.safeParse({
        ...validTemplate,
        identifier: "a".repeat(CANONICAL.identifier_max + 1),
      }).success,
    ).toBe(false);
  });

  it(`headline accepts exactly ${CANONICAL.headline_max} chars and rejects +1`, () => {
    expect(
      templateSettingsSchema.safeParse({
        ...validTemplate,
        headline: "a".repeat(CANONICAL.headline_max),
      }).success,
    ).toBe(true);
    expect(
      templateSettingsSchema.safeParse({
        ...validTemplate,
        headline: "a".repeat(CANONICAL.headline_max + 1),
      }).success,
    ).toBe(false);
  });

  it("header_image_position_x/y default to 0.5 and are rejected outside 0..1", () => {
    const parsed = templateSettingsSchema.parse(validTemplate);
    expect(parsed.header_image_position_x).toBe(0.5);
    expect(parsed.header_image_position_y).toBe(0.5);
    expect(
      templateSettingsSchema.safeParse({ ...validTemplate, header_image_position_x: -0.1 }).success,
    ).toBe(false);
    expect(
      templateSettingsSchema.safeParse({ ...validTemplate, header_image_position_y: 1.1 }).success,
    ).toBe(false);
  });
});
