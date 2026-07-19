import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Loader2, Plus, Video, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { listProjects, updateProject } from "@/lib/projects.functions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [{ title: "Meus projetos — Editor em Massa" }],
  }),
  component: DashboardPage,
});

type ProjectRow = Awaited<ReturnType<typeof listProjects>>[number];

function DashboardPage() {
  const listFn = useServerFn(listProjects);
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listFn(),
  });

  const active = (data ?? []).filter((p) => p.status !== "archived");
  const archived = (data ?? []).filter((p) => p.status === "archived");

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Meus projetos
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Organize seus vídeos, templates e variações.
          </p>
        </div>
        <Link
          to="/projects/new"
          className="inline-flex items-center gap-1.5 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Novo projeto
        </Link>
      </div>

      {isLoading && (
        <div className="mt-16 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="mt-8 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Não foi possível carregar os projetos.
        </div>
      )}

      {!isLoading && !error && active.length === 0 && archived.length === 0 && (
        <EmptyState />
      )}

      {active.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Ativos
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        </section>
      )}

      {archived.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Arquivados
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {archived.map((p) => (
              <ProjectCard key={p.id} project={p} archived />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-12 rounded-lg border border-dashed border-border bg-surface/50 p-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
        <Video className="h-6 w-6 text-primary" />
      </div>
      <h3 className="mt-4 text-lg font-semibold">
        Você ainda não tem projetos
      </h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        Crie seu primeiro projeto para organizar vídeos, templates e variações
        editoriais em lote.
      </p>
      <Link
        to="/projects/new"
        className="mt-6 inline-flex items-center gap-1.5 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        <Plus className="h-4 w-4" /> Criar projeto
      </Link>
    </div>
  );
}

function ProjectCard({
  project,
  archived,
}: {
  project: ProjectRow;
  archived?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const updateFn = useServerFn(updateProject);
  const mut = useMutation({
    mutationFn: (status: "ready" | "archived") =>
      updateFn({ data: { id: project.id, status } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(archived ? "Projeto restaurado." : "Projeto arquivado.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  return (
    <div className="surface-card group flex flex-col p-5">
      <button
        onClick={() =>
          navigate({
            to: "/projects/$projectId",
            params: { projectId: project.id },
          })
        }
        className="flex-1 text-left"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-accent">
            <Video className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold group-hover:text-primary">
              {project.name}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {new Date(project.created_at).toLocaleDateString("pt-BR")} ·{" "}
              {project.variation_count} variações
            </p>
          </div>
        </div>
      </button>
      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <StatusBadge status={project.status} />
        <button
          onClick={() => mut.mutate(archived ? "ready" : "archived")}
          disabled={mut.isPending}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          title={archived ? "Restaurar" : "Arquivar"}
        >
          {archived ? (
            <ArchiveRestore className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
          {archived ? "Restaurar" : "Arquivar"}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    draft: {
      label: "Rascunho",
      className: "bg-muted text-muted-foreground",
    },
    ready: {
      label: "Pronto",
      className: "bg-primary/15 text-primary",
    },
    processing: {
      label: "Processando",
      className: "bg-blue-500/15 text-blue-400",
    },
    completed: {
      label: "Concluído",
      className: "bg-emerald-500/15 text-emerald-400",
    },
    failed: {
      label: "Falhou",
      className: "bg-destructive/15 text-destructive",
    },
    archived: {
      label: "Arquivado",
      className: "bg-muted text-muted-foreground",
    },
  };
  const cfg = map[status] ?? map.draft;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}
