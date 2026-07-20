import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import {
  File as FileIcon,
  Image as ImageIcon,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { deleteProjectFile, listProjectFiles } from "@/lib/project-files.functions";
import { useProjectFileUploader } from "@/lib/project-file-upload";
import type { getAppSettings } from "@/lib/app-settings.functions";

import { extensionMatchesMime, sanitizeFileName } from "@/lib/project-schemas";

type Settings = Awaited<ReturnType<typeof getAppSettings>>;

type UploadItem = {
  key: string;
  file: File;
  file_type: "source_video" | "logo" | "template_asset" | "music";
  status: "queued" | "uploading" | "confirming" | "done" | "error" | "canceled";
  progress: number;
  error?: string;
  abort?: AbortController;
};

function fileKind(mime: string): UploadItem["file_type"] | null {
  if (mime.startsWith("video/")) return "source_video";
  if (mime.startsWith("image/")) return "template_asset";
  return null; // áudio/outros: bloqueado nesta versão
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function IconForType({ type }: { type: string }) {
  if (type.startsWith("video/")) return <Video className="h-4 w-4" />;
  if (type.startsWith("image/")) return <ImageIcon className="h-4 w-4" />;
  if (type.startsWith("audio/")) return <Music className="h-4 w-4" />;
  return <FileIcon className="h-4 w-4" />;
}

export function ProjectFilesSection({
  projectId,
  settings,
}: {
  projectId: string;
  settings: Settings;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listProjectFiles);
  const prepareFn = useServerFn(prepareProjectFileUpload);
  const confirmFn = useServerFn(confirmProjectFile);
  const deleteFn = useServerFn(deleteProjectFile);

  const filesQuery = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () => listFn({ data: { project_id: projectId } }),
  });

  const [pending, setPending] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentCount =
    (filesQuery.data?.length ?? 0) +
    pending.filter((p) => p.status !== "error" && p.status !== "canceled").length;

  const allowedAll = [...settings.allowed_video_types, ...settings.allowed_image_types];

  function updateItem(key: string, patch: Partial<UploadItem>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  async function processUpload(item: UploadItem) {
    const controller = new AbortController();
    updateItem(item.key, {
      status: "uploading",
      progress: 5,
      abort: controller,
    });
    try {
      const prepared = await prepareFn({
        data: {
          project_id: projectId,
          file_name: item.file.name,
          mime_type: item.file.type,
          file_size: item.file.size,
          file_type: item.file_type,
        },
      });

      updateItem(item.key, { progress: 15 });

      // Upload via signed URL usando fetch (com progresso aproximado via XHR)
      const uploaded = await xhrUpload({
        url: prepared.signed_url,
        file: item.file,
        signal: controller.signal,
        onProgress: (p) =>
          updateItem(item.key, {
            progress: 15 + Math.floor(p * 0.75),
          }),
      });
      if (!uploaded) throw new Error("Upload cancelado.");

      updateItem(item.key, { status: "confirming", progress: 92 });

      await confirmFn({
        data: {
          file_id: prepared.file_id,
        },
      });

      updateItem(item.key, { status: "done", progress: 100 });
      qc.invalidateQueries({ queryKey: ["project-files", projectId] });
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });

      // Remove da lista pendente após 1s
      setTimeout(() => {
        setPending((prev) => prev.filter((p) => p.key !== item.key));
      }, 800);
    } catch (err) {
      if (controller.signal.aborted) {
        updateItem(item.key, { status: "canceled", progress: 0 });
        return;
      }
      const msg = err instanceof Error ? err.message : "Erro no upload";
      updateItem(item.key, { status: "error", error: msg });
    }
  }

  function validateLocal(file: File): string | null {
    if (file.size > settings.max_file_size_mb * 1024 * 1024)
      return `Arquivo maior que ${settings.max_file_size_mb} MB.`;
    if (!allowedAll.includes(file.type)) return "Tipo de arquivo não permitido.";
    const safe = sanitizeFileName(file.name);
    if (!extensionMatchesMime(safe, file.type)) return "A extensão não corresponde ao tipo.";
    return null;
  }

  function enqueue(files: FileList | File[]) {
    const arr = Array.from(files);
    const items: UploadItem[] = [];
    for (const f of arr) {
      if (currentCount + items.length >= settings.max_files_per_project) {
        toast.error(`Limite de ${settings.max_files_per_project} arquivos atingido.`);
        break;
      }
      const err = validateLocal(f);
      if (err) {
        toast.error(`${f.name}: ${err}`);
        continue;
      }
      const kind = fileKind(f.type);
      if (!kind) {
        toast.error(`${f.name}: tipo não suportado nesta versão.`);
        continue;
      }
      items.push({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file: f,
        file_type: kind,
        status: "queued",
        progress: 0,
      });
    }
    if (items.length === 0) return;
    setPending((prev) => [...prev, ...items]);
    items.forEach(processUpload);
  }

  const removeMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Arquivo excluído.");
      qc.invalidateQueries({ queryKey: ["project-files", projectId] });
      qc.invalidateQueries({ queryKey: ["project-rights", projectId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro"),
  });

  return (
    <div className="surface-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Arquivos do projeto</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Vídeos, logotipos e áudios. Máx {settings.max_files_per_project} arquivos, até{" "}
            {settings.max_file_size_mb} MB cada.
          </p>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md gradient-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Upload className="h-4 w-4" /> Adicionar
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={allowedAll.join(",")}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) enqueue(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files) enqueue(e.dataTransfer.files);
        }}
        className={`mt-4 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border bg-surface/50 text-muted-foreground"
        }`}
      >
        Arraste arquivos aqui ou clique em Adicionar.
      </div>

      {/* Uploads em andamento */}
      {pending.length > 0 && (
        <ul className="mt-4 space-y-2">
          {pending.map((item) => (
            <li key={item.key} className="rounded-md border border-border bg-surface p-3">
              <div className="flex items-center gap-2 text-sm">
                <IconForType type={item.file.type} />
                <span className="flex-1 truncate">{item.file.name}</span>
                <span className="text-xs text-muted-foreground">{humanSize(item.file.size)}</span>
                {(item.status === "uploading" || item.status === "confirming") && (
                  <button
                    onClick={() => item.abort?.abort()}
                    className="text-muted-foreground hover:text-foreground"
                    title="Cancelar"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                {item.status === "error" && (
                  <button
                    onClick={() => processUpload(item)}
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
              <p className="mt-1.5 text-xs text-muted-foreground">
                {item.status === "queued" && "Na fila…"}
                {item.status === "uploading" && `Enviando ${item.progress}%`}
                {item.status === "confirming" && "Confirmando…"}
                {item.status === "done" && "Concluído"}
                {item.status === "canceled" && "Cancelado"}
                {item.status === "error" && `Erro: ${item.error ?? "desconhecido"}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* Lista de arquivos confirmados */}
      <div className="mt-6">
        {filesQuery.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (filesQuery.data ?? []).length === 0 && pending.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhum arquivo enviado ainda.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(filesQuery.data ?? []).map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-3 text-sm">
                <IconForType type={f.mime_type} />
                <span className="flex-1 truncate">{f.file_name}</span>
                <span className="text-xs text-muted-foreground">{humanSize(f.file_size)}</span>
                <button
                  onClick={() => removeMut.mutate(f.id)}
                  disabled={removeMut.isPending}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                  title="Excluir"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Upload com progresso real via XHR
function xhrUpload({
  url,
  file,
  signal,
  onProgress,
}: {
  url: string;
  file: File;
  signal: AbortSignal;
  onProgress: (p: number) => void;
}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(true);
      else reject(new Error(`Falha no upload (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Erro de rede no upload."));
    xhr.onabort = () => resolve(false);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// Hook útil para evitar hydration mismatch (não usado no arquivo por ora)
export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}
