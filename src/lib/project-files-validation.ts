/**
 * Pure validators used by prepare/confirm project file. Extracted so we can
 * unit-test the rejection rules without a live Supabase Storage.
 */

export type StorageObjectMeta = {
  size?: number;
  mimetype?: string;
};

export type ConfirmValidationError =
  | "not_found"
  | "empty"
  | "size_mismatch"
  | "mime_missing"
  | "mime_mismatch"
  | "expired";

export function validateStorageObject(params: {
  found: boolean;
  meta: StorageObjectMeta | null | undefined;
  expectedSize: number;
  expectedMime: string;
}): ConfirmValidationError | null {
  if (!params.found) return "not_found";
  const size = typeof params.meta?.size === "number" ? params.meta.size : 0;
  const mime = typeof params.meta?.mimetype === "string" ? params.meta.mimetype.trim() : "";
  if (size <= 0) return "empty";
  if (size !== params.expectedSize) return "size_mismatch";
  if (!mime) return "mime_missing";
  if (mime !== params.expectedMime) return "mime_mismatch";
  return null;
}

export function isUploadExpired(
  uploadExpiresAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!uploadExpiresAt) return false;
  const t = new Date(uploadExpiresAt).getTime();
  return Number.isFinite(t) && t < now;
}

/**
 * Storage-path invariant: the server-owned path MUST be exactly
 * `${userId}/${projectId}/${fileId}/<file-name>` with no traversal, no
 * double slashes, and no backslashes. Called before trusting a
 * server-stored path when confirming an upload.
 */
export function isValidStoragePath(
  path: string | null | undefined,
  userId: string,
  projectId: string,
  fileId: string,
): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\\")) return false;
  if (path.includes("..")) return false;
  if (path.includes("//")) return false;
  const prefix = `${userId}/${projectId}/${fileId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return false;
  if (rest.includes("/")) return false;
  return true;
}
