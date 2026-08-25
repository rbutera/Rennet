import type { LensBoard } from "../lens-data"

/**
 * decisions fixture, agent-drafted from PR #438 via packages/lens-instructions
 * (post-lanes rubric), unslop-edited.
 */
export const decisionsBoard: LensBoard = {
  lens: "decisions",
  title: "Decisions",
  intro:
    "Judgment calls inside a change that makes the daemon's GitHub token refresh observable in daemon.log and removes a second, unsafe retry.",
  skippedHunks: [
    {
      path: "packages/adapters/src/github-auth.test.ts",
      reason: "Test coverage of the new records, requirement-coverage material.",
    },
    {
      path: "packages/adapters/src/index.ts",
      reason: "Mechanical re-export of RefreshLogRecord/tokenKind, a rename-tier hunk.",
    },
    {
      path: "openspec/changes/github-token-refresh-reliability/proposal.md",
      reason: "Spec artifact. The Design lane renders the proposal shape.",
    },
    {
      path: "openspec/changes/github-token-refresh-reliability/specs/github-token-refresh/spec.md",
      reason: "Requirement deltas. The Design lane owns the SHALL text and coverage.",
    },
    {
      path: "openspec/changes/github-token-refresh-reliability/tasks.md",
      reason: "Task checklist, Design-lane task-progress material.",
    },
  ],
  sections: [
    {
      id: "secret-safe-observability",
      title: "Secret-safe observability",
      gist: "How each refresh is logged without ever putting a credential in daemon.log.",
      counts: "5 decisions · 3 with code tabs",
      elements: [
        {
          kind: "decision",
          statement:
            "The refresh layer emits observations through an injected `log?` callback on `ResolveAuthDeps`, and `create-server` binds the concrete sink that writes to daemon.log.",
          why: "Stated (design.md Decision 1): the adapter stays side-effect-free and testable, tests assert on captured records, and production formatting lives at the composition boundary in create-server. A bare console call in the adapter would make the secret-safety guarantee untestable.",
          inferred: false,
          alternatives: [
            "A bare `console.error`/`console.log` inside the adapter, rejected in design.md Decision 1 because it couples the adapter to a sink and makes the secret-safety guarantee untestable.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 102 },
            { path: "packages/adapters/src/github-auth.ts", line: 234 },
            { path: "packages/server/src/create-server.ts", line: 626 },
          ],
          excerpts: [
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 97,
              lang: "typescript",
              highlightLines: [102],
              code: `  /**
   * Sink for secret-free refresh observations. Absent ⇒ no-op: callers that do
   * not care about the log need not pass it. \`create-server\` binds one that
   * writes each record to the daemon's stdout (→ \`daemon.log\`).
   */
  log?: (record: RefreshLogRecord) => void;
  /**
   * The refresh exchange (\`refreshGitHubCredential\` bound to the daemon's
   * fetch). Absent ⇒ expiring credentials simply die at expiry (token-invalid).
   */
  refresh?: (refreshToken: string) => Promise<GitHubCredential>;`,
            },
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 232,
              lang: "typescript",
              highlightLines: [234],
              code: `  const refresh = deps.refresh;
  if (!refresh) return null;
  const log: (record: RefreshLogRecord) => void = deps.log ?? (() => undefined);
  const exclusively = deps.withLock ?? (<T>(section: () => Promise<T>) => section());
  return exclusively(async () => {`,
            },
            {
              path: "packages/server/src/create-server.ts",
              startLine: 616,
              lang: "typescript",
              highlightLines: [626],
              code: `  const resolveAuth = () =>
    resolveGitHubAuth({
      octokit: bareOctokit,
      secretStore: gitHubSecretStore,
      refresh: (refreshToken) => refreshGitHubCredential({ fetch: publishHttp, refreshToken }),
      withLock: withAccountLock,
      // One single-line, secret-free \`[github-auth]\` record per refresh observation
      // to the daemon's stdout (captured to daemon.log) — so a field refresh
      // failure is read off the log, not inferred. RefreshLogRecord carries no
      // token/secret field, so nothing here can leak a credential.
      log: (record) => {
        const parts = [\`phase=\${record.phase}\`];
        if (record.githubError !== undefined) parts.push(\`githubError=\${record.githubError}\`);
        if (record.tokenKind !== undefined) parts.push(\`tokenKind=\${record.tokenKind}\`);
        console.log(\`[github-auth] \${parts.join(" ")}\`);
      },
    });`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "The log payload is a typed `RefreshLogRecord` carrying only `phase`, an optional `githubError`, and an optional `tokenKind`. No field can hold a token or secret.",
          why: "Stated (design.md Decision 2): make secret-safety a type-level property, not a review promise. With no token/refresh/secret field on the type, a credential cannot be logged by construction, and the create-server serializer can only ever read those three non-secret fields.",
          inferred: false,
          alternatives: [
            "A freeform log line or a record that carries the credential object.",
            "A field holding a masked or length-tagged token, rejected because any secret-carrying field defeats the by-construction guarantee (design.md Decision 2).",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 59 },
            { path: "packages/server/src/create-server.ts", line: 627 },
          ],
          excerpts: [
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 53,
              lang: "typescript",
              highlightLines: [59],
              code: `/**
 * A single refresh-exchange observation, secret-free BY CONSTRUCTION: there is no
 * field that can hold a token, refresh token, or client secret, so a credential
 * cannot be logged even by mistake. \`create-server\` serializes it to one
 * \`[github-auth]\` line in \`daemon.log\`, so a field failure is observed, not inferred.
 */
export interface RefreshLogRecord {
  phase: "attempt" | "persisted" | "declined" | "network";
  /** The verbatim GitHub \`error\` code on a decline (e.g. \`bad_refresh_token\`). */
  githubError?: string;
  /** A non-secret token-kind label (\`ghu_\`/\`gho_\`/…), never the token body. */
  tokenKind?: string;
}`,
            },
            {
              path: "packages/server/src/create-server.ts",
              startLine: 626,
              lang: "typescript",
              highlightLines: [627, 628, 629],
              code: `      log: (record) => {
        const parts = [\`phase=\${record.phase}\`];
        if (record.githubError !== undefined) parts.push(\`githubError=\${record.githubError}\`);
        if (record.tokenKind !== undefined) parts.push(\`tokenKind=\${record.tokenKind}\`);
        console.log(\`[github-auth] \${parts.join(" ")}\`);
      },`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "`tokenKind` returns only a member of a closed prefix allowlist (`ghu_`, `gho_`, …) or the fixed `\"token\"`, never a substring of the token body.",
          why: "Stated (commit dc35701 review finding, tasks.md 1.3): an earlier draft returned everything before the first underscore, which for an unexpected value could log real credential bytes. The closed allowlist makes the label secret-safe by construction. `customerSecret_body` maps to `\"token\"`, not `customerSecret_`.",
          inferred: false,
          alternatives: [
            "Return the substring before the first `_` (the earlier draft), rejected because an unexpected value like `customerSecret_body` would leak a slice of the credential into a log.",
            "Emit no token-kind at all, which loses the non-secret signal that distinguishes a rotated `ghu_` from a stale `gho_`.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 72 },
            { path: "packages/adapters/src/github-auth.ts", line: 87 },
          ],
          excerpts: [
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 67,
              lang: "typescript",
              highlightLines: [72],
              code: `/**
 * GitHub credential prefixes, a CLOSED allowlist. \`tokenKind\` returns ONLY one of
 * these constants (or the fixed \`"token"\`), never a slice of the token — so an
 * unexpected value like \`customerSecret_x\` can never put credential bytes in a log.
 */
const GITHUB_TOKEN_PREFIXES = [
  "github_pat_",
  "ghu_",
  "gho_",
  "ghp_",
  "ghr_",
  "ghs_",
  "ghe_",
] as const;`,
            },
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 82,
              lang: "typescript",
              highlightLines: [87, 88],
              code: `/**
 * The non-secret token-kind label of a GitHub credential — an allowlisted prefix
 * (\`ghu_\`/\`gho_\`/…) or the fixed \`"token"\`. Returns only a constant, never any part
 * of the token body: safe to put in a log record by construction.
 */
export function tokenKind(token: string): string {
  return GITHUB_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? "token";
}`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "`refreshAndPersist` emits an `attempt` record before the refresh call, inside the single branch both proactive and reactive refreshes route through.",
          why: "Stated (tasks.md 4.2): logging the attempt before the exchange keeps it visible in daemon.log even if the process dies mid-refresh. An outcome-only log would leave a crashed attempt with no trace.",
          inferred: false,
          alternatives: [
            "Log only the outcome (persisted/declined/network). A mid-refresh crash then leaves no record that a refresh was even attempted.",
          ],
          evidence: [{ path: "packages/adapters/src/github-auth.ts", line: 244 }],
        },
        {
          kind: "decision",
          statement:
            "The daemon serializes each record as one space-joined `key=value` `[github-auth]` line rather than JSON.",
          why: "Inferred from create-server.ts: the sink builds a flat `phase=… githubError=… tokenKind=…` line, grep-friendly in a mixed daemon.log. design.md Decision 1 specifies only a `single-line record`, not the encoding, so the key=value choice is the code's, not the spec's.",
          inferred: true,
          alternatives: [
            "`JSON.stringify(record)` per line, structured for machine parsing but noisier to eyeball in a mixed daemon.log.",
          ],
          evidence: [{ path: "packages/server/src/create-server.ts", line: 627 }],
        },
      ],
    },
    {
      id: "retry-and-failure",
      title: "Retry ownership and failure outcomes",
      gist: "Who retries a transient blip, and what a genuine decline leaves behind.",
      counts: "2 decisions · 2 with code tabs",
      elements: [
        {
          kind: "decision",
          statement:
            "`refreshAndPersist` adds no retry of its own. A network failure emits a `network` record and propagates, leaving retry to the shared connect-phase transport.",
          why: "Stated (design.md Decision 3 + commit dc35701 review finding): the shared transport `withConnectResilience` already retries a connect-phase blip once, replay-safely, and deliberately never replays a post-send failure. A second retry here would be redundant (up to four connect attempts) and less safe. `isGitHubNetworkError` also matches post-send errors that may have already rotated the pair, so retrying could burn a rotated refresh token.",
          inferred: false,
          alternatives: [
            "Retry inside `refreshAndPersist` on `isGitHubNetworkError` (the earlier draft, commit 8b40985), removed as redundant and unsafe because it risks burning a rotated token on an ambiguous post-send error.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 261 },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              line: 27,
            },
          ],
          excerpts: [
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 246,
              lang: "typescript",
              highlightLines: [261, 262],
              code: `      minted = await refresh(current.refreshToken);
    } catch (error) {
      // A decline is deterministic — name its cause; the surface resolves token-invalid.
      if (error instanceof GitHubOAuthDeclined) {
        log({ phase: "declined", githubError: error.code });
        return null;
      }
      // NO retry here. The shared GitHub transport (\`withConnectResilience\`) already
      // retries a CONNECT-PHASE blip exactly once — provably replay-safe, since no
      // request reached GitHub — and deliberately never replays a post-send failure,
      // which could double a rotation. A second retry at this layer would duplicate
      // connect attempts AND risk burning a rotated refresh token on an ambiguous
      // post-send error. So observe the network failure and propagate it:
      // resolveGitHubAuth classifies it \`network\` and leaves the credential untouched.
      if (isGitHubNetworkError(error)) log({ phase: "network" });
      throw error;
    }`,
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              startLine: 27,
              lang: "markdown",
              code: `**3. Retry ownership stays in the shared transport; \`refreshAndPersist\` only observes.** The GitHub transport (\`withConnectResilience\`, composed in \`create-server\`) already retries a CONNECT-PHASE failure exactly once and deliberately never replays a post-send failure — precisely because replaying a sent request could double a rotation. The refresh POST rides that transport, so the boot-storm \`UND_ERR_CONNECT_TIMEOUT\` case is already covered, replay-safely. \`refreshAndPersist\` therefore adds NO retry of its own; on a network error it emits a \`network\` record and propagates, and \`resolveGitHubAuth\` classifies it \`network\` with the credential untouched. Rationale (review finding): a retry here would be a redundant second layer (up to four connect attempts) AND less safe than the transport, because \`isGitHubNetworkError\` also matches post-send errors that may have already rotated the pair. Alternative (retry inside \`refreshAndPersist\`) rejected for exactly that double-attempt / rotation-burn risk.`,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "A declined refresh returns null (surfacing `token-invalid`) but leaves the stored credential file untouched. Clearing it on a persistent decline is deferred.",
          why: "Stated (design.md Decision 4 + Open Questions): the change leaves persistence and classification unchanged to keep it small. Whether a persistent decline should clear the credential so `status` reads `not-connected` is deferred. The current behavior is acceptable and the new log makes the dead-refresh loop visible, so revisit only if the field shows churn.",
          inferred: false,
          alternatives: [
            "Clear the credential on a persistent decline so `status` reads `not-connected` instead of re-attempting a dead refresh each resolve (design.md Open Questions, deferred).",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 252 },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              line: 43,
            },
          ],
          excerpts: [
            {
              path: "packages/adapters/src/github-auth.ts",
              startLine: 248,
              lang: "typescript",
              highlightLines: [252],
              code: `    } catch (error) {
      // A decline is deterministic — name its cause; the surface resolves token-invalid.
      if (error instanceof GitHubOAuthDeclined) {
        log({ phase: "declined", githubError: error.code });
        return null;
      }`,
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              startLine: 41,
              lang: "markdown",
              code: `## Open Questions

- Should a persistent decline (stored refresh token dead) proactively CLEAR the credential so \`status\` reads \`not-connected\` instead of re-attempting a dead refresh each resolve? Deferred: current behavior (surface \`token-invalid\`, keep the file) is acceptable and the log now makes the loop visible; revisit if the field shows churn.`,
            },
          ],
        },
      ],
    },
  ],
}
