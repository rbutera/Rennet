import { useMemo, useRef, useState } from "react";
import {
  buildModel,
  cannedReply,
  conventions,
  discussScript,
  meta,
  primerBudget,
  primerSections,
  seedChat,
  seedClaims,
  symbolsByFile,
} from "./data.js";

const short = (name) => name.replace("@rennet/", "");

export function App() {
  const scopes = useMemo(buildModel, []);
  const [selection, setSelection] = useState({ kind: "scope", scope: "@rennet/core" });
  const [claims, setClaims] = useState(seedClaims);
  const [chat, setChat] = useState(seedChat);
  const [scheme, setScheme] = useState("auto");

  const selectedScope = scopes.find((scope) => scope.name === selection.scope) ?? scopes[0];

  const cycleScheme = () => {
    const next = scheme === "auto" ? "dark" : scheme === "dark" ? "light" : "auto";
    setScheme(next);
    if (next === "auto") delete document.documentElement.dataset.scheme;
    else document.documentElement.dataset.scheme = next;
  };

  const setClaimState = (id, state) =>
    setClaims((current) => current.map((claim) => (claim.id === id ? { ...claim, state } : claim)));

  const discuss = (claim) => {
    setChat((current) => [...current, ...discussScript(claim)]);
    setClaimState(claim.id, "revised");
  };

  const send = (text) => {
    setChat((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", text },
      cannedReply(),
    ]);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Context Map</h1>
        <span className="base">
          rennet · {meta.baseRef} @ {meta.baseOid.slice(0, 12)}
        </span>
        <span className="badge fresh">● current</span>
        <span className="spacer" />
        <button type="button" className="scheme" onClick={cycleScheme}>
          scheme: {scheme}
        </button>
      </header>
      <div className="main">
        <section className="col">
          <div className="col-title">
            Structure — {meta.scopeCount} scopes · {meta.fileCount.toLocaleString()} files
          </div>
          <div className="scroll">
            <Tree scopes={scopes} selection={selection} onSelect={setSelection} />
          </div>
        </section>
        <section className="col">
          <div className="graph-wrap">
            <Neighborhood
              scope={selectedScope}
              onSelect={(name) => setSelection({ kind: "scope", scope: name })}
            />
          </div>
          <DetailTabs
            selection={selection}
            scope={selectedScope}
            claims={claims}
            onConfirm={(id) => setClaimState(id, "confirmed")}
            onReject={(id) => setClaimState(id, "rejected")}
            onDiscuss={discuss}
          />
        </section>
        <section className="col chat">
          <div className="col-title">Orchestrator — project session (scripted)</div>
          <ChatRail chat={chat} onSend={send} />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tree ----
function Tree({ scopes, selection, onSelect }) {
  return (
    <div className="tree">
      {scopes.map((scope) => (
        <ScopeRow key={scope.name} scope={scope} selection={selection} onSelect={onSelect} />
      ))}
    </div>
  );
}

function ScopeRow({ scope, selection, onSelect }) {
  const [open, setOpen] = useState(scope.name === "@rennet/core");
  const selected = selection.kind === "scope" && selection.scope === scope.name;
  return (
    <div>
      <button
        type="button"
        className={`row scope${selected ? " selected" : ""}`}
        onClick={() => {
          setOpen(selected ? !open : true);
          onSelect({ kind: "scope", scope: scope.name });
        }}
      >
        <span className="twist">{open ? "▾" : "▸"}</span>
        <span className="name">{scope.name}</span>
        <span className="count">
          {scope.in.length > 0 && `⇦${scope.in.length} `}
          {scope.tree.fileCount}f
        </span>
      </button>
      {open && (
        <DirChildren
          node={scope.tree}
          scope={scope.name}
          depth={1}
          selection={selection}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function DirChildren({ node, scope, depth, selection, onSelect }) {
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

function DirRow({ dir, scope, depth, selection, onSelect }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="row"
        style={{ "--depth": depth }}
        onClick={() => setOpen(!open)}
      >
        <span className="twist">{open ? "▾" : "▸"}</span>
        <span className="name">{dir.name}/</span>
        <span className="count">{dir.fileCount}f</span>
      </button>
      {open && (
        <DirChildren
          node={dir}
          scope={scope}
          depth={depth + 1}
          selection={selection}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function FileRow({ file, scope, depth, selection, onSelect }) {
  const symbols = symbolsByFile[file.path];
  const [open, setOpen] = useState(false);
  const selected = selection.kind === "file" && selection.path === file.path;
  const base = file.path.split("/").at(-1);
  return (
    <div>
      <button
        type="button"
        className={`row file${selected ? " selected" : ""}`}
        style={{ "--depth": depth }}
        onClick={() => {
          onSelect({ kind: "file", scope, path: file.path });
          if (symbols) setOpen(!open);
        }}
      >
        <span className="twist">{symbols ? (open ? "▾" : "▸") : ""}</span>
        <span className="name">{base}</span>
        {symbols && <span className="count">{symbols.length}s</span>}
      </button>
      {open &&
        symbols?.map((symbol) => (
          <div
            key={`${symbol.name}:${symbol.line}`}
            className="row symbol"
            style={{ "--depth": depth + 1 }}
          >
            <span className="twist" />
            <span className="kind">{symbol.kind}</span>
            <span className="name">{symbol.name}</span>
            <span className="count">L{symbol.line}</span>
          </div>
        ))}
    </div>
  );
}

// --------------------------------------------------------------- graph ----
function Neighborhood({ scope, onSelect }) {
  const outs = scope.out;
  const ins = scope.in;
  if (outs.length === 0 && ins.length === 0) {
    return <div className="graph-empty">No dependency edges recorded for {scope.name}.</div>;
  }
  const width = 720;
  const height = 300;
  const cx = width / 2;
  const cy = height / 2;
  const place = (list, side) =>
    list.map((name, index) => {
      const step = height / (list.length + 1);
      return { name, x: side === "left" ? 120 : width - 120, y: step * (index + 1) };
    });
  const inNodes = place(ins, "left");
  const outNodes = place(outs, "right");
  const nodeWidth = 128;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Dependency neighborhood of ${scope.name}`}
    >
      <defs>
        <marker
          id="arrow"
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
          className="edge"
          markerEnd="url(#arrow)"
          x1={node.x + nodeWidth / 2}
          y1={node.y}
          x2={cx - nodeWidth / 2 - 6}
          y2={cy}
        />
      ))}
      {outNodes.map((node) => (
        <line
          key={`out-${node.name}`}
          className="edge"
          markerEnd="url(#arrow)"
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
          onClick={() => onSelect(node.name)}
          onKeyDown={(event) => event.key === "Enter" && onSelect(node.name)}
        >
          <rect
            className="node-box"
            x={node.x - nodeWidth / 2}
            y={node.y - 14}
            width={nodeWidth}
            height={28}
            rx="6"
          />
          <text className="node-label" x={node.x} y={node.y + 4} textAnchor="middle">
            {short(node.name)}
          </text>
        </g>
      ))}
      <rect
        className="node-box center"
        x={cx - nodeWidth / 2}
        y={cy - 16}
        width={nodeWidth}
        height={32}
        rx="6"
      />
      <text className="node-label center" x={cx} y={cy + 4} textAnchor="middle">
        {short(scope.name)}
      </text>
      {ins.length > 0 && (
        <text className="edge-hint" x={120} y={16} textAnchor="middle">
          imported by
        </text>
      )}
      {outs.length > 0 && (
        <text className="edge-hint" x={width - 120} y={16} textAnchor="middle">
          imports
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- tabs ----
function DetailTabs({ selection, scope, claims, onConfirm, onReject, onDiscuss }) {
  const [tab, setTab] = useState("knowledge");
  const subject = selection.kind === "file" ? selection.path : scope.name;
  const relevant = claims.filter(
    (claim) =>
      claim.subject === subject ||
      (selection.kind === "scope" && claim.subject.startsWith(`${scope.root}/`)),
  );
  return (
    <div className="col">
      <div className="tabs">
        {["knowledge", "primer", "details"].map((name) => (
          <button
            key={name}
            type="button"
            className={`tab${tab === name ? " active" : ""}`}
            onClick={() => setTab(name)}
          >
            {name === "knowledge"
              ? `Knowledge (${relevant.length})`
              : name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      <div className="scroll">
        {tab === "knowledge" && (
          <KnowledgePanel
            claims={relevant}
            subject={subject}
            onConfirm={onConfirm}
            onReject={onReject}
            onDiscuss={onDiscuss}
          />
        )}
        {tab === "primer" && <PrimerPanel />}
        {tab === "details" && <DetailsPanel selection={selection} scope={scope} />}
      </div>
    </div>
  );
}

function KnowledgePanel({ claims, subject, onConfirm, onReject, onDiscuss }) {
  return (
    <div className="panel">
      <p className="panel-note">
        Model-derived, evidence-backed statements about {subject}. Each stays a labelled hypothesis
        until evidence or a human confirms it. (Staged data — the real layer is minted by the
        knowledge enrichment pass.)
      </p>
      {claims.length === 0 && (
        <p className="panel-note">Nothing learned about this selection yet.</p>
      )}
      {claims.map((claim) => (
        <article key={claim.id} className={`claim ${claim.state}`}>
          <div className="claim-head">
            <span className="claim-subject">{claim.subject}</span>
            <span className={`conf ${claim.confidence}`}>{claim.confidence}</span>
            <span className={`state-chip ${claim.state}`}>{claim.state}</span>
          </div>
          <div className="claim-body">{claim.claim}</div>
          <div className="claim-evidence">
            evidence: {claim.evidence.join(", ")} · {claim.provenance.generator}
          </div>
          {(claim.state === "hypothesis" || claim.state === "revised") && (
            <div className="claim-actions">
              <button type="button" className="confirm" onClick={() => onConfirm(claim.id)}>
                ✓ confirm
              </button>
              <button type="button" className="reject" onClick={() => onReject(claim.id)}>
                ✗ reject
              </button>
              <button type="button" className="discuss" onClick={() => onDiscuss(claim)}>
                ↪ discuss
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function PrimerPanel() {
  const used = primerSections.reduce((sum, section) => sum + section.bytes, 0);
  return (
    <div className="panel">
      <p className="panel-note">
        The exact orientation the orchestrator receives before its first tool call — deterministic,
        versioned, byte-bounded. Read-only. (Mocked rendering.)
      </p>
      <div className="primer-head">
        <span>byte budget</span>
        <span className="bytes">
          {used} / {primerBudget}
        </span>
      </div>
      <div className="budget">
        <div className="budget-fill" style={{ width: `${(used / primerBudget) * 100}%` }} />
      </div>
      {primerSections.map((section) => (
        <div key={section.name} className="primer-section">
          <div className="primer-head">
            <span>{section.name}</span>
            <span className="bytes">{section.bytes}B</span>
          </div>
          <div className="primer-body">{section.body}</div>
        </div>
      ))}
    </div>
  );
}

function DetailsPanel({ selection, scope }) {
  if (selection.kind === "file") {
    const symbols = symbolsByFile[selection.path] ?? [];
    return (
      <div className="panel">
        <dl className="kv">
          <dt>path</dt>
          <dd>{selection.path}</dd>
          <dt>scope</dt>
          <dd>{scope.name}</dd>
          <dt>symbols</dt>
          <dd>
            {symbols.length > 0 ? symbols.map((symbol) => symbol.name).join(", ") : "none declared"}
          </dd>
        </dl>
      </div>
    );
  }
  return (
    <div className="panel">
      <dl className="kv">
        <dt>scope</dt>
        <dd>{scope.name}</dd>
        <dt>root</dt>
        <dd>{scope.root || "(repo root)"}</dd>
        <dt>files</dt>
        <dd>{scope.tree.fileCount}</dd>
        <dt>tests</dt>
        <dd>{scope.testCount}</dd>
        <dt>entry</dt>
        <dd>{scope.entry?.exports ?? "—"}</dd>
        <dt>imports</dt>
        <dd>{scope.out.map(short).join(", ") || "—"}</dd>
        <dt>imported by</dt>
        <dd>{scope.in.map(short).join(", ") || "—"}</dd>
        <dt>conventions</dt>
        <dd>
          {conventions
            .map((convention) => convention.name ?? convention.kind ?? "")
            .filter(Boolean)
            .join(", ") || `${conventions.length} recorded`}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- chat ----
function ChatRail({ chat, onSend }) {
  const inputRef = useRef(null);
  const submit = (event) => {
    event.preventDefault();
    const text = inputRef.current.value.trim();
    if (!text) return;
    inputRef.current.value = "";
    onSend(text);
  };
  return (
    <>
      <div className="chat-log">
        {chat.map((message) => (
          <div key={message.id} className={`msg ${message.role}`}>
            <div className="who">{message.role === "user" ? "you" : "orchestrator"}</div>
            <div className="bubble">{message.text}</div>
            {message.tools && (
              <div className="tool-chips">
                {message.tools.map((tool) => (
                  <span key={tool} className="tool-chip">
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          ref={inputRef}
          placeholder="Ask about this project…"
          aria-label="Message the orchestrator"
        />
        <button type="submit">Send</button>
      </form>
    </>
  );
}
