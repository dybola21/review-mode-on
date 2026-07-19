import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Termos de Uso — Editor em Massa" },
      {
        name: "description",
        content: "Termos de uso do Editor em Massa.",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Termos de Uso</h1>
      <div className="mt-6 space-y-4 text-sm text-muted-foreground">
        <p>
          O Editor em Massa é uma ferramenta para geração de variações
          editoriais em lote de vídeos <strong>de sua propriedade</strong> ou
          para os quais você possui autorização válida.
        </p>
        <p>
          Você é integralmente responsável por garantir que possui os direitos
          sobre todo o conteúdo enviado, incluindo vídeos, imagens, logotipos,
          textos e áudios.
        </p>
        <p>
          É proibido utilizar a ferramenta para burlar sistemas de detecção,
          moderação ou políticas de plataformas de terceiros.
        </p>
        <p>
          A confirmação de direitos é registrada e vincula sua conta a cada
          envio de processamento.
        </p>
      </div>
    </div>
  );
}
