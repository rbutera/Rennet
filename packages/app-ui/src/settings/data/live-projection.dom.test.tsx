// @vitest-environment happy-dom
//
// C10 §10.1 + C17 cluster 3 — the LIVE settings projection (the fold wiring). Proves the ONE
// projection field with a served backend is REAL, not honest-empty: agents come from
// `harness.hosts`, the SERVER-side per-host detection, so a card's Agents section shows that
// host's actual harnesses (real versions, no guesses); the enable toggle writes through the
// served store rather than a session set; and a host the daemon could not ask claims nothing.
// The Model Mappings dialog stays honest about the gap that IS unserved (no Model Council
// catalogue) instead of showing an empty grid.
import type {
  DaemonHostSection,
  DaemonHostStatus,
  DetectedForge,
  HarnessHostDetection,
} from "@rennet/protocol";
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

// ── C17 cluster 4 — the folded projection over real bridge handlers ────────────
// Every host card is now the projection's, not a bridge synthesis: the enumeration +
// labels from `settings.get.daemonHosts`, the daemon line from `daemon.status`, the
// Source Control rows from `forge.detect`, the Agents rows from `harness.hosts`. The
// controls below are the honest-absence ones — a host that did not answer, and a read
// that rejected, must leave their sections EMPTY rather than borrow another host's
// answer or keep a stale row.

const LOCAL_SECTION: DaemonHostSection = {
  source: "local",
  label: "This machine",
  isLocal: true,
};
const WSL_SECTION: DaemonHostSection = {
  source: "wsl:Ubuntu",
  label: "WSL · Ubuntu",
  isLocal: false,
};

const GH_AVAILABLE: DetectedForge = {
  id: "github",
  version: "2.76.0",
  status: "available",
  detail: "Authenticated with GitHub through the `gh` CLI.",
};

/** A bridge serving the four reads the live projection folds. `forges: "reject"` makes
 *  `forge.detect` fail, so the Source Control section's honest fallback is provable. */
function foldBridge(options: {
  readonly sections: readonly DaemonHostSection[];
  readonly status?: readonly DaemonHostStatus[];
  readonly agents?: readonly HarnessHostDetection[];
  readonly forges?: readonly DetectedForge[] | "reject";
}) {
  return new MemoryBridge(
    {
      "settings.get": () => ({
        scheme: "system",
        schemeProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "system", effective: true }],
        },
        appearanceMalformed: false,
        projects: [],
        daemonHosts: options.sections.map((section) => ({ ...section })),
      }),
      "daemon.status": () => ({ hosts: (options.status ?? []).map((host) => ({ ...host })) }),
      "harness.hosts": () => ({ hosts: (options.agents ?? []).map((host) => ({ ...host })) }),
      "forge.detect": () => {
        if (options.forges === "reject") throw new Error("gh probe failed");
        return { detected: (options.forges ?? []).map((forge) => ({ ...forge })) };
      },
    },
    { platform: "darwin", version: "1.0.1" },
  );
}

function card(host: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-host="${host}"]`);
  if (!node) throw new Error(`host card ${host} not found`);
  return node;
}

describe("LiveSettingsProjectionProvider — host cards, source control + agents folded", () => {
  it("the local card carries the DAEMON's version, its agents and its forge CLI", async () => {
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION],
        status: [{ source: "local", reachable: true, version: "4.3.0" }],
        agents: [localHost([{ id: "claude", version: "2.1.0" }])],
        forges: [GH_AVAILABLE],
      }),
    );
    // The daemon line is the PROBED version (4.3.0), not the bridge's app version (1.0.1).
    expect(await findByText("Rennet daemon v4.3.0")).toBeTruthy();
    const local = within(card("local"));
    expect(local.getByText("GitHub")).toBeTruthy();
    expect(local.getByText("2.76.0")).toBeTruthy();
    // Two rows, both proven present by a real probe: the forge CLI and the harness.
    expect(local.getAllByText("Available")).toHaveLength(2);
    expect(local.getByText("Claude")).toBeTruthy();
    expect(local.getByText("2.1.0")).toBeTruthy();
    cleanup();
  });

  it("a second host renders ITS own daemon line + agents, and borrows no tooling", async () => {
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: true, version: "4.2.0" },
        ],
        agents: [
          localHost([{ id: "claude", version: "2.1.0" }]),
          {
            source: "wsl:Ubuntu",
            asked: true,
            detected: [{ id: "codex", version: "0.9.0", enabled: true }],
          },
        ],
        forges: [GH_AVAILABLE],
      }),
    );
    expect(await findByText("Rennet daemon v4.2.0")).toBeTruthy();
    const local = within(card("local"));
    const wsl = within(card("wsl:Ubuntu"));
    // Each card shows its OWN harness version and neither shows the other's.
    expect(local.getByText("2.1.0")).toBeTruthy();
    expect(local.queryByText("0.9.0")).toBeNull();
    expect(wsl.getByText("0.9.0")).toBeTruthy();
    expect(wsl.queryByText("2.1.0")).toBeNull();
    // `forge.detect` answered for the CONNECTED daemon only, so the WSL card's Source
    // Control is honestly empty rather than showing this machine's `gh`.
    expect(wsl.getByText("Connect WSL · Ubuntu to detect its tooling.")).toBeTruthy();
    expect(wsl.queryByText("2.76.0")).toBeNull();
    // And a host Rennet has no dial address for never claims to be the local machine.
    expect(wsl.queryByText("Local")).toBeNull();
    expect(wsl.getByText("wsl:Ubuntu")).toBeTruthy();
    cleanup();
  });

  it("an unreachable host reads its last-seen version, never the reachable host's", async () => {
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: false, lastSeenVersion: "4.1.0" },
        ],
        agents: [localHost([{ id: "claude", version: "2.1.0" }])],
        forges: [GH_AVAILABLE],
      }),
    );
    expect(await findByText("Not connected — last seen running Rennet daemon v4.1.0")).toBeTruthy();
    const wsl = within(card("wsl:Ubuntu"));
    // No running version is invented for it — the local 4.3.0 stays on the local card.
    expect(wsl.queryByText("Rennet daemon v4.3.0")).toBeNull();
    expect(wsl.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    cleanup();
  });

  it("a host the status read never mentions is unreachable with NO version at all", async () => {
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [{ source: "local", reachable: true, version: "4.3.0" }],
        agents: [localHost([{ id: "claude", version: "2.1.0" }])],
      }),
    );
    expect(await findByText("Not connected — daemon unreachable, version unknown")).toBeTruthy();
    cleanup();
  });

  it("a host that could not be asked shows no agents — never the local machine's", async () => {
    // HONEST ABSENCE control: bind `asked: false` to the local set and the WSL card would
    // read "Claude 2.1.0". It must read its own not-detected line instead.
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: true, version: "4.2.0" },
        ],
        agents: [
          localHost([{ id: "claude", version: "2.1.0" }]),
          { source: "wsl:Ubuntu", asked: false, detected: [] },
        ],
      }),
    );
    expect(await findByText("Connect WSL · Ubuntu to detect its agents.")).toBeTruthy();
    const wsl = within(card("wsl:Ubuntu"));
    expect(wsl.queryByText("Claude")).toBeNull();
    expect(wsl.queryByText("2.1.0")).toBeNull();
    cleanup();
  });

  it("POSITIVE CONTROL: a rejected forge.detect leaves Source Control empty, not stale", async () => {
    // Fabricate a row from anything other than a real answer — a cached one, a default
    // "GitHub / Not Installed" placeholder — and this fails.
    const { findByText, queryByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION],
        status: [{ source: "local", reachable: true, version: "4.3.0" }],
        agents: [localHost([{ id: "claude", version: "2.1.0" }])],
        forges: "reject",
      }),
    );
    expect(await findByText("Connect This Machine to detect its tooling.")).toBeTruthy();
    expect(queryByText("GitHub")).toBeNull();
    expect(queryByText("2.76.0")).toBeNull();
    cleanup();
  });

  it("a forge whose binary is gone drops its row rather than reporting a stale hit", async () => {
    // The rename-out-of-PATH invariant at DOM scale: `gh` absent ⇒ `not-installed` ⇒ the
    // row is not rendered at all, so nothing on screen claims a CLI that is not there.
    const { findByText, queryByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION],
        status: [{ source: "local", reachable: true, version: "4.3.0" }],
        agents: [localHost([{ id: "claude", version: "2.1.0" }])],
        forges: [
          {
            id: "github",
            version: null,
            status: "not-installed",
            detail: "The `gh` CLI was not found on this host.",
          },
        ],
      }),
    );
    expect(await findByText("Connect This Machine to detect its tooling.")).toBeTruthy();
    expect(queryByText("GitHub")).toBeNull();
    cleanup();
  });
});
