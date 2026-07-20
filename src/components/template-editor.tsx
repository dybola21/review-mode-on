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
      return next;
    });
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
            {imageFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Envie uma imagem no bloco de arquivos para poder selecioná-la como arte do
                cabeçalho. Recomendado: 1080×640 px, com textos dentro de uma margem segura.
              </p>
            ) : (
              <div className="space-y-2">
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
