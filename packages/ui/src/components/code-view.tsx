import { parseAnchor } from "@rennet/protocol";
import type { DispositionType } from "@rennet/types";
import { type ReactNode, useEffect, useState } from "react";
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
  /** Occurrence id(s) for the diff's hunks; a single-occurrence element view passes one. */
  occurrenceIds?: readonly string[] | string;
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
  occurrenceIds,
  marks,
  renderMarkCard,
  focusAnchor,
  onPlacement,
  onDispose,
  counterpart,
  onSymbolClick,
}: CodeViewProps) {
  // The live scroll position: seeded from the prop (which the node-count control
  // test and any programmatic positioning inject), then advanced by the user's
  // own scrolling so the window tracks the viewport instead of freezing at row 0.
  const [scroll, setScroll] = useState(scrollTop);

  // Language for syntax highlighting, inferred once from the path extension.
  // Unknown/absent extension → null → plain text (fail-closed, no fabricated colour).
  const language: LanguageId | null = detectLanguage(path);

  // The registry + placement are computed over the FULL diff, never the window —
  // so a mark's home row is a fixed function of (diff, occurrenceIds, marks) and
  // cannot move when a row recycles. Windowing only chooses which rows to paint.
  const registry = buildRowRegistry({ diff, occurrenceIds });
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
      </header>
      <div
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
