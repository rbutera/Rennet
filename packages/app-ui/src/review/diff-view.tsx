import type { FileChangeStatus, PatchFile } from "@rennet/protocol";
import { cn } from "@rennet/ui";
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
import { fileStats, hunkHeader, type NumberedLine, numberLines, parsePatch } from "./diff-parse";
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

/** GitHub's five-square add/delete proportion chip. The squares carry the 4px `micro`
 *  radius, not the prototype's 2px: Rennet's named radius ramp STARTS at micro
 *  (`DESIGN.md` — micro/chip/control/surface/window). Tailwind's own `rounded-xs` would
 *  render 2px here only because `theme.css` never resets the `--radius-*` namespace, and
 *  no test guards it — a 2px step is a ramp decision, not a per-component nudge. */
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

const DIFF_CARD_GAP = 16;
const DIFF_CARD_HEADER_HEIGHT = 36;
const DIFF_ROW_HEIGHT = 24;
const DIFF_EDITOR_HEIGHT = 148;
const DIFF_BODY_TOP = 52;
const DIFF_OVERSCAN = 240;
const DIFF_VIEWPORT_FALLBACK = 720;

type DiffRenderRow =
  | { readonly key: string; readonly kind: "hunk"; readonly header: string }
  | { readonly key: string; readonly kind: "line"; readonly line: NumberedLine };

interface DiffFileModel {
  readonly file: PatchFile;
  readonly rows: readonly DiffRenderRow[];
}

interface DiffFileLayout extends DiffFileModel {
  readonly top: number;
  readonly height: number;
  readonly open: boolean;
  readonly openLine?: number;
}

function modelFile(file: PatchFile): DiffFileModel {
  const rows: DiffRenderRow[] = [];
  for (const [hunkIndex, hunk] of parsePatch(file.patch).entries()) {
    rows.push({ key: `hunk:${hunkIndex}`, kind: "hunk", header: hunkHeader(hunk) });
    for (const [lineIndex, line] of numberLines(hunk).entries()) {
      rows.push({ key: `line:${hunkIndex}:${lineIndex}`, kind: "line", line });
    }
  }
  return { file, rows };
}

function layoutFiles(
  models: readonly DiffFileModel[],
  viewed: Readonly<Record<string, boolean>>,
  collapsed: Readonly<Record<string, boolean>>,
  openLines: Readonly<Record<string, number | undefined>>,
): { readonly files: readonly DiffFileLayout[]; readonly height: number } {
  const layouts: DiffFileLayout[] = [];
  let top = 0;
  for (const model of models) {
    const open = !viewed[model.file.path] && !collapsed[model.file.path];
    const openLine = openLines[model.file.path];
    const bodyHeight = model.file.binary
      ? DIFF_ROW_HEIGHT
      : model.rows.length * DIFF_ROW_HEIGHT +
        (open && openLine !== undefined ? DIFF_EDITOR_HEIGHT : 0);
    const height = DIFF_CARD_HEADER_HEIGHT + (open ? bodyHeight : 0);
    layouts.push({ ...model, top, height, open, openLine });
    top += height + DIFF_CARD_GAP;
  }
  return { files: layouts, height: Math.max(0, top - DIFF_CARD_GAP) };
}

export function DiffView({ files, patchsetId, historical = false }: DiffViewProps) {
  const [filter, setFilter] = React.useState("");
  const [viewed, setViewed] = React.useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [openLines, setOpenLines] = React.useState<Record<string, number | undefined>>({});
  const [bodyFiles, setBodyFiles] = React.useState<readonly PatchFile[]>([]);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(DIFF_VIEWPORT_FALLBACK);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const lastDeepLink = React.useRef<string | undefined>(undefined);
  const search = useSearch();
  const fileParam = readSessionQuery(new URLSearchParams(search)).file;

  const q = filter.trim().toLowerCase();
  const shown = React.useMemo(
    () => files.filter((file) => !q || file.path.toLowerCase().includes(q)),
    [files, q],
  );
  // The summary and file tree commit before patch parsing. This effect starts the
  // virtual body after that first paint, so a large patch cannot hold the whole screen
  // hostage while its row model is built.
  React.useEffect(() => setBodyFiles(shown), [shown]);
  const models = React.useMemo(() => bodyFiles.map(modelFile), [bodyFiles]);
  const layout = React.useMemo(
    () => layoutFiles(models, viewed, collapsed, openLines),
    [models, viewed, collapsed, openLines],
  );
  const totals = files.reduce(
    (acc, f) => {
      const s = fileStats(f);
      return { additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions };
    },
    { additions: 0, deletions: 0 },
  );
  const viewedCount = files.filter((f) => viewed[f.path]).length;

  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const jumpTo = React.useCallback(
    (path: string) => {
      const target = layout.files.find((file) => file.file.path === path);
      const element = scrollRef.current;
      if (!target || !element) return false;
      const top = DIFF_BODY_TOP + target.top;
      element.scrollTop = top;
      setScrollTop(top);
      return true;
    },
    [layout.files],
  );

  // Virtual cards do not exist until they enter the window, so destinations resolve
  // against the stable file layout rather than an incidental DOM node.
  React.useEffect(() => {
    if (!fileParam || lastDeepLink.current === fileParam) return;
    if (jumpTo(fileParam)) lastDeepLink.current = fileParam;
  }, [fileParam, jumpTo]);

  const bodyScrollTop = Math.max(0, scrollTop - DIFF_BODY_TOP);
  const visibleLayouts = layout.files.filter((file) => {
    const pinned = file.openLine !== undefined;
    return (
      pinned ||
      (file.top + file.height >= bodyScrollTop - DIFF_OVERSCAN &&
        file.top <= bodyScrollTop + viewportHeight + DIFF_OVERSCAN)
    );
  });

  function setOpenLine(path: string, line: number | null) {
    setOpenLines((current) => ({ ...current, [path]: line ?? undefined }));
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Scroll frame 1: the diff cards. The selection layer sits INSIDE the frame (its
          plain container div would otherwise break the flex height chain). */}
      <div
        ref={scrollRef}
        className="chrome-scroll-clearance min-h-0 flex-1 overflow-y-auto"
        data-diff-scroll=""
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <MaybeSelectionLayer enabled={!historical}>
          <div className="mx-auto w-full max-w-[980px] px-6 py-4">
            <div className="flex h-5 items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{files.length} files changed</span>
              <span className="text-green">+{totals.additions}</span>
              <span className="text-destructive">−{totals.deletions}</span>
              <StatSquares additions={totals.additions} deletions={totals.deletions} />
              <span className="ml-auto tabular-nums">
                {viewedCount} / {files.length} viewed
              </span>
            </div>

            {shown.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No files match “{filter.trim()}”.
              </div>
            )}
            {shown.length > 0 && (
              <div
                className="relative mt-4"
                style={{ height: `${layout.height}px` }}
                data-total-diff-rows={models.reduce((total, model) => total + model.rows.length, 0)}
              >
                {visibleLayouts.map((entry) => (
                  <div
                    key={entry.file.path}
                    className="absolute inset-x-0"
                    style={{ top: `${entry.top}px`, height: `${entry.height}px` }}
                  >
                    <DiffFileCard
                      model={entry}
                      patchsetId={patchsetId}
                      historical={historical}
                      viewed={!!viewed[entry.file.path]}
                      collapsed={!!collapsed[entry.file.path]}
                      viewportTop={bodyScrollTop - entry.top}
                      viewportHeight={viewportHeight}
                      onCollapsedChange={(value) =>
                        setCollapsed((current) => ({ ...current, [entry.file.path]: value }))
                      }
                      onOpenLineChange={(line) => setOpenLine(entry.file.path, line)}
                      onViewedChange={(value) => {
                        setViewed((current) => ({ ...current, [entry.file.path]: value }));
                        setCollapsed((current) => ({ ...current, [entry.file.path]: value }));
                      }}
                    />
                  </div>
                ))}
              </div>
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
                <span className="ml-auto flex shrink-0 items-center gap-1 text-10 tabular-nums">
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
  model,
  patchsetId,
  historical,
  viewed,
  collapsed,
  viewportTop,
  viewportHeight,
  onCollapsedChange,
  onOpenLineChange,
  onViewedChange,
}: {
  model: DiffFileLayout;
  patchsetId?: string;
  historical: boolean;
  viewed: boolean;
  collapsed: boolean;
  viewportTop: number;
  viewportHeight: number;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenLineChange: (line: number | null) => void;
  onViewedChange: (viewed: boolean) => void;
}) {
  const { file, rows, open, openLine } = model;
  const stats = fileStats(file);
  const [copied, setCopied] = React.useState(false);
  const comments = useRennetStore(selectCodeComments(file.path));
  const stagedAsks = useRennetStore((state) => state.review.stagedAsks);
  const { setCodeComment, clearCodeComment, stageAsk } = useRennetStore(
    (state) => state.reviewActions,
  );
  const flight = useFlightBatcher();
  const language = React.useMemo(() => detectLanguage(file.path), [file.path]);
  const askPositions = React.useMemo(() => {
    const positions = new Set<string>();
    for (const ask of Object.values(stagedAsks)) {
      if (ask.type !== "request-change") continue;
      if (ask.codeRef !== undefined && ask.codeRef.patchsetId !== patchsetId) continue;
      const position = stagedAskCodePosition(ask);
      if (position !== null) positions.add(codePositionKey(position));
    }
    return positions;
  }, [stagedAsks, patchsetId]);

  const positionedRows = React.useMemo(() => {
    const positioned: Array<
      | { readonly kind: "row"; readonly row: DiffRenderRow; readonly top: number }
      | { readonly kind: "editor"; readonly line: number; readonly top: number }
    > = [];
    let top = 0;
    for (const row of rows) {
      positioned.push({ kind: "row", row, top });
      top += DIFF_ROW_HEIGHT;
      if (row.kind === "line" && row.line.newLine === openLine) {
        positioned.push({ kind: "editor", line: openLine, top });
        top += DIFF_EDITOR_HEIGHT;
      }
    }
    return positioned;
  }, [rows, openLine]);
  const bodyViewportTop = viewportTop - DIFF_CARD_HEADER_HEIGHT;
  const visibleRows = positionedRows.filter((positioned) => {
    const height = positioned.kind === "editor" ? DIFF_EDITOR_HEIGHT : DIFF_ROW_HEIGHT;
    const pinned =
      positioned.kind === "editor" ||
      (positioned.row.kind === "line" && positioned.row.line.newLine === openLine);
    return (
      pinned ||
      (positioned.top + height >= bodyViewportTop - DIFF_OVERSCAN &&
        positioned.top <= bodyViewportTop + viewportHeight + DIFF_OVERSCAN)
    );
  });

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
      className="h-full overflow-hidden rounded-lg border border-border bg-card"
    >
      <div
        className={cn(
          "flex h-9 items-center gap-2 border-b border-border bg-secondary/50 px-2",
          !open && "border-b-0",
        )}
      >
        <button
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
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
              "shrink-0 rounded border px-1 py-px text-10 uppercase tracking-wide",
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
            }}
            className="size-3 accent-primary"
          />
          Viewed
        </label>
      </div>

      {open && file.binary && (
        <div className="flex h-6 items-center px-3 text-xs text-muted-foreground">
          Binary file not shown.
        </div>
      )}
      {open && !file.binary && (
        <div className="overflow-x-auto">
          <div
            className="relative min-w-full font-mono text-12-5"
            style={{
              height: `${rows.length * DIFF_ROW_HEIGHT + (openLine === undefined ? 0 : DIFF_EDITOR_HEIGHT)}px`,
            }}
          >
            {visibleRows.map((positioned) => {
              if (positioned.kind === "editor") {
                const commentLine = positioned.line;
                return (
                  <div
                    key={`editor:${commentLine}`}
                    className="absolute inset-x-0 overflow-hidden border-y border-border bg-secondary/40 px-3 py-2.5 font-sans"
                    style={{ top: `${positioned.top}px`, height: `${DIFF_EDITOR_HEIGHT}px` }}
                  >
                    <LineCommentEditor
                      lineLabel={`L${commentLine}`}
                      initialText={comments?.[commentLine] ?? ""}
                      hasComment={comments?.[commentLine] != null}
                      onCancel={() => onOpenLineChange(null)}
                      onSave={(text) => {
                        if (text === null) clearCodeComment(file.path, commentLine);
                        else setCodeComment(file.path, commentLine, text);
                        onOpenLineChange(null);
                      }}
                      onRequestChanges={(text) => {
                        setCodeComment(file.path, commentLine, text);
                        const side = "RIGHT" as const;
                        stageAsk({
                          id: codePositionKey({ path: file.path, line: commentLine, side }),
                          anchor: `${file.path}:${commentLine}`,
                          type: "request-change",
                          body: text,
                          side,
                          ...(patchsetId === undefined
                            ? {}
                            : {
                                codeRef: {
                                  patchsetId,
                                  path: file.path,
                                  side: "head",
                                  startLine: commentLine,
                                  endLine: commentLine,
                                },
                              }),
                        });
                        flight.signal();
                        onOpenLineChange(null);
                      }}
                    />
                  </div>
                );
              }

              if (positioned.row.kind === "hunk") {
                return (
                  <div
                    key={positioned.row.key}
                    className="absolute inset-x-0 flex h-6 items-center gap-2 bg-secondary/40 px-2 text-2xs text-muted-foreground"
                    style={{ top: `${positioned.top}px` }}
                  >
                    <Icon icon={UnfoldVertical} className="size-3 shrink-0" />
                    <span>{positioned.row.header}</span>
                  </div>
                );
              }

              const line = positioned.row.line;
              const rowSide = line.type === "del" ? ("LEFT" as const) : ("RIGHT" as const);
              const rowLine = rowSide === "LEFT" ? line.oldLine : line.newLine;
              const rowPath = rowSide === "LEFT" ? (file.previousPath ?? file.path) : file.path;
              const commentLine = line.newLine;
              const hasComment =
                !historical &&
                rowSide === "RIGHT" &&
                rowLine !== null &&
                comments?.[rowLine] != null;
              const hasAsk =
                !historical &&
                rowLine !== null &&
                askPositions.has(codePositionKey({ path: rowPath, line: rowLine, side: rowSide }));
              const isOpen = commentLine !== null && openLine === commentLine;
              const state = hasAsk ? "ask" : hasComment ? "comment" : line.type;
              const tokens = tokenizeDiffLine(line.text, language);

              return (
                <div
                  key={positioned.row.key}
                  data-line={rowLine ?? ""}
                  data-side={rowSide}
                  data-line-state={state}
                  // ONE diff tint system across the app: the `bg-add`/`bg-del` grounds the
                  // palette defines for changed code (`theme/src/palette.css:74-78`), the
                  // same pair `components/code-view.tsx:141-148` paints. The old
                  // `bg-green/10` / `bg-destructive/10` alphas were a second, near-miss
                  // system over the interface greens — two diff surfaces reading
                  // differently for the same fact. The row carries the fill; the gutters
                  // inherit it rather than carrying their own alpha step, so a changed line
                  // is one continuous band.
                  className={cn(
                    "group absolute inset-x-0 flex h-6 min-w-max items-center",
                    line.type === "add" && "bg-add",
                    line.type === "del" && "bg-del",
                    // The review states OVERRIDE the diff ground (twMerge keeps the last
                    // background): a staged ask reads danger, a comment reads evidence green.
                    hasAsk ? "bg-destructive/25" : (hasComment || isOpen) && "bg-green/15",
                  )}
                  style={{ top: `${positioned.top}px` }}
                >
                  <span className="flex h-full w-[5ch] shrink-0 select-none items-center justify-end border-r border-transparent pr-2 text-muted-foreground/50">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="relative flex h-full w-[6ch] shrink-0 select-none items-center justify-end gap-1 pr-2 text-muted-foreground/50">
                    {commentLine !== null && !historical && (
                      <button
                        type="button"
                        onClick={() => onOpenLineChange(isOpen ? null : commentLine)}
                        aria-label={
                          hasComment
                            ? `Edit comment on line ${commentLine}`
                            : `Comment on line ${commentLine}`
                        }
                        className={cn(
                          "size-4 shrink-0 items-center justify-center rounded transition-colors",
                          hasAsk
                            ? "bg-destructive text-on-danger hover:bg-destructive/90"
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
                      line.type === "add" && "text-add-ink",
                      line.type === "del" && "text-del-ink",
                    )}
                  >
                    {line.type === "add" ? "+" : line.type === "del" ? "−" : ""}
                  </span>
                  <span className="whitespace-pre pr-3 text-foreground/90">
                    {tokens.length
                      ? tokens.map((token, tokenIndex) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: token order within a line is stable and positional.
                          <span key={tokenIndex} className={`rtok rtok-${token.type}`}>
                            {token.text}
                          </span>
                        ))
                      : " "}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
