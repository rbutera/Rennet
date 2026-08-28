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
//   • sourceControlByHost ← `forge.detect` (C17 cluster 1), the forge CLIs present on
//     the host whose daemon answered — GitHub / `gh` only, the #484 boundary (GitLab
//     and Bitbucket are planned, not built). `forge.detect` runs on the ONE daemon this
//     client is connected to, so it describes exactly that host (the `isLocal` section)
//     and no other; every other card's Source Control section stays honestly empty
//     rather than inheriting this machine's answer. A `not-installed` forge is DROPPED,
//     so a binary renamed out of PATH makes its row disappear instead of going stale.
//
//   • agentsByHost ← `harness.hosts` (C17 cluster 3). The daemon runs the real discovery
//     probes for EVERY host the settings surface enumerates — itself directly, a WSL distro
//     through `wsl.exe` — and returns the coding harnesses actually present on each, with
//     that host's own versions. Per-host detection is SERVER-side because the client holds
//     exactly ONE daemon connection (the locus daemon), so it has nothing to fan out over.
//     Each host's Agents section therefore shows ITS machine's real Claude / Codex, and the
//     Review section's Dual/Single logic reacts to what is truly there.
//
//     A host the daemon cannot interrogate comes back `asked: false`, and is dropped here
//     rather than keyed with an empty list — the card falls to its honest "not detected"
//     line instead of claiming that host has no agents. The local set is never copied over.
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
// Every OTHER field stays EMPTY on purpose — the backend does not exist even post-fold,
// so honest-empty is the truthful answer, not a stub. Each named in the cluster-10 report:
//   – projectCount / sessionCount on a host card: `daemonHosts` enumerates hosts but
//     carries no per-host counts, so the Remove confirmation names none rather than a
//     fabricated blast radius.
//   – the Source Control row's enable toggle: `harness.setEnabled` stores a ruling per
//     host + tool id, but nothing READS a forge ruling back, so flipping one could not
//     survive a reload. The rows are detection-only until that read exists; the toggle
//     is left where C10 put it rather than writing a decision nothing can honour.
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

function forgeRow(forge: DetectedForge): DetectedTool {
  const row = FORGE_ROW[forge.id];
  return {
    id: row?.markId ?? forge.id,
    label: row?.label ?? forge.id,
    // No detected version means no version line — never a guess (DetectionRow).
    version: forge.version ?? undefined,
    status: forge.status,
    detail: forge.detail,
    // There is no served READ of a per-host forge ruling, so the row cannot claim to
    // be ruled out; it reports the CLI's real detected state and nothing more.
    enabled: true,
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
  // The forge CLIs on the host whose daemon answers this client's ONE connection.
  const { data: forges } = useCommand("forge.detect", {});
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

  const projection = useMemo<SettingsProjection>(() => {
    const agentsByHost: Record<string, readonly DetectedTool[]> = {};
    for (const host of data?.hosts ?? []) {
      // A host that could not be asked claims NOTHING — no key, so the card reads its
      // honest not-detected line rather than "asked, and found nothing installed".
      if (!host.asked || host.detected.length === 0) continue;
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

    // `forge.detect` answers for the ONE daemon this client is connected to — the
    // `isLocal` section. Keying it anywhere else would copy this host's tooling onto a
    // machine it was never observed on; every other card stays honestly empty.
    const connectedSource = sections.find((section) => section.isLocal)?.source ?? "local";
    // A forge whose binary is absent is DROPPED, not rendered Not Installed: renaming
    // `gh` out of PATH makes the row disappear rather than report a stale hit.
    const detectedForges = (forges?.detected ?? []).filter(
      (forge) => forge.status !== "not-installed",
    );

    return {
      ...EMPTY_SETTINGS_PROJECTION,
      hosts,
      sourceControlByHost:
        detectedForges.length > 0 ? { [connectedSource]: detectedForges.map(forgeRow) } : {},
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
      setToolEnabled: (hostId, toolId, enabled) => {
        // Only a DETECTED harness on that host has a served store behind it. A forge row's
        // toggle has no read to restore it from, so nothing is written for one — better an
        // inert control than a decision the next reload silently forgets.
        if (!agentsByHost[hostId]?.some((tool) => tool.id === toolId)) return;
        // Fire-and-refetch: the mutation invalidates `harness.hosts`, so the row re-reads
        // the persisted decision. A rejected write leaves the switch where it was — it
        // never shows an agent as ruled out when the store refused to remember it.
        // Every host id in this projection came from a served `source`, so the cast
        // narrows back to the shape the command's own schema re-validates on arrival.
        void setEnabled({
          source: hostId as ProjectSource,
          harnessId: toolId,
          enabled,
        }).catch(() => undefined);
      },
    };
  }, [data, settings, status, forges, bridge.platform, setEnabled, reconnect]);

  return <SettingsProjectionProvider value={projection}>{children}</SettingsProjectionProvider>;
}
