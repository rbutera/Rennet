---
categories:
  - research
tags:
  - code-reviews
  - lens-validation
created: 2026-08-04
---

# Lens validation: long-form practitioner writing

Validation pass on the five-lens hypothesis in [[Code Review Harness App]], sourced from engineering blogs, practitioner essays, conference writeups, and 2025-2026 academic work on reviewing LLM-generated code. Sibling notes cover other source tiers.

Headline: four of five lenses are supported by independent practitioner writing, one is weakly supported and correctly deferred. The single biggest gap is that the best-evidenced review concern in the entire corpus, **duplication and reuse blindness**, has no lens at all. The second biggest problem is that our proposed canonical chapter ORDER is contradicted by every published reading order I could find.

---

## Per-lens verdicts

### 1. Chapters (dependency-ordered reading sequence)

**Verdict: VALIDATED as a mechanic, UNSUPPORTED as a fixed order.**

The idea that a large changeset should be read as an ordered narrative is old, well established, and uses our exact word. Ilija Eftimov: "each commit is a chapter, and the reviewer is the reader". Nicholas Hirsch describes commit-by-commit review as feeling "a lot like reading a good book". This is pre-AI vocabulary with no product collisions, which is good news for naming.

Three independently published reading orders exist, and none of them is ours:

| Author | Order |
|---|---|
| Kevin Murphy, [How I Read A PR](https://kevinjmurphy.com/posts/how-i-read-a-pr/) | title/description → commits → file scan → **tests in detail** → implementation → big picture |
| GitHub, [agent PR review](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/) | classify → **CI/workflow config** → new utilities → critical path → security boundaries → evidence |
| [coles.codes](https://coles.codes/posts/reviewing-code-you-didnt-write/) | context reconstruction (callers, deps) → approach → behaviour → polish last |

Murphy: "I tend to READ tests first". coles.codes goes after "the spine of the change", the core state transition every caller depends on. GitHub puts CI config first because agents tamper with it.

Our proposed schema → logic → call sites → UI → tests order is a reasonable fourth opinion, not a consensus. Note that Murphy puts tests FIRST and we put them LAST.

Evidence FOR the post-hoc derivation specifically: all three of these orders assume a human author who structured the work. Agent PRs mostly do not have usable commit structure, which is exactly why deriving chapters rather than reading commits is the right call. GitHub names "Agentic Ghosting" as a red flag: PRs that "lack clear implementation plans".

**Change I would make:** ship chapter ordering as a named, switchable, user-reorderable STRATEGY, not a constant. Ship at minimum three presets: dependency-first (ours), tests-first (Murphy), and config-and-CI-first (GitHub, the agent-specific one). The reading order is a preference with published disagreement, so hardcoding it is a needless fight.

### 2. Decision points

**Verdict: VALIDATED on the pain, UNPROVEN on the mechanism.**

The "6 decisions, not 47 comments" framing is the single best-matched positioning in the corpus. Attention, not correctness, is repeatedly named as the scarce resource. The dev.to piece [Return on Attention](https://dev.to/cseeman/return-on-attention-why-ai-code-reviews-are-wearing-us-out-2hh0) coins exactly that: "Every word you ask someone else to read has to be worth what it costs them". It also gives us "slop grenade" for a huge AI comment dump, and documents a PR where a 10-character change drew a 1,430-character description.

GitHub's post says flatly: "Judgment is the bottleneck, and that's fine". coles.codes defines the reviewer's job in decision-point terms: "The job is to find the issue that changes whether the work should ship". Addy Osmani's agentic review framework reserves for humans "judgment whether this change should exist" and high-blast-radius calls.

The noise side is empirically documented. Jet Xu's signal-vs-noise framework tiers every comment by severity and calls a tool a "noise generator" below a 60% signal ratio; ~40% of alerts get ignored once teams hit fatigue. The "cry wolf" effect is named repeatedly as the top cause of AI review tool abandonment.

Evidence AGAINST: nobody in the corpus describes anything like a queue of extracted decisions. The closest published mechanisms are severity tiering (a filter) and the blocking / non-blocking / `nit:` convention (a binary label applied by the reviewer, after the fact). Our decision unit is genuinely novel, which cuts both ways. And there is an obvious trap: the documented pain is being drowned in machine-generated review artifacts, and a decision queue IS a machine-generated review artifact. If the extractor is not precision-biased to the point of being stingy, this lens becomes the problem it claims to solve.

**Change I would make:** adopt the existing blocking / non-blocking vocabulary rather than inventing around it, and treat the decision COUNT as a hard product constraint with a visible ceiling. If a PR yields 30 decisions the lens has failed and should say so rather than paginate.

### 3. Blast radius

**Verdict: VALIDATED, strongest of the five.**

"Blast radius" is already native practitioner vocabulary and is used in precisely our sense. From the GitHub community thread [How do YOU decide a PR actually needs deeper review?](https://github.com/orgs/community/discussions/184556):

- Ayla-hmadi: "Small diff, huge blast radius. These deserve 10x more scrutiny than their line count suggests."
- riteshroshann: "how wide would the blast radius be, and how long until someone noticed?"
- Ayla-hmadi again: "Touching money, auth, or data integrity. Automatic deep review."

That last one independently validates folding security in as a blast-radius PRESET rather than a separate lens: practitioners already bundle auth with payments and data integrity as one attention class.

[pharaoh.so](https://pharaoh.so/blog/code-change-blast-radius/) gives a usable computation model: fan-in (direct call sites, transitive callers, shared types and schemas and generated clients), dependency-graph breadth, and reversibility. Its formula is "dependency breadth + business criticality + rollback difficulty". It also states the problem our lens exists to solve: "The diff looks clean, tests pass, and you still can't tell whether that 'small' helper tweak will break five callers."

Reversibility comes up as its own axis, separately from risk. Reversible and irreversible changes should not be reviewed in one bucket; a rollback-able UI regression is not a bad payment flow. Refactors are named as the sneakiest case because "It looks safe because it doesn't look like product work."

Also recovered: a human attention ceiling of roughly ten thousand lines past which a reviewer should not review at all, framed explicitly as separate from risk grading. That is a second, higher threshold above the 400-LOC defect-detection anchor already held.

Evidence AGAINST: none on the concept. The objection is engineering cost. Every source agrees the signal is invisible in the diff, which means diff-only heuristics will not produce it. This lens needs real call-graph and fan-in analysis over the repo on disk. That is defensible (a local tool with the whole object store is exactly the thing that can do it and a cloud diff viewer cannot) but it is not cheap, and a weak version of this lens is worse than none because it teaches distrust.

**Change I would make:** make REVERSIBILITY a first-class axis of the lens rather than one item in the risk list, and add CI/workflow config tampering as a preset (see missing lenses).

### 4. Claims and evidence

**Verdict: VALIDATED, and should be widened.**

This is the most AI-specific of the five and the corpus backs it hard, including with numbers.

The strongest voice is Simon Willison, whose whole current position is verification over reading. Via the Pragmatic Summit writeup and the [brgr.one](https://www.brgr.one/blog/stop-reviewing-agent-code-start-verifying) summary of it: "Tests are the only thing between you and blind trust in code nobody reads". He also names the failure state we are selling against: "We become full-time code reviewers and that's an exhausting sort of state". His practical addition is that tests are insufficient alone, you also need runtime evidence, and his `showboat` tool exists to produce auditable Markdown transcripts of manual API exercises.

Mark Seemann's [AI-generated tests as ceremony](https://blog.ploeh.dk/2026/01/26/ai-generated-tests-as-ceremony/) is the sharpest statement of the failure mode: "Tests work best when you have seen them fail", and generated tests are "essentially ex-post tests with extra ceremony". He names tautological assertions specifically and warns that even attentive review misses them.

Practitioners already phrase the check as claim-versus-evidence. Ayla-hmadi: "If I introduced the bug this PR claims to fix, would the new tests catch it?" AbhinavPabbaraju: "Do tests actually encode the intended behavior?"

The crucial correction the corpus forces: **untested changes are the easy half.** The documented AI failure mode is tests that EXIST and PASS and prove nothing. Empirically ([arXiv 2602.00409](https://arxiv.org/html/2602.00409v1), 1.25M commits, 2,168 repos): agent commits touch test files at 23% vs 13% for non-agents, and 36% of agent test commits add mocks vs 26%. Agents also use a much narrower vocabulary of test doubles: "fake" appears in 32% of agent mock commits vs 57% non-agent, "spy" 33% vs 51%. Agents mock more and mock less thoughtfully.

Add to that GitHub's red flag #1, CI gaming: agents "remove tests, skip linting, or weaken coverage thresholds to pass pipelines", with the rule "Any CI weakening is a hard stop". Addy Osmani says to treat widespread test edits as a flag and watch for "rewritten assertions matching new broken behavior".

**Change I would make:** rename the mental model from "does a claim have a test" to "would that test have failed". Signals to surface inside this lens, in rough order of cheapness: (a) behavioural change with no test delta, (b) test delta that only adds mocks, (c) assertion-free or single-mock-assertion tests, (d) modified or deleted EXISTING assertions, (e) coverage threshold and CI config weakening. Mutation testing is the honest gold standard the literature points at, but it requires execution; treat it as a later "prove it" action attached to a claim, not a lens prerequisite.

### 5. Familiarity (blame-derived, later phase)

**Verdict: PARTIALLY SUPPORTED, and the blame implementation is the weak part.**

The underlying need is well argued. The best single essay here is [Code review assumes an author](https://blog.raed.dev/posts/ai-code-review): review "was designed to challenge work someone already understood", and with agent PRs "the pull request is a pre-LLM artifact". When reviewing an agent PR you may be "the first human being to ever lay eyes on this code", so nobody has reconstructed the why yet and the reviewer is the first to try.

Expertise as the decisive variable is the central claim of the largest study in this space. [3100 Opinions on Code Review in an AI World](https://arxiv.org/abs/2607.07980) (Agarwal, Miller, Kästner, Vasilescu; 3,100 documents coded from 38,709 grey-literature blogs and threads; 26 constructs, 67 relationships) concludes that "review is the control point" and that AI "does not fix the sign of that effect: the team sets it, through the expertise its humans bring". Practitioners say the same thing anecdotally: riteshroshann attributes review judgement to "scars, system knowledge of landmines, incident retrospectives". coles.codes gives the flip side, review as knowledge maintenance: "Reviewing is how I stay a contributor to all that code."

Evidence AGAINST the proposed mechanism: git blame measures authorship, not comprehension, and in an agent-authored codebase those have come apart. Ronacher's argument is that "nobody knowing why a subsystem exists becomes the default state rather than a failure mode". A blame gradient in that world attributes ownership to whoever merged the agent's output, which is precisely the person who cannot explain it. Nothing in the corpus asks for a per-reviewer familiarity map.

**Change I would make:** invert the signal. The supported version is not "here is the code you own", it is **"here is the code no human has ever read"**. That is computable from the same substrate (blame plus review history plus merge metadata), matches the loudest documented pain, and is a genuinely novel display. Keep it deferred, but reframe it before designing for it.

---

## Missing lens candidates

Ranked by weight of evidence in the long-form record.

### 1. Duplication and reuse blindness (STRONG, recommend adopting)

This is the best-evidenced review concern in the entire corpus and we have no home for it.

- GitHub names it red flag #2, "Code Reuse Blindness": agents duplicate existing utilities without checking repository-wide patterns.
- coles.codes: "A change can be tidy inside the diff while duplicating something the repo already has."
- [arXiv 2601.21276](https://arxiv.org/html/2601.21276) (3,858 Python PRs): agent redundancy 0.2867 vs human 0.1532, a 1.87x increase, p<0.001. Agents also delete far less: humans remove 25.51 LOC per PR vs agents 16.60.
- GitClear 2026: block duplication up 81% versus 2023 and at record levels; moved (refactored) code collapsed from 21% to 3.8% of changed lines.

Two things make this a lens rather than a linter rule. First, it is invisible in the diff by construction, so it is exactly the class of finding that justifies a local tool with the whole repo on disk. Second, the sources agree the damage is deferred: duplicated code diverges later. That makes it a judgement call, not a mechanical one, which is the shape of a lens.

Given how thin the evidence for familiarity is, **duplication is the better fifth lens.**

### 2. Architectural drift / global coherence (MEDIUM-STRONG)

Recurs under several names. Ronacher's "coherence tax", and the observation that loop-generated code prioritises "local correctness over global coherence". daz.is: "Code that doesn't make sense when you look at the bigger picture." Multiple 2026 posts converge on the phrase: every PR locally optimal, globally chaotic; drift that used to take weeks now accumulates in an afternoon. Distinct from duplication in that it covers layer violations, deprecated internal APIs, and convention divergence. Plausibly a preset of a duplication/consistency lens ("does this match how this repo already does this") rather than a sixth lens.

### 3. Dependency and supply chain, including hallucinated APIs (MEDIUM, cheap to build)

coles.codes: "Plausible method names are cheap for a model to produce", with the instruction to verify unfamiliar APIs against docs and check that config flags exist in the project's actual version. On the package side, slopsquatting is now a documented live attack class with a CISA/NSA/Five Eyes advisory in early 2026. The numbers make it tractable: 43% of hallucinated package names recur on every one of ten identical reruns, so the attack surface is predictable and so is the detection. New-dependency detection is nearly free to implement and maps naturally onto blast radius as a preset.

### 4. Provenance and intent (MEDIUM, and we already half-have it)

An entire well-argued essay (raed.dev) is about the collapse of the authorship assumption. GitHub names "Agentic Ghosting". Addy Osmani's framework requires "evidence before review": an intent statement, test output, CI results, pushed upstream where reconstruction is cheap. The proposed fix in the corpus is a decision log riding on the PR so reconstruction cost falls.

That is the self-review route handoff already listed as a possible keystone. Worth stating explicitly in positioning: **the route handoff is the answer to the best-argued gap in the practitioner record.** It is not a nice-to-have adjacent to the lenses, it is the thing several independent writers ask for by name.

### 5. Performance / budget (WEAK-MEDIUM)

Present but quieter in long-form. Shows up as a named lens in one framework ("Budget": N+1 queries inside loops, unbounded queries over input) and in specialised-agent proposals (hot paths, allocations, algorithmic complexity). Not enough weight to earn a lens slot; fine as a blast-radius or findings category.

### 6. CI and config tampering (SMALL BUT UNHOMED)

Currently has no home in our set and probably should. GitHub ranks it first among red flags and treats it as absolute: "Any CI weakening is a hard stop". Deterministically detectable, zero LLM cost, high severity. Put it in blast radius as a preset, or as a permanent obligation in claims-and-evidence.

### 7. Note on the mechanical/bulk fold

Our decision to pre-collapse mechanical changes is validated in principle but the corpus flags the exact risk. AbhinavPabbaraju: "I distinguish between mechanical changes and semantic changes". Ayla-hmadi's warning is the counterweight: "PR title says 'refactor' but logic is subtly different." So the dangerous case is precisely a semantic change wearing mechanical clothes, and auto-collapsing is the move that hides it. The cross-lens disagreement flare already sketched in the feature inventory is the right structural answer; this is independent evidence that it is load-bearing rather than clever.

---

## Vocabulary harvest

### Units of review
chapter (commit-as-chapter, pre-AI, no collisions) · hunk · **spine of the change** · critical path · deep review · review depth · risk tier · blocking / non-blocking / `nit:` · change stack (burned by CodeRabbit) · **lens** (see warning below)

**Vocabulary warning on "lens".** At least one published framework, [The Five Lenses of AI Code Review](https://anarsolutions.com/ai-code-review-framework/) (functional, regression, security, budget, maintainability), uses "lens" as deliberate framework nomenclature and defines it almost exactly as we do: "A lens is a whole role: a persona who reads the entire diff hunting for one class of problem." This is an article, not a shipped product, so the risk is far lower than "cohort" or "layer". But "lens" is not virgin territory and someone will find that piece. Two of their five (regression, budget) are also lenses we do not have.

### AI-code failure modes
hallucinated correctness · CI gaming · code reuse blindness · agentic ghosting · slop / AI slop / **slop grenade** / slop galore · tautological assertions · over-mocking · ex-post tests with extra ceremony · cargo-cult testing · architectural drift · **coherence tax** · pattern violation · context rot · confident wrongness · slopsquatting / package hallucination · lethal trifecta (private data + malicious instructions + exfiltration vector) · vibe coding

### Reviewer experience
**return on attention** · review fatigue · alert fatigue · cry wolf effect · "full-time code reviewers" · "judgment is the bottleneck" · reviewer pickup time · reconstruction cost · blast radius · landmines · scars · drowning · burnout that "rarely looks dramatic"

### Framings worth stealing for positioning
"proof over vibes" · reviewers as **verification architects** rather than code readers · "evidence before review" · "the first human being to ever lay eyes on this code" · "review exists to ship value and pass knowledge between people" · "if you cannot explain what the code does, you probably should not ship it"

---

## Empirical numbers

Beyond the SmartBear 400-LOC anchor already held.

| Number | What it measures | Source |
|---|---|---|
| 400-500 LOC/hour | above this, high-defect-density reviews "virtually disappear" | daz.is restating SmartBear (corroborates existing anchor) |
| ~10,000 lines | ceiling past which a reviewer should not review at all; attention limit, separate from risk | GitHub community discussion #184556 |
| 408 vs 157 LOC (2.6x) | AI-assisted vs unassisted PR size, 75th percentile | LinearB 2026 Benchmarks, 8.1M PRs / 4,800 teams / 42 countries |
| 1,055 vs 201 min (5.3x) | reviewer pickup time, agentic vs manual PRs | LinearB 2026 |
| 32.7% vs 84.4% | PRs merged within 30 days, AI-assisted vs manual | LinearB 2026 |
| 88.3% (from ~72% in early 2024) | developers using AI regularly | LinearB 2026 |
| +441.5% | median review duration increase | cited in Addy Osmani, Agentic Code Review |
| +31.3% | increase in zero-review merges | Addy Osmani |
| 10.83 vs 6.45 issues/PR (1.7x) | AI-assisted vs human-only, 470 OSS PRs | Dec 2025 analysis, via multiple secondary cites |
| +51% | average agent PR size premium | Addy Osmani |
| 4x output, ~12% productivity gain | volume vs realised benefit | Addy Osmani |
| **93.4%** | share of findings caught uniquely by exactly one of four parallel reviewers | Addy Osmani |
| 0.2867 vs 0.1532 (1.87x, p<0.001) | agent vs human code redundancy (max redundancy score) | arXiv 2601.21276, 3,858 Python PRs |
| 25.51 vs 16.60 LOC | code REMOVED per PR, human vs agent (p<0.001) | arXiv 2601.21276 |
| 40.3 → 73.0 per M changed lines (+81% vs 2023) | block duplication, record high | GitClear 2026 |
| 9.4% (2022) → 15.7% (H1 2026) | copy/paste share of changed lines | GitClear 2026 |
| 21% (2022) → 3.8% (2026 YTD) | moved (refactored) code share | GitClear 2026 |
| 3.3% → 7.1% | code churn, pre-AI baseline vs 2025, over 211M LOC | GitClear |
| 23% vs 13% | share of commits touching test files, agent vs non-agent | arXiv 2602.00409, 1,254,878 commits / 2,168 repos |
| 36% vs 26% | share of test commits adding mocks, agent vs non-agent | arXiv 2602.00409 |
| 32% vs 57% ("fake"), 33% vs 51% ("spy") | test-double vocabulary diversity, agent vs non-agent | arXiv 2602.00409 |
| 45% | AI-generated code samples introducing an OWASP Top 10 vulnerability | via Addy Osmani and AnAr |
| 2.74x | XSS vulnerability rate in AI code | via Addy Osmani |
| +75% (1.75x) | logic error rate in AI code | via Addy Osmani |
| 60M+ reviews, 10x growth in <1 year, >1 in 5 | Copilot code review volume and share of GitHub reviews | GitHub blog |
| 43% | hallucinated package names recurring on all 10 identical reruns | CSA slopsquatting research note, April 2026 |
| 21.7% vs 5.2% vs 3.59% | package hallucination rate: open models vs commercial vs GPT-4 Turbo | CSA slopsquatting research note |
| <60% signal ratio = "noise generator"; ~40% of alerts ignored | AI review tool signal-to-noise thresholds | Jet Xu, DocMason |
| +59% YoY feature-branch throughput, median main-branch throughput FELL | where the bottleneck moved | CircleCI 2026 data |
| 3,100 coded from 38,709 docs; 26 constructs, 67 relationships | scale of the practitioner-discourse synthesis | arXiv 2607.07980 |

The 93.4% figure deserves separate attention. If four parallel reviewers each find findings that no other reviewer finds, that is direct empirical support for both the multi-lens thesis (one pass over a changeset misses most of what is there) and for the harness-disagreement open question (Q12). It is the closest thing in the corpus to a proof that decomposing review into concurrent passes is not just ergonomics.

---

## Notable sources, annotated

**Primary, worth reading in full:**

- [3100 Opinions on Code Review in an AI World](https://arxiv.org/abs/2607.07980) (arXiv 2607.07980, CMU). The most important single source here. Synthesises 38,709 grey-literature documents into a causal model. Its central claim, that review is "the control point" and that team expertise and process structure set the sign of AI's effect, is the academic version of our whole positioning. Read the construct list before finalising the lens set.
- [Agent pull requests are everywhere. Here's how to review them.](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/) (GitHub). A complete, timed, ordered review methodology plus a five-item red-flag taxonomy (CI gaming, code reuse blindness, hallucinated correctness, agentic ghosting, untrusted input in workflows). The closest thing to a competing spec for what our lenses should cover, published by the incumbent.
- [Code review assumes an author](https://blog.raed.dev/posts/ai-code-review). Short, sharp, and the best argument for the route-handoff feature. No numbers, all thesis.
- [AI-generated tests as ceremony](https://blog.ploeh.dk/2026/01/26/ai-generated-tests-as-ceremony/) (Mark Seemann). The epistemology of the claims-and-evidence lens, from someone who has been writing about test validity for twenty years.
- [Reviewing code you didn't write](https://coles.codes/posts/reviewing-code-you-didnt-write/). The most practical single methodology post; gives "spine of the change", the hallucinated-API check, and the blocking/non-blocking discipline.
- [How I Read A PR](https://kevinjmurphy.com/posts/how-i-read-a-pr/) (Kevin Murphy). Pre-AI, clean, explicit ordering. The tests-first preset comes from here.
- [How do YOU decide a PR actually needs deeper review?](https://github.com/orgs/community/discussions/184556) (GitHub community). Unfiltered practitioner heuristics, dozens of them, mostly about blast radius and mechanical-vs-semantic. Highest quote density of anything in the corpus.

**Data:**

- LinearB 2026 Software Engineering Benchmarks (8.1M PRs). The PR-size and pickup-time numbers.
- [GitClear, The Maintainability Gap](https://www.gitclear.com/the_ai_code_quality_maintainability_gap) (2026). Duplication and refactoring-collapse longitudinal data.
- [arXiv 2601.21276](https://arxiv.org/html/2601.21276), More Code, Less Reuse. Redundancy and reviewer-sentiment. Note the counterintuitive finding: reviewers are LESS negative toward AI PRs, which suggests scrutiny drops rather than rises.
- [arXiv 2602.00409](https://arxiv.org/html/2602.00409v1), Are Coding Agents Generating Over-Mocked Tests? The mock-density evidence for the claims-and-evidence lens.

**Positioning and vocabulary:**

- [Return on Attention](https://dev.to/cseeman/return-on-attention-why-ai-code-reviews-are-wearing-us-out-2hh0). "Slop grenade", the attention-economics framing, and the emotional register we said was unoccupied. It is occupied by this post, at least rhetorically.
- [Code Review in the Age of AI](https://addyo.substack.com/p/code-review-in-the-age-of-ai) and [Agentic Code Review](https://addyosmani.com/blog/agentic-code-review/) (Addy Osmani). Highest-reach practitioner writing in the space; the risk-tiering and evidence-before-review framing, plus most of the widely-repeated statistics.
- [The Five Lenses of AI Code Review](https://anarsolutions.com/ai-code-review-framework/) (AnAr). Read this before committing to "lens" as product vocabulary.
- Simon Willison's Pragmatic Summit talk and [fireside writeup](https://simonw.substack.com/p/fireside-chat-about-agentic-engineering). The verification-over-reading position, held by the most-cited person in the field.
- [Armin Ronacher, The Coming Loop](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/). Comprehension as the bar; "coherence tax"; the counterweight to Willison.

---

## Verdict

The long-form record supports this lens set, with one substitution and one correction. Blast radius and claims-and-evidence are the two lenses practitioners are effectively already asking for by name, using our vocabulary, with numbers behind them; both are load-bearing and both are harder to build than they look because the signal genuinely is not in the diff. Chapters is validated as a mechanic but the specific dependency-first order is one published opinion among at least four, so it should ship as a switchable strategy with tests-first and config-first presets rather than as a constant, and the fact that agent PRs have no usable commit structure is the real argument for deriving it. Decision points has the strongest positioning fit of anything in the set and the weakest prior art, which means it is either the differentiator or the place we reinvent the noise problem we are selling against; the count is the product, so put a ceiling on it. Familiarity is the one I would cut from the roadmap in its current form: blame measures authorship and the corpus is unanimous that authorship and comprehension have come apart, so the supported signal is "no human has read this" rather than "you own this". In its place, promote **duplication and reuse blindness** to a first-class lens: it is the best-evidenced concern in the whole corpus (1.87x redundancy, block duplication at record highs, refactoring down from 21% to 3.8% of changed lines), it is structurally invisible to every diff-based tool, and it is exactly the thing a local-first tool with the entire repo on disk can compute that a cloud PR viewer cannot. Add CI and config tampering somewhere, because it is free to detect and the incumbent treats it as a hard stop. And say out loud in positioning that the self-review route handoff answers the single best-argued gap in the practitioner record, which is that code review was designed to interrogate an author who understood the work, and there is no longer an author.
