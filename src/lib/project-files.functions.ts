import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "./app-settings.functions";
import { extensionMatchesMime, sanitizeFileName } from "./project-schemas";

type SB = SupabaseClient<Database>;

function clientError(msg: string): Error {
  return new Error(msg);
}

const idSchema = z.object({ id: z.string().uuid() });
const projectIdSchema = z.object({ project_id: z.string().uuid() });

const fileTypeEnum = z.enum(["source_video", "logo", "template_asset"]);

const prepareUploadSchema = z.object({
  project_id: z.string().uuid(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(120),
  file_size: z.number().int().positive(),
  file_type: fileTypeEnum,
});

const BUCKETS = {
  source_video: "project-inputs",
  logo: "project-assets",
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
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : d;
  };
  return {
    max_files_per_project: num("max_files_per_project", DEFAULT_APP_SETTINGS.max_files_per_project),
    max_file_size_mb: num("max_file_size_mb", DEFAULT_APP_SETTINGS.max_file_size_mb),
    max_variations: num("max_variations", DEFAULT_APP_SETTINGS.max_variations),
    allowed_video_types: arr("allowed_video_types", DEFAULT_APP_SETTINGS.allowed_video_types),
    allowed_image_types: arr("allowed_image_types", DEFAULT_APP_SETTINGS.allowed_image_types),
  };
}

async function assertProjectOwner(supabase: SB, projectId: string): Promise<void> {
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
      .eq("status", "uploaded")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[listProjectFiles]", error);
      throw clientError("Não foi possível carregar os arquivos.");
    }
    return files ?? [];
  });

// ----- preparar upload: valida, cria linha pendente e signed upload URL -----
export const prepareProjectFileUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => prepareUploadSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertProjectOwner(context.supabase, data.project_id);

    const settings = await loadSettings(context.supabase);
    const maxBytes = settings.max_file_size_mb * 1024 * 1024;

    if (data.file_size > maxBytes) {
      throw clientError(`Arquivo maior que o limite de ${settings.max_file_size_mb} MB.`);
    }

    const allowedByType =
      data.file_type === "source_video"
        ? settings.allowed_video_types
        : settings.allowed_image_types;

    if (!allowedByType.includes(data.mime_type)) {
      throw clientError("Tipo de arquivo não permitido.");
    }

    const safeName = sanitizeFileName(data.file_name);
    if (!extensionMatchesMime(safeName, data.mime_type)) {
      throw clientError("A extensão não corresponde ao tipo do arquivo.");
    }

    // Limite de quantidade — só conta arquivos confirmados + pendentes ativos.
    const { count, error: countError } = await context.supabase
      .from("project_files")
      .select("id", { count: "exact", head: true })
      .eq("project_id", data.project_id)
      .in("status", ["uploaded", "pending"]);
    if (countError) {
      console.error("[prepareProjectFileUpload] count", countError);
      throw clientError("Erro ao validar limite de arquivos.");
    }
    if ((count ?? 0) >= settings.max_files_per_project) {
      throw clientError(`Limite de ${settings.max_files_per_project} arquivos atingido.`);
    }

    const bucket = BUCKETS[data.file_type];
    const fileId = crypto.randomUUID();
    const storagePath = `${context.userId}/${data.project_id}/${fileId}/${safeName}`;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Opportunistic cleanup: expira pendências vencidas antes de reservar nova.
    try {
      await supabaseAdmin.rpc("expire_pending_project_files");
    } catch (e) {
      console.warn("[prepareProjectFileUpload] expire cleanup skipped", e);
    }


    const UPLOAD_TTL_SECONDS = 60 * 15;
    const uploadExpiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString();

    // Cria linha pendente com metadata canônica derivada no servidor.
    const { error: insErr } = await supabaseAdmin.from("project_files").insert({
      id: fileId,
      project_id: data.project_id,
      user_id: context.userId,
      file_name: safeName,
      storage_path: storagePath,
      file_type: data.file_type,
      mime_type: data.mime_type,
      file_size: data.file_size,
      status: "pending",
      upload_expires_at: uploadExpiresAt,
    });
    if (insErr) {
      console.error("[prepareProjectFileUpload] insert pending", insErr);
      throw clientError("Não foi possível preparar o upload.");
    }

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUploadUrl(storagePath);

    if (signedError || !signed) {
      console.error("[prepareProjectFileUpload] signed", signedError);
      await supabaseAdmin.from("project_files").delete().eq("id", fileId);
      throw clientError("Não foi possível preparar o upload.");
    }

    return {
      file_id: fileId,
      bucket,
      storage_path: storagePath,
      safe_file_name: safeName,
      signed_url: signed.signedUrl,
      token: signed.token,
      upload_expires_at: uploadExpiresAt,
    };
  });


// ----- confirmar upload: valida objeto e transiciona pending → uploaded -----
const confirmSchema = z.object({
  file_id: z.string().uuid(),
});

export const confirmProjectFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => confirmSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Server-owned lookup: NEVER trust client-supplied metadata.
    const { data: row, error: findErr } = await context.supabase
      .from("project_files")
      .select(
        "id, project_id, storage_path, file_type, mime_type, file_size, status, user_id, upload_expires_at",
      )
      .eq("id", data.file_id)
      .maybeSingle();
    if (findErr || !row) throw clientError("Registro de upload não encontrado.");
    if (row.user_id !== context.userId) throw clientError("Registro de upload não encontrado.");
    if (row.status === "uploaded") return { id: row.id };
    if (row.status !== "pending") throw clientError("Upload em estado inválido.");

    // Expiração explícita: recusa e marca como expirado.
    if (row.upload_expires_at && new Date(row.upload_expires_at).getTime() < Date.now()) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("project_files")
        .update({ status: "expired" })
        .eq("id", row.id)
        .eq("status", "pending");
      throw clientError("Upload expirado. Envie o arquivo novamente.");
    }

    const bucket = BUCKETS[row.file_type as keyof typeof BUCKETS];
    if (!bucket) throw clientError("Tipo de arquivo desconhecido.");

    const parts = row.storage_path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const objectName = parts[parts.length - 1];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: listed, error: listError } = await supabaseAdmin.storage
      .from(bucket)
      .list(parentPath, { search: objectName });
    if (listError) {
      console.error("[confirmProjectFile] list", listError);
      throw clientError("Não foi possível confirmar o upload.");
    }
    const found = (listed ?? []).find((o) => o.name === objectName);
    if (!found) throw clientError("Upload não encontrado no armazenamento.");

    // Valida metadata real do objeto no Storage.
    const meta = (found.metadata ?? {}) as {
      size?: number;
      mimetype?: string;
    };
    const actualSize = typeof meta.size === "number" ? meta.size : 0;
    const actualMime = typeof meta.mimetype === "string" ? meta.mimetype : "";

    if (actualSize <= 0) {
      throw clientError("Upload vazio no armazenamento.");
    }
    if (actualSize !== row.file_size) {
      throw clientError("Tamanho do arquivo divergente do declarado.");
    }
    if (actualMime && actualMime !== row.mime_type) {
      throw clientError("Tipo do arquivo divergente do declarado.");
    }

    const { error: updErr } = await supabaseAdmin
      .from("project_files")
      .update({ status: "uploaded", upload_expires_at: null })
      .eq("id", row.id)
      .eq("status", "pending");
    if (updErr) {
      console.error("[confirmProjectFile] update", updErr);
      throw clientError("Não foi possível registrar o arquivo.");
    }
    return { id: row.id };
  });


// ----- excluir arquivo -----
export const deleteProjectFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => idSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: file, error: findError } = await context.supabase
      .from("project_files")
      .select("id, project_id, storage_path, file_type, user_id")
      .eq("id", data.id)
      .maybeSingle();

    if (findError) {
      console.error("[deleteProjectFile] find", findError);
      throw clientError("Não foi possível excluir o arquivo.");
    }
    if (!file) throw clientError("Arquivo não encontrado.");
    if (file.user_id !== context.userId) throw clientError("Arquivo não encontrado.");

    const bucket = BUCKETS[file.file_type as keyof typeof BUCKETS];
    if (!bucket) throw clientError("Tipo de arquivo desconhecido.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: rmError } = await supabaseAdmin.storage.from(bucket).remove([file.storage_path]);
    if (rmError) {
      console.error("[deleteProjectFile] storage", rmError);
      throw clientError("Falha ao excluir do armazenamento.");
    }

    const { error: delError } = await supabaseAdmin
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(file.storage_path, 60 * 15);
    if (sErr || !signed) throw clientError("Não foi possível gerar URL.");
    return { url: signed.signedUrl };
  });
