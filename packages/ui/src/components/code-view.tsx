import { type WindowRange, windowRows } from "../canvas/logic";

// ─────────────────────────────────────────────────────────────────────────────
// CodeView — the ONLY diff surface (R16). A windowed renderer: at any scroll
// position it renders a slice around the viewport, so the DOM node count stays
// inside MAX_RENDERED_NODES no matter how long the diff is. The Pierre spike
// measured 97,139 nodes / 493ms for a naive full render; windowing is the
// discipline that keeps a large diff cheap.
//
// Doctrine: the code body is fully opaque (`--code-bg`, no wallpaper through it),
// the header strip is glass chrome. Annotation-hosted state lives OUTSIDE the
// recycled rows (in the canvas L3 layer / view store), so nothing is lost when a
// row scrolls out and back (the Pierre annotation-recycling caveat).
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
}

function lineKind(text: string): "add" | "del" | "ctx" {
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  return "ctx";
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
}: CodeViewProps) {
  const lines = diff.length === 0 ? [] : diff.split("\n");
  const range: WindowRange = renderAll
    ? { start: 0, end: lines.length }
    : windowRows({ total: lines.length, rowHeight, viewportHeight, scrollTop, overscan });
  const visible = lines.slice(range.start, range.end);

  return (
    <section className="code-view" aria-label={`Diff of ${path}`}>
      <header className="code-view-head">
        <span className="code-view-path">{path}</span>
        <span className="code-view-tier" title="Definition tier">
          {tier}
        </span>
      </header>
      <div
        className="code-view-scroll"
        style={{ height: `${viewportHeight}px` }}
        data-total-rows={lines.length}
        data-rendered-rows={visible.length}
      >
        {/* A spacer preserves scroll height for the rows above the window. */}
        <div className="code-view-spacer" style={{ height: `${range.start * rowHeight}px` }} />
        {visible.map((text, index) => {
          const lineNumber = range.start + index + 1;
          return (
            <div className={`code-view-row cv-${lineKind(text)}`} key={lineNumber}>
              <span className="code-view-ln">{lineNumber}</span>
              <code className="code-view-code">{text}</code>
            </div>
          );
        })}
        <div
          className="code-view-spacer"
          style={{ height: `${(lines.length - range.end) * rowHeight}px` }}
        />
      </div>
    </section>
  );
}
