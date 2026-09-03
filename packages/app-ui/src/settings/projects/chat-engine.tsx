import type { SidebarProject } from "../../shell/sidebar-data";
import { Row, Section, Segmented } from "../atoms";
import { type ChatEngine, useSettingsProjection } from "../data/projections";
import { UnbackedNote } from "./unbacked-note";

// ─────────────────────────────────────────────────────────────────────────────
// The chat engine a project's sessions run on (t3code-sidecar-chat, group 5): Rennet's
// own orchestrator, or the T3 Code sidecar the daemon owns. Repo-rung, default `rennet`.
// The three statements beside the control are DISCLOSURE, not a confirmation: T3
// threads are persisted harness sessions, their spend shows in T3's usage view rather
// than Rennet's seat usage, and T3 writes hidden checkpoint refs into the reviewed
// repository. One quiet paragraph, visible without a dialog (spec: "Spend and
// persistence differences are stated where the engine is chosen").
// ─────────────────────────────────────────────────────────────────────────────

const ENGINE_OPTIONS = [
  { id: "rennet", label: "rennet" },
  { id: "t3", label: "t3 code" },
] as const satisfies readonly { readonly id: ChatEngine; readonly label: string }[];

export function ChatEngineSection({ project }: { readonly project: SidebarProject }) {
  const projection = useSettingsProjection();
  const resolved = projection.chatEngineByProject[project.id];
  const backed = projection.prefsBackedByProject[project.id] ?? projection.projectEditsPersist;
  // An older daemon serves no engine row at all; the control then shows the default and
  // stays disabled, because a write would have nowhere to land.
  const served = resolved !== undefined;
  const value: ChatEngine = resolved?.value ?? "rennet";

  return (
    <Section title="Chat engine" caption="~/.rennet/projects/<repo>/config.json">
      <Row
        label="Engine"
        hint="which coding-agent chat a new session in this project opens; takes effect on the next session"
      >
        <Segmented
          ariaLabel="Chat engine"
          options={ENGINE_OPTIONS}
          value={value}
          onChange={(engine) => projection.setChatEngine(project.id, engine)}
          disabled={!backed || !served}
        />
      </Row>
      <p data-slot="chat-engine-disclosure" className="text-xs text-ink-soft">
        T3 Code threads are persisted harness sessions: they appear in the harness&apos;s own
        history, their token usage is reported by T3 Code&apos;s usage view rather than
        Rennet&apos;s seat usage, and T3 Code records a hidden checkpoint ref in the reviewed
        repository per turn, which ordinary pushes do not send. The sidecar runs with telemetry off
        and its only egress is the harness provider&apos;s own traffic.
      </p>
      {!backed && (
        <UnbackedNote>
          Chat engine choice needs this project&apos;s config to be served.
        </UnbackedNote>
      )}
      {backed && !served && (
        <UnbackedNote>This daemon predates the engine setting; update it to choose.</UnbackedNote>
      )}
    </Section>
  );
}
