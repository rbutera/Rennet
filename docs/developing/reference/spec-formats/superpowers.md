---
title: Superpowers spec and plan formats
description: The exact spec, plan, and execution-ledger artifacts obra's Superpowers plugin produces, for the Design lens to render.
---

[Superpowers](https://github.com/obra/superpowers) is a Claude Code plugin whose skills drive a brainstorm to spec to plan to execution workflow. Each stage writes a Markdown artifact with a mandated shape. This page documents those shapes so Rennet's Design lens can render them as structured objects instead of raw Markdown.

Source: the installed plugin at `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/`, cross-checked against [github.com/obra/superpowers](https://github.com/obra/superpowers). Skills cited by name below map to `skills/<name>/SKILL.md`.

## Artifacts and where they live

The workflow classifies every request as **spike**, **bounded**, or **architectural** (`brainstorming`). Only the architectural path produces durable files; spikes and bounded work stay in chat.

| Artifact | Default path | Produced by |
|---|---|---|
| Design doc (spec) | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | `brainstorming` (architectural path), committed to git |
| Implementation plan | `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` | `writing-plans` |
| Execution ledger | `<repo-root>/.superpowers/sdd/<plan-basename>/progress.md` | `subagent-driven-development` (git-ignored scratch) |
| Task briefs / reports / review packages | `<repo-root>/.superpowers/sdd/<plan-basename>/` | `subagent-driven-development` scripts |

User preferences override the default `docs/superpowers/specs` and `docs/superpowers/plans` locations, so a renderer must not hard-code them — discover the file, then parse by shape.

Work runs in an isolated git worktree (`using-git-worktrees`): a native worktree tool if the harness has one, else `.worktrees/<branch>` at the repo root, verified git-ignored before creation.

## The plan document

`writing-plans` mandates a fixed header followed by numbered tasks. The header is verbatim-required:

````markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements]

## Global Constraints

[Project-wide requirements — version floors, dependency limits, naming and
copy rules — one line each, values copied verbatim from the spec.]

---
````

Each task then follows this structure exactly:

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [signatures this task uses from earlier tasks]
- Produces: [exact function names, parameter and return types later tasks rely on]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**
````

Structural rules a renderer can rely on:

- **Task granularity.** A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. Each task ends with an independently testable deliverable.
- **Step granularity.** Each step is one action of 2-5 minutes, and the canonical TDD sequence is write-failing-test, run-to-fail, implement-minimal, run-to-pass, commit. The last step of a task is a `git add` + `git commit` block — the commit point.
- **Exact paths, no placeholders.** Every `Files:` entry is a real path, `Modify` entries carry `:line-range`, and steps carry actual code or commands. `TBD`, `TODO`, "add error handling", or "similar to Task N" are declared plan failures — a renderer will not encounter them in a well-formed plan.
- **`Run:` / `Expected:` pairs** give each verification step a command and its expected outcome (FAIL with a reason, or PASS).

## The design document (spec)

On the architectural path, `brainstorming` writes the validated design to the specs directory after per-section user approval and a self-review pass (placeholder scan, internal-consistency check, scope check, ambiguity check). The skill mandates the section topics the design covers rather than a rigid template heading set:

- **Architecture** — the overall approach.
- **Components** — the units the system breaks into, each with one clear purpose and a defined interface.
- **Data flow** — how data moves between components.
- **Error handling.**
- **Testing.**

Each section is scaled to its complexity (a few sentences up to ~200-300 words). The spec is the binding authority the plan argues from; the plan's `**Spec:**` header links back to it, so the two travel together.

## Execution semantics a viewer can surface

Two skills execute a plan; both consume the same checkbox plan.

**`executing-plans`** (inline, one session) loads the plan, creates one todo per task, and runs each task's steps in order, running the `Run:`/`Expected:` verifications as written. It stops on a blocker rather than guessing, and hands off to `finishing-a-development-branch` when done.

**`subagent-driven-development`** (the recommended path) dispatches a fresh implementer subagent per task and gates each task with review:

- **Per-task review.** After each task the controller dispatches a task reviewer that returns two verdicts — **spec compliance** (`✅` / `❌`) and **code quality** (approved / issues). Both are required; neither the implementer's self-review nor a passing spec check alone completes a task.
- **Fix loop.** Findings are categorized **Critical / Important / Minor**. Critical/Important (and confirmed spec ❌) enter a fix loop of at most 5 rounds, each round being one fix dispatch plus one scoped re-review that verdicts every finding `ADDRESSED` / `NOT ADDRESSED`. Minor findings are deferred to the ledger, never looped.
- **Final review.** After all tasks, one whole-branch review runs on the most capable model, using the `requesting-code-review` template (Strengths / Issues by severity / Recommendations / Assessment with a `Ready to merge? Yes | No | With fixes` verdict).
- **Review checkpoints between phases.** The task gate is the phase boundary — the controller never advances to the next task while Critical/Important findings are neither fixed nor explicitly parked with a recorded ruling.

**The ledger** (`progress.md`) is the durable execution state, since conversation memory does not survive compaction. Its first line is `# SDD ledger — plan: <plan file path>`. Line kinds a renderer can parse:

- `Task <N>: complete (commits <base7>..<head7>, review clean)` — a done task, with its commit range.
- `Task <N>: complete (commits ..., <K> parked)` — done after a tripped breaker.
- `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — ...; commits <a7>..<b7>)` — a task mid-loop.
- `Task <N>: minor (deferred): <one-liner>` — a deferred Minor finding.
- `Ruling: <what was decided> — <why> — <what it costs if wrong>` — a controller decision made in place of asking the human.

A task with a `complete` line is DONE; the first task without one is where execution resumes.

## Rendering affordances

What the Design lens can exploit, in descending order of structural reliability:

- **Plan task/step tree.** `### Task N:` headings and `- [ ]` / `- [x]` steps are a machine-parseable outline. Render it as a collapsible phase→task→step tree with live checkbox state.
- **File-touch lists.** Each task's `**Files:**` block (Create / Modify / Test, with line ranges on Modify) is a per-task change manifest — render it as a file-impact badge set and cross-link to the diff.
- **Verification status.** `**Step: Run test to verify it fails/passes**` steps with their `Run:` / `Expected:` pairs are the per-task done criteria — render each as a check with its command and expected result.
- **Interfaces graph.** `**Interfaces:** Consumes / Produces` blocks name the signatures tasks share — a dependency edge between tasks the lens can draw.
- **Ledger overlay.** Parse `progress.md` to overlay real completion state onto the static plan: which tasks are complete (with commit ranges), which are mid-fix-loop, and the `Ruling:` decisions — the one place controller decisions surface to a human.
- **Spec sections.** The design doc's Architecture / Components / Data flow / Error handling / Testing topics are conventional, not rigid headings, so treat them as a soft outline (heading match with fallback), not a guaranteed schema.
- **Header key-values.** The plan's `**Goal:** / **Architecture:** / **Tech Stack:** / **Spec:**` lines and `## Global Constraints` are a reliable metadata card; the `**Spec:**` value is a link to render the design doc alongside the plan.
