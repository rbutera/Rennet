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

export const turns: TurnData[] = [
  {
    id: "t0a",
    speaker: "user",
    time: "10:39",
    paragraphs: ["Add ~/dev/orbital as a project."],
  },
  {
    id: "t0b",
    speaker: "orchestrator",
    time: "10:39",
    preface: [
      {
        kind: "action",
        id: "p0a",
        label: "Detected repository",
        detail: "orbital · main",
        state: "done",
        icon: FolderSearch,
      },
      {
        kind: "action",
        id: "p0b",
        label: "Walked 214 files",
        detail: "mapped commit graph",
        state: "done",
        icon: FileText,
      },
      {
        kind: "action",
        id: "p0c",
        label: "Indexed context",
        detail: "1 repo",
        state: "done",
        icon: Search,
      },
    ],
    paragraphs: ["Added orbital — it's under This machine now."],
  },
  {
    id: "t1",
    speaker: "user",
    time: "10:41",
    paragraphs: ["Pull up Priya's PR on the auth refactor."],
  },
  {
    id: "t2",
    speaker: "orchestrator",
    time: "10:41",
    preface: [
      {
        kind: "action",
        id: "p2",
        label: "Fetched pull request #434",
        state: "done",
        icon: GitPullRequest,
      },
      {
        kind: "action",
        id: "p3",
        label: "Cloned branch",
        detail: "auth-refactor-session-scoping",
        state: "done",
        icon: GitBranch,
      },
    ],
    paragraphs: ["Found #434 — auth-refactor-session-scoping. Pulling the diff against main now."],
  },
  {
    id: "t3",
    speaker: "user",
    time: "10:44",
    paragraphs: [
      "Before you start writing anything up — a few things I want covered specifically. First, the session-scoping change touches the token refresh path, and I want to know if the old refresh tokens issued before this lands will still validate, or if we're silently breaking every signed-in session on deploy. Second, Priya renamed SessionContext to ScopedSession in about a third of the call sites but not the rest — flag every place that's still on the old name, since that's the kind of thing that compiles fine and then confuses the next person who greps for it. Third, check whether the new middleware ordering could let an unscoped request through if the scoping header is missing entirely, rather than just malformed — that's the actual security question here, not the happy path. Last, I don't need a summary of what changed, I can read the diff — I need to know what's risky, what's untested, and what you'd push back on if this were your PR.",
    ],
  },
  {
    id: "t4",
    speaker: "orchestrator",
    time: "10:47",
    streaming: true,
    preface: [
      {
        kind: "thought",
        id: "p4",
        state: "streaming",
        seconds: 14,
        text: [
          "Four separate questions here: refresh-token validity across the scoping change, the incomplete SessionContext rename, a middleware-ordering gap on a missing (not malformed) header, and a risk read rather than a summary.",
          "Worth checking the refresh-token claim schema first, since that determines whether existing sessions break on deploy. Then the call-site rename and the middleware order, in that order.",
        ],
      },
      {
        kind: "action",
        id: "p5",
        label: "Read 6 files",
        detail: "packages/api/session, packages/api/middleware",
        state: "done",
        icon: FileText,
      },
      {
        kind: "action",
        id: "p6",
        label: "Searched codebase",
        detail: "SessionContext · 6 matches",
        state: "done",
        icon: Search,
      },
      {
        kind: "thought",
        id: "p7",
        state: "done",
        seconds: 6,
        text: [
          "Middleware order matters here — checking whether the scoping check runs before or after the auth guard short-circuits the request.",
        ],
      },
      {
        kind: "action",
        id: "p8",
        label: "Explored",
        detail: "2 files · 1 search",
        state: "done",
        icon: FolderSearch,
      },
      {
        kind: "action",
        id: "p9",
        label: "Running",
        detail: "pnpm test --filter auth",
        doneLabel: "Ran",
        doneDetail: "pnpm test --filter auth · 12 passed",
        state: "running",
        icon: TerminalSquare,
      },
    ],
    paragraphs: [
      "Confirmed — refresh tokens issued under the old scoping still validate; the migration keeps the legacy claim as a fallback for one release cycle, so nothing breaks on deploy. On the rename, six call sites are still importing SessionContext directly, all in packages/api; none of them touch the refresh path, so it's a stylistic cleanup rather than a functional risk. On the middleware order — the scoping check now runs after the auth guard, and a missing header falls through to the guard's default 401 rather than being treated as an unscoped pass-through, so that path is safe. Biggest thing I'd push back on: the fallback claim only buys one release cycle, and there's no tracking issue yet for removing it — I'd open one before merging so it doesn't quietly become permanent.",
    ],
  },
]

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
