import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { RIGHTS_CONFIRMATION_VERSION } from "./project-schemas";
import {
  buildOutputStoragePath,
  computeMaxOutputs,
  normalizePublicAppUrl,
  sanitizeBaseName,
} from "./render-security";

function clientError(msg: string): Error {
  return new Error(msg);
}

const ACTIVE_STATUSES = ["queued", "submitting", "processing"] as const;
const SIGNED_INPUT_TTL_SECONDS = 60 * 60; // 1h
const SIGNED_UPLOAD_TTL_SECONDS = 60 * 60 * 2; // 2h — Supabase default upper bound
const SIGNED_DOWNLOAD_TTL_SECONDS = 60 * 10; // 10min
const HARD_MAX_OUTPUTS = 400;

function safeErrorMessage(fallback: string, err: unknown): string {
  console.error(fallback, err);
  return fallback;
}

function isProduction(): boolean {
  return (
    (process.env.NODE_ENV ?? "development") === "production" || process.env.APP_ENV === "production"
  );
}

/**
 * Returns the trusted public base URL for building the webhook callback.
 * In production: PUBLIC_APP_URL is REQUIRED and validated.
 * In dev: falls back to the request's forwarded host.
 */
function getPublicBaseUrl(): string | null {
  const normalized = normalizePublicAppUrl(process.env.PUBLIC_APP_URL);
  if (normalized) return normalized;
  if (isProduction()) return null;
  try {
    const req = getRequest();
    const host = req?.headers.get("x-forwarded-host") ?? req?.headers.get("host");
    if (!host) return null;
    const proto = req?.headers.get("x-forwarded-proto") ?? "http";
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------
export const checkWorkerHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const url = process.env.VIDEO_WORKER_URL;
    if (!url) {
      return {
        configured: false,
        available: false,
        checkedAt: new Date().toISOString(),
        message: "Servidor de processamento não configurado.",
      };
    }
    if (isProduction() && !normalizePublicAppUrl(process.env.PUBLIC_APP_URL)) {
      return {
        configured: false,
        available: false,
        checkedAt: new Date().toISOString(),
        message: "PUBLIC_APP_URL é obrigatória em produção.",
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          configured: true,
          available: false,
          checkedAt: new Date().toISOString(),
          message: "Servidor temporariamente indisponível.",
        };
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const ok =
        !!body &&
        typeof body === "object" &&
        ("status" in body
          ? (body as { status?: string }).status === "ok"
          : "ok" in body
            ? (body as { ok?: boolean }).ok === true
            : true);
      return {
        configured: true,
        available: ok,
        checkedAt: new Date().toISOString(),
        message: ok ? "Servidor disponível." : "Resposta inesperada do servidor.",
      };
    } catch (err) {
      clearTimeout(timer);
      console.error("[checkWorkerHealth]", err);
      return {
        configured: true,
        available: false,
        checkedAt: new Date().toISOString(),
        message: "Servidor temporariamente indisponível.",
      };
    }
  });

// -----------------------------------------------------------------------
// Reads (RLS scoped)
// -----------------------------------------------------------------------
const projectIdSchema = z.object({ project_id: z.string().uuid() });

export const getLatestRenderJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("render_jobs")
      .select(
        "id, status, progress, attempt_count, error_code, error_message, started_at, completed_at, created_at, updated_at",
      )
      .eq("project_id", data.project_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      throw clientError(safeErrorMessage("Não foi possível carregar o status.", error));
    }
    return rows?.[0] ?? null;
  });

export const listRenderOutputs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("render_outputs")
      .select("id, render_job_id, file_name, file_size, mime_type, created_at, expires_at")
      .eq("project_id", data.project_id)
      .order("created_at", { ascending: false });
    if (error) {
      throw clientError(safeErrorMessage("Não foi possível carregar os resultados.", error));
    }
    return rows ?? [];
  });

// -----------------------------------------------------------------------
// Signed download URL for a single output
// -----------------------------------------------------------------------
const outputIdSchema = z.object({ output_id: z.string().uuid() });

export const getSignedDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => outputIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("render_outputs")
      .select("storage_path, expires_at, file_name")
      .eq("id", data.output_id)
      .maybeSingle();
    if (error || !row) throw clientError("Resultado indisponível ou expirado.");
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      throw clientError("Resultado indisponível ou expirado.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from("render-outputs")
      .createSignedUrl(row.storage_path, SIGNED_DOWNLOAD_TTL_SECONDS, {
        download: row.file_name,
      });
    if (sErr || !signed) {
      throw clientError(safeErrorMessage("Resultado indisponível ou expirado.", sErr));
    }
    return { url: signed.signedUrl };
  });

// -----------------------------------------------------------------------
// Submit render job
// -----------------------------------------------------------------------
export const submitRenderJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const workerUrl = process.env.VIDEO_WORKER_URL;
    const workerKey = process.env.VIDEO_WORKER_API_KEY;
    if (!workerUrl || !workerKey) {
      throw clientError("Servidor de processamento não configurado.");
    }

    // Callback URL FIRST — hard fail in prod if PUBLIC_APP_URL missing.
    if (isProduction() && !normalizePublicAppUrl(process.env.PUBLIC_APP_URL)) {
      throw clientError("PUBLIC_APP_URL não configurada — processamento indisponível.");
    }
    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
      throw clientError("URL pública não configurada.");
    }
    const callbackUrl = `${baseUrl}/api/public/worker-webhook`;

    // 1) Project
    const { data: project, error: projectErr } = await context.supabase
      .from("projects")
      .select("id, status, template_settings, variation_settings, variation_count")
      .eq("id", data.project_id)
      .maybeSingle();
    if (projectErr || !project) throw clientError("Projeto não encontrado.");

    // 2) Source files
    const { data: files, error: filesErr } = await context.supabase
      .from("project_files")
      .select("id, file_name, storage_path, mime_type, file_type")
      .eq("project_id", data.project_id)
      .eq("file_type", "source_video");
    if (filesErr) throw clientError("Falha ao ler arquivos do projeto.");
    if (!files || files.length === 0) {
      throw clientError("Envie pelo menos um vídeo antes de processar.");
    }

    // 2b) Assets referenced by the template (logo only for MVP). Never sent
    //     if not referenced — server derives file_type from project_files.
    const templateSettings = (project.template_settings ?? {}) as {
      logo_file_id?: string | null;
    };
    const referencedAssetIds = new Set<string>();
    if (templateSettings.logo_file_id) referencedAssetIds.add(templateSettings.logo_file_id);

    let assetFiles: Array<{
      id: string;
      file_name: string;
      storage_path: string;
      mime_type: string;
      file_type: string;
    }> = [];
    if (referencedAssetIds.size > 0) {
      const { data: assets, error: aErr } = await context.supabase
        .from("project_files")
        .select("id, file_name, storage_path, mime_type, file_type")
        .eq("project_id", data.project_id)
        .in("id", Array.from(referencedAssetIds));
      if (aErr) throw clientError("Falha ao ler arquivos do projeto.");
      assetFiles = assets ?? [];
      for (const id of referencedAssetIds) {
        if (!assetFiles.find((a) => a.id === id)) {
          throw clientError("Asset referenciado pelo template não encontrado.");
        }
      }
    }

    // 3) Rights
    const { data: rights } = await context.supabase
      .from("rights_confirmations")
      .select("rights_confirmed_at")
      .eq("project_id", data.project_id)
      .eq("confirmation_version", RIGHTS_CONFIRMATION_VERSION)
      .maybeSingle();
    if (!rights) {
      throw clientError("Confirme os direitos sobre os arquivos primeiro.");
    }
    const { data: latestFile } = await context.supabase
      .from("project_files")
      .select("created_at")
      .eq("project_id", data.project_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (
      latestFile?.[0] &&
      new Date(latestFile[0].created_at) > new Date(rights.rights_confirmed_at)
    ) {
      throw clientError("Reconfirme os direitos: novos arquivos foram adicionados.");
    }

    // 4) Active job?
    const { data: active } = await context.supabase
      .from("render_jobs")
      .select("id")
      .eq("project_id", data.project_id)
      .in("status", ACTIVE_STATUSES as unknown as string[])
      .limit(1);
    if (active && active.length > 0) {
      throw clientError("Já existe um processamento em andamento.");
    }

    // 5) Compute expected outputs
    const variationCount = Math.max(1, Number(project.variation_count) || 1);
    const totalOutputs = computeMaxOutputs(files.length, variationCount, HARD_MAX_OUTPUTS);
    if (totalOutputs === 0) {
      throw clientError("Nada a processar.");
    }
    if (totalOutputs >= HARD_MAX_OUTPUTS) {
      throw clientError("Combinação de arquivos e variações excede o limite permitido.");
    }

    // 6) Create job
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let jobId: string;
    try {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("render_jobs")
        .insert({
          project_id: data.project_id,
          user_id: context.userId,
          status: "submitting",
          progress: 0,
        })
        .select("id")
        .single();
      if (createErr || !created) throw new Error("insert failed");
      jobId = created.id;
    } catch (err) {
      console.error("[submitRenderJob] insert", err);
      throw clientError("Não foi possível iniciar o processamento.");
    }

    const failJob = async (code: string, msg: string) => {
      await supabaseAdmin
        .from("render_jobs")
        .update({
          status: "failed",
          error_code: code,
          error_message: msg,
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    };

    // 7) Pre-create output targets (server-owned paths & IDs)
    type Target = {
      workerOutputId: string;
      fileName: string;
      storagePath: string;
      mimeType: string;
      sourceFileId: string;
      variationIndex: number;
    };
    const targets: Target[] = [];
    try {
      for (const f of files) {
        const base = sanitizeBaseName((f.file_name ?? "video").replace(/\.[^.]+$/, ""));
        for (let v = 1; v <= variationCount; v++) {
          const workerOutputId = crypto.randomUUID();
          const storagePath = buildOutputStoragePath({
            userId: context.userId,
            projectId: data.project_id,
            jobId,
            workerOutputId,
            extension: "mp4",
          });
          targets.push({
            workerOutputId,
            fileName: `${base}_v${v}.mp4`,
            storagePath,
            mimeType: "video/mp4",
            sourceFileId: f.id,
            variationIndex: v,
          });
        }
      }

      const { error: tErr } = await supabaseAdmin.from("render_output_targets").insert(
        targets.map((t) => ({
          render_job_id: jobId,
          project_id: data.project_id,
          user_id: context.userId,
          worker_output_id: t.workerOutputId,
          file_name: t.fileName,
          storage_path: t.storagePath,
          mime_type: t.mimeType,
          source_file_id: t.sourceFileId,
          variation_index: t.variationIndex,
        })),
      );
      if (tErr) throw new Error(`targets insert: ${tErr.message}`);
    } catch (err) {
      console.error("[submitRenderJob] targets", err);
      await failJob("targets_failed", "Falha ao preparar destinos.");
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 8) Sign input URLs — sources + referenced assets. fileType comes
    //    from project_files, never from the client.
    type SignedInput = {
      fileId: string;
      fileName: string;
      fileType: "source_video" | "logo" | "music" | "template_asset";
      mimeType: string;
      signedUrl: string;
    };
    const ALLOWED_INPUT_TYPES = new Set([
      "source_video",
      "logo",
      "music",
      "template_asset",
    ]);
    const BUCKET_BY_TYPE: Record<string, string> = {
      source_video: "project-inputs",
      logo: "project-assets",
      music: "project-assets",
      template_asset: "project-assets",
    };
    let signedInputs: SignedInput[];
    try {
      const allInputs = [...files, ...assetFiles];
      signedInputs = await Promise.all(
        allInputs.map(async (f) => {
          if (!ALLOWED_INPUT_TYPES.has(f.file_type)) {
            throw new Error(`invalid file_type: ${f.file_type}`);
          }
          const bucket = BUCKET_BY_TYPE[f.file_type];
          const { data: signed, error: sErr } = await supabaseAdmin.storage
            .from(bucket)
            .createSignedUrl(f.storage_path, SIGNED_INPUT_TTL_SECONDS);
          if (sErr || !signed) throw new Error("sign failed");
          return {
            fileId: f.id,
            fileName: f.file_name,
            fileType: f.file_type as SignedInput["fileType"],
            mimeType: f.mime_type,
            signedUrl: signed.signedUrl,
          };
        }),
      );
    } catch (err) {
      console.error("[submitRenderJob] sign inputs", err);
      await failJob("sign_failed", "Falha ao preparar arquivos.");
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 9) Sign upload URLs for each output target — NEVER persisted.
    type OutputTargetPayload = {
      workerOutputId: string;
      fileName: string;
      mimeType: string;
      signedUploadUrl: string;
    };
    let outputTargets: OutputTargetPayload[];
    try {
      outputTargets = await Promise.all(
        targets.map(async (t) => {
          const { data: signed, error: sErr } = await supabaseAdmin.storage
            .from("render-outputs")
            .createSignedUploadUrl(t.storagePath);
          if (sErr || !signed) throw new Error("upload sign failed");
          return {
            workerOutputId: t.workerOutputId,
            fileName: t.fileName,
            mimeType: t.mimeType,
            signedUploadUrl: signed.signedUrl,
          };
        }),
      );
    } catch (err) {
      console.error("[submitRenderJob] sign uploads", err);
      await failJob("sign_upload_failed", "Falha ao preparar destinos.");
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 10) Send job to worker. templateSettings references assets by
    //     fileId only — never storagePath or signed URL.
    const payload = {
      jobId,
      projectId: data.project_id,
      callbackUrl,
      inputFiles: signedInputs,
      outputTargets,
      templateSettings: project.template_settings,
      variationSettings: project.variation_settings,
      variationCount,
      uploadTtlSeconds: SIGNED_UPLOAD_TTL_SECONDS,
    };

    // Cleanup helper for definitive POST /jobs failure. Removes only
    // this job's targets and any partial storage objects under the
    // job prefix; never touches other jobs.
    const cleanupJobArtifacts = async () => {
      try {
        const prefix = `${context.userId}/${data.project_id}/${jobId}`;
        const { data: listed } = await supabaseAdmin.storage
          .from("render-outputs")
          .list(prefix, { limit: 1000 });
        const paths = (listed ?? []).map((o) => `${prefix}/${o.name}`);
        if (paths.length > 0) {
          await supabaseAdmin.storage.from("render-outputs").remove(paths);
        }
      } catch (e) {
        console.error("[submitRenderJob] cleanup storage", e);
      }
      try {
        await supabaseAdmin
          .from("render_output_targets")
          .delete()
          .eq("render_job_id", jobId);
      } catch (e) {
        console.error("[submitRenderJob] cleanup targets", e);
      }
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let workerJobId: string | null = null;
    try {
      const res = await fetch(`${workerUrl.replace(/\/+$/, "")}/jobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": jobId,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`worker ${res.status}`);
      const body = (await res.json().catch(() => null)) as {
        workerJobId?: string;
      } | null;
      if (!body?.workerJobId || typeof body.workerJobId !== "string") {
        throw new Error("invalid worker response");
      }
      workerJobId = body.workerJobId;
    } catch (err) {
      clearTimeout(timer);
      console.error("[submitRenderJob] worker", err);
      await failJob("worker_unreachable", "Servidor temporariamente indisponível.");
      await cleanupJobArtifacts();
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 11) Mark queued
    const { error: updErr } = await supabaseAdmin
      .from("render_jobs")
      .update({
        status: "queued",
        worker_job_id: workerJobId,
        attempt_count: 1,
        started_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (updErr) console.error("[submitRenderJob] update", updErr);

    await supabaseAdmin.from("projects").update({ status: "processing" }).eq("id", data.project_id);

    return { job_id: jobId };
  });
