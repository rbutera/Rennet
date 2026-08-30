import type { Project, SmartListCi } from "@rennet/protocol";
import { cn, Popover, PopoverContent, PopoverTrigger, Toggle, ToggleGroup } from "@rennet/ui";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Map as MapIcon,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useCoachAnchor } from "../coach/registry";
import { Icon } from "../components/icon";
import { useCommand } from "../data";
import { newChatPath, projectMapPath } from "../routes/url";
import { usePriorSurface } from "../settings/prior-surface";
import { TargetIcon } from "../shell/sidebar/target-icon";
import { type SessionTarget, type SessionTargetState, TARGET_LABEL } from "../shell/sidebar-data";
import { hideClaimedRows, useClaimedTargets, useNewChatMint } from "./new-chat-mint";
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
// The smart list (the review-target picker) is cluster 6.2. A row click STARTS the
// session AND its review (R26, #587) — it is not a selection: it mints a durable session,
// claims the row's target, captures that target's change, and lands on the session, all
// through `new-chat-mint.ts`. Cluster 6 shipped the picker while `session.*` was gated on
// B9 and a click did nothing; the gate cleared, and this is the act it was waiting for.
// ─────────────────────────────────────────────────────────────────────────────

/** The tab vocabulary → smart-list filter. One list, no zones — the tabs are a filter. */
const TABS: readonly { readonly filter: SmartFilter; readonly label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "needs-you", label: "Needs you" },
  { filter: "mine", label: "Mine" },
  { filter: "local", label: "Local" },
  { filter: "prs", label: "Requests" },
];

/** The row's `owner/name`, for the repo column (dropped when the workspace is single-repo). */
function repoOf(row: SmartRow): string {
  return row.kind === "pr" ? (row.pr?.repository ?? "") : (row.local?.repository ?? "");
}

function forgeOf(row: SmartRow): string | undefined {
  return row.kind === "pr" ? row.pr?.forgeRepository?.forge : row.local?.forgeRepository?.forge;
}

function forgeLabel(forge: string): string {
  switch (forge) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    default:
      return forge;
  }
}

function requestPrefix(forge: string | undefined): "#" | "!" {
  return forge === "gitlab" ? "!" : "#";
}

/** Bare `owner/name` is normally enough. Qualify only a slug served by multiple forges. */
function repositoriesNeedingForge(rows: readonly SmartRow[]): ReadonlySet<string> {
  const forgesByRepository = new Map<string, Set<string>>();
  for (const row of rows) {
    const forge = forgeOf(row);
    if (forge === undefined) continue;
    const repository = repoOf(row);
    const forges = forgesByRepository.get(repository);
    if (forges === undefined) {
      forgesByRepository.set(repository, new Set([forge]));
    } else {
      forges.add(forge);
    }
  }

  return new Set(
    [...forgesByRepository.entries()]
      .filter(([, forges]) => forges.size > 1)
      .map(([repository]) => repository),
  );
}

function searchableRepository(row: SmartRow, repositoriesWithForge: ReadonlySet<string>): string {
  const repository = repoOf(row);
  const forge = forgeOf(row);
  return forge !== undefined && repositoriesWithForge.has(repository)
    ? `${forgeLabel(forge)} ${repository}`
    : repository;
}

/** The documented text-filter fields: PR number/title/branch/repo/author; local branch+repo. */
function matchesText(
  row: SmartRow,
  needle: string,
  repositoriesWithForge: ReadonlySet<string>,
): boolean {
  if (!needle) return true;
  const repository = searchableRepository(row, repositoriesWithForge);
  const hay =
    row.kind === "pr"
      ? `${requestPrefix(row.pr?.forgeRepository?.forge)}${row.pr?.number} ${row.title} ${row.branch} ${repository} ${row.author}`
      : `${row.branch} ${repository}`;
  return hay.toLowerCase().includes(needle);
}

/** Fold a smart-list row onto the unified target vocabulary (R36 icon language). */
function targetOf(row: SmartRow): { kind: SessionTarget; state?: SessionTargetState } {
  if (row.kind === "local") {
    return {
      kind: "your-branch",
      state: row.local?.stage === "reviewed" || row.local?.stage === "prd" ? "reviewed" : undefined,
    };
  }
  if (row.state === "merged" || row.state === "closed") {
    return { kind: row.mine ? "your-pr" : "teammate-pr", state: "merged" };
  }
  return {
    kind: row.mine ? "your-pr" : "teammate-pr",
    state: row.needsYou ? "needs-you" : undefined,
  };
}

export function NewChatView({ projectId }: { readonly projectId: string }) {
  const [, navigate] = useLocation();
  const priorSurface = usePriorSurface();
  const search = useSearch();
  const { data: projectsData } = useCommand("projects.list", {});
  const projects = projectsData?.projects ?? [];
  const project = projects.find((candidate) => candidate.id === projectId);

  // Seed the composer from an `?ask=` handoff (the context map's "discuss" lands here with
  // the statement prefilled) — read once on mount; the reviewer edits or sends from there.
  const [message, setMessage] = useState(() => new URLSearchParams(search).get("ask") ?? "");
  const [tab, setTab] = useState<SmartFilter>("all");
  const [filter, setFilter] = useState("");

  // A row click STARTS the session (R26) — mint + claim + land, in one act.
  const mint = useNewChatMint(projectId);
  const claimed = useClaimedTargets(projectId);
  const { data: sessionsData } = useCommand("session.list", {});

  const { data: detail } = useCommand("project.detail", { projectId });
  const rows = useMemo(
    () => (detail ? sortSmartRows(buildSmartRows(detail), "hot") : []),
    [detail],
  );
  // Claim-dedup on resolve (#466 res. 11): a target a live session already claims is not
  // offered again. Archive is the only release, so archiving that session puts the row back.
  const unclaimed = useMemo(() => hideClaimedRows(rows, claimed), [rows, claimed]);
  const counts = useMemo(() => smartListCounts(unclaimed), [unclaimed]);
  const needle = filter.trim().toLowerCase();
  const repositoriesWithForge = repositoriesNeedingForge(unclaimed);
  const visible = filterSmartRows(unclaimed, tab).filter((row) =>
    matchesText(row, needle, repositoriesWithForge),
  );
  const showRepo =
    new Set(unclaimed.map((row) => searchableRepository(row, repositoriesWithForge))).size > 1;

  const close = () => navigate(priorSurface());

  // Escape closes the page (the filter input's own Escape stops there first — 6.2). `navigate`
  // is wouter-stable, so the exhaustive dep re-subscribes only if it ever changes (finding 15).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") navigate(priorSurface());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, priorSurface]);

  const branch = project?.primaryBranch ?? "main";

  // Two coach marks live on this surface and chain in system order: `new-chat` (the
  // project header — pick what to review, add another repo) then `smart-list` (the
  // unified branches + pull-requests list).
  const noSessionsAnywhere = sessionsData !== undefined && sessionsData.sessions.length === 0;
  const newChatRef = useCoachAnchor("new-chat", noSessionsAnywhere);
  const smartListRef = useCoachAnchor("smart-list");

  return (
    <section
      data-screen="new-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={close}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="size-3.5" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-13">
          <span className="shrink-0 text-ink-soft">{project?.name ?? projectId}</span>
          <Icon icon={ChevronRight} className="size-2.5 shrink-0 text-muted-foreground/50" />
          <span className="font-medium text-ink">New Chat</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(projectMapPath(projectId))}
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon icon={MapIcon} className="size-3.5" />
            Map
          </button>
          <kbd className="rounded border border-line px-1 py-0.5 text-10 text-ink-faint">esc</kbd>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-8 pt-[7vh] pb-6">
          <h1
            ref={newChatRef}
            className="flex flex-wrap items-baseline justify-center gap-2.5 text-center font-display text-2xl font-semibold tracking-tight text-ink"
          >
            What should we review in
            <ProjectPicker
              projects={projects}
              current={project}
              onChange={(next) => navigate(newChatPath(next.id))}
            />
            ?
          </h1>

          {detail?.forgeUnavailable?.map((unavailable) => (
            <p
              key={`${unavailable.repository.forge}:${unavailable.repository.owner}/${unavailable.repository.name}`}
              className="mt-5 flex items-center gap-2 rounded-chip border border-accent-line bg-accent-surface px-3.5 py-2.5 text-sm text-ink"
              role="note"
            >
              <Icon icon={TriangleAlert} className="size-3.5 shrink-0" />
              <span>
                {unavailable.repository.owner}/{unavailable.repository.name} could not load from{" "}
                {forgeLabel(unavailable.repository.forge)}: {unavailable.repair}
              </span>
            </p>
          ))}

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
                  {/* The count on the ACTIVE tab lifts a notch: at one flat tone it reads
                      as chrome belonging to the group, not to the tab you selected. */}
                  <span
                    className={cn(
                      "text-10",
                      value === tab ? "text-ink-soft" : "text-muted-foreground/60",
                    )}
                  >
                    {counts[value]}
                  </span>
                </Toggle>
              ))}
            </ToggleGroup>
            <label className="ml-auto flex h-7 w-52 items-center gap-1.5 rounded-control border border-line bg-card/40 px-2 focus-within:border-accent-line">
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
                aria-label="Filter branches and change requests"
                className="w-full bg-transparent text-12-5 text-ink placeholder:text-ink-faint focus-visible:outline-none"
              />
            </label>
          </div>

          <div
            ref={smartListRef}
            className="mt-3 flex flex-col divide-y divide-border/70 overflow-hidden rounded-lg border border-line"
          >
            <CheckoutRow
              branch={branch}
              pending={mint.pending}
              onStart={() => mint.start(undefined, message)}
            />
            {visible.map((row) => (
              <ItemRow
                key={row.id}
                row={row}
                showRepo={showRepo}
                showForge={repositoriesWithForge.has(repoOf(row))}
                pending={mint.pending}
                onStart={() => mint.start(row, message)}
              />
            ))}
            {visible.length === 0 ? (
              <div className="px-3 py-5 text-center text-12-5 text-ink-faint">
                {unclaimed.length === 0
                  ? "no open branches or change requests yet"
                  : "nothing matches"}
              </div>
            ) : null}
          </div>

          {/* A failed mint says so, in the reason the host gave. Nothing is claimed to
              have started, and the picker stays where it is so the click can be retried. */}
          {mint.error ? (
            <p role="alert" className="mt-3 text-center text-xs text-danger">
              Could not start a session: {String((mint.error as Error)?.message ?? mint.error)}
            </p>
          ) : null}
        </div>
      </div>

      <Composer
        branch={branch}
        message={message}
        onMessage={setMessage}
        pending={mint.pending}
        onSend={() => mint.start(undefined, message)}
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

/** The composer sends against the whole project — the "no target" chat the Current
 *  Checkout row describes. A specific branch or pull request is started by clicking its
 *  row, which is what claims it. */
function Composer({
  branch,
  message,
  onMessage,
  pending,
  onSend,
}: {
  readonly branch: string;
  readonly message: string;
  readonly onMessage: (value: string) => void;
  readonly pending: boolean;
  readonly onSend: () => void;
}) {
  return (
    <div className="shrink-0 px-8 pt-2 pb-5">
      <div className="mx-auto flex w-full max-w-[720px] flex-col rounded-surface border border-line bg-card/60 shadow-sm focus-within:border-accent-line">
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
            <Icon icon={GitBranch} className="size-3 text-ink-faint" />
            Current Checkout · {branch}
          </span>
          <button
            type="button"
            disabled={!message.trim() || pending}
            onClick={onSend}
            aria-label="Send"
            className={cn(
              "ml-auto flex size-8 shrink-0 items-center justify-center rounded-control transition-colors disabled:cursor-not-allowed",
              message.trim() && !pending
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

/** The pinned "Current Checkout" row — starts a session with NO claimed target, the
 *  whole-project chat. Claiming nothing, it never leaves the list. */
function CheckoutRow({
  branch,
  pending,
  onStart,
}: {
  readonly branch: string;
  readonly pending: boolean;
  readonly onStart: () => void;
}) {
  return (
    <button
      type="button"
      data-row="target"
      onClick={onStart}
      disabled={pending}
      className="flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Icon icon={GitBranch} className="size-3.5 shrink-0 text-ink-faint" />
      <span className="text-sm font-medium text-ink">Current Checkout</span>
      <span className="font-mono text-xs text-ink-soft">{branch}</span>
      <span className="ml-auto text-2xs text-ink-faint">no target — talk about the project</span>
    </button>
  );
}

/** A review-target row. Clicking it STARTS the session (R26): mint + claim + land. */
function ItemRow({
  row,
  showRepo,
  showForge,
  pending,
  onStart,
}: {
  readonly row: SmartRow;
  readonly showRepo: boolean;
  readonly showForge: boolean;
  readonly pending: boolean;
  readonly onStart: () => void;
}) {
  const merged = row.state === "merged";
  return (
    <button
      type="button"
      data-row="target"
      onClick={onStart}
      disabled={pending}
      className={cn(
        "flex flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-raised/60 disabled:cursor-not-allowed",
        // Merged rows dim, and lift on hover.
        merged && "opacity-50 hover:opacity-80",
      )}
    >
      {row.kind === "local" ? (
        // The repository sits on its own second line, under the branch — the same
        // anatomy the change-request row already has. Inline it competed with the
        // branch name for the one truncating slot, so in a multi-repo workspace the
        // branch (the thing you are picking) was what got cut.
        <>
          <span className="flex w-full items-center gap-2">
            <Icon
              icon={GitBranch}
              className={cn(
                "size-3.5 shrink-0",
                row.local?.dirty ? "text-accent" : "text-ink-faint",
              )}
            />
            <span className="min-w-0 truncate font-mono text-sm font-medium text-ink">
              {row.branch}
            </span>
            {row.local?.dirty ? (
              <span
                className="shrink-0 text-2xs font-medium text-accent"
                title="uncommitted changes"
              >
                ● dirty
              </span>
            ) : null}
            {row.local?.stage ? (
              <span className="min-w-0 truncate text-2xs text-ink-faint">{row.local.stage}</span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <StateChip row={row} />
            </span>
          </span>
          {showRepo ? (
            <span className="flex pl-5.5">
              <RepositoryLabel row={row} showForge={showForge} />
            </span>
          ) : null}
        </>
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
            </span>
          </span>
          <span className="flex w-full items-center gap-2.5 pl-[22px] text-2xs text-ink-soft">
            <span className="shrink-0 font-mono text-ink-faint">
              {requestPrefix(row.pr?.forgeRepository?.forge)}
              {row.pr?.number}
            </span>
            <span className="min-w-0 truncate font-mono">{row.branch}</span>
            {showRepo ? <RepositoryLabel row={row} showForge={showForge} /> : null}
            <span className="shrink-0">{row.author}</span>
            <span className="shrink-0">
              {row.pr?.additions === undefined || row.pr.deletions === undefined ? null : (
                <>
                  <span className="text-green">+{row.pr.additions.toLocaleString()}</span>{" "}
                  <span className="text-danger">−{row.pr.deletions.toLocaleString()}</span>
                  <span className="text-ink-faint"> · </span>
                </>
              )}
              <span className="text-ink-faint">
                {row.pr?.changedFiles === undefined
                  ? "file count unavailable"
                  : `${row.pr.changedFiles} files`}
              </span>
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

/** Keep the legacy `owner/name` readable; add a separate provider label only on collision. */
function RepositoryLabel({
  row,
  showForge,
}: {
  readonly row: SmartRow;
  readonly showForge: boolean;
}) {
  const forge = forgeOf(row);
  return (
    <span className="flex shrink-0 items-baseline gap-1 text-2xs text-ink-faint">
      {showForge && forge !== undefined ? (
        <>
          <span className="font-medium text-ink-soft">{forgeLabel(forge)}</span>
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      <span>{repoOf(row)}</span>
    </span>
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
