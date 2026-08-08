---
categories:
  - projects
tags:
  - code-reviews
  - ux
  - design
created: 2026-08-04
---

# Code Review App UX Research

Discovery context-gathering for [[Code Review Harness App]]: a desktop-native (macOS first) code review tool powered by an LLM harness, interoperable with GitHub PRs, focused on making large, often LLM-generated PRs digestible. This note surveys the state of the art in diff/review UX, the research on large-changeset review, native macOS design language, LLM-in-the-loop review patterns, and mobile companion prior art.

---

## 1. Diff and review UX: state of the art

### Hunk (the reference point, with a correction)

Important discovery: [[Hunk]] at [hunk.dev](https://www.hunk.dev/) is **not a native macOS GUI app**. It is a review-first **terminal diff viewer** (TUI), MIT-licensed, built by Modem, written for "agentic coders". Cross-platform (macOS, Linux, Windows), installed via `npm i -g hunkdiff` or Homebrew. Source: [modem-dev/hunk](https://github.com/modem-dev/hunk). There is also a separate [smolcars/hunk](https://github.com/smolcars/hunk), a GPUI-based diff viewer and Codex orchestrator "for vibe engineering". Worth confirming with Rai which one he means; if the pitch is "rebuild Hunk as a real native app", the terminal version leaves the native-GUI slot genuinely open.

What Hunk gets right, and what we should steal:

- **Review stream, not file dump.** Opens the whole changeset as one navigable stream with a multi-file sidebar, rather than N separate diffs.
- **Split / stacked / auto layouts** that respond to available width. A desktop app should do the same responsive collapse.
- **Inline agent annotations**: AI reasoning rendered beside the exact code it discusses, instead of living in a separate chat transcript. This is the single most transferable idea. The agent explains itself in the margin of the diff, not in a sidebar wall of text.
- **Watch mode**: the review session stays open while an agent edits the working tree in another terminal; the diff live-reloads. Maps directly to our "review while the harness works" loop.
- **Every keyboard shortcut is a named command** with remappable bindings. Command-as-primitive, keys-as-bindings is the right architecture for a keyboard-first app.
- **Skill-file agent integration**: agents load a Hunk skill to write structured notes into the review. A clean precedent for harness-to-review-surface protocol.
- Positioning line worth noting: "optimized for reviewing a full changeset interactively", explicitly not a structured-diff or formatting tool.

### GitHub PR review: the failure modes we exist to fix

GitHub's own community discussions are a catalogue of large-PR pain ([#10830](https://github.com/orgs/community/discussions/10830), [#5054](https://github.com/orgs/community/discussions/5054), [#141109](https://github.com/orgs/community/discussions/141109), [#39341](https://github.com/orgs/community/discussions/39341)):

- **Performance collapse**: filtering a 200-entry file tree can lock the browser for ~10s; one reported PR with 307 files took days, with ~5s to mark a file viewed and 8-10s per diff load. Hard limits: 1,000 files in single-file mode historically, ~3,000 files in the new virtualized "Files Changed" view (Jan 2026, [#163932](https://github.com/orgs/community/discussions/163932)).
- **Comment disassociation**: when an author fixes a flagged line, the review comment often detaches and vanishes from "changes since last review", so reviewers cannot verify their feedback landed. Coverage tracking that survives force-pushes is a real gap.
- **The unit of review is wrong**: the sum of all commits on a branch, presented as an alphabetical file list. No narrative, no grouping by concern, no dependency order.
- GitHub knows this: it is building **native stacked PRs** ([InfoQ, April 2026](https://www.infoq.com/news/2026/04/github-stacked-prs/)), which validates the problem but attacks it at the authoring end (make PRs smaller) rather than the reviewing end (make big PRs digestible). Our product attacks the reviewing end, which matters because LLM-generated PRs arrive big whether or not the author stacked them.

### Graphite

[[Graphite]] ([graphite.com](https://graphite.com/)) is the strongest stacked-diff product. Key UX observations ([stacked diffs guide](https://graphite.com/guides/stacked-diffs), [benefits](https://www.graphite.com/guides/benefits-of-stacked-diffs-in-code-review)):

- **PR inbox as email client**: sections like "Needs your review" / "Waiting for review". Review is a queue you drain, not a page you visit. Strong pattern for our home screen.
- Each diff in a stack depends on the previous one, creating a **forced reading order**. That is exactly the "reviewable narrative" idea, but Graphite requires the author to construct it at write time. We construct it at review time, post hoc, from an unstructured PR.
- Praised for polished keyboard-driven review flow; criticised for a steep learning curve and for the diff view's comment panel layout ([Product Hunt reviews](https://www.producthunt.com/products/graphite/reviews)). Lesson: stacking mental models are expensive to teach; a tool that produces the same sequencing benefit without asking the author to change workflow has a real wedge.

### CodeRabbit

[[CodeRabbit]] is the closest prior art for LLM-structured review ([walkthrough docs](https://docs.coderabbit.ai/pr-reviews/walkthroughs), [layer-based walkthroughs](https://www.coderabbit.ai/blog/coderabbit-review-reads-a-pr-how-author-would-explain-it)):

- **Walkthrough comment** at the top of the PR: grouped changed-files table (a PR touching 1 source file + 27 localization files renders as two rows), each row with a plain-language description; optional Mermaid **sequence diagrams** for changed interaction flows.
- **Layer-based walkthroughs** reorganise the PR into "cohorts": semantically related blocks, ordered by dependency (schema, then business logic, then call sites, then frontend, then tests). Their stated framing: the real question is "what meaningful change happened?", not lines added/deleted. This is precisely our cohort/narrative concept, but delivered as a **GitHub comment**, so it stays a wall of markdown divorced from the diff. Our advantage: the cohort model can BE the navigation structure of a native app, not an annotation bolted onto GitHub's file list.
- They also do semantic search across summaries, useful in large PRs.

### Gerrit

[[Gerrit]]'s patchset model ([walkthrough for GitHub users](https://gerrit-review.googlesource.com/Documentation/intro-gerrit-walkthrough-github.html)) contributes two durable ideas:

- **The commit is the unit of review**, and every iteration of it is a preserved patchset. Reviewers can diff patchset N against patchset N-1, so a force-push never resets the review. This is the correct answer to GitHub's comment-disassociation bug and the model our coverage tracking should emulate internally: track review state against logical chunks, diff chunk versions across pushes.
- **Label-based approvals** (Code-Review +2, Verified +1) separate "a human read this" from "the machine checked this". Relevant to keeping the human gate explicit while the harness does structural work.

### Native git clients: GitButler, Sublime Merge, Tower, Fork

- [[GitButler]] ([virtual branches](https://docs.gitbutler.com/features/virtual-branches/virtual-branches)): multiple branches applied to the working directory at once, each a **vertical lane**, with drag-and-drop of hunks between lanes. The transferable idea is direct manipulation of hunks as first-class draggable objects, which is how cohort re-grouping should feel: if the LLM put a hunk in the wrong cohort, you drag it to the right one.
- [[Sublime Merge]]: the performance benchmark. Custom Git library and rendering engine, stays fast on huge repos, **command palette for every action**, syntax-highlighted diffs ([comparison](https://www.git-tower.com/compare/sublime-merge)). Its reputation is built almost entirely on speed plus keyboard access.
- [[Fork]] and [[Tower]]: both ship command palettes; Fork is repeatedly cited as the best speed/value balance, Tower as the full-featured daily driver ([Tower's own roundup](https://www.git-tower.com/blog/best-git-client)). Notable: none of these clients does serious PR *review*; they are commit/branch tools. The native-app review niche is thin, which is the opportunity.

---

## 2. Reviewing large changesets: the research

### The 400 LOC cliff

The canonical numbers come from the SmartBear/Cisco study: 10 months, 2,500 reviews, 3.2M LOC ([best practices](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/), [Cisco case study PDF](https://static0.smartbear.co/support/media/resources/cc/book/code-review-cisco-case-study.pdf)):

- Defect discovery ability drops sharply **beyond 200-400 LOC per session**.
- Review speed matters independently: reviewers slower than ~400 LOC/hour found above-average defect counts; faster than ~450 LOC/hour, defect density was below average in 87% of cases.
- Detection plummets after **60-90 minutes** of continuous review.
- A 200-400 LOC review over 60-90 minutes yields 70-90% defect discovery.

Design implications, stated bluntly:

- The product's core job is to decompose an N-thousand-line PR into a sequence of sub-400-LOC cohorts, each reviewable in one sitting. The numbers give us the chunk-size budget.
- Pace is a first-class signal. If the user blows through 2,000 lines in 20 minutes, the tool knows the review was theatre. Whether and how to surface that is a design tension (see below), but the data justifies tracking it.
- Session boundaries matter: after ~60-90 minutes the tool should make stopping cheap (perfect resume state) rather than encouraging a heroic single pass.

### Review-by-commit vs review-by-file vs review-by-concern

Practitioner writing converges on the same diagnosis ([commit-by-commit](https://nicholashirsch.medium.com/code-reviews-in-git-commit-by-commit-ae02f8dcd9a0), [making reviewers love big PRs](https://ieftimov.com/posts/how-to-make-reviewers-love-your-big-pull-requests/), [review styles](https://gitting.substack.com/p/pull-request-review-styles)):

- Commit-by-commit review works because commits are a **storytelling vehicle**: chapters in chronological order, each logically cohesive, with the message conveying intent and relative importance.
- But it only works when the author curated the history. The standard advice is literally "tell the reviewer whether your commits are worth reading in order". LLM-generated PRs almost never have a curated history, so the story must be **reconstructed at review time**. That is the product.
- Review-by-concern (CodeRabbit's cohorts, dependency-ordered) is the generalisation: group by what changed semantically, sequence by what depends on what, and let mechanical bulk (renames, lockfiles, generated code, localization) collapse into single skimmable rows.
- Progressive disclosure in practice: show the narrative first (what happened and why, per cohort), the grouped summary second, the raw diff last, with the raw diff always one keystroke away. Trust dies the moment the summary is the only view.

---

## 3. Native macOS design language, 2025/26

### Liquid Glass and the current HIG direction

[[Liquid Glass]] (announced WWDC June 2025, spans macOS Tahoe 26 and iOS 26; [overview](https://en.wikipedia.org/wiki/Liquid_Glass), [developer guide](https://github.com/giorgio-a11y/liquid-glass-guide/blob/main/LIQUID-GLASS-GUIDE.md)):

- Controls float above content on translucent glass layers; the HIG's explicit principle is **content leads, controls recede**. For a diff app that is convenient doctrine: the diff is the content, chrome should be glass.
- Practical adoption: system materials (`.ultraThinMaterial` etc.) and **semantic colors**, never hard-coded colors, so the app inherits system-wide material updates and dark mode for free.
- Accessibility caution flagged by designers ([designedforhumans](https://designedforhumans.tech/blog/liquid-glass-smart-or-bad-for-accessibility)): translucency degrades contrast. Code and diff gutters need opaque, high-contrast surfaces; save the glass for toolbars and palettes.

### What actually makes an app feel native and fast

The Linear/Raycast/Warp cluster shows "native feel" is mostly **latency and keyboard grammar**, not toolkit choice ([Linear performance breakdown](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown), [Linear design patterns](https://gunpowderlabs.com/2024/12/22/linear-delightful-patterns)):

- [[Linear]] is Electron-adjacent web tech yet reads as fast because: the command palette searches a **local object pool, not a server**; every common action has a shortcut; animations touch only GPU-composited properties (transform, opacity), never layout. Local-first data plus optimistic writes means interactions complete in one frame and sync later. For us: clone the repo locally, compute diffs locally, sync review state to GitHub in the background. Never make a keystroke wait on the network.
- [[Raycast]] demonstrates the grammar: one hotkey, type intent, instant filtered results, minimal chrome so hands never leave the keyboard ([Raycast for designers](https://www.hackdesign.org/toolkit/raycast/)).
- [[Warp]] shows a from-scratch GPU-rendered UI can out-native native, and that developers accept novel UI in a dev tool when it is visibly faster.
- The synthesis for our stack decision: users cannot detect Tauri vs Electron vs AppKit directly; they detect input latency, scroll performance on 5,000-line diffs, correct system behaviors (menu bar, standard shortcuts, Services, window management) and platform conventions. Sublime Merge earned its reputation with a custom renderer; Hunk earned it in a terminal. The bar is: 120Hz scrolling on giant syntax-highlighted diffs, sub-frame keystroke response, real menu bar and command palette parity (every menu item a command, every command palettable and bindable, like Hunk's named-command model).

---

## 4. LLM-in-the-loop review UX

### Presenting AI findings without drowning the human

Findings from the AI-review tool landscape ([false-positive analysis](https://www.codeant.ai/blogs/ai-code-review-false-positives), [Greptile guide](https://www.greptile.com/what-is-ai-code-review)):

- **False-positive budget is the whole game.** At a 10% FP rate on 250 weekly suggestions, teams burn ~4 hours/week investigating noise; practitioner guidance targets under 5-10% FPR before trust collapses. Alert fatigue is measurable: when developers override more than ~30% of flags, the tool is dead to them.
- Working patterns: **confidence scores** used for triage routing (Greptile scores 1-5), configurable **severity thresholds**, findings **ranked by impact** rather than file order, and a verification/filtering pass before anything is shown. Multiple agents propose, a verifier culls, the survivor list is ranked.
- Dismissal must be cheap, sticky, and teachable: one keystroke to dismiss, with the dismissal recorded as feedback so the same class of finding stops appearing. A dismissal that comes back next push is how tools get uninstalled.
- CodeRabbit's structural insight applies here too: findings attached inline at the exact code location beat a summary dump, but a large PR needs a **triage layer above the inline layer** (severity-ranked queue you work through, each item deep-linking into the diff).

### Human-gated AI actions: draft-then-approve

The emerging pattern language ([draft-approve-execute](https://medium.com/data-science-collective/human-in-the-loop-for-ai-agents-draft-approve-execute-c7fe0b72b0af), [HITL approval framework](https://www.agentic-patterns.com/patterns/human-in-loop-approval-framework/), [AI UX Playground](https://www.aiuxplayground.com/pattern/human-loop)):

- Core principle: humans are better at **evaluating options than generating them**. The agent drafts; output lives in an explicit draft state; the human edits and promotes. Applied to us: the LLM drafts cohort groupings, sequencing, summaries, comments, and even a proposed review verdict, and every one of those is a draft the human can edit before anything touches GitHub.
- **Classify every agent action by severity and reversibility before building the workflow.** For a review tool the taxonomy is clean: reading/grouping/summarising is reversible and free; posting comments is semi-reversible (visible to colleagues); approving a PR is the crown-jewel irreversible action and must never be automatable. Approve should be un-defaultable: no "approve all", no approval while unreviewed cohorts remain, or at minimum a loud accounting of what was skipped.
- Supporting mechanics worth building in from day one: approval packets (the exact bundle of comments/verdict shown pre-send), resumable interrupts (close the laptop mid-review, resume exactly), audit log of what the AI did vs what the human did.
- Anti-goal: approval spam. If every trivial AI step demands a click, users rubber-stamp and the gate becomes theatre. Gate the few irreversible actions hard; let everything else flow and be undoable.

---

## 5. Mobile companion patterns

- [[GitHub Mobile]] is the main prior art ([code review on mobile](https://github.blog/2020-10-14-even-better-code-review-in-github-for-mobile/), [community guidance](https://github.com/orgs/community/discussions/168685)). Real usage data: hundreds of thousands of reviews and merges from phones, but the community's own consensus is "treat it as a **triage and lightweight workflow tool**, not a development environment". What works: swipe-to-triage inbox (done, assign, label, mute), long-press a line for an inline comment, saved replies to reduce typing, small-PR review. What fails: any sustained reading of large diffs.
- GitHub's stated design goal, worth adopting verbatim: **continuity**, start review on the phone, finish on the laptop, or vice versa.
- [[Graphite]] has no dedicated mobile review app as of this research; its inbox model is web/desktop. The stacked-review-on-mobile slot is empty.
- Implication for our companion app: the phone is not for reading diffs, it is for the layer above them. Sensible mobile verbs: read cohort narratives and summaries, triage AI findings (dismiss/escalate), approve individual small low-risk cohorts that the desktop session already chunked, reply to review threads, and nudge or redirect the harness. Coverage state syncs so the desktop session opens exactly where the phone left off. The narrative layer we build for large-PR digestibility is coincidentally the only representation of a big PR that fits on a phone, which makes the mobile app cheap leverage rather than a separate product.

---

## Design tensions to resolve

1. **Trust the grouping vs verify the coverage.** The whole pitch is "review cohort by cohort with confidence", but the cohorts are LLM-constructed. If the LLM mis-files a security-relevant hunk into the "mechanical renames" cohort, the user confidently skims past it. What makes cohort assignment auditable enough to trust, without forcing re-review of the raw diff (which would erase the product's value)? Candidate ingredients: deterministic residue checking (every hunk provably in exactly one cohort), risk-scored cohorts, drag-to-regroup with GitButler-style direct manipulation. This is the product's existential question.

2. **Narrative order vs reviewer agency.** A sequenced narrative implies a rail: read chapter 1, then 2. Senior reviewers jump around, chase hypotheses, and resent rails. How much does the sequence bind? Is it a default path with free navigation and a coverage map, or a stronger commitment where skipping is a recorded, visible act?

3. **Where does review state live?** GitHub is the system of record for comments and approvals, but GitHub has no concept of cohorts, sequence position, per-hunk coverage, or patchset-style chunk history. Local-first state enables the speed and the resume experience; it also means a second source of truth that can diverge (force-pushes, teammates commenting from github.com, two machines). What syncs, what is device-local, and what happens to coverage state when the PR is force-pushed under you? Gerrit's patchset diffing is the model to beat.

4. **Summary-first vs diff-first.** Progressive disclosure says lead with the narrative; review integrity says the human must gate on code, not on prose about code. If the summary is good, humans will approve from the summary (the automation-complacency failure). Does the UI require some diff exposure per cohort before its "reviewed" state can be set, and does pace data (400 LOC/hr research) ever confront the user, or is that surveillance that kills the tool's likability?

5. **AI finding volume vs the false-positive budget.** The harness can generate near-unlimited observations; the research says trust collapses past roughly 10% noise and 30% override rates. Where is the culling done (verifier pass, confidence threshold, severity floor), who controls the knob, and how does one-keystroke dismissal feed back so the same finding class stays dead?

6. **The approve button's blast radius.** Approval must land as a normal GitHub approval, yet the tool knows things GitHub does not: which cohorts were actually reviewed, at what pace, with which findings dismissed unread. Does the tool ever refuse or friction the approve action (unreviewed cohorts remaining), and is coverage honesty ever visible to anyone but the reviewer? Team-visible coverage is a feature and a workplace-politics landmine.

7. **Native purity vs iteration speed.** Sub-frame latency on 5,000-line syntax-highlighted diffs argues for a serious custom renderer (Sublime Merge, Warp); a founding-team-sized bet argues for web-tech pragmatism with Linear-style local-first discipline. Liquid Glass adoption pushes toward real AppKit/SwiftUI chrome; the portable-architecture requirement pushes away from it. Where is the line: native shell + custom diff surface, full Tauri, or GPUI-style from scratch?

8. **Live review vs settled review.** Hunk's watch mode points at reviewing while the agent still works, and the harness in our product may be revising the PR in response to review comments mid-session. Reviewing a moving target invalidates coverage ("reviewed" against which version?). Does the tool freeze a snapshot per session and diff snapshots Gerrit-style, or embrace live-updating diffs and re-open affected cohorts automatically?
