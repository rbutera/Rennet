import {
  basename,
  groupReferencesByFile,
  type SymbolDefinitionRow,
  type SymbolInspection,
  type SymbolLookupSection,
  type SymbolNeighbors,
  type SymbolTier,
} from "../canvas/symbol";

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
  return (
    <span
      className={`symbol-tier symbol-tier--${tier.kind}`}
      data-tier={tier.kind}
      data-method={tier.method}
      title={title}
    >
      <span className="symbol-tier-kind">{tier.kind}</span>
      <span className="symbol-tier-method">{tier.method}</span>
      {candidates !== null ? (
        <span className="symbol-tier-candidates">{candidates} candidates</span>
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
      <span className="symbol-site-loc" title={`${path}:${line}`}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="symbol-site-open"
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
      <div className="symbol-section" data-section="definition">
        <p className="symbol-section-head">Defined in</p>
        <p className="symbol-unavailable" role="status">
          Couldn't resolve definitions — {section.reason}
        </p>
      </div>
    );
  }
  if (section.sites.length === 0) {
    return (
      <div className="symbol-section" data-section="definition">
        <p className="symbol-section-head">Defined in</p>
        <p className="symbol-empty">
          No exported definition in the reviewed range. Go-to-definition covers exported top-level
          symbols in the committed review range (base..head), not uncommitted local edits.
        </p>
      </div>
    );
  }
  return (
    <div className="symbol-section" data-section="definition">
      <p className="symbol-section-head">
        Defined in
        <TierChip tier={section.tier} />
      </p>
      <ul className="symbol-sites">
        {section.sites.map((site) => (
          <li className="symbol-site" key={`${site.path}:${site.line}`}>
            <span className="symbol-site-kind">{site.kind}</span>
            <OpenSite path={site.path} line={site.line} onOpenInEditor={onOpenInEditor} />
            {site.scope ? <span className="symbol-site-scope">{site.scope}</span> : null}
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
      <div className="symbol-section" data-section="references">
        <p className="symbol-section-head">Used in</p>
        <p className="symbol-unavailable" role="status">
          Couldn't resolve references — {section.reason}
        </p>
      </div>
    );
  }
  const groups = groupReferencesByFile(section.sites);
  if (groups.length === 0) {
    return (
      <div className="symbol-section" data-section="references">
        <p className="symbol-section-head">Used in</p>
        <p className="symbol-empty">No other occurrences found.</p>
      </div>
    );
  }
  return (
    <div className="symbol-section" data-section="references">
      <p className="symbol-section-head">
        Used in <span className="symbol-ref-count">{groups.length} files</span>
        <TierChip tier={section.tier} />
      </p>
      <ul className="symbol-ref-groups">
        {groups.map((group) => (
          <li className="symbol-ref-group" key={group.path}>
            <span className="symbol-ref-file" title={group.path}>
              {basename(group.path)}
            </span>
            <span className="symbol-ref-lines">
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
        <p className="symbol-truncated">More occurrences exist than shown.</p>
      ) : null}
      <p className="symbol-scope-note">
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
    <div className="symbol-section" data-section="neighbors">
      <p className="symbol-section-head">
        In {basename(neighbors.path)} <span className="symbol-ref-count">symbols</span>
      </p>
      <ul className="symbol-neighbors">
        {neighbors.symbols.map((symbol) => {
          const isCurrent = symbol.name === current;
          return (
            <li key={`${symbol.name}:${symbol.line}`}>
              <button
                type="button"
                className={`symbol-neighbor${isCurrent ? " symbol-neighbor--current" : ""}`}
                aria-current={isCurrent ? "true" : undefined}
                disabled={!onNavigate || isCurrent}
                title={`Inspect ${symbol.name} (${symbol.kind}) · ${basename(neighbors.path)}:${symbol.line}`}
                onClick={() => onNavigate?.(symbol.name)}
              >
                <span className="symbol-neighbor-kind">{symbol.kind}</span>
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
    <nav className="symbol-crumb" aria-label="Inspector history">
      {names.map((name, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a breadcrumb is positional history — the same symbol legitimately recurs at different positions, so the index IS the crumb's identity.
        <span className="symbol-crumb-item" key={`${name}:${index}`}>
          {index > 0 ? (
            <span className="symbol-crumb-sep" aria-hidden="true">
              ›
            </span>
          ) : null}
          <button
            type="button"
            className={`symbol-crumb-name${index === cursor ? " symbol-crumb-name--current" : ""}`}
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
      className={`symbol-inspector${pinned ? " symbol-inspector--pinned" : ""}`}
      aria-label={`Symbol: ${name}`}
      data-pinned={pinned ? "true" : undefined}
    >
      <header className="symbol-inspector-head">
        <span className="symbol-inspector-eyebrow">{pinned ? "INSPECTOR · PINNED" : "SYMBOL"}</span>
        <span className="symbol-inspector-name">{name}</span>
        {onTogglePin ? (
          <button
            type="button"
            className={`symbol-inspector-pin${pinned ? " symbol-inspector-pin--on" : ""}`}
            aria-pressed={pinned}
            title={pinned ? "Unpin from the rail" : "Pin to the rail"}
            onClick={onTogglePin}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        ) : null}
        <button
          type="button"
          className="symbol-inspector-close"
          aria-label="Close symbol inspector"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {pinned ? (
        <div className="symbol-nav">
          <button
            type="button"
            className="symbol-nav-btn"
            aria-label="Back"
            disabled={!onBack || !canBack}
            onClick={onBack}
          >
            ‹ back
          </button>
          <button
            type="button"
            className="symbol-nav-btn"
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
        <p className="symbol-pending" role="status">
          Looking up {name}…
        </p>
      ) : error ? (
        <p className="symbol-error" role="alert">
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
        <p className="symbol-pinned-note">navigation stays here · the diff never moves</p>
      ) : null}
    </aside>
  );
}
