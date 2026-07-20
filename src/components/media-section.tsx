import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { TemplatePreview9x16 } from "@/components/template-preview";
import type { getAppSettings } from "@/lib/app-settings.functions";
import { useProjectFileUploader } from "@/lib/project-file-upload";
import { updateTemplateSettings } from "@/lib/project-config.functions";
import {
  deleteProjectFile,
  getProjectFilePreviewUrl,
  listProjectFiles,
} from "@/lib/project-files.functions";
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

const HEADER_ART_MIMES = ["image/png", "image/jpeg", "image/webp"];

type UploadItem = {
  key: string;
  file: File;
  status: "uploading" | "confirming" | "done" | "error" | "canceled";
  progress: number;
  error?: string;
  abort?: AbortController;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type Tab = "header" | "videos";

export function MediaSection({
  projectId,
  initialTemplate,
  settings,
}: {
  projectId: string;
  initialTemplate: unknown;
  settings: Settings;
}) {
  const [tab, setTab] = useState<Tab>("header");
  const parsed = templateSettingsSchema.safeParse(initialTemplate);
  const [tpl, setTpl] = useState<TemplateSettings>(
    parsed.success ? parsed.data : DEFAULT_TEMPLATE_SETTINGS,
  );

  const qc = useQueryClient();
  const saveFn = useServerFn(updateTemplateSettings);
  const listFn = useServerFn(listProjectFiles);
  const previewFn = useServerFn(getProjectFilePreviewUrl);
  const deleteFn = useServerFn(deleteProjectFile);

  const filesQuery = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () => listFn({ data: { project_id: projectId } }),
  });

  const headerImages = useMemo(
    () => (filesQuery.data ?? []).filter((f) => f.file_type === "template_asset"),
    [filesQuery.data],
  );
  const videos = useMemo(
    () => (filesQuery.data ?? []).filter((f) => f.file_type === "source_video"),
    [filesQuery.data],
  );

  // signed URL para a arte selecionada
  const [headerUrl, setHeaderUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const id = tpl.header_image_file_id;
    if (!id || !headerImages.find((f) => f.id === id)) {
      setHeaderUrl(null);
      return;
    }
    previewFn({ data: { id } })
      .then((r) => alive && setHeaderUrl(r.url))
      .catch(() => alive && setHeaderUrl(null));
    return () => {
      alive = false;
    };
  }, [tpl.header_image_file_id, headerImages, previewFn]);

  // signed URL para o logo (marca d'água)
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!tpl.logo_file_id || !headerImages.find((f) => f.id === tpl.logo_file_id)) {
      setLogoUrl(null);
      return;
    }
    previewFn({ data: { id: tpl.logo_file_id } })
      .then((r) => alive && setLogoUrl(r.url))
      .catch(() => alive && setLogoUrl(null));
    return () => {
      alive = false;
    };
  }, [tpl.logo_file_id, headerImages, previewFn]);

  // seleção do vídeo apenas para prévia visual (não persistido)
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (previewVideoId && !videos.find((v) => v.id === previewVideoId)) {
      setPreviewVideoId(null);
    }
  }, [videos, previewVideoId]);
  useEffect(() => {
    let alive = true;
    if (!previewVideoId) {
      setPreviewVideoUrl(null);
      return;
    }
    previewFn({ data: { id: previewVideoId } })
      .then((r) => alive && setPreviewVideoUrl(r.url))
      .catch(() => alive && setPreviewVideoUrl(null));
    return () => {
      alive = false;
    };
  }, [previewVideoId, previewFn]);

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
      if (id && prev.header_height_ratio < MIN_HEADER_RATIO) {
        next.header_height_ratio = DEFAULT_HEADER_RATIO;
      }
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

  const removeMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: (_r, id) => {
      toast.success("Arquivo excluído.");
      qc.invalidateQueries({ queryKey: ["project-files", projectId] });
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });
      setTpl((prev) => ({
        ...prev,
        header_image_file_id: prev.header_image_file_id === id ? null : prev.header_image_file_id,
        logo_file_id: prev.logo_file_id === id ? null : prev.logo_file_id,
      }));
      if (previewVideoId === id) setPreviewVideoId(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  const headerRatioPct = Math.round(tpl.header_height_ratio * 100);
  const canSave = Boolean(tpl.header_image_file_id);

  return (
    <div className="surface-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Mídias do projeto</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Organize a arte do cabeçalho e os vídeos que serão renderizados.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Mídias"
          className="inline-flex rounded-md border border-border bg-surface p-0.5 text-sm"
        >
          <TabButton active={tab === "header"} onClick={() => setTab("header")}>
            <ImageIcon className="h-4 w-4" /> Cabeçalho
          </TabButton>
          <TabButton active={tab === "videos"} onClick={() => setTab("videos")}>
            <Video className="h-4 w-4" /> Vídeos
          </TabButton>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div>
          {tab === "header" ? (
            <HeaderTab
              projectId={projectId}
              settings={settings}
              filesCount={filesQuery.data?.length ?? 0}
              images={headerImages}
              loading={filesQuery.isLoading}
              tpl={tpl}
              set={set}
              headerUrl={headerUrl}
              onSelect={handleHeaderSelect}
              onCenter={centerHeaderImage}
              headerRatioPct={headerRatioPct}
              onDelete={(id) => removeMut.mutate(id)}
              deleting={removeMut.isPending}
              onSave={() => save.mutate()}
              saving={save.isPending}
              canSave={canSave}
            />
          ) : (
            <VideosTab
              projectId={projectId}
              settings={settings}
              filesCount={filesQuery.data?.length ?? 0}
              videos={videos}
              loading={filesQuery.isLoading}
              selectedId={previewVideoId}
              onSelect={setPreviewVideoId}
              onDelete={(id) => removeMut.mutate(id)}
              deleting={removeMut.isPending}
            />
          )}
        </div>

        <TemplatePreview9x16
          template={tpl}
          headerUrl={headerUrl}
          logoUrl={logoUrl}
          videoUrl={previewVideoUrl}
          interactive
          onPositionChange={(p) =>
            setTpl((prev) => ({
              ...prev,
              header_image_position_x: p.x,
              header_image_position_y: p.y,
            }))
          }
        />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------- Header tab ------------------------- */

function HeaderTab(props: {
  projectId: string;
  settings: Settings;
  filesCount: number;
  images: Array<{ id: string; file_name: string; file_size: number }>;
  loading: boolean;
  tpl: TemplateSettings;
  set: <K extends keyof TemplateSettings>(k: K, v: TemplateSettings[K]) => void;
  headerUrl: string | null;
  onSelect: (id: string) => void;
  onCenter: () => void;
  headerRatioPct: number;
  onDelete: (id: string) => void;
  deleting: boolean;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
}) {
  const {
    projectId,
    settings,
    filesCount,
    images,
    loading,
    tpl,
    set,
    headerUrl,
    onSelect,
    onCenter,
    headerRatioPct,
    onDelete,
    deleting,
    onSave,
    saving,
    canSave,
  } = props;

  const uploader = useProjectFileUploader();
  const qc = useQueryClient();
  const [item, setItem] = useState<UploadItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function validate(file: File): string | null {
    if (file.size > settings.max_file_size_mb * 1024 * 1024)
      return `Arquivo maior que ${settings.max_file_size_mb} MB.`;
    if (!HEADER_ART_MIMES.includes(file.type)) return "Envie PNG, JPG/JPEG ou WebP.";
    const safe = sanitizeFileName(file.name);
    if (!extensionMatchesMime(safe, file.type))
      return "A extensão não corresponde ao tipo do arquivo.";
    const pending = item && item.status !== "done" ? 1 : 0;
    if (filesCount + pending >= settings.max_files_per_project)
      return `Limite de ${settings.max_files_per_project} arquivos atingido.`;
    return null;
  }

  async function startUpload(file: File) {
    const err = validate(file);
    if (err) return toast.error(err);
    const controller = new AbortController();
    const it: UploadItem = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      status: "uploading",
      progress: 5,
      abort: controller,
    };
    setItem(it);
    try {
      const { file_id } = await uploader({
        projectId,
        file,
        fileType: "template_asset",
        signal: controller.signal,
        onProgress: (p) =>
          setItem((prev) =>
            prev && prev.key === it.key
              ? { ...prev, status: p.phase as UploadItem["status"], progress: p.percent }
              : prev,
          ),
      });
      setItem((prev) =>
        prev && prev.key === it.key ? { ...prev, status: "done", progress: 100 } : prev,
      );
      await qc.invalidateQueries({ queryKey: ["project-files", projectId] });
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });
      onSelect(file_id);
      toast.success("Arte enviada.");
      setTimeout(
        () => setItem((prev) => (prev && prev.key === it.key ? null : prev)),
        800,
      );
    } catch (e) {
      if (controller.signal.aborted) {
        setItem((prev) =>
          prev && prev.key === it.key ? { ...prev, status: "canceled", progress: 0 } : prev,
        );
        return;
      }
      const msg = e instanceof Error ? e.message : "Erro no upload";
      setItem((prev) => (prev && prev.key === it.key ? { ...prev, status: "error", error: msg } : prev));
      toast.error(msg);
    }
  }

  return (
    <div className="space-y-4">
      <Dropzone
        dragOver={dragOver}
        onDragState={setDragOver}
        onFiles={(fs) => fs[0] && startUpload(fs[0])}
        onClick={() => inputRef.current?.click()}
        disabled={item?.status === "uploading" || item?.status === "confirming"}
        label="Arraste a arte aqui ou clique para selecionar (PNG, JPG ou WebP)."
        ctaLabel="Enviar arte do cabeçalho"
      />
      <input
        ref={inputRef}
        type="file"
        accept={HEADER_ART_MIMES.join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) startUpload(f);
          e.target.value = "";
        }}
      />

      {item && <UploadStatus item={item} onRetry={() => startUpload(item.file)} />}

      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Artes enviadas</div>
        {loading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : images.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nenhuma arte enviada. Recomendado 1080×640 px, textos dentro de uma margem segura.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {images.map((f) => {
              const selected = tpl.header_image_file_id === f.id;
              return (
                <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name="header-art"
                    checked={selected}
                    onChange={() => onSelect(f.id)}
                  />
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{f.file_name}</span>
                  <span className="text-xs text-muted-foreground">{humanSize(f.file_size)}</span>
                  <button
                    onClick={() => onDelete(f.id)}
                    disabled={deleting}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    title="Excluir"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Altura do cabeçalho (${headerRatioPct}%)`}>
          <input
            type="range"
            min={Math.round(MIN_HEADER_RATIO * 100)}
            max={Math.round(MAX_HEADER_RATIO * 100)}
            value={headerRatioPct}
            onChange={(e) => set("header_height_ratio", Number(e.target.value) / 100)}
          />
          <p className="text-[11px] text-muted-foreground">Faixa recomendada: 20%–40%.</p>
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
                <span className="block text-[10px] text-muted-foreground">Corta se necessário</span>
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
                <span className="block text-[10px] text-muted-foreground">Fundo preto se sobrar</span>
              </span>
            </label>
          </div>
          {tpl.header_image_fit === "cover" && tpl.header_image_file_id && (
            <button
              type="button"
              onClick={onCenter}
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
          {images.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Envie uma arte para usar como marca d&apos;água.
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <select
                className="input flex-1"
                value={tpl.logo_file_id ?? ""}
                onChange={(e) => set("logo_file_id", e.target.value || null)}
              >
                <option value="">— Sem marca d&apos;água —</option>
                {images.map((f) => (
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
          onClick={onSave}
          disabled={saving || !canSave}
          className="ml-auto rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? "Salvando…" : "Salvar template"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------- Videos tab ------------------------- */

function VideosTab(props: {
  projectId: string;
  settings: Settings;
  filesCount: number;
  videos: Array<{
    id: string;
    file_name: string;
    file_size: number;
    status: string;
  }>;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { projectId, settings, filesCount, videos, loading, selectedId, onSelect, onDelete, deleting } =
    props;

  const uploader = useProjectFileUploader();
  const qc = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const allowed = settings.allowed_video_types;

  function updateItem(key: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function validate(file: File): string | null {
    if (file.size > settings.max_file_size_mb * 1024 * 1024)
      return `Arquivo maior que ${settings.max_file_size_mb} MB.`;
    if (!allowed.includes(file.type)) return "Tipo de vídeo não permitido.";
    const safe = sanitizeFileName(file.name);
    if (!extensionMatchesMime(safe, file.type))
      return "A extensão não corresponde ao tipo do arquivo.";
    return null;
  }

  async function processUpload(it: UploadItem) {
    const controller = new AbortController();
    updateItem(it.key, { status: "uploading", progress: 5, abort: controller });
    try {
      await uploader({
        projectId,
        file: it.file,
        fileType: "source_video",
        signal: controller.signal,
        onProgress: (p) =>
          updateItem(it.key, { status: p.phase as UploadItem["status"], progress: p.percent }),
      });
      updateItem(it.key, { status: "done", progress: 100 });
      qc.invalidateQueries({ queryKey: ["project-files", projectId] });
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });
      setTimeout(() => setItems((prev) => prev.filter((p) => p.key !== it.key)), 800);
    } catch (e) {
      if (controller.signal.aborted) {
        updateItem(it.key, { status: "canceled", progress: 0 });
        return;
      }
      const msg = e instanceof Error ? e.message : "Erro no upload";
      updateItem(it.key, { status: "error", error: msg });
    }
  }

  function enqueue(files: FileList | File[]) {
    const arr = Array.from(files);
    const active = items.filter((p) => p.status !== "error" && p.status !== "canceled").length;
    const next: UploadItem[] = [];
    for (const f of arr) {
      if (filesCount + active + next.length >= settings.max_files_per_project) {
        toast.error(`Limite de ${settings.max_files_per_project} arquivos atingido.`);
        break;
      }
      const err = validate(f);
      if (err) {
        toast.error(`${f.name}: ${err}`);
        continue;
      }
      next.push({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file: f,
        status: "uploading",
        progress: 0,
      });
    }
    if (next.length === 0) return;
    setItems((prev) => [...prev, ...next]);
    next.forEach(processUpload);
  }

  return (
    <div className="space-y-4">
      <Dropzone
        dragOver={dragOver}
        onDragState={setDragOver}
        onFiles={(fs) => enqueue(fs)}
        onClick={() => inputRef.current?.click()}
        label={`Arraste vídeos aqui ou clique para enviar (${allowed.map((m) => m.split("/")[1]).join(", ")}).`}
        ctaLabel="Enviar vídeo"
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={allowed.join(",")}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) enqueue(e.target.files);
          e.target.value = "";
        }}
      />

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it) => (
            <UploadStatus key={it.key} item={it} onRetry={() => processUpload(it)} />
          ))}
        </ul>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>Vídeos enviados</span>
          {selectedId && (
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Limpar prévia
            </button>
          )}
        </div>
        {loading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : videos.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhum vídeo enviado ainda.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {videos.map((v) => (
              <li key={v.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <input
                  type="radio"
                  name="preview-video"
                  checked={selectedId === v.id}
                  onChange={() => onSelect(v.id)}
                  title="Exibir na prévia"
                />
                <Video className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{v.file_name}</span>
                <span className="text-xs text-muted-foreground">{humanSize(v.file_size)}</span>
                <button
                  onClick={() => onDelete(v.id)}
                  disabled={deleting}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                  title="Excluir"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {videos.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            A escolha do vídeo aqui é apenas para visualizar a prévia. Todos os vídeos enviados
            entram na renderização.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------- Shared bits ------------------------- */

function Dropzone(props: {
  dragOver: boolean;
  onDragState: (v: boolean) => void;
  onFiles: (files: FileList | File[]) => void;
  onClick: () => void;
  label: string;
  ctaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragState(true);
      }}
      onDragLeave={() => props.onDragState(false)}
      onDrop={(e) => {
        e.preventDefault();
        props.onDragState(false);
        if (e.dataTransfer.files) props.onFiles(e.dataTransfer.files);
      }}
      className={`rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ${
        props.dragOver
          ? "border-primary bg-primary/5"
          : "border-border bg-surface/50 text-muted-foreground"
      }`}
    >
      <div className="flex flex-col items-center gap-2">
        <Upload className="h-5 w-5" />
        <p className="text-xs">{props.label}</p>
        <button
          type="button"
          onClick={props.onClick}
          disabled={props.disabled}
          className="inline-flex items-center gap-1.5 rounded-md gradient-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" /> {props.ctaLabel}
        </button>
      </div>
    </div>
  );
}

function UploadStatus({ item, onRetry }: { item: UploadItem; onRetry: () => void }) {
  return (
    <li className="list-none rounded-md border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="flex-1 truncate">{item.file.name}</span>
        {(item.status === "uploading" || item.status === "confirming") && (
          <button
            type="button"
            onClick={() => item.abort?.abort()}
            className="text-muted-foreground hover:text-foreground"
            title="Cancelar"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {item.status === "error" && (
          <button
            type="button"
            onClick={onRetry}
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
            item.status === "error"
              ? "bg-destructive"
              : item.status === "done"
                ? "bg-emerald-500"
                : "bg-primary"
          }`}
          style={{ width: `${item.progress}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {item.status === "uploading" && `Enviando ${item.progress}%`}
        {item.status === "confirming" && "Confirmando…"}
        {item.status === "done" && "Concluído"}
        {item.status === "canceled" && "Cancelado"}
        {item.status === "error" && `Erro: ${item.error ?? "desconhecido"}`}
      </p>
    </li>
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
