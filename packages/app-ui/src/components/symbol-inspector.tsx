import { ChevronRight } from "lucide-react";
import {
  basename,
  groupReferencesByFile,
  type SymbolDefinitionRow,
  type SymbolInspection,
  type SymbolLookupSection,
  type SymbolNeighbors,
  type SymbolTier,
} from "../canvas/symbol";
import { Icon } from "./icon";

// ─────────────────────────────────────────────────────────────────────────────
// SymbolInspector — the in-app symbol preview (Rai, wireframes #8 + #11).
//
// A plain click on a symbol opens this as a floating PEEK: where it is DEFINED
// (go-to-definition), where it is USED (find-references / blast radius), and an
// "open in editor" jump on every site. The data is Rennet's OWN model-free symbolic
// surface, so the panel is honest about its scope, and an unavailable snapshot is a
// first-class state, never a silent blank.
//
// Two #11 additions, both surfacing what the lookup ALREADY knows — never inventing:
//   • a TIER CHIP per section — `exact` (a single structural declaration) vs `guess`
//     (a textual reference match, or several ambiguous declarations + a candidate
//     count). The LSP-honesty doctrine made a discrete signal; a textual guess can
//     never read `exact`.
//   • PIN → the peek docks into the rail as a tiny code-browser: a breadcrumb chain,
//     back / forward, and the definition file's REAL sibling symbols as clickable
//     rungs (clicking re-runs the lookup). The navigation stays in the rail so the
//     diff never moves.
// ─────────────────────────────────────────────────────────────────────────────

export interface SymbolInspectorProps {
  /** The inspected name (shown while the lookup is still in flight, too). */
  name: string;
  /** True while the lookup port is resolving — the panel shows a calm pending line. */
  pending?: boolean;
  /** A lookup that rejected outright (transport/host error), distinct from an `unavailable` section. */
  error?: string;
  /** The resolved answer; absent while pending or on error. */
  inspection?: SymbolInspection;
  /** Open a site in the reviewer's editor. Absent ⇒ sites are shown but not openable. */
  onOpenInEditor?: (path: string, line: number) => void;
  /** Close the inspector. */
  onClose(): void;

  // ── Pin + mini-browser navigation (#11). All optional: the plain floating peek
  //    renders with none of these, so existing/simple callers are unaffected. ──

  /** Whether the inspector is docked into the rail as the persistent mini-browser. */
  pinned?: boolean;
  /** Toggle pinned ⇄ floating. Present ⇒ a Pin control is shown in the header. */
  onTogglePin?: () => void;
  /** The navigation history (names), oldest first — the breadcrumb chain. */
  breadcrumb?: readonly string[];
  /** Index of the currently-shown crumb within {@link breadcrumb}. */
  cursor?: number;
  /** Jump to a crumb by index (re-shows that name). */
  onCrumb?: (index: number) => void;
  /** Step back one crumb. */
  onBack?: () => void;
  /** Step forward one crumb. */
  onForward?: () => void;
  /** Whether a back step is available. */
  canBack?: boolean;
  /** Whether a forward step is available. */
  canForward?: boolean;
  /** Inspect another name from inside the panel (a neighbour rung or a crumb). */
  onNavigate?: (name: string) => void;
}

// Shared chrome recipes, repeated across the three lookup sections. Each keeps its
// semantic class as the first token (tests select on those) and its role is sans/chrome.
const SECTION = "symbol-section mt-3";
const SECTION_HEAD =
  "symbol-section-head mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint";
const SECTION_NOTE = "text-2xs text-ink-faint mt-1";
const SITE_LIST = "list-none m-0 p-0 flex flex-col gap-1.5";

/**
 * The honest confidence chip (#11). `exact` = a single structural declaration;
 * `guess` = a textual reference match, or several ambiguous declarations (with the
 * candidate count). The method (`structural` / `textual`) rides alongside so the
 * chip never overclaims a TypeScript-LSP answer — Rennet has none.
 */
function TierChip({ tier }: { tier?: SymbolTier }) {
  if (!tier) return null;
  // `candidates` lives only on the guess/structural arm of the discriminated union.
  const candidates = tier.kind === "guess" && tier.method === "structural" ? tier.candidates : null;
  const title =
    tier.method === "textual"
      ? "Name-based textual match: same-named symbols and mentions in comments or strings are included, so this is a guess, not a resolved reference."
      : tier.kind === "exact"
        ? "Resolved to a single exported declaration by structural extraction (not a TypeScript LSP — exported top-level symbols only)."
        : `Structural extraction found ${candidates ?? 0} declarations of this name; the index cannot pick one, so these are candidates.`;
  // exact = gold wash + gold ink; guess = the fuller gold surface with plain ink
  // (both live on the one gold family — review-blue and decision-amber are retired).
  const tone =
    tier.kind === "exact"
      ? "border-accent-line bg-accent-soft text-accent"
      : "border-accent-line bg-accent-surface text-ink";
  return (
    <span
      className={`symbol-tier symbol-tier--${tier.kind} ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 align-middle font-mono text-2xs normal-case tracking-normal ${tone}`}
      data-tier={tier.kind}
      data-method={tier.method}
      title={title}
    >
      <span className="symbol-tier-kind font-semibold">{tier.kind}</span>
      <span
        className={`symbol-tier-method ${tier.kind === "guess" ? "opacity-75" : "text-ink-faint"}`}
      >
        {tier.method}
      </span>
      {candidates !== null ? (
        <span className="symbol-tier-candidates border-l border-current pl-1.5 opacity-80">
          {candidates} candidates
        </span>
      ) : null}
    </span>
  );
}

function OpenSite({
  path,
  line,
  onOpenInEditor,
}: {
  path: string;
  line: number;
  onOpenInEditor?: (path: string, line: number) => void;
}) {
  const label = `${basename(path)}:${line}`;
  if (!onOpenInEditor) {
    return (
      <span className="symbol-site-loc font-mono text-sm text-ink" title={`${path}:${line}`}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="symbol-site-open cursor-pointer border-0 bg-transparent p-0 font-mono text-sm text-accent underline-offset-2 hover:underline"
      title={`Open ${path}:${line} in your editor`}
      onClick={() => onOpenInEditor(path, line)}
    >
      {label}
    </button>
  );
}

function DefinitionSection({
  section,
  onOpenInEditor,
}: {
  section: SymbolLookupSection<SymbolDefinitionRow>;
  onOpenInEditor?: (path: string, line: number) => void;
}) {
  if (section.status === "unavailable") {
    return (
      <div className={SECTION} data-section="definition">
        <p className={SECTION_HEAD}>Defined in</p>
        <p className={`symbol-unavailable ${SECTION_NOTE}`} role="status">
          Couldn't resolve definitions — {section.reason}
        </p>
      </div>
    );
  }
  if (section.sites.length === 0) {
    return (
      <div className={SECTION} data-section="definition">
        <p className={SECTION_HEAD}>Defined in</p>
        <p className={`symbol-empty ${SECTION_NOTE}`}>
          No exported definition in the reviewed range. Go-to-definition covers exported top-level
          symbols in the committed review range (base..head), not uncommitted local edits.
        </p>
      </div>
    );
  }
  return (
    <div className={SECTION} data-section="definition">
      <p className={SECTION_HEAD}>
        Defined in
        <TierChip tier={section.tier} />
      </p>
      <ul className={`symbol-sites ${SITE_LIST}`}>
        {section.sites.map((site) => (
          <li className="symbol-site flex items-center gap-2" key={`${site.path}:${site.line}`}>
            <span className="symbol-site-kind rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-2xs text-accent">
              {site.kind}
            </span>
            <OpenSite path={site.path} line={site.line} onOpenInEditor={onOpenInEditor} />
            {site.scope ? (
              <span className="symbol-site-scope font-mono text-2xs text-ink-faint">
                {site.scope}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReferencesSection({
  section,
  onOpenInEditor,
}: {
  section: SymbolInspection["references"];
  onOpenInEditor?: (path: string, line: number) => void;
}) {
  if (section.status === "unavailable") {
    return (
      <div className={SECTION} data-section="references">
        <p className={SECTION_HEAD}>Used in</p>
        <p className={`symbol-unavailable ${SECTION_NOTE}`} role="status">
          Couldn't resolve references — {section.reason}
        </p>
      </div>
    );
  }
  const groups = groupReferencesByFile(section.sites);
  if (groups.length === 0) {
    return (
      <div className={SECTION} data-section="references">
        <p className={SECTION_HEAD}>Used in</p>
        <p className={`symbol-empty ${SECTION_NOTE}`}>No other occurrences found.</p>
      </div>
    );
  }
  return (
    <div className={SECTION} data-section="references">
      <p className={SECTION_HEAD}>
        Used in{" "}
        <span className="symbol-ref-count normal-case tracking-normal">{groups.length} files</span>
        <TierChip tier={section.tier} />
      </p>
      <ul className="symbol-ref-groups list-none m-0 p-0 flex flex-col gap-1.5">
        {groups.map((group) => (
          <li className="symbol-ref-group flex items-baseline gap-2 flex-wrap" key={group.path}>
            <span className="symbol-ref-file font-mono text-2xs text-ink-faint" title={group.path}>
              {basename(group.path)}
            </span>
            <span className="symbol-ref-lines inline-flex gap-2 flex-wrap">
              {group.lines.map((line) => (
                <OpenSite
                  key={line}
                  path={group.path}
                  line={line}
                  onOpenInEditor={onOpenInEditor}
                />
              ))}
            </span>
          </li>
        ))}
      </ul>
      {section.truncated ? (
        <p className={`symbol-truncated ${SECTION_NOTE}`}>More occurrences exist than shown.</p>
      ) : null}
      <p className={`symbol-scope-note ${SECTION_NOTE}`}>
        Find-references is name-based and textual — same-named symbols and mentions in comments or
        strings are included.
      </p>
    </div>
  );
}

/**
 * The pinned mini-browser's clickable rungs: the sibling top-level symbols of the
 * definition's file, from the real `context.overview`. Clicking one re-runs the
 * lookup for that name — walking declaration→declaration while the diff stays put.
 * The currently-inspected name is marked, not a link.
 */
function NeighborsSection({
  neighbors,
  current,
  onNavigate,
}: {
  neighbors: SymbolNeighbors;
  current: string;
  onNavigate?: (name: string) => void;
}) {
  if (neighbors.symbols.length === 0) return null;
  return (
    <div className={SECTION} data-section="neighbors">
      <p className={SECTION_HEAD}>
        In {basename(neighbors.path)}{" "}
        <span className="symbol-ref-count normal-case tracking-normal">symbols</span>
      </p>
      <ul className="symbol-neighbors list-none m-0 p-0 flex flex-wrap gap-2">
        {neighbors.symbols.map((symbol) => {
          const isCurrent = symbol.name === current;
          return (
            <li key={`${symbol.name}:${symbol.line}`}>
              <button
                type="button"
                className={`symbol-neighbor inline-flex items-center gap-1.5 rounded-chip border px-2 py-1 font-mono text-2xs cursor-pointer disabled:cursor-default ${
                  isCurrent
                    ? "symbol-neighbor--current border-accent-line bg-accent-soft text-accent"
                    : "border-line bg-raised text-ink hover:border-accent-line"
                }${!isCurrent && !onNavigate ? " opacity-70" : ""}`}
                aria-current={isCurrent ? "true" : undefined}
                disabled={!onNavigate || isCurrent}
                title={`Inspect ${symbol.name} (${symbol.kind}) · ${basename(neighbors.path)}:${symbol.line}`}
                onClick={() => onNavigate?.(symbol.name)}
              >
                <span
                  className={`symbol-neighbor-kind text-2xs ${isCurrent ? "text-inherit" : "text-ink-faint"}`}
                >
                  {symbol.kind}
                </span>
                <span className="symbol-neighbor-name">{symbol.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The breadcrumb chain of inspected names — each crumb re-shows that name. */
function Breadcrumb({
  names,
  cursor,
  onCrumb,
}: {
  names: readonly string[];
  cursor: number;
  onCrumb?: (index: number) => void;
}) {
  return (
    <nav
      className="symbol-crumb mt-2.5 flex flex-wrap items-center gap-1"
      aria-label="Inspector history"
    >
      {names.map((name, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a breadcrumb is positional history — the same symbol legitimately recurs at different positions, so the index IS the crumb's identity.
        <span className="symbol-crumb-item inline-flex items-center gap-1" key={`${name}:${index}`}>
          {index > 0 ? (
            <Icon
              icon={ChevronRight}
              className="symbol-crumb-sep size-2.5 shrink-0 text-muted-foreground/50"
            />
          ) : null}
          <button
            type="button"
            className={`symbol-crumb-name border-0 bg-transparent px-0.5 py-px font-mono text-2xs ${
              index === cursor
                ? "symbol-crumb-name--current text-ink font-semibold cursor-default"
                : "text-ink-faint hover:text-ink hover:underline hover:underline-offset-2 cursor-pointer"
            }`}
            aria-current={index === cursor ? "true" : undefined}
            disabled={!onCrumb || index === cursor}
            onClick={() => onCrumb?.(index)}
          >
            {name}
          </button>
        </span>
      ))}
    </nav>
  );
}

/**
 * The inspector panel. Renders the pending line while a lookup is in flight, an
 * error line if the port rejected, and otherwise the definition + references
 * sections — each honest about unavailable vs empty, each carrying a tier chip.
 * When {@link SymbolInspectorProps.pinned}, it docks as the mini-browser: a
 * breadcrumb chain, back / forward, and the definition file's clickable neighbours.
 */
export function SymbolInspector({
  name,
  pending = false,
  error,
  inspection,
  onOpenInEditor,
  onClose,
  pinned = false,
  onTogglePin,
  breadcrumb,
  cursor = 0,
  onCrumb,
  onBack,
  onForward,
  canBack = false,
  canForward = false,
  onNavigate,
}: SymbolInspectorProps) {
  const showCrumbs = pinned && breadcrumb !== undefined && breadcrumb.length > 0;
  return (
    <aside
      className={`symbol-inspector rounded-surface border border-line bg-surface p-4 font-sans text-sm text-ink ${
        pinned ? "symbol-inspector--pinned mt-0" : "mt-2.5"
      }`}
      aria-label={`Symbol: ${name}`}
      data-pinned={pinned ? "true" : undefined}
    >
      <header className="symbol-inspector-head flex items-baseline gap-2">
        <span className="symbol-inspector-eyebrow text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          {pinned ? "INSPECTOR · PINNED" : "SYMBOL"}
        </span>
        <span className="symbol-inspector-name font-mono text-base text-ink">{name}</span>
        {onTogglePin ? (
          <button
            type="button"
            className={`symbol-inspector-pin rounded-full border px-2.5 py-0.5 font-sans text-xs cursor-pointer ${
              pinned
                ? "symbol-inspector-pin--on border-accent-line bg-accent-soft text-accent"
                : "border-line-strong bg-transparent text-ink-faint hover:text-ink"
            }`}
            aria-pressed={pinned}
            title={pinned ? "Unpin from the rail" : "Pin to the rail"}
            onClick={onTogglePin}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        ) : null}
        <button
          type="button"
          className="symbol-inspector-close ml-auto cursor-pointer border-0 bg-transparent text-lg leading-none text-ink-faint hover:text-ink"
          aria-label="Close symbol inspector"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {pinned ? (
        <div className="symbol-nav mt-2.5 flex gap-2">
          <button
            type="button"
            className="symbol-nav-btn cursor-pointer rounded-control border border-line-strong bg-transparent px-3 py-1.5 font-sans text-xs text-ink hover:border-accent-line disabled:cursor-default disabled:text-ink-faint disabled:opacity-50"
            aria-label="Back"
            disabled={!onBack || !canBack}
            onClick={onBack}
          >
            ‹ back
          </button>
          <button
            type="button"
            className="symbol-nav-btn cursor-pointer rounded-control border border-line-strong bg-transparent px-3 py-1.5 font-sans text-xs text-ink hover:border-accent-line disabled:cursor-default disabled:text-ink-faint disabled:opacity-50"
            aria-label="Forward"
            disabled={!onForward || !canForward}
            onClick={onForward}
          >
            fwd ›
          </button>
        </div>
      ) : null}
      {showCrumbs ? <Breadcrumb names={breadcrumb} cursor={cursor} onCrumb={onCrumb} /> : null}
      {pending ? (
        <p className={`symbol-pending ${SECTION_NOTE}`} role="status">
          Looking up {name}…
        </p>
      ) : error ? (
        <p className="symbol-error mt-1 text-2xs text-danger" role="alert">
          {error}
        </p>
      ) : inspection ? (
        <>
          <DefinitionSection section={inspection.definition} onOpenInEditor={onOpenInEditor} />
          <ReferencesSection section={inspection.references} onOpenInEditor={onOpenInEditor} />
          {/* The sibling mini-browser is a PINNED-only affordance (wireframes #11): the
              floating quick peek stays a peek, the rail is where you navigate deeper. */}
          {pinned && inspection.neighbors ? (
            <NeighborsSection
              neighbors={inspection.neighbors}
              current={name}
              onNavigate={onNavigate}
            />
          ) : null}
        </>
      ) : null}
      {pinned ? (
        <p className="symbol-pinned-note mt-3 font-mono text-2xs text-ink-faint">
          navigation stays here · the diff never moves
        </p>
      ) : null}
    </aside>
  );
}
