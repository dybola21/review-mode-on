import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getSignedDownloadUrl, listRenderOutputs } from "@/lib/render.functions";

export const Route = createFileRoute("/_authenticated/projects/$projectId/results")({
  head: () => ({
    meta: [{ title: "Resultados — Editor em Massa" }],
  }),
  component: ResultsPage,
  errorComponent: ResultsErrorBoundary,
  notFoundComponent: () => (
    <div className="mx-auto max-w-2xl px-6 py-10 text-center">
      <h1 className="text-lg font-semibold">Sem resultados</h1>
    </div>
  ),
});

function ResultsErrorBoundary({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-2xl px-6 py-10 text-center">
      <h1 className="text-lg font-semibold">Erro ao carregar</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <button
        onClick={() => {
          router.invalidate();
          reset();
        }}
        className="mt-4 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Tentar novamente
      </button>
    </div>
  );
}
  notFoundComponent: () => (
    <div className="mx-auto max-w-2xl px-6 py-10 text-center">
      <h1 className="text-lg font-semibold">Sem resultados</h1>
    </div>
  ),
});

function formatSize(bytes: number | null) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function ResultsPage() {
  const { projectId } = Route.useParams();
  const listFn = useServerFn(listRenderOutputs);
  const urlFn = useServerFn(getSignedDownloadUrl);

  const query = useQuery({
    queryKey: ["render-outputs", projectId],
    queryFn: () => listFn({ data: { project_id: projectId } }),
  });

  const download = async (outputId: string) => {
    try {
      const { url } = await urlFn({ data: { output_id: outputId } });
      window.location.assign(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao baixar.");
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Voltar ao projeto
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Resultados</h1>
      <p className="mt-1 text-sm text-muted-foreground">Arquivos gerados pelo processamento.</p>

      <div className="surface-card mt-6 p-6">
        {query.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !query.data || query.data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nenhum resultado disponível ainda.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {query.data.map((o) => {
              const expired = o.expires_at && new Date(o.expires_at) < new Date();
              return (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-medium">{o.file_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(o.file_size)} · {new Date(o.created_at).toLocaleString("pt-BR")}
                      {o.expires_at && (
                        <>
                          {" · "}
                          {expired ? "expirado" : "expira"}{" "}
                          {new Date(o.expires_at).toLocaleDateString("pt-BR")}
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => download(o.id)}
                    disabled={!!expired}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                  >
                    <Download className="h-4 w-4" /> Baixar
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
