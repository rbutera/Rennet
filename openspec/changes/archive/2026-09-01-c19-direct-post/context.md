# Context packet — C19 direct-post

Read `openspec/BUILD-LOOP.md` first. Added 2026-08-28 under Rai's ruling on the
parked C14 §0b item (#435): the `publish.requestConsent` token is DELETED. Rule
Zero — publishing's control is Rai clicking post; the token is a consent
ceremony on the acting path. Do not re-argue it.

## Objective

Delete the token end to end and keep the ONE property it actually enforced —
the posted verdict equals the previewed verdict (a post differing from its
preview is a UI lie) — by folding the VERDICT into the byte-exact payload
re-derivation / compositionId freshness check that already runs at post time.
Same existing mechanism, one more input; no token, no dialog, nothing to clear.

**The deletion** (~11 files, ~350–450 lines; `grep -rn requestConsent` to
enumerate — verified 2026-08-28):

- `packages/server/src/publish-consent-authority.ts` — deleted whole (82 lines:
  `publishConsentKey`, `PublishConsentAuthority`, `createPublishConsentAuthority`).
- `packages/server/src/create-server.ts` — the composition (import at 192,
  `createPublishConsentAuthority()` at 1448, the `publishConsent` dep at 1610).
- `packages/server/src/dispatch/runtime.ts` — the import + `deps.publishConsent`
  declaration (~192–197) and the requestConsent mention in the own-target
  comment (~808).
- `packages/server/src/dispatch/publish.ts` — the `publish.requestConsent`
  handler (33–65) and step (4b), the consume block, in `publish.review` (144–157).
- `packages/protocol/src/commands/index.ts` — the `publish.requestConsent`
  definition + comment block (186–221) and the `authorization` input on
  `publish.review`. `commands.test.ts` `ABSORBED_IDS` drops one (79 → 78).
- `packages/protocol/src/wire.ts` (131, 2292) + `src/domain.ts` (138) —
  comment-only references; reword, do not leave the token narrated.
- `packages/app-ui/src/handoff/exits.ts` — the
  `useMutation("publish.requestConsent")` + the mint in `onPost` (~12 lines).
- `apps/mobile/app/daemon/[daemonId]/review/[reviewId]/publish.tsx` — a SECOND
  client consumer (the audit said exits.ts was the sole one; the grep says
  otherwise): the `supervisor.invoke("publish.requestConsent", …)` leg (~189–192).
- `packages/server/src/dispatch.test.ts` — the bulk: every token-binding block
  (8 references), replaced per Verification below.

**The verdict fold.** `publishCompositionId` (`dispatch/runtime.ts:649`) hashes
(reviewId, patchsetId, mode, payload); add the verdict for `mode: "review"`
("pr" has none). `publish.compose` already derives it (`resolveReviewEvent` in
`dispatch/publish.ts`, projection `verdictOverride` winning) and returns it
beside `compositionId` — bind it in. `assertCompositionFresh`
(`runtime.ts:670`) grows a verdict input: `publish.review` passes its resolved
post verdict (`resolveReviewEvent([...comments, ...bodyNotes], input.verdict)`);
the expected side recomputes from the durable ask projection exactly as the
payload already does. A post whose verdict differs from the previewed
composition now fails the EXISTING stale-compositionId refusal. `compositionId`
stays optional on the wire (additive/back-compat), and both live clients
(exits.ts, mobile publish.tsx) already post the composed id, so the property
binds on every real path. Client side: `onPost`'s posted `verdict` must be the
composed one — a human verdict flip already routes `ask.setVerdictOverride` →
projection → recompose; verify that path recomposes before Post arms, and do
not add a second verdict channel.

**Keep untouched** — surviving correctness gates, none of them ceremony: the
retrospective gate, `assertTargetIsReviewOwn`, byte-exact payload re-derivation
(`canonicalReviewPayload(...) !== input.payload ⇒ refuse`), compositionId
freshness, `dryRun` defaulting true, single-flight by marker
(`realPostInFlight`).

## Out of scope

Any new confirmation surface (Rule Zero — deleting a gate must not grow a
smaller one). Any change to WHAT gets posted (payload composition, verdict
derivation, marker, ledger). The harness-run consent-authority sibling.

## Blocked by

C16 landing (the same protocol command-registry/snapshot surface). The
c08-revise-wired branch landing (it owns the `app-ui/handoff` files).

## Sources

- The ruling: https://github.com/rbutera/rennet/issues/435 + the C14 packet §0b
  ("the default is delete").
- The shape today: `packages/server/src/dispatch/publish.ts`,
  `packages/server/src/dispatch/runtime.ts` (`publishCompositionId`,
  `assertCompositionFresh`), `packages/server/src/publish-consent-authority.ts`,
  `packages/app-ui/src/handoff/exits.ts`, the mobile `publish.tsx` above.
- Docs: the markdown library carries zero `requestConsent` references today
  (verified); keep it that way, and update `docs/developing/concepts/handoff-and-exits.md`
  if the exit flow's description shifts.

## Verification

- `pnpm check` green. `grep -rn requestConsent packages apps docs --include='*.ts'
  --include='*.tsx' --include='*.md'` (excluding `dist/`/build output) returns
  zero hits.
- The verdict-fold test replaces the token-binding blocks in `dispatch.test.ts`,
  red-green: compose, then post with a verdict ≠ the previewed one ⇒ the
  stale-compositionId refusal; posting the previewed verdict succeeds.
- Positive control (can fail): in a test, mutate the verdict between preview and
  post — flip COMMENT → APPROVE without recomposing — and assert the post is
  refused and nothing left the machine.

## Completion sigil

`<promise>C19-COMPLETE</promise>`
