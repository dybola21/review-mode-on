import path from "node:path";

// -----------------------------------------------------------------------
// Safe file name / path helpers. The worker owns all local paths — the
// client-supplied fileName is treated as opaque metadata for the output
// contract only, never as a local path.
// -----------------------------------------------------------------------

const SAFE_BASENAME_RE = /[^a-zA-Z0-9._-]+/g;

export function safeBaseName(name: string): string {
  const trimmed = (name ?? "").trim();
  const noPath = trimmed.replace(/[\\/]/g, "_");
  const cleaned = noPath.replace(SAFE_BASENAME_RE, "_").replace(/^\.+/, "_");
  const bounded = cleaned.slice(0, 128);
  return bounded.length > 0 ? bounded : "file";
}

/**
 * Ensure a resolved child path lives strictly under the parent directory.
 * Throws on any path-traversal attempt or symlink escape sequence.
 */
export function ensureInsideDir(parent: string, child: string): string {
  const p = path.resolve(parent);
  const c = path.resolve(parent, child);
  const rel = path.relative(p, c);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path_traversal_detected");
  }
  return c;
}

/** Build a per-job workspace directory name from the workerJobId. */
export function jobDirName(workerJobId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(workerJobId)) throw new Error("invalid_job_id");
  return workerJobId;
}
