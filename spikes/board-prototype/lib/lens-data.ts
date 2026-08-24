/**
 * Lens-board data model for the prototype — a pragmatic cut of the board
 * block-kind vocabulary (CONTEXT.md): sections of typed elements. Code is
 * carried literally here (the real app cites and hydrates from the patchset;
 * a fixture fakes the hydration).
 */

export type LensId = "reading-order" | "spec" | "decisions" | "flagged" | "noise"

export interface CodeAnchor {
  path: string
  line: number
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
      source: string
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
      body: string
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
  /** Delta badge beside the title (capability sections on the spec board). */
  badge?: "added" | "modified"
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
  /** Widens the document column (structured-artifact boards like Spec). */
  wide?: boolean
  sections: BoardSection[]
}
