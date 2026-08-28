import type { ProjectSource } from "@rennet/protocol";
import { type ReactNode, useMemo } from "react";
import { useCommand, useMutation } from "../../data";
import type { AgentToolId } from "../assets/agent-marks";
import {
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type SettingsProjection,
  SettingsProjectionProvider,
} from "./projections";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE settings projection (C10 §10.1, the fold wiring). Cluster 10 is the one
// place a projection read binds to a landed backend instead of resolving honest-empty.
// After the B10 + B7 fold, exactly ONE projection field has a served backend:
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
// Every OTHER field stays EMPTY on purpose — the backend does not exist even post-fold,
// so honest-empty is the truthful answer, not a stub waiting on B10. Each named in the
// cluster-10 report + tasks.md §10:
//   – hosts: `settings.get.daemonHosts` ENUMERATES hosts but carries no per-host OS,
//     daemon reachability/version, or project/session counts — mapping it to a card
//     would fabricate those. The live local card is synthesised by the Environments
//     page from the bridge (real OS + version); remote-host detection is the named gap.
//   – sourceControlByHost: the gh/glab CLI-detection model was REMOVED in v4.2 (GitHub
//     is now OAuth via `github.*`, whose shape the §4 CLI row does not match).
//   – reviewRoles: no Model-Council / mappings command exists.
//   – nameByProject / glyphByProject / worktreeByProject / trackerByProject: no served
//     write command (the composition's `setTrackerValue` / `worktreeBaseDir` are unwired).
//   – guidanceByProject: `settings.guidance` is a READ only; no guidance-WRITE command.
//
// This provider wraps the live Settings takeover. Tests that mount a page directly
// supply their own projection, so the seam stays fully test-drivable; a test may still
// exercise THIS provider by supplying a `harness.hosts` bridge handler.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_LABEL: Record<AgentToolId, string> = { claude: "Claude", codex: "Codex" };

function agentLabel(id: string): string {
  return AGENT_LABEL[id as AgentToolId] ?? id;
}

export function LiveSettingsProjectionProvider({ children }: { readonly children: ReactNode }) {
  // Real per-host detection (C17): each entry holds exactly the harnesses found ON that
  // host. An in-flight / rejected read yields no data, so every Agents section falls back
  // to its honest "not detected" line.
  const { data } = useCommand("harness.hosts", {});
  // The toggle is a served WRITE: it persists, then invalidates the detection read so the
  // switch reflects what is actually STORED rather than an optimistic local guess.
  const { mutate: setEnabled } = useMutation("harness.setEnabled", {
    invalidates: ["harness.hosts"],
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
    return {
      ...EMPTY_SETTINGS_PROJECTION,
      agentsByHost,
      setToolEnabled: (hostId, toolId, enabled) => {
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
  }, [data, setEnabled]);

  return <SettingsProjectionProvider value={projection}>{children}</SettingsProjectionProvider>;
}
