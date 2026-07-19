import { timingSafeEqualString } from "./hmac.js";

/**
 * Extract bearer token from an Authorization header.
 * Returns null if missing/malformed. Case-insensitive scheme.
 */
export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const tok = m[1]?.trim();
  return tok && tok.length > 0 ? tok : null;
}

/** Compare a provided bearer against the expected API key in constant time. */
export function verifyBearer(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  // Reject accidental blank/short values before timing compare.
  if (provided.length < 8) return false;
  return timingSafeEqualString(provided, expected);
}
