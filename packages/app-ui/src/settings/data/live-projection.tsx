import { type ReactNode, useMemo, useState } from "react";
import { useCommand } from "../../data";
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
//   • agentsByHost ← `harness.detect` (B7). The daemon spawns the real discovery
//     probes and returns the coding harnesses actually present on THIS machine, each
//     with its own version. That is genuine detection, so the local host's Agents
//     section shows the machine's real Claude / Codex instead of the "not detected"
//     line, and the Review section's Dual/Single logic reacts to what is truly there.
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
// exercise THIS provider by supplying a `harness.detect` bridge handler.
// ─────────────────────────────────────────────────────────────────────────────

/** The id the Environments page synthesises for the local machine card; detected
 *  harnesses key under it so that card's Agents section reads them back. */
const LOCAL_HOST_ID = "local";

const AGENT_LABEL: Record<AgentToolId, string> = { claude: "Claude", codex: "Codex" };

function agentLabel(id: string): string {
  return AGENT_LABEL[id as AgentToolId] ?? id;
}

export function LiveSettingsProjectionProvider({ children }: { readonly children: ReactNode }) {
  // Real detection (B7): the daemon returns exactly the harnesses it FOUND on this
  // machine, each with its version (or null). An in-flight / rejected read yields no
  // data, so the Agents section falls back to its honest "not detected" line.
  const { data } = useCommand("harness.detect", {});

  // Ruling an agent out of reviews is a real preference with NO served store yet
  // (`harness.detect` only DETECTS; no command persists enablement). Held here for the
  // session so the toggle and the Review section's Dual/Single logic are live and honest;
  // it resets on reload until a backend serves it (named gap, cluster-10 report §10.2).
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(() => new Set<string>());

  const projection = useMemo<SettingsProjection>(() => {
    const localAgents: readonly DetectedTool[] = (data?.detected ?? []).map(
      (harness): DetectedTool => ({
        id: harness.id,
        label: agentLabel(harness.id),
        // A harness the probe RETURNED is present on the machine — the honest status is
        // Available. A null version is shown as no version, never a guess (DetectionRow).
        version: harness.version ?? undefined,
        status: "available",
        detail: `Detected on this machine. Disable to rule ${agentLabel(harness.id)} out of reviews here.`,
        enabled: !disabled.has(harness.id),
      }),
    );
    const agentsByHost: Record<string, readonly DetectedTool[]> =
      localAgents.length > 0 ? { [LOCAL_HOST_ID]: localAgents } : {};
    return {
      ...EMPTY_SETTINGS_PROJECTION,
      agentsByHost,
      setToolEnabled: (hostId, toolId, enabled) => {
        // Only the local host runs real detection; a remote host has no served agents.
        if (hostId !== LOCAL_HOST_ID) return;
        setDisabled((prev) => {
          const next = new Set(prev);
          if (enabled) next.delete(toolId);
          else next.add(toolId);
          return next;
        });
      },
    };
  }, [data, disabled]);

  return <SettingsProjectionProvider value={projection}>{children}</SettingsProjectionProvider>;
}
