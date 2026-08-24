/**
 * Decisions lens — built from the real content of rbutera/Rennet PR #438
 * ("fix(adapters): observe GitHub token refresh, drop the unsafe retry").
 *
 * The Decisions lens surfaces the implementer's calls: each choice the change
 * embodies, its why, the alternatives not taken, and evidence anchors into the
 * diff. `inferred` marks a call reconstructed from the code rather than stated
 * in the PR body.
 */
import type { LensBoard } from "@/lib/lens-data"

export const decisionsBoard: LensBoard = {
  lens: "decisions",
  title: "Decisions — observe the token refresh, drop the unsafe retry",
  intro:
    "The token's lifetime was never the bug: renewal was invisible. These are the calls that made the refresh exchange legible without moving the state machine — and the one call review forced, removing a second retry that was redundant and unsafe.",
  sections: [
    {
      id: "retry-ownership",
      title: "Retry ownership and failure propagation",
      gist: "Retry stays in the shared transport; the refresh layer only observes and propagates.",
      counts: "2 decisions · 1 code",
      elements: [
        {
          kind: "prose",
          text: "The headline call, and the one review caught: an earlier draft added a second retry inside refreshAndPersist. The shared GitHub transport (withConnectResilience) already retries a connect-phase blip once, replay-safely — nothing reached GitHub, so nothing rotated. A retry here would be a redundant second layer AND unsafe, because isGitHubNetworkError also matches post-send errors that may have already rotated the pair. So the refresh layer was cut back to observe-and-propagate.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 244,
          lang: "ts",
          highlightLines: [1, 13, 14, 15, 16, 17, 18, 19],
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
          kind: "decision",
          statement:
            "Remove the adapter-level retry from refreshAndPersist and leave connect-phase retry to the shared transport.",
          why: "The transport's connect-phase retry is the only replay-safe kind: no request reached GitHub, so nothing could have rotated. A second retry here would double connect attempts and could replay a post-send failure onto an already-rotated pair, burning a live refresh token.",
          inferred: false,
          alternatives: [
            "Keep the second retry inside refreshAndPersist (the rejected earlier draft).",
            "Retry only when the error is provably connect-phase — duplicating the transport's own classification.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 262 },
            { path: "openspec/changes/github-token-refresh-reliability/design.md", line: 41 },
          ],
        },
        {
          kind: "decision",
          statement:
            "On a network error, emit a `network` record and re-throw, letting resolveGitHubAuth do the classification.",
          why: "Keeping classification in one place (resolveGitHubAuth maps the propagated error to reason 'network') means refreshAndPersist never has to decide the surface state, and the credential is left byte-untouched because no write runs before the throw.",
          inferred: true,
          alternatives: [
            "Catch the network error in refreshAndPersist and return null, collapsing it into the same path as a decline.",
            "Map the network error to a GitHubAuthState here instead of throwing.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 267 },
            { path: "packages/adapters/src/github-auth.test.ts", line: 296 },
          ],
        },
      ],
    },
    {
      id: "log-record-shape",
      title: "The refresh log record: secret-free by construction",
      gist: "A typed record with no secret-carrying field, written at the composition boundary.",
      counts: "3 decisions",
      elements: [
        {
          kind: "prose",
          text: "Making the refresh observable meant choosing where the logging lives and what the record can hold. The safety here is a type-level property, not a review promise: the record shape has nowhere to put a token, and the only token-derived field is a label drawn from a closed allowlist.",
        },
        {
          kind: "decision",
          statement:
            "Inject an optional `log?: (record: RefreshLogRecord) => void` into ResolveAuthDeps instead of calling console.log inside the adapter.",
          why: "The adapter stays side-effect-free and testable — tests assert on captured records — while production formatting lives at the composition boundary in create-server. A bare console.error in the adapter would couple it to a sink and make the secret-safety guarantee untestable.",
          inferred: true,
          alternatives: [
            "console.error directly inside refreshAndPersist.",
            "Return the records from resolveGitHubAuth for the caller to log.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 96 },
            { path: "packages/server/src/create-server.ts", line: 622 },
          ],
        },
        {
          kind: "decision",
          statement:
            "Give RefreshLogRecord no field that can hold a token, refresh token, or secret.",
          why: "If the type cannot carry a credential, a credential cannot be logged even by mistake. The fields are phase, an optional verbatim githubError code, and an optional non-secret tokenKind label — nothing else.",
          inferred: false,
          alternatives: [
            "A freeform message string per record (which could accidentally interpolate a token).",
            "Include the token expiry or a truncated token for debugging.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 57 },
            { path: "packages/adapters/src/github-auth.test.ts", line: 356 },
          ],
        },
        {
          kind: "decision",
          statement:
            "tokenKind returns only an allowlisted GitHub prefix or the fixed string `token`, never a slice of the value.",
          why: "An unrecognized value like customerSecret_body must not leak its own prefix into a log. Matching against a closed prefix allowlist and falling back to a constant means the returned string is always a constant, never credential bytes.",
          inferred: false,
          alternatives: [
            "Return the substring up to the first underscore (would leak customerSecret_).",
            "Return a fixed-length prefix of every token.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 84 },
            { path: "packages/adapters/src/github-auth.test.ts", line: 218 },
          ],
        },
      ],
    },
    {
      id: "hook-point-and-proof",
      title: "Where the observation hooks in, and how it is proven",
      gist: "One attempt record before the exchange; tests pin the exact ordered records and the call count.",
      counts: "2 decisions",
      elements: [
        {
          kind: "prose",
          text: "The last calls are about placement and proof: log the attempt before anything can fail, so a mid-exchange crash still leaves a trace, and assert the whole record sequence exactly so a stray extra log — or a sneaked-back retry — fails a test.",
        },
        {
          kind: "decision",
          statement:
            "Emit the `attempt` record at the start of the exchange, inside the locked section both the proactive and reactive branches route through.",
          why: "Both refresh triggers funnel through refreshAndPersist, so logging the attempt there — before the refresh call — covers both with one line and survives a process death mid-exchange, which a record written only on completion would not.",
          inferred: true,
          alternatives: [
            "Log the attempt in each of the proactive and reactive branches separately.",
            "Log only the outcome (persisted / declined / network) and skip the attempt record.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 244 },
            { path: "openspec/changes/github-token-refresh-reliability/tasks.md", line: 27 },
          ],
        },
        {
          kind: "decision",
          statement:
            "Verify by asserting the exact ordered record array and that refresh() is called exactly once, rather than checking individual records loosely.",
          why: "toEqual on the full [attempt, network] / [attempt, declined] sequence catches an extra, missing, or reordered record — and a toHaveBeenCalledTimes(1) on refresh is the regression guard that would fail the instant an adapter-level retry is reintroduced.",
          inferred: true,
          alternatives: [
            "Assert only that a network record appears somewhere (would miss a spurious retry log).",
            "Spy on console output instead of the injected record sink.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.test.ts", line: 301 },
            { path: "packages/adapters/src/github-auth.test.ts", line: 259 },
          ],
        },
      ],
    },
  ],
}
