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
      text: string
      status: "covered" | "partial" | "unimplemented"
      coverage: { hunks: number; tests: number }
      scenarios?: string[]
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
  sections: BoardSection[]
}
