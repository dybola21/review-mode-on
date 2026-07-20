import { describe, expect, it } from "vitest";
import {
  classifyWorkerHttpFailure,
  parseWorkerErrorEnvelope,
  WORKER_INVALID_RESPONSE,
  WORKER_UNREACHABLE,
} from "./worker-response";

describe("parseWorkerErrorEnvelope", () => {
  it("returns the error string from a valid envelope", () => {
    expect(parseWorkerErrorEnvelope({ error: "invalid_payload" })).toBe("invalid_payload");
  });
  it("returns null for missing, wrong-type or malformed bodies", () => {
    expect(parseWorkerErrorEnvelope(null)).toBeNull();
    expect(parseWorkerErrorEnvelope(undefined)).toBeNull();
    expect(parseWorkerErrorEnvelope("string")).toBeNull();
    expect(parseWorkerErrorEnvelope({})).toBeNull();
    expect(parseWorkerErrorEnvelope({ error: 42 })).toBeNull();
  });
});

describe("classifyWorkerHttpFailure", () => {
  it("400 invalid_payload → worker_contract_invalid", () => {
    const r = classifyWorkerHttpFailure(400, "invalid_payload");
    expect(r.code).toBe("worker_contract_invalid");
    expect(r.message).toBe("Contrato de processamento incompatível.");
  });
  it("400 url_not_allowed → worker_url_not_allowed", () => {
    const r = classifyWorkerHttpFailure(400, "url_not_allowed");
    expect(r.code).toBe("worker_url_not_allowed");
    expect(r.message).toBe("Configuração de armazenamento não autorizada.");
  });
  it("400 unknown error → worker_rejected (not unreachable)", () => {
    const r = classifyWorkerHttpFailure(400, "something_else");
    expect(r.code).toBe("worker_rejected");
  });
  it("400 null body → worker_rejected", () => {
    expect(classifyWorkerHttpFailure(400, null).code).toBe("worker_rejected");
  });
  it("401 → worker_auth_failed", () => {
    expect(classifyWorkerHttpFailure(401, null).code).toBe("worker_auth_failed");
  });
  it("403 → worker_auth_failed", () => {
    expect(classifyWorkerHttpFailure(403, null).code).toBe("worker_auth_failed");
  });
  it("503 → worker_unavailable", () => {
    expect(classifyWorkerHttpFailure(503, null).code).toBe("worker_unavailable");
  });
  it("500 → worker_rejected (never blanket-unreachable)", () => {
    expect(classifyWorkerHttpFailure(500, null).code).toBe("worker_rejected");
  });
  it("502 → worker_rejected (never blanket-unreachable)", () => {
    expect(classifyWorkerHttpFailure(502, null).code).toBe("worker_rejected");
  });
  it("504 → worker_rejected (never blanket-unreachable)", () => {
    expect(classifyWorkerHttpFailure(504, null).code).toBe("worker_rejected");
  });
});

describe("worker sentinel failures", () => {
  it("WORKER_UNREACHABLE is only for network/timeout, not HTTP status", () => {
    expect(WORKER_UNREACHABLE.code).toBe("worker_unreachable");
  });
  it("WORKER_INVALID_RESPONSE is used for 2xx with bad body", () => {
    expect(WORKER_INVALID_RESPONSE.code).toBe("worker_invalid_response");
  });
});
