import { parseAnchor } from "@rennet/protocol";
import type { AnchorSide, DispositionType, RenderedHunkOccurrence } from "@rennet/types";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type ConversationAnchor,
  chunkAnchorKey,
  lineAnchorKey,
  rangeAnchorKey,
} from "../canvas/conversation";
import { type WindowRange, windowRows } from "../canvas/logic";
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
import { detectLanguage, type LanguageId, tokenizeLine } from "../syntax/highlight";
import { DiscussControl } from "./conversation-cluster";
import { DispositionCluster } from "./disposition-cluster";

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
  /** Reports placement (placed + orphans) up, so the host routes orphans + builds the index. */
  onPlacement?: (placement: MarkPlacement) => void;

  /**
   * The disposition cluster on the chunk/file HEADER (issue #109). When present, the
   * header carries the four verbs anchored to this file/chunk; disposing calls this
   * with the chosen verb and the host resolves it to the L2 write (a chunk-header
   * disposition). Absent ⇒ no cluster (additive: existing callers render unchanged,
   * so the R16 node envelope is untouched — the cluster lives on the non-windowed
   * header, never in the per-row window). Line + range anchoring ride the inhabited
   * canvas + the #36/#139 thread machinery; the header is this slice's floor.
   */
  onDispose?: (type: DispositionType) => void;

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
   * Open a private conversation thread (issue #36, the "discuss / ask-the-harness"
   * verb) anchored INSIDE the diff — the felt gap the audit ranked first. ONE
   * callback carries every anchor KIND, so the diff surface speaks the "verbs times
   * anchors" abstraction rather than four one-off paths:
   *   • a diff LINE — plain-click a row's discuss glyph;
   *   • a RANGE — shift-click a second row's glyph, extending from the last line
   *     whose glyph was clicked (the GitHub line-number idiom);
   *   • the CHUNK — the discuss verb on the file/chunk header.
   * The thread lands in the right-margin sibling column, so opening or growing it
   * never reflows this diff. Absent ⇒ no discuss affordance renders (additive:
   * existing callers/tests are untouched, and the R16 node envelope holds because
   * the per-row glyph is one element on already-windowed rows).
   */
  onDiscuss?: (anchor: ConversationAnchor) => void;
}

/**
 * Build a diff-LINE conversation anchor. The key is INJECTIVE and kind-prefixed
 * (`line|path|side|line`, issue #36 F4), and — the load-bearing half — `side` rides as
 * SEMANTIC DATA on the anchor (F1), so `buildConversationQuestion` tells the model
 * WHICH SIDE the reviewer pointed at. Deletion old-L11 and addition new-L11 are then
 * distinct threads AND distinct questions, not just distinct keys.
 */
function lineAnchor(
  path: string,
  line: number,
  side: AnchorSide,
  context: string,
): ConversationAnchor {
  return {
    kind: "line",
    label: `${path}:${line}`,
    key: lineAnchorKey(path, side, line),
    side,
    path,
    context,
  };
}

/**
 * Build a RANGE conversation anchor spanning two file lines on ONE side (order-
 * normalised). A range never spans pre- and post-image: the caller only forms one when
 * both endpoints share a side, so the (kind-prefixed) key and the carried `side` are
 * unambiguous.
 */
function rangeAnchor(
  path: string,
  a: number,
  b: number,
  side: AnchorSide,
  context: string,
): ConversationAnchor {
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return {
    kind: "range",
    label: `${path}:${start}-${end}`,
    key: rangeAnchorKey(path, side, start, end),
    side,
    path,
    context,
  };
}

const SIDE_CLASS = { additions: "cv-add", deletions: "cv-del", context: "cv-ctx" } as const;

function rowClass(row: RegistryRow): string {
  if (row.side) return SIDE_CLASS[row.side];
  return `cv-${row.kind}`;
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
  for (const tok of tokenizeLine(row.text, language)) {
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
  onPlacement,
  onDispose,
  counterpart,
  onSymbolClick,
  onDiscuss,
}: CodeViewProps) {
  // The live scroll position: seeded from the prop (which the node-count control
  // test and any programmatic positioning inject), then advanced by the user's
  // own scrolling so the window tracks the viewport instead of freezing at row 0.
  const [scroll, setScroll] = useState(scrollTop);
  // The last file line whose discuss glyph was plain-clicked (issue #36). A
  // subsequent SHIFT-click on another row's glyph extends a RANGE from here — the
  // GitHub line-number idiom. Null until the first line is clicked; it does not gate
  // a plain click (a line thread opens with no prior selection). This is UI-only
  // ephemeral state: it never touches the diff registry, so the code column cannot
  // move when a thread opens.
  // The last line whose discuss glyph was plain-clicked, WITH its side (issue #36
  // HIGH-2). A subsequent SHIFT-click on another row's glyph extends a RANGE from here
  // — but only when the SIDES MATCH, so a range can never span pre- and post-image.
  // Null until the first line is clicked. UI-only ephemeral state: it never touches the
  // diff registry, so the code column cannot move when a thread opens.
  const [rangeStart, setRangeStart] = useState<{ line: number; side: AnchorSide } | null>(null);

  // Open a thread on the clicked row's line, or — on a same-side shift-click with a
  // prior line recorded — on the RANGE from that prior line to this one. One handler,
  // both anchor kinds, so the diff speaks the single "verbs times anchors" abstraction.
  function discussLine(line: number, side: AnchorSide, shiftKey: boolean): void {
    if (!onDiscuss) return;
    const contextBetween = (start: number, end: number) =>
      registry.rows
        .filter(
          (row) =>
            row.kind === "content" &&
            row.side === side &&
            row.fileLine !== null &&
            row.fileLine >= start &&
            row.fileLine <= end,
        )
        .map((row) => row.text.replace(/^[ +-]/, ""))
        .join("\n");
    // A range only forms across the SAME side (both new-file or both old-file); a
    // cross-side shift-click starts a fresh single-line anchor instead of a nonsensical
    // pre-to-post span.
    if (shiftKey && rangeStart !== null && rangeStart.side === side && rangeStart.line !== line) {
      const start = Math.min(rangeStart.line, line);
      const end = Math.max(rangeStart.line, line);
      onDiscuss(rangeAnchor(path, start, end, side, contextBetween(start, end)));
      setRangeStart(null);
      return;
    }
    onDiscuss(lineAnchor(path, line, side, contextBetween(line, line)));
    setRangeStart({ line, side });
  }
  // The scroll container, so a focus-driven jump can move the REAL viewport (setting
  // window state alone leaves the DOM at scrollTop 0, painting blank spacer).
  const scrollRef = useRef<HTMLDivElement>(null);

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
    if (firstFocusRow < 0 || renderAll) return;
    const margin = Math.min(overscan, 4) * rowHeight;
    const target = Math.max(0, firstFocusRow * rowHeight - margin);
    setScroll(target);
    if (scrollRef.current) scrollRef.current.scrollTop = target;
  }, [firstFocusRow, renderAll, rowHeight, overscan]);

  const total = registry.rows.length;
  const range: WindowRange = renderAll
    ? { start: 0, end: total }
    : windowRows({ total, rowHeight, viewportHeight, scrollTop: scroll, overscan });
  const visible = registry.rows.slice(range.start, range.end);

  return (
    <section className="code-view" aria-label={`Diff of ${path}`}>
      <header className="code-view-head">
        <span className="code-view-path">{path}</span>
        <span className="code-view-tier" title="Definition tier">
          {tier}
        </span>
        {/* The impl↔test counterpart jump (Rai, wireframes #7): ONE button that
            reads "View test" on an implementation and "View implementation" on its
            test, present only when the counterpart is a file in this review. */}
        {counterpart ? (
          <button
            type="button"
            className="code-view-counterpart"
            title={`Go to ${counterpart.path}`}
            onClick={counterpart.onView}
          >
            {counterpart.label}
          </button>
        ) : null}
        {/* The chunk-header disposition cluster (issue #109) — the four verbs
            anchored to this file/chunk. Progressively disclosed (calm roll-up, #62)
            by the header's hover/focus, so the surface reads quiet until engaged. */}
        {onDispose ? (
          <DispositionCluster
            anchor={{ kind: "chunk", label: path }}
            compact
            labelled={false}
            onDispose={onDispose}
          />
        ) : null}
        {/* The discuss verb on the chunk header (issue #36) — open a private thread
            on the whole chunk, the sibling of the four disposition verbs. Icon-only
            to keep the header calm; the same `onDiscuss` the per-line glyphs use. */}
        {onDiscuss ? (
          <DiscussControl
            anchor={{ kind: "chunk", label: path, key: chunkAnchorKey(path) }}
            labelled={false}
            onDiscuss={onDiscuss}
          />
        ) : null}
      </header>
      <div
        ref={scrollRef}
        className="code-view-scroll"
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
          // The file line this row can anchor a conversation to (issue #36): a real
          // new/old-file line on a content row, else none (a meta/header row has
          // nothing to discuss). Bound once so TS narrows it inside the glyph JSX.
          // The (line, side) this row can anchor a conversation to (issue #36): a real
          // new/old-file line on a content row with a side, else none (a meta/header row
          // has nothing to discuss). Bound once so TS narrows them inside the glyph JSX.
          const discussSide = row.kind === "content" ? (row.side ?? undefined) : undefined;
          const discussLineNo =
            row.kind === "content" && row.fileLine != null && discussSide !== undefined
              ? row.fileLine
              : undefined;
          // The discuss glyph's title. A range preview only when the recorded start is on
          // the SAME side as this row (a cross-side shift-click starts a fresh line).
          let discussTitle = "";
          if (discussLineNo !== undefined) {
            if (
              rangeStart !== null &&
              rangeStart.side === discussSide &&
              rangeStart.line !== discussLineNo
            ) {
              const lo = Math.min(rangeStart.line, discussLineNo);
              const hi = Math.max(rangeStart.line, discussLineNo);
              discussTitle = `Discuss lines ${lo}-${hi} (shift-click), or this line`;
            } else {
              discussTitle = `Discuss line ${discussLineNo} (shift-click a second line for a range)`;
            }
          }
          const discussIsRangeStart =
            rangeStart !== null &&
            rangeStart.line === discussLineNo &&
            rangeStart.side === discussSide;
          const className = [
            "code-view-row",
            rowClass(row),
            isGlow ? "cv-glow" : "",
            isFocus ? "cv-focus" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              className={className}
              key={row.rawIndex}
              data-raw-index={row.rawIndex}
              data-side={row.side ?? undefined}
              data-file-line={row.fileLine ?? undefined}
              data-side-ordinal={row.sideOrdinal ?? undefined}
              data-occurrence={row.occurrenceId ?? undefined}
              data-mark={isGlow ? glowMarks.map((m) => m.mark.markId).join(" ") : undefined}
            >
              {gutterMarks && gutterMarks.length > 0 ? (
                <span
                  className="cv-gutter l3-hand"
                  data-l3="mark"
                  data-gutter-marks={gutterMarks.map((m) => m.mark.markId).join(" ")}
                  aria-hidden="true"
                  title="Orchestrator mark"
                >
                  ◇
                </span>
              ) : null}
              {/* The per-line discuss glyph (issue #36): plain-click opens a thread
                  on this line; shift-click extends a range from the last clicked
                  line. Only content rows with a real file line carry it — a meta/
                  header row has no line to anchor to. Hover-disclosed via CSS so the
                  gutter reads calm. It is one absolutely-positioned element, so it
                  cannot widen the row or reflow the code column. */}
              {onDiscuss && discussLineNo !== undefined && discussSide !== undefined ? (
                <button
                  type="button"
                  className="cv-discuss l3-hand"
                  data-cv-discuss={discussLineNo}
                  data-cv-discuss-side={discussSide}
                  data-range-start={discussIsRangeStart ? "" : undefined}
                  title={discussTitle}
                  aria-label={`Discuss line ${discussLineNo}`}
                  onClick={(event) => discussLine(discussLineNo, discussSide, event.shiftKey)}
                >
                  ◇
                </button>
              ) : null}
              <span className="code-view-ln">{row.fileLine ?? ""}</span>
              <code className="code-view-code">{renderCode(row, language, onSymbolClick)}</code>
              {/* The mark's card renders inline AT its span (its home row), not in a strip. */}
              {gutterMarks && renderMarkCard
                ? gutterMarks.map((placed) => (
                    <div
                      className="cv-mark-card"
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
