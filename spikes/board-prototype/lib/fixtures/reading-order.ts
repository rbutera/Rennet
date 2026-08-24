/**
 * Reading-order lens fixture — a document-like walkthrough of PR #438
 * ("fix(adapters): observe GitHub token refresh, drop the unsafe retry").
 *
 * Ordered the way a reviewer should READ the change, not the way git lists the
 * files: start where the token-refresh observation begins, then the retry that
 * review removed, then the secret-safety shape, the daemon wiring, and finally
 * the tests. Code excerpts are verbatim from the diff (real paths, hunk-derived
 * start lines); prose narrates the real change only.
 */

import type { LensBoard } from "@/lib/lens-data"

export const readingOrderBoard: LensBoard = {
  lens: "reading-order",
  title: "Observe the GitHub token refresh, drop the unsafe retry",
  intro:
    "The token lifetime was never the bug. Renewal was invisible: the refresh exchange emitted zero logs, so a field failure could only be inferred and had never once been confirmed to succeed. Read the observation change first, then the retry that review took out, then how both are kept secret-free.",
  sections: [
    {
      id: "observation",
      title: "Where understanding starts: make the refresh observable",
      gist: "refreshAndPersist emits an attempt record before the exchange, so a mid-refresh crash still leaves a trace.",
      counts: "3 blocks · 0 findings",
      elements: [
        {
          kind: "prose",
          text: "On lancelot a project.detail PR fetch reported the token expired and forced a device-flow re-auth. The refresh path was fully wired and the store was sound, but it was silent, so nobody could tell a decline from a network blip from a refresh that was never attempted. The fix begins by giving every attempt a shape to record.",
        },
        {
          kind: "prose",
          text: "RefreshLogRecord is that shape, and it is secret-free by construction: there is simply no field on the type that can hold a token, a refresh token, or a client secret, so a credential cannot be logged even by mistake.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 53,
          lang: "typescript",
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
          kind: "prose",
          text: "The attempt record is emitted at the very start of the exchange, inside the account lock, before refresh() is called. Both the proactive (near-expiry) and reactive (on a 401) branches route through refreshAndPersist, so an attempt is always visible in daemon.log even if the process dies mid-exchange.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 231,
          lang: "typescript",
          highlightLines: [244],
          code: `  const refresh = deps.refresh;
  if (!refresh) return null;
  const log: (record: RefreshLogRecord) => void = deps.log ?? (() => undefined);
  const exclusively = deps.withLock ?? (<T>(section: () => Promise<T>) => section());
  return exclusively(async () => {
    const current = await deps.secretStore.getGitHubCredential();
    if (!current) return null; // disconnected while we waited for the lock
    if (current.token !== expected.token) return current; // another caller rotated
    if (!current.refreshToken) return null;
    // Emitted at the START of the exchange (both proactive and reactive branches
    // route through here) so an attempt is visible in daemon.log even if the
    // process dies mid-exchange.
    log({ phase: "attempt" });`,
        },
      ],
    },
    {
      id: "dropped-retry",
      title: "The retry review removed, and why it was unsafe",
      gist: "An earlier draft retried inside refreshAndPersist; it was redundant with the transport and could burn a rotated token. Removed.",
      counts: "1 block · 1 finding · 1 thread",
      elements: [
        {
          kind: "prose",
          text: "The shared GitHub transport, withConnectResilience, already retries a connect-phase blip exactly once, and it is provably replay-safe because no request reached GitHub, so nothing could have rotated. It deliberately never replays a post-send failure, since replaying a sent request could double a rotation. An earlier draft added a second retry here in refreshAndPersist. Review caught it: redundant with the transport, and less safe, because isGitHubNetworkError also matches post-send errors that may have already rotated the pair. So the retry was dropped; the refresh layer now only observes a network failure and propagates it.",
        },
        {
          kind: "callout",
          tone: "warn",
          text: "Retrying a post-send network error is the dangerous case: the refresh POST may have already reached GitHub and rotated the refresh-token pair. A retry then replays with a token GitHub has already spent, burning the rotation and dropping the session. That is exactly the retry this change removed.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 239,
          lang: "typescript",
          highlightLines: [246],
          code: `    let minted: GitHubCredential;
    try {
      minted = await refresh(current.refreshToken);
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
    }
    await deps.secretStore.setGitHubCredential(minted);
    log({ phase: "persisted", tokenKind: tokenKind(minted.token) });
    return minted;`,
        },
        {
          kind: "finding",
          id: "F-438-retry-ownership",
          title: "isGitHubNetworkError still gates the network record, and that is the right call",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body: "The same matcher that made an adapter-level retry unsafe (it matches post-send errors, not just connect-phase ones) is reused here only to decide whether to emit a `network` record before rethrowing. That is safe: emitting a log line and propagating never touches the credential or replays the request. A `declined` (GitHubOAuthDeclined) short-circuits above it and returns null so the surface resolves `token-invalid`; anything isGitHubNetworkError matches is logged `network` and rethrown for resolveGitHubAuth to classify with the stored credential byte-untouched. Retry ownership stays entirely in the transport. Confirm no other adapter path re-wraps this throw into a retry.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 254 },
        },
        {
          kind: "thread",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 246 },
          messages: [
            {
              author: "user",
              text: "If refresh() throws a post-send timeout after GitHub already rotated the pair, we log `network` and rethrow — but the stored credential still holds the OLD refresh token. Isn't that now stale, so the next attempt declines?",
            },
            {
              author: "orchestrator",
              text: "It can be, and that outcome is intended over the alternative. On a network throw we make zero writes, so the stored pair is byte-identical to before — resolveGitHubAuth surfaces `network`, not `token-invalid`. If GitHub really did rotate on that lost response, the next resolve refreshes with the old token and GitHub answers 200-with-error; we then log `declined` with the verbatim code and degrade to a clean reconnect. The change accepts one possibly-wasted attempt to guarantee we never replay a spent token.",
            },
            {
              author: "user",
              text: "Good — but then the log lies a little: it says `network` when the token was actually spent. Can we tell those apart?",
            },
            {
              author: "orchestrator",
              text: "Not from the network record alone, no — a post-send loss is genuinely ambiguous at that layer. What disambiguates it is the NEXT record: an `attempt` followed by `declined` with `bad_refresh_token` is the tell that the earlier `network` had in fact rotated. The sequence in daemon.log carries the truth even though a single line cannot.",
            },
            {
              author: "user",
              text: "Then let's not leave that implicit. Add a follow-up to proactively clear the credential on a persistent decline so status reads not-connected instead of re-attempting a dead refresh each resolve — the open question in design.md. Keep this PR observe-only.",
            },
            {
              author: "orchestrator",
              text: "Agreed, filing it against the deferred open question and leaving this PR's state machine untouched. This change stays observe-only; the proactive-clear decision rides separately once the log shows whether the field actually churns.",
            },
          ],
        },
      ],
    },
    {
      id: "secret-free",
      title: "Secret-free by construction: tokenKind is a closed allowlist",
      gist: "tokenKind returns only an allowlisted prefix or the fixed \"token\", never a slice of the credential body.",
      counts: "2 blocks · 1 annotation",
      elements: [
        {
          kind: "prose",
          text: "The one non-secret detail a record may carry is the token KIND — enough to tell a ghu_ user-to-server token from a gho_ OAuth token when reading the log. The danger is doing that with a naive prefix split, which would put a slice of an unexpected credential body straight into the log. tokenKind avoids that by matching against a closed allowlist and returning only a constant.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 66,
          lang: "typescript",
          highlightLines: [23],
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
] as const;

/**
 * The non-secret token-kind label of a GitHub credential — an allowlisted prefix
 * (\`ghu_\`/\`gho_\`/…) or the fixed \`"token"\`. Returns only a constant, never any part
 * of the token body: safe to put in a log record by construction.
 */
export function tokenKind(token: string): string {
  return GITHUB_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? "token";
}`,
        },
        {
          kind: "annotation",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 87 },
          text: "The ?? \"token\" fallback is the whole safety property: an unrecognized value collapses to a fixed constant, so tokenKind(\"customerSecret_body\") returns \"token\", never the \"customerSecret_\" slice. A test asserts exactly this adversarial case.",
        },
      ],
    },
    {
      id: "daemon-wiring",
      title: "Wire the logger at the composition boundary",
      gist: "create-server binds one log that writes each record as a single [github-auth] line to daemon.log.",
      counts: "1 block · 0 findings",
      elements: [
        {
          kind: "prose",
          text: "The adapter stays side-effect-free: it takes an optional log dependency and defaults it to a no-op, so tests capture records and production formatting lives at the seam. create-server binds the concrete logger, serializing each secret-free record to one line on the daemon's stdout, which is captured to daemon.log. Because RefreshLogRecord has no secret field, nothing this formatter reads can be a credential.",
        },
        {
          kind: "code",
          path: "packages/server/src/create-server.ts",
          startLine: 617,
          lang: "typescript",
          code: `      secretStore: gitHubSecretStore,
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
      },`,
        },
      ],
    },
    {
      id: "tests",
      title: "Tests: exact record sequences and sentinel secret-safety",
      gist: "Nine new/tightened tests pin the ordered records, the exactly-once refresh call, the allowlist, and that no sentinel token ever reaches a record.",
      counts: "2 blocks · 0 findings",
      elements: [
        {
          kind: "prose",
          text: "The tests assert on captured records rather than on a log sink, which is what the injected logger seam buys. The network case is the load-bearing one: it pins the exact [attempt, network] sequence, proves the stored credential is byte-unchanged, and asserts refresh() was called EXACTLY ONCE — the machine-checkable form of the no-adapter-retry guarantee.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.test.ts",
          startLine: 273,
          lang: "typescript",
          highlightLines: [55],
          code: `  it("a NETWORK-failing refresh emits exactly [attempt, network], resolves network, leaves the credential untouched, and calls refresh() exactly once", async () => {
    const original: GitHubCredential = {
      token: "gho_dying",
      expiresAt: SOON,
      refreshToken: "ghr_1",
    };
    const store = memoryStore({ ...original });
    const records: RefreshLogRecord[] = [];
    const networkError = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const refresh = vi.fn(() => Promise.reject(networkError));
    const state = await resolveGitHubAuth({
      octokit: octokitFor({}),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
    // Exactly attempt then network — no retry phase, no extra records.
    expect(records).toEqual([{ phase: "attempt" }, { phase: "network" }]);
    // The stored credential is byte-unchanged: no write happened at all.
    expect(store.writes).toEqual([]);
    expect(store.current()).toEqual(original);
    // The no-adapter-retry guarantee: the transport (not github-auth) owns retry.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a SUCCESSFUL refresh emits a \`persisted\` record with an allowlisted tokenKind, and persists the rotated pair", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_1" });
    const records: RefreshLogRecord[] = [];
    const refresh = vi.fn(() => Promise.resolve(ROTATED_GHU));
    const fetch: typeof globalThis.fetch = (input) =>
      Promise.resolve(new URL(String(input)).pathname === "/rate_limit" ? rateLimitOk() : userOk());
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(true);
    const persisted = records.find((r) => r.phase === "persisted");
    expect(persisted).toBeDefined();
    expect(persisted?.tokenKind).toBe("ghu_");
    expect(store.current()).toEqual(ROTATED_GHU);
  });

  it("maps an unrecognized value to the fixed 'token' label, never a slice of it", () => {
    // Must NEVER return "customerSecret_" — that would leak a slice of an
    // unexpected credential body into a log record.
    expect(tokenKind("customerSecret_body")).toBe("token");
    expect(tokenKind("customerSecret_body")).not.toBe("customerSecret_");
  });`,
        },
      ],
    },
  ],
}
