import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { RIGHTS_CONFIRMATION_VERSION } from "./project-schemas";

function clientError(msg: string): Error {
  return new Error(msg);
}

const ACTIVE_STATUSES = ["queued", "submitting", "processing"] as const;
const SIGNED_INPUT_TTL_SECONDS = 60 * 60; // 1h
const SIGNED_DOWNLOAD_TTL_SECONDS = 60 * 10; // 10min

function safeErrorMessage(fallback: string, err: unknown): string {
  console.error(fallback, err);
  return fallback;
}

function getPublicBaseUrl(): string | null {
  const envUrl = process.env.PUBLIC_APP_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  try {
    const req = getRequest();
    const host =
      req?.headers.get("x-forwarded-host") ?? req?.headers.get("host");
    if (!host) return null;
    const proto = req?.headers.get("x-forwarded-proto") ?? "https";
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
        message: ok
          ? "Servidor disponível."
          : "Resposta inesperada do servidor.",
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
// List / get jobs (RLS scoped)
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
      throw clientError(
        safeErrorMessage("Não foi possível carregar o status.", error),
      );
    }
    return rows?.[0] ?? null;
  });

export const listRenderOutputs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("render_outputs")
      .select(
        "id, render_job_id, file_name, file_size, mime_type, created_at, expires_at",
      )
      .eq("project_id", data.project_id)
      .order("created_at", { ascending: false });
    if (error) {
      throw clientError(
        safeErrorMessage("Não foi possível carregar os resultados.", error),
      );
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
    // RLS garante que só o dono lê o registro
    const { data: row, error } = await context.supabase
      .from("render_outputs")
      .select("storage_path, expires_at, file_name")
      .eq("id", data.output_id)
      .maybeSingle();
    if (error || !row) throw clientError("Resultado indisponível ou expirado.");
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      throw clientError("Resultado indisponível ou expirado.");
    }

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from("render-outputs")
      .createSignedUrl(row.storage_path, SIGNED_DOWNLOAD_TTL_SECONDS, {
        download: row.file_name,
      });
    if (sErr || !signed) {
      throw clientError(
        safeErrorMessage("Resultado indisponível ou expirado.", sErr),
      );
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

    // 1) Projeto do usuário
    const { data: project, error: projectErr } = await context.supabase
      .from("projects")
      .select(
        "id, status, template_settings, variation_settings, variation_count",
      )
      .eq("id", data.project_id)
      .maybeSingle();
    if (projectErr || !project) throw clientError("Projeto não encontrado.");

    // 2) Arquivos de origem
    const { data: files, error: filesErr } = await context.supabase
      .from("project_files")
      .select("id, file_name, storage_path, mime_type, file_type")
      .eq("project_id", data.project_id)
      .eq("file_type", "source_video");
    if (filesErr) throw clientError("Falha ao ler arquivos do projeto.");
    if (!files || files.length === 0) {
      throw clientError("Envie pelo menos um vídeo antes de processar.");
    }

    // 3) Direitos
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

    // 4) Job ativo?
    const { data: active } = await context.supabase
      .from("render_jobs")
      .select("id")
      .eq("project_id", data.project_id)
      .in("status", ACTIVE_STATUSES as unknown as string[])
      .limit(1);
    if (active && active.length > 0) {
      throw clientError("Já existe um processamento em andamento.");
    }

    // 5) Cria job (admin) com status submitting
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

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
      if (createErr || !created) {
        // Unique-active-index conflict = job de corrida.
        throw new Error("insert failed");
      }
      jobId = created.id;
    } catch (err) {
      console.error("[submitRenderJob] insert", err);
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 6) Sign input URLs
    let signedInputs: Array<{
      fileId: string;
      fileName: string;
      mimeType: string;
      signedUrl: string;
    }>;
    try {
      signedInputs = await Promise.all(
        files.map(async (f) => {
          const { data: signed, error: sErr } = await supabaseAdmin.storage
            .from("project-inputs")
            .createSignedUrl(f.storage_path, SIGNED_INPUT_TTL_SECONDS);
          if (sErr || !signed) throw new Error("sign failed");
          return {
            fileId: f.id,
            fileName: f.file_name,
            mimeType: f.mime_type,
            signedUrl: signed.signedUrl,
          };
        }),
      );
    } catch (err) {
      console.error("[submitRenderJob] sign", err);
      await supabaseAdmin
        .from("render_jobs")
        .update({
          status: "failed",
          error_code: "sign_failed",
          error_message: "Falha ao preparar arquivos.",
        })
        .eq("id", jobId);
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 7) Envia ao worker
    const baseUrl = getPublicBaseUrl();
    const callbackUrl = baseUrl
      ? `${baseUrl}/api/public/worker-webhook`
      : null;
    if (!callbackUrl) {
      await supabaseAdmin
        .from("render_jobs")
        .update({
          status: "failed",
          error_code: "no_callback",
          error_message: "URL pública não configurada.",
        })
        .eq("id", jobId);
      throw clientError("Não foi possível iniciar o processamento.");
    }

    const payload = {
      jobId,
      projectId: data.project_id,
      callbackUrl,
      inputFiles: signedInputs,
      templateSettings: project.template_settings,
      variationSettings: project.variation_settings,
      variationCount: project.variation_count,
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
      await supabaseAdmin
        .from("render_jobs")
        .update({
          status: "failed",
          error_code: "worker_unreachable",
          error_message: "Servidor temporariamente indisponível.",
          attempt_count: 1,
        })
        .eq("id", jobId);
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 8) Sucesso: marca queued + worker_job_id
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

    await supabaseAdmin
      .from("projects")
      .update({ status: "processing" })
      .eq("id", data.project_id);

    return { job_id: jobId };
  });
