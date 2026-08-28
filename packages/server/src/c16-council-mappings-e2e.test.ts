import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientSettingsStore } from "@rennet/adapters";
import type { ReviewRoleMapping } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { settingsHandlers } from "./dispatch/settings";
import { createSettingsComposition } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// C16 packet E2E (cluster 6, task 6.1) — the council mappings over the REAL
// command path: the real `settings.*` dispatch handlers (so every payload crosses
// `parseCommandInput`/`parseCommandOutput`), the real settings composition, the
// real core resolver over the real council tables, and the REAL on-disk
// `client-settings.json` store. Nothing is stubbed on the mapping path.
//
// The headline property is Rai's 2026-08-28 per-scenario ruling: an edit in ONE
// scenario column moves that column and NOTHING else. The E2E proves it the only
// way that can go red — by capturing the sibling columns BEFORE the write and
// deep-equalling them after a RELOAD (a brand-new store + composition + handler
// table over the same directory, so the on-disk bytes are the only survivor).
//
// Positive control: `expect(after.claudeOnly).toEqual(baseline.claudeOnly)` is
// exactly the assertion the pre-re-scope job-keyed shape failed — one edit moved
// all three columns. Flip `setRoleAssignment` back to writing a job-wide pick and
// this test reddens.
// ─────────────────────────────────────────────────────────────────────────────

/** Boot a whole settings stack over `dir` — nothing carried in memory from a prior boot. */
function boot(dir: string) {
  const store = createClientSettingsStore(join(dir, "client-settings.json"));
  let writes = 0;
  const settings = createSettingsComposition({
    // The council mappings ride the CLIENT-SETTINGS rung only; the project/repo
    // ladder is not on this path, so its effects are inert here.
    listProjects: () => [],
    loadConfigState: () => ({ status: "absent", config: null }),
    readGlobalState: () => store.readState(),
    updateGlobal: (update) => {
      writes += 1;
      return store.update(update);
    },
    readDaemonSettings: () => ({ version: 1 }),
    listPairedDevices: () => [],
    updateDaemon: (update) => update({ version: 1 }),
    gitTopLevel: async () => null,
    discoverWorkspaceRepos: async () => [],
    loadGuidance: () => ({ reason: "absent", dropped: 0 }),
    applyVisibility: async () => ({ changed: false, gitignorePath: "" }),
    clearRepoValue: () => {},
  });
  const handlers = settingsHandlers(createDispatchRuntime({ settings } as unknown as DispatchDeps));
  return {
    get: async (): Promise<readonly ReviewRoleMapping[]> => {
      const view = (await handlers["settings.get"]({})) as { reviewRoles?: ReviewRoleMapping[] };
      // Honest-present: the tables are static, so a read ALWAYS carries the roles.
      expect(view.reviewRoles).toBeDefined();
      return view.reviewRoles ?? [];
    },
    setRoleAssignment: (input: unknown) =>
      handlers["settings.setRoleAssignment"](input) as Promise<{
        reviewRoles: ReviewRoleMapping[];
      }>,
    writes: () => writes,
  };
}

const roleOf = (roles: readonly ReviewRoleMapping[], id: string): ReviewRoleMapping => {
  const role = roles.find((entry) => entry.id === id);
  if (!role) throw new Error(`no such review role: ${id}`);
  return role;
};

describe("C16 E2E — a role assignment edit over the real settings command path", () => {
  it("persists one (role, scenario) cell across a reload and leaves every sibling column alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c16-council-e2e-"));

    // ── STAGE. Boot 1 reads the mappings with nothing persisted. ──────────────
    const host1 = boot(dir);
    const baseline = await host1.get();
    expect(baseline).toHaveLength(8);
    // Every cell is the council table's own answer — no override exists yet.
    for (const role of baseline) {
      expect([role.dual.layer, role.claudeOnly.layer, role.codexOnly.layer]).toEqual([
        "default",
        "default",
        "default",
      ]);
    }
    // HONEST-UNASSIGNED: the Flagged Second Seat does not run under one provider,
    // so its single-provider cells are `null` — the em dash the surface renders,
    // never a fabricated model.
    const secondSeatBefore = roleOf(baseline, "second-seat");
    expect(secondSeatBefore.dual.value).not.toBeNull();
    expect(secondSeatBefore.claudeOnly.value).toBeNull();
    expect(secondSeatBefore.codexOnly.value).toBeNull();

    const before = roleOf(baseline, "lens-workers");
    expect(before.dual.value).toEqual({ model: "opus-4.8", effort: "high" });

    // ── EDIT. ONE scenario of ONE role, through the real write command. ───────
    const written = await host1.setRoleAssignment({
      roleId: "lens-workers",
      scenario: "dual",
      assignment: { model: "sonnet-5", effort: "medium" },
    });
    // The write FIRES ONCE — one config write, not a rewrite per column.
    expect(host1.writes()).toBe(1);
    // The response is the resolver's own re-resolution, adopted by the surface.
    expect(roleOf(written.reviewRoles, "lens-workers").dual).toEqual({
      value: { model: "sonnet-5", effort: "medium" },
      layer: "override",
    });

    // ── RELOAD. A brand-new stack over the same directory: only the bytes on ──
    // disk survive, exactly as a daemon restart.
    const reloaded = await boot(dir).get();
    const after = roleOf(reloaded, "lens-workers");

    // The change PERSISTS, carrying the provenance the chip renders.
    expect(after.dual).toEqual({
      value: { model: "sonnet-5", effort: "medium" },
      layer: "override",
    });
    // ── THE HEADLINE (per-scenario, Rai 2026-08-28). The sibling columns are ──
    // byte-identical to the pre-write baseline, values AND layer. A job-keyed
    // override would have moved all three; this is the assertion that reddens.
    expect(after.claudeOnly).toEqual(before.claudeOnly);
    expect(after.codexOnly).toEqual(before.codexOnly);
    expect(after.claudeOnly.layer).toBe("default");
    expect(after.codexOnly.layer).toBe("default");
    // …and no OTHER role moved at all.
    expect(reloaded.filter((role) => role.id !== "lens-workers")).toEqual(
      baseline.filter((role) => role.id !== "lens-workers"),
    );
    // Honest-unassigned survives the reload too.
    expect(roleOf(reloaded, "second-seat").claudeOnly.value).toBeNull();

    // On disk: exactly one job, exactly one scenario cell. Nothing broader was written.
    const onDisk = JSON.parse(readFileSync(join(dir, "client-settings.json"), "utf8")) as {
      routing?: { task?: Record<string, Record<string, unknown>> };
    };
    expect(onDisk.routing?.task).toEqual({
      "lens-draft": { dual: { model: "sonnet-5", effort: "medium" } },
    });

    // ── A SECOND COLUMN. Overriding `claudeOnly` now leaves `dual`'s own ──────
    // override standing — the columns are independent in both directions.
    const host2 = boot(dir);
    await host2.setRoleAssignment({
      roleId: "lens-workers",
      scenario: "claudeOnly",
      assignment: { model: "haiku", effort: "low" },
    });
    const both = roleOf(await boot(dir).get(), "lens-workers");
    expect(both.dual).toEqual({
      value: { model: "sonnet-5", effort: "medium" },
      layer: "override",
    });
    expect(both.claudeOnly).toEqual({
      value: { model: "haiku", effort: "low" },
      layer: "override",
    });
    expect(both.codexOnly).toEqual(before.codexOnly);

    // ── RESET. `null` clears ONE cell; the sibling override stays. ────────────
    const host3 = boot(dir);
    await host3.setRoleAssignment({ roleId: "lens-workers", scenario: "dual", assignment: null });
    const reset = roleOf(await boot(dir).get(), "lens-workers");
    expect(reset.dual).toEqual(before.dual);
    expect(reset.claudeOnly).toEqual({
      value: { model: "haiku", effort: "low" },
      layer: "override",
    });

    // Clearing the LAST cell drops the whole slice: an install that reset everything
    // is byte-identical to one that never overrode anything.
    await boot(dir).setRoleAssignment({
      roleId: "lens-workers",
      scenario: "claudeOnly",
      assignment: null,
    });
    expect(await boot(dir).get()).toEqual(baseline);
    const cleared = JSON.parse(readFileSync(join(dir, "client-settings.json"), "utf8")) as {
      routing?: unknown;
    };
    expect(cleared.routing).toBeUndefined();
  });
});
