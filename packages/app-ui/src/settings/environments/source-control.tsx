import { type SourceControlToolId, ToolMark } from "../assets/tool-marks";
import { type SettingsHost, useSettingsProjection } from "../data";
import { CardSection, DetectionRow } from "./detection-row";

// ─────────────────────────────────────────────────────────────────────────────
// The Source Control section on a host card (C10 §4, claims 598–607). Detection
// lives on the HOST, not in a dedicated Providers page — these are the VCS/forge
// CLIs the host itself has: git, GitHub (`gh`, #483), GitLab (`glab`), Bitbucket
// (API token, #484). Azure DevOps deliberately never appears.
//
// A host with no detected tooling (a disconnected one Rennet could not reach to
// look) shows ONE honest line — "Connect <host> to detect its tooling." — never a
// row of fake providers. There is NO OAuth-shaped connect ceremony anywhere in the
// rows (Rule Zero, #483): each row is honest state plus the one command that fixes
// it. A toggle appears only where a current acting path consumes the ruling; GitLab's
// readiness-only row stays status-only until merge-request operations exist.
// ─────────────────────────────────────────────────────────────────────────────

export function SourceControlSection({ host }: { readonly host: SettingsHost }) {
  const projection = useSettingsProjection();
  // An ABSENT key is an unasked host; an EMPTY array is an asked host with nothing on it.
  const tools = projection.sourceControlByHost[host.id];

  return (
    <CardSection title="Source Control">
      {!tools || tools.length === 0 ? (
        <span className="py-2 text-xs text-ink-soft">
          {tools
            ? `No source-control CLIs detected on ${host.name}.`
            : `Connect ${host.name} to detect its tooling.`}
        </span>
      ) : (
        tools.map((tool) => (
          <DetectionRow
            key={tool.id}
            tool={tool}
            mark={<ToolMark id={tool.id as SourceControlToolId} />}
            toggle={
              tool.id === "glab"
                ? null
                : {
                    label: `Use ${tool.label} on ${host.name}`,
                    onChange: (enabled) => projection.setToolEnabled(host.id, tool.id, enabled),
                  }
            }
          />
        ))
      )}
    </CardSection>
  );
}
