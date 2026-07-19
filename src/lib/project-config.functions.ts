import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  makeVariationSettingsSchema,
  templateSettingsSchema,
  RIGHTS_CONFIRMATION_VERSION,
} from "./project-schemas";
import { DEFAULT_APP_SETTINGS } from "./app-settings.functions";

function clientError(msg: string): Error {
  return new Error(msg);
}

const projectIdSchema = z.object({ project_id: z.string().uuid() });

const updateTemplateSchema = z.object({
  project_id: z.string().uuid(),
  template: templateSettingsSchema,
});

export const updateTemplateSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateTemplateSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("projects")
      .update({ template_settings: data.template })
      .eq("id", data.project_id);
    if (error) {
      console.error("[updateTemplateSettings]", error);
      throw clientError("Não foi possível salvar o template.");
    }
    return { ok: true };
  });

const updateVariationsSchema = z.object({
  project_id: z.string().uuid(),
  // O settings vem em formato bruto; validamos com base em app_settings.
  settings: z.unknown(),
});

export const updateVariationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateVariationsSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Busca max_variations do app_settings
    const { data: settingRow } = await context.supabase
      .from("app_settings")
      .select("value")
      .eq("key", "max_variations")
      .maybeSingle();
    const maxVariations =
      typeof settingRow?.value === "number" && settingRow.value > 0
        ? settingRow.value
        : DEFAULT_APP_SETTINGS.max_variations;

    const schema = makeVariationSettingsSchema(maxVariations);
    const parsed = schema.safeParse(data.settings);
    if (!parsed.success) {
      throw clientError(
        parsed.error.issues[0]?.message ?? "Configuração inválida.",
      );
    }

    const { error } = await context.supabase
      .from("projects")
      .update({
        variation_settings: parsed.data,
        variation_count: parsed.data.variation_count,
      })
      .eq("id", data.project_id);
    if (error) {
      console.error("[updateVariationSettings]", error);
      throw clientError("Não foi possível salvar as variações.");
    }
    return { ok: true };
  });

export const confirmProjectRights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Confirma propriedade
    const { data: project } = await context.supabase
      .from("projects")
      .select("id")
      .eq("id", data.project_id)
      .maybeSingle();
    if (!project) throw clientError("Projeto não encontrado.");

    // Existe confirmação atual? Se sim, no-op.
    const { data: existing } = await context.supabase
      .from("rights_confirmations")
      .select("id, rights_confirmed_at")
      .eq("project_id", data.project_id)
      .eq("confirmation_version", RIGHTS_CONFIRMATION_VERSION)
      .maybeSingle();
    if (existing) {
      return {
        rights_confirmed_at: existing.rights_confirmed_at,
        confirmation_version: RIGHTS_CONFIRMATION_VERSION,
      };
    }

    const { data: inserted, error } = await context.supabase
      .from("rights_confirmations")
      .insert({
        user_id: context.userId,
        project_id: data.project_id,
        confirmation_version: RIGHTS_CONFIRMATION_VERSION,
      })
      .select("rights_confirmed_at")
      .single();
    if (error || !inserted) {
      console.error("[confirmProjectRights]", error);
      throw clientError("Não foi possível registrar a confirmação.");
    }
    return {
      rights_confirmed_at: inserted.rights_confirmed_at,
      confirmation_version: RIGHTS_CONFIRMATION_VERSION,
    };
  });

export const getProjectRightsStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: confirmation } = await context.supabase
      .from("rights_confirmations")
      .select("rights_confirmed_at, confirmation_version")
      .eq("project_id", data.project_id)
      .eq("confirmation_version", RIGHTS_CONFIRMATION_VERSION)
      .maybeSingle();

    let last_file_change: string | null = null;
    if (confirmation) {
      const { data: files } = await context.supabase
        .from("project_files")
        .select("created_at")
        .eq("project_id", data.project_id)
        .order("created_at", { ascending: false })
        .limit(1);
      last_file_change = files?.[0]?.created_at ?? null;
    }

    const needs_reconfirmation =
      !!confirmation &&
      !!last_file_change &&
      new Date(last_file_change) > new Date(confirmation.rights_confirmed_at);

    return {
      confirmed: !!confirmation,
      rights_confirmed_at: confirmation?.rights_confirmed_at ?? null,
      confirmation_version: RIGHTS_CONFIRMATION_VERSION,
      needs_reconfirmation,
    };
  });
