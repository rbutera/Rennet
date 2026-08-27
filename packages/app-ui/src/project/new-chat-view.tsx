import type { Project, SmartListCi } from "@rennet/protocol";
import { cn, Popover, PopoverContent, PopoverTrigger, Toggle, ToggleGroup } from "@rennet/ui";
import {
  ArrowUp,
  Check,
  ChevronDown,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Map as MapIcon,
  MoveLeft,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Icon } from "../components/icon";
import { useCommand } from "../data";
import { newChatPath, projectMapPath } from "../routes/url";
import { TargetIcon } from "../shell/sidebar/target-icon";
import { type SessionTarget, type SessionTargetState, TARGET_LABEL } from "../shell/sidebar-data";
import {
  buildSmartRows,
  filterSmartRows,
  type SmartFilter,
  type SmartRow,
  smartListCounts,
  sortSmartRows,
} from "./smart-list";

/** The unified target vocabulary's STATE labels (R36) — a row with a state reads by its
 *  state, not its bare kind, so "Needs you" / "Merged" / "Reviewed" surface honestly. */
const STATE_LABEL: Record<SessionTargetState, string> = {
  "needs-you": "Needs you",
  merged: "Merged",
  reviewed: "Reviewed",
};

// ─────────────────────────────────────────────────────────────────────────────
// The New Chat view (C12 §10.8, /new-chat?project=…). A full-view takeover — there
// is no session yet, so no chat column. The header carries the project › New Chat
// trail, a Map control, and the esc hint; Escape closes the page. The headline asks
// "What should we review in <project>?" with the project name as a headline-sized
// inline picker — changing it resets the target and rewrites the URL. A bottom
// composer carries the review target as a chip (X resets to the current checkout)
// and its Send is inert while empty.
//
// The smart list (the review-target picker) is cluster 6.2; live session minting
// from a row is the GATED cluster 7 (B9) behind `new-chat-mint.ts`. Cluster 6 builds
// every surface it can against the projection seam — selection, not minting.
// ─────────────────────────────────────────────────────────────────────────────

/** The chosen review target: the whole-project current checkout (default), or a row
 *  from the smart list. */
export type NewChatTarget =
  | { readonly kind: "checkout" }
  | { readonly kind: "row"; readonly row: SmartRow };

/** The tab vocabulary → smart-list filter. One list, no zones — the tabs are a filter. */
const TABS: readonly { readonly filter: SmartFilter; readonly label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "needs-you", label: "Needs you" },
  { filter: "mine", label: "Mine" },
  { filter: "local", label: "Local" },
  { filter: "prs", label: "PRs" },
];

/** The row's `owner/name`, for the repo column (dropped when the workspace is single-repo). */
function repoOf(row: SmartRow): string {
  return row.kind === "pr" ? (row.pr?.repository ?? "") : (row.local?.repository ?? "");
}

/** The documented text-filter fields: PR number/title/branch/repo/author; local branch+repo. */
function matchesText(row: SmartRow, needle: string): boolean {
  if (!needle) return true;
  const hay =
    row.kind === "pr"
      ? `#${row.pr?.number} ${row.title} ${row.branch} ${row.pr?.repository} ${row.author}`
      : `${row.branch} ${row.local?.repository ?? ""}`;
  return hay.toLowerCase().includes(needle);
}

/** Fold a smart-list row onto the unified target vocabulary (R36 icon language). */
function targetOf(row: SmartRow): { kind: SessionTarget; state?: SessionTargetState } {
  if (row.kind === "local") return { kind: "your-branch" };
  if (row.state === "merged" || row.state === "closed") {
    return { kind: row.mine ? "your-pr" : "teammate-pr", state: "merged" };
  }
  if (row.mine) return { kind: "your-pr" };
  return { kind: "teammate-pr", state: row.needsYou ? "needs-you" : undefined };
}

/** The composer chip's label for the current target. */
function targetChipLabel(target: NewChatTarget, branch: string): string {
  if (target.kind === "checkout") return `Current Checkout · ${branch}`;
  const row = target.row;
  return row.kind === "pr" ? `#${row.pr?.number} · ${row.branch}` : row.branch;
}

export function NewChatView({ projectId }: { readonly projectId: string }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { data: projectsData } = useCommand("projects.list", {});
  const projects = projectsData?.projects ?? [];
  const project = projects.find((candidate) => candidate.id === projectId);

  const [target, setTarget] = useState<NewChatTarget>({ kind: "checkout" });
  // Seed the composer from an `?ask=` handoff (the context map's "discuss" lands here with
  // the statement prefilled) — read once on mount; the reviewer edits or sends from there.
  const [message, setMessage] = useState(() => new URLSearchParams(search).get("ask") ?? "");
  const [tab, setTab] = useState<SmartFilter>("all");
  const [filter, setFilter] = useState("");

  const { data: detail } = useCommand("project.detail", { projectId });
  const rows = useMemo(
    () => (detail ? sortSmartRows(buildSmartRows(detail), "hot") : []),
    [detail],
  );
  const counts = useMemo(() => smartListCounts(rows), [rows]);
  const needle = filter.trim().toLowerCase();
  const visible = filterSmartRows(rows, tab).filter((row) => matchesText(row, needle));
  const showRepo = new Set(rows.map(repoOf)).size > 1;
  const selectedRowId = target.kind === "row" ? target.row.id : null;

  const close = () => navigate(newChatPath());

  // Escape closes the page (the filter input's own Escape stops there first — 6.2). `navigate`
  // is wouter-stable, so the exhaustive dep re-subscribes only if it ever changes (finding 15).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") navigate(newChatPath());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  // Switching project rewrites the URL; reset the target back to the checkout. projectId
  // is the intended run trigger — the effect fires ON a project change to drop a stale
  // row selection (6.2), it does not read projectId in its body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is a run trigger, not a body reference.
  useEffect(() => {
    setTarget({ kind: "checkout" });
  }, [projectId]);

  const branch = project?.primaryBranch ?? "main";

  return (
    <section
      data-screen="new-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <button
          type="button"
          onClick={close}
          aria-label="Back"
          className="flex size-7 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={MoveLeft} className="size-4" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="shrink-0 text-ink-soft">{project?.name ?? projectId}</span>
          <span className="text-ink-faint">›</span>
          <span className="font-medium text-ink">New Chat</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(projectMapPath(projectId))}
            className="flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-xs font-medium text-ink-soft hover:bg-raised hover:text-ink"
          >
            <Icon icon={MapIcon} className="size-3.5" />
            Map
          </button>
          <kbd className="rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-faint">
            esc
          </kbd>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-8 pt-[7vh] pb-6">
          <h1 className="flex flex-wrap items-baseline justify-center gap-2 text-center font-display text-2xl font-medium tracking-tight text-ink">
            What should we review in
            <ProjectPicker
              projects={projects}
              current={project}
              onChange={(next) => navigate(newChatPath(next.id))}
            />
            ?
          </h1>

          <div className="mt-7 flex items-center gap-2">
            {/* The tabs are a single-select segmented control — ToggleGroup, not a
                hand-rolled aria-pressed group (no-handrolled-toggle, autopsy S6). */}
            <ToggleGroup
              value={[tab]}
              onValueChange={(next: string[]) => {
                if (next[0]) setTab(next[0] as SmartFilter);
              }}
              aria-label="Filter the review targets"
            >
              {TABS.map(({ filter: value, label }) => (
                <Toggle key={value} value={value} size="sm">
                  {label}
                  <span className="text-2xs text-ink-faint">{counts[value]}</span>
                </Toggle>
              ))}
            </ToggleGroup>
            <label className="ml-auto flex h-7 w-52 items-center gap-1.5 rounded-control border border-line bg-surface px-2 focus-within:border-accent-line">
              <Icon icon={Search} className="size-3.5 shrink-0 text-ink-faint" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  // Esc clears the filter first; a second Esc (empty filter) bubbles to
                  // the window handler and closes the page.
                  if (event.key === "Escape" && filter) {
                    event.stopPropagation();
                    setFilter("");
                  }
                }}
                placeholder="Filter"
                aria-label="Filter branches and pull requests"
                className="w-full bg-transparent text-xs text-ink placeholder:text-ink-faint focus-visible:outline-none"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-col divide-y divide-line overflow-hidden rounded-surface border border-line">
            <CheckoutRow
              branch={branch}
              selected={target.kind === "checkout"}
              onSelect={() => setTarget({ kind: "checkout" })}
            />
            {visible.map((row) => (
              <ItemRow
                key={row.id}
                row={row}
                showRepo={showRepo}
                selected={selectedRowId === row.id}
                onSelect={() => setTarget({ kind: "row", row })}
              />
            ))}
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-faint">
                {rows.length === 0 ? "No open branches or pull requests yet." : "Nothing matches."}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Composer
        target={target}
        branch={branch}
        message={message}
        onMessage={setMessage}
        onResetTarget={() => setTarget({ kind: "checkout" })}
      />
    </section>
  );
}

/** The headline-sized inline project picker — a Popover of the project list, matching
 *  the Add Project source picker. Choosing a project rewrites the URL (the parent). */
function ProjectPicker({
  projects,
  current,
  onChange,
}: {
  readonly projects: readonly Project[];
  readonly current: Project | undefined;
  readonly onChange: (project: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Project: ${current?.name ?? "none"}`}
        render={
          <button
            type="button"
            className="inline-flex items-baseline gap-1 rounded-control px-1.5 text-accent underline decoration-accent-line decoration-dotted underline-offset-4 hover:bg-raised"
          />
        }
      >
        {current?.name ?? "a project"}
        <Icon icon={ChevronDown} className="size-4 flex-none self-center text-ink-faint" />
      </PopoverTrigger>
      <PopoverContent align="center" className="min-w-56 gap-0 p-1">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-base text-ink hover:bg-raised"
            onClick={() => {
              setOpen(false);
              if (project.id !== current?.id) onChange(project);
            }}
          >
            <span className="flex-1 truncate">{project.name}</span>
            {project.id === current?.id ? (
              <Icon icon={Check} className="size-4 flex-none text-accent" />
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Composer({
  target,
  branch,
  message,
  onMessage,
  onResetTarget,
}: {
  readonly target: NewChatTarget;
  readonly branch: string;
  readonly message: string;
  readonly onMessage: (value: string) => void;
  readonly onResetTarget: () => void;
}) {
  return (
    <div className="shrink-0 px-8 pt-2 pb-5">
      <div className="mx-auto flex w-full max-w-[720px] flex-col rounded-surface border border-line bg-surface focus-within:border-accent-line">
        <textarea
          value={message}
          onChange={(event) => onMessage(event.target.value)}
          placeholder="Message the orchestrator"
          rows={3}
          aria-label="Message the orchestrator"
          className="w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus-visible:outline-none"
        />
        <div className="flex items-center gap-2 px-3 pt-1 pb-2.5">
          <span className="flex items-center gap-1.5 rounded-chip border border-line bg-raised px-2 py-1 text-xs text-ink-soft">
            <Icon
              icon={target.kind === "row" && target.row.kind === "pr" ? GitPullRequest : GitBranch}
              className="size-3 text-ink-faint"
            />
            {targetChipLabel(target, branch)}
            {target.kind !== "checkout" ? (
              <button
                type="button"
                onClick={onResetTarget}
                aria-label="Reset target to current checkout"
                className="flex size-3.5 items-center justify-center rounded-sm text-ink-faint hover:bg-raised hover:text-ink"
              >
                ×
              </button>
            ) : null}
          </span>
          <button
            type="button"
            disabled={!message.trim()}
            aria-label="Send"
            // Live minting is the GATED cluster 7 (B9) — the surface stops at the
            // typed ask + target here; no fake session is started.
            className={cn(
              "ml-auto flex size-8 shrink-0 items-center justify-center rounded-control transition-colors disabled:cursor-not-allowed",
              message.trim()
                ? "bg-accent-fill text-accent-ink hover:opacity-90"
                : "bg-raised text-ink-faint",
            )}
          >
            <Icon icon={ArrowUp} className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectionMark({ selected }: { readonly selected: boolean }) {
  return (
    <Icon
      icon={Check}
      className={cn(
        "size-4 shrink-0 text-accent transition-opacity",
        selected ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/** The unified target-vocabulary state chip: the R36 icon + its words. A row with a derived
 *  state reads by that state ("Needs you" / "Merged" / "Reviewed"); otherwise by its kind. */
function StateChip({ row }: { readonly row: SmartRow }) {
  const { kind, state } = targetOf(row);
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-soft">
      <TargetIcon kind={kind} state={state} className="size-3" />
      {state ? STATE_LABEL[state] : TARGET_LABEL[kind]}
    </span>
  );
}

/** The pinned "Current Checkout" row — the default target (whole project, no row). */
function CheckoutRow({
  branch,
  selected,
  onSelect,
}: {
  readonly branch: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors",
        selected ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      <Icon icon={GitBranch} className="size-3.5 shrink-0 text-ink-faint" />
      <span className="text-sm font-medium text-ink">Current Checkout</span>
      <span className="font-mono text-xs text-ink-soft">{branch}</span>
      <span className="ml-auto text-2xs text-ink-faint">no target — talk about the project</span>
      <SelectionMark selected={selected} />
    </button>
  );
}

function ItemRow({
  row,
  showRepo,
  selected,
  onSelect,
}: {
  readonly row: SmartRow;
  readonly showRepo: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const merged = row.state === "merged";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-1 px-3.5 py-2.5 text-left transition-colors",
        selected ? "bg-raised" : "hover:bg-raised/60",
        // Merged rows dim, and lift on hover/selection.
        merged && !selected && "opacity-50 hover:opacity-80",
      )}
    >
      {row.kind === "local" ? (
        <span className="flex w-full items-center gap-2">
          <Icon
            icon={GitBranch}
            className={cn("size-3.5 shrink-0", row.local?.dirty ? "text-accent" : "text-ink-faint")}
          />
          <span className="min-w-0 truncate font-mono text-sm font-medium text-ink">
            {row.branch}
          </span>
          {row.local?.dirty ? (
            <span className="shrink-0 text-2xs font-medium text-accent" title="uncommitted changes">
              ● dirty
            </span>
          ) : null}
          {row.local?.stage ? (
            <span className="min-w-0 truncate text-2xs text-ink-faint">{row.local.stage}</span>
          ) : null}
          {showRepo ? (
            <span className="shrink-0 text-2xs text-ink-faint">{repoOf(row)}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <StateChip row={row} />
            <SelectionMark selected={selected} />
          </span>
        </span>
      ) : (
        <>
          <span className="flex w-full items-center gap-2">
            <Icon
              icon={merged ? GitMerge : GitPullRequest}
              className={cn("size-3.5 shrink-0", row.needsYou ? "text-accent" : "text-ink-faint")}
            />
            <span className="min-w-0 truncate text-sm font-medium text-ink">{row.title}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <CiDot ci={row.pr?.ci} />
              <StateChip row={row} />
              <SelectionMark selected={selected} />
            </span>
          </span>
          <span className="flex w-full items-center gap-2.5 pl-[22px] text-2xs text-ink-soft">
            <span className="shrink-0 font-mono text-ink-faint">#{row.pr?.number}</span>
            <span className="min-w-0 truncate font-mono">{row.branch}</span>
            {showRepo ? <span className="shrink-0">{repoOf(row)}</span> : null}
            <span className="shrink-0">{row.author}</span>
            <span className="shrink-0">
              <span className="text-green">+{row.pr?.additions.toLocaleString()}</span>{" "}
              <span className="text-danger">−{row.pr?.deletions.toLocaleString()}</span>
              <span className="text-ink-faint"> · {row.pr?.changedFiles} files</span>
            </span>
            {row.checkedOutLocally ? (
              <span className="shrink-0 rounded-chip border border-line px-1.5 py-px text-ink-faint">
                checked out locally
              </span>
            ) : null}
          </span>
        </>
      )}
    </button>
  );
}

/** CI status: a loud "CI failing" chip, else a small dot (passing = green, pending =
 *  pulsing); `none`/unknown renders nothing rather than a misleading green tick. */
function CiDot({ ci }: { readonly ci: SmartListCi | undefined }) {
  if (ci === "failing") {
    return (
      <span className="flex items-center gap-1 rounded-chip border border-danger/40 bg-danger/10 px-2 py-0.5 text-2xs font-medium text-danger">
        CI failing
      </span>
    );
  }
  if (ci === "passing" || ci === "pending") {
    return (
      <span
        title={ci === "passing" ? "CI passing" : "CI pending"}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          ci === "passing" ? "bg-green" : "animate-pulse bg-ink-faint",
        )}
      />
    );
  }
  return null;
}
