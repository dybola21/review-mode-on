/**
 * Source-level invariants for prepareProjectFileUpload / confirmProjectFile.
 * These lock the ordering rules that we rely on for safety:
 *  - cleanup of expired pendencies runs BEFORE the uploaded+pending count.
 *  - confirmProjectFile updates with .select("id") so we can detect a
 *    zero-rows race and refuse the confirmation.
 *  - confirmProjectFile validates storage_path with isValidStoragePath
 *    before trusting it.
 *  - confirmProjectFile rejects missing MIME via the "mime_missing"
 *    validation branch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  path.resolve(process.cwd(), "src/lib/project-files.functions.ts"),
  "utf8",
);

describe("project-files.functions invariants", () => {
  it("cleanupExpiredProjectFiles runs before the uploaded+pending count", () => {
    const cleanupIdx = SRC.indexOf("cleanupExpiredProjectFiles(supabaseAdmin, data.project_id)");
    const countIdx = SRC.indexOf('.in("status", ["uploaded", "pending"])');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(countIdx);
  });

  it("confirmProjectFile validates storage_path before trusting it", () => {
    const pathGuardIdx = SRC.indexOf("isValidStoragePath(row.storage_path");
    const listIdx = SRC.indexOf(".list(parentPath");
    expect(pathGuardIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(-1);
    expect(pathGuardIdx).toBeLessThan(listIdx);
  });

  it("confirmProjectFile rejects mime_missing distinctly from mime_mismatch", () => {
    expect(SRC).toContain('validation === "mime_missing"');
    expect(SRC).toContain('validation === "mime_mismatch"');
  });

  it("confirmProjectFile selects updated rows so a zero-rows race is detected", () => {
    // The update chain must include .select("id") and a guard on updated.length !== 1.
    const updIdx = SRC.indexOf('.update({ status: "uploaded", upload_expires_at: null })');
    const selectAfterUpdate = SRC.indexOf('.select("id")', updIdx);
    expect(updIdx).toBeGreaterThan(-1);
    expect(selectAfterUpdate).toBeGreaterThan(updIdx);
    expect(SRC).toContain("updated.length !== 1");
  });
});
