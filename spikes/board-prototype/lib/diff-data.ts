/**
 * Patchset fixture for the Diff view — the raw hunks behind the teammate
 * scenario (Priya's auth refactor: session scoping + observable token
 * refresh). The real app hydrates this from the captured patchset; the
 * fixture fakes that hydration the same way lens boards fake theirs.
 */

export interface DiffLine {
  type: "context" | "add" | "del"
  text: string
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  /** Set when status is "renamed". */
  oldPath?: string
  status: "modified" | "added" | "renamed"
  hunks: DiffHunk[]
}

export function hunkHeader(hunk: DiffHunk): string {
  const oldCount = hunk.lines.filter((l) => l.type !== "add").length
  const newCount = hunk.lines.filter((l) => l.type !== "del").length
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`
}

export function fileStats(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++
      if (line.type === "del") deletions++
    }
  }
  return { additions, deletions }
}

export const diffFiles: DiffFile[] = [
  {
    path: "packages/core/src/session/scoped-session.ts",
    oldPath: "packages/core/src/session/session-context.ts",
    status: "renamed",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { type: "context", text: 'import { randomUUID } from "node:crypto"' },
          { type: "context", text: "" },
          { type: "del", text: "export interface SessionContext {" },
          { type: "add", text: "export interface ScopedSession {" },
          { type: "context", text: "  readonly sessionId: string" },
          { type: "add", text: "  /** The workspace this session is scoped to — never undefined after handshake. */" },
          { type: "add", text: "  readonly scopeId: string" },
          { type: "context", text: "  readonly startedAt: number" },
          { type: "context", text: "}" },
          { type: "context", text: "" },
          { type: "del", text: "export function createSessionContext(): SessionContext {" },
          { type: "del", text: "  return { sessionId: randomUUID(), startedAt: Date.now() }" },
          { type: "add", text: "export function createScopedSession(scopeId: string): ScopedSession {" },
          { type: "add", text: '  if (!scopeId) throw new Error("scope required")' },
          { type: "add", text: "  return { sessionId: randomUUID(), scopeId, startedAt: Date.now() }" },
          { type: "context", text: "}" },
        ],
      },
    ],
  },
  {
    path: "packages/server/src/middleware/scope-guard.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 18,
        newStart: 18,
        lines: [
          { type: "context", text: "export function scopeGuard(req: Request, res: Response, next: NextFunction) {" },
          { type: "del", text: '  const scope = req.headers["x-rennet-scope"] ?? DEFAULT_SCOPE' },
          { type: "add", text: '  const scope = req.headers["x-rennet-scope"]' },
          { type: "add", text: "  // A missing scope header is a hard reject — absent and malformed both 403." },
          { type: "add", text: '  if (typeof scope !== "string" || scope.length === 0) {' },
          { type: "add", text: '    return res.status(403).json({ error: "scope-missing" })' },
          { type: "add", text: "  }" },
          { type: "context", text: "  if (!VALID_SCOPE.test(scope)) {" },
          { type: "context", text: '    return res.status(403).json({ error: "scope-invalid" })' },
          { type: "context", text: "  }" },
          { type: "context", text: "  next()" },
          { type: "context", text: "}" },
        ],
      },
    ],
  },
  {
    path: "packages/adapters/src/github/token-refresh.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 42,
        newStart: 42,
        lines: [
          { type: "context", text: "  async refresh(token: StoredToken): Promise<RefreshOutcome> {" },
          { type: "del", text: '    const response = await this.transport.post("/login/oauth/access_token", body)' },
          { type: "del", text: "    if (!response.ok) return this.retryOnce(token)" },
          { type: "add", text: "    // Retry ownership moved to the shared transport: a replayed post-send" },
          { type: "add", text: "    // failure here could double-rotate the credential." },
          { type: "add", text: '    const response = await this.transport.post("/login/oauth/access_token", body)' },
          { type: "add", text: "    if (!response.ok) return classifyFailure(response)" },
          { type: "context", text: "    const next = parseToken(response.body)" },
          { type: "add", text: '    logRefresh({ outcome: "rotated", tokenId: token.id })' },
          { type: "context", text: '    return { kind: "rotated", token: next }' },
          { type: "context", text: "  }" },
        ],
      },
      {
        oldStart: 71,
        newStart: 73,
        lines: [
          { type: "context", text: "  }" },
          { type: "context", text: "" },
          { type: "del", text: "  private async retryOnce(token: StoredToken): Promise<RefreshOutcome> {" },
          { type: "del", text: "    await delay(this.backoffMs)" },
          { type: "del", text: "    return this.refresh(token)" },
          { type: "del", text: "  }" },
          { type: "context", text: "}" },
        ],
      },
    ],
  },
  {
    path: "packages/adapters/src/github/refresh-log.ts",
    status: "added",
    hunks: [
      {
        oldStart: 0,
        newStart: 1,
        lines: [
          { type: "add", text: 'import { appendFile } from "node:fs/promises"' },
          { type: "add", text: 'import { DAEMON_LOG } from "../paths"' },
          { type: "add", text: "" },
          { type: "add", text: "/** Secret-free record of one refresh attempt (observable renewal). */" },
          { type: "add", text: "export interface RefreshLogRecord {" },
          { type: "add", text: "  tokenId: string" },
          { type: "add", text: '  outcome: "rotated" | "declined" | "network"' },
          { type: "add", text: "  at: string" },
          { type: "add", text: "}" },
          { type: "add", text: "" },
          { type: "add", text: 'export async function logRefresh(record: Omit<RefreshLogRecord, "at">) {' },
          { type: "add", text: "  const line = JSON.stringify({ ...record, at: new Date().toISOString() })" },
          { type: "add", text: "  await appendFile(DAEMON_LOG, `${line}\\n`)" },
          { type: "add", text: "}" },
        ],
      },
    ],
  },
  {
    path: "packages/adapters/test/token-refresh.test.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 12,
        newStart: 12,
        lines: [
          { type: "context", text: 'describe("token refresh", () => {' },
          { type: "add", text: '  it("rejects a request with no scope header", async () => {' },
          { type: "add", text: '    const res = await request(app).post("/refresh")' },
          { type: "add", text: "    expect(res.status).toBe(403)" },
          { type: "add", text: "  })" },
          { type: "add", text: "" },
          { type: "add", text: '  it("classifies a GitHub decline as token-invalid", async () => {' },
          { type: "add", text: '    transport.failWith(401, "bad_refresh_token")' },
          { type: "add", text: "    const outcome = await refresher.refresh(expired)" },
          { type: "add", text: '    expect(outcome.kind).toBe("declined")' },
          { type: "add", text: "  })" },
          { type: "add", text: "" },
          { type: "context", text: '  it("rotates on a valid refresh", async () => {' },
        ],
      },
    ],
  },
]
