/**
 * sequence fixture, agent-drafted from PR #438 via packages/lens-instructions
 * (post-lanes rubric), unslop-edited.
 */

import type { LensBoard } from "@/lib/lens-data"

export const sequenceBoard: LensBoard = {
  lens: "sequence",
  title: "Observe the GitHub token refresh, drop the unsafe retry",
  intro:
    "The token's lifetime was not the bug. Renewal was invisible. The refresh exchange emitted zero logs, so on lancelot a failed refresh surfaced as token-invalid and forced a device-flow re-auth. You couldn't tell a decline apart from a network blip or a refresh that never ran. Read the change ground-up: the shape of a single observation, then how it stays secret-free, then where it's emitted and why the network path only observes, then the daemon sink, then the tests.",
  skippedHunks: [
    { path: "openspec/changes/github-token-refresh-reliability/.openspec.yaml", reason: "generated scaffold stamp — noise" },
    { path: "openspec/changes/github-token-refresh-reliability/proposal.md", reason: "spec artifact — Design lens" },
    { path: "openspec/changes/github-token-refresh-reliability/design.md", reason: "spec artifact — Design lens" },
    {
      path: "openspec/changes/github-token-refresh-reliability/specs/github-token-refresh/spec.md",
      reason: "spec artifact — Design lens",
    },
    { path: "openspec/changes/github-token-refresh-reliability/tasks.md", reason: "spec artifact — Design lens" },
    {
      path: "packages/adapters/src/index.ts",
      reason: "mechanical barrel re-export of RefreshLogRecord and tokenKind; both symbols are taught at earlier stops",
    },
  ],
  sections: [
    {
      id: "record-shape",
      title: "The shape of an observation, secret-free by construction",
      gist: "RefreshLogRecord is the type every refresh observation takes; no field on it can hold a credential.",
      counts: "1 prose · 1 code",
      elements: [
        {
          kind: "prose",
          text: "Everything else in this change either produces or consumes one thing, so read it first. That thing is the record. RefreshLogRecord is the shape of a single refresh observation, and its safety is structural. No field on the type can hold a token, a refresh token, or a client secret, so a credential cannot be logged even by mistake. Once you understand this type, the rest of the change is just the points that emit a record and the one place that turns it into a log line. The phase field is the outcome, an attempt followed by persisted, declined, or network. The two optional fields carry the only non-secret detail an outcome ever needs.",
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
      ],
    },
    {
      id: "token-kind",
      title: "The one non-secret detail, kept safe by a closed allowlist",
      gist: "tokenKind returns only an allowlisted prefix or the fixed \"token\", never a slice of the credential body.",
      counts: "1 prose · 1 code · 1 annotation",
      elements: [
        {
          kind: "prose",
          text: "The record's tokenKind field is the only place a record touches the credential at all, so it's where the secret-free promise could break. Its job is small. It lets a reader of the log tell a ghu_ user-to-server token apart from a gho_ OAuth token. The obvious implementation, split on the first underscore, would drop a slice of an unexpected credential body straight into the log. tokenKind refuses that. It matches the token against a closed allowlist of GitHub prefixes and returns one of those constants, or the fixed string \"token\" when nothing matches. That is why a record can carry a kind without carrying a secret.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 67,
          lang: "typescript",
          highlightLines: [88],
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
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 88 },
          text: "The ?? \"token\" fallback carries the whole safety property. An unrecognized value collapses to a fixed constant, so tokenKind(\"customerSecret_body\") is \"token\", never the \"customerSecret_\" slice. A test pins exactly that adversarial case.",
        },
      ],
    },
    {
      id: "emit-and-observe",
      title: "Emit at every outcome, and refuse to retry the network case",
      gist: "refreshAndPersist logs attempt, then declined, network, or persisted; the network branch only observes and propagates, no retry.",
      counts: "1 prose · 1 code · 1 callout",
      elements: [
        {
          kind: "prose",
          text: "With the record and its secret-safety settled, this is the one place that produces records. Inside the account lock, refreshAndPersist emits an attempt record before calling refresh(), so an attempt is visible in daemon.log even if the process dies mid-exchange, and both the proactive (near-expiry) and reactive (on a 401) branches route through here. The exchange then resolves to exactly one outcome. A GitHubOAuthDeclined is deterministic, so it logs declined with GitHub's verbatim error code and returns null, and the caller resolves token-invalid. A success logs persisted with the rotated token's kind. The third outcome, a network error, is the one this change deliberately does not retry. It logs network and rethrows. The log dependency is optional and defaults to a no-op, so the adapter stays side-effect-free and testable.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 244,
          lang: "typescript",
          highlightLines: [261],
          code: `    log({ phase: "attempt" });
    let minted: GitHubCredential;
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
          kind: "callout",
          tone: "warn",
          text: "The no-retry choice is what carries this change. The shared transport (withConnectResilience) already retries a connect-phase blip once, and that retry is replay-safe because no request reached GitHub, so nothing could have rotated. A retry at this layer would instead key off isGitHubNetworkError, which also matches post-send errors, where the refresh POST may have already reached GitHub and rotated the pair. Replaying then spends a token GitHub has already rotated and burns the session. An earlier draft carried that second retry. This change drops it, so the layer now only observes network and propagates with the credential byte-untouched. The accepted consequence, per design.md: after a post-send loss where GitHub did rotate, the stored pair is stale and the next resolve declines, and an attempt followed by a declined bad_refresh_token is the tell. Clearing the credential on a persistent decline is left as a deferred open question, so this change stays observe-only.",
        },
      ],
    },
    {
      id: "daemon-sink",
      title: "Wire the sink at the composition boundary",
      gist: "create-server binds one log that serializes each secret-free record to a single [github-auth] line on the daemon's stdout.",
      counts: "1 prose · 1 code",
      elements: [
        {
          kind: "prose",
          text: "The adapter only produces records. Something at the edge must turn them into log lines, and that belongs at the composition boundary rather than inside the testable adapter. create-server binds the concrete logger next to the refresh and withLock deps, formatting each record as one [github-auth] line on the daemon's stdout, which the daemon captures to daemon.log. Because RefreshLogRecord has no secret field, the formatter reads only phase, githubError, and tokenKind, none of which can be a credential, so the seam cannot leak one either.",
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
      title: "Tests pin the exact record sequences",
      gist: "The network test pins the [attempt, network] sequence and asserts refresh() is called exactly once, the machine-checkable no-retry guarantee.",
      counts: "1 prose · 1 code",
      elements: [
        {
          kind: "prose",
          text: "The injected-logger seam pays off here. Tests capture records directly instead of scraping a log sink. The network case is the one that guards this whole change. It pins the exact [attempt, network] sequence with no retry phase, proves the stored credential is byte-identical afterward, and asserts refresh() was called exactly once. That last assertion turns the no-adapter-retry decision from the previous stop into something a test can fail on.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.test.ts",
          startLine: 515,
          lang: "typescript",
          highlightLines: [544],
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
  });`,
        },
      ],
    },
  ],
}
