import {
  basename,
  groupReferencesByFile,
  type SymbolDefinitionRow,
  type SymbolInspection,
  type SymbolLookupSection,
} from "../canvas/symbol";

// ─────────────────────────────────────────────────────────────────────────────
// SymbolInspector — the in-app symbol preview (Rai, wireframes #8).
//
// Click a symbol in the diff and this panel opens beside the code: where it is
// DEFINED (go-to-definition), where it is USED (find-references / blast radius),
// and an "open in editor" jump on every site. The data is Rennet's OWN model-free
// symbolic surface, so the panel is honest about its scope — exported symbols only
// for definitions, name-based/textual for references — and an unavailable snapshot
// is a first-class state, never a silent blank. No inline-in-the-code weirdness:
// the code stays the code, the inspector is its own surface.
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
          No exported definition found. Go-to-definition is over exported top-level symbols only.
        </p>
      </div>
    );
  }
  return (
    <div className="symbol-section" data-section="definition">
      <p className="symbol-section-head">Defined in</p>
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
 * The inspector panel. Renders the pending line while a lookup is in flight, an
 * error line if the port rejected, and otherwise the definition + references
 * sections — each honest about unavailable vs empty.
 */
export function SymbolInspector({
  name,
  pending = false,
  error,
  inspection,
  onOpenInEditor,
  onClose,
}: SymbolInspectorProps) {
  return (
    <aside className="symbol-inspector" aria-label={`Symbol: ${name}`}>
      <header className="symbol-inspector-head">
        <span className="symbol-inspector-eyebrow">SYMBOL</span>
        <span className="symbol-inspector-name">{name}</span>
        <button
          type="button"
          className="symbol-inspector-close"
          aria-label="Close symbol inspector"
          onClick={onClose}
        >
          ×
        </button>
      </header>
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
        </>
      ) : null}
    </aside>
  );
}
