import type { AnchorSpan, DispositionType } from "@rennet/types";
import type { AuthoringAct, Granularity } from "../canvas/authoring";
import { DispositionBar } from "./disposition";

// The authoring affordance at EVERY altitude of the zoom ladder. Each row offers
// approve / request-change / comment / question; picking one emits an `AuthoringAct`
// the container resolves (via `authorDisposition`) into per-anchor L2 writes. A
// group act (cohort / roll-up) is ONE user act — that is the whole point.

/** The current target at each altitude; a row is disabled when its locator is absent. */
export interface GranularityContext {
  cohortKey?: string;
  /** Serves both `element` and `symbol` altitudes. */
  elementKey?: string;
  hunkId?: string;
  /** The line span, for `line` altitude (paired with `hunkId`). */
  span?: AnchorSpan;
}

interface Rung {
  granularity: Granularity;
  label: string;
  build(context: GranularityContext, type: DispositionType): AuthoringAct | null;
}

const LADDER: Rung[] = [
  {
    granularity: "line",
    label: "Line",
    build: (ctx, type) =>
      ctx.hunkId && ctx.span
        ? { granularity: "line", hunkId: ctx.hunkId, span: ctx.span, type }
        : null,
  },
  {
    granularity: "hunk",
    label: "Hunk",
    build: (ctx, type) => (ctx.hunkId ? { granularity: "hunk", hunkId: ctx.hunkId, type } : null),
  },
  {
    granularity: "symbol",
    label: "Symbol",
    build: (ctx, type) =>
      ctx.elementKey ? { granularity: "symbol", elementKey: ctx.elementKey, type } : null,
  },
  {
    granularity: "element",
    label: "Element",
    build: (ctx, type) =>
      ctx.elementKey ? { granularity: "element", elementKey: ctx.elementKey, type } : null,
  },
  {
    granularity: "cohort",
    label: "Cohort",
    build: (ctx, type) =>
      ctx.cohortKey ? { granularity: "cohort", cohortKey: ctx.cohortKey, type } : null,
  },
  {
    granularity: "rollup",
    label: "Roll-up",
    // The whole changeset — always available, no locator required.
    build: (_ctx, type) => ({ granularity: "rollup", type }),
  },
];

export function GranularityAuthor({
  context = {},
  onAuthor,
}: {
  context?: GranularityContext;
  onAuthor(act: AuthoringAct): void;
}) {
  return (
    <fieldset className="granularity-author" aria-label="Author at any granularity">
      {LADDER.map((rung) => {
        const available = rung.build(context, "approve") !== null;
        return (
          <div
            className={`granularity-rung granularity-${rung.granularity}`}
            key={rung.granularity}
          >
            <span className="granularity-label">{rung.label}</span>
            {available ? (
              <DispositionBar
                scopeLabel={rung.label}
                compact
                onDisposition={(type) => {
                  const act = rung.build(context, type);
                  if (act) onAuthor(act);
                }}
              />
            ) : (
              <span
                className="granularity-unavailable"
                title={`Select a ${rung.label.toLowerCase()} first`}
              >
                —
              </span>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
