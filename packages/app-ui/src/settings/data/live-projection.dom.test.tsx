// @vitest-environment happy-dom
//
// C10 §10.1 + C17 cluster 3 — the LIVE settings projection (the fold wiring). Proves the ONE
// projection field with a served backend is REAL, not honest-empty: agents come from
// `harness.hosts`, the SERVER-side per-host detection, so a card's Agents section shows that
// host's actual harnesses (real versions, no guesses); the enable toggle writes through the
// served store rather than a session set; and a host the daemon could not ask claims nothing.
// The Model Mappings dialog stays honest about the gap that IS unserved (no Model Council
// catalogue) instead of showing an empty grid.
import type { HarnessHostDetection } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { cleanup, mount, waitFor, within } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import { EnvironmentsPage } from "../environments/environments-page";
import { LiveSettingsProjectionProvider } from "./live-projection";

/** A bridge whose `harness.hosts` returns the given per-host detection verbatim. */
function detectBridge(hosts: readonly HarnessHostDetection[]) {
  return new MemoryBridge(
    { "harness.hosts": () => ({ hosts: hosts.map((host) => ({ ...host })) }) },
    { platform: "darwin", version: "1.0.1" },
  );
}

/** The local host, asked, reporting exactly these harnesses (all enabled). */
function localHost(
  detected: readonly { id: string; version: string | null }[],
): HarnessHostDetection {
  return {
    source: "local",
    asked: true,
    detected: detected.map((harness) => ({ ...harness, enabled: true })),
  };
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

describe("LiveSettingsProjectionProvider — agents wired live from harness.hosts", () => {
  it("renders the machine's detected harnesses on the local card, versions only when present", async () => {
    const { findByText, queryByText } = mountLive(
      detectBridge([
        localHost([
          { id: "claude", version: "2.1.0" },
          { id: "codex", version: null },
        ]),
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
    const { findByText } = mountLive(detectBridge([localHost([])]));
    expect(await findByText("Connect This Machine to detect its agents.")).toBeTruthy();
    cleanup();
  });

  it("a host that could NOT be asked shows the same honest line — never another host's agents", async () => {
    // POSITIVE CONTROL for the no-fabrication law: a WSL host really does have Claude, and
    // the LOCAL host could not be interrogated. Copy the answers across (bind `asked: false`
    // to some other host's rows) and this card would read "Claude 9.9.9" — it must not.
    const { findByText, queryByText } = mountLive(
      detectBridge([
        { source: "local", asked: false, detected: [] },
        {
          source: "wsl:Ubuntu",
          asked: true,
          detected: [{ id: "claude", version: "9.9.9", enabled: true }],
        },
      ]),
    );
    expect(await findByText("Connect This Machine to detect its agents.")).toBeTruthy();
    expect(queryByText("9.9.9")).toBeNull();
    cleanup();
  });

  it("disabling a detected agent writes through the SERVED store and re-reads it back", async () => {
    // The store lives in the bridge, not the component: the switch flips only because the
    // write persisted and the invalidated read returned the stored decision.
    const disabled = new Set<string>();
    const bridge = new MemoryBridge(
      {
        "harness.hosts": () => ({
          hosts: [
            {
              source: "local" as const,
              asked: true,
              detected: [{ id: "claude", version: "2.1.0", enabled: !disabled.has("claude") }],
            },
          ],
        }),
        "harness.setEnabled": (input) => {
          expect(input.source).toBe("local"); // scoped to the host the row belongs to.
          if (input.enabled) disabled.delete(input.harnessId);
          else disabled.add(input.harnessId);
          return { disabled: [...disabled] };
        },
      },
      { platform: "darwin", version: "1.0.1" },
    );
    const { findByRole, user } = mountLive(bridge);
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
    expect([...disabled]).toEqual(["claude"]);
    cleanup();
  });

  it("the Model Mappings dialog is honest about the unserved Model Council, not an empty grid", async () => {
    const { findByRole, findByText } = mountLive(
      detectBridge([
        localHost([
          { id: "claude", version: "2.1.0" },
          { id: "codex", version: "0.9.0" },
        ]),
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
