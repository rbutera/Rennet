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
  ForgeHostDetection,
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

/** One host, asked, with exactly these forge CLIs — the common `forge.hosts` fixture. */
function forgeHost(source: string, detected: readonly DetectedForge[]): ForgeHostDetection {
  return { source: source as "local", asked: true, detected: [...detected] };
}

/** A bridge serving the reads the live projection folds. `forges: "reject"` makes
 *  `forge.hosts` fail, so the Source Control section's honest fallback is provable.
 *  `reconnect` / `update` are the served operations: each may mutate `status` (a host that
 *  comes back, a daemon on its new version) or refuse, and the card must follow the STATUS,
 *  never the click. */
function foldBridge(options: {
  readonly sections: readonly DaemonHostSection[];
  readonly status?: readonly DaemonHostStatus[];
  readonly agents?: readonly HarnessHostDetection[];
  readonly forges?: readonly ForgeHostDetection[] | "reject";
  readonly reconnect?: (source: string) => Promise<{ status: DaemonHostStatus; error?: string }>;
  readonly update?: (source: string) => Promise<{ status: DaemonHostStatus; error?: string }>;
}) {
  let status = options.status ?? [];
  return new MemoryBridge(
    {
      "daemon.reconnect": async (input) => {
        if (!options.reconnect) throw new Error("no reconnect handler wired");
        const outcome = await options.reconnect(input.source);
        // The served operation IS the source of truth: whatever it decided this host's
        // status now is, that is what the invalidated `daemon.status` read returns.
        status = status.map((host) => (host.source === input.source ? outcome.status : host));
        return outcome;
      },
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
      "daemon.status": () => ({ hosts: status.map((host) => ({ ...host })) }),
      "harness.hosts": () => ({ hosts: (options.agents ?? []).map((host) => ({ ...host })) }),
      "forge.hosts": () => {
        if (options.forges === "reject") throw new Error("gh probe failed");
        return { hosts: (options.forges ?? []).map((host) => ({ ...host })) };
      },
      "daemon.update": async (input) => {
        if (!options.update) throw new Error("no update handler wired");
        const outcome = await options.update(input.source);
        // The served operation IS the source of truth: the refreshed `daemon.status` read
        // carries whatever it decided this host's status now is.
        status = status.map((host) => (host.source === input.source ? outcome.status : host));
        return outcome;
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
        forges: [forgeHost("local", [GH_AVAILABLE])],
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
        forges: [forgeHost("local", [GH_AVAILABLE])],
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
    // The WSL host reported `asked: false`, so its Source Control is honestly empty rather
    // than showing this machine's `gh`.
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
        forges: [forgeHost("local", [GH_AVAILABLE])],
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
          forgeHost("local", [
            {
              id: "github",
              version: null,
              status: "not-installed",
              detail: "The `gh` CLI was not found on this host.",
            },
          ]),
        ],
      }),
    );
    expect(await findByText("Connect This Machine to detect its tooling.")).toBeTruthy();
    expect(queryByText("GitHub")).toBeNull();
    cleanup();
  });
});

// ── C17 amendment B — every host's Source Control section is fillable ─────────
// `forge.detect` answers for ONE daemon, so keying its rows to the connected host left every
// other card structurally unfillable: a distro with its own `gh` could never show it. The
// per-host `forge.hosts` read fixes that without letting a card borrow another's tooling.

describe("LiveSettingsProjectionProvider — per-host forge detection", () => {
  it("a WSL card shows ITS OWN gh, with the distro's version — not this machine's", async () => {
    // POSITIVE CONTROL for amendment B: key the rows to the connected host again and the WSL
    // card falls back to "Connect … to detect its tooling" about a host that HAS the CLI.
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: true, version: "4.3.0" },
        ],
        forges: [
          forgeHost("local", [GH_AVAILABLE]),
          forgeHost("wsl:Ubuntu", [{ ...GH_AVAILABLE, version: "2.40.0" }]),
        ],
      }),
    );
    await findByText("2.40.0");
    const wsl = within(card("wsl:Ubuntu"));
    const local = within(card("local"));
    // Each card carries its own version and neither borrows the other's.
    expect(wsl.getByText("GitHub")).toBeTruthy();
    expect(wsl.queryByText("2.76.0")).toBeNull();
    expect(local.getByText("2.76.0")).toBeTruthy();
    expect(local.queryByText("2.40.0")).toBeNull();
    cleanup();
  });

  it("a host that could NOT be asked keeps its honest line — never the other host's gh", async () => {
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [{ source: "local", reachable: true, version: "4.3.0" }],
        forges: [
          forgeHost("local", [GH_AVAILABLE]),
          { source: "wsl:Ubuntu", asked: false, detected: [] },
        ],
      }),
    );
    expect(await findByText("Connect WSL · Ubuntu to detect its tooling.")).toBeTruthy();
    expect(within(card("wsl:Ubuntu")).queryByText("2.76.0")).toBeNull();
    cleanup();
  });
});

// ── C17 review findings 3 + 7 — the two emptinesses, and the pending ruling ───

describe("LiveSettingsProjectionProvider — asked-and-empty is not unasked", () => {
  it("POSITIVE CONTROL: a host probed with nothing installed says so, and is not told to connect", async () => {
    // Drop asked-with-no-rows on the floor (the old fold) and both cards fall back to
    // "Connect …" — telling a machine Rennet just probed to connect itself.
    const { findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: true, version: "4.3.0" },
        ],
        agents: [
          { source: "local", asked: true, detected: [] },
          { source: "wsl:Ubuntu", asked: false, detected: [] },
        ],
        forges: [
          { source: "local", asked: true, detected: [] },
          { source: "wsl:Ubuntu", asked: false, detected: [] },
        ],
      }),
    );
    // Asked, nothing there — a real answer about a real machine.
    expect(await findByText("No coding agents detected on This Machine.")).toBeTruthy();
    expect(await findByText("No source-control CLIs detected on This Machine.")).toBeTruthy();
    // Not asked — an unknown, and the card says which one it is.
    const wsl = within(card("wsl:Ubuntu"));
    expect(wsl.getByText("Connect WSL · Ubuntu to detect its agents.")).toBeTruthy();
    expect(wsl.getByText("Connect WSL · Ubuntu to detect its tooling.")).toBeTruthy();
    cleanup();
  });

  it("POSITIVE CONTROL: a forge row waits for the served ruling instead of defaulting to enabled", async () => {
    // Review finding 7: with the ruling read still in flight (or rejected), rendering the row
    // "enabled" paints a PERSISTED ruled-out decision as an enabled switch. Render the rows
    // before the ruling arrives and the toggle below appears reading on.
    const bridge = new MemoryBridge(
      {
        "settings.get": () => ({
          scheme: "system" as const,
          schemeProvenance: {
            layer: "builtin" as const,
            contributions: [{ layer: "builtin" as const, value: "system", effective: true }],
          },
          appearanceMalformed: false,
          projects: [],
          daemonHosts: [{ ...LOCAL_SECTION }],
        }),
        "daemon.status": () => ({
          hosts: [{ source: "local" as const, reachable: true, version: "4.3.0" }],
        }),
        // The ruling read never answers — the state the fold has to be honest about.
        "harness.hosts": () => new Promise<never>(() => undefined),
        "forge.hosts": () => ({
          hosts: [{ source: "local" as const, asked: true, detected: [{ ...GH_AVAILABLE }] }],
        }),
      },
      { platform: "darwin", version: "1.0.1" },
    );
    const { findByText, queryByRole } = mountLive(bridge);
    // The section holds its honest empty state rather than showing a row whose switch would
    // be guessing at a decision the viewer may already have made.
    expect(await findByText("Connect This Machine to detect its tooling.")).toBeTruthy();
    expect(queryByRole("switch", { name: "Use GitHub on This Machine" })).toBeNull();
    cleanup();
  });
});

// ── C17 cluster 6 — Update Daemon (#534) performs a real update ───────────────
// The button shows only where the status reported a REAL `updateAvailable`, dispatches
// `daemon.update`, and shows the honest outcome: the refreshed version on success, the
// mechanism's own reason on failure. It never paints a success it did not earn.

describe("LiveSettingsProjectionProvider — Update Daemon is a real operation", () => {
  const OUTDATED: readonly DaemonHostStatus[] = [
    { source: "local", reachable: true, version: "4.3.0" },
    { source: "wsl:Ubuntu", reachable: true, version: "4.1.0", updateAvailable: true },
  ];

  it("POSITIVE CONTROL: a FAILING update shows Updating the daemon…, then the reason — never a fake success", async () => {
    const gate = deferred<{ status: DaemonHostStatus; error?: string }>();
    const { findByRole, findByText, queryByRole } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: OUTDATED,
        update: () => gate.promise,
      }),
    );
    const button = await findByRole("button", { name: "Update Daemon" });
    button.click();

    const pending = await findByRole("button", { name: "Updating the daemon…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(queryByRole("button", { name: "Update Daemon" })).toBeNull();

    gate.resolve({
      status: { source: "wsl:Ubuntu", reachable: false, lastSeenVersion: "4.1.0" },
      error: 'No Node runtime in WSL distro "Ubuntu".',
    });

    expect(await findByText('No Node runtime in WSL distro "Ubuntu".')).toBeTruthy();
    const wsl = within(card("wsl:Ubuntu"));
    // No new version was invented by the attempt — the card still reads the old sighting.
    expect(wsl.getByText("Not connected — last seen running Rennet daemon v4.1.0")).toBeTruthy();
    expect(wsl.queryByText("Rennet daemon v4.3.0")).toBeNull();
    cleanup();
  });

  it("a SUCCEEDING update shows the host's new version and stops offering the update", async () => {
    const { findByRole, findByText, queryByRole } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: OUTDATED,
        update: async (source) => ({
          status: { source: source as "wsl:Ubuntu", reachable: true, version: "4.3.0" },
        }),
      }),
    );
    (await findByRole("button", { name: "Update Daemon" })).click();
    // The version the host answered with AFTER the update, read off the refreshed status.
    expect(await findByText("Rennet daemon v4.3.0")).toBeTruthy();
    await waitFor(() => expect(queryByRole("button", { name: "Update Daemon" })).toBeNull());
    cleanup();
  });

  it("a host with no update available shows no button at all", async () => {
    const { findByText, queryByRole } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        // Both current: `updateAvailable` was withheld, so there is nothing to offer.
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: true, version: "4.2.9", updateAvailable: false },
        ],
      }),
    );
    await findByText("Rennet daemon v4.2.9");
    expect(queryByRole("button", { name: "Update Daemon" })).toBeNull();
    cleanup();
  });

  it("a REJECTED dispatch is reported as a failed update, never a hopeful card", async () => {
    const { findByRole, findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: OUTDATED,
        update: async () => {
          throw new Error("Rennet has no way to update this host's daemon.");
        },
      }),
    );
    (await findByRole("button", { name: "Update Daemon" })).click();
    expect(await findByText("Rennet has no way to update this host's daemon.")).toBeTruthy();
    cleanup();
  });
});

// ── C17 cluster 5 — Reconnect (#533) is a real operation, honestly reported ────
// The button dispatches `daemon.reconnect` and shows a REAL in-flight state for exactly as
// long as the operation is pending. What it must never do is read green off the click: the
// card turns reachable only when the refreshed `daemon.status` says the host answered.

/** A promise a test resolves by hand, so the in-flight state is observable rather than raced. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("LiveSettingsProjectionProvider — Reconnect performs a real re-handshake", () => {
  it("POSITIVE CONTROL: a FAILING re-handshake shows Connecting…, then stays unreachable with the reason", async () => {
    // Paint the card reachable off the click — an optimistic flip, a timed animation, a
    // swallowed rejection — and this fails: the host never answered, so it must still read
    // Not connected, with the handshake's own reason on screen.
    const gate = deferred<{ status: DaemonHostStatus; error?: string }>();
    const { findByRole, findByText, queryByRole } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: false, lastSeenVersion: "4.1.0" },
        ],
        reconnect: () => gate.promise,
      }),
    );
    const button = await findByRole("button", { name: "Reconnect" });
    button.click();

    // In flight: the honest progress state, disabled so it cannot be double-fired.
    const pending = await findByRole("button", { name: "Connecting…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(queryByRole("button", { name: "Reconnect" })).toBeNull();

    gate.resolve({
      status: { source: "wsl:Ubuntu", reachable: false, lastSeenVersion: "4.1.0" },
      error: 'No Rennet daemon answered in WSL distro "Ubuntu".',
    });

    expect(await findByText('No Rennet daemon answered in WSL distro "Ubuntu".')).toBeTruthy();
    const wsl = within(card("wsl:Ubuntu"));
    // Still unreachable, still last-seen — no version was invented by the attempt.
    expect(wsl.getByText("Not connected — last seen running Rennet daemon v4.1.0")).toBeTruthy();
    expect(wsl.queryByText("Rennet daemon v4.1.0")).toBeNull();
    // And the button is offered again, enabled, so the viewer can retry.
    expect(wsl.getByRole("button", { name: "Reconnect" }).hasAttribute("disabled")).toBe(false);
    cleanup();
  });

  it("a SUCCEEDING re-handshake flips the card to reachable with its real version", async () => {
    const { findByRole, findByText, queryByRole } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: false, lastSeenVersion: "4.1.0" },
        ],
        reconnect: async (source) => ({
          status: { source: source as "wsl:Ubuntu", reachable: true, version: "4.2.0" },
        }),
      }),
    );
    (await findByRole("button", { name: "Reconnect" })).click();
    // The card reads the version the REFRESHED status carries, not the last-seen one.
    expect(await findByText("Rennet daemon v4.2.0")).toBeTruthy();
    // Reachable ⇒ there is nothing left to reconnect, so the button is gone.
    await waitFor(() => expect(queryByRole("button", { name: "Reconnect" })).toBeNull());
    cleanup();
  });

  it("a REJECTED dispatch is reported as a failed reconnect, never a hopeful card", async () => {
    const { findByRole, findByText } = mountLive(
      foldBridge({
        sections: [LOCAL_SECTION, WSL_SECTION],
        status: [
          { source: "local", reachable: true, version: "4.3.0" },
          { source: "wsl:Ubuntu", reachable: false },
        ],
        reconnect: async () => {
          throw new Error("daemon.reconnect: no settings composition is wired");
        },
      }),
    );
    (await findByRole("button", { name: "Reconnect" })).click();
    expect(await findByText("daemon.reconnect: no settings composition is wired")).toBeTruthy();
    expect(
      within(card("wsl:Ubuntu")).getByText("Not connected — daemon unreachable, version unknown"),
    ).toBeTruthy();
    cleanup();
  });
});

// ── C17 amendment A — the Source Control toggle writes and reads a real ruling ─
// Until this landed the toggle flipped, wrote nothing, and a reload silently restored it.
// Now it writes `forge.setEnabled` and reads the host's ruling back off `harness.hosts`.

describe("LiveSettingsProjectionProvider — the forge toggle is served, not inert", () => {
  /** A bridge whose forge ruling lives in the STORE, so the switch can only reflect what
   *  the write persisted and the invalidated re-read returned. */
  function ruledBridge(initial: readonly string[] = []) {
    let disabledForges = [...initial];
    return new MemoryBridge(
      {
        "settings.get": () => ({
          scheme: "system" as const,
          schemeProvenance: {
            layer: "builtin" as const,
            contributions: [{ layer: "builtin" as const, value: "system", effective: true }],
          },
          appearanceMalformed: false,
          projects: [],
          daemonHosts: [{ ...LOCAL_SECTION }],
        }),
        "daemon.status": () => ({
          hosts: [{ source: "local" as const, reachable: true, version: "4.3.0" }],
        }),
        "harness.hosts": () => ({
          hosts: [
            {
              source: "local" as const,
              asked: true,
              detected: [],
              ...(disabledForges.length > 0 ? { disabledForges: [...disabledForges] } : {}),
            },
          ],
        }),
        "forge.hosts": () => ({
          hosts: [{ source: "local" as const, asked: true, detected: [{ ...GH_AVAILABLE }] }],
        }),
        "forge.setEnabled": (input) => {
          expect(input.source).toBe("local"); // scoped to the row's own host.
          // The WIRE id, not the row's mark id — the same key detection and the store use.
          expect(input.forgeId).toBe("github");
          disabledForges = input.enabled
            ? disabledForges.filter((id) => id !== input.forgeId)
            : [...disabledForges, input.forgeId];
          return { disabled: [...disabledForges] };
        },
      },
      { platform: "darwin", version: "1.0.1" },
    );
  }

  it("POSITIVE CONTROL: ruling a forge out writes through and the RE-READ shows it off", async () => {
    // Hard-code the row to `enabled: true` again (the pre-amendment state) and this fails:
    // the switch would spring back on the re-read, exactly the silent reset it used to do.
    const bridge = ruledBridge();
    const { findByRole, user } = mountLive(bridge);
    const toggle = await findByRole("switch", { name: "Use GitHub on This Machine" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() =>
      expect(
        within(document.body)
          .getByRole("switch", { name: "Use GitHub on This Machine" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    cleanup();
  });

  it("a host whose stored ruling has the forge off renders it off on first paint (survives reload)", async () => {
    const { findByRole } = mountLive(ruledBridge(["github"]));
    const toggle = await findByRole("switch", { name: "Use GitHub on This Machine" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Ruled out, NOT hidden: the CLI is really installed, so the row still reports it.
    expect(within(card("local")).getByText("Available")).toBeTruthy();
    cleanup();
  });

  it("a host with NO ruling reads enabled by default — never a fabricated decision", async () => {
    const { findByRole } = mountLive(ruledBridge());
    expect(
      (await findByRole("switch", { name: "Use GitHub on This Machine" })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    cleanup();
  });
});
