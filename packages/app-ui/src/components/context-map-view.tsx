import type {
  KnowledgeDispositionResult,
  KnowledgeSetPayload,
  KnowledgeStatementPayload,
  ProjectContextAskResult,
  ProjectContextMapResult,
  ProjectMapPayload,
  RennetBridge,
} from "@rennet/protocol";
import { ArrowLeft, Check, X } from "lucide-react";
import {
  type FormEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildScopes,
  knowledgeForSelection,
  type ScopeNode,
  type Selection,
} from "../context-map/model";
import { messageFrom } from "../lib/message-from";
import { Icon } from "./icon";

const short = (name: string) => name.replace("@rennet/", "");

type AskTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "orchestrator"; result: ProjectContextAskResult };

type LoadState =
  | { kind: "loading" }
  | { kind: "absent"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "ok"; map: ProjectMapPayload; knowledge: KnowledgeSetPayload | null };

/**
 * The Context Map surface (change add-context-map-view).
 *
 * A per-project view of the Repo Map: the deterministic structure (scopes → dirs →
 * files, with dependency edges) on the left, the model-derived knowledge layer in the
 * middle, and a project-scoped orchestrator ask rail on the right. Structure and
 * knowledge are read verbatim over `project.contextMap`; a knowledge statement is
 * confirmed/rejected through `project.knowledgeDisposition`; the rail speaks
 * `project.contextAsk` — a real turn through the user's own harness. Nothing here is
 * fabricated: an absent snapshot is stated plainly, and the ask rail's unanswered and
 * failed states are first-class.
 */
export function ContextMapView({
  bridge,
  projectId,
  onBack,
}: {
  bridge: RennetBridge;
  projectId: string;
  onBack(): void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    bridge
      .invoke("project.contextMap", { projectId })
      .then((result: ProjectContextMapResult) => {
        if (!live) return;
        if (result.status === "ok") {
          setState({ kind: "ok", map: result.map, knowledge: result.knowledge });
        } else {
          setState({ kind: "absent", reason: result.reason });
        }
      })
      .catch((reason: unknown) => {
        if (live) setState({ kind: "error", message: messageFrom(reason) });
      });
    return () => {
      live = false;
    };
  }, [bridge, projectId]);

  if (state.kind === "ok") {
    return (
      <ContextMap
        bridge={bridge}
        projectId={projectId}
        map={state.map}
        knowledge={state.knowledge}
        onBack={onBack}
      />
    );
  }
  return (
    <div className="context-map min-h-screen flex flex-col bg-canvas">
      <header className="context-map-bar flex items-center gap-4 px-6 pt-5 pb-4 border-b border-line">
        <button
          type="button"
          onClick={onBack}
          className="context-map-back inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-chip border border-line text-ink-soft hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="h-3.5 w-3.5" />
          Back
        </button>
        <h1 className="context-map-title font-display text-xl text-ink">Context Map</h1>
      </header>
      <div className="context-map-status px-8 py-10 font-serif text-base text-ink-soft">
        {state.kind === "loading"
          ? "Loading the repo map…"
          : state.kind === "absent"
            ? state.reason
            : state.message}
      </div>
    </div>
  );
}

function ContextMap({
  bridge,
  projectId,
  map,
  knowledge,
  onBack,
}: {
  bridge: RennetBridge;
  projectId: string;
  map: ProjectMapPayload;
  knowledge: KnowledgeSetPayload | null;
  onBack(): void;
}) {
  const scopes = useMemo(() => buildScopes(map), [map]);
  const [selection, setSelection] = useState<Selection>(
    scopes[0] ? { kind: "scope", scope: scopes[0].name } : { kind: "scope", scope: "" },
  );
  const [statements, setStatements] = useState<KnowledgeStatementPayload[]>(
    knowledge?.statements ? [...knowledge.statements] : [],
  );
  const selectedScope =
    scopes.find((scope) =>
      selection.kind === "file" ? scope.name === selection.scope : scope.name === selection.scope,
    ) ?? scopes[0];

  const [dispositionError, setDispositionError] = useState<string | null>(null);
  const disposition = async (statementId: string, next: "confirmed" | "rejected") => {
    const prior = statements.find((entry) => entry.id === statementId)?.status;
    // Optimistic flip for responsiveness; the server's answer is authoritative and
    // reconciles below — a failed or not-found disposition rolls back, never leaves a
    // guessed status standing (a lie in the UI is a bug).
    setStatements((current) =>
      current.map((entry) => (entry.id === statementId ? { ...entry, status: next } : entry)),
    );
    setDispositionError(null);
    const rollback = () =>
      setStatements((current) =>
        current.map((entry) =>
          entry.id === statementId && prior ? { ...entry, status: prior } : entry,
        ),
      );
    try {
      const result = (await bridge.invoke("project.knowledgeDisposition", {
        projectId,
        statementId,
        disposition: next,
      })) as KnowledgeDispositionResult;
      if (result.status === "ok") {
        // Apply the persisted statement verbatim — the store, not the optimism, wins.
        setStatements((current) =>
          current.map((entry) => (entry.id === statementId ? result.statement : entry)),
        );
      } else {
        rollback();
        setDispositionError("That statement is no longer in the map — the view may be stale.");
      }
    } catch (reason) {
      rollback();
      setDispositionError(messageFrom(reason));
    }
  };

  const askRef = useRef<{ prefill(text: string): void }>(null);
  const discuss = (statement: KnowledgeStatementPayload) => {
    askRef.current?.prefill(
      `About "${statement.subject}": the claim "${statement.claim}" — is this right? Revise it against the evidence.`,
    );
  };

  const fileCount = map.files.length;
  // The knowledge layer is loaded independently of the (gate-fresh) structural map
  // and enrichment trails structure, so a lagging set must not read as "current".
  const knowledgeBehind = knowledge !== null && knowledge.baseOid !== map.baseOid;
  return (
    <div className="context-map min-h-screen flex flex-col bg-canvas">
      <header className="context-map-bar flex items-center gap-4 px-6 pt-5 pb-4 border-b border-line">
        <button
          type="button"
          onClick={onBack}
          className="context-map-back inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-chip border border-line text-ink-soft hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="h-3.5 w-3.5" />
          Back
        </button>
        <h1 className="context-map-title font-display text-xl text-ink">Context Map</h1>
        <span className="context-map-base font-mono text-sm text-ink-faint truncate">
          {knowledge?.repoKey ?? map.baseRef} · {map.baseRef} @ {map.baseOid.slice(0, 12)}
        </span>
        {knowledgeBehind ? (
          <span className="context-map-fresh inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-line bg-surface text-ink-soft text-2xs font-semibold">
            ◐ knowledge behind map
          </span>
        ) : (
          <span className="context-map-fresh inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-green-line bg-surface text-green text-2xs font-semibold">
            ● current
          </span>
        )}
      </header>
      <div className="context-map-main flex flex-1 min-h-0">
        <section className="context-map-col flex flex-col min-w-0 w-[26rem] border-r border-line">
          <div className="context-map-col-title px-4 py-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint border-b border-line">
            Structure — {map.scopes.length} scopes · {fileCount.toLocaleString()} files
          </div>
          <div className="context-map-scroll flex-1 overflow-auto py-1.5">
            <Tree scopes={scopes} selection={selection} onSelect={setSelection} />
          </div>
        </section>
        <section className="context-map-col flex flex-col flex-1 min-w-0 border-r border-line">
          <div className="context-map-graph border-b border-line p-4">
            <Neighborhood
              scope={selectedScope}
              onSelect={(name) => setSelection({ kind: "scope", scope: name })}
            />
          </div>
          {dispositionError ? (
            <div className="context-map-disposition-error px-4 py-2 text-2xs text-danger border-b border-danger-soft bg-danger-soft">
              {dispositionError}
            </div>
          ) : null}
          <DetailTabs
            selection={selection}
            scope={selectedScope}
            statements={statements}
            map={map}
            onConfirm={(id) => void disposition(id, "confirmed")}
            onReject={(id) => void disposition(id, "rejected")}
            onDiscuss={discuss}
          />
        </section>
        <section className="context-map-col flex flex-col min-w-0 w-[24rem]">
          <div className="context-map-col-title px-4 py-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint border-b border-line">
            Orchestrator — project session
          </div>
          <AskRail ref={askRef} bridge={bridge} projectId={projectId} />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tree ----
function Tree({
  scopes,
  selection,
  onSelect,
}: {
  scopes: ScopeNode[];
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  return (
    <div className="context-map-tree font-mono text-xs">
      {scopes.map((scope) => (
        <ScopeRow key={scope.name} scope={scope} selection={selection} onSelect={onSelect} />
      ))}
    </div>
  );
}

function rowClass(selected: boolean): string {
  return `context-map-row flex items-center gap-1.5 w-full py-1 pr-3 text-left text-ink-soft hover:bg-raised hover:text-ink ${
    selected ? "is-selected bg-accent-surface text-ink" : ""
  }`;
}

function ScopeRow({
  scope,
  selection,
  onSelect,
}: {
  scope: ScopeNode;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  const [open, setOpen] = useState(false);
  const selected = selection.kind === "scope" && selection.scope === scope.name;
  return (
    <div>
      <button
        type="button"
        className={rowClass(selected)}
        style={{ paddingLeft: "0.75rem" }}
        onClick={() => {
          setOpen(selected ? !open : true);
          onSelect({ kind: "scope", scope: scope.name });
        }}
      >
        <span className="context-map-twist w-3 text-ink-faint">{open ? "▾" : "▸"}</span>
        <span className="context-map-name flex-1 truncate text-ink">{scope.name}</span>
        <span className="context-map-count text-2xs text-ink-faint">
          {scope.in.length > 0 ? `⇦${scope.in.length} ` : ""}
          {scope.tree.fileCount}f
        </span>
      </button>
      {open ? (
        <DirChildren
          node={scope.tree}
          scope={scope.name}
          depth={1}
          selection={selection}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}

function DirChildren({
  node,
  scope,
  depth,
  selection,
  onSelect,
}: {
  node: ScopeNode["tree"];
  scope: string;
  depth: number;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  return (
    <>
      {node.dirs.map((dir) => (
        <DirRow
          key={dir.path}
          dir={dir}
          scope={scope}
          depth={depth}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
      {node.files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          scope={scope}
          depth={depth}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function DirRow({
  dir,
  scope,
  depth,
  selection,
  onSelect,
}: {
  dir: ScopeNode["tree"];
  scope: string;
  depth: number;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={rowClass(false)}
        style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
        onClick={() => setOpen(!open)}
      >
        <span className="context-map-twist w-3 text-ink-faint">{open ? "▾" : "▸"}</span>
        <span className="context-map-name flex-1 truncate">{dir.name}/</span>
        <span className="context-map-count text-2xs text-ink-faint">{dir.fileCount}f</span>
      </button>
      {open ? (
        <DirChildren
          node={dir}
          scope={scope}
          depth={depth + 1}
          selection={selection}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}

function FileRow({
  file,
  scope,
  depth,
  selection,
  onSelect,
}: {
  file: { path: string };
  scope: string;
  depth: number;
  selection: Selection;
  onSelect(next: Selection): void;
}) {
  const selected = selection.kind === "file" && selection.path === file.path;
  const base = file.path.split("/").at(-1) ?? file.path;
  return (
    <button
      type="button"
      className={rowClass(selected)}
      style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
      onClick={() => onSelect({ kind: "file", scope, path: file.path })}
    >
      <span className="context-map-twist w-3" />
      <span className="context-map-name flex-1 truncate">{base}</span>
    </button>
  );
}

// --------------------------------------------------------------- graph ----
function Neighborhood({
  scope,
  onSelect,
}: {
  scope: ScopeNode | undefined;
  onSelect(name: string): void;
}) {
  if (!scope)
    return <div className="context-map-graph-empty text-sm text-ink-faint">No scope selected.</div>;
  const outs = scope.out;
  const ins = scope.in;
  if (outs.length === 0 && ins.length === 0) {
    return (
      <div className="context-map-graph-empty text-sm text-ink-faint">
        No dependency edges recorded for {scope.name}.
      </div>
    );
  }
  const width = 720;
  const height = 300;
  const cx = width / 2;
  const cy = height / 2;
  const nodeWidth = 128;
  const place = (list: string[], side: "left" | "right") =>
    list.map((name, index) => {
      const step = height / (list.length + 1);
      return { name, x: side === "left" ? 120 : width - 120, y: step * (index + 1) };
    });
  const inNodes = place(ins, "left");
  const outNodes = place(outs, "right");
  return (
    <svg
      className="context-map-svg w-full h-auto"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Dependency neighborhood of ${scope.name}`}
    >
      <defs>
        <marker
          id="cm-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="var(--rn-ink-faint)" />
        </marker>
      </defs>
      {inNodes.map((node) => (
        <line
          key={`in-${node.name}`}
          stroke="var(--rn-line-strong)"
          markerEnd="url(#cm-arrow)"
          x1={node.x + nodeWidth / 2}
          y1={node.y}
          x2={cx - nodeWidth / 2 - 6}
          y2={cy}
        />
      ))}
      {outNodes.map((node) => (
        <line
          key={`out-${node.name}`}
          stroke="var(--rn-line-strong)"
          markerEnd="url(#cm-arrow)"
          x1={cx + nodeWidth / 2}
          y1={cy}
          x2={node.x - nodeWidth / 2 - 6}
          y2={node.y}
        />
      ))}
      {[...inNodes, ...outNodes].map((node) => (
        // biome-ignore lint/a11y/useSemanticElements: a <button> cannot exist inside <svg>; role is the SVG-correct affordance
        <g
          key={node.name}
          role="button"
          tabIndex={0}
          className="context-map-node cursor-pointer"
          onClick={() => onSelect(node.name)}
          onKeyDown={(event) => event.key === "Enter" && onSelect(node.name)}
        >
          <rect
            fill="var(--rn-raised)"
            stroke="var(--rn-line-strong)"
            x={node.x - nodeWidth / 2}
            y={node.y - 14}
            width={nodeWidth}
            height={28}
            rx="6"
          />
          <text fill="var(--rn-ink)" fontSize="12" x={node.x} y={node.y + 4} textAnchor="middle">
            {short(node.name)}
          </text>
        </g>
      ))}
      <rect
        fill="var(--rn-accent-surface)"
        stroke="var(--rn-accent-line)"
        x={cx - nodeWidth / 2}
        y={cy - 16}
        width={nodeWidth}
        height={32}
        rx="6"
      />
      <text fill="var(--rn-ink)" fontSize="14" x={cx} y={cy + 4} textAnchor="middle">
        {short(scope.name)}
      </text>
      {ins.length > 0 ? (
        <text fill="var(--rn-ink-faint)" fontSize="11" x={120} y={16} textAnchor="middle">
          imported by
        </text>
      ) : null}
      {outs.length > 0 ? (
        <text fill="var(--rn-ink-faint)" fontSize="11" x={width - 120} y={16} textAnchor="middle">
          imports
        </text>
      ) : null}
    </svg>
  );
}

// ---------------------------------------------------------------- tabs ----
function DetailTabs({
  selection,
  scope,
  statements,
  map,
  onConfirm,
  onReject,
  onDiscuss,
}: {
  selection: Selection;
  scope: ScopeNode | undefined;
  statements: KnowledgeStatementPayload[];
  map: ProjectMapPayload;
  onConfirm(id: string): void;
  onReject(id: string): void;
  onDiscuss(statement: KnowledgeStatementPayload): void;
}) {
  const [tab, setTab] = useState<"knowledge" | "details">("knowledge");
  const subject = selection.kind === "file" ? selection.path : (scope?.name ?? "");
  const relevant = knowledgeForSelection(statements, selection, scope);
  return (
    <div className="context-map-detail flex flex-col flex-1 min-h-0">
      <div className="context-map-tabs flex gap-1 px-4 pt-3 border-b border-line">
        {(["knowledge", "details"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`context-map-tab px-3 py-1.5 rounded-t-md text-sm ${
              tab === name
                ? "is-active text-ink border-b-2 border-accent"
                : "text-ink-soft hover:text-ink"
            }`}
            onClick={() => setTab(name)}
          >
            {name === "knowledge" ? `Knowledge (${relevant.length})` : "Details"}
          </button>
        ))}
      </div>
      <div className="context-map-scroll flex-1 overflow-auto p-4">
        {tab === "knowledge" ? (
          <KnowledgePanel
            statements={relevant}
            subject={subject}
            onConfirm={onConfirm}
            onReject={onReject}
            onDiscuss={onDiscuss}
          />
        ) : (
          <DetailsPanel selection={selection} scope={scope} map={map} />
        )}
      </div>
    </div>
  );
}

function KnowledgePanel({
  statements,
  subject,
  onConfirm,
  onReject,
  onDiscuss,
}: {
  statements: KnowledgeStatementPayload[];
  subject: string;
  onConfirm(id: string): void;
  onReject(id: string): void;
  onDiscuss(statement: KnowledgeStatementPayload): void;
}) {
  return (
    <div className="context-map-knowledge flex flex-col gap-3">
      <p className="context-map-note text-sm text-ink-faint">
        Model-derived, evidence-backed statements about {subject}. Each stays a labelled hypothesis
        until evidence or a human confirms it.
      </p>
      {statements.length === 0 ? (
        <p className="context-map-note text-sm text-ink-faint">
          Nothing learned about this selection yet.
        </p>
      ) : null}
      {statements.map((statement) => (
        <article
          key={statement.id}
          className={`context-map-claim rounded-surface border p-3 ${
            statement.status === "rejected"
              ? "border-line bg-surface opacity-60"
              : statement.status === "confirmed"
                ? "border-green-line bg-surface"
                : "border-line bg-raised"
          }`}
        >
          <div className="context-map-claim-head flex items-center gap-2 mb-1.5">
            <span className="context-map-claim-subject font-mono text-xs text-ink-soft truncate flex-1">
              {statement.subject}
            </span>
            <span className="context-map-conf text-2xs uppercase text-ink-faint">
              {statement.confidence}
            </span>
            <span
              className={`context-map-state px-1.5 py-0.5 rounded-full text-2xs font-semibold ${
                statement.status === "confirmed"
                  ? "bg-green-soft text-green"
                  : statement.status === "rejected"
                    ? "bg-surface text-ink-faint"
                    : "bg-accent-soft text-accent"
              }`}
            >
              {statement.status}
            </span>
          </div>
          <div className="context-map-claim-body text-base text-ink">{statement.claim}</div>
          <div className="context-map-claim-evidence mt-1.5 text-2xs text-ink-faint font-mono truncate">
            evidence: {statement.evidence.map((anchor) => anchor.path).join(", ") || "—"} ·{" "}
            {statement.provenance.generator}
          </div>
          {statement.status !== "confirmed" && statement.status !== "rejected" ? (
            <div className="context-map-claim-actions flex gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => onConfirm(statement.id)}
                className="context-map-confirm inline-flex items-center gap-1 px-2.5 py-1 rounded-chip border border-green-line text-green text-sm hover:bg-green-soft"
              >
                <Icon icon={Check} className="h-3 w-3" /> confirm
              </button>
              <button
                type="button"
                onClick={() => onReject(statement.id)}
                className="context-map-reject inline-flex items-center gap-1 px-2.5 py-1 rounded-chip border border-line text-ink-soft text-sm hover:bg-raised hover:text-danger"
              >
                <Icon icon={X} className="h-3 w-3" /> reject
              </button>
              <button
                type="button"
                onClick={() => onDiscuss(statement)}
                className="context-map-discuss inline-flex items-center gap-1 px-2.5 py-1 rounded-chip border border-line text-ink-soft text-sm hover:bg-raised hover:text-ink"
              >
                ↪ discuss
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function DetailsPanel({
  selection,
  scope,
  map,
}: {
  selection: Selection;
  scope: ScopeNode | undefined;
  map: ProjectMapPayload;
}) {
  if (selection.kind === "file") {
    return (
      <dl className="context-map-kv grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-ink-faint">path</dt>
        <dd className="font-mono text-ink truncate">{selection.path}</dd>
        <dt className="text-ink-faint">scope</dt>
        <dd className="text-ink">{selection.scope}</dd>
      </dl>
    );
  }
  if (!scope) return null;
  return (
    <dl className="context-map-kv grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-ink-faint">scope</dt>
      <dd className="text-ink">{scope.name}</dd>
      <dt className="text-ink-faint">root</dt>
      <dd className="font-mono text-ink truncate">{scope.root || "(repo root)"}</dd>
      <dt className="text-ink-faint">files</dt>
      <dd className="text-ink">{scope.tree.fileCount}</dd>
      <dt className="text-ink-faint">tests</dt>
      <dd className="text-ink">{scope.testCount}</dd>
      <dt className="text-ink-faint">imports</dt>
      <dd className="text-ink truncate">{scope.out.map(short).join(", ") || "—"}</dd>
      <dt className="text-ink-faint">imported by</dt>
      <dd className="text-ink truncate">{scope.in.map(short).join(", ") || "—"}</dd>
      <dt className="text-ink-faint">conventions</dt>
      <dd className="text-ink">{map.conventions.length} recorded</dd>
    </dl>
  );
}

// ---------------------------------------------------------------- rail ----
const AskRail = forwardRef<
  { prefill(text: string): void },
  { bridge: RennetBridge; projectId: string }
>(function AskRail({ bridge, projectId }, ref) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    prefill(text: string) {
      if (inputRef.current) {
        inputRef.current.value = text;
        inputRef.current.focus();
      }
    },
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = inputRef.current?.value.trim();
    if (!text || busy) return;
    if (inputRef.current) inputRef.current.value = "";
    const question = { id: crypto.randomUUID(), role: "user" as const, text };
    setTurns((current) => [...current, question]);
    setBusy(true);
    try {
      const result = await bridge.invoke("project.contextAsk", { projectId, question: text });
      setTurns((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "orchestrator", result },
      ]);
    } catch (reason) {
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "orchestrator",
          result: {
            status: "failed",
            failureReason: messageFrom(reason),
            cost: {
              turns: 0,
              model: null,
              effort: null,
              budgetGranted: false,
              overage: false,
              resolution: null,
            },
          },
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="context-map-log flex-1 overflow-auto p-4 flex flex-col gap-3">
        {turns.length === 0 ? (
          <p className="context-map-note text-sm text-ink-faint">
            Ask the orchestrator about this project. Answers cite the map and knowledge as evidence.
          </p>
        ) : null}
        {turns.map((turn) => (
          <AskBubble key={turn.id} turn={turn} />
        ))}
        {busy ? <p className="context-map-note text-sm text-ink-faint">Thinking…</p> : null}
      </div>
      <form className="context-map-input flex gap-2 p-3 border-t border-line" onSubmit={submit}>
        <input
          ref={inputRef}
          placeholder="Ask about this project…"
          aria-label="Message the orchestrator"
          className="context-map-field flex-1 min-w-0 px-3 py-2 rounded-control border border-line bg-surface text-ink text-base"
        />
        <button
          type="submit"
          disabled={busy}
          className="context-map-send px-3 py-2 rounded-control border border-accent-line bg-accent-soft text-ink text-sm disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </>
  );
});

function AskBubble({ turn }: { turn: AskTurn }) {
  if (turn.role === "user") {
    return (
      <div className="context-map-msg is-user self-end max-w-[85%]">
        <div className="context-map-who text-2xs uppercase text-ink-faint mb-0.5 text-right">
          you
        </div>
        <div className="context-map-bubble rounded-surface border border-accent-line bg-accent-surface px-3 py-2 text-base text-ink">
          {turn.text}
        </div>
      </div>
    );
  }
  const result = turn.result;
  return (
    <div className="context-map-msg is-orchestrator self-start max-w-[85%]">
      <div className="context-map-who text-2xs uppercase text-ink-faint mb-0.5">orchestrator</div>
      {result.status === "failed" ? (
        <div className="context-map-bubble rounded-surface border border-danger bg-danger-soft px-3 py-2 text-base text-danger">
          Couldn’t answer: {result.failureReason}
        </div>
      ) : (
        <div className="context-map-bubble rounded-surface border border-line bg-raised px-3 py-2 text-base text-ink">
          {result.answer.answer}
          {result.status === "unanswered" && result.answer.unanswered ? (
            <div className="context-map-unanswered mt-1.5 text-sm text-ink-faint">
              Unanswered: {result.answer.unanswered.reason}
            </div>
          ) : null}
          {result.answer.evidence.length > 0 ? (
            <div className="context-map-evidence mt-1.5 text-2xs text-ink-faint font-mono truncate">
              evidence: {result.answer.evidence.map((anchor) => anchor.path).join(", ")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
