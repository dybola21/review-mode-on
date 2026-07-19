import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "./app-settings.functions";
import { extensionMatchesMime, sanitizeFileName } from "./project-schemas";

type SB = SupabaseClient<Database>;


function clientError(msg: string): Error {
  return new Error(msg);
}

const idSchema = z.object({ id: z.string().uuid() });
const projectIdSchema = z.object({ project_id: z.string().uuid() });

const fileTypeEnum = z.enum([
  "source_video",
  "logo",
  "music",
  "template_asset",
]);

const prepareUploadSchema = z.object({
  project_id: z.string().uuid(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(120),
  file_size: z.number().int().positive(),
  file_type: fileTypeEnum,
});

const confirmUploadSchema = z.object({
  id: z.string().uuid(),
  duration_seconds: z.number().finite().min(0).max(60 * 60 * 6).optional(),
});

const BUCKETS = {
  source_video: "project-inputs",
  logo: "project-assets",
  music: "project-assets",
  template_asset: "project-assets",
} as const;

async function loadSettings(supabase: SB): Promise<AppSettings> {
  const { data } = await supabase.from("app_settings").select("key, value");
  const map = new Map<string, unknown>();
  for (const r of data ?? []) map.set(r.key, r.value);
  const num = (k: keyof AppSettings, d: number) => {
    const v = map.get(k);
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
  };
  const arr = (k: keyof AppSettings, d: string[]) => {
    const v = map.get(k);
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : d;
  };
  return {
    max_files_per_project: num(
      "max_files_per_project",
      DEFAULT_APP_SETTINGS.max_files_per_project,
    ),
    max_file_size_mb: num(
      "max_file_size_mb",
      DEFAULT_APP_SETTINGS.max_file_size_mb,
    ),
    max_variations: num("max_variations", DEFAULT_APP_SETTINGS.max_variations),
    allowed_video_types: arr(
      "allowed_video_types",
      DEFAULT_APP_SETTINGS.allowed_video_types,
    ),
    allowed_image_types: arr(
      "allowed_image_types",
      DEFAULT_APP_SETTINGS.allowed_image_types,
    ),
  };
}

async function assertProjectOwner(
  supabase: SB,
  projectId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) throw clientError("Projeto não encontrado.");
}


// ----- listar arquivos -----
export const listProjectFiles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertProjectOwner(context.supabase, data.project_id);
    const { data: files, error } = await context.supabase
      .from("project_files")
      .select(
        "id, file_name, storage_path, file_type, mime_type, file_size, duration_seconds, status, created_at",
      )
      .eq("project_id", data.project_id)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[listProjectFiles]", error);
      throw clientError("Não foi possível carregar os arquivos.");
    }
    return files ?? [];
  });

// ----- preparar upload: valida e cria signed upload URL -----
export const prepareProjectFileUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => prepareUploadSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertProjectOwner(context.supabase, data.project_id);

    const settings = await loadSettings(context.supabase);
    const maxBytes = settings.max_file_size_mb * 1024 * 1024;

    if (data.file_size > maxBytes) {
      throw clientError(
        `Arquivo maior que o limite de ${settings.max_file_size_mb} MB.`,
      );
    }

    const allowedByType =
      data.file_type === "source_video"
        ? settings.allowed_video_types
        : data.file_type === "logo" || data.file_type === "template_asset"
        ? settings.allowed_image_types
        : ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm"];

    if (!allowedByType.includes(data.mime_type)) {
      throw clientError("Tipo de arquivo não permitido.");
    }

    const safeName = sanitizeFileName(data.file_name);

    if (
      (data.file_type === "source_video" ||
        data.file_type === "logo" ||
        data.file_type === "template_asset") &&
      !extensionMatchesMime(safeName, data.mime_type)
    ) {
      throw clientError("A extensão não corresponde ao tipo do arquivo.");
    }

    // Limite de quantidade
    const { count, error: countError } = await context.supabase
      .from("project_files")
      .select("id", { count: "exact", head: true })
      .eq("project_id", data.project_id);
    if (countError) {
      console.error("[prepareProjectFileUpload] count", countError);
      throw clientError("Erro ao validar limite de arquivos.");
    }
    if ((count ?? 0) >= settings.max_files_per_project) {
      throw clientError(
        `Limite de ${settings.max_files_per_project} arquivos atingido.`,
      );
    }

    const bucket = BUCKETS[data.file_type];
    const fileId = crypto.randomUUID();
    const storagePath = `${context.userId}/${data.project_id}/${fileId}/${safeName}`;

    // Insere registro placeholder em project_files com status 'uploaded' → false
    // Só criaremos o registro após o upload confirmado (via confirmProjectFile).
    // Aqui, geramos apenas uma signed upload URL.
    const { data: signed, error: signedError } = await context.supabase.storage
      .from(bucket)
      .createSignedUploadUrl(storagePath);

    if (signedError || !signed) {
      console.error("[prepareProjectFileUpload] signed", signedError);
      throw clientError("Não foi possível preparar o upload.");
    }

    return {
      file_id: fileId,
      bucket,
      storage_path: storagePath,
      safe_file_name: safeName,
      signed_url: signed.signedUrl,
      token: signed.token,
    };
  });

// ----- confirmar upload: valida objeto e cria registro -----
const confirmSchema = z.object({
  project_id: z.string().uuid(),
  file_id: z.string().uuid(),
  file_name: z.string().max(255),
  storage_path: z.string().max(500),
  bucket: z.enum(["project-inputs", "project-assets"]),
  file_type: fileTypeEnum,
  mime_type: z.string().max(120),
  file_size: z.number().int().positive(),
});

export const confirmProjectFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => confirmSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertProjectOwner(context.supabase, data.project_id);

    // Confere que o path começa com userId/projectId/fileId/
    const expectedPrefix = `${context.userId}/${data.project_id}/${data.file_id}/`;
    if (!data.storage_path.startsWith(expectedPrefix)) {
      throw clientError("Caminho de armazenamento inválido.");
    }

    // Verifica se o objeto realmente existe no Storage do usuário
    const parts = data.storage_path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const objectName = parts[parts.length - 1];
    const { data: listed, error: listError } = await context.supabase.storage
      .from(data.bucket)
      .list(parentPath, { search: objectName });
    if (listError) {
      console.error("[confirmProjectFile] list", listError);
      throw clientError("Não foi possível confirmar o upload.");
    }
    const found = (listed ?? []).find((o) => o.name === objectName);
    if (!found) {
      throw clientError("Upload não encontrado no armazenamento.");
    }

    const { data: inserted, error } = await context.supabase
      .from("project_files")
      .insert({
        project_id: data.project_id,
        user_id: context.userId,
        file_name: data.file_name,
        storage_path: data.storage_path,
        file_type: data.file_type,
        mime_type: data.mime_type,
        file_size: data.file_size,
        status: "uploaded",
      })
      .select("id")
      .single();

    if (error || !inserted) {
      console.error("[confirmProjectFile] insert", error);
      // Rollback: tenta apagar o arquivo órfão
      await context.supabase.storage
        .from(data.bucket)
        .remove([data.storage_path]);
      throw clientError("Não foi possível registrar o arquivo.");
    }

    return { id: inserted.id };
  });

// ----- atualizar duração/status opcional -----
export const updateProjectFileMeta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => confirmUploadSchema.parse(data))
  .handler(async ({ data, context }) => {
    const patch: { duration_seconds?: number } = {};
    if (data.duration_seconds !== undefined)
      patch.duration_seconds = data.duration_seconds;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await context.supabase
      .from("project_files")
      .update(patch)
      .eq("id", data.id);
    if (error) console.error("[updateProjectFileMeta]", error);
    return { ok: true };
  });

// ----- excluir arquivo -----
export const deleteProjectFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => idSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: file, error: findError } = await context.supabase
      .from("project_files")
      .select("id, project_id, storage_path, file_type")
      .eq("id", data.id)
      .maybeSingle();

    if (findError) {
      console.error("[deleteProjectFile] find", findError);
      throw clientError("Não foi possível excluir o arquivo.");
    }
    if (!file) throw clientError("Arquivo não encontrado.");

    const bucket = BUCKETS[file.file_type as keyof typeof BUCKETS];
    if (!bucket) throw clientError("Tipo de arquivo desconhecido.");

    const { error: rmError } = await context.supabase.storage
      .from(bucket)
      .remove([file.storage_path]);
    if (rmError) {
      console.error("[deleteProjectFile] storage", rmError);
      throw clientError("Falha ao excluir do armazenamento.");
    }

    const { error: delError } = await context.supabase
      .from("project_files")
      .delete()
      .eq("id", data.id);
    if (delError) {
      console.error("[deleteProjectFile] db", delError);
      throw clientError(
        "Arquivo removido do armazenamento, mas o registro persiste. Tente novamente.",
      );
    }

    return { ok: true };
  });

// ----- signed URL para exibir preview de logo/imagem -----
const previewSchema = z.object({ id: z.string().uuid() });

export const getProjectFilePreviewUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => previewSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: file, error } = await context.supabase
      .from("project_files")
      .select("storage_path, file_type")
      .eq("id", data.id)
      .maybeSingle();
    if (error || !file) throw clientError("Arquivo não encontrado.");
    const bucket = BUCKETS[file.file_type as keyof typeof BUCKETS];
    const { data: signed, error: sErr } = await context.supabase.storage
      .from(bucket)
      .createSignedUrl(file.storage_path, 60 * 15);
    if (sErr || !signed) throw clientError("Não foi possível gerar URL.");
    return { url: signed.signedUrl };
  });
