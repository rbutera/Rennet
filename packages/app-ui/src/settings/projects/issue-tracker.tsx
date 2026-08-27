import { cn } from "@rennet/ui";
import type { KeyboardEvent } from "react";
import type { SidebarHost, SidebarProject } from "../../shell/sidebar-data";
import { Row, Section, Segmented } from "../atoms";
import {
  type IssueTrackerSettings,
  type TrackerKind,
  toProvenance,
  useSettingsProjection,
} from "../data";
import { ProvenanceChip } from "../provenance-chip";
import { UnbackedNote } from "./unbacked-note";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Issue Tracker section (C10 §8.5–8.6, claims 659–668). Related-context
// config (#461): the tracker whose referenced tickets the retrieval worker fetches for
// the review agents. The choice is github / jira / linear / none, each with a
// provenance chip — a scout pick lands "detected", a user pick lands "global", a
// project whose scout found nothing reads "none" (no guess).
//
//   • GitHub rides the host's `gh` CLI and exposes NO further fields.
//   • JIRA / Linear expose a project key, a base URL, and the NAME of the env var
//     holding the token — the token value itself never enters any store, only the name.
//   • Switching to a REST tracker seeds its token env var with the conventional name;
//     switching away drops its fields; Escape inside a field blurs, never closes settings.
//
// Rides the settings projection (`setTracker`) — provable now, one seam at B10.
// ─────────────────────────────────────────────────────────────────────────────

/** A project whose scout found nothing — tracker unset until the user says. */
const UNSET_TRACKER: IssueTrackerSettings = {
  kind: { value: "none", layer: "builtin" },
  projectKey: null,
  baseUrl: null,
  tokenEnv: null,
};

/** The conventional token env-var name a REST tracker seeds on selection. */
const TOKEN_ENV_DEFAULT: Record<"jira" | "linear", string> = {
  jira: "JIRA_API_TOKEN",
  linear: "LINEAR_API_KEY",
};

const TRACKER_OPTIONS = [
  { id: "github", label: "github" },
  { id: "jira", label: "jira" },
  { id: "linear", label: "linear" },
  { id: "none", label: "none" },
] as const;

/** Escape blurs the field WITHOUT closing the settings takeover (the root handler). */
function stopEscape(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.currentTarget.blur();
  }
}

export function TrackerSection({
  project,
  host,
}: {
  readonly project: SidebarProject;
  readonly host: SidebarHost;
}) {
  const projection = useSettingsProjection();
  // No served write store yet ⇒ lock the picker + fields and disclose the gap.
  const backed = projection.projectEditsPersist;
  const tracker = projection.trackerByProject[project.id] ?? UNSET_TRACKER;

  const setKind = (kind: TrackerKind) => {
    if (kind === tracker.kind.value) return;
    // A user pick lands on the global rung; REST trackers seed their fields, others drop them.
    const rest = kind === "jira" || kind === "linear";
    projection.setTracker(project.id, {
      kind: { value: kind, layer: "global" },
      projectKey: rest ? (tracker.projectKey ?? { value: "", layer: "global" }) : null,
      baseUrl: rest ? (tracker.baseUrl ?? { value: "", layer: "global" }) : null,
      tokenEnv: rest
        ? (tracker.tokenEnv ?? { value: TOKEN_ENV_DEFAULT[kind], layer: "global" })
        : null,
    });
  };

  const setField = (field: "projectKey" | "baseUrl" | "tokenEnv", value: string) => {
    projection.setTracker(project.id, { ...tracker, [field]: { value, layer: "global" } });
  };

  const textField = (
    field: "projectKey" | "baseUrl" | "tokenEnv",
    ariaLabel: string,
    placeholder: string,
  ) => {
    const entry = tracker[field];
    if (!entry) return null;
    return (
      <>
        <ProvenanceChip provenance={toProvenance(entry)} />
        <input
          value={entry.value}
          onChange={(event) => setField(field, event.target.value)}
          onKeyDown={stopEscape}
          disabled={!backed}
          aria-label={ariaLabel}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(
            "w-56 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus-visible:border-accent-line focus-visible:outline-none",
            !backed && "cursor-not-allowed opacity-60",
          )}
        />
      </>
    );
  };

  return (
    <Section title="Issue Tracker" caption={`.rennet/ in ${project.name}`}>
      <Row
        label="Tracker"
        hint="tickets a branch or PR references are fetched for the review agents"
      >
        <ProvenanceChip provenance={toProvenance(tracker.kind)} />
        <Segmented
          ariaLabel="Issue tracker"
          options={TRACKER_OPTIONS}
          value={tracker.kind.value}
          onChange={setKind}
          disabled={!backed}
        />
      </Row>
      {tracker.kind.value === "github" ? (
        <Row label="Access" hint="how tickets are read">
          <span className="text-xs text-ink-soft">
            rides the <code className="font-mono text-ink">gh</code> CLI on {host.label}
          </span>
        </Row>
      ) : null}
      {tracker.projectKey ? (
        <Row label="Project Key" hint="the ticket prefix in branch names and commits">
          {textField("projectKey", "Tracker project key", "PAY")}
        </Row>
      ) : null}
      {tracker.baseUrl ? (
        <Row label="Base URL" hint="where the retrieval worker points its calls">
          {textField("baseUrl", "Tracker base URL", "https://your-org.atlassian.net")}
        </Row>
      ) : null}
      {tracker.tokenEnv ? (
        <Row label="Token" hint={`env var on ${host.label}; the token itself never leaves it`}>
          {textField("tokenEnv", "Tracker token environment variable", "JIRA_API_TOKEN")}
        </Row>
      ) : null}
      {backed ? null : (
        <div className="py-2.5">
          <UnbackedNote>
            Issue-tracker config isn&rsquo;t served yet — this lands with the settings engine.
          </UnbackedNote>
        </div>
      )}
    </Section>
  );
}
