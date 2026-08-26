"use client"

import * as React from "react"
import { ArrowLeft, Check, ChevronDown, ChevronRight, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  mapBase,
  mapScopes,
  mapStatements,
  scopeIns,
  type MapScope,
  type MapStatement,
} from "@/lib/context-map-data"

/**
 * The Context Map panel, ported from the shipped feature (design kept as-is
 * per Rai): structure tree on the left (scopes with ⇦importers/file counts),
 * the dependency neighborhood graph + knowledge/details tabs on the right.
 * The shipped ask rail is omitted — the session chat column plays that role.
 *
 * `revealed` caps how many scopes (and their statements) exist yet, so the
 * add-project flow can render the same panel filling in live.
 */
export function ContextMapPanel({ revealed }: { revealed?: number }) {
  const scopes = revealed === undefined ? mapScopes : mapScopes.slice(0, revealed)
  const scopeNames = new Set(scopes.map((scope) => scope.name))
  const [selected, setSelected] = React.useState(mapScopes[0].name)
  const [statements, setStatements] = React.useState<MapStatement[]>(mapStatements)

  const visibleStatements = statements.filter((statement) => scopeNames.has(statement.subject))
  const scope = scopes.find((s) => s.name === selected) ?? scopes[0]

  function setStatus(id: string, status: MapStatement["status"]) {
    setStatements((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Structure — {scopes.length} scopes · {scopes.reduce((n, s) => n + s.files, 0).toLocaleString()} files
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {scopes.map((s) => (
            <ScopeRow
              key={s.name}
              scope={s}
              importerCount={scopeIns(s.name).filter((n) => scopeNames.has(n)).length}
              selected={scope?.name === s.name}
              onSelect={() => setSelected(s.name)}
            />
          ))}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border p-4">
          {scope ? (
            <Neighborhood
              scope={scope}
              ins={scopeIns(scope.name).filter((n) => scopeNames.has(n))}
              outs={scope.out.filter((n) => scopeNames.has(n))}
              onSelect={setSelected}
            />
          ) : null}
        </div>
        {scope ? (
          <DetailTabs
            scope={scope}
            statements={visibleStatements.filter((s) => s.subject === scope.name)}
            onConfirm={(id) => setStatus(id, "confirmed")}
            onReject={(id) => setStatus(id, "rejected")}
          />
        ) : null}
      </section>
    </div>
  )
}

/** The context map as a full main-surface view with its own header. */
export function ContextMapFullView({
  projectName,
  onBack,
}: {
  projectName: string
  onBack: () => void
}) {
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onBack()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onBack])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="mr-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="shrink-0 font-medium text-foreground">{projectName}</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span className="text-muted-foreground">Context Map</span>
        </span>
        <kbd className="ml-auto rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </header>
      <MapBaseLine />
      <ContextMapPanel />
    </div>
  )
}

/** Header strip naming the base the map was built from, with freshness. */
export function MapBaseLine({ building }: { building?: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <span className="text-[13px] font-medium text-foreground">Context Map</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground/70">
        {mapBase.repoKey} · {mapBase.ref} @ {mapBase.oid}
      </span>
      {building ? (
        <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          ◐ building
        </span>
      ) : (
        <span className="ml-auto rounded-full border border-green-500/30 px-2 py-0.5 text-[10px] font-medium text-green-500">
          ● current
        </span>
      )}
    </div>
  )
}

function ScopeRow({
  scope,
  importerCount,
  selected,
  onSelect,
}: {
  scope: MapScope
  importerCount: number
  selected: boolean
  onSelect: () => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(selected ? !open : true)
          onSelect()
        }}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pl-3 pr-3 text-left font-mono text-[12px] transition-colors",
          selected ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
        )}
      >
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", !open && "-rotate-90")}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{scope.name.replace("@rennet/", "")}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60">
          {importerCount > 0 ? `⇦${importerCount} ` : ""}
          {scope.files}f
        </span>
      </button>
      {open && (
        <div className="flex flex-col">
          {scope.sampleFiles.map((file) => (
            <div
              key={file}
              className="truncate py-0.5 pl-9 pr-3 font-mono text-[11px] text-muted-foreground/60"
            >
              {file.split("/").at(-1)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function short(name: string): string {
  return name.replace("@rennet/", "")
}

function Neighborhood({
  scope,
  ins,
  outs,
  onSelect,
}: {
  scope: MapScope
  ins: string[]
  outs: string[]
  onSelect: (name: string) => void
}) {
  if (ins.length === 0 && outs.length === 0) {
    return (
      <div className="py-8 text-center text-[12px] text-muted-foreground/50">
        No dependency edges recorded for {short(scope.name)}.
      </div>
    )
  }
  const width = 720
  const height = Math.max(200, Math.max(ins.length, outs.length) * 44 + 60)
  const cx = width / 2
  const cy = height / 2
  const nodeWidth = 128
  const place = (list: string[], side: "left" | "right") =>
    list.map((name, index) => {
      const step = height / (list.length + 1)
      return { name, x: side === "left" ? 110 : width - 110, y: step * (index + 1) }
    })
  const inNodes = place(ins, "left")
  const outNodes = place(outs, "right")
  return (
    <svg
      className="h-auto w-full"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Dependency neighborhood of ${scope.name}`}
    >
      <defs>
        <marker id="cm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" className="fill-muted-foreground/60" />
        </marker>
      </defs>
      {inNodes.map((node) => (
        <line
          key={`in-${node.name}`}
          className="stroke-border"
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
          className="stroke-border"
          markerEnd="url(#cm-arrow)"
          x1={cx + nodeWidth / 2}
          y1={cy}
          x2={node.x - nodeWidth / 2 - 6}
          y2={node.y}
        />
      ))}
      {[...inNodes, ...outNodes].map((node) => (
        <g
          key={node.name}
          role="button"
          tabIndex={0}
          className="cursor-pointer"
          onClick={() => onSelect(node.name)}
          onKeyDown={(event) => event.key === "Enter" && onSelect(node.name)}
        >
          <rect
            className="fill-secondary stroke-border"
            x={node.x - nodeWidth / 2}
            y={node.y - 14}
            width={nodeWidth}
            height={28}
            rx="6"
          />
          <text className="fill-foreground" fontSize="12" x={node.x} y={node.y + 4} textAnchor="middle">
            {short(node.name)}
          </text>
        </g>
      ))}
      <rect
        className="fill-primary/15 stroke-primary/50"
        x={cx - nodeWidth / 2}
        y={cy - 16}
        width={nodeWidth}
        height={32}
        rx="6"
      />
      <text className="fill-foreground" fontSize="13" x={cx} y={cy + 4} textAnchor="middle">
        {short(scope.name)}
      </text>
      {ins.length > 0 && (
        <text className="fill-muted-foreground" fontSize="11" x={110} y={16} textAnchor="middle">
          imported by
        </text>
      )}
      {outs.length > 0 && (
        <text className="fill-muted-foreground" fontSize="11" x={width - 110} y={16} textAnchor="middle">
          imports
        </text>
      )}
    </svg>
  )
}

function DetailTabs({
  scope,
  statements,
  onConfirm,
  onReject,
}: {
  scope: MapScope
  statements: MapStatement[]
  onConfirm: (id: string) => void
  onReject: (id: string) => void
}) {
  const [tab, setTab] = React.useState<"knowledge" | "details">("knowledge")
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-border px-4 pt-2">
        {(["knowledge", "details"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={cn(
              "rounded-t-md px-3 py-1.5 text-[12.5px] transition-colors",
              tab === name
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {name === "knowledge" ? `Knowledge (${statements.length})` : "Details"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "knowledge" ? (
          <div className="flex flex-col gap-3">
            {statements.length === 0 && (
              <p className="text-[12.5px] text-muted-foreground/60">
                Nothing learned about {short(scope.name)} yet.
              </p>
            )}
            {statements.map((statement) => (
              <article
                key={statement.id}
                className={cn(
                  "rounded-md border p-3",
                  statement.status === "rejected" && "border-border opacity-60",
                  statement.status === "confirmed" && "border-green-500/30",
                  statement.status === "proposed" && "border-border bg-secondary/30",
                )}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {statement.subject}
                  </span>
                  <span className="text-[10px] uppercase text-muted-foreground/60">{statement.confidence}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                      statement.status === "confirmed" && "bg-green-soft text-green",
                      statement.status === "rejected" && "bg-secondary text-muted-foreground",
                      statement.status === "proposed" && "bg-model-soft text-model",
                    )}
                  >
                    {statement.status}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-foreground/90">{statement.claim}</p>
                <p className="mt-1.5 truncate font-mono text-[10.5px] text-muted-foreground/60">
                  evidence: {statement.evidence.join(", ")}
                </p>
                {statement.status === "proposed" && (
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onConfirm(statement.id)}
                      className="flex items-center gap-1 rounded-md border border-green-500/30 px-2 py-1 text-[11.5px] text-green-500 hover:bg-green-500/10"
                    >
                      <Check className="size-3" aria-hidden="true" /> confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(statement.id)}
                      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-destructive"
                    >
                      <X className="size-3" aria-hidden="true" /> reject
                    </button>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      ↪ discuss
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            <dt className="text-muted-foreground/60">scope</dt>
            <dd className="text-foreground">{scope.name}</dd>
            <dt className="text-muted-foreground/60">root</dt>
            <dd className="truncate font-mono text-foreground">{scope.root}</dd>
            <dt className="text-muted-foreground/60">files</dt>
            <dd className="text-foreground">{scope.files}</dd>
            <dt className="text-muted-foreground/60">tests</dt>
            <dd className="text-foreground">{scope.tests}</dd>
            <dt className="text-muted-foreground/60">imports</dt>
            <dd className="truncate text-foreground">{scope.out.map(short).join(", ") || "—"}</dd>
            <dt className="text-muted-foreground/60">imported by</dt>
            <dd className="truncate text-foreground">{scopeIns(scope.name).map(short).join(", ") || "—"}</dd>
          </dl>
        )}
      </div>
    </div>
  )
}
