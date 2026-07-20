/**
 * Unit tests for cleanupExpiredProjectFiles.
 *
 * These lock the semantics required by the 3-fix-A micropatch:
 *  - If expire_pending_project_files RPC fails, cleanup must throw a
 *    transient error and NOT proceed to any counting logic.
 *  - If Storage.remove fails for a bucket, the corresponding rows must
 *    be preserved as `expired` (i.e. NOT deleted from the DB).
 *  - If Storage.remove succeeds, the rows are deletable from the DB.
 */
import { describe, it, expect, vi } from "vitest";
import { cleanupExpiredProjectFiles } from "./project-files.functions";

type ExpiredRow = { id: string; storage_path: string; file_type: string };

interface FakeOptions {
  rpcError?: { message: string } | null;
  expired?: ExpiredRow[];
  removeError?: { message: string } | null;
  // Per-bucket override; if provided, wins over removeError.
  removeErrorByBucket?: Record<string, { message: string } | null>;
}

function makeFakeSupabase(opts: FakeOptions) {
  const deleteCalls: { ids: string[] }[] = [];
  const removeCalls: { bucket: string; paths: string[] }[] = [];

  const client = {
    rpc: vi.fn(async (_name: string) => ({ error: opts.rpcError ?? null })),
    from(_table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq: async () => ({ data: opts.expired ?? [], error: null }),
              };
            },
          };
        },
        delete() {
          return {
            in: async (_col: string, ids: string[]) => {
              deleteCalls.push({ ids });
              return { error: null };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          remove: async (paths: string[]) => {
            removeCalls.push({ bucket, paths });
            const err =
              opts.removeErrorByBucket && bucket in opts.removeErrorByBucket
                ? opts.removeErrorByBucket[bucket]
                : (opts.removeError ?? null);
            return { error: err ?? null };
          },
        };
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, deleteCalls, removeCalls };
}

describe("cleanupExpiredProjectFiles", () => {
  it("throws transient error when the RPC fails and does NOT continue", async () => {
    const { client, deleteCalls, removeCalls } = makeFakeSupabase({
      rpcError: { message: "boom" },
      expired: [{ id: "a", storage_path: "u/p/a/f", file_type: "source_video" }],
    });

    await expect(cleanupExpiredProjectFiles(client, "project-1")).rejects.toThrow(
      /Falha temporária/i,
    );
    expect(removeCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it("preserves rows as expired when Storage.remove fails", async () => {
    const { client, deleteCalls, removeCalls } = makeFakeSupabase({
      expired: [
        { id: "a", storage_path: "u/p/a/f", file_type: "source_video" }, // bucket: project-inputs
        { id: "b", storage_path: "u/p/b/g", file_type: "logo" }, // bucket: project-assets
      ],
      removeErrorByBucket: {
        "project-inputs": { message: "storage down" },
        "project-assets": null,
      },
    });

    await cleanupExpiredProjectFiles(client, "project-1");

    expect(removeCalls).toHaveLength(2);
    // Only the successful bucket's row (b) is deleted from DB. Row (a) stays expired.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.ids).toEqual(["b"]);
  });

  it("deletes rows from DB when Storage.remove succeeds", async () => {
    const { client, deleteCalls } = makeFakeSupabase({
      expired: [
        { id: "a", storage_path: "u/p/a/f", file_type: "source_video" },
        { id: "b", storage_path: "u/p/b/g", file_type: "logo" },
      ],
      removeError: null,
    });

    await cleanupExpiredProjectFiles(client, "project-1");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.ids.sort()).toEqual(["a", "b"]);
  });

  it("is a no-op when there are no expired rows", async () => {
    const { client, deleteCalls, removeCalls } = makeFakeSupabase({ expired: [] });
    await cleanupExpiredProjectFiles(client, "project-1");
    expect(removeCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });
});
