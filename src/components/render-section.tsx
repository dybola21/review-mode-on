import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PlayCircle,
  RefreshCw,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import {
  checkWorkerHealth,
  getLatestRenderJob,
  submitRenderJob,
} from "@/lib/render.functions";

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

  const health = useQuery({
    queryKey: ["worker-health"],
    queryFn: () => healthFn(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const job = useQuery({
    queryKey: ["render-job", projectId],
    queryFn: () => jobFn({ data: { project_id: projectId } }),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && ACTIVE.has(s) ? 4000 : false;
    },
  });

  const isActive = !!job.data && ACTIVE.has(job.data.status);

  const submit = useMutation({
    mutationFn: () => submitFn({ data: { project_id: projectId } }),
    onSuccess: () => {
      toast.success("Processamento iniciado.");
      qc.invalidateQueries({ queryKey: ["render-job", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Não foi possível iniciar."),
  });

  const canSubmit =
    health.data?.configured &&
    health.data?.available &&
    !isActive &&
    !submit.isPending;

  const workerStatus = !health.data
    ? { icon: Loader2, label: "Verificando servidor…", cls: "text-muted-foreground animate-spin" }
    : !health.data.configured
    ? { icon: Server, label: "Servidor não configurado", cls: "text-muted-foreground" }
    : health.data.available
    ? { icon: CheckCircle2, label: "Servidor disponível", cls: "text-emerald-500" }
    : { icon: AlertCircle, label: "Servidor indisponível", cls: "text-amber-500" };

  const WorkerIcon = workerStatus.icon;

  return (
    <div className="surface-card space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Processamento
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Envie o projeto para gerar as variações editoriais.
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
            <span className="font-medium">
              {STATUS_LABEL[job.data.status] ?? job.data.status}
            </span>
            <span className="text-muted-foreground">
              {new Date(job.data.updated_at).toLocaleString("pt-BR")}
            </span>
          </div>
          {ACTIVE.has(job.data.status) && (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-border">
              <div
                className="h-full gradient-primary transition-all"
                style={{ width: `${job.data.progress}%` }}
              />
            </div>
          )}
          {job.data.status === "failed" && job.data.error_message && (
            <p className="mt-2 text-sm text-destructive">
              {job.data.error_message}
            </p>
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
            : "Iniciar processamento"}
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
