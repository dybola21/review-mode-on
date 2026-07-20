/**
 * Pure validators used by confirmProjectFile. Extracted so we can unit-test
 * the rejection rules without a live Supabase Storage.
 */

export type StorageObjectMeta = {
  size?: number;
  mimetype?: string;
};

export type ConfirmValidationError =
  | "not_found"
  | "empty"
  | "size_mismatch"
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
  const mime = typeof params.meta?.mimetype === "string" ? params.meta.mimetype : "";
  if (size <= 0) return "empty";
  if (size !== params.expectedSize) return "size_mismatch";
  if (mime && mime !== params.expectedMime) return "mime_mismatch";
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
