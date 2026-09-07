import type { SmartListCi } from "@rennet/protocol";
import { cn, Switch, Toggle, ToggleGroup } from "@rennet/ui";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useCoachAnchor } from "../coach/registry";
import { Avatar } from "../components/avatar";
import { Icon } from "../components/icon";
import { useCommand } from "../data";
import { newChatPath } from "../routes/url";
import { usePriorSurface } from "../settings/prior-surface";
import { ProjectPicker } from "../settings/projects/project-picker";
import { useSidebarTree } from "../shell/sidebar-data";
import { hideClaimedRows, useClaimedTargets, useNewChatMint } from "./new-chat-mint";
import {
  buildSmartRows,
  filterSmartRows,
  type SmartFilter,
  type SmartRow,
  smartListCounts,
  sortSmartRows,
} from "./smart-list";

const FILTERS: readonly { readonly filter: SmartFilter; readonly label: string }[] = [
  { filter: "all", label: "All changes" },
  { filter: "needs-you", label: "Needs you" },
  { filter: "mine", label: "Yours" },
  { filter: "local", label: "Local branches" },
  { filter: "prs", label: "Pull requests" },
];
type SortKey = "created" | "recent";
type SortDirection = "asc" | "desc";

function repoOf(row: SmartRow): string {
  return row.kind === "pr" ? (row.pr?.repository ?? "") : (row.local?.repository ?? "");
}
function forgeOf(row: SmartRow): string | undefined {
  return row.kind === "pr" ? row.pr?.forgeRepository?.forge : row.local?.forgeRepository?.forge;
}
function forgeLabel(forge: string): string {
  if (forge === "github") return "GitHub";
  if (forge === "gitlab") return "GitLab";
  if (forge === "bitbucket") return "Bitbucket";
  return forge;
}
function requestPrefix(forge: string | undefined): "#" | "!" {
  return forge === "gitlab" ? "!" : "#";
}
function repositoriesNeedingForge(rows: readonly SmartRow[]): ReadonlySet<string> {
  const forgesByRepository = new Map<string, Set<string>>();
  for (const row of rows) {
    const forge = forgeOf(row);
    if (!forge) continue;
    const repository = repoOf(row);
    const forges = forgesByRepository.get(repository) ?? new Set<string>();
    forges.add(forge);
    forgesByRepository.set(repository, forges);
  }
  return new Set(
    [...forgesByRepository]
      .filter(([, forges]) => forges.size > 1)
      .map(([repository]) => repository),
  );
}
function matchesText(row: SmartRow, needle: string, ambiguous: ReadonlySet<string>): boolean {
  if (!needle) return true;
  const repository = repoOf(row);
  const forge = forgeOf(row);
  const qualified =
    forge && ambiguous.has(repository) ? `${forgeLabel(forge)} ${repository}` : repository;
  const haystack =
    row.kind === "pr"
      ? `${requestPrefix(forge)}${row.pr?.number} ${row.title} ${row.branch} ${qualified} ${row.author}`
      : `${row.branch} ${qualified} ${row.author}`;
  return haystack.toLowerCase().includes(needle);
}
function formatDate(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(value),
  );
}
function formatActivity(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < day * 2) return "Yesterday";
  return formatDate(value);
}

export function NewChatView({ projectId }: { readonly projectId: string }) {
  const [, navigate] = useLocation();
  const priorSurface = usePriorSurface();
  const { data: projectsData } = useCommand("projects.list", {});
  const project = projectsData?.projects.find((candidate) => candidate.id === projectId);
  const { hosts } = useSidebarTree();
  const [activeFilter, setActiveFilter] = useState<SmartFilter>("all");
  const [query, setQuery] = useState("");
  const [showMerged, setShowMerged] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [starting, setStarting] = useState<string | null>(null);
  const mint = useNewChatMint(projectId);
  const claimed = useClaimedTargets(projectId);
  // `pending` is the FIRST load of this project's branches and change requests, and it is
  // load-bearing for the empty-state copy below (#872): `rows` is `[]` until `detail`
  // arrives, and on a network clone that scan runs for minutes, during which the list read
  // "no open branches or change requests yet" — honest-empty wording for a state that was
  // actually still scanning. A refetch (the merged-PR toggle) keeps `data`, so it stays
  // false and the rows already on screen are not replaced by a scanning line.
  const { data: detail, pending: scanning } = useCommand("project.detail", {
    projectId,
    prStates: showMerged ? ["open", "merged"] : ["open"],
  });

  useEffect(() => {
    if (!mint.pending) setStarting(null);
  }, [mint.pending]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") navigate(priorSurface());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, priorSurface]);

  const rows = useMemo(() => {
    if (!detail) return [];
    const visibleDetail = showMerged
      ? detail
      : { ...detail, prs: detail.prs.filter((pr) => pr.state !== "merged") };
    const sorted = sortSmartRows(buildSmartRows(visibleDetail), sortKey);
    if (sortDirection === "desc") return sorted;
    if (sortKey === "recent") return sorted.reverse();
    return sorted.sort((a, b) => {
      const aCreated = a.createdAt;
      const bCreated = b.createdAt;
      if (aCreated === undefined && bCreated === undefined)
        return a.lastActivityAt.localeCompare(b.lastActivityAt);
      if (aCreated === undefined) return 1;
      if (bCreated === undefined) return -1;
      return aCreated.localeCompare(bCreated);
    });
  }, [detail, showMerged, sortDirection, sortKey]);
  const unclaimed = useMemo(() => hideClaimedRows(rows, claimed), [claimed, rows]);
  const counts = useMemo(() => smartListCounts(unclaimed), [unclaimed]);
  const ambiguousRepositories = repositoriesNeedingForge(unclaimed);
  const visible = filterSmartRows(unclaimed, activeFilter).filter((row) =>
    matchesText(row, query.trim().toLowerCase(), ambiguousRepositories),
  );
  const smartListRef = useCoachAnchor("smart-list");
  const chooseSort = (next: SortKey) => {
    if (sortKey === next) setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
    else {
      setSortKey(next);
      setSortDirection("desc");
    }
  };

  return (
    <section
      data-screen="new-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={() => navigate(priorSurface())}
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
        <kbd className="ml-auto rounded border border-line px-1 py-0.5 text-10 text-ink-faint">
          esc
        </kbd>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1380px] flex-col px-8 pt-[6vh] pb-10">
          <h1 className="flex flex-wrap items-baseline justify-center gap-2.5 text-center font-display text-2xl font-semibold tracking-tight text-ink">
            What should we review in
            <ProjectPicker
              large
              hosts={hosts}
              value={projectId}
              onChange={(next) => navigate(newChatPath(next))}
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
          <label className="mt-8 flex h-10 items-center gap-2 rounded-lg border border-line bg-card/40 px-3 focus-within:border-accent-line">
            <Icon icon={Search} className="size-4 shrink-0 text-ink-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search branches, PRs, authors…"
              aria-label="Search branches, pull requests, and authors"
              className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none"
            />
          </label>
          <div className="mt-4 flex min-h-0 items-start gap-4">
            <aside className="w-60 shrink-0 overflow-hidden rounded-lg border border-line bg-card/25">
              <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-3">
                <label htmlFor="show-merged" className="text-12-5 font-medium text-ink-soft">
                  Show merged PRs
                </label>
                <Switch
                  id="show-merged"
                  size="sm"
                  checked={showMerged}
                  onCheckedChange={setShowMerged}
                />
              </div>
              <ToggleGroup
                value={[activeFilter]}
                onValueChange={(next: string[]) => {
                  if (next[0]) setActiveFilter(next[0] as SmartFilter);
                }}
                orientation="vertical"
                aria-label="Filter review targets"
                className="flex w-full flex-col items-stretch gap-0 border-0 bg-transparent p-1.5"
              >
                {FILTERS.map(({ filter, label }) => (
                  <Toggle
                    key={filter}
                    value={filter}
                    size="sm"
                    className="w-full justify-between border-0 border-l-2 border-l-transparent px-2.5 data-pressed:border-l-accent"
                  >
                    <span>{label}</span>
                    <span
                      className={cn(
                        "text-10 tabular-nums",
                        activeFilter === filter ? "text-ink-soft" : "text-ink-faint",
                      )}
                    >
                      {counts[filter]}
                    </span>
                  </Toggle>
                ))}
              </ToggleGroup>
            </aside>
            <div
              ref={smartListRef}
              className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-card/20"
            >
              <div className="min-w-[940px]">
                <ListHeader sortKey={sortKey} sortDirection={sortDirection} onSort={chooseSort} />
                <div className="divide-y divide-border/70">
                  {visible.map((row) => (
                    <ItemRow
                      key={row.id}
                      row={row}
                      pending={mint.pending}
                      starting={mint.pending && starting === row.id}
                      onStart={() => {
                        setStarting(row.id);
                        mint.start(row, "");
                      }}
                    />
                  ))}
                  {visible.length === 0 ? (
                    <div className="px-4 py-12 text-center text-12-5 text-ink-faint">
                      {scanning
                        ? "scanning this project's branches and change requests…"
                        : unclaimed.length === 0
                          ? "no open branches or change requests yet"
                          : "nothing matches"}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          {mint.error ? (
            <p role="alert" className="mt-3 text-center text-xs text-danger">
              Could not start a session: {String((mint.error as Error)?.message ?? mint.error)}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const GRID =
  "grid grid-cols-[minmax(19rem,1fr)_7rem_3.25rem_7rem_4rem_6.25rem_6.25rem_9rem_1.25rem] items-center gap-3";

function ListHeader({
  sortKey,
  sortDirection,
  onSort,
}: {
  readonly sortKey: SortKey;
  readonly sortDirection: SortDirection;
  readonly onSort: (key: SortKey) => void;
}) {
  return (
    <div
      className={cn(
        GRID,
        "border-b border-line px-4 py-2.5 text-10 uppercase tracking-wide text-ink-faint",
      )}
    >
      <span>Change</span>
      <span>Author</span>
      <span>CI</span>
      <span>+ / −</span>
      <span>Files</span>
      <SortHeader
        label="Created"
        value="created"
        active={sortKey}
        direction={sortDirection}
        onSort={onSort}
      />
      <SortHeader
        label="Activity"
        value="recent"
        active={sortKey}
        direction={sortDirection}
        onSort={onSort}
      />
      <span>Status</span>
      <span />
    </div>
  );
}
function SortHeader({
  label,
  value,
  active,
  direction,
  onSort,
}: {
  readonly label: string;
  readonly value: SortKey;
  readonly active: SortKey;
  readonly direction: SortDirection;
  readonly onSort: (value: SortKey) => void;
}) {
  const selected = active === value;
  return (
    <button
      type="button"
      onClick={() => onSort(value)}
      aria-label={`Sort by ${label.toLowerCase()}`}
      className={cn(
        "flex w-fit items-center gap-1 rounded-control border border-line px-2 py-1 text-left uppercase tracking-wide hover:bg-raised hover:text-ink",
        selected && "bg-raised font-semibold text-ink-soft",
      )}
    >
      {label}
      <Icon
        icon={selected && direction === "asc" ? ArrowUp : ArrowDown}
        className={cn("size-3", !selected && "opacity-0")}
      />
    </button>
  );
}

function ItemRow({
  row,
  pending,
  starting,
  onStart,
}: {
  readonly row: SmartRow;
  readonly pending: boolean;
  readonly starting: boolean;
  readonly onStart: () => void;
}) {
  const reviewRequested = row.kind === "pr" && row.pr?.reviewRequested && row.state === "open";
  const merged = row.state === "merged";
  return (
    <button
      type="button"
      data-row="target"
      data-starting={starting ? "true" : undefined}
      onClick={onStart}
      disabled={pending}
      className={cn(
        GRID,
        "relative w-full border-l-2 border-l-transparent px-3.5 py-3 text-left transition-colors hover:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-60",
        reviewRequested && "border-l-accent",
        starting && "bg-secondary/60",
        // Merged is done: it stays legible (the retrospective path reads it) but
        // recedes behind the open work.
        merged && "opacity-70 hover:opacity-100",
      )}
    >
      <ChangeCell row={row} />
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
        <Avatar name={row.author} src={row.authorAvatarUrl} />
        <span className="truncate">{row.author}</span>
      </span>
      <CiStatus ci={row.pr?.ci} />
      <span className="whitespace-nowrap text-xs tabular-nums">
        {row.additions === undefined || row.deletions === undefined ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <>
            <span className="font-medium text-green">+{row.additions.toLocaleString()}</span>{" "}
            <span className="font-medium text-danger">−{row.deletions.toLocaleString()}</span>
          </>
        )}
      </span>
      <span className="text-xs tabular-nums text-ink-soft">
        {row.changedFiles === undefined ? (
          <span className="text-ink-faint">—</span>
        ) : (
          row.changedFiles
        )}
      </span>
      <time
        dateTime={row.createdAt}
        className="text-xs tabular-nums text-ink-soft"
        title={row.createdAt}
      >
        {formatDate(row.createdAt)}
      </time>
      <time
        dateTime={row.lastActivityAt}
        className="text-xs tabular-nums text-ink-soft"
        title={row.lastActivityAt}
      >
        {formatActivity(row.lastActivityAt)}
      </time>
      <RowBadge row={row} />
      <Icon
        icon={Check}
        data-mark="start"
        className={cn(
          "size-4 text-accent transition-opacity",
          starting ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}

function ChangeCell({ row }: { readonly row: SmartRow }) {
  const merged = row.state === "merged";
  if (row.kind === "local") {
    const local = row.local;
    const ahead = local?.ahead !== null && local?.ahead !== undefined && local.ahead > 0;
    const behind = local?.behind !== null && local?.behind !== undefined && local.behind > 0;
    return (
      <span className="flex min-w-0 items-start gap-2.5">
        <Icon
          icon={GitBranch}
          className={cn("mt-0.5 size-3.5 shrink-0", local?.dirty ? "text-warn" : "text-ink-faint")}
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="truncate font-mono text-sm font-medium text-ink">{row.branch}</span>
            {/* Clean/dirty is a measured fact only where there is a checkout to measure;
                a bare branch says nothing. Dirty is copper (a flag to weigh), not gold. */}
            {local?.worktree ? (
              <span
                data-worktree={local.dirty ? "dirty" : "clean"}
                className={cn(
                  "flex shrink-0 items-center gap-1 text-2xs font-medium",
                  local.dirty ? "text-warn" : "text-green",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", local.dirty ? "bg-warn" : "bg-green")}
                />
                {local.dirty ? "dirty" : "clean"}
              </span>
            ) : null}
          </span>
          {ahead || behind ? (
            <span className="mt-0.5 flex gap-2 text-2xs tabular-nums text-ink-faint">
              {ahead ? <span>↑{local.ahead}</span> : null}
              {behind ? <span>↓{local.behind}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-start gap-2.5">
      <Icon
        icon={merged ? GitMerge : row.pr?.reviewRequested ? GitPullRequestArrow : GitPullRequest}
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          row.pr?.reviewRequested && !merged ? "text-accent" : "text-ink-faint",
        )}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{row.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-ink-faint">
          <span className="shrink-0 font-mono">
            {requestPrefix(row.pr?.forgeRepository?.forge)}
            {row.pr?.number}
          </span>
          {merged ? (
            <span className="flex shrink-0 items-center gap-1 text-ink-soft">
              <Icon icon={GitMerge} className="size-2.5" /> Merged
            </span>
          ) : null}
          <span className="truncate font-mono">{row.branch}</span>
          {row.checkedOutLocally ? <span className="shrink-0">checked out locally</span> : null}
        </span>
      </span>
    </span>
  );
}

function RowBadge({ row }: { readonly row: SmartRow }) {
  if (row.kind === "local") return <span />;
  if (row.state === "merged") return <span />;
  if (row.pr?.reviewRequested)
    return (
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent-fill px-2 py-0.5 text-10 font-semibold text-accent-ink">
        <Icon icon={GitPullRequestArrow} className="size-2.5" /> Review requested
      </span>
    );
  if (row.mine)
    return (
      <span className="inline-flex w-fit items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-10 font-medium text-ink-soft">
        <Icon icon={GitPullRequest} className="size-2.5" /> Your PR
      </span>
    );
  return <span />;
}
// CI is a coloured mark AND a named state (the aria-label): DESIGN.md never lets
// colour stand alone. Green passes, red fails, copper is still running; a change
// with no checks at all has nothing to say.
function CiStatus({ ci }: { readonly ci: SmartListCi | undefined }) {
  if (ci === "passing")
    return <Icon icon={CircleCheck} aria-label="CI passing" className="size-4 text-green" />;
  if (ci === "failing")
    return <Icon icon={CircleX} aria-label="CI failing" className="size-4 text-danger" />;
  if (ci === "pending")
    return <Icon icon={CircleDashed} aria-label="CI pending" className="size-4 text-warn" />;
  return <span className="text-xs text-ink-faint">—</span>;
}
