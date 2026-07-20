/**
 * Classifies the response from a POST /jobs call to the render worker into
 * a stable (code, message) pair used to fail the render_job row.
 *
 * The classifier never returns bodies, URLs, or secrets. It only reads:
 *   - HTTP status
 *   - the `error` string from a safely-parsed JSON envelope
 */

export type WorkerFailure = {
  code:
    | "worker_contract_invalid"
    | "worker_url_not_allowed"
    | "worker_auth_failed"
    | "worker_unavailable"
    | "worker_unreachable"
    | "worker_rejected"
    | "worker_invalid_response";
  message: string;
};

/**
 * Safely parses the worker JSON response body.
 * Returns the `error` field when the body is `{ error: string }`; otherwise
 * returns null. Never throws.
 */
export function parseWorkerErrorEnvelope(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as { error?: unknown }).error;
  return typeof e === "string" ? e : null;
}

/**
 * Maps (status, error) → stable failure code + user-facing message.
 * `error` is the value returned by `parseWorkerErrorEnvelope` (may be null).
 * Status 2xx is not a failure; callers should not invoke this on success.
 */
export function classifyWorkerHttpFailure(status: number, error: string | null): WorkerFailure {
  if (status === 400 && error === "invalid_payload") {
    return {
      code: "worker_contract_invalid",
      message: "Contrato de processamento incompatível.",
    };
  }
  if (status === 400 && error === "url_not_allowed") {
    return {
      code: "worker_url_not_allowed",
      message: "Configuração de armazenamento não autorizada.",
    };
  }
  if (status === 400) {
    return {
      code: "worker_rejected",
      message: "Servidor rejeitou a solicitação.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: "worker_auth_failed",
      message: "Falha de autenticação com o servidor de processamento.",
    };
  }
  if (status === 503) {
    return {
      code: "worker_unavailable",
      message: "Servidor temporariamente indisponível.",
    };
  }
  // Every other non-2xx: treat as a rejection, NOT as unreachable.
  return {
    code: "worker_rejected",
    message: "Servidor rejeitou a solicitação.",
  };
}

/** Timeouts, DNS failures, TCP resets, etc. — the request never got a response. */
export const WORKER_UNREACHABLE: WorkerFailure = {
  code: "worker_unreachable",
  message: "Servidor temporariamente indisponível.",
};

/** 2xx with a malformed / missing workerJobId. */
export const WORKER_INVALID_RESPONSE: WorkerFailure = {
  code: "worker_invalid_response",
  message: "Resposta do servidor de processamento inválida.",
};
