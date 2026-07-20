import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { confirmProjectFile, prepareProjectFileUpload } from "@/lib/project-files.functions";

export type ProjectFileType = "source_video" | "logo" | "template_asset" | "music";

export type UploadPhase = "queued" | "uploading" | "confirming" | "done" | "error" | "canceled";

export type UploadProgress = {
  phase: UploadPhase;
  percent: number;
};

/**
 * Reusable secure upload flow shared by ProjectFilesSection and the header-art
 * uploader inside TemplateEditor.
 *
 * Flow: prepareProjectFileUpload → PUT signed URL → confirmProjectFile.
 * No direct INSERTs, no service-role credentials in the client.
 */
export function useProjectFileUploader() {
  const prepareFn = useServerFn(prepareProjectFileUpload);
  const confirmFn = useServerFn(confirmProjectFile);

  return useCallback(
    async (params: {
      projectId: string;
      file: File;
      fileType: ProjectFileType;
      signal: AbortSignal;
      onProgress?: (p: UploadProgress) => void;
    }): Promise<{ file_id: string }> => {
      const { file, fileType, projectId, signal, onProgress } = params;

      onProgress?.({ phase: "uploading", percent: 5 });

      const prepared = await prepareFn({
        data: {
          project_id: projectId,
          file_name: file.name,
          mime_type: file.type,
          file_size: file.size,
          file_type: fileType,
        },
      });

      onProgress?.({ phase: "uploading", percent: 15 });

      const uploaded = await xhrUpload({
        url: prepared.signed_url,
        file,
        signal,
        onProgress: (p) => onProgress?.({ phase: "uploading", percent: 15 + Math.floor(p * 0.75) }),
      });
      if (!uploaded) throw new Error("Upload cancelado.");

      onProgress?.({ phase: "confirming", percent: 92 });

      await confirmFn({ data: { file_id: prepared.file_id } });

      onProgress?.({ phase: "done", percent: 100 });
      return { file_id: prepared.file_id };
    },
    [prepareFn, confirmFn],
  );
}

export function xhrUpload({
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
