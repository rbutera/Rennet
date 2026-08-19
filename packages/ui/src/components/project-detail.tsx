import type { Project, ProjectDetail as ProjectDetailData, RennetBridge } from "@rennet/protocol";
import { useEffect, useMemo, useState } from "react";
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
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CloseIcon,
  EllipsisIcon,
  GitBranchIcon,
  LockIcon,
  SparkleIcon,
  TriangleIcon,
} from "./icons";

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
  onBack,
}: {
  bridge: RennetBridge;
  project: Project;
  initialDetail?: ProjectDetailData;
  /** The resolved appearance scheme (system already folded to dark/light upstream). */
  scheme?: "dark" | "light";
  onOpenRow(row: SmartRow): void;
  onBack(): void;
}) {
  const [detail, setDetail] = useState<ProjectDetailData | null>(initialDetail ?? null);
  const [error, setError] = useState<string>();
  const [sort, setSort] = useState<SmartSort>("hot");
  const [filter, setFilter] = useState<SmartFilter>("all");
  // Branches whose local worktree has been cleaned up (optimistic; the row's
  // annotation disappears immediately, the command acknowledges behind it).
  const [cleaned, setCleaned] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setError(undefined);
    if (initialDetail) {
      setDetail(initialDetail);
      return;
    }
    setDetail(null);
    bridge
      .invoke("project.detail", { projectId: project.id })
      .then(setDetail)
      .catch((reason: unknown) => setError(messageFrom(reason)));
  }, [bridge, initialDetail, project.id]);

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
        <button
          type="button"
          className="project-detail-back inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-chip border border-line text-ink-soft hover:bg-raised hover:text-ink"
          onClick={onBack}
        >
          <ArrowLeftIcon size={13} />
          Projects
        </button>
        <span className="project-detail-heading flex flex-col gap-0.5 min-w-0">
          <span className="project-detail-name font-display text-xl text-ink">{project.name}</span>
          <span className="project-detail-path font-mono text-sm text-ink-faint truncate">
            {project.path}
          </span>
        </span>
      </header>

      {error ? <p className="project-detail-error mt-4 text-danger">{error}</p> : null}

      {detail === null && !error ? (
        <p className="project-detail-loading my-6 mx-1 text-ink-faint">
          Reading local work and pull requests…
        </p>
      ) : null}

      {detail ? (
        <>
          <FilterBar
            counts={counts}
            filter={filter}
            sort={sort}
            onFilter={setFilter}
            onSort={setSort}
          />

          {detail.truncated ? (
            <p
              className="project-detail-truncated flex items-center gap-2 mt-3.5 px-3.5 py-2.5 rounded-chip border border-accent-line bg-accent-surface text-ink text-base"
              role="note"
            >
              <TriangleIcon size={13} />
              Showing a partial list — more than 1000 items upstream. This surface is not complete.
            </p>
          ) : null}

          {detail.authUnavailable ? (
            <p
              className="project-detail-auth-hint mt-2.5 px-3.5 py-2 rounded-chip border border-line text-ink-soft text-sm"
              role="note"
            >
              {detail.authUnavailable === "not-connected"
                ? "Pull requests unavailable — GitHub is not connected. Connect in Settings."
                : detail.authUnavailable === "token-invalid"
                  ? "Pull requests unavailable — the GitHub token was revoked or expired. Reconnect in Settings."
                  : detail.authUnavailable === "network"
                    ? "GitHub is unreachable right now — showing local work only."
                    : "Pull requests unavailable — the GitHub token is missing the repo scope."}
            </p>
          ) : null}

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

/* ── The filter + sort bar ─────────────────────────────────────────────────── */

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
  onFilter,
  onSort,
}: {
  counts: Record<SmartFilter, number>;
  filter: SmartFilter;
  sort: SmartSort;
  onFilter(filter: SmartFilter): void;
  onSort(sort: SmartSort): void;
}) {
  return (
    <div className="smart-filter-bar flex items-center justify-between gap-4 py-4 flex-wrap">
      <div className="smart-filters flex gap-2 flex-wrap">
        {FILTERS.map((entry) => {
          const active = filter === entry.id;
          return (
            <button
              type="button"
              key={entry.id}
              className={`smart-filter inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-base transition ${active ? "is-active border-accent-line bg-accent-soft text-ink" : "border-line text-ink-soft hover:text-ink"}`}
              aria-pressed={active}
              onClick={() => onFilter(entry.id)}
            >
              {entry.label}
              <span
                className={`smart-filter-count font-mono text-2xs ${active ? "text-accent" : "text-ink-faint"}`}
              >
                {counts[entry.id]}
              </span>
            </button>
          );
        })}
      </div>
      <label className="smart-sort inline-flex items-center gap-2">
        <span className="smart-sort-label text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          Sort
        </span>
        <select
          className="smart-sort-select px-2.5 py-1.5 rounded-chip border border-line-strong bg-surface text-ink"
          value={sort}
          onChange={(event) => onSort(event.target.value as SmartSort)}
        >
          {SORTS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
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
            <GitBranchIcon size={14} />
          )}
        </span>
        <span className="smart-row-main min-w-0 flex flex-col gap-1.5">
          <span className="smart-row-title text-base font-semibold text-ink truncate">
            {row.title}
          </span>
          <span className="smart-row-sub flex items-center flex-wrap gap-2.5 text-sm text-ink-faint">
            <span className="smart-row-branch inline-flex items-center gap-1 font-mono text-ink-soft">
              <GitBranchIcon size={11} />
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
                <SparkleIcon size={11} />
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
              <LockIcon size={11} />
              read-only
            </span>
          ) : null}
          <StateLabel row={row} />
        </span>
      </button>

      <div className="smart-row-actions flex-none flex items-center gap-2 pr-3 py-2.5">
        {row.readOnly && row.checkedOutLocally ? (
          <button
            type="button"
            className="smart-row-cleanup px-3 py-1.5 rounded-control border border-line text-ink-soft text-base hover:text-ink hover:border-green-line"
            onClick={() => onCleanUp(row)}
          >
            Clean up
          </button>
        ) : null}
        <button
          type="button"
          className="smart-row-action inline-flex items-center gap-1 px-3 py-1.5 rounded-control border border-accent-line bg-accent-soft text-ink text-base hover:border-accent"
          onClick={() => onOpen(row)}
        >
          {rowActionLabel(row)}
          <ArrowRightIcon size={12} />
        </button>
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
            {done ? <CheckIcon size={9} /> : null}
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
  const Glyph = ci === "passing" ? CheckIcon : ci === "failing" ? CloseIcon : EllipsisIcon;
  return (
    <span
      className={`smart-row-ci is-${ci} inline-flex items-center gap-1 font-mono text-2xs font-bold ${ci === "pending" ? "text-ink-faint" : "text-ink"}`}
    >
      CI <Glyph size={11} />
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
