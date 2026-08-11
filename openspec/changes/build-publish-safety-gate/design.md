# Design — publish safety gate (#80)

## Context

The publish sheet (`components/publish-sheet.tsx`) has two sign paths — a pointer hold (`beginHold`/`endHold`) and a keyboard `onKeyDown` — both routing through the pure `resolveSign(elapsedMs, holdToSignMs, payload)` in `canvas/destination.ts`. `resolveSign` is genuinely unit-tested (`canvas/destination.test.ts`). What is **not** tested is that the COMPONENT actually calls it correctly and honours its result: the only "hold" coverage in the tree is an SSR string check (`destination.test.tsx:90`, `expect(html).toContain('data-hold-ms="800"')`), which is exactly the vacuous-presence class this issue exists to replace. PR #76's mutation pass confirmed the wiring is unguarded (MUT A/C/I passed green).

The #53 DOM harness (`packages/ui/src/test/dom.ts`) is the enabling dependency: a test opts in with `// @vitest-environment happy-dom` on line 1 and imports `mount`, `fireEvent`, `waitFor`, `userEvent` from `../test/dom`. `afterEach(cleanup)` is registered there, so mounted trees unmount between tests.

## The safety guarantees and the mutation that reddens each

Every safety test below MUST be proven able to go RED. The lumiere/rennet suite is vitest, so `revert-proof.mjs` (node --test only) does NOT apply — each is proven by hand: neuter the named invariant, confirm the NAMED test reddens, restore, confirm the restore is byte-identical, then run the full GREEN pass (a red proves only the assertion that fired — 81al).

| Guarantee | Test (mounted) | Reddening mutation (must turn the named test red) |
|---|---|---|
| **Emit fidelity** (MUT A): a completed sign emits **exactly** `stagedPayload(batch)` | mount sheet, fake-timer a sufficient hold, assert the `onSign` spy received a string **byte-equal** to `stagedPayload(batch)` | in `endHold`, emit `outbound + "\n"` (or `payload.toUpperCase()`) → byte-equality fails → RED |
| **Hold-gate wiring** (MUT C): a too-short hold does **NOT** sign | mount sheet, mousedown → advance the clock **below** `holdToSignMs` → mouseup, assert `onSign` **not** called; then a second interaction with elapsed ≥ `holdToSignMs` **does** call it | make `endHold` call `onSign?.(payload)` unconditionally (ignore `resolveSign`'s null) → the too-short case signs → RED |
| **App clear-on-sign** (MUT I): signing clears the staged paper | mount `RennetApp` (fake bridge), stage a disposition, open the sheet, complete a sign, assert the destination's `data-staged-count` returns to `0` and the sheet closes | delete `setStaged([])` from the `onSign` handler in `app.tsx` → staged count stays non-zero after sign → RED |
| **Ledger gate**: unacknowledged degradations block signing | mount sheet with a `ledger` carrying an unacknowledged entry; a sufficient hold does **NOT** sign; acknowledge; the same hold **does** sign | make `endHold`/keyboard ignore the ledger block (sign on `resolveSign` alone) → the unacknowledged-ledger sign succeeds → RED |

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. Delete the **Ledger gate** row from this table; the other four guarantees (emit fidelity, hold-gate wiring, app clear-on-sign, keyboard sign) stand as ordinary correctness tests.
| **Keyboard sign** (a11y): Enter/Space on the focused control signs deliberately, byte-equal, ledger-gated | mount sheet, focus the sign control, `keyDown` Enter → assert `onSign` received byte-equal `stagedPayload`; and with an unacknowledged ledger, Enter does **NOT** sign | remove the `onKeyDown` handler (or make it emit a transform) → keyboard sign stops firing / byte-equality fails → RED |

## Decision 1 — the ledger sign-gate lives in `layer:ui` as a thin view-model, not a guessed cross-layer type

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. All of Decision 1 is withdrawn — `ledgerBlocksSign`, the `acknowledged` state, and the "Acknowledge N run degradations to sign" control. What applies instead: if a `PublishLedger` view-model is useful at all, it is a read-only display of what degraded, and nothing about it may block a sign path. Note especially the reasoning at the end of this section ("a gate that clears the instant the ledger renders is not a gate") — that is precisely the ceremony-polishing Rule Zero exists to stop.

The issue's third MUST is "the degradation-ledger sign-gate landed (signing impossible without the ledger visible)." There is **no unified degradation-ledger data model** in `types`/`protocol` today (only per-source `degraded`/`degradationReason` flags on `Changeset`, and `RunLedgerHeadline` in `@rennet/core`'s `orchestrator-primer.ts`). Critically, **`layer:ui` may import only `@rennet/types` and `@rennet/protocol`, never `@rennet/core`** (AGENTS.md; enforced by eslint `@nx/enforce-module-boundaries`), so the UI cannot reference core's ledger types even if it wanted to.

Therefore #80 does **not** invent a cross-layer degradation model (that belongs to #22/council, which owns the ledger CONTENT and its source). It defines a **minimal UI-local `PublishLedger` view-model** — the thin prop the sheet needs to enforce the GATE — and #22/council maps real run-degradation data into it later:

```ts
// canvas/destination.ts (UI-local view-model; #22/council supplies the content)
export interface LedgerEntry { readonly id: string; readonly summary: string; }
export interface PublishLedger { readonly entries: readonly LedgerEntry[]; }

/** The gate: an unacknowledged, non-empty ledger blocks every sign path. */
export function ledgerBlocksSign(
  ledger: PublishLedger | undefined,
  acknowledged: boolean,
): boolean {
  return ledger !== undefined && ledger.entries.length > 0 && !acknowledged;
}
```

The sheet owns the `acknowledged` state locally (`useState(false)`) and renders an explicit "Acknowledge N run degradations to sign" control listing the entries. **Both** sign paths (`endHold` and keyboard) check `ledgerBlocksSign` before emitting. When `ledger` is `undefined` or has zero entries the gate is open — so the shipped shell (which passes no ledger) is **unchanged**, keeping this change additive.

Why "acknowledged", not merely "visible": a gate that clears the instant the ledger renders is not a gate. The safety property is that the reviewer cannot publish a degraded review **without an explicit act acknowledging the degradation** — the honesty the paper/glass doctrine demands.

## Decision 2 — resolve the keyboard barrier rather than merely documenting it

Today `onKeyDown` computes `resolveSign(0, holdToSignMs, payload)`: with the default `holdToSignMs=800`, elapsed 0 < 800 → `null` → **no keyboard sign at all**. "Document floor-0 as the accommodation" is hollow, because nothing sets floor-0 for AT users, so a keyboard user with the default hold simply cannot publish — a real barrier.

Resolution: **an Enter/Space activation of the focused sign control is itself the deliberate act.** The hold-to-confirm exists to stop an *accidental pointer release* from publishing; a keyboard user must deliberately focus the control and press Enter/Space, which is already an intentional discrete act, so requiring an additional timed "hold" on the keyboard is a barrier with no matching safety benefit. The keyboard path signs at any hold budget, but:

- it routes through the **same emit-fidelity guarantee** (emits exactly `stagedPayload`, never a transform), and
- it is subject to the **same ledger gate** (`ledgerBlocksSign`), and
- the "never auto-approves / no PASSIVE approval" invariant is preserved: nothing signs without an explicit keyboard activation of the focused control.

Floor-0 remains documented as the **pointer** accommodation. The deeper "keyboard press-and-hold to mirror the pointer ceremony exactly" is a follow-up, not a safety gap (a deliberate keypress is not passive).

## Decision 3 — the app-clear test mounts `RennetApp` with a minimal fake bridge

Item 3 (MUT I) is genuine app glue: `onSign={() => { setStaged([]); setPublishOpen(false); }}` in `RennetApp`, untested because the existing app test only exercises the presentational `ReviewWorkspace`. The honest coverage mounts `RennetApp` and drives the real flow. `RennetApp` calls `bridge.invoke("app.bootstrap" | "review.checkFreshness" | …)` on mount, so the test supplies a **minimal fake `RennetBridge`** (from `@rennet/protocol`) returning a ready review and no-op command results — enough to stage a disposition, open the sheet, and sign. If the full mount proves disproportionately heavy, the fallback is a thin mounted smoke test over just the destination-chrome subtree with the same `onSign` handler wired; either way the assertion is behavioural (staged count returns to 0 after sign), never a presence check.

## Non-goals / deferred (file as follow-ups, do not block)

- The real degradation-ledger data model and its source (run/council degradation → `PublishLedger`): #22/council. #80 wires the GATE and the view-model boundary only.
- Real GitHub/Git publishing: #21 (the slice this gate blocks).
- Keyboard press-and-hold that mirrors the pointer hold-duration ceremony exactly (the current resolution is a deliberate discrete activation, which is safe): a11y polish follow-up.
- Three-phase idempotent publish, refined-comment preview forms (#19): unchanged, still deferred seams.
