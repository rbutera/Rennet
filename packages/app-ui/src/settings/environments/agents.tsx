import { AgentMark, type AgentToolId } from "../assets/agent-marks";
import { type SettingsHost, useSettingsProjection } from "../data";
import { CardSection, DetectionRow } from "./detection-row";

// ─────────────────────────────────────────────────────────────────────────────
// The Agents section on a host card (C10 §5.1, claims 611–613). The coding
// harnesses this host can run, detected exactly the way the forge CLIs are
// (§4) — the SAME row shape: official mark, label, the harness's own version
// line, status chip, one honest helper naming the fix, enable toggle.
//
// Disabling an agent rules it out of reviews on this host WITHOUT uninstalling
// anything (the toggle flips detection state, it does not touch the machine).
// That enabled/disabled state lives in the ONE hosts projection — the Review
// section below the card reads it back to know which harnesses may carry a role,
// so the mutation flows through `setToolEnabled`, never a local card copy.
//
// A host with nothing detected (a disconnected one Rennet could not reach) shows
// one honest line instead of fake rows — the same honesty as Source Control.
// ─────────────────────────────────────────────────────────────────────────────

export function AgentsSection({ host }: { readonly host: SettingsHost }) {
  const projection = useSettingsProjection();
  const tools = projection.agentsByHost[host.id] ?? [];

  return (
    <CardSection title="Agents">
      {tools.length === 0 ? (
        <span className="py-2 text-xs text-ink-soft">
          Connect {host.name} to detect its agents.
        </span>
      ) : (
        tools.map((tool) => (
          <DetectionRow
            key={tool.id}
            tool={tool}
            mark={<AgentMark id={tool.id as AgentToolId} />}
            toggleLabel={`Use ${tool.label} on ${host.name}`}
            onToggle={(enabled) => projection.setToolEnabled(host.id, tool.id, enabled)}
          />
        ))
      )}
    </CardSection>
  );
}
