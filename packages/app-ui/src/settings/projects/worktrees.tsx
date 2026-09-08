import type { SettingsProject, WorktreeKind, WorktreeRow } from "@rennet/protocol";
import { Button, cn } from "@rennet/ui";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import type { SidebarProject } from "../../shell/sidebar-data";
import { Row, Section, Segmented } from "../atoms";
import {
  useRemoveWorktree,
  useSetProjectValue,
  useSettingsView,
  useWorktreeInventory,
} from "../data";
import { ProvenanceChip } from "../provenance-chip";
import { UnbackedNote } from "./unbacked-note";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Worktrees section (workspace-settings D7) — WHERE A REVIEW ACTUALLY
// WORKS, and what Rennet has left lying around from the ones before it.
//
// The card used to state the binding in prose because nothing read the settings (#812).
// The binding reads them now, so the card is controls again: a LOCATION, a LAYOUT (two
// patterns), a WORKSPACE mode, and the WORKSPACES that exist.
//
// EVERYTHING KEYED BY THE ROW, NEVER BY THE PROJECT. A workspace project maps many
// repositories onto one identity and that mapping is not invertible (CLAUDE.md,
// 2026-08-28), so two repos of one workspace get two blocks: each resolves its own
// values, previews its own paths, lists its own workspaces, and writes through its OWN
// `repoPath`. The previous shape keyed the card by project id and showed one repo's
// answer under both repos' names.
//
// NO PATH IS DERIVED HERE. The two preview lines are strings the DAEMON resolved through
// the same functions the binding calls (`worktreePreview`, D3) — the client has neither
// the data directory nor the escaped repo key, and every past attempt to derive one was
// wrong. The inventory's paths are the rows' own. app-ui prints what it was handed.
//
// ONE FILE, ONE RUNG. All four controls write the REPO rung — the project's own
// `config.json`, addressed by THIS row's `repoPath`, exactly as the identity and tracker
// rows are. Each of the four is a decision about ONE repository: the binding is per
// repository and so are its siblings (D4), so a workspace's two repos can differ, and a
// host-wide write from here would answer for a repository the reviewer was not looking at.
//
// The HOST rung (`daemon-settings.json` → `worktrees.*`) is READ — it is the `global` layer
// of these four keys and the chip names it when it wins — and it is edited by hand, exactly
// as the tracker's global rung is. No surface in Rennet edits a host rung today, and one
// would be its own feature rather than a corner of this card.
//
// That single rung is what makes provenance, Reset and Pin COHERENT here: a write lands on
// `layer: "repo"`, so the chip says `repo` and the button becomes Reset; Reset drops that
// entry and the chip falls back to whatever the ladder answers underneath (the host rung, or
// the builtin). A control that wrote the host rung and offered a repo-rung Reset was three
// facts about three different files under one button.
//
// The chip says which rung answered, and it says it from the RESOLVER's re-read — every
// write stales `settings.get`, so the row settles on what is stored, never on the click.
//
// NOTHING HERE CONFIRMS ANYTHING (Rule Zero). A removal runs on the first click; what
// stops it is git, whose refusal is printed verbatim on the row. A pattern that escapes
// the root or names a token the grammar does not have is refused by the write, and that
// reason lands under the field — no dialog, no are-you-sure.
// ─────────────────────────────────────────────────────────────────────────────

/** The ONE file this section writes, named for the reader who wants to go open it. */
const BACKING_FILE = "projects/<repo>/config.json";

/** The section's four editable values, each named by the repo-rung key it reads AND
 *  writes. ONE table, so a control cannot pin a different setting from the one it edits. */
const KEYS = {
  root: "worktreeRoot",
  pattern: "worktreePattern",
  prPattern: "prWorktreePattern",
  workspace: "workspace",
} as const satisfies Record<
  string,
  "worktreeRoot" | "worktreePattern" | "prWorktreePattern" | "workspace"
>;

type FieldKey = keyof typeof KEYS;

const WORKSPACE_OPTIONS = [
  { id: "share", label: "share" },
  { id: "own", label: "own" },
] as const;

/** What a workspace IS. The row's own fact, in the reviewer's words — never "created by
 *  Rennet" or another sentence about Rennet's machinery. */
const KIND_LABEL: Record<WorktreeKind, string> = {
  "own-checkout": "your own checkout",
  branch: "branch",
  sibling: "sibling",
  "pull-request": "pull request",
};

/** A repo path's last two segments — enough to tell a workspace's repos apart (the same
 *  label the Repository section uses, so one repo reads the same in both). */
function repoLabel(repoPath: string): string {
  const segments = repoPath.split(/[/\\]+/).filter(Boolean);
  return segments.slice(-2).join("/") || repoPath;
}

/** Escape clears the field WITHOUT closing the settings takeover (the root handler). */
function stopEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape") {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).blur();
  }
}

/** A measured size, or the em dash the wire's `undefined` means: the measurement did not
 *  finish inside its bound. Absent is UNKNOWN, never zero. */
function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** An epoch-ms stamp as a date. Absent stamps render NOTHING — an empty cell explaining
 *  itself is the chrome the no-self-explaining rule forbids. */
function dayText(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString();
}

/** The honest one-liner a non-apply repo write earns (nothing was written). */
function noopOutcomeText(status: "unresolved" | "malformed"): string {
  return status === "unresolved"
    ? "Couldn’t resolve this checkout — nothing was written."
    : "The repo config is malformed — the change was refused.";
}

function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function WorktreeSection({ project }: { readonly project: SidebarProject }) {
  const { data, pending, error } = useSettingsView();
  // One row per repo, all of them rendered: a workspace's second repository places its
  // worktrees under its own answer, and collapsing onto the first would show one repo's
  // preview under the other's name.
  const rows = data?.projects.filter((row) => row.projectId === project.id) ?? [];

  let body: ReactNode;
  if (pending) {
    body = <Standin>Loading…</Standin>;
  } else if (error) {
    body = <Standin accent>Couldn’t read settings: {failureText(error)}</Standin>;
  } else if (rows.length === 0) {
    body = <Standin>not yet scanned</Standin>;
  } else {
    body = rows.map((row) => (
      <RepoWorktrees key={row.repoPath} row={row} showRepoLabel={rows.length > 1} />
    ));
  }

  return (
    <Section title="Worktrees" caption={BACKING_FILE}>
      {body}
    </Section>
  );
}

/** The Location row's stand-in while there is no row to render controls from. */
function Standin({
  children,
  accent,
}: {
  readonly children: ReactNode;
  readonly accent?: boolean;
}) {
  return (
    <Row label="Location" hint="where Rennet places a worktree it makes">
      <span className={cn("text-xs", accent ? "text-accent" : "text-ink-soft")}>{children}</span>
    </Row>
  );
}

/** One repository's whole section: its four values, and its workspaces. */
function RepoWorktrees({
  row,
  showRepoLabel,
}: {
  readonly row: SettingsProject;
  readonly showRepoLabel: boolean;
}) {
  const setRepoValue = useSetProjectValue();
  // A daemon that does not serve the rung claims nothing: the editors sit disabled and
  // the gap is disclosed, rather than an enabled field over a write with nowhere to go.
  const prefs = row.prefs;
  const backed = prefs !== undefined;
  const editable = backed && !row.configMalformed;
  const label = repoLabel(row.repoPath);
  /** The answer to the LAST write on THIS repo, keyed by the field it came from — a
   *  refused pattern names which rule it broke, and the newest answer replaces the old. */
  const [notice, setNotice] = useState<{ key: FieldKey; text: string } | undefined>();
  const busy = setRepoValue.pending;

  /** THE write of this section: the repo rung, addressed by THIS row's own `repoPath`.
   *  Every control goes through it — the three text fields on commit, the workspace
   *  segments, and Pin/Reset on all four — so one write reaches one file and the chip
   *  above it reports the rung that write actually landed on.
   *
   *  A REFUSED value (a pattern with an unknown token, or one that escapes the root)
   *  arrives here as a rejection carrying git-level honesty about WHICH rule it broke.
   *  Printed as it came: the reason is the instruction. */
  async function writeRepo(key: FieldKey, value: string | null) {
    setNotice(undefined);
    try {
      const outcome = await setRepoValue.mutate({
        projectId: row.projectId,
        repoPath: row.repoPath,
        key: KEYS[key],
        value,
      });
      if (outcome.status !== "applied") {
        setNotice({ key, text: noopOutcomeText(outcome.status) });
      }
    } catch (reason) {
      setNotice({ key, text: failureText(reason) });
    }
  }

  /** Pin the current effective value at the repo rung, or reset the repo entry away. */
  function pinOrReset(key: FieldKey, pinned: boolean, effective: string) {
    void writeRepo(key, pinned ? null : effective);
  }

  const field = (
    key: Exclude<FieldKey, "workspace">,
    rowLabel: string,
    hint: string,
    /** The grammar a LAYOUT field takes, shown only while the field is empty. Location has
     *  none: its builtin is a real resolved directory the daemon serves on the row, and the
     *  literal `~/.rennet/worktrees` that used to sit here was the #812 path — a folder
     *  Rennet never created, printed as if it were the answer. */
    placeholder: string,
    preview?: string,
  ) => {
    const value = prefs?.[KEYS[key]] ?? { value: "", layer: "builtin" as const };
    return (
      <Row label={rowLabel} hint={hint} stacked>
        <div className="flex flex-wrap items-center gap-2">
          <LocationField
            ariaLabel={`${rowLabel} for ${label}`}
            value={value.value}
            placeholder={placeholder}
            disabled={!editable || busy}
            onCommit={(next) => void writeRepo(key, next.trim() === "" ? null : next)}
          />
          {/* The rung the RESOLVER reported. The wire's per-project prefs carry the
              effective layer and no contribution list, so the chip shows the summary and
              claims no contributions — never a list this file recomputed. */}
          <ProvenanceChip provenance={{ layer: value.layer, contributions: [] }} />
          <Button
            variant="ghost"
            size="xs"
            disabled={!editable || busy}
            aria-label={
              value.layer === "repo"
                ? `Reset ${rowLabel.toLowerCase()} for ${label} to inherit`
                : `Pin ${rowLabel.toLowerCase()} for ${label} at the repo`
            }
            onClick={() => pinOrReset(key, value.layer === "repo", value.value)}
          >
            {value.layer === "repo" ? "Reset" : "Pin"}
          </Button>
        </div>
        {preview ? (
          <span data-slot="worktree-preview" className="font-mono text-2xs text-ink-soft">
            {preview}
          </span>
        ) : null}
        {notice?.key === key ? (
          <span
            data-slot="worktree-refusal"
            role="status"
            className="whitespace-pre-wrap text-2xs text-accent"
          >
            {notice.text}
          </span>
        ) : null}
      </Row>
    );
  };

  const workspace = prefs?.workspace ?? { value: "share", layer: "builtin" as const };

  return (
    <>
      {showRepoLabel ? (
        <Row label={<span className="font-mono text-2xs text-ink-soft">{label}</span>}>
          <span className="sr-only">{row.repoPath}</span>
        </Row>
      ) : null}
      {field(
        "root",
        "Location",
        // D1's one line: a session binds once, so a move reaches the next one.
        "the directory Rennet's worktrees hang under; a change reaches sessions started after it",
        "",
      )}
      {field(
        "pattern",
        "Branch layout",
        "under the location: {repo}, {name}, {owner}, {branch}",
        "{repo}/{branch}",
        row.worktreePreview?.branch,
      )}
      {field(
        "prPattern",
        "Pull-request layout",
        "under the location: {owner}, {name}, {repo}, {number}",
        "{owner}/{name}/pr-{number}",
        row.worktreePreview?.pullRequest,
      )}
      <Row label="Workspace" hint="a review of a branch a checkout already has out" stacked>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel={`Workspace for ${label}`}
            options={WORKSPACE_OPTIONS}
            value={workspace.value === "own" ? "own" : "share"}
            disabled={!editable || busy}
            onChange={(next) => void writeRepo("workspace", next)}
          />
          <ProvenanceChip provenance={{ layer: workspace.layer, contributions: [] }} />
          <Button
            variant="ghost"
            size="xs"
            disabled={!editable || busy}
            aria-label={
              workspace.layer === "repo"
                ? `Reset workspace for ${label} to inherit`
                : `Pin workspace for ${label} at the repo`
            }
            onClick={() => pinOrReset("workspace", workspace.layer === "repo", workspace.value)}
          >
            {workspace.layer === "repo" ? "Reset" : "Pin"}
          </Button>
        </div>
        {/* One sentence per option, each about the reviewer's own branch — what happens
            to it, not what Rennet does to itself. */}
        <span className="text-xs text-ink-soft">
          share — the review works in that checkout, and the round commits on your branch.
        </span>
        <span className="text-xs text-ink-soft">
          own — your checkout is left alone; the round&rsquo;s commits go on{" "}
          <code className="font-mono">rennet/&lt;branch&gt;</code> until you fast-forward.
        </span>
        {notice?.key === "workspace" ? (
          <span
            data-slot="worktree-refusal"
            role="status"
            className="whitespace-pre-wrap text-2xs text-accent"
          >
            {notice.text}
          </span>
        ) : null}
      </Row>
      <Workspaces repoPath={row.repoPath} label={label} />
      {row.configMalformed ? (
        <div className="py-1 text-2xs text-ink-soft">
          This repo&rsquo;s <code className="font-mono">config.json</code> is malformed — edits are
          refused until it is fixed.
        </div>
      ) : null}
      {backed ? null : (
        <div className="py-2.5">
          <UnbackedNote>
            Worktree settings aren&rsquo;t served yet — this lands with the settings engine.
          </UnbackedNote>
        </div>
      )}
    </>
  );
}

/** A text field holding a LOCAL draft, committed on blur/Enter. Each commit is a disk
 *  write, so a per-keystroke binding would write once per character and, on a controlled
 *  input, drop characters whenever the round trip lagged the typing (the same shape the
 *  Identity name field uses). */
function LocationField({
  ariaLabel,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  readonly ariaLabel: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next !== value) onCommit(next);
  }
  return (
    <input
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        stopEscape(event);
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={false}
      className={cn(
        "w-72 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus-visible:border-accent-line focus-visible:outline-none",
        disabled && "cursor-not-allowed opacity-60",
      )}
    />
  );
}

/** The D6 inventory for ONE repository: what exists, and the removal of an idle row
 *  Rennet made. Asked here rather than on the page, so a repository's sizes are measured
 *  only while this card is on screen for it. */
function Workspaces({ repoPath, label }: { readonly repoPath: string; readonly label: string }) {
  const { data, pending, error } = useWorktreeInventory(repoPath);
  const remove = useRemoveWorktree();
  /** Each removal's answer, keyed by the row it named. Kept here, not on the row, because
   *  a successful removal takes its row out of the next list and its note — what was
   *  deliberately KEPT — would go with it. One entry per row, not one slot: two removals
   *  in flight must not wipe each other's answer, and git's refusal of the first must
   *  still be on screen when the second lands. */
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const answer = (id: string, text: string) =>
    setOutcomes((held) => new Map([...held, [id, text]]));
  /** WHICH row is being removed. `remove.pending` is one flag for the whole hook, so it
   *  disabled every row's button at once — a fact about the mutation, rendered as a fact
   *  about four workspaces nothing is happening to. */
  // One entry per in-flight removal, keyed by row: two rows removed back to back must not
  // share a flag, or the second click re-enables the first row and whichever answer lands
  // first clears both.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());

  const rows = data?.rows ?? [];
  /** Answers whose row is GONE from the list — the successful case. */
  const orphaned = [...outcomes].filter(([id]) => !rows.some((row) => row.id === id));

  async function removeRow(row: WorktreeRow) {
    setOutcomes((held) => {
      const next = new Map(held);
      next.delete(row.id);
      return next;
    });
    setRemoving((held) => new Set([...held, row.id]));
    try {
      const reply = await remove.mutate({ repoPath, id: row.id });
      answer(
        reply.id,
        reply.status === "removed" ? (reply.note ?? `Removed ${reply.path}`) : reply.reason,
      );
    } catch (reason) {
      answer(row.id, failureText(reason));
    } finally {
      setRemoving((held) => {
        const next = new Set(held);
        next.delete(row.id);
        return next;
      });
    }
  }

  /** The last removal's answer when its row is GONE from the list — the successful case,
   *  where the note (what was deliberately KEPT: `rennet/<branch>` and why) would otherwise
   *  leave with the row it named. Rendered beside the list rather than inside it, because
   *  removing the LAST row empties the list and the empty branch used to swallow the note
   *  entirely: the one removal whose sentence matters most said nothing at all. */
  const orphanNote =
    orphaned.length > 0
      ? orphaned.map(([id, text]) => (
          <span
            key={id}
            data-slot="worktree-outcome"
            role="status"
            className="whitespace-pre-wrap text-2xs text-ink-soft"
          >
            {text}
          </span>
        ))
      : null;

  let body: ReactNode;
  if (pending) {
    body = <span className="text-xs text-ink-soft">Loading…</span>;
  } else if (error) {
    body = (
      <span className="text-xs text-accent">Couldn’t read workspaces: {failureText(error)}</span>
    );
  } else if (rows.length === 0) {
    body = (
      <span data-slot="worktree-empty" className="text-xs text-ink-soft">
        Nothing yet. Rennet&rsquo;s worktrees for this repository appear here.
      </span>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <WorkspaceRow
            key={row.id}
            row={row}
            label={label}
            busy={removing.has(row.id)}
            outcome={outcomes.get(row.id)}
            onRemove={() => void removeRow(row)}
          />
        ))}
        {data?.truncated ? (
          <span className="text-2xs text-ink-soft">
            This repository has more workspaces than this list carries.
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Row label="Workspaces" hint="every workspace Rennet knows for this repository" stacked>
      {body}
      {orphanNote}
    </Row>
  );
}

/** One inventory row: what it is, what it holds, and the removal when one is offered. */
function WorkspaceRow({
  row,
  label,
  busy,
  outcome,
  onRemove,
}: {
  readonly row: WorktreeRow;
  readonly label: string;
  readonly busy: boolean;
  readonly outcome: string | undefined;
  readonly onRemove: () => void;
}) {
  return (
    <div
      data-slot="worktree-row"
      data-kind={row.kind}
      className="flex flex-col gap-1 rounded-md border border-line px-2.5 py-2"
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* The path AS THE HOST SPELLS IT (or, over a projected connection, as the
              reference it was scrubbed into). Never assembled here. */}
          <span className="break-all font-mono text-xs text-ink">{row.path}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-soft">
            <span>{KIND_LABEL[row.kind]}</span>
            {row.ref ? <code className="font-mono">{row.ref}</code> : null}
            <span>{sizeText(row.sizeBytes)}</span>
            {row.createdAt === undefined ? null : <span>made {dayText(row.createdAt)}</span>}
            {row.lastUsedAt === undefined ? null : <span>used {dayText(row.lastUsedAt)}</span>}
          </span>
          {row.aheadOf ? (
            <span className="text-2xs text-ink-soft">
              ahead of <code className="font-mono">{row.aheadOf.branch}</code> by{" "}
              {row.aheadOf.commits} {row.aheadOf.commits === 1 ? "commit" : "commits"}
            </span>
          ) : null}
          {/* The host's own sentence about what a removal would KEEP. Printed as given. */}
          {row.keepsBranch ? (
            <span data-slot="worktree-keeps" className="text-2xs text-ink-soft">
              {row.keepsBranch}
            </span>
          ) : null}
          {row.sessionIds.length > 0 ? (
            // The ids the wire carried (capped at 20 there). A truncated row says only
            // what it KNOWS — that there are more than these — because the total was
            // never sent and "+N more" would be a number nobody counted.
            <span data-slot="worktree-sessions" className="text-2xs text-ink-soft">
              {row.sessionIds.join(", ")}
              {row.sessionsTruncated ? ` … more than ${row.sessionIds.length}` : ""}
            </span>
          ) : null}
        </div>
        {row.removable ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0"
            disabled={busy}
            aria-label={`Remove workspace ${row.path} in ${label}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
      </div>
      {outcome ? (
        // Git's own words when git refused, and Rennet's own when a row could not be
        // addressed. Never rewritten, never softened: the refusal is the instruction.
        <span
          data-slot="worktree-outcome"
          role="status"
          className="whitespace-pre-wrap text-2xs text-accent"
        >
          {outcome}
        </span>
      ) : null}
    </div>
  );
}
