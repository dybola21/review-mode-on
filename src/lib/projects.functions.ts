import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const CLIENT_STATUSES = ["draft", "ready", "archived"] as const;

const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Nome obrigatório").max(120),
});

const updateProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  template_settings: z.record(z.string(), z.unknown()).optional(),
  variation_settings: z.record(z.string(), z.unknown()).optional(),
  variation_count: z.number().int().min(1).max(100).optional(),
});

const idSchema = z.object({ id: z.string().uuid() });

function toClientError(message: string): Error {
  return new Error(message);
}

export const listProjects = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("projects")
      .select(
        "id, name, status, variation_count, created_at, updated_at",
      )
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[listProjects]", error);
      throw toClientError("Não foi possível carregar seus projetos.");
    }
    return data ?? [];
  });

export const getProject = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => idSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: project, error } = await context.supabase
      .from("projects")
      .select(
        "id, name, status, template_settings, variation_settings, variation_count, created_at, updated_at",
      )
      .eq("id", data.id)
      .maybeSingle();

    if (error) {
      console.error("[getProject]", error);
      throw toClientError("Não foi possível carregar o projeto.");
    }
    if (!project) throw toClientError("Projeto não encontrado.");
    return project;
  });

export const createProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createProjectSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: project, error } = await context.supabase
      .from("projects")
      .insert({
        user_id: context.userId,
        name: data.name,
        status: "draft",
      })
      .select("id")
      .single();

    if (error || !project) {
      console.error("[createProject]", error);
      throw toClientError("Não foi possível criar o projeto.");
    }
    return { id: project.id };
  });

export const updateProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateProjectSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { id, ...rest } = data;
    // Allowlist: nunca deixe o cliente enviar user_id ou statuses de servidor.
    const patch: Record<string, unknown> = {};
    if (rest.name !== undefined) patch.name = rest.name;
    if (rest.status !== undefined) patch.status = rest.status;
    if (rest.template_settings !== undefined)
      patch.template_settings = rest.template_settings;
    if (rest.variation_settings !== undefined)
      patch.variation_settings = rest.variation_settings;
    if (rest.variation_count !== undefined)
      patch.variation_count = rest.variation_count;

    if (Object.keys(patch).length === 0) {
      throw toClientError("Nada para atualizar.");
    }

    const { error } = await context.supabase
      .from("projects")
      .update(patch)
      .eq("id", id);

    if (error) {
      console.error("[updateProject]", error);
      throw toClientError("Não foi possível atualizar o projeto.");
    }
    return { ok: true };
  });

export const archiveProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => idSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("projects")
      .update({ status: "archived" })
      .eq("id", data.id);
    if (error) {
      console.error("[archiveProject]", error);
      throw toClientError("Não foi possível arquivar o projeto.");
    }
    return { ok: true };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => idSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("projects")
      .delete()
      .eq("id", data.id);
    if (error) {
      console.error("[deleteProject]", error);
      throw toClientError("Não foi possível excluir o projeto.");
    }
    return { ok: true };
  });
