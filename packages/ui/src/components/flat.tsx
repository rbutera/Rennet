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
      <div className="canvas-toolbar">
        <span className="canvas-coverage">{elements.length} items</span>
        <DispositionBar
          scopeLabel="whole roll-up"
          onDisposition={(type) => onApproveScope({ kind: "rollup" }, type)}
        />
      </div>
      {elements.length === 0 ? (
        <p className="canvas-empty">This angle is empty.</p>
      ) : (
        <ol className="flat-elements">
          {elements.map((element) => {
            const chunkId = anchorChunkId(canvas, element.anchor);
            const isBlast = chunkId !== undefined && painted.has(chunkId);
            const blastReason = chunkId !== undefined ? reasons.get(chunkId) : undefined;
            return (
              <li className={`flat-element ${isBlast ? "is-blast" : ""}`} key={element.elementKey}>
                <button
                  type="button"
                  className="flat-element-select"
                  onClick={() => onSelectElement(element.elementKey)}
                >
                  <span className="flat-element-kind">{element.kind}</span>
                  <span className="flat-element-title">{element.title}</span>
                  {isBlast ? (
                    <span
                      className="flat-element-blast"
                      title={blastReason ?? "In the blast radius"}
                    >
                      blast
                    </span>
                  ) : null}
                </button>
                {/* The one-line reason rendered beside the amber mark (issue #35). */}
                {isBlast && blastReason ? (
                  <p className="flat-element-blast-reason">{blastReason}</p>
                ) : null}
                <DispositionBar
                  scopeLabel={element.title}
                  compact
                  onDisposition={(type) =>
                    onApproveScope({ kind: "anchor", elementKey: element.elementKey }, type)
                  }
                />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
