import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, Loader2, PlayCircle, RefreshCw, Server } from "lucide-react";
import { toast } from "sonner";
import {
  checkWorkerHealth,
  getLatestRenderJob,
  getRenderJobDiagnostics,
  submitRenderJob,
  type RenderJobDiagnostics,
} from "@/lib/render.functions";
import { listProjectFiles } from "@/lib/project-files.functions";

const ACTIVE = new Set(["queued", "submitting", "processing"]);
const FINAL = new Set(["completed", "failed", "cancelled", "expired"]);

const STATUS_LABEL: Record<string, string> = {
  queued: "Na fila",
  submitting: "Enviando",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
  expired: "Expirado",
};

export function RenderSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const healthFn = useServerFn(checkWorkerHealth);
  const jobFn = useServerFn(getLatestRenderJob);
  const submitFn = useServerFn(submitRenderJob);
  const filesFn = useServerFn(listProjectFiles);
  const diagFn = useServerFn(getRenderJobDiagnostics);

  const health = useQuery({
    queryKey: ["worker-health"],
    queryFn: () => healthFn(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const files = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () => filesFn({ data: { project_id: projectId } }),
  });

  const job = useQuery({
    queryKey: ["render-job", projectId],
    queryFn: () => jobFn({ data: { project_id: projectId } }),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && ACTIVE.has(s) ? 4000 : false;
    },
  });

  const diagnostics = useQuery({
    queryKey: ["render-diagnostics", projectId],
    queryFn: () => diagFn({ data: { project_id: projectId } }),
    enabled: !!job.data && ACTIVE.has(job.data.status),
    refetchInterval: () => {
      const s = job.data?.status;
      return s && ACTIVE.has(s) ? 4000 : false;
    },
  });

  const sourceCount = (files.data ?? []).filter(
    (f) => f.file_type === "source_video" && f.status === "uploaded",
  ).length;

  const isActive = !!job.data && ACTIVE.has(job.data.status);

  const submit = useMutation({
    mutationFn: () => submitFn({ data: { project_id: projectId } }),
    onSuccess: () => {
      toast.success("Processamento iniciado.");
      qc.invalidateQueries({ queryKey: ["render-job", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível iniciar."),
  });

  const canSubmit =
    health.data?.configured &&
    health.data?.available &&
    !isActive &&
    !submit.isPending &&
    sourceCount > 0;

  const workerStatus = !health.data
    ? { icon: Loader2, label: "Verificando servidor…", cls: "text-muted-foreground animate-spin" }
    : !health.data.configured
      ? { icon: Server, label: "Servidor não configurado", cls: "text-muted-foreground" }
      : health.data.available
        ? { icon: CheckCircle2, label: "Servidor disponível", cls: "text-emerald-500" }
        : { icon: AlertCircle, label: "Servidor indisponível", cls: "text-amber-500" };

  const WorkerIcon = workerStatus.icon;

  const processedCount =
    isActive && sourceCount > 0
      ? Math.min(sourceCount, Math.floor((job.data!.progress / 100) * sourceCount))
      : 0;

  return (
    <div className="surface-card space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Processamento
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {sourceCount > 0
              ? `${sourceCount} ${sourceCount === 1 ? "vídeo enviado" : "vídeos enviados"} → ${sourceCount} ${sourceCount === 1 ? "vídeo de saída" : "vídeos de saída"}.`
              : "Envie ao menos um vídeo para processar."}
          </p>
        </div>
        <div className={`flex items-center gap-1.5 text-xs ${workerStatus.cls}`}>
          <WorkerIcon className="h-4 w-4" />
          <span>{workerStatus.label}</span>
        </div>
      </div>

      {job.data && (
        <div className="rounded-md border border-border bg-surface p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{STATUS_LABEL[job.data.status] ?? job.data.status}</span>
            <span className="text-muted-foreground">
              {new Date(job.data.updated_at).toLocaleString("pt-BR")}
            </span>
          </div>
          {ACTIVE.has(job.data.status) && (
            <>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full gradient-primary transition-all"
                  style={{ width: `${job.data.progress}%` }}
                />
              </div>
              {sourceCount > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Processando {Math.min(processedCount + 1, sourceCount)} de {sourceCount} ·{" "}
                  {job.data.progress}%
                </p>
              )}
            </>
          )}
          {job.data.status === "failed" && job.data.error_message && (
            <p className="mt-2 text-sm text-destructive">{job.data.error_message}</p>
          )}
          {job.data.status === "completed" && (
            <Link
              to="/projects/$projectId/results"
              params={{ projectId }}
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Ver resultados
            </Link>
          )}
        </div>
      )}

      {isActive && (
        <DiagnosticsBlock
          state={diagnostics.data}
          isLoading={diagnostics.isPending || diagnostics.isFetching}
          isError={diagnostics.isError}
          onRefresh={() => diagnostics.refetch()}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => submit.mutate()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submit.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : job.data && FINAL.has(job.data.status) && job.data.status !== "completed" ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          {job.data && FINAL.has(job.data.status) && job.data.status !== "completed"
            ? "Tentar novamente"
            : "Processar todos os vídeos"}
        </button>
        {!health.data?.configured && (
          <span className="text-xs text-muted-foreground">
            Configure o servidor de processamento para habilitar.
          </span>
        )}
      </div>
    </div>
  );
}

function fmtDuration(s: number): string {
  const sec = Math.max(0, Math.round(s));
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

function DiagnosticsBlock({ d }: { d: NonNullable<RenderJobDiagnostics> }) {
  const title = "Diagnóstico";
  let detail = "";
  if (d.status === "queued" && d.queuePosition != null) {
    detail = `Na fila — posição ${d.queuePosition}`;
  } else if (d.stage === "downloading") {
    detail = `Baixando entradas — ${fmtDuration(d.elapsedSeconds)}`;
  } else if (d.stage === "preparing") {
    detail = `Preparando template — ${fmtDuration(d.elapsedSeconds)}`;
  } else if (d.stage === "rendering") {
    detail = `Renderizando — ${fmtDuration(d.elapsedSeconds)}`;
  } else if (d.stage === "uploading") {
    detail = `Upload — ${d.progress}%`;
  } else if (d.stage === "claimed") {
    detail = `Iniciando — ${fmtDuration(d.elapsedSeconds)}`;
  } else {
    detail = `${d.stage} — ${fmtDuration(d.elapsedSeconds)}`;
  }

  const hbAgeSec = d.heartbeatAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(d.heartbeatAt)) / 1000))
    : null;
  const stale = hbAgeSec != null && hbAgeSec >= 30;

  return (
    <div className="rounded-md border border-border/60 bg-surface/60 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-muted-foreground">{title}</span>
        <span className="text-muted-foreground">tentativa {d.attemptCount}</span>
      </div>
      <p className="mt-1 text-sm text-foreground">{detail}</p>
      {stale && <p className="mt-1 text-amber-500">Sem heartbeat há {hbAgeSec}s</p>}
      {d.lastErrorCode && <p className="mt-1 text-destructive">Último código: {d.lastErrorCode}</p>}
    </div>
  );
}
