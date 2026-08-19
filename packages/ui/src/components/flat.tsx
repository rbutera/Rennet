import type { Canvas, DispositionType } from "@rennet/types";
import {
  type ApprovalScope,
  anchorChunkId,
  blastReasonsByChunk,
  paintedChunkIds,
} from "../canvas/logic";
import { DispositionBar } from "./disposition";

// The flat canvases (sequence / spec / noise): a single ordered list of elements,
// each disposable. An empty flat canvas renders honestly empty rather than
// pretending coverage exists.

export function FlatCanvas({
  canvas,
  overlayOn,
  onApproveScope,
  onSelectElement,
}: {
  canvas: Canvas;
  /**
   * The blast-radius overlay toggle (issue #35). Amber paint FOLLOWS the toggle,
   * exactly like the not-assessed chips: off ⇒ no amber, so a reviewer who has not
   * asked for blast radius never sees an unlabelled amber mark whose caveat is
   * hidden. On ⇒ amber + the not-assessed chips together.
   */
  overlayOn: boolean;
  onApproveScope(scope: ApprovalScope, type: DispositionType): void;
  onSelectElement(elementKey: string): void;
}) {
  // Resolve the overlay through the SUBSTRATE the same way DecisionsCanvas does:
  // the deterministic signals target `rennet:file/<path>`, which never equals an
  // element's `rennet:chunk/<id>` anchor — so a raw `blastPaint(canvas).has(anchor)`
  // matched nothing and the sequence lens painted no amber (#F3). `paintedChunkIds`
  // maps file targets onto the substrate chunks that cover them; an element is amber
  // when its chunk is painted, with the covering chunk's one-line reason beside it.
  const painted = overlayOn ? paintedChunkIds(canvas) : new Set<string>();
  const reasons = overlayOn ? blastReasonsByChunk(canvas) : new Map<string, string>();
  const elements = canvas.layers.analysis.elements;
  return (
    <div className={`flat-canvas flat-${canvas.angle}`}>
      <div className="canvas-toolbar mb-3.5 flex items-center justify-between gap-4 border-b border-line pb-2.5">
        <span className="canvas-coverage text-sm font-semibold text-ink">
          {elements.length} items
        </span>
        <DispositionBar
          scopeLabel="whole roll-up"
          onDisposition={(type) => onApproveScope({ kind: "rollup" }, type)}
        />
      </div>
      {elements.length === 0 ? (
        <p className="canvas-empty px-1 py-5 italic text-ink-faint">This angle is empty.</p>
      ) : (
        <ol className="flat-elements m-0 list-none p-0">
          {elements.map((element) => {
            const chunkId = anchorChunkId(canvas, element.anchor);
            const isBlast = chunkId !== undefined && painted.has(chunkId);
            const blastReason = chunkId !== undefined ? reasons.get(chunkId) : undefined;
            return (
              <li
                className={`flat-element group mb-2 flex flex-wrap items-center justify-between gap-3 rounded-surface border px-3.5 py-2.5 ${isBlast ? "is-blast border-accent-line bg-accent-surface" : "border-line bg-surface"}`}
                key={element.elementKey}
              >
                <button
                  type="button"
                  className="flat-element-select flex cursor-pointer items-baseline gap-2.5 border-0 bg-transparent text-left text-ink"
                  onClick={() => onSelectElement(element.elementKey)}
                >
                  <span className="flat-element-kind text-2xs font-bold uppercase tracking-wide text-ink-faint">
                    {element.kind}
                  </span>
                  <span className="flat-element-title">{element.title}</span>
                  {isBlast ? (
                    <span
                      className="flat-element-blast text-2xs font-bold uppercase tracking-wide text-ink"
                      title={blastReason ?? "In the blast radius"}
                    >
                      blast
                    </span>
                  ) : null}
                </button>
                {/* The one-line reason rendered beside the gold blast mark (issue #35). */}
                {isBlast && blastReason ? (
                  <p className="flat-element-blast-reason m-0 basis-full text-sm text-ink">
                    {blastReason}
                  </p>
                ) : null}
                {/* Calm roll-up (#62): the per-row cluster stays in the DOM + tab order,
                    revealed on hover/focus so the surface reads calm, not a dense grid. */}
                <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
                  <DispositionBar
                    scopeLabel={element.title}
                    compact
                    onDisposition={(type) =>
                      onApproveScope({ kind: "anchor", elementKey: element.elementKey }, type)
                    }
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
