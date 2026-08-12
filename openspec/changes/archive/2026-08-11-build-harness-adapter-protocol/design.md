> **SUPERSEDED (2026-08-12) on the read-only posture** (see proposal.md banner). The
> "Read-only posture makes denial a normal event" section below described the shipped
> behaviour; Rule Zero retired that posture (#261 adapter, #259 analysis/verification
> path). Analysis sessions are now capable by default and verification may run the code.
> `tool.denied` remains a first-class event kind — it is still the right shape for a
> harness- or user-side denial — it is simply no longer produced by a Rennet-imposed
> review denylist. The body is left as the historical account of what shipped.

## Context

Rennet has a working local review loop and a decision-complete harness plan (the Wingman Harness Adapter Protocol, Master Plan R2/R13, the T3 auth trace). The plan is larger than this slice: it covers three harnesses, disagreement/N=3, session persistence, the utility tier, and a cross-adapter conformance runner. This change implements only the consumed subset that unblocks angle generation, the canvasOps session, and the handoff loop, and it does so without adopting the proprietary Claude SDK as a workspace dependency, because that adoption conflicts with three ratified repository policies.

## Goals / Non-Goals

**Goals:**

- A node-free normalized protocol in `core` that a mobile/third-party client can import, with an adapter-assigned monotonic sequence and lossless native passthrough.
- Three-layer capability flags that are derived from passing checks, never declared from docs.
- A Claude adapter that is an SDK integration by contract, provably safe on money (OAuth assertion + metered-key warning), read-only by default, and hermetically testable.

- Discovery that finds the harness in the bare login-shell environment a GUI app actually inherits.

**Non-Goals:**

- Adopting `@anthropic-ai/claude-agent-sdk` as a production dependency (open licensing/supply-chain decision).
- Codex and omp adapters, disagreement/N=3, session persistence and re-attach, fork/resume, steer, the utility tier, and the cross-adapter conformance runner.
- Any write to the working tree, any credential read, any packaging run.

## Decisions

### The protocol lives in `core`, node-free

`HarnessPort`/`HarnessSession` join the existing `PatchsetCapturePort`/`ReviewStorePort` ports in `packages/core`. The whole `harness.ts` module imports nothing at module scope, so the phone can import capabilities and event types. `seq` is assigned by the adapter via a `SeqCounter`, never taken from a harness clock. Every event carries its raw frame in `native`, and any unmodelled frame becomes a visible `passthrough` rather than being dropped.

### The SDK is injected, not depended upon

`@anthropic-ai/claude-agent-sdk` reports its licence as `SEE LICENSE IN README.md`, which is not in the MIT-family `check-licenses` allowlist, so it cannot be a production dependency without a licensing decision that belongs to Rai; it also fails the repository's `minimumReleaseAge: 10080` (7-day) floor for its latest release and would drag in strict peer dependencies. Rather than allowlist a proprietary licence autonomously or dodge the gate with a devDependency workaround, the adapter is written against a narrow local `ClaudeQueryFn` boundary (the SDK's `query()` signature subset) and takes it by injection. The composition root wires the real SDK in a later slice once the adoption decision lands. This keeps `main` releasable and every gate green while honoring R2's intent: the adapter consumes exactly the SDK's frames and options.

### Money safety is detection, per R2

The adapter reads `apiKeySource` on the init frame every session. `'oauth'` (subscription) is the expected path; any metered value emits an `auth.metered-key-warning`. It never fails the turn closed (the user may legitimately be on a key), and it never injects a key. This is the positive guarantee the SDK integration makes possible: the credential source arrives as typed data.

### Read-only posture makes denial a normal event

Review is read-only, so the adapter builds the session with a read/search allowlist and a write/exec denylist, never a bypass mode. A denied write is therefore an expected `tool.denied` event, not an error, which is why `tool.denied` is a first-class event kind.


### Discovery never asks a shell to resolve a binary

On this machine a bare login shell (what a Finder-launched app inherits) finds neither harness, and interactively `claude` is a shell function, so `which`/`command -v` return a function body. Discovery harvests only PATH, unions it with known locations, resolves candidates itself with readdir + X_OK, and proves each by executing `--version`. Every effect is injected, so a test proves discovery touches no credential file.

## Risks / Trade-offs

- The Claude adapter has no default SDK wiring in this slice, so it is not yet runnable from the desktop app. Mitigation: the consumers this unblocks (#8, #12) are also later slices; the seam and the adapter logic are what they need first, and the real `query` is a one-line injection when the SDK is adopted.
- `testedRange` is a hand-maintained constant, a known staleness hazard (deferred to a follow-up that derives it from CI).
- Real-turn evidence is manual, not a gated test, because it is non-hermetic and spends the subscription.
