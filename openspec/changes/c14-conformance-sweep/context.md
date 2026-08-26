# Context packet — C14 conformance-sweep

Read `openspec/BUILD-LOOP.md` first. Plan row: C14. The last wave — the build's own verification contract.

## Objective

Prove inventory parity and close the loop:

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
