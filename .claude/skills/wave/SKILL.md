---
name: wave
description: Use when dispatching implementer agents and review agents on Rennet issues. Encodes Rule Zero, the environment facts that must not be re-explained per dispatch, proportional review, and how to sort review findings before acting on them.
---

# Wave — implementer dispatch and review for Rennet

**The loop:** `openspec propose` (issue + wireframes + docs + AGENTS.md as input) → the same agent applies its own proposal → the orchestrator gates it and hands off to review → findings are **sorted** before any reach the implementer → the change is **archived** once it merges.


This exists because on 2026-08-11 a night of parallel agent work burned roughly half of Rai's Claude capacity, and **most of the burn was not building. It was ceremony around building** — reviewing, verifying, re-verifying, and fixing things nobody needed fixed. Every rule below is a specific thing that went wrong.

## ⛔ 0. Rule Zero governs everything here

**NO CONSENT GATES. NO GATES. NO ROBUSTNESS FOR ROBUSTNESS' SAKE.** See the top of `AGENTS.md`.

It outranks `docs/`. **The `docs/` directory contains ~30 files of R-numbered rulings that read as binding contracts, and at least one of them is actively wrong** (a blanket "read-only sandbox posture across all harnesses" written for the review harness, which structurally forbids the acting harness the product requires). An agent that inherits a doctrine from `docs/` and defends it is repeating the original failure.

**Treat `docs/` as history and rationale. Treat `AGENTS.md` as law.**

## 1. Do not re-explain the environment in every brief

Roughly a thousand words per dispatch went on repeating the same facts across about twenty dispatches. **They live here now. Point agents at this file instead of retyping them.**

- The gate is `NX_DAEMON=false pnpm check` from the worktree root. Green means exit 0 **and** the output contains `Successfully ran target`. Nx can exit 1 while succeeding under cache contention — read the output, not just the code.
- `rg` here accepts **extended** regular expressions only. `\|` alternation silently fails to parse; use `-e pat1 -e pat2`.
- ⛔ Never pipe a search through `head` when drawing a **negative** conclusion. Truncation manufactures an absence.
- `git status --porcelain` is proxied on this machine and prints `ok` for a clean tree. Use `git --no-pager status --short`.
- `noclobber` is on: force redirects with `>|`, and check mtime before believing anything you redirected into.
- ⛔ **A `git push` from a detached HEAD prints "Everything up-to-date" and pushes nothing.** `git ls-remote` is the authority; the local tracking ref is a cache a detached HEAD never updates.
- Adding a field to a type that crosses IPC requires adding it to the Zod schema in `packages/protocol`. Required fields are build-protected by a `z.ZodType<T>` annotation; **optional fields are not** and get silently stripped with every unit test still green.
- Each agent gets its own git worktree. **Never symlink a whole `node_modules` from another worktree** — pnpm's workspace links resolve `@rennet/*` to that worktree's source, so the gate reports green on code you are not changing. Install with `--offline --frozen-lockfile`.

## 2. Review proportionally — single by default

Dual adversarial review is expensive and it is not free insurance. Default to **one reviewer**. Escalate to two only when the change touches:

- the review engine itself (canvas, marks, lineage, dispositions, anything deciding what the human is shown)
- anything that can lose or corrupt the user's work
- anything that leaves the machine

**Skip review entirely** for changes that cannot reach the application — docs, the static site, isolated assets. State the reason in the PR rather than skipping silently.

⚠️ And do not double-gate. Running the full suite locally *and* letting CI run the identical suite is paying twice. Pick one; CI is the one that matters for a PR.

## 3. Tell reviewers about Rule Zero, or they will manufacture gates

A reviewer asked to find problems will find gate-shaped problems, because caution always has an argument. **Put this in every review brief:**

> Do not propose gates, consent steps, sandboxes, permission checks, or hardening for its own sake. If a finding's only fix is one of those, do not report it. A bug that makes the product do its job worse is in scope. A capability that makes the product harder to use safely is not.

**Ask reviewers to state what they mutated, not just what they concluded.** On one branch two reviewers reached opposite verdicts on the same mechanism purely because they had mutated different dimensions of it — and knowing what each varied is the only thing that let the contradiction be resolved.

## 4. ⛔ Sort findings before dispatching. Never relay a review verbatim.

**This is where the most time was wasted.** A review came back with eight findings; two were ceremony that Rai had already banned, and all eight were forwarded to the implementer as work.

Before sending any finding to an implementer, sort it:

- **Does the product do its job worse?** → fix it. A diff that does not show what changed, a crash, a lie in the UI, state attached to the wrong code.
- **Does it make the product harder to use safely?** → drop it, however good the argument.
- **Ambiguous?** → ask Rai. Do not resolve it yourself and do not pad the list.

A review is evidence. It is not a work order.

## 5. The implementer lifecycle: propose → apply → review → archive

**The implementer starts with an OpenSpec proposal, applies it itself, and then this skill hands the result to review.** Do not let an agent start editing code from a bare issue title.

### Step 1 — propose

The implementer runs the `openspec-propose` skill, with **four inputs named explicitly in the brief**:

1. **The GitHub issue** — `gh issue view <n>`, in full, including its acceptance criteria.
2. **The v3.2 wireframes** at `/Users/rai/dev/rennet/wireframes/` — **the canonical behavioural and visual spec.** Name the specific frames that bear on the issue; the agent should not read all of them.
3. **The relevant `docs/`** — as rationale and history, never as law. See Rule Zero.
4. **`AGENTS.md`** — the repo rules, which are law.

⭐ **Where the wireframe and the issue prose disagree, the wireframe wins, and the agent must say so in the proposal** rather than silently picking one. This has already happened once: an issue said an editable draft rendered "on the paper", the wireframes said the paper is frozen and the collation draft is the one editable surface, and the wireframes were right.

The proposal lands in `openspec/changes/<name>/` as `proposal.md`, `design.md`, `tasks.md` and `specs/`.

⭐ **Read the existing model before scoping the build.** More than one issue here has read like a feature and turned out to be three integration points against an abstraction the types already fully expressed. The first move is to find out which.

### Step 2 — apply

The same agent applies its own proposal (`openspec-apply-change`), working through `tasks.md`.

- **Tick the `tasks.md` checkbox in the same commit that completes the task.** The checked boxes are the progress record an interrupted session resumes from; a done-but-unchecked task reads as pending and gets redone, an unchecked-but-abandoned task needs a note saying why. Progress that is not a checked box or a commit does not exist.
- Worktree path, branch name, base commit and the current gate baseline go in the brief so nobody re-derives them.
- Red-proof every fix **with the prediction named before running it**, then restore and run the full green pass.
- ⛔ Never derive a test's assertions by reading your own implementation. That can only confirm it, bugs included. Assert the contract.
- ⛔ **Do not spawn review subagents.** The orchestrator owns the review gate. A reviewer spawned by an implementer is a separate session that cannot report back, so the implementer hangs forever waiting on a verdict that cannot arrive.
- Commit and push. State the tip, the counted whole-branch diff, the gate total reconciled against the baseline, and **anything left undone, named specifically.**

### Step 3 — hand off to review

The orchestrator, never the implementer, dispatches review at the pushed tip per §2 and §3. Verify the gate yourself first, on a clean tree, at the exact sha the agent reported — a self-reported green has been wrong more than once.

Then §4: **sort the findings before any of them reach the implementer.**

### Step 4 — archive the change

**Once the review fixes are done and the branch has merged, archive the OpenSpec change** (`openspec-archive-change`). This is the last step of the loop and it is not optional.

Before archiving, open `tasks.md` and reconcile it: every box checked, or unchecked with a note naming where the work went (cut, deferred to a named issue, deliberately unwired). Tick any box whose task verifiably shipped but was left unchecked — then the archive move (`openspec/changes/archive/YYYY-MM-DD-<name>/`) carries an honest ledger. For board-rebuild changes (`b*`/`c*`), this is also the moment the orchestrator flips the workstream's `BUILD-STATUS.json` entry.

An un-archived change stays in `openspec/changes/` looking like live in-flight work. The next agent proposing against the same area reads it as a pending intention rather than a shipped fact, and either duplicates it or designs around a constraint that no longer exists. That is the same "correct in a place that cannot produce action" rot this repo keeps producing in new costumes.

⛔ **Archive on the real outcome, not the intended one.** If the change shipped narrower than proposed — a task cut, a seam left deliberately unwired, a finding deferred to its own issue — say so as you archive and make sure the issue or a follow-up carries what did not land. **An archived change asserts "this happened"; if part of it did not, that assertion is a lie the next reader inherits.**

## 6. What good work looks like, from the night this file came from

- **Make it structural, not asserted.** A composition step that returns only a partition and never the bodies is *incapable* of dropping one. Better than a test proving it did not.
- **The reported instance is a sample, not the extent.** After fixing a reported class, probe its neighbours. One agent found a wrong-carry in `exact` after being told only about `move`, and shipping the reported fix alone would have left the product carrying approvals onto wrong code.
- **Disclose coverage gaps.** One agent said its guard had no dedicated red-proof and refused to claim it covered. That disclosure named the exact gap a real bug was hiding in.
- **A weakness with a loud failure mode is not a silent one** — but verify the alarm actually fires rather than reasoning that it would.
- **Refuse a bad instruction with evidence.** An agent declined to fix a defect the orchestrator had invented from phantom diagnostics, brought line counts and a clean typecheck, and asked which commit the orchestrator had gated. It was right.
