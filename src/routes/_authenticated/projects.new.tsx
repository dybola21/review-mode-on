import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createProject } from "@/lib/projects.functions";

export const Route = createFileRoute("/_authenticated/projects/new")({
  head: () => ({
    meta: [{ title: "Novo projeto — Editor em Massa" }],
  }),
  component: NewProjectPage,
});

function NewProjectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const createFn = useServerFn(createProject);

  const mut = useMutation({
    mutationFn: () => createFn({ data: { name } }),
    onSuccess: (res) => {
      toast.success("Projeto criado.");
      navigate({
        to: "/projects/$projectId",
        params: { projectId: res.id },
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link
        to="/dashboard"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Voltar
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">Novo projeto</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Dê um nome ao projeto. Você poderá enviar vídeos e configurar o
        template no próximo passo.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) mut.mutate();
        }}
        className="surface-card mt-8 space-y-4 p-6"
      >
        <div>
          <label
            htmlFor="name"
            className="mb-1.5 block text-sm font-medium text-foreground"
          >
            Nome do projeto
          </label>
          <input
            id="name"
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Cortes Podcast Julho"
            autoFocus
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Escolha algo que te ajude a identificar depois.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Link
            to="/dashboard"
            className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={mut.isPending || !name.trim()}
            className="inline-flex items-center gap-2 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {mut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Criar projeto
          </button>
        </div>
      </form>
    </div>
  );
}
