---
title: Delivery order
description: The current build sequence, the live gaps that matter most, and the definition of done for work on Rennet.
---

Read this before choosing product work. It outranks the ordering implied by
issue numbers, priority labels, and historical plans. Re-check the linked issues
before acting: this page is orientation, while GitHub is the live queue.

Last checked against `main` and GitHub on 2026-08-14.

## Rule Zero

**No consent gates. No capability gates. No robustness for its own sake.**

Ask one question: does the change help Rennet digest a diff and help a person
finish a review, or does it mainly make the capable product harder to use?

Historical plans may argue persuasively for restrictions. Rule Zero wins. A
human signing something that will appear under their name is a product action;
blocking the coding agent from running tests or pushing its branch is not.

## What works now

Both current GitHub destinations are wired end to end:

- A team pull request can be ingested, decomposed, reviewed through the lens
  set, refined, previewed, signed, and posted as one real GitHub review.
- A review of your own branch can produce a drafted title and body, sign, push
  the named branch, and create the pull request. The create path is idempotent by
  head branch and surfaces the resulting URL.
- The coding-agent handoff backend and exact-evidence delta carry have landed,
  and the renderer now wires the loop end to end. Per #72, `review.handoff.run`
  executes the exact composed bundle `review.handoff.compose` produced
  (digest-bound, refusing a tampered or stale bundle); a pure stage-6 preview
  view-model plus paper component render that composed bundle before it runs; and
  the own-branch destination offers a "Hand off to agent" path that composes on
  surface entry, previews, and runs the exact previewed bundle from one action,
  surfacing the outcome truthfully. The next slice is consuming the run's
  successor patchset into a delta re-review (#73). The fuzzy sub-file matcher
  exists but is not connected to disposition carry. When the acting path is
  called, the agent is allowed to edit and test with the full harness tool surface.
- Blast radius, the project knowledge lifecycle, IPC field-fidelity fixes,
  shell-enabled verification turns, and honest invocation-budget behavior have
  all landed since the previous delivery-order snapshot.

That closes the most obvious “review buddy cannot finish the review” holes. Do
not rebuild them from old issue prose.

## What matters next

### Complete the context and regeneration spine

The remaining open P1 issues describe the deeper review-context contract:

1. [#30 — deterministic ContextManifest](https://github.com/rbutera/rennet/issues/30): make the assembled fleet context inspectable and reproducible.
2. [#15 — context.ask](https://github.com/rbutera/rennet/issues/15): give the orchestrator one honest retrieval tool over project knowledge.
3. [#38 — affected-only regeneration](https://github.com/rbutera/rennet/issues/38): turn patchset invalidation into a useful successor-review experience.
4. [#28 — settings v1](https://github.com/rbutera/rennet/issues/28): finish the layered resolver and settings surface without turning setup into ceremony.

These reinforce the core loop: the models see the right material, the reviewer
can ask for missing context, and a new patchset does not force a full restart.

### Make the agent loop easier to read

- [#72](https://github.com/rbutera/rennet/issues/72) composes several review notes into one coherent work order — the composed bundle runs (digest-bound), previews on the stage-6 paper, and the renderer now wires compose→preview→run end to end from the own-branch destination.
- [#73](https://github.com/rbutera/rennet/issues/73) narrates what the coding agent changed, including work beyond the asks.
- [#182](https://github.com/rbutera/rennet/issues/182) brings CI signal into the review without turning it into a blocker.

### Release when the external pieces are ready

[Issue #298](https://github.com/rbutera/rennet/issues/298) owns public macOS
signing, GitHub release publishing, and updates. It is blocked on external setup,
not on another in-product ceremony.

## How to read an issue

Some older issues carry a Rule Zero amendment with struck scope. Struck scope is
not work. Also check whether the issue is already closed and whether its shipped
commit is on `main`; several old documents described completed features as
missing.

Use this order of evidence:

1. Current live code and the real call path.
2. Current issue state and its closing note.
3. Promoted OpenSpec requirements.
4. Historical plans and archived changes.

## What counts as a bug

Always worth fixing:

- The diff does not show what changed.
- A crash.
- A UI state that claims work succeeded, content exists, or a mark was placed
  when the live path says otherwise.
- A transport that silently strips a field.
- A test that stays green when its claimed guard or integration is deleted.
- An agent that cannot run the test or push the branch needed to finish its job.

Not a product bug by itself:

- A theoretical bypass with no demonstrated product failure.
- Precision hardening whose payoff is showing the user less.
- A proposal whose fix is an approval ceremony, consent token, sandbox, or
  capability denial.

## Definition of done

Run the full repository gate:

```sh
pnpm check
```

The gate includes a positive control that must be capable of failing. Use the
Nx cache when its declared inputs match; do not add `--skip-nx-cache` to make a
result look fresher. Update the affected docs in the same change, push, and
verify the remote ref matches local `HEAD`.
