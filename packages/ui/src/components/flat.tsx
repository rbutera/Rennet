import type { Canvas, DispositionType } from "@rennet/types";
import { type ApprovalScope, blastPaint } from "../canvas/logic";
import { DispositionBar } from "./disposition";

// The flat canvases (sequence / spec / claims / noise): a single ordered list of
// elements, each disposable. `claims` renders empty-but-honest when no claim
// documents have been admitted, rather than pretending coverage exists.

const EMPTY_COPY: Partial<Record<string, string>> = {
  claims: "No claims have been admitted yet. This angle is empty, not unchecked.",
};

export function FlatCanvas({
  canvas,
  onApproveScope,
  onSelectElement,
}: {
  canvas: Canvas;
  onApproveScope(scope: ApprovalScope, type: DispositionType): void;
  onSelectElement(elementKey: string): void;
}) {
  const painted = blastPaint(canvas);
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
        <p className="canvas-empty">{EMPTY_COPY[canvas.angle] ?? "This angle is empty."}</p>
      ) : (
        <ol className="flat-elements">
          {elements.map((element) => (
            <li
              className={`flat-element ${painted.has(element.anchor) ? "is-blast" : ""}`}
              key={element.elementKey}
            >
              <button
                type="button"
                className="flat-element-select"
                onClick={() => onSelectElement(element.elementKey)}
              >
                <span className="flat-element-kind">{element.kind}</span>
                <span className="flat-element-title">{element.title}</span>
              </button>
              <DispositionBar
                scopeLabel={element.title}
                compact
                onDisposition={(type) =>
                  onApproveScope({ kind: "anchor", elementKey: element.elementKey }, type)
                }
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
