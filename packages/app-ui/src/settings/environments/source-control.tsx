import type { Locus } from "@rennet/protocol";
import { InstallForMe } from "../../components/install-for-me";
import { type SourceControlToolId, ToolMark } from "../assets/tool-marks";
import { type SettingsHost, type SourceControlTool, useSettingsProjection } from "../data";
import { CardSection, DetectionRow } from "./detection-row";

// ─────────────────────────────────────────────────────────────────────────────
// The Source Control section on a host card (C10 §4, claims 598–607). Detection
// lives on the HOST, not in a dedicated Providers page — these are the VCS/forge
// CLIs the host itself has: git and Git LFS (probed with the daemon's own environment,
// with Install for me when one is missing), GitHub (`gh`, #483), GitLab (`glab`), Bitbucket
// (API token, #484). Azure DevOps deliberately never appears.
//
// A host with no detected tooling (a disconnected one Rennet could not reach to
// look) shows ONE honest line — "Connect <host> to detect its tooling." — never a
// row of fake providers. There is NO OAuth-shaped connect ceremony anywhere in the
// rows (Rule Zero, #483): each row is honest state plus the one command that fixes
// it. A toggle appears only where a current acting path consumes the ruling; GitLab's
// readiness-only row stays status-only until merge-request operations exist.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where Install for me would run for this host: this machine, or one of its WSL distros.
 * A paired remote device installs nothing from here — it has its own daemon and its own
 * settings — so it reports its state and the fix, without a button.
 */
function locusOfHost(host: SettingsHost): Locus | undefined {
  if (host.kind === "local" || host.id === "local") return { kind: "host" };
  if (host.id.startsWith("wsl:")) return { kind: "wsl", distro: host.id.slice("wsl:".length) };
  return undefined;
}

/** One `git` / `git-lfs` row, with Install for me when it is missing (source-control-tooling
 *  spec: "the Git LFS row reads as not installed and offers Install for me"). */
function GitToolRow({
  tool,
  host,
}: {
  readonly tool: SourceControlTool;
  readonly host: SettingsHost;
}) {
  const locus = locusOfHost(host);
  return (
    <div data-slot="git-tool-row" data-tool={tool.id} data-status={tool.status}>
      <DetectionRow
        tool={tool}
        mark={<ToolMark id="git" />}
        toggle={null}
        footer={
          tool.status !== "available" && locus !== undefined ? (
            <InstallForMe tool={tool.id} locus={locus} />
          ) : undefined
        }
      />
    </div>
  );
}

export function SourceControlSection({ host }: { readonly host: SettingsHost }) {
  const projection = useSettingsProjection();
  // An ABSENT key is an unasked host; an EMPTY array is an asked host with nothing on it.
  const tools = projection.sourceControlByHost[host.id];
  // `git` and `git-lfs` first: every review on this host runs through them.
  const gitTools = projection.gitToolsByHost[host.id] ?? [];

  return (
    <CardSection title="Source Control">
      {gitTools.map((tool) => (
        <GitToolRow key={tool.id} tool={tool} host={host} />
      ))}
      {gitTools.length > 0 && (!tools || tools.length === 0) ? null : !tools ||
        tools.length === 0 ? (
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
