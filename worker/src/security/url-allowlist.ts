/**
 * URL / host allowlist checks. Signed URLs delivered by the Lovable app
 * must resolve to hostnames the operator explicitly configured. We reject
 * any non-https URL in production (except localhost in dev) to prevent
 * accidental exfiltration through http.
 */

export type UrlKind = "download" | "upload";

export function assertAllowedUrl(
  raw: string,
  allowedHosts: readonly string[],
  kind: UrlKind,
  isProduction: boolean,
): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlAllowlistError(`invalid_${kind}_url`, "URL malformada.", null);
  }
  if (u.protocol !== "https:") {
    const localhostOk = !isProduction && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if (!localhostOk) {
      throw new UrlAllowlistError(`insecure_${kind}_url`, "URL não HTTPS não permitida.", u.hostname);
    }
  }
  const host = u.hostname.toLowerCase();
  const ok = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) {
    throw new UrlAllowlistError(`host_not_allowed_${kind}`, "Host não permitido.", host);
  }
  return u;
}

export class UrlAllowlistError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hostname: string | null = null,
  ) {
    super(message);
    this.name = "UrlAllowlistError";
  }
}

