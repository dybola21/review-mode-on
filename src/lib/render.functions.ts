import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CONTRACT_VERSION, RIGHTS_CONFIRMATION_VERSION } from "./project-schemas";
import {
  bucketForFileType,
  buildOutputStoragePath,
  normalizePublicAppUrl,
  sanitizeBaseName,
  validateRenderInput,
} from "./render-security";
import {
  classifyWorkerHttpFailure,
  parseWorkerErrorEnvelope,
  WORKER_INVALID_RESPONSE,
  WORKER_UNREACHABLE,
  type WorkerFailure,
} from "./worker-response";

function clientError(msg: string): Error {
  return new Error(msg);
}

type SubmitStage =
  | "validation_started"
  | "job_created"
  | "targets_created"
  | "signed_urls_created"
  | "worker_request_started"
  | "worker_accepted"
  | "submission_failed";

function logSubmit(
  stage: SubmitStage,
  fields: { projectId: string; jobId?: string | null; code?: string },
): void {
  // Structured, secret-free log line for the render submission pipeline.
  console.log(
    JSON.stringify({
      event: "submitRenderJob",
      stage,
      projectId: fields.projectId,
      jobId: fields.jobId ?? null,
      code: fields.code ?? null,
    }),
  );
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

/**
 * Pure predicate: a health body is only "available" when every field is
 * present and correct. Used by the server-fn below AND unit tests.
 * Requires:
 *   - status === "ok"
 *   - ffmpeg === true
 *   - queue === "ready"
 *   - version is a non-empty string
 */
export function isHealthyBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const versionOk = typeof b.version === "string" && b.version.trim().length > 0;
  return b.status === "ok" && b.ffmpeg === true && b.queue === "ready" && versionOk;
}

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
      if (res.status !== 200) {
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
      const ok = isHealthyBody(body);
      return {
        configured: true,
        available: ok,
        checkedAt: new Date().toISOString(),
        message: ok ? "Servidor disponível." : "Servidor incompleto (FFmpeg, fila ou versão).",
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
// Worker diagnostics — proxied through the app so ownership is enforced
// via RLS. Never exposes worker URL / API key / payload.
// -----------------------------------------------------------------------

export type RenderJobDiagnostics = {
  status: string;
  stage: string;
  progress: number;
  queuePosition: number | null;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  heartbeatAt: string | null;
  elapsedSeconds: number;
  lastErrorCode: string | null;
  running: boolean;
} | null;

const DIAG_ACTIVE = new Set(["queued", "submitting", "processing"]);

export const getRenderJobDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => projectIdSchema.parse(data))
  .handler(async ({ data, context }): Promise<RenderJobDiagnostics> => {
    // RLS-scoped read — ownership enforced by the policy on render_jobs.
    const { data: rows, error } = await context.supabase
      .from("render_jobs")
      .select("id, worker_job_id, status")
      .eq("project_id", data.project_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return null;
    const job = rows?.[0];
    if (!job || !job.worker_job_id) return null;
    if (!DIAG_ACTIVE.has(job.status)) return null;

    const workerUrl = process.env.VIDEO_WORKER_URL;
    const workerKey = process.env.VIDEO_WORKER_API_KEY;
    if (!workerUrl || !workerKey) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${workerUrl.replace(/\/+$/, "")}/internal/job-status`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jobId: job.id, workerJobId: job.worker_job_id }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status !== 200) return null;
      const body = (await res.json().catch(() => null)) as RenderJobDiagnostics;
      if (!body || typeof body !== "object") return null;
      return body;
    } catch {
      clearTimeout(timer);
      return null;
    }
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

    logSubmit("validation_started", { projectId: data.project_id });

    // 1) Project
    const { data: project, error: projectErr } = await context.supabase
      .from("projects")
      .select("id, status, template_settings")
      .eq("id", data.project_id)
      .maybeSingle();
    if (projectErr || !project) throw clientError("Projeto não encontrado.");

    // 2) Source files
    const { data: files, error: filesErr } = await context.supabase
      .from("project_files")
      .select("id, user_id, project_id, file_name, storage_path, mime_type, file_type, status")
      .eq("project_id", data.project_id)
      .eq("file_type", "source_video")
      .eq("status", "uploaded");
    if (filesErr) throw clientError("Falha ao ler arquivos do projeto.");
    if (!files || files.length === 0) {
      throw clientError("Envie pelo menos um vídeo antes de processar.");
    }

    // 2b) Assets referenced by the template (logo e/ou arte do cabeçalho).
    const templateSettings = (project.template_settings ?? {}) as {
      logo_file_id?: string | null;
      header_image_file_id?: string | null;
    };
    const referencedAssetIds = new Set<string>();
    if (templateSettings.logo_file_id) referencedAssetIds.add(templateSettings.logo_file_id);
    if (templateSettings.header_image_file_id)
      referencedAssetIds.add(templateSettings.header_image_file_id);

    let assetFiles: Array<{
      id: string;
      user_id: string;
      project_id: string;
      file_name: string;
      storage_path: string;
      mime_type: string;
      file_type: string;
      status: string;
    }> = [];
    if (referencedAssetIds.size > 0) {
      const { data: assets, error: aErr } = await context.supabase
        .from("project_files")
        .select("id, user_id, project_id, file_name, storage_path, mime_type, file_type, status")
        .eq("project_id", data.project_id)
        .eq("status", "uploaded")
        .in("id", Array.from(referencedAssetIds));
      if (aErr) throw clientError("Falha ao ler arquivos do projeto.");
      assetFiles = assets ?? [];
      for (const id of referencedAssetIds) {
        const found = assetFiles.find((a) => a.id === id);
        if (!found) {
          throw clientError("Asset referenciado pelo template não encontrado.");
        }
        if (id === templateSettings.logo_file_id && !found.mime_type.startsWith("image/")) {
          throw clientError("O logo do template precisa ser uma imagem.");
        }
        if (id === templateSettings.header_image_file_id && !found.mime_type.startsWith("image/")) {
          throw clientError("A arte do cabeçalho precisa ser uma imagem.");
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

    // 5) v2: 1:1 — número de saídas = número de vídeos de origem. Sem clamp.
    const totalOutputs = files.length;
    if (totalOutputs === 0) {
      throw clientError("Nada a processar.");
    }
    if (totalOutputs > HARD_MAX_OUTPUTS) {
      throw clientError(`O limite é de ${HARD_MAX_OUTPUTS} vídeos por processamento.`);
    }

    // 5b) Validate every input file BEFORE we write anything.
    const allInputsForValidation = [...files, ...assetFiles];
    for (const f of allInputsForValidation) {
      const reason = validateRenderInput(
        {
          id: f.id,
          user_id: f.user_id,
          project_id: f.project_id,
          status: f.status,
          file_type: f.file_type,
          mime_type: f.mime_type,
          storage_path: f.storage_path,
        },
        context.userId,
        data.project_id,
      );
      if (reason) {
        console.error("[submitRenderJob] input invalid", { id: f.id, reason });
        throw clientError("Um dos arquivos do projeto está inválido para renderização.");
      }
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
      logSubmit("job_created", { projectId: data.project_id, jobId });
    } catch (err) {
      console.error("[submitRenderJob] insert", err);
      logSubmit("submission_failed", {
        projectId: data.project_id,
        code: "job_insert_failed",
      });
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

    const cleanupJobArtifactsSafely = async () => {
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
        await supabaseAdmin.from("render_output_targets").delete().eq("render_job_id", jobId);
      } catch (e) {
        console.error("[submitRenderJob] cleanup targets", e);
      }
    };

    // 7) Pre-create output targets — 1:1 com source_video (sem variações).
    type Target = {
      workerOutputId: string;
      fileName: string;
      storagePath: string;
      mimeType: string;
      sourceFileId: string;
    };
    const targets: Target[] = [];
    try {
      for (const f of files) {
        const base = sanitizeBaseName((f.file_name ?? "video").replace(/\.[^.]+$/, ""));
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
          fileName: `${base}.mp4`,
          storagePath,
          mimeType: "video/mp4",
          sourceFileId: f.id,
        });
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
          // Legacy schema field kept for compatibility — always 1 in v2.
          variation_index: 1,
        })),
      );
      if (tErr) throw new Error(`targets insert: ${tErr.message}`);
      logSubmit("targets_created", { projectId: data.project_id, jobId });
    } catch (err) {
      console.error("[submitRenderJob] targets", err);
      await failJob("targets_failed", "Falha ao preparar destinos.");
      logSubmit("submission_failed", {
        projectId: data.project_id,
        jobId,
        code: "targets_failed",
      });
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 8) Sign input URLs — sources + referenced assets. fileType comes
    //    from project_files, never from the client.
    type SignedInput = {
      fileId: string;
      fileName: string;
      fileType: "source_video" | "logo" | "template_asset";
      mimeType: string;
      signedUrl: string;
    };
    // Bucket comes from the shared server-canonical map, not from a
    // client-supplied hint. Validation ran in step 5b already.

    let signedInputs: SignedInput[];
    try {
      const allInputs = [...files, ...assetFiles];
      signedInputs = await Promise.all(
        allInputs.map(async (f) => {
          const bucket = bucketForFileType(f.file_type);
          if (!bucket) {
            throw new Error(`invalid file_type: ${f.file_type}`);
          }
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
      await cleanupJobArtifactsSafely();
      logSubmit("submission_failed", {
        projectId: data.project_id,
        jobId,
        code: "sign_failed",
      });
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 9) Sign upload URLs for each output target — NEVER persisted.
    type OutputTargetPayload = {
      workerOutputId: string;
      fileName: string;
      mimeType: string;
      signedUploadUrl: string;
      sourceFileId: string;
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
            sourceFileId: t.sourceFileId,
          };
        }),
      );
    } catch (err) {
      console.error("[submitRenderJob] sign uploads", err);
      await failJob("sign_upload_failed", "Falha ao preparar destinos.");
      await cleanupJobArtifactsSafely();
      logSubmit("submission_failed", {
        projectId: data.project_id,
        jobId,
        code: "sign_upload_failed",
      });
      throw clientError("Não foi possível iniciar o processamento.");
    }

    logSubmit("signed_urls_created", { projectId: data.project_id, jobId });

    // 10) Send job to worker (v2). templateSettings references assets by
    //     fileId only — never storagePath or signed URL. Sem variações.
    const payload = {
      contractVersion: CONTRACT_VERSION,
      jobId,
      projectId: data.project_id,
      callbackUrl,
      inputFiles: signedInputs,
      outputTargets,
      templateSettings: project.template_settings,
      uploadTtlSeconds: SIGNED_UPLOAD_TTL_SECONDS,
    };

    // Cleanup helper (moved above; see `cleanupJobArtifactsSafely`).

    logSubmit("worker_request_started", { projectId: data.project_id, jobId });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let workerJobId: string | null = null;
    let failure: WorkerFailure | null = null;
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
      if (!res.ok) {
        // Safely read the JSON envelope — never log its body.
        const body = await res.json().catch(() => null);
        const errCode = parseWorkerErrorEnvelope(body);
        failure = classifyWorkerHttpFailure(res.status, errCode);
      } else {
        const body = (await res.json().catch(() => null)) as {
          workerJobId?: string;
        } | null;
        if (!body?.workerJobId || typeof body.workerJobId !== "string") {
          failure = WORKER_INVALID_RESPONSE;
        } else {
          workerJobId = body.workerJobId;
          logSubmit("worker_accepted", { projectId: data.project_id, jobId });
        }
      }
    } catch (err) {
      clearTimeout(timer);
      // Timeout / DNS / TCP / abort — never got a response from the worker.
      console.error("[submitRenderJob] worker network", (err as Error)?.name ?? "err");
      failure = WORKER_UNREACHABLE;
    }
    if (failure) {
      await failJob(failure.code, failure.message);
      await cleanupJobArtifactsSafely();
      logSubmit("submission_failed", {
        projectId: data.project_id,
        jobId,
        code: failure.code,
      });
      throw clientError("Não foi possível iniciar o processamento.");
    }

    // 11) Race-safe status/binding update.
    //     - Never regress processing/completed/failed/cancelled → queued.
    //     - Try to bind worker_job_id conditionally (only when null) and
    //       advance status → queued only when still 'submitting'.
    const { error: updErr } = await supabaseAdmin
      .from("render_jobs")
      .update({
        status: "queued",
        worker_job_id: workerJobId,
        attempt_count: 1,
        started_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("status", "submitting")
      .is("worker_job_id", null);
    if (updErr) console.error("[submitRenderJob] update", updErr);

    // Conditional bind if status advanced past 'submitting' but no binding
    // was set yet.
    const { error: bindErr } = await supabaseAdmin
      .from("render_jobs")
      .update({ worker_job_id: workerJobId, attempt_count: 1 })
      .eq("id", jobId)
      .is("worker_job_id", null);
    if (bindErr) console.error("[submitRenderJob] bind", bindErr);

    // Re-read authoritative binding. If a webhook won the race and bound
    // a DIFFERENT worker_job_id, DO NOT overwrite: mark as conflict, log,
    // and fail the caller so no signed URL for a foreign worker leaks.
    const { data: reread, error: rrErr } = await supabaseAdmin
      .from("render_jobs")
      .select("worker_job_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (rrErr || !reread) {
      console.error("[submitRenderJob] reread", rrErr);
      throw clientError("Não foi possível confirmar o processamento.");
    }
    if (reread.worker_job_id === null) {
      // Extremely unlikely (both updates failed). Treat as transient.
      throw clientError("Não foi possível confirmar o processamento.");
    }
    if (reread.worker_job_id !== workerJobId) {
      console.error("[submitRenderJob] worker_job_id conflict", {
        jobId,
        expected: workerJobId,
        bound: reread.worker_job_id,
      });
      // Do NOT overwrite. Do NOT silently return success. Let the caller
      // know so the UI stops assuming this POST /jobs response was accepted.
      throw clientError("Conflito ao vincular o processamento. Tente novamente.");
    }

    // Only advance the project to 'processing' if it isn't already
    // completed/failed by an early webhook. Prevents regression.
    await supabaseAdmin
      .from("projects")
      .update({ status: "processing" })
      .eq("id", data.project_id)
      .not("status", "in", "(completed,failed)");

    return { job_id: jobId };
  });
