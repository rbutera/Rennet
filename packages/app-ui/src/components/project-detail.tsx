import type {
  Project,
  ProjectDetail as ProjectDetailData,
  PullRequestState,
  RennetBridge,
} from "@rennet/protocol";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@rennet/ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Ellipsis,
  GitBranch,
  Lock,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { messageFrom } from "../lib/message-from";
import {
  buildSmartRows,
  filterSmartRows,
  type SmartFilter,
  type SmartRow,
  type SmartSort,
  smartListCounts,
  sortSmartRows,
} from "../project/smart-list";
import { DeviceFlowPrompt, useGitHubAccount } from "./github-connect";
import { Icon } from "./icon";

/**
 * Project detail: the unified smart list (issue #37).
 *
 * Clicking a project lands here — ONE scrolling surface with local work AND every
 * pull request in a single list, no hard zones. Rows read distinctly by state (local
 * backlight · my PR · teammate PR · merged read-only); the bar above filters (all /
 * needs-you / mine / local / PRs) and sorts (HOT default, then recent / author /
 * status). A branch that has a PR appears once, as the PR row, with its worktree a
 * "checked out locally" annotation (dedupe). A merged PR is read-only with a clean-up
 * action. The derivation is the pure `../project/smart-list` module; this component is
 * the surface over it. The substrate is LIVE behind the real `project.detail` command:
 * real local work from git plus live GitHub OPEN PRs. Opening a PR row reaches the live
 * review over that specific `owner/name#number`; a local row captures the working tree.
 */
export function ProjectDetail({
  bridge,
  project,
  initialDetail,
  scheme,
  onOpenRow,
  onOpenContextMap,
  onBack,
}: {
  bridge: RennetBridge;
  project: Project;
  initialDetail?: ProjectDetailData;
  /** The resolved appearance scheme (system already folded to dark/light upstream). */
  scheme?: "dark" | "light";
  onOpenRow(row: SmartRow): void;
  onOpenContextMap(): void;
  onBack(): void;
}) {
  // Two-phase, local-first paint. `local` is the instant git-only half (no auth, no
  // network); `full` is the authoritative detail with live PRs. The list shows `full`
  // once it lands, `local` in the meantime — so the work already on disk appears at
  // once instead of blocking behind a slow (or dead-token, failing) GitHub round-trip.
  const [full, setFull] = useState<ProjectDetailData | null>(initialDetail ?? null);
  const [local, setLocal] = useState<ProjectDetailData | null>(null);
  const [fetchingFull, setFetchingFull] = useState(false);
  const [error, setError] = useState<string>();
  const [sort, setSort] = useState<SmartSort>("hot");
  const [filter, setFilter] = useState<SmartFilter>("all");
  // Which PR states the list shows (historical-PR review). "open" is the live
  // default; flipping to merged/closed/all refetches the substrate with that
  // filter — history is paged on demand, never synced locally.
  const [prScope, setPrScope] = useState<PrScope>("open");
  // Bumped by an inline reconnect success, forcing a fresh full fetch (and bypassing
  // the initialDetail fast path — the stale detail predates the just-fixed auth).
  const [reloadNonce, setReloadNonce] = useState(0);
  // Branches whose local worktree has been cleaned up (optimistic; the row's
  // annotation disappears immediately, the command acknowledges behind it).
  const [cleaned, setCleaned] = useState<ReadonlySet<string>>(new Set());
  // Live PR-fetch narration streamed under the full fetch's commandId: the honest
  // determinate total, how many repos are done, and the one just fetched. Null
  // until the daemon announces `prs-start` (or when the host has no push channel).
  const [progress, setProgress] = useState<DetailProgress | null>(null);

  useEffect(() => {
    setError(undefined);
    setProgress(null);
    // Fast path: the projects list already handed us the full open-state detail.
    if (initialDetail && prScope === "open" && reloadNonce === 0) {
      setFull(initialDetail);
      setLocal(null);
      setFetchingFull(false);
      return;
    }
    let alive = true;
    setFull(null);
    setLocal(null);
    setFetchingFull(true);
    // Correlate the full fetch with its per-repo PR-fetch narration. Subscribe
    // BEFORE invoking so no early event is missed; a host with no push channel
    // simply omits onProjectDetailProgress and the banner stays indeterminate.
    const commandId = crypto.randomUUID();
    const unsubscribe = bridge.onProjectDetailProgress?.(commandId, (event) => {
      if (!alive) return;
      setProgress(
        event.kind === "prs-start"
          ? { total: event.total, done: 0 }
          : { total: event.total, done: event.index, repo: event.repo, count: event.count },
      );
    });
    // Instant local paint: git only, no auth, no network — first content on screen.
    // A failure here is non-fatal; the full fetch below reports the real error.
    bridge
      .invoke("project.detail", { projectId: project.id, localOnly: true })
      .then((detail) => {
        if (alive) setLocal(detail);
      })
      .catch(() => undefined);
    // Authoritative full detail: local work + live PRs for the chosen scope, its
    // per-repo progress streamed under `commandId`.
    bridge
      .invoke("project.detail", {
        projectId: project.id,
        prStates: PR_SCOPE_STATES[prScope],
        commandId,
      })
      .then((detail) => {
        if (!alive) return;
        setFull(detail);
        setFetchingFull(false);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setError(messageFrom(reason));
        setFetchingFull(false);
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [bridge, initialDetail, project.id, prScope, reloadNonce]);

  // The list shows the authoritative full detail once it lands, the instant local
  // half until then. PRs are still in flight while `full` is null but `local` is up.
  const detail = full ?? local;
  const prsPending = fetchingFull && detail !== null;
  const rows = useMemo(() => (detail ? buildSmartRows(detail) : []), [detail]);
  // Apply the optimistic clean-ups: drop the annotation from any swept worktree (keyed
  // by the stable worktree id, so a reused branch name never sweeps the wrong row).
  const swept = useMemo(
    () =>
      rows.map((row) =>
        row.checkedOutLocally && cleaned.has(row.checkedOutLocally.id)
          ? { ...row, checkedOutLocally: undefined }
          : row,
      ),
    [rows, cleaned],
  );
  const counts = useMemo(() => smartListCounts(swept), [swept]);
  const shown = useMemo(
    () => sortSmartRows(filterSmartRows(swept, filter), sort),
    [swept, filter, sort],
  );

  function restoreCleaned(worktreeId: string): void {
    setCleaned((current) => {
      const next = new Set(current);
      next.delete(worktreeId);
      return next;
    });
  }

  async function cleanUp(row: SmartRow): Promise<void> {
    const checkout = row.checkedOutLocally;
    if (!checkout) return;
    // Optimistically hide the annotation, then AWAIT the result: a rejection OR an
    // `{ ok: false }` is a real failure, so the annotation is RESTORED (never left
    // silently hidden when the worktree is still on disk).
    setCleaned((current) => new Set(current).add(checkout.id));
    try {
      const { ok } = await bridge.invoke("project.cleanupWorktree", {
        commandId: crypto.randomUUID(),
        projectId: project.id,
        worktreeId: checkout.id,
      });
      if (!ok) {
        restoreCleaned(checkout.id);
        setError(`Could not clean up ${checkout.branch}.`);
      }
    } catch (reason) {
      restoreCleaned(checkout.id);
      setError(messageFrom(reason));
    }
  }

  return (
    <div
      className="rennet-glass project-detail min-h-screen flex flex-col bg-canvas px-6 pb-24"
      data-scheme={scheme ?? "dark"}
    >
      <header className="project-detail-bar flex items-center gap-4 px-1 pt-5 pb-4 border-b border-line">
        <Button variant="outline" className="project-detail-back text-ink-soft" onClick={onBack}>
          <Icon icon={ArrowLeft} className="size-3.5" />
          Projects
        </Button>
        <span className="project-detail-heading flex flex-col gap-0.5 min-w-0">
          <span className="project-detail-name font-display text-xl text-ink">{project.name}</span>
          <span className="project-detail-path font-mono text-sm text-ink-faint truncate">
            {project.path}
          </span>
        </span>
        <Button
          variant="outline"
          className="project-detail-context-map ml-auto text-ink-soft"
          onClick={onOpenContextMap}
        >
          Context Map
        </Button>
      </header>

      {error ? <p className="project-detail-error mt-4 text-danger">{error}</p> : null}

      {detail === null && !error ? <SmartListSkeleton /> : null}

      {detail ? (
        <>
          <FilterBar
            counts={counts}
            filter={filter}
            sort={sort}
            prScope={prScope}
            onFilter={setFilter}
            onSort={setSort}
            onPrScope={setPrScope}
          />

          {prsPending ? (
            <PrPendingBanner detail={detail} prScope={prScope} progress={progress} />
          ) : null}

          {detail.truncated ? (
            <p
              className="project-detail-truncated flex items-center gap-2 mt-3.5 px-3.5 py-2.5 rounded-chip border border-accent-line bg-accent-surface text-ink text-base"
              role="note"
            >
              <Icon icon={TriangleAlert} className="size-3.5" />
              Showing a partial list — more than 1000 items upstream. This surface is not complete.
            </p>
          ) : null}

          {detail.authUnavailable ? (
            <AuthHint
              reason={detail.authUnavailable}
              source={detail.authUnavailableSource}
              copy={detail.authUnavailableCopy}
              onReconnected={() => setReloadNonce((nonce) => nonce + 1)}
            />
          ) : null}

          {detail.forgeUnavailable?.map((unavailable) => (
            <p
              key={`${unavailable.repository.forge}:${unavailable.repository.owner}/${unavailable.repository.name}`}
              className="project-detail-forge-unavailable flex items-center gap-2 mt-3.5 px-3.5 py-2.5 rounded-chip border border-accent-line bg-accent-surface text-ink text-base"
              role="note"
            >
              <Icon icon={TriangleAlert} className="size-3.5" />
              <span>
                {unavailable.repository.owner}/{unavailable.repository.name} could not load from{" "}
                {unavailable.repository.forge}: {unavailable.repair}
              </span>
            </p>
          ))}

          <div className="smart-list flex flex-col gap-2 mt-1">
            {shown.length === 0 ? (
              <p className="smart-list-empty my-6 mx-1 text-ink-faint">
                Nothing here for this filter.
              </p>
            ) : (
              shown.map((row) => (
                <SmartListRow key={row.id} row={row} onOpen={onOpenRow} onCleanUp={cleanUp} />
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ── The loading + pending + auth surfaces ─────────────────────────────────── */

/** The count of distinct repositories represented in a detail's local work. */
function repoCount(detail: ProjectDetailData): number {
  return new Set(detail.locals.map((work) => work.repository)).size;
}

/**
 * The instant-loading skeleton: a few pulsing placeholder rows echoing the smart
 * list's shape. Shown only before the first (local) half paints — a moment, since
 * local work is pure git. Honest: it is visibly a placeholder, never faked content.
 */
function SmartListSkeleton() {
  return (
    <div className="smart-list-skeleton flex flex-col gap-2 mt-4" aria-hidden="true">
      <p className="project-detail-loading mb-1 mx-1 text-ink-faint">Reading local work…</p>
      {[0, 1, 2].map((index) => {
        // Stagger the row's shimmer. The pulse lives in the Skeleton children, so the
        // delay must ride the ANIMATED elements — on the static row wrapper it is dead.
        const delay = `${index * 120}ms`;
        return (
          <div
            key={index}
            className="smart-row-skeleton flex items-center gap-3.5 rounded-surface border border-line bg-raised px-3.5 py-3.5"
          >
            <Skeleton className="h-3.5 w-[42px]" style={{ animationDelay: delay }} />
            <span className="flex flex-col gap-2 flex-1">
              <Skeleton className="h-3.5 w-1/2" style={{ animationDelay: delay }} />
              <Skeleton className="h-3 w-1/3 opacity-70" style={{ animationDelay: delay }} />
            </span>
            <Skeleton className="h-3.5 w-16" style={{ animationDelay: delay }} />
          </div>
        );
      })}
    </div>
  );
}

/** Live PR-fetch progress: the honest determinate total, repos done, last repo. */
type DetailProgress = { total: number; done: number; repo?: string; count?: number };

/**
 * The truthful "still fetching PRs" banner. Once the daemon streams per-repo
 * progress it names exactly which repo it is on and fills an HONEST determinate
 * bar (`done / total` real forge repos — never a fabricated percentage); the bar
 * eases as each repo lands. Before the first event (or a host with no push
 * channel) it degrades to the indeterminate pulsing dot, still never lying.
 */
function PrPendingBanner({
  detail,
  prScope,
  progress,
}: {
  detail: ProjectDetailData;
  prScope: PrScope;
  progress: DetailProgress | null;
}) {
  const repos = repoCount(detail);
  const across = repos > 1 ? ` across ${repos} repos` : "";
  const scope = prScope === "open" ? "" : `${prScope} `;
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <div
      className="project-detail-prs-pending mt-3 px-3.5 py-2 rounded-chip border border-accent-line bg-accent-surface text-ink-soft text-sm"
      role="status"
    >
      <span className="flex items-center gap-2.5">
        <span className="relative inline-flex h-2 w-2 flex-none" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        {progress?.repo ? (
          <span className="min-w-0">
            Fetching {scope}pull requests —{" "}
            <span className="font-mono text-ink">{progress.repo}</span>{" "}
            <span className="text-ink-faint">
              ({done} of {total})
            </span>
          </span>
        ) : (
          <span>
            Fetching {scope}pull requests{across}…
          </span>
        )}
      </span>
      {total > 0 ? (
        <span
          className="project-detail-prs-bar mt-2 block h-1 w-full overflow-hidden rounded-full bg-line"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

/** The auth-unavailable reason the detail substrate reports. */
type AuthUnavailable = NonNullable<ProjectDetailData["authUnavailable"]>;
type AuthUnavailableSource = NonNullable<ProjectDetailData["authUnavailableSource"]>;

const AUTH_HINT_COPY: Record<AuthUnavailable, string> = {
  "not-connected": "Pull requests need a GitHub connection.",
  "token-invalid": "The GitHub token was revoked or expired.",
  "insufficient-scope": "This token is missing the `repo` scope needed to read pull requests.",
  network: "GitHub is unreachable right now — showing local work only.",
};

const GH_AUTH_HINT_COPY: Partial<Record<AuthUnavailable, string>> = {
  "token-invalid":
    "The GitHub CLI credential needs repair. Run `gh auth status --hostname github.com`.",
  "insufficient-scope":
    "The GitHub CLI credential is missing the `repo` scope. Run `gh auth refresh -s repo`.",
};

/**
 * The auth-unavailable hint — actionable at the point of failure. A missing or
 * fallback-owned credential gets an inline device-flow repair; a `gh`-owned failure
 * names the CLI command that repairs the authoritative source and never offers a
 * fallback action that the next auth resolution would ignore. A network outage is
 * transient, so it states the fact with no button.
 */
function AuthHint({
  reason,
  source,
  copy: resolvedCopy,
  onReconnected,
}: {
  reason: AuthUnavailable;
  source?: AuthUnavailableSource;
  copy?: string;
  onReconnected(): void;
}) {
  const account = useGitHubAccount();
  // A device flow was in flight → when the account flips to connected, the reconnect
  // succeeded: refetch. The ref keeps a stale `status` from firing it on mount.
  const wasConnecting = useRef(false);
  useEffect(() => {
    if (account.flow) wasConnecting.current = true;
    if (wasConnecting.current && account.status?.state === "connected") {
      wasConnecting.current = false;
      onReconnected();
    }
  }, [account.flow, account.status, onReconnected]);

  const ghOwned = source === "gh";
  const canReconnect = reason !== "network" && !ghOwned;
  const label = reason === "not-connected" ? "Connect" : "Reconnect";
  const copy =
    resolvedCopy ?? (ghOwned ? GH_AUTH_HINT_COPY[reason] : undefined) ?? AUTH_HINT_COPY[reason];
  return (
    <div
      className="project-detail-auth-hint flex items-center gap-3 mt-2.5 px-3.5 py-2.5 rounded-chip border border-line bg-surface text-ink-soft text-sm"
      role="note"
    >
      {account.flow && !ghOwned ? (
        <DeviceFlowPrompt flow={account.flow} onCancel={() => void account.cancel()} />
      ) : (
        <>
          <span className="flex-1 min-w-0">{account.error ?? copy}</span>
          {canReconnect ? (
            <Button
              variant="accent"
              className="project-detail-reconnect flex-none"
              onClick={() => void account.connect()}
            >
              {label}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ── The filter + sort bar ─────────────────────────────────────────────────── */

/** The PR-state scope the list fetches: live open PRs, or history. */
type PrScope = "open" | "merged" | "closed" | "all";

const PR_SCOPE_STATES: Record<PrScope, [PullRequestState, ...PullRequestState[]]> = {
  open: ["open"],
  merged: ["merged"],
  closed: ["closed"],
  all: ["open", "merged", "closed"],
};

const PR_SCOPES: { id: PrScope; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All states" },
];

const FILTERS: { id: SmartFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "mine", label: "Mine" },
  { id: "local", label: "Local" },
  { id: "prs", label: "PRs" },
];

const SORTS: { id: SmartSort; label: string }[] = [
  { id: "hot", label: "Hot" },
  { id: "recent", label: "Recent" },
  { id: "author", label: "Author" },
  { id: "status", label: "Status" },
];

function FilterBar({
  counts,
  filter,
  sort,
  prScope,
  onFilter,
  onSort,
  onPrScope,
}: {
  counts: Record<SmartFilter, number>;
  filter: SmartFilter;
  sort: SmartSort;
  prScope: PrScope;
  onFilter(filter: SmartFilter): void;
  onSort(sort: SmartSort): void;
  onPrScope(scope: PrScope): void;
}) {
  return (
    <div className="smart-filter-bar flex items-center justify-between gap-4 py-4 flex-wrap">
      <div className="smart-filters flex gap-2 flex-wrap">
        {FILTERS.map((entry) => {
          const active = filter === entry.id;
          return (
            <Button
              key={entry.id}
              variant={active ? "accent" : "outline"}
              className={`smart-filter rounded-full text-base ${active ? "is-active" : "text-ink-soft"}`}
              aria-pressed={active}
              onClick={() => onFilter(entry.id)}
            >
              {entry.label}
              <span
                className={`smart-filter-count font-mono text-2xs ${active ? "text-accent" : "text-ink-faint"}`}
              >
                {counts[entry.id]}
              </span>
            </Button>
          );
        })}
      </div>
      <span className="smart-pr-scope inline-flex items-center gap-2">
        {/* Real label→control association: htmlFor + the trigger's id. The label is a
            SIBLING (not a wrapper), so a trigger click never bubbles up to re-fire it —
            the double-fire that a wrapping <label> caused, without losing click-to-open. */}
        <label
          htmlFor="smart-pr-scope-select"
          className="smart-pr-scope-label text-2xs font-semibold uppercase tracking-wide text-ink-faint"
        >
          PRs
        </label>
        <Select value={prScope} onValueChange={(value) => onPrScope(value as PrScope)}>
          <SelectTrigger
            id="smart-pr-scope-select"
            size="sm"
            className="smart-pr-scope-select"
            aria-label="PR scope"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PR_SCOPES.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <span className="smart-sort inline-flex items-center gap-2">
        <label
          htmlFor="smart-sort-select"
          className="smart-sort-label text-2xs font-semibold uppercase tracking-wide text-ink-faint"
        >
          Sort
        </label>
        <Select value={sort} onValueChange={(value) => onSort(value as SmartSort)}>
          <SelectTrigger
            id="smart-sort-select"
            size="sm"
            className="smart-sort-select"
            aria-label="Sort"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    </div>
  );
}

/* ── One row in the unified list ───────────────────────────────────────────── */

function SmartListRow({
  row,
  onOpen,
  onCleanUp,
}: {
  row: SmartRow;
  onOpen(row: SmartRow): void;
  onCleanUp(row: SmartRow): void;
}) {
  // State law (was attribute-selector CSS, now inline): local = gold backlight +
  // inset glow; merged/read-only = green edge + dimmed; my PR / needs-you = gold edge;
  // teammate PR = neutral.
  const stateClass = row.readOnly
    ? "border-green-line bg-surface opacity-80"
    : row.kind === "local"
      ? "border-accent-line bg-accent-surface shadow-[inset_0_0_18px_var(--rn-accent-soft)]"
      : row.needsYou || row.mine
        ? "border-accent-line"
        : "border-line";
  return (
    <div
      className={`smart-row flex items-stretch gap-2.5 rounded-surface border bg-raised overflow-hidden ${stateClass}`}
      data-kind={row.kind}
      data-state={row.state}
      data-mine={row.mine ? "true" : "false"}
      data-needs-you={row.needsYou ? "true" : "false"}
      data-read-only={row.readOnly ? "true" : "false"}
    >
      <button
        type="button"
        className="smart-row-open flex-1 min-w-0 flex items-center gap-3.5 px-3.5 py-3 bg-transparent text-ink text-left"
        onClick={() => onOpen(row)}
      >
        <span
          className={`smart-row-lead flex-none grid place-items-center min-w-[42px] ${row.kind === "local" ? "text-accent" : "text-ink-soft"}`}
          aria-hidden="true"
        >
          {row.kind === "pr" ? (
            <span className="smart-row-num font-mono text-base font-bold text-accent">
              #{row.pr?.number}
            </span>
          ) : (
            <Icon icon={GitBranch} className="size-3.5" />
          )}
        </span>
        <span className="smart-row-main min-w-0 flex flex-col gap-1.5">
          <span className="smart-row-title text-base font-semibold text-ink truncate">
            {row.title}
          </span>
          <span className="smart-row-sub flex items-center flex-wrap gap-2.5 text-sm text-ink-faint">
            <span className="smart-row-branch inline-flex items-center gap-1 font-mono text-ink-soft">
              <Icon icon={GitBranch} className="size-3" />
              {row.branch}
            </span>
            <span className="smart-row-author text-ink-faint">{row.mine ? "you" : row.author}</span>
            {row.kind === "local" && row.local ? <LocalTrajectory row={row} /> : null}
            {row.kind === "pr" && row.pr ? (
              <span className="smart-row-diffstat font-mono text-ink-faint">
                +{row.pr.additions} −{row.pr.deletions} · {row.pr.changedFiles}f
              </span>
            ) : null}
            {row.checkedOutLocally ? (
              <span
                className="smart-row-checkout inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-accent-line bg-accent-soft text-ink text-2xs"
                title="A local worktree is checked out for this branch"
              >
                <Icon icon={Sparkles} className="size-3" />
                checked out locally
                {row.checkedOutLocally.dirty ? " · uncommitted" : ""}
              </span>
            ) : null}
          </span>
        </span>
        <span
          className="smart-row-state flex-none inline-flex items-center gap-2 pl-2"
          aria-hidden="true"
        >
          {row.pr ? <CiGlyph ci={row.pr.ci} /> : null}
          {row.needsYou ? (
            <span className="smart-row-badge is-needs-you inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-accent-line bg-accent-soft text-ink text-2xs font-semibold">
              needs you
            </span>
          ) : null}
          {row.readOnly ? (
            <span className="smart-row-badge is-read-only inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-green-line bg-green-soft text-ink text-2xs font-semibold">
              <Icon icon={Lock} className="size-3" />
              read-only
            </span>
          ) : null}
          <StateLabel row={row} />
        </span>
      </button>

      <div className="smart-row-actions flex-none flex items-center gap-2 pr-3 py-2.5">
        {row.readOnly && row.checkedOutLocally ? (
          <Button
            variant="outline"
            className="smart-row-cleanup text-ink-soft text-base hover:border-green-line"
            onClick={() => onCleanUp(row)}
          >
            Clean up
          </Button>
        ) : null}
        <Button variant="accent" className="smart-row-action text-base" onClick={() => onOpen(row)}>
          {rowActionLabel(row)}
          <Icon icon={ArrowRight} className="size-3" />
        </Button>
      </div>
    </div>
  );
}

/** The local pipeline trajectory: captured › reviewed › PR'd, current stage lit. */
function LocalTrajectory({ row }: { row: SmartRow }) {
  const stage = row.local?.stage ?? "captured";
  const steps: { id: typeof stage; label: string }[] = [
    { id: "captured", label: "captured" },
    { id: "reviewed", label: "reviewed" },
    { id: "prd", label: "PR'd" },
  ];
  const currentIndex = steps.findIndex((step) => step.id === stage);
  return (
    <span
      className="smart-row-trajectory inline-flex items-center gap-1.5"
      title={`stage ${stage}`}
    >
      {steps.map((step, index) => {
        const done = index <= currentIndex;
        return (
          <span
            key={step.id}
            className={`trajectory-step inline-flex items-center gap-1 ${done ? "is-done text-accent" : "text-ink-faint"}`}
          >
            {done ? <Icon icon={Check} className="size-2.5" /> : null}
            {step.label}
          </span>
        );
      })}
      {row.local?.dirty ? (
        <span className="smart-row-dirty px-1.5 py-0.5 rounded-full border border-accent-line text-ink text-2xs">
          dirty
        </span>
      ) : null}
    </span>
  );
}

function CiGlyph({ ci }: { ci: NonNullable<SmartRow["pr"]>["ci"] }) {
  if (ci === "none") return null;
  const glyph = ci === "passing" ? Check : ci === "failing" ? X : Ellipsis;
  return (
    <span
      className={`smart-row-ci is-${ci} inline-flex items-center gap-1 font-mono text-2xs font-bold ${ci === "pending" ? "text-ink-faint" : "text-ink"}`}
    >
      CI <Icon icon={glyph} className="size-3" />
    </span>
  );
}

function StateLabel({ row }: { row: SmartRow }) {
  const label =
    row.state === "local"
      ? "local"
      : row.state === "open"
        ? row.mine
          ? "your PR"
          : "review"
        : row.state;
  return (
    <span className="smart-row-statelabel text-2xs font-semibold uppercase tracking-wide text-ink-faint">
      {label}
    </span>
  );
}

function rowActionLabel(row: SmartRow): string {
  if (row.kind === "local") return row.local?.stage === "reviewed" ? "Make PR" : "Review";
  if (row.readOnly) return "View";
  return row.mine ? "Open" : "Review";
}
