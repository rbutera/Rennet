import type { DaemonHostStatus, DetectedForge, ProjectSource } from "@rennet/protocol";
import { type ReactNode, useMemo } from "react";
import { useBridge, useCommand, useMutation } from "../../data";
import type { AgentToolId } from "../assets/agent-marks";
import { type HostOS, osFromPlatform } from "../assets/os-glyphs";
import {
  type DaemonInfo,
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
} from "./projections";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE settings projection (C10 §10.1, the fold wiring). This seam is the one
// place a projection read binds to a landed backend instead of resolving honest-empty.
// After the B10 + B7 + C17 folds, THREE projection fields have a served backend:
//
//   • hosts ← `settings.get.daemonHosts` (the enumeration + each host's label) joined
//     by `source` with `daemon.status` (C17 cluster 2), which asks each host's daemon
//     for `reachable` / `version` / `lastSeenVersion` / `updateAvailable`. A host with
//     no status entry — the read in flight, rejected, or the host simply not answered
//     for — falls to `{ reachable: false }`: the card reads honestly unreachable and
//     invents no version. A remote host's platform is never reported to us, so its
//     glyph is the neutral `unknown` mark rather than a guessed penguin.
//
//   • sourceControlByHost ← `forge.hosts` (C17 amendment B), the forge CLIs present on EACH
//     host the settings surface enumerates — GitHub / `gh` only, the #484 boundary (GitLab
//     and Bitbucket are planned, not built). Like `harness.hosts` the fan-out is SERVER-side:
//     the daemon probes each host through that host's own deps (a WSL distro's `gh` over
//     `wsl.exe`), so a distro card shows ITS `gh` rather than inheriting this machine's. A host
//     that could not be asked comes back `asked: false` and is dropped here, so its card reads
//     the honest "Connect … to detect its tooling" line. A `not-installed` forge is DROPPED
//     too, so a binary renamed out of PATH makes its row disappear instead of going stale.
//     The row's enable toggle is served (amendment A): it writes `forge.setEnabled` and
//     reads the host's ruling back off `harness.hosts`, so ruling `gh` out survives a reload.
//
//   • agentsByHost ← `harness.hosts` (C17 cluster 3). The daemon runs the real discovery
//     probes for EVERY host the settings surface enumerates — itself directly, a WSL distro
//     through `wsl.exe` — and returns the coding harnesses actually present on each, with
//     that host's own versions. Per-host detection is SERVER-side because the client holds
//     exactly ONE daemon connection (the locus daemon), so it has nothing to fan out over.
//     Each host's Agents section therefore shows ITS machine's real Claude / Codex, and the
//     Review section's Dual/Single logic reacts to what is truly there.
//
//     A host the daemon cannot interrogate comes back `asked: false` and is dropped here, so
//     its card reads "Connect …" — an unknown, not an answer. A host that WAS asked keeps its
//     key even when empty, so its card reads "No coding agents detected": a real finding about
//     a real machine. The local set is never copied onto either.
//
//     The enable toggle writes through `harness.setEnabled`, which persists the decision
//     per host on the daemon-settings rung, so a ruled-out agent stays ruled out across
//     reload and ruling it out on one host leaves it running on the others.
//
//   • reconnectHost ← `daemon.reconnect` (C17 cluster 5, #533). The host card's Reconnect
//     button dispatches a real per-host re-handshake and reports its real outcome. It
//     invalidates `daemon.status`, so a card turns reachable only because the refreshed
//     status says the host answered — a failed attempt keeps the card unreachable and shows
//     the handshake's own reason.
//
//   • updateHost ← `daemon.update` (C17 cluster 6, #534). The Update Daemon button — shown only
//     where the status carried a real `updateAvailable` — dispatches the real per-host update
//     and invalidates `daemon.status` the same way, so the new version on the card is the one
//     the host answered with afterwards. A host with no update mechanism reports its reason.
//
// Every OTHER field stays EMPTY on purpose — the backend does not exist even post-fold,
// so honest-empty is the truthful answer, not a stub. Each named in the cluster-10 report:
//   – projectCount / sessionCount on a host card: `daemonHosts` enumerates hosts but
//     carries no per-host counts, so the Remove confirmation names none rather than a
//     fabricated blast radius.
//   – reviewRoles: no Model-Council / mappings command exists.
//   – nameByProject / glyphByProject / worktreeByProject / trackerByProject: no served
//     write command (the composition's `setTrackerValue` / `worktreeBaseDir` are unwired).
//   – guidanceByProject: `settings.guidance` is a READ only; no guidance-WRITE command.
//
// This provider wraps the live Settings takeover. Tests that mount a page directly
// supply their own projection, so the seam stays fully test-drivable; a test may still
// exercise THIS provider by supplying the four bridge handlers it reads.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_LABEL: Record<AgentToolId, string> = { claude: "Claude", codex: "Codex" };

function agentLabel(id: string): string {
  return AGENT_LABEL[id as AgentToolId] ?? id;
}

/** The forge wire id → the source-control row's mark id + label. ONE entry: GitHub /
 *  `gh` is the only forge Rennet builds (#484 keeps GitLab/Bitbucket as planning). */
const FORGE_ROW: Record<string, { readonly markId: string; readonly label: string }> = {
  github: { markId: "gh", label: "GitHub" },
};

/** The row's mark id back to the forge's WIRE id — the id the served ruling is keyed by,
 *  so a toggle writes the same name the detection and the store both use. */
const FORGE_WIRE_ID: Record<string, string> = Object.fromEntries(
  Object.entries(FORGE_ROW).map(([wireId, row]) => [row.markId, wireId]),
);

function forgeRow(forge: DetectedForge, disabled: ReadonlySet<string>): DetectedTool {
  const row = FORGE_ROW[forge.id];
  return {
    id: row?.markId ?? forge.id,
    label: row?.label ?? forge.id,
    // No detected version means no version line — never a guess (DetectionRow).
    version: forge.version ?? undefined,
    status: forge.status,
    detail: forge.detail,
    // The SERVED per-host ruling (amendment A) — a forge the viewer ruled out on this host
    // reads off across reload, and one with no ruling reads enabled by default.
    enabled: !disabled.has(forge.id),
  };
}

/** The host's platform, or the neutral `unknown` mark when it is genuinely not knowable. */
function hostOS(source: string, isLocal: boolean, platform: string | undefined): HostOS {
  if (isLocal) return osFromPlatform(platform);
  if (source.startsWith("wsl:")) return "wsl";
  // A paired remote host reports no platform anywhere on the wire — so we show none.
  return "unknown";
}

/** One host's daemon line. A host with NO status entry (read in flight, read rejected,
 *  or a host the daemon returned nothing for) is unreachable with nothing else — the
 *  honest fallback the card already renders, never a stubbed version. */
function daemonInfo(status: DaemonHostStatus | undefined): DaemonInfo {
  if (!status) return { reachable: false };
  return {
    reachable: status.reachable,
    version: status.version,
    lastSeenVersion: status.lastSeenVersion,
    updateAvailable: status.updateAvailable,
  };
}

export function LiveSettingsProjectionProvider({ children }: { readonly children: ReactNode }) {
  const bridge = useBridge();
  // Real per-host detection (C17): each entry holds exactly the harnesses found ON that
  // host. An in-flight / rejected read yields no data, so every Agents section falls back
  // to its honest "not detected" line.
  const { data } = useCommand("harness.hosts", {});
  // The host ENUMERATION + each host's label (the same walk `daemon.status` and
  // `harness.hosts` make), joined below with the per-host daemon probe.
  const { data: settings } = useCommand("settings.get", {});
  const { data: status } = useCommand("daemon.status", {});
  // The forge CLIs on EACH enumerated host, probed server-side through that host's own deps.
  const { data: forges } = useCommand("forge.hosts", {});
  // The toggle is a served WRITE: it persists, then invalidates the detection read so the
  // switch reflects what is actually STORED rather than an optimistic local guess.
  const { mutate: setEnabled } = useMutation("harness.setEnabled", {
    invalidates: ["harness.hosts"],
  });
  // Reconnect (C17 cluster 5, #533) is a served operation, not a local state flip: it
  // invalidates `daemon.status`, so a card only turns reachable when the REFRESHED status
  // says the host answered — the button can never paint itself green.
  const { mutate: reconnect } = useMutation("daemon.reconnect", {
    invalidates: ["daemon.status"],
  });
  // Update Daemon (C17 cluster 6, #534) — the same served-operation shape: the refreshed status
  // is what moves the card, so the button can never paint a version the host did not report.
  const { mutate: update } = useMutation("daemon.update", {
    invalidates: ["daemon.status"],
  });
  // The Source Control row's toggle (amendment A) — the same served-write shape, invalidating
  // the same per-host read the ruling is served on, so the switch shows what is STORED.
  const { mutate: setForgeEnabled } = useMutation("forge.setEnabled", {
    invalidates: ["harness.hosts"],
  });

  const projection = useMemo<SettingsProjection>(() => {
    const agentsByHost: Record<string, readonly DetectedTool[]> = {};
    for (const host of data?.hosts ?? []) {
      // A host that could not be asked claims NOTHING — no key at all, so its card reads
      // "Connect …". A host that WAS asked keeps its key even when the list is empty: that
      // is the real answer "nothing is installed there", and dropping it (review finding 3)
      // told an already-probed machine to connect itself.
      if (!host.asked) continue;
      agentsByHost[host.source] = host.detected.map(
        (harness): DetectedTool => ({
          id: harness.id,
          label: agentLabel(harness.id),
          // A harness the probe RETURNED is present on that host — the honest status is
          // Available. A null version is shown as no version, never a guess (DetectionRow).
          version: harness.version ?? undefined,
          status: "available",
          detail: `Detected on this machine. Disable to rule ${agentLabel(harness.id)} out of reviews here.`,
          enabled: harness.enabled,
        }),
      );
    }
    // The daemon probe, keyed by the source it answered for. A host missing from the
    // read (or the whole read missing) simply has no entry — `daemonInfo` turns that
    // into an honestly unreachable card.
    const statusBySource = new Map(status?.hosts.map((host) => [host.source, host]) ?? []);
    const sections = settings?.daemonHosts ?? [];
    const hosts: SettingsHost[] = sections.map((section) => ({
      id: section.source,
      // The local host's card keeps the product's own name for this machine; every
      // other host reads the label the daemon composed for it.
      name: section.isLocal ? "This Machine" : section.label,
      kind: section.isLocal ? "local" : "remote",
      os: hostOS(section.source, section.isLocal, bridge.platform),
      // The routing address IS the source for a non-local host (`wsl:Ubuntu`,
      // `remote:<deviceId>`); the local machine has nothing to dial.
      address: section.isLocal ? undefined : section.source,
      daemon: daemonInfo(statusBySource.get(section.source)),
    }));

    // Each host's OWN forge CLIs (amendment B). A host that could not be asked claims NOTHING —
    // no key, so the card reads its honest "Connect … to detect its tooling" line rather than
    // inheriting the machine this client is connected to. A forge whose binary is absent is
    // DROPPED, not rendered Not Installed: renaming `gh` out of PATH makes the row disappear
    // rather than report a stale hit.
    const sourceControlByHost: Record<string, readonly DetectedTool[]> = {};
    // The rows carry the viewer's forge ruling, which is served on `harness.hosts`. Until THAT
    // read lands there is no ruling to render, and defaulting to enabled would paint a
    // persisted "ruled out" decision as an enabled switch (review finding 7) — a fabricated
    // answer, briefly, which is exactly what the served ruling exists to stop. So: no rows
    // until the ruling read has arrived, and every card holds its honest empty state.
    for (const host of data ? (forges?.hosts ?? []) : []) {
      if (!host.asked) continue;
      // This host's ruling, off the entry that arrived. No entry ⇒ nothing ruled out.
      const disabled = new Set(
        data.hosts.find((entry) => entry.source === host.source)?.disabledForges ?? [],
      );
      // An asked host keeps its key even with no rows — "asked, nothing installed" is an
      // answer, and the section says so rather than asking to connect a connected host.
      sourceControlByHost[host.source] = host.detected
        .filter((forge) => forge.status !== "not-installed")
        .map((forge) => forgeRow(forge, disabled));
    }

    return {
      ...EMPTY_SETTINGS_PROJECTION,
      hosts,
      sourceControlByHost,
      agentsByHost,
      reconnectHost: async (hostId) => {
        try {
          const outcome = await reconnect({ source: hostId as ProjectSource });
          return {
            reachable: outcome.status.reachable,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        } catch (reason) {
          // A rejected dispatch IS a failed reconnect — reported as one, with whatever the
          // failure said, rather than swallowed into a card that keeps looking hopeful.
          return { reachable: false, error: reason instanceof Error ? reason.message : undefined };
        }
      },
      updateHost: async (hostId) => {
        try {
          const outcome = await update({ source: hostId as ProjectSource });
          return {
            reachable: outcome.status.reachable,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        } catch (reason) {
          // A rejected dispatch IS a failed update — reported as one, never swallowed into a
          // card that claims a version the host was never asked for.
          return { reachable: false, error: reason instanceof Error ? reason.message : undefined };
        }
      },
      setToolEnabled: (hostId, toolId, enabled) => {
        // ONE signature, two served stores — the row's own host decides which. Fire-and-
        // refetch in both cases: the mutation invalidates `harness.hosts`, so the row re-reads
        // the PERSISTED decision. A rejected write leaves the switch where it was — it never
        // shows a tool as ruled out when the store refused to remember it.
        // Every host id in this projection came from a served `source`, so the cast narrows
        // back to the shape the command's own schema re-validates on arrival.
        const source = hostId as ProjectSource;
        if (agentsByHost[hostId]?.some((tool) => tool.id === toolId)) {
          void setEnabled({ source, harnessId: toolId, enabled }).catch(() => undefined);
          return;
        }
        // A Source Control row (amendment A): written under the forge's WIRE id, which is
        // what the served ruling and the detection are both keyed by. Scoped to the row's own
        // host — every card's rows are now real (amendment B), so every card's toggle writes.
        const forgeId = FORGE_WIRE_ID[toolId];
        if (forgeId && sourceControlByHost[hostId]?.some((tool) => tool.id === toolId)) {
          void setForgeEnabled({ source, forgeId, enabled }).catch(() => undefined);
        }
      },
    };
  }, [
    data,
    settings,
    status,
    forges,
    bridge.platform,
    setEnabled,
    setForgeEnabled,
    reconnect,
    update,
  ]);

  return <SettingsProjectionProvider value={projection}>{children}</SettingsProjectionProvider>;
}
