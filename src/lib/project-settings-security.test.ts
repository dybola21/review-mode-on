import { describe, expect, it, vi } from "vitest";
import { applyOwnedProjectPatch, assertProjectOwnership } from "./project-config.functions";

// -------------------------------------------------------------------------
// Fake supabase clients — mimic the fluent PostgREST builder just enough to
// let us assert what the real code sends to the DB.
// -------------------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeRlsClient(opts: { ownedRow: Row | null }) {
  return {
    from() {
      const filters: Row = {};
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        async maybeSingle() {
          return { data: opts.ownedRow, error: null };
        },
      };
      return builder;
    },
  };
}

function fakeAdminClient(opts: { updateReturns: Row[]; onUpdate?: (patch: Row) => void }) {
  const calls: Array<{ table: string; patch: Row; filters: Row; selected: string[] }> = [];
  const client = {
    _calls: calls,
    from(table: string) {
      return {
        update(patch: Row) {
          opts.onUpdate?.(patch);
          const filters: Row = {};
          const selected: string[] = [];
          const chain = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            select(cols: string) {
              selected.push(cols);
              calls.push({ table, patch, filters, selected });
              return Promise.resolve({ data: opts.updateReturns, error: null });
            },
          };
          return chain;
        },
      };
    },
  };
  return client;
}

// -------------------------------------------------------------------------

describe("assertProjectOwnership", () => {
  it("passes when RLS returns the row", async () => {
    const rls = fakeRlsClient({ ownedRow: { id: "p1" } });
    await expect(assertProjectOwnership(rls, "p1")).resolves.toBeUndefined();
  });

  it("rejects another user (RLS returns null)", async () => {
    const rls = fakeRlsClient({ ownedRow: null });
    await expect(assertProjectOwnership(rls, "p1")).rejects.toThrow(/Projeto não encontrado/);
  });
});

describe("applyOwnedProjectPatch", () => {
  it("scopes updates to (id, user_id) and asks for id back", async () => {
    const admin = fakeAdminClient({ updateReturns: [{ id: "p1" }] });
    await applyOwnedProjectPatch(admin, {
      projectId: "p1",
      userId: "u1",
      patch: { template_settings: { header_image_fit: "cover" } },
    });
    const call = admin._calls[0];
    expect(call.table).toBe("projects");
    expect(call.filters).toEqual({ id: "p1", user_id: "u1" });
    expect(call.selected).toEqual(["id"]);
  });

  it("never forwards user_id, status, or unknown fields from the caller", async () => {
    const admin = fakeAdminClient({ updateReturns: [{ id: "p1" }] });
    await applyOwnedProjectPatch(admin, {
      projectId: "p1",
      userId: "u1",
      // Cast: simulate a malicious client trying to smuggle server-owned fields.
      patch: {
        template_settings: { header_image_fit: "cover" },
        // @ts-expect-error — proving the allow-list drops these
        user_id: "attacker",
        // @ts-expect-error — proving the allow-list drops these
        status: "completed",
        // @ts-expect-error — proving the allow-list drops these
        worker_job_id: "xxx",
      },
    });
    const patch = admin._calls[0].patch;
    expect(patch).toEqual({ template_settings: { header_image_fit: "cover" } });
    expect(patch).not.toHaveProperty("user_id");
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("worker_job_id");
  });

  it("throws when the RLS scope updated zero rows (owner mismatch)", async () => {
    const admin = fakeAdminClient({ updateReturns: [] });
    await expect(
      applyOwnedProjectPatch(admin, {
        projectId: "p1",
        userId: "attacker",
        patch: { variation_settings: { variation_count: 3 } },
      }),
    ).rejects.toThrow(/Projeto não encontrado/);
  });

  it("throws when nothing to update", async () => {
    const admin = fakeAdminClient({ updateReturns: [{ id: "p1" }] });
    await expect(
      applyOwnedProjectPatch(admin, {
        projectId: "p1",
        userId: "u1",
        patch: {},
      }),
    ).rejects.toThrow(/Nada para atualizar/);
  });

  it("accepts a project whose status is server-controlled (processing/failed)", async () => {
    // Regression: the previous RLS-only path failed with 42501 whenever the
    // project had status='processing' or 'failed' because the projects UPDATE
    // WITH CHECK only allows draft/ready/archived. The service-role writer
    // bypasses that WITH CHECK; we still refuse to write status ourselves.
    const seenPatches: Row[] = [];
    const admin = fakeAdminClient({
      updateReturns: [{ id: "p1" }],
      onUpdate: (p) => seenPatches.push(p),
    });
    await applyOwnedProjectPatch(admin, {
      projectId: "p1",
      userId: "u1",
      patch: {
        variation_settings: { variation_count: 5 },
        variation_count: 5,
      },
    });
    expect(seenPatches[0]).not.toHaveProperty("status");
    expect(seenPatches[0]).toEqual({
      variation_settings: { variation_count: 5 },
      variation_count: 5,
    });
  });
});

describe("RLS policy invariants (documented as a regression contract)", () => {
  it("documents that projects UPDATE WITH CHECK forbids status ∈ (processing,failed,completed)", () => {
    // This test encodes the required RLS shape as living documentation. If a
    // future migration widens the projects UPDATE policy to accept any of
    // these server-controlled statuses from the client, this assertion must
    // be revisited alongside the migration.
    const CLIENT_ALLOWED_STATUSES = new Set(["draft", "ready", "archived"]);
    const SERVER_ONLY_STATUSES = ["processing", "completed", "failed"];
    for (const s of SERVER_ONLY_STATUSES) {
      expect(CLIENT_ALLOWED_STATUSES.has(s)).toBe(false);
    }
  });
});

// Sanity: keep vi imported so this file has a chance to grow.
vi.fn();
