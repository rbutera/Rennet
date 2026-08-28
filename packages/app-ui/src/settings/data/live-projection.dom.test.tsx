// @vitest-environment happy-dom
//
// C10 §10.1 — the LIVE settings projection (the fold wiring). Proves the projection
// fields with a served backend are REAL, not honest-empty: agents come from
// `harness.detect`, so the local card's Agents section shows the machine's actual
// harnesses (real versions, no guesses) and the enable toggle is live; and the council
// review-role mappings come from `settings.get`, edited through
// `settings.setRoleAssignment` — one (role, scenario) cell per write (C16, #485).
import type { ReviewRoleMapping, SettingsView } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { cleanup, mount, waitFor, within } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import { EnvironmentsPage } from "../environments/environments-page";
import { LiveSettingsProjectionProvider } from "./live-projection";

/** A bridge whose `harness.detect` returns real detected harnesses (claude with a
 *  version, codex with none — the null-version case must render no version, no guess). */
function detectBridge(detected: readonly { id: string; version: string | null }[]) {
  return new MemoryBridge(
    { "harness.detect": () => ({ detected: [...detected] }) },
    { platform: "darwin", version: "1.0.1" },
  );
}

/** The council mappings the daemon serves, in the wire's `{value, layer}` shape. */
const SERVED_ROLES: readonly ReviewRoleMapping[] = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    hint: "The review seat.",
    dual: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
    claudeOnly: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
    codexOnly: { value: { model: "gpt-5.6-sol", effort: "high" }, layer: "default" },
  },
  {
    id: "second-seat",
    label: "Flagged Second Seat",
    hint: "Dual-provider only.",
    dual: { value: { model: "gpt-5.6-sol", effort: "high" }, layer: "default" },
    // Honest-null: the role does not run under one provider.
    claudeOnly: { value: null, layer: "default" },
    codexOnly: { value: null, layer: "default" },
  },
];

const VIEW: SettingsView = {
  scheme: "system",
  schemeProvenance: { layer: "builtin", contributions: [] },
  appearanceMalformed: false,
  projects: [],
  reviewRoles: [...SERVED_ROLES],
};

function mountLive(bridge: MemoryBridge) {
  return mount(
    <BridgeProvider bridge={bridge}>
      <LiveSettingsProjectionProvider>
        <EnvironmentsPage />
      </LiveSettingsProjectionProvider>
    </BridgeProvider>,
  );
}

describe("LiveSettingsProjectionProvider — agents wired live from harness.detect", () => {
  it("renders the machine's detected harnesses on the local card, versions only when present", async () => {
    const { findByText, queryByText } = mountLive(
      detectBridge([
        { id: "claude", version: "2.1.0" },
        { id: "codex", version: null },
      ]),
    );
    // Both detected harnesses appear in the shared row shape, both Available.
    expect(await findByText("Claude")).toBeTruthy();
    expect(await findByText("Codex")).toBeTruthy();
    expect(await findByText("2.1.0")).toBeTruthy();
    // A null-version harness shows NO version line — never a guess.
    expect(queryByText("null")).toBeNull();
    cleanup();
  });

  it("shows the honest not-detected line when the probe finds nothing", async () => {
    const { findByText } = mountLive(detectBridge([]));
    expect(await findByText("Connect This Machine to detect its agents.")).toBeTruthy();
    cleanup();
  });

  it("disabling a detected agent flips it live (session-local, no uninstall)", async () => {
    const { findByRole, user } = mountLive(detectBridge([{ id: "claude", version: "2.1.0" }]));
    const toggle = await findByRole("switch", { name: "Use Claude on This Machine" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() =>
      expect(
        within(document.body)
          .getByRole("switch", { name: "Use Claude on This Machine" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    cleanup();
  });

  it("the Model Mappings dialog reads the served council roles, honest-null included", async () => {
    const bridge = new MemoryBridge(
      {
        "harness.detect": () => ({
          detected: [
            { id: "claude" as const, version: "2.1.0" },
            { id: "codex" as const, version: "0.9.0" },
          ],
        }),
        "settings.get": () => VIEW,
      },
      { platform: "darwin", version: "1.0.1" },
    );
    const { findByRole } = mountLive(bridge);
    // Both detected + enabled ⇒ the Review section's Edit Mappings is live.
    const edit = await findByRole("button", { name: "Edit Mappings" });
    expect(edit.hasAttribute("disabled")).toBe(false);
    await edit.click();
    const dialog = () => within(document.body);
    await waitFor(() => expect(dialog().getAllByText("Orchestrator").length).toBeGreaterThan(0));
    // The SERVED values, not a local table copy.
    expect(dialog().getAllByText("opus-4.8").length).toBeGreaterThan(0);
    // Every served cell is `default` provenance ⇒ no chip, no Reset.
    expect(dialog().queryByText("Overridden")).toBeNull();
    expect(dialog().queryByText("Reset to default")).toBeNull();
    cleanup();
  });

  it("a cell edit writes ONE (role, scenario) cell and adopts the returned mappings", async () => {
    const writes: unknown[] = [];
    // A STATEFUL fake daemon: the write persists, so the invalidated `settings.get`
    // re-read agrees with the adopted response instead of blinking back.
    let stored: readonly ReviewRoleMapping[] = SERVED_ROLES;
    const bridge = new MemoryBridge(
      {
        "harness.detect": () => ({ detected: [{ id: "claude" as const, version: "2.1.0" }] }),
        "settings.get": () => ({ ...VIEW, reviewRoles: [...stored] }),
        "settings.setRoleAssignment": (input) => {
          writes.push(input);
          // The daemon's re-resolution: ONLY the edited column moved, and it now carries
          // `override` provenance. The client adopts THIS, never its own recomputation.
          stored = stored.map((role) =>
            role.id === input.roleId
              ? { ...role, [input.scenario]: { value: input.assignment, layer: "override" } }
              : role,
          );
          return { reviewRoles: [...stored] };
        },
      },
      { platform: "darwin", version: "1.0.1" },
    );
    const { findByRole, user } = mountLive(bridge);
    await user.click(await findByRole("button", { name: "Edit Mappings" }));
    const dialog = () => within(document.body);
    await waitFor(() => expect(dialog().getAllByText("Orchestrator").length).toBeGreaterThan(0));
    // Claude only ⇒ the editable column is `claudeOnly`.
    await user.click(dialog().getByRole("button", { name: "Orchestrator model" }));
    await user.click(dialog().getByRole("option", { name: "haiku" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      roleId: "orchestrator",
      scenario: "claudeOnly",
      // Model + effort only — no harness (#89), no client-asserted provenance.
      assignment: { model: "haiku", effort: "high" },
    });
    // The write's own answer is adopted: the chip appears without a manual re-read.
    await waitFor(() => expect(dialog().getAllByText("Overridden").length).toBe(1));
    expect(dialog().getAllByText("Reset to default").length).toBe(1);
    // PER-SCENARIO: the sibling columns of the same role never moved on disk.
    const orchestrator = stored.find((role) => role.id === "orchestrator");
    expect(orchestrator?.claudeOnly).toEqual({
      value: { model: "haiku", effort: "high" },
      layer: "override",
    });
    expect(orchestrator?.dual).toEqual({
      value: { model: "opus-4.8", effort: "high" },
      layer: "default",
    });
    expect(orchestrator?.codexOnly).toEqual({
      value: { model: "gpt-5.6-sol", effort: "high" },
      layer: "default",
    });
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C16 packet E2E (cluster 6, task 6.1) — the client half, driven not asserted. The
// server half (`packages/server/src/c16-council-mappings-e2e.test.ts`) runs the
// same sequence over the real dispatch + the real `client-settings.json`; this one
// runs it through the REAL surfaces — `EnvironmentsPage` → `ReviewSettings` → the
// Model Mappings dialog — over the REAL `settings.*` command names.
//
// The stand-in daemon holds ONE thing: a `(roleId, scenario) → pick` override map,
// resolved against a defaults table on every read. That is the per-scenario contract
// itself, so a client that wrote job-wide (or recomputed siblings locally) reddens
// the sibling-column assertions below.
// ─────────────────────────────────────────────────────────────────────────────

/** The council defaults the stand-in daemon resolves against — two roles is enough
 *  to count text occurrences exactly, and `second-seat` carries the honest-nulls. */
const E2E_DEFAULTS = {
  "lens-workers": {
    label: "Lens Drafters",
    dual: { model: "opus-4.8", effort: "high" },
    claudeOnly: { model: "opus-4.8", effort: "high" },
    codexOnly: { model: "gpt-5.6-sol", effort: "high" },
  },
  "second-seat": {
    label: "Flagged Second Seat",
    dual: { model: "gpt-5.6-sol", effort: "high" },
    // The role does not run under one provider — the em-dash cells.
    claudeOnly: null,
    codexOnly: null,
  },
} as const;

/** A stand-in daemon: per-(role, scenario) overrides layered over the defaults. */
function councilDaemon() {
  const overrides = new Map<string, { model: string; effort: string }>();
  const writes: unknown[] = [];
  const resolve = (): ReviewRoleMapping[] =>
    Object.entries(E2E_DEFAULTS).map(([id, def]) => {
      const cell = (scenario: "dual" | "claudeOnly" | "codexOnly") => {
        const override = overrides.get(`${id}:${scenario}`);
        if (override) return { value: override, layer: "override" as const };
        return { value: def[scenario], layer: "default" as const };
      };
      return {
        id,
        label: def.label,
        hint: "",
        dual: cell("dual"),
        claudeOnly: cell("claudeOnly"),
        codexOnly: cell("codexOnly"),
      } as ReviewRoleMapping;
    });
  const bridge = () =>
    new MemoryBridge(
      {
        "harness.detect": () => ({
          detected: [
            { id: "claude" as const, version: "2.1.0" },
            { id: "codex" as const, version: "0.9.0" },
          ],
        }),
        "settings.get": () => ({ ...VIEW, reviewRoles: resolve() }),
        "settings.setRoleAssignment": (input) => {
          writes.push(input);
          const key = `${input.roleId}:${input.scenario}`;
          // Writes or clears exactly ONE cell — siblings are never touched.
          if (input.assignment === null) overrides.delete(key);
          else overrides.set(key, input.assignment);
          return { reviewRoles: resolve() };
        },
      },
      { platform: "darwin", version: "1.0.1" },
    );
  return { bridge, writes, overrides };
}

describe("C16 E2E — edit one scenario, reload, and only that column moved", () => {
  it("drives the Review section end to end over the real settings commands", async () => {
    const daemon = councilDaemon();

    // ── STAGE. Mount the Environments page live and open the mappings dialog. ──
    const first = mountLive(daemon.bridge());
    await first.user.click(await first.findByRole("button", { name: "Edit Mappings" }));
    const dialog = () => within(document.body);
    await waitFor(() => expect(dialog().getAllByText("Lens Drafters").length).toBeGreaterThan(0));
    // Both agents enabled ⇒ Dual is the live column; the visible pair is dual + claudeOnly.
    // Both start at the council default, so `opus-4.8` appears TWICE and nothing is chipped.
    expect(dialog().getAllByText("opus-4.8")).toHaveLength(2);
    expect(dialog().queryByText("Overridden")).toBeNull();
    // HONEST-UNASSIGNED: the Flagged Second Seat's single-provider cell is an em dash.
    expect(dialog().getAllByText("—")).toHaveLength(1);

    // ── EDIT. One cell, in the Dual column only. ──────────────────────────────
    await first.user.click(dialog().getByRole("button", { name: "Lens Drafters model" }));
    await first.user.click(dialog().getByRole("option", { name: "sonnet-5" }));
    // The write fires ONCE, naming exactly the edited (role, scenario).
    await waitFor(() => expect(daemon.writes).toHaveLength(1));
    expect(daemon.writes[0]).toEqual({
      roleId: "lens-workers",
      scenario: "dual",
      assignment: { model: "sonnet-5", effort: "high" },
    });
    // The chip appears on that one cell; the sibling column still reads the default.
    await waitFor(() => expect(dialog().getAllByText("Overridden")).toHaveLength(1));
    expect(dialog().getAllByText("sonnet-5")).toHaveLength(1);
    expect(dialog().getAllByText("opus-4.8")).toHaveLength(1);

    // ── RELOAD. Unmount everything and mount a COLD page over the same daemon: ─
    // a fresh bridge, a fresh command cache, a fresh `settings.get`. Only what the
    // daemon persisted survives.
    cleanup();
    const reloaded = mountLive(daemon.bridge());
    await reloaded.user.click(await reloaded.findByRole("button", { name: "Edit Mappings" }));
    await waitFor(() => expect(dialog().getAllByText("Lens Drafters").length).toBeGreaterThan(0));
    // The change PERSISTED, and it still carries its provenance chip.
    expect(dialog().getAllByText("sonnet-5")).toHaveLength(1);
    expect(dialog().getAllByText("Overridden")).toHaveLength(1);
    // ── THE HEADLINE (per-scenario, Rai 2026-08-28). The sibling column never ──
    // moved: it still renders the council default, unchipped. A job-keyed write
    // would show `sonnet-5` twice and two chips — this is the assertion that reddens.
    expect(dialog().getAllByText("opus-4.8")).toHaveLength(1);
    expect(daemon.overrides.has("lens-workers:claudeOnly")).toBe(false);
    expect(daemon.overrides.has("lens-workers:codexOnly")).toBe(false);
    // …and the honest em dash survived the reload too.
    expect(dialog().getAllByText("—")).toHaveLength(1);

    // ── RESET. Clears the one overridden column, back to the council table. ───
    await reloaded.user.click(dialog().getByRole("button", { name: /Reset to default/ }));
    await waitFor(() => expect(dialog().queryByText("Overridden")).toBeNull());
    expect(dialog().getAllByText("opus-4.8")).toHaveLength(2);
    expect(daemon.overrides.size).toBe(0);
    cleanup();
  });
});
