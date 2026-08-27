import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rennet/ui";
import { Pencil, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import { OSGlyph } from "../assets/os-glyphs";
import { type SettingsHost, useSettingsProjection } from "../data";
import { AgentsSection } from "./agents";
import { ReviewSettings } from "./model-mappings";
import { PairingSection } from "./pairing";
import { SourceControlSection } from "./source-control";

// ─────────────────────────────────────────────────────────────────────────────
// One environment card (C10 §3, claims 585–594). The MACHINE, not its tooling:
// which OS it runs, how Rennet reaches it, and what its daemon reports. Ported
// from the spike's `EnvironmentCard` — layout faithful, every value rewritten onto
// the settings projection seam (one hosts state, edits flow through `renameHost` /
// `removeHost`, never a local copy).
//
//   • header — OS glyph, the name (inline-renameable), a WSL chip for a WSL host,
//     and either the mono address or a "Local" chip; rename on every card, Remove
//     on remote hosts only (This Machine is where Rennet runs).
//   • daemon meta — the honest connection line: the version when reachable, and one
//     of two "Not connected" lines otherwise (never inventing a current version).
//     Reconnect appears only when unreachable; Update Daemon only when this host has
//     an update (button-only — no auto-apply, reconciliation 6).
//   • Remove — the ONE sanctioned destructive confirmation (task 3.4): it names the
//     projects + sessions it forgets and states the machine itself is untouched.
//
// Source Control (§4), Agents and Review model mappings (§5) mount below the
// daemon line, each reading its own slice of the one hosts projection.
// ─────────────────────────────────────────────────────────────────────────────

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The daemon connection line — the resolver's honest answer, never a guess. */
function daemonLine(host: SettingsHost): string {
  const { reachable, version, lastSeenVersion } = host.daemon;
  if (reachable) return version ? `Rennet daemon v${version}` : "Rennet daemon — version unknown";
  if (lastSeenVersion) return `Not connected — last seen running Rennet daemon v${lastSeenVersion}`;
  return "Not connected — daemon unreachable, version unknown";
}

/** The Remove confirmation's blast-radius sentence — names the counts it forgets. */
function removeDescription(host: SettingsHost): string {
  const projects = host.projectCount ?? 0;
  const sessions = host.sessionCount ?? 0;
  if (projects === 0)
    return "This removes the environment from Rennet. The machine itself is not touched.";
  const sessionClause = sessions > 0 ? ` and ${plural(sessions, "session")}` : "";
  return `This removes the environment, its ${plural(projects, "project")}${sessionClause}, from Rennet. The machine itself is not touched.`;
}

export function HostCard({ host }: { readonly host: SettingsHost }) {
  const projection = useSettingsProjection();
  // Which agents this host may use lives on the card, because the Review section
  // below depends on the answer — one hosts projection, no local copy (§5.1).
  const enabledAgentIds = (projection.agentsByHost[host.id] ?? [])
    .filter((tool) => tool.enabled)
    .map((tool) => tool.id);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Take focus + select the moment the rename field opens (the a11y-safe autofocus).
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function commitRename() {
    // An emptied name keeps the old one (the sidebar rename's rule).
    projection.renameHost(host.id, draft.trim() || host.name);
    setRenaming(false);
  }

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") commitRename();
    if (event.key === "Escape") {
      // Clear the editor WITHOUT closing settings (the takeover root's Escape handler).
      event.stopPropagation();
      setRenaming(false);
    }
  }

  return (
    <div
      data-slot="host-card"
      data-host={host.id}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface/40 p-4"
    >
      <div className="flex items-center gap-2">
        <OSGlyph os={host.os} className="shrink-0 text-ink-soft" />
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={onRenameKeyDown}
            aria-label="Environment name"
            className="min-w-0 flex-1 rounded-sm bg-raised px-1 py-0.5 text-sm font-medium text-ink outline-none"
          />
        ) : (
          <span className="truncate text-sm font-medium text-ink">{host.name}</span>
        )}
        {host.os === "wsl" ? (
          <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 font-mono text-2xs text-ink-soft">
            WSL
          </span>
        ) : null}
        {host.address ? (
          <span className="truncate font-mono text-2xs text-ink-faint">{host.address}</span>
        ) : (
          <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-2xs font-medium text-ink-soft">
            Local
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Rename ${host.name}`}
            className="text-ink-soft hover:text-ink"
            onClick={() => {
              setDraft(host.name);
              setRenaming(true);
            }}
          >
            <Icon icon={Pencil} />
          </Button>
          {/* This Machine is where Rennet runs — there is nothing to remove. */}
          {host.kind !== "local" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${host.name}`}
              className="text-ink-soft hover:text-destructive"
              onClick={() => setRemoveOpen(true)}
            >
              <Icon icon={Trash2} />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-ink-soft">
        <span>{daemonLine(host)}</span>
        {/* Reconnect / Update Daemon are the affordances; the daemon dial + apply are
            B10-side detection (cluster 10) — button-only here (reconciliation 6), never
            a faked local action. Their VISIBILITY is the honest, testable behaviour. */}
        {!host.daemon.reachable ? (
          <Button variant="outline" size="xs">
            Reconnect
          </Button>
        ) : null}
        {host.daemon.reachable && host.daemon.updateAvailable ? (
          <Button variant="outline" size="xs">
            Update Daemon
          </Button>
        ) : null}
      </div>

      <SourceControlSection host={host} />

      <AgentsSection host={host} />

      <ReviewSettings host={host} enabledIds={enabledAgentIds} />

      {/* Pairing bootstraps a connection to THIS daemon — local card only (§11 salvage). */}
      {host.kind === "local" ? <PairingSection /> : null}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {host.name}?</DialogTitle>
            <DialogDescription>{removeDescription(host)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setRemoveOpen(false);
                projection.removeHost(host.id);
              }}
            >
              Remove Environment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { daemonLine, removeDescription };
