---
title: Reader personas
description: The people Rennet documentation is written for, and how to check a page against them.
---

Rennet has two documentation audiences and a few distinct readers inside each. These personas name those readers so you can write for a real person instead of an average one, and so an interface or docs critique has concrete failure modes to test against.

Every trait below comes from the product sources: [Product and vision](../../using/concepts/product-and-vision.md), `PRODUCT.md`, and `DESIGN.md`. Do not invent audience details beyond them.

## Using Rennet readers

These readers run reviews. They do not have the codebase open, and most of them do not want to.

### Agentic engineer reviewing their own branch: "Mara"

**Profile**: Ships fast with Claude Code and Codex and hand-writes little, but signs off on every merge and answers for it. Faces changesets too large to read file by file and wants grouped cohorts and a reading order, not a flat list of changed files.

**Behaviors**:
- Opens working-tree and committed changes, not only merged pull requests.
- Acts at whatever altitude fits the moment: the whole review, one cohort, or a single line.
- Sends dispositions back to a coding agent as a work order, then reviews only the resulting delta before pushing.
- Expects installed agents to work with no extra config, no separate API key, and no account.

**Red Flags**:
- Copy that implies Rennet approved the change or found a bug for her; she owns the verdict.
- Grouping or reading order she cannot open up to the underlying hunks and decisions.
- A guide that stops at "review a pull request" and never shows the own-branch handoff and rereview loop.
- Any hint that she needs a Rennet backend, a model API key, or an inference markup.

### Team reviewer on a pull request: "Tomas"

**Profile**: Reviews other people's GitHub pull requests and posts one review under his own name, in his own words. Knows the GitHub review flow well but is new to Rennet's lenses.

**Behaviors**:
- Opens a GitHub pull request and reads it in comprehension order through the Spec, Sequence, Decisions, Noise, and Flagged lenses.
- Records dispositions against a cohort, requirement, chunk, range, or line.
- Reads what the models flagged, then decides for himself what counts as a real problem.
- Edits the review preview and posts one batched GitHub review when he is ready.

**Red Flags**:
- Text that presents a model finding as his conclusion, or anything that posts before he clicks.
- An internal term (patchset, cohort, daemon) dropped into a using page where "pull request" or plain words would carry the meaning.
- A preview that hides what will actually be sent to GitHub.
- Recorded dispositions that vanish when he switches lenses or navigates away.

### Local-first adopter: "Rune"

**Profile**: Deciding whether to run agent-assembled context through Rennet, and wants to know exactly what leaves the machine. Values honest provenance over marketing and reads concept and FAQ pages closely before installing.

**Behaviors**:
- Looks for what Rennet sends, to which harness and provider, and what stays local.
- Checks whether Rennet stores harness credentials or adds an inference markup, and finds it does neither.
- Confirms that `.rennet/` is local and never staged or committed.
- Distrusts any blanket "nothing leaves your machine" line and hunts for the real boundary.

**Red Flags**:
- A page that claims nothing ever leaves the machine instead of naming harness and provider egress.
- A provenance label that says sent, read, or verified when Rennet did not do that.
- Fear-based security language, or invented telemetry, benchmarks, or testimonials.
- A consent dialog standing in for one honest sentence of disclosure.

## Developing Rennet reader

This reader builds Rennet with the repo open.

### Rennet contributor: "Wei"

**Profile**: Reads the contracts, rulings, and dependency standard before changing product behavior. Works under Rule Zero, so she adds capability rather than gates or ceremony, and treats the docs as part of done.

**Behaviors**:
- Starts at `docs/README.md` to find the authority for the part she is touching.
- Checks package import boundaries and the Nx graph before adding code.
- Runs the full local gate before pushing and keeps `main` releasable.
- Updates the affected page in the same change, not as a follow-up.

**Red Flags**:
- A page that invents a work queue the issue tracker does not carry, or narrates archived history as if it were current.
- Guidance that adds a gate, sandbox, or consent step and calls it robustness.
- A reference page that disagrees with the code, the Nx graph, or accepted OpenSpec behavior.
- Missing frontmatter, the wrong audience area, or an internal name leaked into a using page.

## How to use these personas

Pick the one or two readers a page actually serves, and write for them: match their vocabulary, answer the question they arrive with, and put the shortest path to it first. A using page written for Mara or Tomas should not read like it was written for Wei.

Before you call a page done, read it once as each of its personas and check it against their red flags. If the page would lose that reader or mislead them, it is not done yet. The same red-flag list feeds the interface critique in the impeccable skill, so a check written here does double duty.
