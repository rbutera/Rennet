/**
 * Lens-board data model for the prototype — a pragmatic cut of the board
 * block-kind vocabulary (CONTEXT.md): sections of typed elements. Code is
 * carried literally here (the real app cites and hydrates from the patchset;
 * a fixture fakes the hydration).
 */

export type LensId = "design" | "sequence" | "decisions" | "flagged" | "noise"

export interface CodeAnchor {
  path: string
  line: number
}

/** A code slice an element carries for its tabbed viewer (one tab per excerpt). */
export interface CodeExcerpt {
  path: string
  startLine: number
  code: string
  lang?: string
  highlightLines?: number[]
}

export type BoardElement =
  | { kind: "prose"; text: string }
  | {
      kind: "spec-header"
      /** The change/feature name the spec artifacts describe. */
      change: string
      /** Where the spec was discovered, e.g. "openspec/changes/observe-github-token-refresh". */
      source: string
      /** Which spec format the discovery matched (drives the source chip label). */
      format: "OpenSpec" | "Kiro" | "BMAD" | "Superpowers"
      counts: { added: number; modified: number }
      tasks?: { done: number; total: number }
      /** The distilled why — one paragraph, not the raw proposal. */
      why: string
      /** The artifact set the discovery found (proposal/design/spec deltas/tasks), each jumping to its section. */
      artifacts?: { label: string; sectionId: string }[]
    }
  | {
      kind: "what-changes"
      rows: { tag: string; text: string }[]
      /** Blast/impact summary rendered beside the spine. */
      impact?: string
    }
  | {
      kind: "capability-grid"
      capabilities: {
        slug: string
        state: "added" | "modified"
        requirements: number
        scenarios: number
        /** Board section this card jumps to when clicked. */
        sectionId: string
      }[]
    }
  | {
      kind: "task-progress"
      source?: string
      groups: { label: string; done: number; total: number }[]
    }
  | {
      kind: "code"
      path: string
      startLine: number
      code: string
      highlightLines?: number[]
      lang?: string
    }
  | { kind: "callout"; tone: "info" | "warn"; text: string }
  | {
      kind: "finding"
      id: string
      title: string
      severity: "high" | "medium" | "low"
      /** Cross-model concurrence: which review seats raised or endorsed it. */
      agreement: { claude: boolean; codex: boolean }
      /** Short claim summary; the members of the failure live in `details`. */
      body: string
      /** Subheaded parts of the scenario (e.g. one per input class). */
      details?: { heading: string; body: string }[]
      /** The proposed remedy, rendered as an actionable callout. */
      fix?: string
      anchor?: CodeAnchor
    }
  | { kind: "annotation"; anchor: CodeAnchor; text: string }
  | {
      kind: "thread"
      anchor?: CodeAnchor
      messages: { author: "user" | "orchestrator"; text: string }[]
    }
  | {
      kind: "decision"
      statement: string
      why: string
      /** Labeled inferred when reconstructed rather than stated by the implementer. */
      inferred: boolean
      alternatives: string[]
      evidence: CodeAnchor[]
      /** Evidence rendered as a tabbed code viewer — one tab per excerpt. */
      excerpts?: CodeExcerpt[]
    }
  | {
      kind: "requirement"
      /** Short requirement name, rendered as the row title (the SHALL text is the body). */
      name?: string
      /** Delta state from the change spec (ADDED/MODIFIED/REMOVED headers). */
      delta?: "added" | "modified" | "removed"
      text: string
      status: "covered" | "partial" | "unimplemented"
      coverage: { hunks: number; tests: number }
      scenarios?: string[]
      /** Related file chips beside the coverage chip (e.g. the claiming test file). */
      refs?: string[]
    }
  | {
      kind: "noise-group"
      label: string
      judgedBy: "rule" | "llm"
      reason: string
      hunks: { path: string; summary: string }[]
    }

export interface BoardSection {
  id: string
  title: string
  /** Renders folded on first paint (secondary material like cleared concerns). */
  startFolded?: boolean
  /** Delta badge beside the title (capability sections on the spec board). */
  badge?: "added" | "modified"
  /** The artifact file this section renders (spec-board provenance chip). */
  source?: string
  /** One-line rollup shown when the section is folded. */
  gist: string
  /** Small counts shown beside the gist when folded, e.g. "3 blocks · 1 finding". */
  counts?: string
  elements: BoardElement[]
}

export interface LensBoard {
  lens: LensId
  title: string
  /** Optional short intro prose above the first section. */
  intro?: string
  /** Widens the document column (structured-artifact boards like Design). */
  wide?: boolean
  /**
   * Hunks this lens consciously left to other lenses. Pipeline coverage data:
   * the composition step checks every patchset hunk lands in some lens's
   * taught-or-skipped set. Never rendered on the board.
   */
  skippedHunks?: { path: string; reason: string }[]
  sections: BoardSection[]
}
