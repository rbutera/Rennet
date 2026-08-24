"use client"

import * as React from "react"
import { ChevronDown, GitCommitHorizontal, MapPin, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import type { BoardElement, BoardSection, LensBoard } from "@/lib/lens-data"
import { CodeBlock } from "@/components/code-block"

/**
 * Renders a lens board as a document: sections of typed elements in reading
 * order. Sections fold to their one-line gist (rollup grammar); blocks get a
 * quiet hover toolbar (shortcuts for things you could say to the orchestrator).
 */
export function LensBoardView({
  board,
  initiallyFolded = [],
}: {
  board: LensBoard
  initiallyFolded?: string[]
}) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-8 py-8">
      <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{board.title}</h1>
      {board.intro && (
        <p className="-mt-3 text-[14px] leading-relaxed text-muted-foreground">{board.intro}</p>
      )}
      {board.sections.map((section) => (
        <Section key={section.id} section={section} initiallyFolded={initiallyFolded.includes(section.id)} />
      ))}
    </div>
  )
}

function Section({ section, initiallyFolded }: { section: BoardSection; initiallyFolded: boolean }) {
  const [folded, setFolded] = React.useState(initiallyFolded)

  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setFolded((f) => !f)}
        aria-expanded={!folded}
        className="group flex items-center gap-2 text-left"
      >
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", folded && "-rotate-90")}
          aria-hidden="true"
        />
        <span className="text-[15px] font-medium text-foreground">{section.title}</span>
        {folded && (
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">
            {section.gist}
            {section.counts ? <span className="text-muted-foreground/60"> · {section.counts}</span> : null}
          </span>
        )}
      </button>
      {!folded && (
        <div className="flex flex-col gap-4 pl-5">
          {section.elements.map((element, index) => (
            <Element key={index} element={element} />
          ))}
        </div>
      )}
    </section>
  )
}

function HoverBar({ children }: { children?: React.ReactNode }) {
  return (
    <div className="absolute -top-2.5 right-2 hidden items-center gap-0.5 rounded-md border border-border bg-background px-1 py-0.5 group-hover/el:flex">
      {children}
      <button
        type="button"
        className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        Explain
      </button>
    </div>
  )
}

function Element({ element }: { element: BoardElement }) {
  switch (element.kind) {
    case "prose":
      return (
        <div className="group/el relative">
          <HoverBar />
          <p className="max-w-[640px] text-[14.5px] leading-relaxed text-foreground/90">{element.text}</p>
        </div>
      )

    case "code":
      return (
        <div className="group/el relative">
          <HoverBar />
          <CodeBlock
            code={element.code}
            path={element.path}
            lang={element.lang}
            startLine={element.startLine}
            highlightLines={element.highlightLines}
          />
        </div>
      )

    case "callout":
      return (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-[13.5px] leading-relaxed",
            element.tone === "warn"
              ? "border-destructive/40 bg-destructive/5 text-foreground/90"
              : "border-border bg-secondary/40 text-foreground/90",
          )}
        >
          {element.text}
        </div>
      )

    case "finding":
      return (
        <div className="group/el relative rounded-md border border-border">
          <HoverBar />
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                element.severity === "high" && "bg-destructive/15 text-destructive",
                element.severity === "medium" && "bg-primary/15 text-primary",
                element.severity === "low" && "bg-secondary text-muted-foreground",
              )}
            >
              {element.severity}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
              {element.title}
            </span>
            <Concurrence agreement={element.agreement} />
          </div>
          <div className="flex flex-col gap-1.5 px-3 py-2.5">
            <p className="text-[13.5px] leading-relaxed text-foreground/90">{element.body}</p>
            {element.anchor && <Anchor anchor={element.anchor} />}
          </div>
        </div>
      )

    case "annotation":
      return (
        <div className="flex items-start gap-2 pl-1">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Anchor anchor={element.anchor} />
            <p className="text-[13.5px] leading-relaxed text-foreground/90">{element.text}</p>
          </div>
        </div>
      )

    case "thread":
      return (
        <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
          {element.anchor && <Anchor anchor={element.anchor} />}
          {element.messages.map((message, index) =>
            message.author === "user" ? (
              <div key={index} className="flex justify-start">
                <div className="max-w-[480px] rounded-lg bg-secondary px-2.5 py-1.5 text-[13.5px] leading-relaxed text-foreground/95">
                  {message.text}
                </div>
              </div>
            ) : (
              <p key={index} className="max-w-[560px] text-[13.5px] leading-relaxed text-foreground/85">
                {message.text}
              </p>
            ),
          )}
        </div>
      )

    case "decision":
      return (
        <div className="group/el relative rounded-md border border-border px-3 py-2.5">
          <HoverBar />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-[13.5px] font-medium leading-snug text-foreground">{element.statement}</span>
              {element.inferred && (
                <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  inferred
                </span>
              )}
            </div>
            <p className="pl-5 text-[13px] leading-relaxed text-foreground/85">{element.why}</p>
            {element.alternatives.length > 0 && (
              <p className="pl-5 text-[12.5px] leading-relaxed text-muted-foreground">
                Not taken: {element.alternatives.join(" · ")}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 pl-5">
              {element.evidence.map((anchor, index) => (
                <Anchor key={index} anchor={anchor} />
              ))}
            </div>
          </div>
        </div>
      )

    case "requirement":
      return (
        <div className="group/el relative rounded-md border border-border px-3 py-2.5">
          <HoverBar />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  element.status === "covered" && "bg-secondary text-foreground/80",
                  element.status === "partial" && "bg-primary/15 text-primary",
                  element.status === "unimplemented" && "bg-destructive/15 text-destructive",
                )}
              >
                {element.status}
              </span>
              <span className="text-[13.5px] leading-snug text-foreground">{element.text}</span>
            </div>
            <p className="pl-1 text-[12px] text-muted-foreground">
              {element.coverage.hunks} {element.coverage.hunks === 1 ? "hunk" : "hunks"} ·{" "}
              {element.coverage.tests} {element.coverage.tests === 1 ? "test" : "tests"}
            </p>
            {element.scenarios && element.scenarios.length > 0 && (
              <ul className="flex flex-col gap-1 pl-1">
                {element.scenarios.map((scenario, index) => (
                  <li key={index} className="text-[13px] leading-relaxed text-foreground/80">
                    {scenario}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )

    case "noise-group":
      return <NoiseGroup element={element} />

    default:
      return null
  }
}

function NoiseGroup({ element }: { element: Extract<BoardElement, { kind: "noise-group" }> }) {
  const [dismissed, setDismissed] = React.useState(false)

  return (
    <div className={cn("rounded-md border border-border", dismissed && "opacity-50")}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[13.5px] font-medium text-foreground">{element.label}</span>
        <span className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {element.judgedBy === "llm" && <Sparkles className="size-2.5" aria-hidden="true" />}
          {element.judgedBy === "llm" ? "model judged" : "rule"}
        </span>
        <button
          type="button"
          onClick={() => setDismissed((d) => !d)}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {dismissed ? "not noise?" : "dismiss"}
        </button>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <p className="text-[12.5px] text-muted-foreground">{element.reason}</p>
        <div className="flex flex-col gap-1">
          {element.hunks.map((hunk, index) => (
            <div key={index} className="flex items-baseline gap-2 text-[12.5px]">
              <span className="shrink-0 font-mono text-muted-foreground">{hunk.path}</span>
              <span className="min-w-0 truncate text-foreground/70">{hunk.summary}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Concurrence({ agreement }: { agreement: { claude: boolean; codex: boolean } }) {
  const concur = agreement.claude && agreement.codex
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
        concur ? "border-border text-muted-foreground" : "border-primary/40 text-primary",
      )}
      title={concur ? "Both models raised this" : "Models disagree"}
    >
      {concur ? "concur 2/2" : agreement.claude ? "Claude only" : "Codex only"}
    </span>
  )
}

function Anchor({ anchor }: { anchor: { path: string; line: number } }) {
  return (
    <button
      type="button"
      className="w-fit rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      title="Jump to code"
    >
      {anchor.path}:{anchor.line}
    </button>
  )
}
