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
    await user.click(dialog().getAllByRole("button", { name: "Orchestrator model" })[0]);
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
