import type { Project, ProjectDetail as ProjectDetailData, RennetBridge } from "@rennet/protocol";
import { useEffect, useMemo, useState } from "react";
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
 * the surface over it. The substrate is fixture-backed this wave behind the real
 * `project.detail` command; opening a row reaches the live review surface.
 */
export function ProjectDetail({
  bridge,
  project,
  onOpenRow,
  onBack,
}: {
  bridge: RennetBridge;
  project: Project;
  onOpenRow(row: SmartRow): void;
  onBack(): void;
}) {
  const [detail, setDetail] = useState<ProjectDetailData | null>(null);
  const [error, setError] = useState<string>();
  const [sort, setSort] = useState<SmartSort>("hot");
  const [filter, setFilter] = useState<SmartFilter>("all");
  // Branches whose local worktree has been cleaned up (optimistic; the row's
  // annotation disappears immediately, the command acknowledges behind it).
  const [cleaned, setCleaned] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setDetail(null);
    setError(undefined);
    bridge
      .invoke("project.detail", { projectId: project.id })
      .then(setDetail)
      .catch((reason: unknown) => setError(messageFrom(reason)));
  }, [bridge, project.id]);

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
    <div className="rennet-glass project-detail" data-scheme="dark">
      <header className="project-detail-bar">
        <button type="button" className="project-detail-back" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          Projects
        </button>
        <span className="project-detail-heading">
          <span className="project-detail-name">{project.name}</span>
          <span className="project-detail-path">{project.path}</span>
        </span>
      </header>

      {error ? <p className="project-detail-error">{error}</p> : null}

      {detail === null && !error ? (
        <p className="project-detail-loading">Reading local work and pull requests…</p>
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
            <p className="project-detail-truncated" role="note">
              <TriangleIcon size={13} />
              Showing a partial list — more than 1000 items upstream. This surface is not complete.
            </p>
          ) : null}

          <div className="smart-list">
            {shown.length === 0 ? (
              <p className="smart-list-empty">Nothing here for this filter.</p>
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
    <div className="smart-filter-bar">
      <div className="smart-filters">
        {FILTERS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={`smart-filter${filter === entry.id ? " is-active" : ""}`}
            aria-pressed={filter === entry.id}
            onClick={() => onFilter(entry.id)}
          >
            {entry.label}
            <span className="smart-filter-count">{counts[entry.id]}</span>
          </button>
        ))}
      </div>
      <label className="smart-sort">
        <span className="smart-sort-label">Sort</span>
        <select
          className="smart-sort-select"
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
  return (
    <div
      className="smart-row"
      data-kind={row.kind}
      data-state={row.state}
      data-mine={row.mine ? "true" : "false"}
      data-needs-you={row.needsYou ? "true" : "false"}
      data-read-only={row.readOnly ? "true" : "false"}
    >
      <button type="button" className="smart-row-open" onClick={() => onOpen(row)}>
        <span className="smart-row-lead" aria-hidden="true">
          {row.kind === "pr" ? (
            <span className="smart-row-num">#{row.pr?.number}</span>
          ) : (
            <GitBranchIcon size={14} />
          )}
        </span>
        <span className="smart-row-main">
          <span className="smart-row-title">{row.title}</span>
          <span className="smart-row-sub">
            <span className="smart-row-branch">
              <GitBranchIcon size={11} />
              {row.branch}
            </span>
            <span className="smart-row-author">{row.mine ? "you" : row.author}</span>
            {row.kind === "local" && row.local ? <LocalTrajectory row={row} /> : null}
            {row.kind === "pr" && row.pr ? (
              <span className="smart-row-diffstat">
                +{row.pr.additions} −{row.pr.deletions} · {row.pr.changedFiles}f
              </span>
            ) : null}
            {row.checkedOutLocally ? (
              <span
                className="smart-row-checkout"
                title="A local worktree is checked out for this branch"
              >
                <SparkleIcon size={11} />
                checked out locally
                {row.checkedOutLocally.dirty ? " · uncommitted" : ""}
              </span>
            ) : null}
          </span>
        </span>
        <span className="smart-row-state" aria-hidden="true">
          {row.pr ? <CiGlyph ci={row.pr.ci} /> : null}
          {row.needsYou ? <span className="smart-row-badge is-needs-you">needs you</span> : null}
          {row.readOnly ? (
            <span className="smart-row-badge is-read-only">
              <LockIcon size={11} />
              read-only
            </span>
          ) : null}
          <StateLabel row={row} />
        </span>
      </button>

      <div className="smart-row-actions">
        {row.readOnly && row.checkedOutLocally ? (
          <button type="button" className="smart-row-cleanup" onClick={() => onCleanUp(row)}>
            Clean up
          </button>
        ) : null}
        <button type="button" className="smart-row-action" onClick={() => onOpen(row)}>
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
    <span className="smart-row-trajectory" title={`stage ${stage}`}>
      {steps.map((step, index) => (
        <span key={step.id} className={`trajectory-step${index <= currentIndex ? " is-done" : ""}`}>
          {index <= currentIndex ? <CheckIcon size={9} /> : null}
          {step.label}
        </span>
      ))}
      {row.local?.dirty ? <span className="smart-row-dirty">dirty</span> : null}
    </span>
  );
}

function CiGlyph({ ci }: { ci: NonNullable<SmartRow["pr"]>["ci"] }) {
  if (ci === "none") return null;
  return <span className={`smart-row-ci is-${ci}`}>{ciLabel(ci)}</span>;
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
  return <span className="smart-row-statelabel">{label}</span>;
}

function rowActionLabel(row: SmartRow): string {
  if (row.kind === "local") return row.local?.stage === "reviewed" ? "Make PR" : "Review";
  if (row.readOnly) return "View";
  return row.mine ? "Open" : "Review";
}

function ciLabel(ci: "passing" | "failing" | "pending"): string {
  return ci === "passing" ? "CI ✓" : ci === "failing" ? "CI ✕" : "CI …";
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
