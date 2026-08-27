# B11 — exits-backend (#458 R29–R36 + #486: the durable exits engine)

Packet: `context.md` (scope authority). Plan row B11 — the last engine wave, consuming turn of B8→B9→B11. Blocked-by B8 (lens pipeline, landed), B9 (session/rounds runtime + `ReworkQueue`, landed PR #531), B10 (persistence engine, landed). Authored 2026-08-27 against main @ e9e47632.

## What this change does

Builds the **engine side of the three exits** (R29–R36). The marquee is **durable host-side asks**: the reviewer's staged asks, line comments, quote threads, retired ledger and verdict override are **client-only and transient today** (`app-ui/src/store/review.ts` — "no persist: reload resets interaction clean"), so a reload loses the whole review. B11 moves them host-side behind **one write path — tool call → event log → projection** — so they survive reload, with **receipt-is-undo** on every mutation (Q15, decided).

The egress is **already live and is not rebuilt**: `dispatch/publish.ts` implements `publish.compose` (review + pr), `publish.review`, `publish.submitPr` with consent-token binding, exact-preview (R33), single-flight and compositionId staleness; `core/` already carries `draft-pr-body`, `publish-review` (two-strata composition), `publish-submission`, and `handoff-compose`/`handoff-loop` (the round work-order). B11's job over that base:

- **Durable asks**: an append-only per-session ask event log + a fold to the current ask projection, a file-backed store (B10 precedent), and the `ask.*` command surface that is the sole writer. Receipt-is-undo. Emitted to clients (private + R19 projected).
- **Compose from the durable projection**: extend `publish.compose` so the two-strata review and the PR-body draft source the living draft from the durable ask projection — the swap `app-ui/src/handoff/handoff-data.ts` was built to absorb (its own line: "THIS is the only file that changes").
- **Round work-order dispatch**: the round-dispatch command composes the dispatched asks into **one** work-order via `handoff-compose`, **serialized per session** (one round in flight), idempotent (dispatch twice → one dispatch). This **wires `createRoundsRuntime` + `SessionEntry` into `create-server`** — the trigger B9 explicitly deferred (tasks 5.1/6.2, "lands with the round trigger").
- **Living-draft rework + PR ripening**: the real span-rework command backing the client's gated `reviseDraftSpan` seam, dispatched as a one-shot worker through **B9's `ReworkQueue`** with **quote-match carry** (re-anchor via `core/lineage-matcher`); the own-branch PR draft **ripens across rounds** (re-compose + re-raise publish-ready as each round lands).
- **Nothing posts without Rai clicking post**: preserved unchanged — draft/preview/post language; pushing a branch is not publishing.

## Out of scope

All UI (C8 landed the client exits; C9 owns the client swap to the durable projection). The round-report drafter (B8 owns it). **The `publish.requestConsent` consent-token question is PARKED for Rai** (CLAUDE.md) — B11 does not remove, extend, or restyle it; the egress path is consumed as-is.

## Objective clause → cluster map (every packet clause lands a task)

- Asks durable host-side (Q15); one write path event log → projection; receipt-is-undo → **Clusters 1, 2**
- `core/exits/` round work-order composition (asks → one dispatch, serialized) → **Cluster 4**
- PR body draft; two-strata review composition; publish submission shape → **Cluster 3** (source the existing primitives from durable asks; not rebuilt)
- Idempotent push + open-PR; PR lane ripening across rounds; living-draft rework as one-shot workers + quote-match carry → **Cluster 5**
- Nothing posts without Rai clicking post (draft/preview/post; push ≠ publish) → preserved; verified **Cluster 6**
- Docs `handoff-and-exits.md` (make it live) → **Cluster 6**

## Reconciliation ledger (proposer findings — hold these, do not re-open)

1. **Egress already exists.** `publish.*` (compose/review/submitPr) is fully implemented in `dispatch/publish.ts`, and `draft-pr-body`/`publish-review`/`publish-submission` in `core`. The packet's "PR body draft / two-strata composition / publish submission / idempotent push+open-PR" are **not greenfield** — B11 sources them from the durable ask projection and verifies, rather than re-implementing. Re-writing them would be duplicate implementation (BUILD-LOOP's classic loop failure).

2. **Asks are the real gap.** No host-side ask surface exists (`ask.*` absent from protocol/server/core); the full model lives only in the client store. This — durable asks with event-log→projection and receipt-is-undo — is B11's substance.

3. **`createRoundsRuntime` + `SessionEntry` are unwired by design.** B9 tasks 5.1/6.2 built the mechanism and E2E-composed it but left it out of `create-server` ("dead integration with no caller until the round trigger"). B11 **is** that trigger (asks → one dispatch), so it owns the `create-server` wiring. This closes B9's ledgered deferral; it is not a B9 re-open.

4. **`handoff-data.ts` is the client swap seam, and it is C9's, not B11's.** B11 makes `publish.compose` return the living-draft composition from the durable projection; the client's swap to read it (replacing store-derived `selectLivingDraft`) is C9. B11 must not edit `app-ui`.

5. **`handoff-and-exits.md` already exists** (11 KB planned page). "Make it live" = update it to describe the durable-asks backend and the exits as shipped, not author from scratch.

6. **Consent token is PARKED.** Reconciliation-adjacent findings whose fix touches `publish.requestConsent` or adds any gate are dropped under Rule Zero.

## Review-fix ledger (dual-review PR #537 — opus REQUEST-CHANGES / Codex BLOCK, all upheld under Rule Zero)

Each entry is a fix, not a gate: data-loss prevention, honest failure, correctness, privacy, or test-validity.

1. **P0 — corrupt durable history silently became an empty review** (`adapters/ask-log-store.ts`). `read` caught EVERY failure as "absent", so a torn write / malformed JSON / schema or version mismatch / foreign-session or non-contiguous seq folded to an empty projection → compose posted a CLEAN review over lost asks (silent lie). Fixed: ONLY ENOENT is absent; every other state is `corrupt` and `read`/`readProjection` throw `AskLogCorruptError` while `append` refuses to clobber. Added `readState` validation (version + per-event session identity + contiguous seq) and a parent-directory fsync after rename (crash-durable rename, a genuine ~4-line addition — no transaction machinery, per the B09 precedent). Proof: `ask-log-store.test.ts` — torn-write refusal, version/foreign-session/seq refusal, and a **child-process** SIGKILL'd-mid-write durability test (finding 10a).

## Verification (packet)

`pnpm check` green. E2E with positive controls able to fail: (a) stage asks → kill host → restart → asks intact; (b) dispatch a round work-order twice → exactly one dispatch; (c) compose + preview a GitHub review draft for a real PR **without posting**.

## Completion sigil

`<promise>B11-COMPLETE</promise>`
