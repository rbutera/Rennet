> ⛔ **SUPERSEDED IN PART 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. This change is **partly retired**: the degradation-ledger acknowledge gate (an are-you-sure confirmation standing between the user and publishing) and the framing of this change as a **hard merge-blocker that #21 may not land until** are both withdrawn — a requirement whose effect is "you may not build X until ceremony Y is discharged" is exactly what Rule Zero forbids, and #21 shipped anyway (`747d966`). What SURVIVES and is still wanted: the emit-fidelity tests (published bytes byte-equal the previewed bytes), the hold-gate wiring tests, the app-level clear-on-sign test, and the keyboard-accessibility resolution — those make the product do its job better. Read every section below through that filter.

## Why

The destination-frame / publish-sheet SHELL (#64/#22, merged as PR #76) performs ZERO outbound mutation, and every publish-act invariant HOLDS today — but the load-bearing ones hold **only by construction, with no regression guard**, and are **untestable** because `packages/ui` had no DOM env. That gap is now closed: #53 landed the happy-dom + `@testing-library` harness (`packages/ui/src/test/dom.ts`).

PR #76's adversarial dual review proved the exposure with mutations that PASSED all green tests:

- **MUT A (emit side):** a mutation making `onSign` emit different bytes than the preview passed — **no test observes what `onSign` emits.** #22's own "previewed bytes equal published bytes (asserted)" is only half-met (render, not emit).
- **MUT C (gate wiring):** a mutation that signed on ANY pointer release (bypassing the hold gate) passed — the "too-short hold never signs" safety property rides on **untested component wiring**. The `canSign` predicate is unit-tested and genuine; the WIRING is unguarded.
- **MUT I (app clear):** app-level clear-on-sign / dispose==staged in `RennetApp` is untested — the app test only exercises `ReviewWorkspace`.

These are harmless while sign is a no-op that clears the paper (**nothing leaves the machine**). They become **real exposure** the moment #21 (the GitHub publish pipeline) makes sign actually publish. This change is the **hard safety gate** that must be green before #21 wires real publish: it replaces the vacuous SSR presence checks with **red-provable, mounted-DOM emit observations**, adds the **degradation-ledger sign-gate** (signing impossible without acknowledging what degraded during the run), and resolves the keyboard-accessibility barrier.

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. This change is NOT a merge-blocker on #21 or on anything else, and the degradation-ledger sign-gate is withdrawn; the emit-fidelity, wiring, and keyboard tests are ordinary tests that land on their own merits, blocking no other work.

The relevant safety doctrine is R33 (author-side/reviewer publication is inspect → sign → one submit; Rennet never pushes; **what you see on the sheet is exactly what leaves**), R38 (publish is all-or-nothing per signing act v1), and AGENTS.md's fixed boundary: "Never auto-approve, auto-comment, push source branches, or publish anything another human can see without an explicit human action." This gate is that boundary made red-provable.

## What Changes

- **Replace the vacuous hold-gate presence check** (`destination.test.tsx:90`, an SSR assertion on `data-hold-ms="800"`) with real **mounted-DOM interaction tests** that observe `onSign` directly. The SSR render tests remain as rendering coverage but are **no longer the safety guarantee**.
- **Add emit-fidelity coverage** (MUT A): a sufficient hold calls `onSign` with **exactly `stagedPayload(batch)`, byte-equal** — proving the emitted bytes are the previewed bytes, never a transform.
- **Add hold-gate-wiring coverage** (MUT C): a too-short pointer hold does **NOT** call `onSign`; a sufficient hold does. The gate is proven at the component boundary, not just in the pure predicate.
- **Add app-level clear-on-sign coverage** (MUT I): mounting `RennetApp`, staging a disposition, opening the sheet, and signing clears the staged paper (dispose==staged demonstrated end-to-end).
- **Add the degradation-ledger sign-gate** (the #22 ledger gate; bead `idwba`): the publish sheet accepts an optional `PublishLedger` view-model (UI-local — `layer:ui` cannot import `@rennet/core`, so #22/council maps real run-degradation data into this thin prop). When the ledger carries **unacknowledged** degradations, **every sign path is blocked** regardless of hold; acknowledging unblocks. Absent/clean ledger → behaviour unchanged (additive, backward-compatible with the shipped shell). Red-provable: a mutation that ignores the ledger lets a sign through with unacknowledged degradations.

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. The degradation-ledger **sign-gate** is withdrawn entirely: blocking every sign path until the user clicks "I acknowledge" is a textbook consent gate. Showing the user what degraded during the run is a fine **display**; it must never block the sign.
- **Resolve the keyboard-accessibility barrier** (LOW rider): today `onKeyDown` signs only at floor-0, so a keyboard/AT user cannot complete the publish act under the default non-zero hold — a real barrier, not a documented accommodation. Resolve it: **Enter/Space on the focused sign control is a deliberate sign** (an explicit discrete key activation is the keyboard equivalent of clearing the pointer hold; it can never auto-approve because nothing signs without an intentional keypress on the focused control) that routes through the **same emit-fidelity and ledger gates**. Floor-0 remains the documented **pointer** accommodation. Both keyboard behaviours are tested.
- **Add the honesty affordance** (LOW rider): under the paper/glass doctrine ("paper is what leaves the machine"), the shell's sign clears the staged paper while publishing NOTHING. Add a persistent "shell publishes nothing — real publishing lands in #21" notice so a shell sign can never read as a real publish.

## Capabilities

### New Capabilities

- `publish-safety-gate`: the red-provable safety guarantees the publish sheet must uphold before real publishing is wired — emitted bytes equal previewed bytes, a too-short hold never signs, a keyboard user can complete the act deliberately without weakening the no-passive-approval property, signing is blocked until run degradations are acknowledged, and signing in the shell honestly discloses that nothing left the machine.

## Impact

- Adds `packages/ui/src/components/publish-safety.dom.test.tsx` (mounted interaction + ledger-gate + keyboard tests) and an app-level clear-on-sign test (extends `packages/ui/src/app.test.tsx` or a new `app.dom.test.tsx`, mounting `RennetApp` with a minimal fake `RennetBridge`).
- Extends `packages/ui/src/components/publish-sheet.tsx` (the `PublishLedger` prop + the ledger gate + the resolved keyboard sign path + the honesty notice) and `packages/ui/src/canvas/destination.ts` (a pure `ledgerBlocksSign(ledger)` gate so the block is unit-testable alongside `resolveSign`). Optionally extends `packages/ui/src/index.ts` with the new pure exports and the stylesheet with the notice + acknowledge control.
- `layer:ui` stays clean: the `PublishLedger` is a UI-local view-model over `@rennet/types` primitives; nothing imports `@rennet/core`. No new package, no new runtime dependency, no dependency-arrow change — the `architecture` and `licenses` gates are untouched.
- No Git or GitHub mutation is added anywhere. This change hardens and gates the SHELL; #21 remains the slice that wires real publishing, and it is a hard merge-blocker on this gate being green.

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. #21 is not blocked on this change and never was; it shipped in `747d966`. Nothing in Rennet's plan may be gated on another change's ceremony being discharged first.
