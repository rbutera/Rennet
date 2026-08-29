import type { FileChangeStatus, PatchFile } from "@rennet/protocol";
import { Collapse, cn } from "@rennet/ui";
import {
  Check,
  ChevronDown,
  Copy,
  File,
  FileCode,
  Folder,
  MessageSquare,
  Plus,
  Search,
  UnfoldVertical,
} from "lucide-react";
import * as React from "react";
import { useSearch } from "wouter";
import { Icon } from "../components/icon";
import { useFlightBatcher } from "../handoff/exit-flight";
import { readSessionQuery } from "../routes/url";
import {
  codePositionKey,
  selectCodeComments,
  stagedAskCodePosition,
  useRennetStore,
} from "../store";
import { detectLanguage, tokenizeDiffLine } from "../syntax/shiki";
import { fileStats, type Hunk, hunkHeader, numberLines, parsePatch } from "./diff-parse";
import { LineCommentEditor } from "./line-comment-editor";
import { ProseSelectionLayer } from "./selection-toolbar";

// ─────────────────────────────────────────────────────────────────────────────
// The Diff surface (C6, #489) — the raw patchset in GitHub's Files-changed shape:
// file tree + filter on the left, per-file diff cards with dual line-number gutters,
// hunk headers, viewed tracking, and the SAME line-comment / Request Changes / selection
// Explain machinery as every other code surface. Ported from the board-prototype spike's
// `diff-view.tsx` (one of its cleanest files); only the seams are rewritten — the fixture
// becomes the `PatchFile` projection parsed by `diff-parse.ts`, tokenization goes through
// the synchronous `syntax/shiki.ts`, comments read/write the `review` slice directly (no
// provider shim), and the deep-link param is read through wouter + the `routes/url.ts`
// query grammar (no `next/navigation`).
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<FileChangeStatus, string> = {
  added: "added",
  modified: "",
  deleted: "deleted",
  renamed: "renamed",
};

/** GitHub's five-square add/delete proportion chip. */
function StatSquares({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const greens = total === 0 ? 0 : Math.round((additions / total) * 5);
  return (
    <span className="flex items-center gap-px" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: five fixed positional squares.
          key={i}
          className={cn(
            "size-2 rounded-micro",
            i < greens ? "bg-green" : total > 0 && "bg-destructive/80",
            total === 0 && "bg-muted",
          )}
        />
      ))}
    </span>
  );
}

export interface DiffViewProps {
  readonly files: readonly PatchFile[];
  /** The active captured patchset. Absent only for legacy/test mounts and historical reads. */
  readonly patchsetId?: string;
  /**
   * This surface is a HISTORICAL read — its line numbers are not the review's (#571).
   *
   * A comment and a request-change ask are both keyed on `${path}:${line}` — `codeComments`
   * by path+line, a staged ask by that string as its whole identity — and that keyspace
   * belongs to the review's ACTIVE patchset. A past round's diff is measured
   * checkpoint-to-checkpoint, so `src/foo.ts:42` there is very likely different code from
   * `src/foo.ts:42` here. Writing under it would surface the comment on the live diff over
   * code the reviewer never read, and would SILENTLY REPLACE a live-diff ask staged at the
   * same coordinates ("re-save replaces it", below) — the reviewer's own words gone with no
   * trace. Nothing errors; the label is right and the content is wrong.
   *
   * So a historical surface carries no gutter and no selection toolbar. Absent, not
   * disabled: a control that cannot mean what it says should not be on the page. Reading is
   * the whole of what a past round's diff offers.
   */
  readonly historical?: boolean;
}

export function DiffView({ files, patchsetId, historical = false }: DiffViewProps) {
  const [filter, setFilter] = React.useState("");
  const [viewed, setViewed] = React.useState<Record<string, boolean>>({});
  const search = useSearch();

  // ?file=<path> deep-links to one file's card (the code-block / board filename links
  // here with it). The persistent chat can change the target while Diff stays mounted,
  // so every distinct address scrolls rather than only the first one.
  const fileParam = readSessionQuery(new URLSearchParams(search)).file;
  React.useEffect(() => {
    if (!fileParam) return;
    document.getElementById(`diff-${fileParam}`)?.scrollIntoView({ block: "start" });
  }, [fileParam]);

  const q = filter.trim().toLowerCase();
  const shown = files.filter((f) => !q || f.path.toLowerCase().includes(q));
  const totals = files.reduce(
    (acc, f) => {
      const s = fileStats(f);
      return { additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions };
    },
    { additions: 0, deletions: 0 },
  );
  const viewedCount = files.filter((f) => viewed[f.path]).length;

  function jumpTo(path: string) {
    document.getElementById(`diff-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Scroll frame 1: the diff cards. The selection layer sits INSIDE the frame (its
          plain container div would otherwise break the flex height chain). */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MaybeSelectionLayer enabled={!historical}>
          <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4 px-6 py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{files.length} files changed</span>
              <span className="text-green">+{totals.additions}</span>
              <span className="text-destructive">−{totals.deletions}</span>
              <StatSquares additions={totals.additions} deletions={totals.deletions} />
              <span className="ml-auto tabular-nums">
                {viewedCount} / {files.length} viewed
              </span>
            </div>

            {shown.map((file) => (
              <DiffFileCard
                key={file.path}
                file={file}
                patchsetId={patchsetId}
                historical={historical}
                viewed={!!viewed[file.path]}
                onViewedChange={(value) => setViewed((prev) => ({ ...prev, [file.path]: value }))}
              />
            ))}
            {shown.length === 0 && (
              <span className="py-8 text-center text-sm text-muted-foreground">
                No files match “{filter.trim()}”.
              </span>
            )}
          </div>
        </MaybeSelectionLayer>
      </div>

      {/* Scroll frame 2: the file list, on the right. */}
      <aside className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-3">
        <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 focus-within:border-ring">
          <Icon icon={Search} className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files…"
            aria-label="Filter changed files"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <FileTree files={shown} viewed={viewed} onJump={jumpTo} />
      </aside>
    </div>
  );
}

/** Minimal directory tree — folders as headers, files indented beneath. */
function FileTree({
  files,
  viewed,
  onJump,
}: {
  files: readonly PatchFile[];
  viewed: Record<string, boolean>;
  onJump: (path: string) => void;
}) {
  const byDir = new Map<string, PatchFile[]>();
  for (const file of files) {
    const dir = file.path.split("/").slice(0, -1).join("/");
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Changed files">
      {[...byDir.entries()].map(([dir, dirFiles]) => (
        <div key={dir} className="flex flex-col gap-0.5">
          {/* Root-level files (no directory) list directly — no empty folder header. */}
          {dir !== "" && (
            <span className="flex items-center gap-1.5 px-1 pt-1.5 text-2xs text-muted-foreground/70">
              <Icon icon={Folder} className="size-3 shrink-0" />
              <span className="truncate">{dir}</span>
            </span>
          )}
          {dirFiles.map((file) => {
            const name = file.path.split("/").pop();
            const stats = fileStats(file);
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => onJump(file.path)}
                className="flex items-center gap-1.5 rounded-md py-1 pl-5 pr-1 text-left text-xs text-foreground/85 transition-colors hover:bg-secondary"
              >
                <Icon icon={File} className="size-3 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    "truncate",
                    viewed[file.path] &&
                      "text-muted-foreground line-through decoration-muted-foreground/40",
                  )}
                >
                  {name}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-2xs tabular-nums">
                  <span className="text-green">+{stats.additions}</span>
                  <span className="text-destructive">−{stats.deletions}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** The selection toolbar's container, or a plain box when the surface takes no asks
 *  (`historical`). The wrapper must stay a plain div either way — the flex height chain
 *  above it depends on it. */
function MaybeSelectionLayer({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return enabled ? <ProseSelectionLayer>{children}</ProseSelectionLayer> : <div>{children}</div>;
}

function DiffFileCard({
  file,
  patchsetId,
  historical,
  viewed,
  onViewedChange,
}: {
  file: PatchFile;
  patchsetId?: string;
  historical: boolean;
  viewed: boolean;
  onViewedChange: (viewed: boolean) => void;
}) {
  // Marking a file viewed collapses it, exactly like GitHub. `collapsed` is the user's own
  // collapse INTENT (toggled by the chevron); `viewed` collapses the display independently.
  // Toggling Viewed re-syncs the intent so un-viewing reveals the card (below), instead of a
  // chevron click on a viewed card latching `collapsed=true` and hiding it after un-view.
  const [collapsed, setCollapsed] = React.useState(false);
  const open = !collapsed && !viewed;
  const stats = fileStats(file);
  const hunks = React.useMemo(() => parsePatch(file.patch), [file.patch]);
  const [copied, setCopied] = React.useState(false);

  async function copyPath() {
    // Silent no-op when the clipboard API is unavailable (insecure context, denied).
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail (permissions) — the button no-ops.
    }
  }

  return (
    <section
      id={`diff-${file.path}`}
      className="scroll-mt-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border bg-secondary/50 px-2 py-1.5",
          !open && "border-b-0",
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={open}
          aria-label={open ? "Collapse file" : "Expand file"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Icon
            icon={ChevronDown}
            className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
          />
        </button>
        <Icon icon={FileCode} className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "truncate font-mono text-xs text-foreground/85",
            viewed && "text-muted-foreground",
          )}
        >
          {file.status === "renamed" && file.previousPath ? (
            <>
              <span className="text-muted-foreground">{file.previousPath}</span>
              <span className="mx-1 text-muted-foreground/60">→</span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {STATUS_LABEL[file.status] && (
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-px text-2xs uppercase tracking-wide",
              file.status === "added"
                ? "border-green/40 text-green"
                : file.status === "deleted"
                  ? "border-destructive/40 text-destructive"
                  : "border-border text-muted-foreground",
            )}
          >
            {STATUS_LABEL[file.status]}
          </span>
        )}
        <button
          type="button"
          onClick={copyPath}
          aria-label="Copy file path"
          title="Copy file path"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Icon icon={copied ? Check : Copy} className="size-3" />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
          <span className="text-green">+{stats.additions}</span>
          <span className="text-destructive">−{stats.deletions}</span>
          <StatSquares additions={stats.additions} deletions={stats.deletions} />
        </span>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => {
              onViewedChange(event.target.checked);
              // Re-sync the collapse intent to the Viewed state: checking collapses,
              // un-checking reveals — so a prior chevron click can't leave it latched shut.
              setCollapsed(event.target.checked);
            }}
            className="size-3 accent-primary"
          />
          Viewed
        </label>
      </div>

      <Collapse open={open}>
        {file.binary ? (
          <div className="px-3 py-2.5 text-xs text-muted-foreground">Binary file not shown.</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-max font-mono text-xs leading-[1.7]">
              {hunks.map((hunk, i) => (
                <DiffHunkView
                  // biome-ignore lint/suspicious/noArrayIndexKey: hunks are a fixed positional list within the file.
                  key={i}
                  hunk={hunk}
                  path={file.path}
                  basePath={file.previousPath ?? file.path}
                  patchsetId={patchsetId}
                  historical={historical}
                />
              ))}
            </div>
          </div>
        )}
      </Collapse>
    </section>
  );
}

function DiffHunkView({
  hunk,
  path,
  basePath,
  patchsetId,
  historical,
}: {
  hunk: Hunk;
  path: string;
  basePath: string;
  patchsetId?: string;
  historical: boolean;
}) {
  const comments = useRennetStore(selectCodeComments(path));
  const stagedAsks = useRennetStore((s) => s.review.stagedAsks);
  const { setCodeComment, clearCodeComment, stageAsk } = useRennetStore((s) => s.reviewActions);
  const flight = useFlightBatcher();
  const [openLine, setOpenLine] = React.useState<number | null>(null);

  const language = React.useMemo(() => detectLanguage(path), [path]);
  const lines = React.useMemo(() => numberLines(hunk), [hunk]);
  const tokenLines = React.useMemo(
    () => lines.map((line) => tokenizeDiffLine(line.text, language)),
    [lines, language],
  );
  const askPositions = React.useMemo(() => {
    const set = new Set<string>();
    for (const ask of Object.values(stagedAsks)) {
      if (ask.type !== "request-change") continue;
      if (ask.codeRef !== undefined && ask.codeRef.patchsetId !== patchsetId) continue;
      const position = stagedAskCodePosition(ask);
      if (position !== null) set.add(codePositionKey(position));
    }
    return set;
  }, [stagedAsks, patchsetId]);

  return (
    <div className="[container-type:inline-size]">
      <div className="flex items-center gap-2 bg-secondary/40 px-2 py-1 text-2xs text-muted-foreground">
        <Icon icon={UnfoldVertical} className="size-3 shrink-0" />
        <span>{hunkHeader(hunk)}</span>
      </div>
      {lines.map((line, i) => {
        const rowSide = line.type === "del" ? ("LEFT" as const) : ("RIGHT" as const);
        const rowLine = rowSide === "LEFT" ? line.oldLine : line.newLine;
        const rowPath = rowSide === "LEFT" ? basePath : path;
        const commentLine = line.newLine;
        // The marks are read out of the SAME `path:line` keyspace the writes go into, so a
        // historical surface must not read them either: a live-diff comment at `foo.ts:42`
        // would paint line 42 of a past round's diff green over code it was never left on.
        // Wrong content under the right label, in the read direction (#571).
        const hasComment =
          !historical && rowSide === "RIGHT" && rowLine !== null && comments?.[rowLine] != null;
        const hasAsk =
          !historical &&
          rowLine !== null &&
          askPositions.has(codePositionKey({ path: rowPath, line: rowLine, side: rowSide }));
        const isOpen = commentLine !== null && openLine === commentLine;
        // The row state a test reads (same vocabulary code-block exposes): a staged ask
        // wins (danger red), then a plain comment (evidence green), else the diff line kind.
        const state = hasAsk ? "ask" : hasComment ? "comment" : line.type;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: hunk rows are a fixed positional list; the index is the line offset.
          <React.Fragment key={i}>
            <div
              data-line={rowLine ?? ""}
              data-side={rowSide}
              data-line-state={state}
              className={cn(
                "group flex min-h-[1.7em]",
                line.type === "add" && "bg-green/10",
                line.type === "del" && "bg-destructive/10",
                hasAsk ? "bg-destructive/25" : (hasComment || isOpen) && "bg-green/15",
              )}
            >
              <span
                className={cn(
                  "w-[5ch] shrink-0 select-none border-r border-transparent py-0 pr-2 text-right text-muted-foreground/50",
                  line.type === "add" && "bg-green/10",
                  line.type === "del" && "bg-destructive/15",
                )}
              >
                {line.oldLine ?? ""}
              </span>
              <span
                className={cn(
                  "relative flex w-[6ch] shrink-0 select-none items-center justify-end gap-1 pr-2 text-right text-muted-foreground/50",
                  line.type === "add" && "bg-green/15",
                  line.type === "del" && "bg-destructive/10",
                )}
              >
                {commentLine !== null && !historical && (
                  <button
                    type="button"
                    onClick={() => setOpenLine(isOpen ? null : commentLine)}
                    aria-label={
                      hasComment
                        ? `Edit comment on line ${commentLine}`
                        : `Comment on line ${commentLine}`
                    }
                    className={cn(
                      "size-4 shrink-0 items-center justify-center rounded transition-colors",
                      hasAsk
                        ? "bg-destructive text-primary-foreground hover:bg-destructive/90"
                        : "bg-primary text-primary-foreground hover:bg-primary/90",
                      hasComment || isOpen ? "flex" : "hidden group-hover:flex",
                    )}
                  >
                    <Icon
                      icon={hasComment ? MessageSquare : Plus}
                      className={hasComment ? "size-2.5" : "size-3"}
                    />
                  </button>
                )}
                <span
                  className={cn(
                    "tabular-nums",
                    commentLine !== null &&
                      !historical &&
                      !hasComment &&
                      !isOpen &&
                      "group-hover:hidden",
                  )}
                >
                  {line.newLine ?? ""}
                </span>
              </span>
              <span
                className={cn(
                  "w-[2ch] shrink-0 select-none text-center",
                  line.type === "add" && "text-green",
                  line.type === "del" && "text-destructive",
                )}
              >
                {line.type === "add" ? "+" : line.type === "del" ? "−" : ""}
              </span>
              <span className="whitespace-pre pr-3 text-foreground/90">
                {tokenLines[i]?.length
                  ? tokenLines[i]?.map((token, ti) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: token order within a line is stable and positional.
                      <span key={ti} className={`rtok rtok-${token.type}`}>
                        {token.text}
                      </span>
                    ))
                  : " "}
              </span>
            </div>
            {isOpen && commentLine !== null && (
              <div className="sticky left-0 w-[100cqw] border-y border-border bg-secondary/40 px-3 py-2.5 font-sans">
                <LineCommentEditor
                  lineLabel={`L${commentLine}`}
                  initialText={comments?.[commentLine] ?? ""}
                  hasComment={!!hasComment}
                  onCancel={() => setOpenLine(null)}
                  onSave={(text) => {
                    if (text === null) clearCodeComment(path, commentLine);
                    else setCodeComment(path, commentLine, text);
                    setOpenLine(null);
                  }}
                  onRequestChanges={(text) => {
                    // Same contract as CodeBlock: the comment saves AND a request-change
                    // ask stages against `${path}:${line}` — the SAME object a board
                    // excerpt's editor writes (R36).
                    setCodeComment(path, commentLine, text);
                    const side = "RIGHT" as const;
                    stageAsk({
                      id: codePositionKey({ path, line: commentLine, side }),
                      anchor: `${path}:${commentLine}`,
                      type: "request-change",
                      body: text,
                      side,
                      ...(patchsetId === undefined
                        ? {}
                        : {
                            codeRef: {
                              patchsetId,
                              path,
                              side: "head",
                              startLine: commentLine,
                              endLine: commentLine,
                            },
                          }),
                    });
                    flight.signal(); // the staging act flies one bubble to the FAB
                    setOpenLine(null);
                  }}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
