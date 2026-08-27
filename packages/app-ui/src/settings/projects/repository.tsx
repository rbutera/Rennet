import type { ProjectVisibility, ResolvedProvenance, SettingsProject } from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { Monitor, Server } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Icon } from "../../components/icon";
import type { SidebarHost, SidebarProject } from "../../shell/sidebar-data";
import { Row, Section, Segmented } from "../atoms";
import {
  toProvenance,
  usePinRepoValue,
  useResetRepoValue,
  useSetRepoVisibility,
  useSettingsView,
} from "../data";
import { ProvenanceChip } from "../provenance-chip";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Repository section (C10 §8.4, claims 656–658). The LIVE part of
// the page: Review Context (local vs git-visible) reads and writes the real
// `settings.setRepoVisibility` with its resolver provenance chip; the promotion
// state is shown; and "Runs on" is a DISPLAYED DETECTED FACT — a provenance chip,
// a host glyph, and the host name, with NO editable override (reconciliation 7).
//
// A project can carry MORE THAN ONE repo (a workspace): the protocol emits one
// `SettingsProject` row PER repo, each keyed by its own `repoPath`. So this renders
// EVERY row for the scoped project, not just the first — a two-repo workspace shows
// both, and each control writes through ITS OWN `repoPath` (never collapsed onto the
// first repo). Each write is INSPECTED: a `status` other than `applied` (an
// unresolved checkout, a refused-because-malformed config) or a transport rejection
// is DISCLOSED, never silently adopted as done. The ladder controls (Pin the current
// effective value at the repo layer / Reset the repo entry back to inheritance) ride
// the real `pinRepoValue` / `resetRepoValue` commands — plain buttons, no ceremony.
// ─────────────────────────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS = [
  { id: "local", label: "local" },
  { id: "git-visible", label: "git-visible" },
] as const;

/** A repo path's last two segments — enough to tell a workspace's repos apart. */
function repoLabel(repoPath: string): string {
  const segments = repoPath.split(/[/\\]+/).filter(Boolean);
  return segments.slice(-2).join("/") || repoPath;
}

/** The honest one-liner a non-apply write outcome earns (nothing was written). */
function noopOutcomeText(status: "unresolved" | "malformed"): string {
  return status === "unresolved"
    ? "Couldn’t resolve this checkout — nothing was written."
    : "The repo config is malformed — the change was refused.";
}

export function RepositorySection({
  project,
  host,
}: {
  readonly project: SidebarProject;
  readonly host: SidebarHost;
}) {
  const { data, pending, error } = useSettingsView();
  // A project contributes ONE row per repo (a workspace ⇒ several); render them all so a
  // multi-repo project's other repos are reachable, not collapsed onto the first row.
  const rows = data?.projects.filter((p) => p.projectId === project.id) ?? [];

  // A live-read that is in-flight or FAILED is shown as its own state — never masked as
  // the genuine "not yet scanned" empty (which means the read succeeded with no repo row).
  let body: ReactNode;
  if (pending) {
    body = (
      <Row label="Review Context" hint="whether .rennet is visible to git">
        <span className="text-xs text-ink-soft">Loading…</span>
      </Row>
    );
  } else if (error) {
    body = (
      <Row label="Review Context" hint="whether .rennet is visible to git">
        <span className="text-xs text-accent">
          Couldn’t read settings: {error instanceof Error ? error.message : String(error)}
        </span>
      </Row>
    );
  } else if (rows.length === 0) {
    body = (
      <Row label="Review Context" hint="whether .rennet is visible to git">
        <span className="text-xs text-ink-soft">not yet scanned</span>
      </Row>
    );
  } else {
    body = rows.map((row) => (
      <RepoRow key={row.repoPath} row={row} host={host} showRepoLabel={rows.length > 1} />
    ));
  }

  return (
    <Section title="Repository" caption={`.rennet/ in ${project.name}`}>
      {body}
    </Section>
  );
}

/** One repo's rows (Review Context + Promotion + Runs on) for a single `repoPath`. */
function RepoRow({
  row,
  host,
  showRepoLabel,
}: {
  readonly row: SettingsProject;
  readonly host: SidebarHost;
  readonly showRepoLabel: boolean;
}) {
  const setVisibility = useSetRepoVisibility();
  const pinValue = usePinRepoValue();
  const resetValue = useResetRepoValue();
  // The honest result of the LAST write on THIS repo — a rejection, or a no-op outcome
  // that wrote nothing. Cleared before each attempt; an `applied` write leaves it clear
  // (the invalidated `settings.get` refetch re-renders the resolver's own answer).
  const [notice, setNotice] = useState<string | undefined>();

  const busy = setVisibility.pending || pinValue.pending || resetValue.pending;
  const label = repoLabel(row.repoPath);

  // "Runs on" is where this project's commands run — a detected fact: the row's locus
  // provenance when known, else a detected chip of the host itself (never invented).
  const locusProvenance: ResolvedProvenance =
    row.locusProvenance ?? toProvenance({ value: host.label, layer: "detected" });

  // Visibility resolved FROM the repo layer ⇒ an explicit repo entry exists, so offer
  // Reset (fall back down the ladder). Otherwise offer Pin (freeze the current effective
  // value at the repo layer so a lower-layer change no longer moves it).
  const pinnedAtRepo = row.visibilityProvenance.layer === "repo";

  async function changeVisibility(visibility: ProjectVisibility) {
    if (busy || row.configMalformed) return;
    setNotice(undefined);
    try {
      const outcome = await setVisibility.mutate({
        commandId: crypto.randomUUID(),
        projectId: row.projectId,
        repoPath: row.repoPath,
        visibility,
      });
      if (outcome.status !== "applied") setNotice(noopOutcomeText(outcome.status));
    } catch (reason) {
      setNotice(`The write failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  async function pinOrReset() {
    if (busy || row.configMalformed) return;
    setNotice(undefined);
    const input = { projectId: row.projectId, repoPath: row.repoPath, key: "visibility" } as const;
    try {
      const outcome = pinnedAtRepo ? await resetValue.mutate(input) : await pinValue.mutate(input);
      if (outcome.status !== "applied") setNotice(noopOutcomeText(outcome.status));
    } catch (reason) {
      setNotice(`The write failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  return (
    <>
      {showRepoLabel ? (
        <Row label={<span className="font-mono text-2xs text-ink-soft">{label}</span>}>
          <span className="sr-only">{row.repoPath}</span>
        </Row>
      ) : null}
      <Row label="Review Context" hint="whether .rennet is visible to git">
        <ProvenanceChip provenance={row.visibilityProvenance} />
        <Segmented
          ariaLabel={`Review context for ${label}`}
          options={VISIBILITY_OPTIONS}
          value={row.visibility}
          disabled={busy || row.configMalformed}
          onChange={(visibility) => void changeVisibility(visibility)}
        />
        <Button
          variant="ghost"
          size="xs"
          disabled={busy || row.configMalformed}
          aria-label={
            pinnedAtRepo
              ? `Reset review context for ${label} to inherit`
              : `Pin review context for ${label} at the repo`
          }
          onClick={() => void pinOrReset()}
        >
          {pinnedAtRepo ? "Reset" : "Pin"}
        </Button>
      </Row>
      {row.configMalformed ? (
        <div className="py-1 text-2xs text-ink-soft">
          This repo&rsquo;s <code className="font-mono">config.json</code> is malformed — edits are
          refused until it is fixed.
        </div>
      ) : notice ? (
        <div className="py-1 text-2xs text-accent" role="status">
          {notice}
        </div>
      ) : null}
      <Row label="Promotion" hint="review context committed and shared via the repo">
        <ProvenanceChip provenance={row.promotedProvenance} />
        <span className="text-xs text-ink-soft">{row.promoted ? "promoted" : "not promoted"}</span>
      </Row>
      <Row label="Runs on" hint="where this project's commands run">
        {/* Detection only — no override control on the surface (reconciliation 7). */}
        <ProvenanceChip provenance={locusProvenance} />
        <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink">
          <Icon icon={host.kind === "local" ? Monitor : Server} className="size-3 text-ink-soft" />
          {host.label}
        </span>
      </Row>
    </>
  );
}
