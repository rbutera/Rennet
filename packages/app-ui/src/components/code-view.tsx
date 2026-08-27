import type { RenderedHunkOccurrence } from "@rennet/protocol";
import { parseAnchor } from "@rennet/protocol";
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import {
  buildRowRegistry,
  indexPlacements,
  type Mark,
  type MarkPlacement,
  type PlacedMark,
  placeMarks,
  type RegistryRow,
  resolveAnchorToRows,
} from "../canvas/registrar";
import { splitIdentifierRuns, tokenTextMayContainSymbol } from "../canvas/symbol";
import { detectLanguage, type LanguageId, tokenizeDiffLine } from "../syntax/shiki";

// The windowed-render range, inlined from the deleted `canvas/logic` (B2, #489): the
// slice of rows to paint around the viewport, keeping the DOM node count bounded. The
// discuss/disposition wiring that once wove this diff into the canvas conversation +
// L2 surface is gone with those modules; the diff renderer itself is what C6 ports.
interface WindowRange {
  start: number;
  end: number;
}
function windowRows(input: {
  total: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}): WindowRange {
  const overscan = input.overscan ?? 6;
  const visibleRows = Math.ceil(input.viewportHeight / input.rowHeight);
  const maxFirst = Math.max(0, input.total - visibleRows);
  const first = Math.min(Math.max(0, Math.floor(input.scrollTop / input.rowHeight)), maxFirst);
  const start = Math.max(0, first - overscan);
  const end = Math.min(input.total, first + visibleRows + overscan);
  return { start, end };
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeView — the ONLY diff surface (R16), and now an INHABITED canvas (issue #77).
// It is still a windowed renderer (a slice around the viewport keeps the DOM node
// count inside MAX_RENDERED_NODES; the Pierre spike measured 97,139 nodes / 493ms
// for a naive full render), but every row now carries real identity and the
// agent's hand (L3 marks) renders AT its anchor, not in a strip beside the code.
//
// Two things make this a canvas rather than a pane:
//   • Rows carry identity — real file line + side + occurrence + per-side ordinal
//     (from the anchor↔row registrar), not diff-row indices.
//   • Marks land at their anchors — an annotation glows ON its span, a proposal
//     card renders inline at its span, the ◇ gutter glyph marks the agent's hand.
//     Placement is computed over the FULL diff and keyed by rawIndex, so a row
//     scrolling out and back never loses its mark (the Pierre recycling caveat,
//     answered: mark state lives outside the recycled rows).
//
// Doctrine: the code body is fully opaque (`--code-bg`); L3 marks are glass chrome
// (the ◇ hand, dashed), visually distinct from L1 analysis and L2 human judgment.
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeViewProps {
  path: string;
  diff: string;
  tier?: string;
  rowHeight?: number;
  viewportHeight?: number;
  scrollTop?: number;
  overscan?: number;
  /** Escape hatch for the node-count control test only: render every row. */
  renderAll?: boolean;

  // ── The inhabited canvas (issue #77), additive and optional ─────────────────
  /**
   * The occurrence identity of each rendered `@@` hunk, in diff order (issue #84).
   * Passed straight from `ElementDiff.hunkOccurrences` — the SAME artifact that
   * produced `diff` — so a mark's row can never drift from the text. Outer index is
   * the Nth `@@` hunk; the inner list is the occurrence(s) it carries (several under
   * one raw hunk for an oversize split).
   */
  hunkOccurrences?: readonly (readonly RenderedHunkOccurrence[])[];
  /** L3 marks to render AT their anchors (annotations glow; proposals get a card). */
  marks?: readonly Mark[];
  /** Renders a mark's interactive card inline at its span (the host owns adjudication/pinning). */
  renderMarkCard?: (mark: Mark, placed: PlacedMark) => ReactNode;
  /** Deixis: the agent points — the focused anchor's span is pulsed. */
  focusAnchor?: string;
  /** Repeats the same pointing deliberately; a new value re-scrolls and re-pulses. */
  focusNonce?: number;
  /** Reports placement (placed + orphans) up, so the host routes orphans + builds the index. */
  onPlacement?: (placement: MarkPlacement) => void;

  /**
   * The impl↔test counterpart jump (Rai, wireframes #7). When the shown file has a
   * counterpart in the review, the header carries ONE button — "View test" on an
   * implementation, "View implementation" on its test — that navigates to it.
   * Absent ⇒ no button (additive: the R16 node envelope is untouched; the button
   * lives on the non-windowed header, never in the per-row window).
   */
  counterpart?: {
    /** "View test" or "View implementation" — the label already resolved by the host. */
    readonly label: string;
    /** The counterpart file's path, for the button's tooltip. */
    readonly path: string;
    /** Navigate to the counterpart (the host selects its element). */
    onView(): void;
  };

  /**
   * A reviewer clicked a code identifier (Rai, wireframes #8). The host opens the
   * in-app symbol inspector for that name. Absent ⇒ identifiers are inert plain
   * tokens (additive: existing callers/tests render unchanged).
   */
  onSymbolClick?: (name: string) => void;

  /**
   * Exposes the diff scroll container (`.code-view-scroll`) upward (issue #356), so the
   * review heart's conversation rail can query rendered rows by their `data-anchor-key`
   * and align a thread panel to the code it discusses. Populated on mount via a merge
   * ref alongside the internal scroll ref. Absent ⇒ nothing is exposed and CodeView
   * behaves exactly as before (additive; the rail then stacks its panels honestly).
   *
   * Accepts EITHER a `RefObject` or a callback ref. A callback ref lets the owner route the
   * element identity through React state, so a sibling rail RE-MEASURES when this CodeView
   * unmounts/remounts (a zoom-out then into another file) instead of aligning against the
   * detached node it first saw (Opus BUG-1). Called with the element on mount, `null` on unmount.
   */
  scrollContainerRef?: Ref<HTMLElement | null>;
}

const SIDE_CLASS = { additions: "cv-add", deletions: "cv-del", context: "cv-ctx" } as const;

function rowClass(row: RegistryRow): string {
  if (row.side) return SIDE_CLASS[row.side];
  return `cv-${row.kind}`;
}

// The diff fill lives on the whole row (dominant signal); the diff INK lives on the
// code cell only, so line numbers stay quiet even on a changed line — the same split
// the old CSS made (`.cv-add` row fill vs `.cv-add .code-view-code` ink).
function rowTint(row: RegistryRow): string {
  if (row.side === "additions") return "bg-add";
  if (row.side === "deletions") return "bg-del";
  return "";
}

function codeTint(row: RegistryRow): string {
  if (row.side === "additions") return "text-add-ink";
  if (row.side === "deletions") return "text-del-ink";
  // Header/meta rows are muted chrome, never content ink.
  if (row.kind === "hunk-header" || row.kind === "file-header" || row.kind === "meta")
    return "text-ink-faint";
  return "text-ink";
}

// Syntax highlighting (issue #68). Only CONTENT rows are tokenized; the highlight
// rides UNDER the diff add/removed colouring, never over it — the row background
// carries the diff semantic (dominant), structural tokens (whitespace, the diff
// marker, punctuation, operators) inherit the row's diff-tinted base colour, and
// only semantic tokens (keyword/string/comment/number/type/function/…) take a
// syntax hue. Header/meta rows stay muted chrome, untouched. Tokenization runs
// only on the windowed rows the CodeView paints, so R16's node/perf envelope holds.
function renderCode(
  row: RegistryRow,
  language: LanguageId | null,
  onSymbolClick?: (name: string) => void,
): ReactNode {
  if (row.kind !== "content") return row.text;
  const nodes: ReactNode[] = [];
  let column = 0; // the token's start column — a stable, data-derived key (not an array index).
  for (const tok of tokenizeDiffLine(row.text, language)) {
    // When the host wants symbol lookups, split a symbol-bearing token into its
    // identifier RUNS and make each one clickable (Rai, wireframes #8). This does not
    // key off the highlight class — an ordinary `plain` identifier, or several inside
    // one whitespace-merged token, each resolve independently. Inert tokens (keyword,
    // string, comment, number, operator, punctuation) render as one plain span, and a
    // QUOTED property key (`"name":`) is a string, not a symbol, so it is inert too.
    if (onSymbolClick && tokenTextMayContainSymbol(tok.type, tok.text)) {
      let offset = 0;
      for (const segment of splitIdentifierRuns(tok.text)) {
        const key = column + offset;
        if (segment.isIdentifier) {
          const name = segment.text;
          nodes.push(
            <button
              type="button"
              className={`rtok rtok-${tok.type} rtok-symbol`}
              key={key}
              data-symbol={name}
              title={`Inspect ${name}`}
              onClick={() => onSymbolClick(name)}
            >
              {segment.text}
            </button>,
          );
        } else {
          nodes.push(
            <span className={`rtok rtok-${tok.type}`} key={key}>
              {segment.text}
            </span>,
          );
        }
        offset += segment.text.length;
      }
    } else {
      nodes.push(
        <span className={`rtok rtok-${tok.type}`} key={column}>
          {tok.text}
        </span>,
      );
    }
    column += tok.text.length;
  }
  return nodes;
}

export function CodeView({
  path,
  diff,
  tier = "syntactic",
  rowHeight = 18,
  viewportHeight = 480,
  scrollTop = 0,
  overscan = 8,
  renderAll = false,
  hunkOccurrences,
  marks,
  renderMarkCard,
  focusAnchor,
  focusNonce = 0,
  onPlacement,
  counterpart,
  onSymbolClick,
  scrollContainerRef,
}: CodeViewProps) {
  // The live scroll position: seeded from the prop (which the node-count control
  // test and any programmatic positioning inject), then advanced by the user's
  // own scrolling so the window tracks the viewport instead of freezing at row 0.
  const [scroll, setScroll] = useState(scrollTop);
  // The scroll container, so a focus-driven jump can move the REAL viewport (setting
  // window state alone leaves the DOM at scrollTop 0, painting blank spacer).
  const scrollRef = useRef<HTMLDivElement>(null);
  // Merge ref: the scroll container serves the internal focus-jump (scrollRef) AND, when
  // the host asks, is exposed upward (issue #356) so the conversation rail can query its
  // rows by anchor key. Set synchronously at commit — before the rail's layout effect
  // reads it — which a passive effect could not guarantee across sibling subtrees.
  const attachScroll = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      // Support both ref shapes: a callback ref (the owner routes identity through state) and
      // a plain RefObject (the existing `.current` contract the anchor tests rely on).
      if (typeof scrollContainerRef === "function") scrollContainerRef(element);
      else if (scrollContainerRef) scrollContainerRef.current = element;
    },
    [scrollContainerRef],
  );

  // Language for syntax highlighting, inferred once from the path extension.
  // Unknown/absent extension → null → plain text (fail-closed, no fabricated colour).
  const language: LanguageId | null = detectLanguage(path);

  // The registry + placement are computed over the FULL diff, never the window —
  // so a mark's home row is a fixed function of (diff, hunkOccurrences, marks) and
  // cannot move when a row recycles. Windowing only chooses which rows to paint.
  const registry = buildRowRegistry({ diff, hunkOccurrences });
  const placement = marks && marks.length > 0 ? placeMarks(registry, marks) : null;
  const { glow, gutter } = placement
    ? indexPlacements(placement)
    : { glow: new Map<number, PlacedMark[]>(), gutter: new Map<number, PlacedMark[]>() };

  // Deixis: resolve the focused anchor to its rows so the surface can pulse them.
  const focusRows = new Set<number>();
  if (focusAnchor) {
    const parsed = parseAnchor(focusAnchor);
    if (parsed.ok) {
      const res = resolveAnchorToRows(registry, parsed.anchor);
      if (res.outcome === "resolved")
        for (const rawIndex of res.rawIndices) focusRows.add(rawIndex);
    }
  }

  // Report placement up (orphans → tray, marks → index) exactly when it changes.
  const placementKey = placement
    ? placement.placed.map((p) => `${p.mark.markId}@${p.gutterRawIndex}`).join(",") +
      "|" +
      placement.orphans.map((o) => `${o.mark.markId}:${o.reason}`).join(",")
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: placementKey is the stable digest of `placement`; depending on the object identity would fire every render.
  useEffect(() => {
    if (placement && onPlacement) onPlacement(placement);
  }, [placementKey, onPlacement]);

  // Bring the deixis focus into view. A jump — a coverage chip to a later hunk in a
  // multi-hunk chunk, a Flagged/Noise index row — resolves rows ANYWHERE in the diff,
  // but the window is seeded from `scrollTop` and would otherwise leave the pulsed row
  // scrolled off-screen (the CSS focus is then useless). When the FIRST focused row
  // CHANGES, move BOTH the window state AND the real scroll container so that row sits
  // near the top (a small margin), clamped into range. Setting `scroll` alone would
  // repaint the right rows but leave the DOM at scrollTop 0 showing blank spacer, so we
  // also move the element's scrollTop through its ref. Keyed on the row index (a
  // number) — user scrolling does not change it, so this never fights the reviewer's
  // own scroll, only a fresh jump target.
  const firstFocusRow = focusRows.size > 0 ? Math.min(...focusRows) : -1;
  useEffect(() => {
    void focusNonce;
    if (firstFocusRow < 0 || renderAll) return;
    const margin = Math.min(overscan, 4) * rowHeight;
    const target = Math.max(0, firstFocusRow * rowHeight - margin);
    setScroll(target);
    if (scrollRef.current) scrollRef.current.scrollTop = target;
  }, [firstFocusRow, focusNonce, renderAll, rowHeight, overscan]);

  const total = registry.rows.length;
  const range: WindowRange = renderAll
    ? { start: 0, end: total }
    : windowRows({ total, rowHeight, viewportHeight, scrollTop: scroll, overscan });
  const visible = registry.rows.slice(range.start, range.end);

  return (
    <section
      className="code-view overflow-hidden rounded-surface border border-line bg-code"
      aria-label={`Diff of ${path}`}
    >
      <header className="code-view-head flex items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2">
        <span className="code-view-path font-mono text-sm text-ink">{path}</span>
        <span
          className="code-view-tier text-2xs font-semibold uppercase tracking-wide text-ink-faint"
          title="Definition tier"
        >
          {tier}
        </span>
        {/* The impl↔test counterpart jump (Rai, wireframes #7): ONE button that
            reads "View test" on an implementation and "View implementation" on its
            test, present only when the counterpart is a file in this review. */}
        {counterpart ? (
          <button
            type="button"
            className="code-view-counterpart ml-auto cursor-pointer rounded-full border border-accent-line bg-accent-soft px-3 py-1 font-sans text-xs text-accent hover:bg-accent-surface"
            title={`Go to ${counterpart.path}`}
            onClick={() => counterpart.onView()}
          >
            {counterpart.label}
          </button>
        ) : null}
      </header>
      <div
        ref={attachScroll}
        className="code-view-scroll overflow-auto bg-code"
        style={{ height: `${viewportHeight}px` }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        data-total-rows={total}
        data-rendered-rows={visible.length}
        data-window-start={range.start}
      >
        {/* A spacer preserves scroll height for the rows above the window. */}
        <div className="code-view-spacer" style={{ height: `${range.start * rowHeight}px` }} />
        {visible.map((row) => {
          const glowMarks = glow.get(row.rawIndex);
          const gutterMarks = gutter.get(row.rawIndex);
          const isGlow = glowMarks !== undefined && glowMarks.length > 0;
          const isFocus = focusRows.has(row.rawIndex);
          const className = [
            // Layout is pinned to an 18px row (text-xs · leading-normal = 12·1.5) so the
            // windowing spacers stay honest.
            "code-view-row group relative grid grid-cols-[52px_1fr] font-mono text-xs leading-normal",
            rowClass(row),
            rowTint(row),
            // The L3 mark's private backlight: a gold left bar + faint inset wash (the
            // load-bearing local/private state marker), replacing the old --private glow.
            isGlow
              ? "cv-glow shadow-[inset_3px_0_0_0_var(--rn-accent),inset_0_0_18px_var(--rn-accent-soft)]"
              : "",
            isFocus ? "cv-focus" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              className={className}
              key={isFocus ? `${row.rawIndex}:${focusNonce}` : row.rawIndex}
              data-raw-index={row.rawIndex}
              data-side={row.side ?? undefined}
              data-file-line={row.fileLine ?? undefined}
              data-side-ordinal={row.sideOrdinal ?? undefined}
              data-occurrence={row.occurrenceId ?? undefined}
              data-focus-nonce={isFocus ? focusNonce : undefined}
              data-mark={isGlow ? glowMarks.map((m) => m.mark.markId).join(" ") : undefined}
            >
              {gutterMarks && gutterMarks.length > 0 ? (
                <span
                  className="cv-gutter l3-hand pointer-events-none absolute left-0.5 top-0 text-xs leading-normal text-accent"
                  data-l3="mark"
                  data-gutter-marks={gutterMarks.map((m) => m.mark.markId).join(" ")}
                  aria-hidden="true"
                  title="Orchestrator mark"
                >
                  ◇
                </span>
              ) : null}
              <span className="code-view-ln select-none px-2.5 text-right text-ink-faint">
                {row.fileLine ?? ""}
              </span>
              <code className={`code-view-code whitespace-pre pr-3 ${codeTint(row)}`}>
                {renderCode(row, language, onSymbolClick)}
              </code>
              {/* The mark's card renders inline AT its span (its home row), not in a strip. */}
              {gutterMarks && renderMarkCard
                ? gutterMarks.map((placed) => (
                    <div
                      className="cv-mark-card col-span-full py-1.5 pr-3 pl-[52px]"
                      data-mark-card={placed.mark.markId}
                      key={placed.mark.markId}
                    >
                      {renderMarkCard(placed.mark, placed)}
                    </div>
                  ))
                : null}
            </div>
          );
        })}
        <div
          className="code-view-spacer"
          style={{ height: `${(total - range.end) * rowHeight}px` }}
        />
      </div>
    </section>
  );
}
