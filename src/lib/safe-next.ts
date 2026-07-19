/**
 * Aceita apenas caminhos internos ("/algo") e rejeita "//..." ou URLs externas.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;
  if (typeof next !== "string") return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  if (next.startsWith("/\\")) return null;
  return next;
}
