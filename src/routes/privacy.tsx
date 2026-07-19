import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Política de Privacidade — Editor em Massa" },
      {
        name: "description",
        content: "Como tratamos seus dados no Editor em Massa.",
      },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Política de Privacidade</h1>
      <div className="mt-6 space-y-4 text-sm text-muted-foreground">
        <p>
          Armazenamos apenas os dados necessários para operar a aplicação:
          email, nome de exibição e conteúdo dos projetos que você cria.
        </p>
        <p>
          Vídeos e arquivos enviados são armazenados de forma privada e
          acessíveis somente pelo próprio usuário autenticado.
        </p>
        <p>
          Você pode excluir seus projetos e arquivos a qualquer momento pelo
          painel.
        </p>
      </div>
    </div>
  );
}
