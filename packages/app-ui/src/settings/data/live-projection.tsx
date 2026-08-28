import { councilPickSchema, type ReviewRoleCell, type ReviewRoleMapping } from "@rennet/protocol";
import { type ReactNode, useMemo, useState } from "react";
import { useCommand, useMutation } from "../../data";
import type { AgentToolId } from "../assets/agent-marks";
import {
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type ReviewRole,
  type RoleAssignment,
  type SettingsProjection,
  SettingsProjectionProvider,
} from "./projections";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE settings projection (C10 §10.1, the fold wiring). Cluster 10 is the one
// place a projection read binds to a landed backend instead of resolving honest-empty.
// Two projection fields now have a served backend:
//
//   • agentsByHost ← `harness.detect` (B7). The daemon spawns the real discovery
//     probes and returns the coding harnesses actually present on THIS machine, each
//     with its own version. That is genuine detection, so the local host's Agents
//     section shows the machine's real Claude / Codex instead of the "not detected"
//     line, and the Review section's Dual/Single logic reacts to what is truly there.
//   • reviewRoles ← `settings.get.reviewRoles`, written by `settings.setRoleAssignment`
//     (C16, #485). HONEST-PRESENT: the council tables are static, so the read carries
//     all eight roles with `default` provenance even on a fresh install — the Review
//     section is never a blank. An edit writes ONE (role, scenario) cell and the
//     response's re-resolved mappings are adopted straight away (the resolver's own
//     answer, never a hand-recomputed one); the `settings.get` read is invalidated so
//     the reload settles on disk truth.
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

/** One wire cell → the projection's assignment. `null` value stays null: the role does
 *  not run in that scenario and the surface renders an em dash, never a guess. */
function toAssignment(cell: ReviewRoleCell): RoleAssignment | null {
  if (cell.value === null) return null;
  return { model: cell.value.model, effort: cell.value.effort, layer: cell.layer };
}

function toReviewRole(mapping: ReviewRoleMapping): ReviewRole {
  return {
    id: mapping.id,
    label: mapping.label,
    hint: mapping.hint,
    dual: toAssignment(mapping.dual),
    claudeOnly: toAssignment(mapping.claudeOnly),
    codexOnly: toAssignment(mapping.codexOnly),
  };
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

  // The council mappings (C16, #485). The read is honest-present; the write returns the
  // re-resolved mappings, which are adopted immediately so the cell settles without a
  // round-trip, then invalidated so the next `settings.get` confirms it off disk.
  const { data: settings } = useCommand("settings.get", {});
  const { mutate: writeRole } = useMutation("settings.setRoleAssignment", {
    invalidates: ["settings.get"],
  });
  const [adopted, setAdopted] = useState<readonly ReviewRole[] | null>(null);

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
    // The freshest truth wins. A write's response is the resolver's answer AFTER the
    // write, so it outranks the `settings.get` read it just invalidated — the cell
    // settles at once instead of blinking back to the pre-write value. The refetch
    // then agrees; nothing here recomputes a value the daemon did not return.
    const served = settings?.reviewRoles?.map(toReviewRole);
    return {
      ...EMPTY_SETTINGS_PROJECTION,
      agentsByHost,
      reviewRoles: adopted ?? served ?? [],
      setRoleAssignment: (roleId, scenario, assignment) => {
        // Model + effort only — `layer` is provenance the resolver decides, not input
        // (#89: the harness follows the model, and nothing here pins one). The
        // projection's model is a plain string, so parse it against the council set at
        // this boundary rather than casting a value the command would reject anyway.
        const parsed =
          assignment === null
            ? null
            : councilPickSchema.safeParse({ model: assignment.model, effort: assignment.effort });
        if (parsed !== null && !parsed.success) return;
        void writeRole({ roleId, scenario, assignment: parsed === null ? null : parsed.data })
          .then((output) => setAdopted(output.reviewRoles.map(toReviewRole)))
          // A refused write (a malformed config, Rule 75) leaves the cell where it was;
          // the invalidated read is the honest answer, never a fabricated success.
          .catch(() => undefined);
      },
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
  }, [data, disabled, settings, adopted, writeRole]);

  return <SettingsProjectionProvider value={projection}>{children}</SettingsProjectionProvider>;
}
