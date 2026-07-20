import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteProject, getProject, updateProject } from "@/lib/projects.functions";
import { getAppSettings } from "@/lib/app-settings.functions";
import { MediaSection } from "@/components/media-section";
import { VariationsEditor } from "@/components/variations-editor";
import { RightsSection } from "@/components/rights-section";
import { RenderSection } from "@/components/render-section";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  head: () => ({
    meta: [{ title: "Editar projeto — Editor em Massa" }],
  }),
  component: EditProjectPage,
  errorComponent: EditProjectErrorBoundary,
  notFoundComponent: () => (
    <div className="mx-auto max-w-2xl px-6 py-10 text-center">
      <h1 className="text-lg font-semibold">Projeto não encontrado</h1>
      <Link
        to="/dashboard"
        className="mt-4 inline-block rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Voltar ao painel
      </Link>
    </div>
  ),
});

function EditProjectErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-2xl px-6 py-10 text-center">
      <h1 className="text-lg font-semibold">Não foi possível carregar</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <div className="mt-6 flex justify-center gap-2">
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Tentar novamente
        </button>
        <Link
          to="/dashboard"
          className="rounded-md border border-border bg-surface px-4 py-2 text-sm"
        >
          Voltar
        </Link>
      </div>
    </div>
  );
}

function EditProjectPage() {
  const { projectId } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const getFn = useServerFn(getProject);
  const updateFn = useServerFn(updateProject);
  const deleteFn = useServerFn(deleteProject);
  const settingsFn = useServerFn(getAppSettings);

  const query = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getFn({ data: { id: projectId } }),
  });

  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: () => settingsFn(),
    staleTime: 5 * 60 * 1000,
  });

  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (query.data) setName(query.data.name);
  }, [query.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          id: projectId,
          name: name.trim(),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Alterações salvas.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteFn({ data: { id: projectId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Projeto excluído.");
      navigate({ to: "/dashboard" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  if (query.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const project = query.data;
  if (!project) return null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        to="/dashboard"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Painel
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Criado em {new Date(project.created_at).toLocaleDateString("pt-BR")}
          </p>
        </div>
      </div>

      <div className="surface-card mt-8 space-y-5 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Detalhes
        </h2>

        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-foreground">
            Nome
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex justify-end border-t border-border pt-4">
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !name.trim()}
            className="inline-flex items-center gap-2 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Salvar alterações
          </button>
        </div>
      </div>

      {settingsQuery.data && (
        <div className="mt-6 space-y-6">
          <MediaSection
            projectId={projectId}
            initialTemplate={project.template_settings}
            settings={settingsQuery.data}
          />
          <VariationsEditor
            projectId={projectId}
            initial={project.variation_settings}
            currentCount={project.variation_count ?? 1}
            maxVariations={settingsQuery.data.max_variations}
          />
          <RightsSection projectId={projectId} />
          <RenderSection projectId={projectId} />
        </div>
      )}

      <div className="surface-card mt-6 space-y-4 border-destructive/30 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-destructive">
          Zona de perigo
        </h2>
        <p className="text-sm text-muted-foreground">
          Excluir remove o projeto permanentemente, junto com todos os arquivos enviados.
        </p>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20"
          >
            <Trash2 className="h-4 w-4" /> Excluir projeto
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <span className="text-sm text-foreground">Tem certeza? Esta ação é irreversível.</span>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {deleteMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirmar exclusão
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
