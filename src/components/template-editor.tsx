import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { TemplatePreview9x16 } from "@/components/template-preview";
import type { getAppSettings } from "@/lib/app-settings.functions";
import { useProjectFileUploader } from "@/lib/project-file-upload";
import { updateTemplateSettings } from "@/lib/project-config.functions";
import { getProjectFilePreviewUrl, listProjectFiles } from "@/lib/project-files.functions";
import {
  DEFAULT_TEMPLATE_SETTINGS,
  extensionMatchesMime,
  sanitizeFileName,
  templateSettingsSchema,
  type TemplateSettings,
} from "@/lib/project-schemas";

type Settings = Awaited<ReturnType<typeof getAppSettings>>;

const MIN_HEADER_RATIO = 0.2;
const MAX_HEADER_RATIO = 0.4;
const DEFAULT_HEADER_RATIO = 0.335;

// Formatos permitidos para arte do cabeçalho.
const HEADER_ART_MIMES = ["image/png", "image/jpeg", "image/webp"];

type HeaderUpload = {
  key: string;
  file: File;
  status: "uploading" | "confirming" | "done" | "error" | "canceled";
  progress: number;
  error?: string;
  abort?: AbortController;
};

export function TemplateEditor({
  projectId,
  initial,
  settings,
}: {
  projectId: string;
  initial: unknown;
  settings: Settings;
}) {
  const parsed = templateSettingsSchema.safeParse(initial);
  const [tpl, setTpl] = useState<TemplateSettings>(
    parsed.success ? parsed.data : DEFAULT_TEMPLATE_SETTINGS,
  );

  const qc = useQueryClient();
  const saveFn = useServerFn(updateTemplateSettings);
  const listFn = useServerFn(listProjectFiles);
  const previewFn = useServerFn(getProjectFilePreviewUrl);
  const uploader = useProjectFileUploader();

  const filesQuery = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () => listFn({ data: { project_id: projectId } }),
  });

  const imageFiles = useMemo(
    () =>
      (filesQuery.data ?? []).filter(
        (f) =>
          typeof f.mime_type === "string" &&
          f.mime_type.startsWith("image/") &&
          f.status === "uploaded",
      ),
    [filesQuery.data],
  );

  // Signed URL para a arte de cabeçalho selecionada.
  const [headerUrl, setHeaderUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const id = tpl.header_image_file_id;
    if (!id || !imageFiles.find((f) => f.id === id)) {
      setHeaderUrl(null);
      return;
    }
    previewFn({ data: { id } })
      .then((r) => alive && setHeaderUrl(r.url))
      .catch(() => alive && setHeaderUrl(null));
    return () => {
      alive = false;
    };
  }, [tpl.header_image_file_id, imageFiles, previewFn]);

  // Signed URL para logo opcional (marca d'água).
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!tpl.logo_file_id || !imageFiles.find((f) => f.id === tpl.logo_file_id)) {
      setLogoUrl(null);
      return;
    }
    previewFn({ data: { id: tpl.logo_file_id } })
      .then((r) => alive && setLogoUrl(r.url))
      .catch(() => alive && setLogoUrl(null));
    return () => {
      alive = false;
    };
  }, [tpl.logo_file_id, imageFiles, previewFn]);

  const save = useMutation({
    mutationFn: () => saveFn({ data: { project_id: projectId, template: tpl } }),
    onSuccess: () => toast.success("Template salvo."),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  function set<K extends keyof TemplateSettings>(key: K, value: TemplateSettings[K]) {
    setTpl((prev) => ({ ...prev, [key]: value }));
  }

  function handleHeaderSelect(id: string) {
    setTpl((prev) => {
      const next: TemplateSettings = { ...prev, header_image_file_id: id || null };
      // Ao selecionar a primeira arte, se altura atual < mínimo recomendado,
      // subir para o padrão de 33,5%.
      if (id && prev.header_height_ratio < MIN_HEADER_RATIO) {
        next.header_height_ratio = DEFAULT_HEADER_RATIO;
      }
      // Ao trocar a imagem, sempre voltar para o centro.
      if (id !== prev.header_image_file_id) {
        next.header_image_position_x = 0.5;
        next.header_image_position_y = 0.5;
      }
      return next;
    });
  }

  function centerHeaderImage() {
    setTpl((prev) => ({
      ...prev,
      header_image_position_x: 0.5,
      header_image_position_y: 0.5,
    }));
  }


  // -------- Upload direto da arte do cabeçalho --------
  const [headerUpload, setHeaderUpload] = useState<HeaderUpload | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function validateHeaderFile(file: File): string | null {
    if (file.size > settings.max_file_size_mb * 1024 * 1024) {
      return `Arquivo maior que ${settings.max_file_size_mb} MB.`;
    }
    if (!HEADER_ART_MIMES.includes(file.type)) {
      return "Envie PNG, JPG/JPEG ou WebP.";
    }
    const safe = sanitizeFileName(file.name);
    if (!extensionMatchesMime(safe, file.type)) {
      return "A extensão não corresponde ao tipo do arquivo.";
    }
    const totalFiles =
      (filesQuery.data?.length ?? 0) + (headerUpload && headerUpload.status !== "done" ? 1 : 0);
    if (totalFiles >= settings.max_files_per_project) {
      return `Limite de ${settings.max_files_per_project} arquivos atingido.`;
    }
    return null;
  }

  async function startHeaderUpload(file: File) {
    const err = validateHeaderFile(file);
    if (err) {
      toast.error(err);
      return;
    }
    const controller = new AbortController();
    const item: HeaderUpload = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      status: "uploading",
      progress: 5,
      abort: controller,
    };
    setHeaderUpload(item);
    try {
      const { file_id } = await uploader({
        projectId,
        file,
        fileType: "template_asset",
        signal: controller.signal,
        onProgress: (p) =>
          setHeaderUpload((prev) =>
            prev && prev.key === item.key
              ? { ...prev, status: p.phase as HeaderUpload["status"], progress: p.percent }
              : prev,
          ),
      });

      setHeaderUpload((prev) =>
        prev && prev.key === item.key ? { ...prev, status: "done", progress: 100 } : prev,
      );

      // Atualizar listagens e selecionar automaticamente a nova arte.
      await qc.invalidateQueries({ queryKey: ["project-files", projectId] });
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });
      handleHeaderSelect(file_id);
      toast.success("Arte do cabeçalho enviada.");

      setTimeout(() => {
        setHeaderUpload((prev) => (prev && prev.key === item.key ? null : prev));
      }, 800);
    } catch (e) {
      if (controller.signal.aborted) {
        setHeaderUpload((prev) =>
          prev && prev.key === item.key ? { ...prev, status: "canceled", progress: 0 } : prev,
        );
        return;
      }
      const msg = e instanceof Error ? e.message : "Erro no upload";
      setHeaderUpload((prev) =>
        prev && prev.key === item.key ? { ...prev, status: "error", error: msg } : prev,
      );
      toast.error(msg);
    }
  }

  const headerRatioPct = Math.round(tpl.header_height_ratio * 100);
  const canSave = Boolean(tpl.header_image_file_id);

  return (
    <div className="surface-card p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Template do projeto</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Envie uma arte pronta (logo + textos) que ocupará o topo do vídeo 9:16. O vídeo entra logo
          abaixo, sem sobreposição.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <Field label="Arte do cabeçalho (obrigatória)">
            <div className="space-y-3">
              {/* Slot de upload direto */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) startHeaderUpload(f);
                }}
                className={`rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : "border-border bg-surface/50 text-muted-foreground"
                }`}
              >
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-5 w-5" />
                  <p className="text-xs">
                    Arraste a arte aqui ou clique para selecionar (PNG, JPG ou WebP).
                  </p>
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={
                      headerUpload?.status === "uploading" || headerUpload?.status === "confirming"
                    }
                    className="inline-flex items-center gap-1.5 rounded-md gradient-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    <Upload className="h-3.5 w-3.5" /> Enviar arte do cabeçalho
                  </button>
                  <input
                    ref={inputRef}
                    type="file"
                    accept={HEADER_ART_MIMES.join(",")}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) startHeaderUpload(f);
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>

              {/* Progresso do upload atual */}
              {headerUpload && (
                <div className="rounded-md border border-border bg-surface p-3">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="flex-1 truncate">{headerUpload.file.name}</span>
                    {(headerUpload.status === "uploading" ||
                      headerUpload.status === "confirming") && (
                      <button
                        type="button"
                        onClick={() => headerUpload.abort?.abort()}
                        className="text-muted-foreground hover:text-foreground"
                        title="Cancelar"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    {headerUpload.status === "error" && (
                      <button
                        type="button"
                        onClick={() => startHeaderUpload(headerUpload.file)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Tentar novamente"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full transition-all ${
                        headerUpload.status === "error"
                          ? "bg-destructive"
                          : headerUpload.status === "done"
                            ? "bg-emerald-500"
                            : "bg-primary"
                      }`}
                      style={{ width: `${headerUpload.progress}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {headerUpload.status === "uploading" && `Enviando ${headerUpload.progress}%`}
                    {headerUpload.status === "confirming" && "Confirmando…"}
                    {headerUpload.status === "done" && "Concluído"}
                    {headerUpload.status === "canceled" && "Cancelado"}
                    {headerUpload.status === "error" &&
                      `Erro: ${headerUpload.error ?? "desconhecido"}`}
                  </p>
                </div>
              )}

              {/* Seletor de imagens já enviadas */}
              {filesQuery.isLoading ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : imageFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nenhuma imagem enviada ainda. Use o slot acima ou o bloco de arquivos do projeto.
                  Recomendado: 1080×640 px, com textos dentro de uma margem segura.
                </p>
              ) : (
                <div className="space-y-2">
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Ou selecione uma imagem já enviada
                  </label>
                  <select
                    className="input w-full"
                    value={tpl.header_image_file_id ?? ""}
                    onChange={(e) => handleHeaderSelect(e.target.value)}
                  >
                    <option value="">— Selecione a arte —</option>
                    {imageFiles.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.file_name}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Recomendado 1080×640 px. Mantenha textos dentro de uma margem segura para evitar
                    corte no modo &quot;Preencher&quot;.
                  </p>
                  {tpl.header_image_file_id && headerUrl && (
                    <div className="rounded-md border border-border bg-surface p-2">
                      <img
                        src={headerUrl}
                        alt="Arte do cabeçalho"
                        className="max-h-24 w-full object-contain"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Altura do cabeçalho (${headerRatioPct}%)`}>
              <input
                type="range"
                min={Math.round(MIN_HEADER_RATIO * 100)}
                max={Math.round(MAX_HEADER_RATIO * 100)}
                value={headerRatioPct}
                onChange={(e) => set("header_height_ratio", Number(e.target.value) / 100)}
              />
              <p className="text-[11px] text-muted-foreground">
                Faixa recomendada: 20%–40%. Padrão 33,5%.
              </p>
            </Field>
            <Field label="Ajuste da arte">
              <div className="flex gap-2">
                <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface p-2 text-xs">
                  <input
                    type="radio"
                    name="header_fit"
                    checked={tpl.header_image_fit === "cover"}
                    onChange={() => set("header_image_fit", "cover")}
                  />
                  <span>
                    <strong>Preencher</strong>
                    <span className="block text-[10px] text-muted-foreground">
                      Corta se necessário
                    </span>
                  </span>
                </label>
                <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface p-2 text-xs">
                  <input
                    type="radio"
                    name="header_fit"
                    checked={tpl.header_image_fit === "contain"}
                    onChange={() => set("header_image_fit", "contain")}
                  />
                  <span>
                    <strong>Mostrar inteira</strong>
                    <span className="block text-[10px] text-muted-foreground">
                      Fundo preto se sobrar
                    </span>
                  </span>
                </label>
              </div>
              {tpl.header_image_fit === "cover" && tpl.header_image_file_id && (
                <button
                  type="button"
                  onClick={centerHeaderImage}
                  className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Centralizar
                </button>
              )}
            </Field>
          </div>


          <div className="rounded-md border border-border p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Marca d&apos;água (opcional)
            </div>
            <Field label="Imagem da marca d'água">
              {imageFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Envie uma imagem para usar como marca d&apos;água.
                </p>
              ) : (
                <div className="flex items-center gap-3">
                  <select
                    className="input flex-1"
                    value={tpl.logo_file_id ?? ""}
                    onChange={(e) => set("logo_file_id", e.target.value || null)}
                  >
                    <option value="">— Sem marca d&apos;água —</option>
                    {imageFiles.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.file_name}
                      </option>
                    ))}
                  </select>
                  {tpl.logo_file_id && (
                    <button
                      type="button"
                      onClick={() => set("logo_file_id", null)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Remover
                    </button>
                  )}
                </div>
              )}
            </Field>
            {tpl.logo_file_id && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Posição">
                  <select
                    className="input"
                    value={tpl.watermark_position}
                    onChange={(e) =>
                      set(
                        "watermark_position",
                        e.target.value as TemplateSettings["watermark_position"],
                      )
                    }
                  >
                    <option value="top-left">Sup. esquerda</option>
                    <option value="top-right">Sup. direita</option>
                    <option value="bottom-left">Inf. esquerda</option>
                    <option value="bottom-right">Inf. direita</option>
                  </select>
                </Field>
                <Field label={`Opacidade (${Math.round(tpl.watermark_opacity * 100)}%)`}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(tpl.watermark_opacity * 100)}
                    onChange={(e) => set("watermark_opacity", Number(e.target.value) / 100)}
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            {!canSave && (
              <p className="text-xs text-amber-600">
                Selecione a arte do cabeçalho antes de salvar.
              </p>
            )}
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || !canSave}
              className="ml-auto rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {save.isPending ? "Salvando…" : "Salvar template"}
            </button>
          </div>
        </div>

        <TemplatePreview9x16 template={tpl} headerUrl={headerUrl} logoUrl={logoUrl} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
