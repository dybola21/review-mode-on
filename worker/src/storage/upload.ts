import fs from "node:fs";
import { assertAllowedUrl, UrlAllowlistError } from "../security/url-allowlist.js";

export class UploadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly transient: boolean = false,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

interface UploadOptions {
  maxBytes: number;
  timeoutMs: number;
  allowedHosts: readonly string[];
  isProduction: boolean;
  /** External cancellation signal (job wall-clock or worker shutdown). */
  cancel?: AbortSignal;
}

/**
 * Upload a local file to a signed upload URL owned by the app server. We
 * never mutate the destination — the URL is used verbatim.
 *
 * The local per-attempt timeout AND the external `cancel` signal are wired
 * into the same AbortController, so any of them aborts the fetch.
 */
export async function uploadOutput(
  localPath: string,
  signedUploadUrl: string,
  mimeType: string,
  opts: UploadOptions,
): Promise<{ bytes: number }> {
  let url: URL;
  try {
    url = assertAllowedUrl(signedUploadUrl, opts.allowedHosts, "upload", opts.isProduction);
  } catch (err) {
    if (err instanceof UrlAllowlistError) throw new UploadError(err.code, err.message);
    throw new UploadError("invalid_upload_url", "URL de upload inválida.");
  }

  const stat = fs.statSync(localPath);
  if (stat.size === 0) throw new UploadError("output_empty", "Resultado vazio.");
  if (stat.size > opts.maxBytes) {
    throw new UploadError("output_too_large", "Resultado excede tamanho máximo.");
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (opts.cancel) {
    if (opts.cancel.aborted) controller.abort();
    else opts.cancel.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const stream = fs.createReadStream(localPath);
  let res: Response;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers: {
        "content-type": mimeType || "application/octet-stream",
        "content-length": String(stat.size),
      },
      body: stream as unknown as ReadableStream<Uint8Array>,
      signal: controller.signal,
      duplex: "half",
    };
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    if (opts.cancel) opts.cancel.removeEventListener("abort", onExternalAbort);
    if ((err as { name?: string })?.name === "AbortError") {
      throw new UploadError("output_upload_timeout", "Timeout no upload.", true);
    }
    throw new UploadError("output_upload_failed", "Falha no upload.", true);
  } finally {
    clearTimeout(timer);
    if (opts.cancel) opts.cancel.removeEventListener("abort", onExternalAbort);
  }

  if (res.status === 401 || res.status === 403) {
    throw new UploadError("output_upload_expired", "URL de upload expirada.", false);
  }
  if ([408, 425, 429, 500, 502, 503, 504].includes(res.status)) {
    throw new UploadError("output_upload_transient", "Falha temporária no upload.", true);
  }
  if (!res.ok) {
    throw new UploadError("output_upload_failed", "Falha no upload.", false);
  }
  return { bytes: stat.size };
}
