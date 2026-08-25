import { GitPullRequest, GitBranch, FileText, Search, FolderSearch, TerminalSquare, type LucideIcon } from "lucide-react"

export type Speaker = "user" | "orchestrator"

export interface ThoughtStep {
  kind: "thought"
  id: string
  state: "done" | "streaming"
  seconds?: number
  text: string[]
}

export interface ActionStep {
  kind: "action"
  id: string
  label: string
  detail?: string
  state: "done" | "running"
  /** Label to switch to once a "running" step resolves on its own. */
  doneLabel?: string
  /** Detail to switch to once a "running" step resolves on its own. */
  doneDetail?: string
  icon: LucideIcon
}

export type ActivityStep = ThoughtStep | ActionStep

export interface TextBlock {
  kind: "text"
  text: string
}

export interface CodeBlockContent {
  kind: "code"
  path: string
  lang?: string
  code: string
  startLine?: number
  highlightLines?: number[]
}

export type ContentBlock = TextBlock | CodeBlockContent

export interface TurnData {
  id: string
  speaker: Speaker
  time: string
  paragraphs: string[]
  streaming?: boolean
  /** A short line of prose shown before the activity sequence starts. */
  lead?: string
  preface?: ActivityStep[]
  /** Richer reply content (prose interleaved with code blocks). Takes precedence over `paragraphs` when present. */
  body?: ContentBlock[]
}

export interface Exchange {
  user: TurnData
  orchestrator: TurnData
}

export const followUpExchanges: Exchange[] = [
  {
    user: {
      id: "follow-up-user-1",
      speaker: "user",
      time: "10:52",
      paragraphs: [
        "Once the tests pass, can you check whether the middleware change affects any public API routes that don't require auth?",
      ],
    },
    orchestrator: {
      id: "follow-up-orchestrator-1",
      speaker: "orchestrator",
      time: "10:52",
      preface: [
        {
          kind: "thought",
          id: "f1",
          state: "streaming",
          seconds: 4,
          text: [
            "Public routes should already skip the scoping middleware entirely — worth confirming the reorder didn't widen the route matcher in the process.",
          ],
        },
        {
          kind: "action",
          id: "f2",
          label: "Searched codebase",
          detail: "public route matcher · 3 matches",
          state: "done",
          icon: Search,
        },
        {
          kind: "action",
          id: "f3",
          label: "Read 2 files",
          detail: "packages/api/middleware/matcher.ts",
          state: "done",
          icon: FileText,
        },
        {
          kind: "action",
          id: "f4",
          label: "Running",
          detail: "pnpm test --filter routes",
          doneLabel: "Ran",
          doneDetail: "pnpm test --filter routes · 7 passed",
          state: "running",
          icon: TerminalSquare,
        },
      ],
      paragraphs: [
        "No impact — the matcher still excludes those three public routes by path prefix before the scoping check ever runs, and the reorder only changes behavior for routes that were already behind auth. I'd still add a regression test pinned to that matcher, since it's the kind of exclusion that's easy to widen by accident later.",
      ],
    },
  },
  {
    user: {
      id: "follow-up-user-2",
      speaker: "user",
      time: "10:55",
      paragraphs: ["Show me the code where she added that missing-header check — the actual diff, not a description."],
    },
    orchestrator: {
      id: "follow-up-orchestrator-2",
      speaker: "orchestrator",
      time: "10:55",
      lead: "Sure — pulling the actual diff rather than paraphrasing it.",
      preface: [
        {
          kind: "action",
          id: "c1",
          label: "Read 2 files",
          detail: "packages/api/middleware/index.ts, scope-guard.ts",
          state: "done",
          icon: FileText,
        },
        {
          kind: "action",
          id: "c2",
          label: "Searched codebase",
          detail: "requireScope · 4 matches",
          state: "done",
          icon: Search,
        },
      ],
      body: [
        {
          kind: "text",
          text: "Here's the composed order the request actually goes through:",
        },
        {
          kind: "code",
          path: "packages/api/middleware/index.ts",
          startLine: 12,
          highlightLines: [14, 15],
          code: `export const middleware = compose(
  authGuard,
  scopeGuard,
  requestLogger,
)`,
        },
        {
          kind: "text",
          text: "And the guard she changed — this is the part your third question was really about:",
        },
        {
          kind: "code",
          path: "packages/api/middleware/scope-guard.ts",
          startLine: 34,
          highlightLines: [42, 43, 44],
          code: `export async function scopeGuard(req: NextRequest) {
  const session = await verifySession(req)

  if (!session) {
    return unauthorized("missing session")
  }

  const scopeHeader = req.headers.get("x-session-scope")

  if (!scopeHeader) {
    return unauthorized("missing scope header")
  }

  requireScope(session, scopeHeader)

  return NextResponse.next()
}`,
        },
        {
          kind: "text",
          text: "So a missing header can't slip through unscoped — it's rejected on line 43, before requireScope ever runs. The only path that reaches requireScope is one with both a valid session and a scope header present, which is what you'd want here.",
        },
      ],
      paragraphs: [],
    },
  },
]
