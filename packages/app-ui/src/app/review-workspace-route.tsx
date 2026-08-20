import type { CanvasAngle, Review } from "@rennet/types";
import { useEffect, useMemo, useRef } from "react";
import { buildRowRegistry, type RegistryRow } from "../canvas/registrar";
import { ArrowRightIcon } from "../components/icons";
import { ChromeMark } from "../components/update-ready";
import { type AngleRailRow, activePatchset, type DiffFocus, SECONDARY_BUTTON } from "./shared";

const ANGLE_STATE_TEXT: Record<Exclude<AngleRailRow["state"], "ran">, string> = {
  pending: "Pending",
  running: "Running",
  failed: "Failed",
  unavailable: "Unavailable",
};

// The changed-file status chip's gold/green/red fill, by git status. Decisions and
// accent are one hue now, so a modified file's square is the gold fill (brief).
const STATUS_CHIP: Record<string, string> = {
  added: "bg-add text-add-ink",
  modified: "bg-accent-fill text-accent-ink",
  deleted: "bg-del text-del-ink",
  renamed: "bg-accent-soft text-accent",
};

function rowIsFocused(row: RegistryRow, focus: DiffFocus | undefined): boolean {
  if (focus === undefined || row.fileLine === null || row.kind !== "content") return false;
  const endLine = focus.span.endLine ?? focus.span.startLine;
  if (row.fileLine < focus.span.startLine || row.fileLine > endLine) return false;
  if (focus.side === "deletions") return row.side === "deletions";
  if (focus.side === "additions") return row.side === "additions";
  return row.side !== "deletions";
}

export function ReviewWorkspace({
  review,
  selectedPath,
  focus,
  angleRail,
  outlineFallback,
  onOpenAngle,
  onSelectPath,
  onSetRead,
  onRegenerate,
}: {
  review: Review;
  selectedPath?: string;
  focus?: DiffFocus;
  /** The Angles rail, derived from the real canvas/fetch state (`angleRailRows`). */
  angleRail: readonly AngleRailRow[];
  /** True when the loaded set is the mechanical outline, not AI findings (#260). */
  outlineFallback: boolean;
  /** Open the Canvases view on the given angle — the rail's rows navigate there. */
  onOpenAngle(angle: CanvasAngle): void;
  onSelectPath(path: string): void;
  onSetRead(path: string, read: boolean): void;
  onRegenerate(): void;
}) {
  const patchset = activePatchset(review);
  const selected = patchset.files.find((file) => file.path === selectedPath) ?? patchset.files[0];
  const diffRows = useMemo(
    () => buildRowRegistry({ diff: selected?.patch ?? "" }).rows,
    [selected?.patch],
  );
  const diffRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (focus === undefined || focus.path !== selected?.path) return;
    const first = diffRef.current?.querySelector<HTMLElement>('[data-delta-focus="true"]');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView?.({ block: "center" });
  }, [focus, selected?.path]);
  // Read-state is derived: a file is "read" iff it carries a disposition.
  const readPaths = new Set(review.dispositions.map((disposition) => disposition.anchor.path));
  const percentage = patchset.files.length
    ? Math.round((readPaths.size / patchset.files.length) * 100)
    : 100;

  return (
    <div className="app-shell flex min-h-screen flex-col bg-canvas text-ink">
      <header className="topbar flex h-14 items-center justify-between gap-4 border-b border-line bg-canvas px-6">
        <div className="topbar-title flex items-center gap-3">
          <ChromeMark
            size={16}
            className="topbar-mark grid h-[30px] flex-none place-items-center rounded-control border border-accent-line bg-accent-soft px-2"
          />
          <div>
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              LOCAL REVIEW
            </p>
            <h1 className="m-0 font-display text-xl font-medium text-ink">
              {patchset.repository.root.split("/").at(-1)}
            </h1>
          </div>
        </div>
        <div
          className="provenance flex items-center gap-2.5 text-sm text-ink-faint"
          title={patchset.id}
        >
          <span>{patchset.repository.baseRef}</span>
          <code className="rounded-micro bg-raised px-2 py-1 font-mono text-ink">
            {patchset.repository.baseOid.slice(0, 8)}
          </code>
          <ArrowRightIcon size={12} className="provenance-arrow text-ink-faint opacity-70" />
          <code className="rounded-micro bg-raised px-2 py-1 font-mono text-ink">
            {patchset.repository.headOid.slice(0, 8)}
          </code>
        </div>
      </header>

      {review.status === "invalid" ? (
        <section
          className="invalid-banner flex items-center justify-between gap-5 border-b border-accent-line bg-accent-surface px-6 py-3 text-ink"
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <strong>Your code changed.</strong>
            <span>Pinned to the previous patchset until you regenerate.</span>
          </div>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent-fill px-3.5 py-2 font-semibold text-accent-ink"
            onClick={onRegenerate}
          >
            Regenerate affected review
          </button>
        </section>
      ) : null}

      <section
        className="progress-row grid h-[34px] grid-cols-[58px_1fr_58px] items-center gap-2.5 border-b border-line bg-canvas px-6 text-xs text-ink-faint"
        aria-label={`${percentage}% of changed files read`}
      >
        <span>{readPaths.size} read</span>
        <div className="progress-track h-[3px] overflow-hidden rounded-control bg-raised">
          <span className="block h-full bg-accent-fill" style={{ width: `${percentage}%` }} />
        </div>
        <span>{patchset.files.length} files</span>
      </section>

      <main className="review-grid grid min-h-0 flex-1 grid-cols-[260px_minmax(440px,1fr)_240px]">
        <aside
          className="file-panel min-w-0 border-r border-line bg-surface"
          aria-label="Changed files"
        >
          <div className="panel-title flex h-11 items-center gap-2 px-4 pt-4 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
            Changes
          </div>
          {patchset.files.length === 0 ? (
            <p className="muted px-4 text-sm leading-relaxed text-ink-faint">
              No changes against {patchset.repository.baseRef}.
            </p>
          ) : (
            patchset.files.map((file) => {
              const read = readPaths.has(file.path);
              return (
                <button
                  type="button"
                  className={`file-row grid h-10 w-full grid-cols-[22px_minmax(0,1fr)_12px] items-center gap-2 border-l-2 border-transparent text-left text-ink-soft hover:bg-raised ${selected?.path === file.path ? "selected border-accent bg-raised text-ink" : ""}`}
                  key={file.path}
                  onClick={() => onSelectPath(file.path)}
                >
                  <span
                    className={`status status-${file.status} grid h-[17px] w-[18px] place-items-center rounded-micro font-mono text-2xs font-bold ${STATUS_CHIP[file.status] ?? "bg-raised text-ink-soft"}`}
                  >
                    {file.status[0]?.toUpperCase()}
                  </span>
                  <span className="file-name overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs">
                    {file.path}
                  </span>
                  <span
                    className={`read-dot size-[7px] rounded-full border border-line-strong ${read ? "is-read border-accent bg-accent" : ""}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })
          )}
        </aside>

        <section className="diff-panel flex min-w-0 flex-col bg-code">
          <div className="diff-toolbar flex h-11 flex-none items-center justify-between gap-4 border-b border-line bg-canvas px-3.5">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs font-semibold text-ink">
                {selected?.path ?? "No changed file selected"}
              </strong>
              {selected ? (
                <span className="whitespace-nowrap text-xs text-ink-faint">
                  +{selected.additions ?? "–"} −{selected.deletions ?? "–"}
                </span>
              ) : null}
            </div>
            {selected ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => onSetRead(selected.path, !readPaths.has(selected.path))}
              >
                {readPaths.has(selected.path) ? "Mark unread" : "Mark read"}
              </button>
            ) : null}
          </div>
          <pre
            className="diff m-0 flex-1 overflow-auto whitespace-pre px-[18px] pt-4 pb-10 font-mono text-sm leading-relaxed text-ink-soft [tab-size:2]"
            ref={diffRef}
          >
            {selected
              ? diffRows.map((row, index) => {
                  const focused = focus?.path === selected.path && rowIsFocused(row, focus);
                  return (
                    <span
                      key={row.rawIndex}
                      className={`diff-line${focused ? " is-delta-focus bg-accent-soft text-ink" : ""}`}
                      data-delta-focus={focused ? "true" : undefined}
                      data-file-line={row.fileLine ?? undefined}
                      data-side={row.side ?? undefined}
                      tabIndex={focused ? -1 : undefined}
                    >
                      {row.text}
                      {index < diffRows.length - 1 ? "\n" : ""}
                    </span>
                  );
                })
              : "There is no diff to display."}
          </pre>
        </section>

        <aside
          className="angle-panel min-w-0 border-l border-line bg-surface pb-5"
          aria-label="Review angles"
        >
          <div className="panel-title flex h-11 items-center gap-2 px-4 pt-4 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
            Angles
          </div>
          {/* The loud outline honesty travels with the data (real-AI-default): when
              the loaded set is the deterministic mechanical outline, the counts below
              are diff STRUCTURE, and the rail says so — never passing them off as AI
              findings. The Canvases view carries the full banner + retry. */}
          {outlineFallback ? (
            <p className="muted px-4 text-sm leading-relaxed text-ink-faint">
              Structural outline — not AI findings.
            </p>
          ) : null}
          {/* Each row is the REAL state of that canvas angle (critique P2), and a
              row navigates to its canvas lens — the plumbing the Canvases view
              already exposes (`setAngle` + the view toggle), no new machinery. */}
          {angleRail.map((row) => (
            <button
              type="button"
              className="angle-row mx-3 flex h-9 w-[calc(100%-24px)] cursor-pointer items-center justify-between border-b border-line text-left text-sm text-ink-soft hover:text-ink"
              key={row.angle}
              onClick={() => onOpenAngle(row.angle)}
            >
              <span>{row.label}</span>
              <span
                className={`angle-state text-2xs uppercase tracking-wide text-ink-faint${row.state === "ran" ? " is-ran text-ink-soft" : ""}`}
              >
                {row.state === "ran" ? row.detail : ANGLE_STATE_TEXT[row.state]}
              </span>
            </button>
          ))}
          <div className="snapshot-card mx-3 my-4 grid gap-2 rounded-control border border-line bg-raised p-3">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">PATCHSET</span>
            <code className="font-mono text-sm text-accent">{patchset.id.slice(0, 12)}</code>
            <small className="leading-snug text-ink-faint">
              {patchset.truncated
                ? `Showing a capped view of ${patchset.byteLength.toLocaleString()} bytes`
                : `${patchset.byteLength.toLocaleString()} captured bytes`}
            </small>
          </div>
        </aside>
      </main>
    </div>
  );
}
