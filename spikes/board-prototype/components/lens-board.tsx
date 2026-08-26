"use client"

import * as React from "react"
import {
  ChevronDown,
  FileText,
  GitCommitHorizontal,
  Link2,
  MapPin,
  Sparkles,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { BoardElement, BoardSection, LensBoard } from "@/lib/lens-data"
import { CodeBlock } from "@/components/code-block"
import { AnchorReveal, CodeTabs } from "@/components/code-tabs"
import { HydratedCode, InlineCode, RichText } from "@/components/rich-text"
import { ProseSelectionLayer } from "@/components/selection-toolbar"
import { useCodeComments } from "@/components/code-comments"

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
    <ProseSelectionLayer>
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-8 px-8 py-8",
        board.wide ? "max-w-[960px]" : "max-w-[760px]",
      )}
    >
      <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{board.title}</h1>
      {board.intro && (
        <RichText
          text={board.intro}
          className="-mt-3"
          paragraphClassName="text-[14px] leading-relaxed text-muted-foreground"
        />
      )}
      {board.sections.map((section) => (
        <Section key={section.id} section={section} initiallyFolded={initiallyFolded.includes(section.id)} />
      ))}
    </div>
    </ProseSelectionLayer>
  )
}

function Section({ section, initiallyFolded }: { section: BoardSection; initiallyFolded: boolean }) {
  const [folded, setFolded] = React.useState(initiallyFolded || Boolean(section.startFolded))

  return (
    <section id={section.id} className="flex flex-col gap-3 scroll-mt-6">
      {/* disclosure pattern: the heading wraps the toggle button, never the reverse */}
      <h2 className="contents">
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
        <span className="text-[17px] font-medium text-foreground">{section.title}</span>
        {section.badge && <DeltaBadge delta={section.badge} />}
        {folded && (
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">
            {section.gist}
            {section.counts ? <span className="text-muted-foreground/60"> · {section.counts}</span> : null}
          </span>
        )}
        {section.source && (
          <span className="ml-auto shrink-0 rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
            {section.source}
          </span>
        )}
        </button>
      </h2>
      {!folded && (
        <div className="flex flex-col gap-5 pl-5">
          {section.elements.map((element, index) => (
            <Element key={index} element={element} />
          ))}
        </div>
      )}
    </section>
  )
}


function Element({ element }: { element: BoardElement }) {
  switch (element.kind) {
    case "prose":
      return (
        <div>
          <RichText
            text={element.text}
            className="max-w-[640px]"
            paragraphClassName="text-[14.5px] leading-relaxed text-foreground/90"
          />
        </div>
      )

    case "spec-header":
      return (
        <header className="flex flex-col gap-3 rounded-md border border-border bg-secondary/30 px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-[16px] font-semibold text-foreground">{element.change}</h3>
            <span className="text-[12.5px] text-muted-foreground">
              {element.counts.added} new {element.counts.added === 1 ? "capability" : "capabilities"} ·{" "}
              {element.counts.modified} modified
              {element.tasks ? (
                <>
                  {" "}
                  · tasks {element.tasks.done}/{element.tasks.total}
                </>
              ) : null}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {element.format} · {element.source}
              </span>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                raw ⌘R
              </button>
            </span>
          </div>
          <RichText
            text={`Why: ${element.why}`}
            paragraphClassName="text-[13.5px] leading-relaxed text-foreground/90"
          />
          {element.artifacts && element.artifacts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {element.artifacts.map((artifact) => (
                <a
                  key={artifact.sectionId}
                  href={`#${artifact.sectionId}`}
                  className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {artifact.label}
                </a>
              ))}
            </div>
          )}
        </header>
      )

    case "what-changes":
      return (
        <div className={cn("grid gap-4", element.impact && "md:grid-cols-[3fr_2fr]")}>
          <div className="flex flex-col">
            <SmallLabel>What changes</SmallLabel>
            <div className="flex flex-col divide-y divide-border/60">
              {element.rows.map((row, index) => (
                <div key={index} className="flex items-baseline gap-2.5 py-1.5">
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {row.tag}
                  </span>
                  <RichText
                    text={row.text}
                    paragraphClassName="text-[13px] leading-relaxed text-foreground/90"
                  />
                </div>
              ))}
            </div>
          </div>
          {element.impact && (
            <div className="flex flex-col">
              <SmallLabel>Impact</SmallLabel>
              <div className="rounded-md border border-border px-3 py-2">
                <RichText
                  text={element.impact}
                  paragraphClassName="text-[12.5px] leading-relaxed text-foreground/85"
                />
              </div>
            </div>
          )}
        </div>
      )

    case "capability-grid":
      return (
        <div className="flex flex-col">
          <SmallLabel>Capabilities</SmallLabel>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {element.capabilities.map((capability) => (
              <a
                key={capability.slug}
                href={`#${capability.sectionId}`}
                className={cn(
                  "flex flex-col gap-1 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-secondary/50",
                  capability.state === "added" && "border-l-2 border-l-green/70",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">
                    {capability.slug}
                  </span>
                  <DeltaBadge delta={capability.state} />
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {capability.requirements} {capability.requirements === 1 ? "requirement" : "requirements"} ·{" "}
                  {capability.scenarios} {capability.scenarios === 1 ? "scenario" : "scenarios"}
                </span>
              </a>
            ))}
          </div>
        </div>
      )

    case "task-progress":
      return (
        <div className="flex flex-col">
          <SmallLabel>
            Tasks · {element.groups.reduce((sum, group) => sum + group.done, 0)}/
            {element.groups.reduce((sum, group) => sum + group.total, 0)}
            {element.source && (
              <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-muted-foreground/70">
                {element.source}
              </span>
            )}
          </SmallLabel>
          <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border px-3">
            {element.groups.map((group, index) => (
              <div key={index} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{group.label}</span>
                <span
                  className="h-1 w-28 shrink-0 overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                  aria-valuenow={group.done}
                  aria-valuemin={0}
                  aria-valuemax={group.total}
                >
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      group.done === group.total ? "bg-green/80" : "bg-foreground/40",
                    )}
                    style={{ width: `${group.total === 0 ? 0 : (group.done / group.total) * 100}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                  {group.done}/{group.total}
                </span>
              </div>
            ))}
          </div>
        </div>
      )

    case "code-ref":
      return (
        <div>
          <HydratedCode
            path={element.path}
            startLine={element.startLine}
            endLine={element.endLine}
            highlightLines={element.highlightLines}
          />
        </div>
      )

    case "code":
      return (
        <div>
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
          <RichText text={element.text} paragraphClassName="leading-relaxed" />
        </div>
      )

    case "finding":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                element.severity === "high" && "bg-destructive/15 text-destructive",
                element.severity === "medium" && "bg-warn-soft text-warn",
                element.severity === "low" && "bg-secondary text-muted-foreground",
              )}
            >
              {element.severity}
            </span>
            <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-foreground">
              <InlineCode text={element.title} />
            </h3>
            <Concurrence agreement={element.agreement} />
          </div>
          <RichText text={element.body} paragraphClassName="text-[13.5px] leading-relaxed text-foreground/90" />
          {element.details?.map((detail) => (
            <div key={detail.heading} className="flex flex-col gap-1.5">
              <h4 className="text-[14px] font-semibold text-foreground">
                <InlineCode text={detail.heading} />
              </h4>
              <RichText
                text={detail.body}
                paragraphClassName="text-[13.5px] leading-relaxed text-foreground/85"
              />
            </div>
          ))}
          {element.fix && <FixCallout fix={element.fix} findingTitle={element.title} anchor={element.anchor} />}
          {element.anchor && <AnchorReveal anchors={[element.anchor]} />}
        </div>
      )

    case "annotation":
      return (
        <div className="flex items-start gap-2 pl-1">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <AnchorReveal anchors={[element.anchor]} />
            <RichText text={element.text} paragraphClassName="text-[13.5px] leading-relaxed text-foreground/90" />
          </div>
        </div>
      )

    case "thread":
      return (
        <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
          {element.anchor && <AnchorReveal anchors={[element.anchor]} />}
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
        <div className="rounded-md border border-border px-3 py-2.5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-[13.5px] font-medium leading-snug text-foreground">
                <InlineCode text={element.statement} />
              </span>
              {element.inferred && (
                <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  inferred
                </span>
              )}
            </div>
            <RichText
              text={element.why}
              className="pl-5"
              paragraphClassName="text-[13px] leading-relaxed text-foreground/85"
            />
            {element.alternatives.length > 0 && (
              <p className="pl-5 text-[12.5px] leading-relaxed text-muted-foreground">
                Not taken: <InlineCode text={element.alternatives.join(" · ")} />
              </p>
            )}
            {element.excerpts && element.excerpts.length > 0 ? (
              <div className="pl-5 pt-1">
                <CodeTabs excerpts={element.excerpts} />
              </div>
            ) : (
              <div className="pl-5">
                <AnchorReveal anchors={element.evidence} />
              </div>
            )}
          </div>
        </div>
      )

    case "requirement":
      return (
        <div>
          <div className="flex flex-col gap-1.5">
            {element.name ? (
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-semibold text-foreground">{element.name}</h3>
                {element.delta && <DeltaBadge delta={element.delta} />}
              </div>
            ) : null}
            <RichText
              text={element.text}
              keywords
              paragraphClassName="text-[13.5px] leading-relaxed text-foreground/90"
            />
            {element.scenarios && element.scenarios.length > 0 && (
              <ul className="flex flex-col gap-1">
                {element.scenarios.map((scenario, index) => (
                  <li key={index} className="flex gap-1.5 text-[13px] leading-relaxed text-foreground/75">
                    <span aria-hidden="true" className="select-none text-muted-foreground/60">
                      ‣
                    </span>
                    <RichText text={scenario} keywords paragraphClassName="leading-relaxed" />
                  </li>
                ))}
              </ul>
            )}
            {(element.coverage || (element.refs && element.refs.length > 0)) && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <CoverageChip status={element.status} coverage={element.coverage} />
                {element.refs?.map((ref) => (
                  <span
                    key={ref}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {ref}
                  </span>
                ))}
              </div>
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
        <h3 className="text-[14.5px] font-medium text-foreground">{element.label}</h3>
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
        concur ? "border-green-line text-green" : "border-model-line text-model",
      )}
      title={concur ? "Both models raised this" : "Models disagree"}
    >
      {concur ? "concur 2/2" : agreement.claude ? "Claude only" : "Codex only"}
    </span>
  )
}

/**
 * A finding's fix as an actionable callout. On a teammate PR the action stages
 * a request-change ask (R29); the button is its own receipt and undo.
 */
function FixCallout({
  fix,
  findingTitle,
  anchor,
}: {
  fix: string
  findingTitle: string
  anchor?: { path: string; line: number }
}) {
  const store = useCodeComments()
  const [askId, setAskId] = React.useState<string | null>(null)
  const staged = askId !== null && (store?.asks ?? []).some((ask) => ask.id === askId)

  function toggle() {
    if (!store) return
    if (staged && askId) {
      store.unstageAsk(askId)
      setAskId(null)
      return
    }
    setAskId(store.stageAsk(fix, "request-change", `finding: ${findingTitle.slice(0, 56)}`, anchor))
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Fix</span>
      <RichText text={fix} paragraphClassName="text-[13px] leading-relaxed text-foreground/90" />
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "rounded px-2.5 py-1 text-[12px] transition-colors",
            staged
              ? "border border-border bg-secondary/60 text-muted-foreground"
              : "bg-foreground font-medium text-background hover:bg-foreground/90",
          )}
        >
          {staged ? "Staged · Request Change ✓" : "Request This Change"}
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          Discuss
        </button>
      </div>
    </div>
  )
}

function SmallLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  )
}

function DeltaBadge({ delta }: { delta: "added" | "modified" | "removed" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        delta === "added" && "bg-green-soft text-green",
        delta === "modified" && "bg-secondary text-muted-foreground",
        delta === "removed" && "bg-destructive/15 text-destructive",
      )}
    >
      {delta}
    </span>
  )
}

/**
 * The coverage chip wires a requirement to the diff: covered links to its
 * claiming hunks; zero hunks renders an honest "unimplemented".
 */
function CoverageChip({
  status,
  coverage,
}: {
  status?: "covered" | "partial" | "unimplemented"
  coverage?: { hunks: number; tests: number }
}) {
  // No coverage = no relation to render (proposal-stage board: coverage is a
  // relation to an implementation patchset, and none exists).
  if (!coverage) return null
  const label =
    status === "unimplemented"
      ? `unimplemented · ${coverage.hunks} hunks`
      : `covered by ${coverage.hunks} ${coverage.hunks === 1 ? "hunk" : "hunks"} · ${coverage.tests} ${
          coverage.tests === 1 ? "test" : "tests"
        }${status === "partial" ? " · partial" : ""}`

  return (
    <button
      type="button"
      title={status === "unimplemented" ? "No hunk claims this requirement" : "Jump to the claiming hunk"}
      className={cn(
        "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors",
        status === "covered" && "border-green-line text-green hover:bg-green-soft",
        status === "partial" && "border-warn-line text-warn hover:bg-warn-soft",
        status === "unimplemented" && "border-warn-line text-warn hover:bg-warn-soft",
      )}
    >
      <Link2 className="size-3" aria-hidden="true" />
      {label}
    </button>
  )
}



