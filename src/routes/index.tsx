import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Layers, ShieldCheck, Zap } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Editor em Massa — Variações editoriais dos seus vídeos" },
      {
        name: "description",
        content:
          "Aplique templates, identidade visual e variações editoriais em lote nos seus próprios vídeos.",
      },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md gradient-primary" />
            <span className="text-lg font-semibold tracking-tight">
              Editor em Massa
            </span>
          </Link>
          <nav className="flex items-center gap-3">
            <Link
              to="/auth"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Entrar
            </Link>
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className="inline-flex items-center gap-1.5 rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Criar conta
              <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-6 py-24 text-center">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Uso responsável com conteúdo próprio
          </div>
          <h1 className="mt-6 text-5xl font-bold tracking-tight sm:text-6xl">
            Variações editoriais dos{" "}
            <span className="bg-gradient-to-r from-primary to-primary-glow bg-clip-text text-transparent">
              seus vídeos
            </span>
            , em lote.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Crie versões editoriais consistentes dos seus próprios vídeos
            utilizando templates, identidade visual e processamento em lote.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className="inline-flex items-center gap-2 rounded-md gradient-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Começar agora
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-6 py-3 text-sm font-medium transition-colors hover:bg-accent"
            >
              Já tenho conta
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-3xl font-semibold">Como funciona</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            <Feature
              icon={<Layers className="h-5 w-5" />}
              title="Envie seus vídeos"
              text="Faça upload dos vídeos que você possui ou está autorizado a editar."
            />
            <Feature
              icon={<Zap className="h-5 w-5" />}
              title="Configure o template"
              text="Defina logotipo, cabeçalho, rodapé, cores e marca d'água no formato 9:16."
            />
            <Feature
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Gere variações"
              text="Ajustes editoriais discretos aplicados em lote, com download dos resultados."
            />
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-16">
          <div className="surface-card p-8">
            <h3 className="text-lg font-semibold">Uso responsável</h3>
            <p className="mt-3 text-sm text-muted-foreground">
              O Editor em Massa é destinado a criadores que já possuem os
              direitos ou a autorização necessária sobre os arquivos enviados.
              Não utilize a ferramenta para burlar moderação, políticas de
              plataformas ou direitos autorais de terceiros. Ao enviar um
              projeto para processamento, você confirma expressamente que
              detém tais direitos.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} Editor em Massa</span>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-foreground">
              Privacidade
            </Link>
            <Link to="/terms" className="hover:text-foreground">
              Termos
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Feature({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="surface-card p-6">
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-accent text-primary">
        {icon}
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
