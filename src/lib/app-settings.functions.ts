import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AppSettings = {
  max_files_per_project: number;
  max_file_size_mb: number;
  max_variations: number;
  allowed_video_types: string[];
  allowed_image_types: string[];
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  max_files_per_project: 20,
  max_file_size_mb: 200,
  max_variations: 20,
  allowed_video_types: ["video/mp4", "video/quicktime", "video/webm"],
  allowed_image_types: ["image/png", "image/jpeg", "image/webp"],
};

const numberSchema = z.number().finite().positive();
const stringArraySchema = z.array(z.string().min(1).max(120)).min(1).max(50);

function parseValue<T>(
  raw: unknown,
  fallback: T,
  parser: (v: unknown) => T,
): T {
  try {
    return parser(raw);
  } catch {
    return fallback;
  }
}

export const getAppSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AppSettings> => {
    const { data, error } = await context.supabase
      .from("app_settings")
      .select("key, value");

    if (error) {
      console.error("[getAppSettings]", error);
      return DEFAULT_APP_SETTINGS;
    }
    const map = new Map<string, unknown>();
    for (const row of data ?? []) map.set(row.key, row.value);

    return {
      max_files_per_project: parseValue(
        map.get("max_files_per_project"),
        DEFAULT_APP_SETTINGS.max_files_per_project,
        (v) => numberSchema.parse(v),
      ),
      max_file_size_mb: parseValue(
        map.get("max_file_size_mb"),
        DEFAULT_APP_SETTINGS.max_file_size_mb,
        (v) => numberSchema.parse(v),
      ),
      max_variations: parseValue(
        map.get("max_variations"),
        DEFAULT_APP_SETTINGS.max_variations,
        (v) => numberSchema.parse(v),
      ),
      allowed_video_types: parseValue(
        map.get("allowed_video_types"),
        DEFAULT_APP_SETTINGS.allowed_video_types,
        (v) => stringArraySchema.parse(v),
      ),
      allowed_image_types: parseValue(
        map.get("allowed_image_types"),
        DEFAULT_APP_SETTINGS.allowed_image_types,
        (v) => stringArraySchema.parse(v),
      ),
    };
  });
