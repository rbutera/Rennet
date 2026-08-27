// @vitest-environment happy-dom
//
// C10 §10.1 — the LIVE settings projection (the fold wiring). Proves the ONE
// projection field with a served backend post-fold is REAL, not honest-empty:
// agents come from `harness.detect`, so the local card's Agents section shows the
// machine's actual harnesses (real versions, no guesses), the enable toggle is live,
// and the Review section reacts. The Model Mappings dialog stays honest about the gap
// that IS unserved (no Model Council catalogue) instead of showing an empty grid.
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

  it("the Model Mappings dialog is honest about the unserved Model Council, not an empty grid", async () => {
    const { findByRole, findByText } = mountLive(
      detectBridge([
        { id: "claude", version: "2.1.0" },
        { id: "codex", version: "0.9.0" },
      ]),
    );
    // Both detected + enabled ⇒ the Review section's Edit Mappings is live.
    const edit = await findByRole("button", { name: "Edit Mappings" });
    expect(edit.hasAttribute("disabled")).toBe(false);
    await edit.click();
    // No served role catalogue ⇒ an honest line, never an empty mode-switch grid.
    expect(await findByText(/Model Council is served/)).toBeTruthy();
    cleanup();
  });
});
