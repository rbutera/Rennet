# Context packet — C14 conformance-sweep

Read `openspec/BUILD-LOOP.md` first. Plan row: C14. The last wave — the build's own verification contract.

## Objective

Prove inventory parity and close the loop:

0. **Gate — close the live-wiring ledger first.** Every claim is verified against a
   fully live client; a MemoryBridge-backed surface is not auditable. Before any
   audit line is checked, each entry below must be closed and `pnpm check` green.
   A missing swap stops the audit — it is not an audit finding.

   | Deferred | Swap | Gated on |
   |---|---|---|
   | B08 composition-root wiring | B09's consuming turn | B09 (landed) |
   | B09 create-server/dispatch wiring | round-trigger wiring (5.1/6.2) | C9/B10 |
   | B10 cluster 6 | live-turn wiring | B09 (landed) |
   | C05 cluster 8 | live-wiring swap | B04/B08 (landed) |
   | C07 transcript projection | one-file swap in `chat-data.ts` | B09 (landed) |
   | C08 cluster 8 | `REVISE_WIRED` one-bool flip | B11 |
   | C11 live command execution | registry exposure flags on live rows | B10 |
   | C12 cluster 7 | rename seam | B09 (landed) |

   Managers close these opportunistically as gates clear — C14 confirms closure,
   it does not perform the integration.

0b. **Carried defects and rulings** — resolve before the sweep, not during it:
   - C08: own-PR resolves as teammate-pr (no ownership fact in the frozen schema).
     A real behavioral defect; fix on the B-track first — it will fail a §6 claim.
   - C08: the parked `publish.requestConsent` token needs Rai's explicit ruling.
     Rule Zero reading: publishing is not data loss and Rai clicking post is the
     control, so the default is delete. Do not let it survive as accepted behavior.
   - C11/C10: the keyboard page must carry the six-bind `KEY_ACTIONS` +
     `settings.get` invalidation when it replaces `settings-screen.tsx`.
   - C10's honest-empty ledger (model-council, glyph, worktree, tracker,
     guidance-write, remote-host detection) awaits backends that do not exist.
     In scope for C14: that no page or surface *claims* them as working. Out of
     scope: building them.

1. Sweep INVENTORY §14's residue: every remaining unbuilt/built-wrong item (tracked on #492) either fixed or explicitly re-ruled by Rai — no silent drops.
2. **The inventory audit**: every `[ws:*]`-tagged line (712 total) verified against the *running client* — driven, not code-read. A line that fails is a bug in its workstream; bounce a scoped fix, re-verify.
3. Close the generated per-workstream checklist issues; regenerate one final time to prove tag/issue agreement.
4. Flip the last `BUILD-STATUS.json` entries; delete the file (the sprint artifact does not outlive the sprint).
5. Final docs pass in coordination with #490's scope: no reader page describes the partition canvas or dispositions.

## Out of scope

New behavior. Anything a re-ruling would expand — park it as a fresh ticket instead.

## Blocked by

Every other C-change and B-change. Strictly last.

## Sources

- `spikes/board-prototype/INVENTORY.md` (all sections, all tags) + §14 · debts: https://github.com/rbutera/rennet/issues/492
- The plan's verification contract: `docs/developing/plans/board-rebuild-plan.md`
- Docs scope: https://github.com/rbutera/rennet/issues/490

## Verification

- `pnpm check` green. The audit artifact: a per-line pass/fail record attached to the change; zero fails at close. Positive control: deliberately break one claim's behavior, confirm the audit catches it, revert.

## Completion sigil

`<promise>C14-COMPLETE</promise>` — and with it, the board rebuild.
