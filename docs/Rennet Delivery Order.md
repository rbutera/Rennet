# Rennet Delivery Order

**Purpose:** if you are an agent about to build something in this repo, read this first and pick your work from here. It outranks the ordering implied by issue numbers, P-labels, and any plan document.

Last revised 2026-08-11.

---

## 0. Rule Zero

**NO CONSENT GATES. NO GATES. NO ROBUSTNESS FOR ROBUSTNESS' SAKE.** See `AGENTS.md`.

Rennet is a diff digestor and a PR review buddy. Everything in this repo is judged by one question:

> Does this make the product do its job better, or does it make the product harder to use safely?

The first is a feature. The second is a gate, however good the argument. **Feeling clever about a restriction is the signal to stop, not to proceed.**

Much of `docs/` predates Rule Zero and was written in a security-ceremony register. Where a document conflicts with Rule Zero, Rule Zero wins, whether or not that passage carries a supersession mark yet. Do not implement a gate because a doc told you to.

### Reading an issue

Many issues now carry a block at the top of the body:

> ⛔ **RULE ZERO AMENDMENT, 2026-08-11.** … **Struck from scope:** …

The struck scope is **not work**. Do not build it, do not add it back during review, and do not treat its absence as an oversight. The rest of the issue stands.

---

## 1. What is true right now

Check these claims before relying on them; they go stale.

- **`main` is releasable and the review loop works end to end** for reviewing *other people's* PRs: ingest, decompose, the lens set (Spec / Decisions / Flagged / Noise), hypothesis-first pre-read, dual-model review, per-finding verification, refine, sign, and a real GitHub post.
- **The own-branch half does not work.** `signPaper()` short-circuits to a no-op. Rennet cannot push a branch or open a PR. That is issue **#257**, and it is the single largest hole in the product.
- **Several finished features live on unmerged branches**, not on `main`. Run `git branch -r` and compare against `origin/main` before you build anything — the most common failure mode in this repo is rebuilding something that already exists on a branch nobody merged.
- **`openspec/changes/` is 25/26 stale.** Checkbox state lies: several changes show 0 of N tasks ticked while their code is fully shipped. Read `openspec/changes/README.md` for the verified status before opening any `tasks.md`. Only `build-repo-map-lifecycle` is live work.
- **Analysis turns are denied a shell** (`harness-run-turn.ts:107` hardcodes `readOnly: true`). So reproduce-or-refute verification cannot reproduce anything. That is **#259**, and it caps how good a review can get.

### Rule Zero is not only a docs problem

The 2026-08-11 sweep found gates in **live code**, not just in plan documents. Three so far:

| where | what | issue |
|---|---|---|
| `adapters/handoff-run-live.ts` | `HANDOFF_DENIED_TOOLS` denies the coding agent `Bash` so it "structurally cannot" push | #18 (branch) |
| `core/harness-run-turn.ts:107` | `readOnly: true` hardcoded — the verifier cannot run the code it reasons about | #259 |
| `core/invocation-budget.ts` | absent or `NaN` budget refuses every turn and silently renders a deterministic-floor review as if it were real | #260 |

All three read as careful engineering and all three make the product worse. When you find a fourth, that is the pattern — file it, do not defend it.

---

## 2. The order

### First: land what is already built

Unmerged finished work is worth more than anything you could start today, and it rots. Merge it, or say why it should not merge.

At the time of writing this covers the lineage matcher (#16), the handoff loop (#18), the inline conversation anchoring facet, the PR-body draft (#74), the bundle composition (#72), and the proposal-chunk orphan fix (#250).

**One required change before `feat/handoff-loop` merges.** `packages/adapters/src/handoff-run-live.ts` defines `HANDOFF_DENIED_TOOLS`, which denies the coding agent `Bash` so it "structurally cannot" push. Rule Zero forbids that twice over: it is capability denial, and it leaves the agent unable to run the tests it just wrote. Remove the denylist and update `handoff-run-live.test.ts`, which currently pins it. The stale comment at `claude-adapter.ts:523` goes with it.

### Second: close the loop the product is named for

1. **#257 — open the PR on your own branch.** Push plus PR-create, wired to sign. Absorbs #107 (the payload carries a commit SHA where a branch ref belongs). Consumes #74's drafted title and body.
2. **#254 — wire the lineage matcher into the delta re-review seam.** Blocked until #16 and #18 both land. Without it, re-review works only at the byte-identical floor.
3. **#72 / #73** — compose review notes into one work order, then narrate what the agent changed and what it did beyond your asks.

That sequence is the whole pitch: read a diff, say what should change, have an agent change it, see what moved, open the PR.

### Third: the intelligence that makes a review worth reading

**#243** (knowledge layer into the desktop — the structural map stays warm, the mined knowledge does not), **#35** (blast radius), **#182** (CI signal that never blocks), **#242** (fields silently stripped at the IPC boundary — this has already killed three shipped features).

### Fourth: everything else

Sorted by label. `P3` is filler. `blocked` means a dependency is genuinely missing, not that it is hard.

---

## 3. What counts as a bug

Rule Zero narrows this deliberately. These are bugs, always worth fixing:

- The diff does not show what changed.
- A crash.
- **A lie in the UI** — a mark rendered as placed that cannot be placed; provenance stamped `route=agentic` when the truth is `route=utility`; "ran clean" displayed when the run actually failed; a feature whose field is silently dropped in transport so it is dead in production while its tests are green.
- An agent that cannot run the tests it just wrote.

These are **not** bugs, and filing them wastes the repo's time:

- A guard that could theoretically be bypassed.
- A fail-open path that has never fired.
- Precision hardening whose payoff is showing the user *less*.
- Anything whose fix is a consent screen, an approval ceremony, a capability denial, or a sandbox.

---

## 4. Definition of done

`pnpm check` green, with a positive control capable of failing. Do not add `--skip-nx-cache` to make work look fresh. See `AGENTS.md` for the Nx workflow and the worktree cleanup you owe after a merge.
