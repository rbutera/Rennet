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
// Two different emptinesses, two different lines (review finding 3). A host Rennet could
// not ASK reads "Connect …" — it is an unknown, not an answer. A host that WAS asked and
// came back with nothing reads "No coding agents detected", which is a real finding about a
// real machine. Collapsing them told a probed host to connect something already connected.
// ─────────────────────────────────────────────────────────────────────────────

export function AgentsSection({ host }: { readonly host: SettingsHost }) {
  const projection = useSettingsProjection();
  // An ABSENT key is an unasked host; an EMPTY array is an asked host with nothing on it.
  const tools = projection.agentsByHost[host.id];

  return (
    <CardSection title="Agents">
      {!tools || tools.length === 0 ? (
        <span className="py-2 text-xs text-ink-soft">
          {tools
            ? `No coding agents detected on ${host.name}.`
            : `Connect ${host.name} to detect its agents.`}
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
