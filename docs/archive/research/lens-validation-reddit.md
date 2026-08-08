---
categories:
  - research
tags:
  - code-reviews
  - lens-validation
created: 2026-08-04
---

# Lens Validation: Reddit Discourse

Validation pass on the five-lens hypothesis in [[Code Review Harness App]], mined from Reddit practitioner discussion 2024-2026.

## Method and corpus

Reddit blocks HTTP-level crawlers (WebFetch, Exa, jina, redlib mirrors all 403). Data was pulled through a real browser session against Reddit's own JSON API, searching r/ExperiencedDevs, r/programming, r/webdev, r/devops, r/SoftwareEngineering, r/ClaudeAI, r/ChatGPTCoding, r/cursor, r/LocalLLaMA, r/github and r/codereview across 40+ query terms, then fetching full comment trees for the 40 highest-signal threads. Comments are the data; titles are not. Roughly 3,500 comments read across those threads.

The centre of gravity is r/ExperiencedDevs. r/ClaudeAI, r/cursor and r/ChatGPTCoding contribute the pre-PR self-review perspective and almost nothing on reviewing other people's work. r/LocalLLaMA contributed nothing usable on review at all.

---

## Per-lens verdicts

### 1. Chapters (dependency-ordered reading sequence): VALIDATED as a need, PARTIALLY validated as a mechanic

The exact layering the hypothesis proposes is described independently by multiple engineers, unprompted, as the correct way to cut work.

In [How are you doing code reviews?](https://www.reddit.com/r/ExperiencedDevs/comments/1p8v861/how_are_you_doing_code_reviews/) a commenter lays out the sequence verbatim: refactor common code into a helper (250 lines), add RPC stubs (100), implement RPC X with tests (150), implement RPC Y (150), have UI call X behind a flag (300), integration tests (300). Their summary: "At each stage, the project builds and all tests pass."

In [How do you deal with review of big branches/PR?](https://www.reddit.com/r/ExperiencedDevs/comments/1qjh66z/how_do_you_deal_with_review_of_big_branchespr/) the top comment describes the same thing as personal practice: "schema changes, wiring, UI scaffolding, actual logic" as "a sequence of tiny, isolated steps". Another commenter gives a reading order that is *not* the hypothesis order: "scan the test files first to understand what the feature is supposed to do, then look at the main logic changes".

In [Are too many commits in a code review bad?](https://www.reddit.com/r/ExperiencedDevs/comments/1rfjuum/are_too_many_commits_in_a_code_review_bad/) one commenter describes the chapter mechanic as commit history: reading "ADD API endpoints", "ADD database layer", "ADD endpoint impl", "ADD tests" in order makes a larger PR "more readable". Another notes FOSS projects "expect you to submit clean history nicely broken down into reviewable bits".

**The counter-evidence is severe and useful.** In that same thread the top comment at 645 points is "I don't look at it. We squash the commits at merge anyway", seconded at 332 points by "Anyone that doesn't do this is insane tbh". A commenter in the big-branches thread is blunter: a PR "is not a novel where twists, turns, and anticipation are a good thing".

Two things follow. First, the raw material for a chapter sequence is routinely destroyed by squash-merge, which is an argument *for* deriving chapters post-hoc rather than expecting authors to author them. Second, the community does not currently believe that an author-supplied narrative is worth reading, because it is normally a self-serving artefact. A derived, verifiable sequence is a different object and has to be presented as one.

The larger threat: the culturally sanctioned response to a large PR is not "give me a better reading order", it is **rejection**. "Reject it and ask that they follow the existing pattern" (392 points, [Reviewing 2000 line AI Slop Pull Request](https://www.reddit.com/r/ExperiencedDevs/comments/1osyyci/reviewing_2000_line_ai_slop_pull_request/)). "This is too verbose for me to approve is a complete sentence where i work" ([AI Slop PR's are burning me and my team out hard](https://www.reddit.com/r/ExperiencedDevs/comments/1kr8clp/ai_slop_prs_are_burning_me_and_my_team_out_hard/)). Chapters must be positioned as *the split you were about to demand, without the round trip*, not as a way to make a 3,000-line PR acceptable.

One live design tension the discourse surfaces: horizontal layering (schema, then logic, then UI) versus vertical slicing. From [AI agents pass the tests but break the architecture](https://www.reddit.com/r/ExperiencedDevs/comments/1s3f06x/ai_agents_pass_the_tests_but_break_the/): "Shallow vertical slices won before AI and they matter even more now." Some reviewers want thin end-to-end slices, not layers. Chapters should probably support both orderings rather than hardcode the layer cake.

### 2. Decision points: VALIDATED, strongest of the five

This lens has the best organic evidence and the best vocabulary in the entire corpus.

[Does AI generated code change the review process itself?](https://www.reddit.com/r/ExperiencedDevs/comments/1t1zfsz/does_ai_generated_code_change_the_review_process/) is essentially a first-person account of the problem the lens exists to solve. The OP: "it feels less like reviewing and more like orbiting the decision". And: "You're doing review like activity, but youre not realy making a clean call." That is the product thesis written by a stranger.

[What are we doing with AI PRs now?](https://www.reddit.com/r/webdev/comments/1thelaf/what_are_we_doing_with_ai_prs_now/) reads as a decision queue with the decisions removed: "nobody can say why that cache key exists, why auth runs after the expensive call, what happens when the provider times out". The OP's closing observation is the diagnosis: AI is "good at filling the happy path, less good at leaving a trail a human can explain later".

Supporting evidence is everywhere. From [While doing code review we often miss the why behind change](https://www.reddit.com/r/ExperiencedDevs/comments/1o1sctg/while_doing_code_review_we_often_miss_the_why/), a reviewer's framework had two items: "the little why" (why this change, why this approach) and "the big why". From [How to deal with juniors shipping AI slop code?](https://www.reddit.com/r/ExperiencedDevs/comments/1sz9d0x/how_to_deal_with_juniors_shipping_ai_slop_code/): "whenever I ask them why they made certain decisions, they just give me this blank look". From the process thread: "I ask the author to explain why this piece of code is needed. And then they don't respond."

And from r/devops, [anyone lose the reasoning behind an ai-generated terraform/pipeline change](https://www.reddit.com/r/devops/comments/1ulm2o6/anyone_lose_the_reasoning_behind_an_aigenerated/), the decision is not merely unsurfaced, it is destroyed: the rationale is "buried in a chat transcript instead of a runbook or a pr description".

**The important refinement.** Reddit is not asking for a list of forks in the road. It is asking for *the decision plus the reason it was taken*. A lens that extracts decision points and hands the reviewer six unanswered questions has named the gap without closing it. The harness must attempt the why, sourced from the plan, the spec, the ticket, or the agent session, and mark it as reconstructed rather than known. This is the strongest argument in the corpus for the self-review route handoff being the keystone rather than a nice-to-have.

The "6 decisions, not 47 comments" framing has no direct analogue in the discourse, but the pain it targets is loud: a maintainer leaving "nearly 30 comments" on one PR, and the round trip described in [My coworker uses AI to reply to my PR review](https://www.reddit.com/r/ExperiencedDevs/comments/1nq5npn/my_coworker_uses_ai_to_reply_to_my_pr_review_and/) as "20 minutes of my time, 15 seconds of theirs".

### 3. Blast radius: VALIDATED, with a skepticism tax

The vocabulary is native. There is a 2024 r/ExperiencedDevs thread literally titled [Programmatically figuring out impact/blast radius of code changes](https://www.reddit.com/r/ExperiencedDevs/comments/1eljry6/programmatically_figuring_out_impactblast_radius/). Engineers say "load-bearing", "regression risk" and "blast radius" without prompting.

The canonical horror story is a blast-radius finding. From the burnout thread: the agent produced a change that "aborted early in a middleware basically skipping most of AuthZ, then mocked out a good chunk of the AuthZ in tests". From the 2000-line thread: "When the regression risk of a change is high you need to decline it." From [Is the norm now that PRs are basically rubber stamps](https://www.reddit.com/r/ExperiencedDevs/comments/1tf5jq1/is_the_norm_now_that_prs_are_basically_rubber/): "I've rejected multiple PR's from principal engineers... full of hallucinated api calls."

Security-as-preset is directly supported. In [security review is becoming an afterthought](https://www.reddit.com/r/ExperiencedDevs/comments/1nmnx5b/security_review_is_becoming_an_afterthought_in/) the top comment (184 points) argues for exactly a preset rule: "Any dynamic SQL should raise red flags, be picked up by tooling", and any undocumented case "should be an auto reject during review". The threat model is also articulated: a hostile contributor could "create a 10k line PR that they know no one will read" and hide "a few naughty lines in a place no one would look at".

**The tax.** The blast-radius thread's own consensus is discouraging. "You're gonna run into the theoretical limits of static analysis pretty quickly." "This question sounds like another instance of someone trying to outsource their mental effort." The community's stated answer is architecture, tests and tenured judgement, plus CODEOWNERS gating as a crude proxy: "Code that is really important can be gated such that only a select few trained reviewers can approve."

So: engineers want the signal but are pre-loaded against tools that claim to compute impact. Ground the lens in cheap, verifiable, explainable signals (fan-in count, CODEOWNERS overlap, migration and manifest touches, auth and payment path markers, irreversible operations) and never present it as full impact analysis. Show your working or it reads as astrology.

### 4. Claims and evidence: VALIDATED, second-strongest, and it solves a second problem

[My teammates are generating enormous test suites now](https://www.reddit.com/r/ExperiencedDevs/comments/1po8uud/my_teammates_are_generating_enormous_test_suites_now/) is the single best thread for this lens. The top comment (753 points): AI test code "is actually testing the actual implementation details, which is wrong for the most cases". At 202 points: "AI will often rewrite tests until they pass, even when the code is buggy." At 134: "the AI generated tests largely just match the code. If there's a bug, AI will write tests assuming that is correct." At 104, the metaphor the product should probably steal: "Leave the arrow and tell AI to paint a new target around it."

Tests-that-test-nothing is documented as a literal artefact. From [What's the most "yep, an AI wrote this" bug you've seen?](https://www.reddit.com/r/ExperiencedDevs/comments/1moi9ta/whats_the_most_yep_an_ai_wrote_this_bug_youve_seen/): a test that sets `x = 123`, calls the function under test, then asserts `x == 123`. From the test-suite thread, the same failure abstracted: "Function ReturnsTrue => false; AI will generate a test that will pass".

Pairing behaviour to evidence is described as a working technique. From [how are you handling code review when most of the code is ai-generated?](https://www.reddit.com/r/cursor/comments/1so1xzn/how_are_you_handling_code_review_when_most_of_the/): test-first means "review becomes are these tests actually covering the right cases" rather than reading implementation cold. Same thread, the other half of the lens: "reviewing against the original spec, not the implementation thread" catches "scope creep and edge cases that reviewing the diff misses entirely".

Bonus: this lens attacks the largest single chunk of modern diffs. Half the PR being tests is now normal, and reviewers admit they skim: "These days I zoom through the tests to be honest. They all feel soulless." A claims-and-evidence view that collapses tests into evidence rows *reduces* the surface rather than adding to it. That is a real, defensible win.

### 5. Familiarity: PARTIALLY validated, and mis-specified

The felt loss the discourse describes is not familiarity with the surrounding code. It is familiarity with *how the change came to be*.

[I spend 4x longer reviewing AI code than a junior's worse code](https://www.reddit.com/r/cursor/comments/1utdf6b/i_spend_4x_longer_reviewing_ai_code_than_a/) diagnoses it precisely: "I watched the junior's code get made... By the time his PR landed I already knew the story of it. The agent's code showed up fully formed with no history."

The same shape appears in r/ExperiencedDevs's process thread: "I open their PR, and I already know what it's about because we chatted about it briefly... Regardless of how many LOC it is, it's never too much." And the loss is named explicitly: "that signal that this is someone I trust is yet another thing that disappears thanks to LLMs. I wonder how much extra review time that loss of signal leads to."

Blame does appear, but socially rather than navigationally: "I do remind those devs that git blame exists, and it won't say Claude." Nobody in this corpus describes wanting a per-reviewer blame gradient painted over a diff. What they describe wanting is the story.

**Recommendation:** reframe familiarity as **provenance**. Blend blame-derived ownership with (a) whether you have already reviewed this hunk in an earlier patchset, (b) whether the change was planned or improvised, (c) whether the author can answer for it. Keep it in phase two as planned; the ROI is visibly lower than the other four, and the raw blame gradient alone would land as a novelty.

---

## Missing lens candidates

### A. Redundancy, or "this already exists": strongest missing candidate

This is the most-reported concrete defect in AI PRs and none of the five lenses catch it, because the evidence is not in the diff.

- [Reviewing someone else's AI slop](https://www.reddit.com/r/ExperiencedDevs/comments/1nfpb14/reviewing_someone_elses_ai_slop/): "copy paste logic even within a single file", "repetitive logic across multiple files that could be abstracted".
- [What do you do to keep your codebase DRY in the age of AI?](https://www.reddit.com/r/ExperiencedDevs/comments/1k7m5e5/what_do_you_do_to_keep_your_codebase_dry_in_the/): "AI loves repetitions... Each time I look away I find new duplications." One commenter already runs `pmd cpd` and fails CI on duplicate blocks.
- [I audited 6 months of PRs](https://www.reddit.com/r/webdev/comments/1sin68g/i_audited_6_months_of_prs_after_my_team_went/): "a utility function that was 40 lines of enterprise-grade typescript doing exactly what Array.prototype.map already does".
- [the most productive thing i do every morning](https://www.reddit.com/r/ExperiencedDevs/comments/1tivlma/the_most_productive_thing_i_do_every_morning_is/): the payoff described is catching "two different people were independently building basically the same caching helper".

Lens shape: for each new symbol or block, the nearest existing thing in the repo, with a similarity score and a jump link. Local-first is a genuine advantage here because the whole repo is on disk and the comparison never leaves the machine. Nobody has this as a first-class review surface.

### B. Subtraction, or "what could be deleted"

The most-upvoted description of the AI review feeling in the entire corpus is about excess, not error. The 611-point line that seeded a dozen blog posts is "Reviewing PRs full of extremely over engineered slop is exhausting".

- Burnout thread: "Multiple 5k+ line PR's that should be sub 100 lines" and "endless redirection where multiple things don't actually do anything".
- Slop-review thread: "if they reduced the slop it would literally not break 500ish lines", including "catching exceptions just to re-raise them with some extra text".
- PR audit thread: "try-catch around a console.log", "same tendency to over-abstract simple things".
- [Handling AI code reviews from juniors](https://www.reddit.com/r/ExperiencedDevs/comments/1r0iepg/handling_ai_code_reviews_from_juniors/): AI adds "runtime type checking of things that the static type checker already approves of".

Lens shape: single-caller abstractions, unreachable branches, defensive code the type system already covers, indirection with one implementation, comments that restate the line below. Present it as a delete queue, not a comment queue. This is the emotionally resonant one: the reviewer's true wish is not to understand the 3,000 lines, it is to be told which 2,000 should not exist. No existing tool frames review this way.

### C. Scope conformance (fold into claims and evidence)

Scope creep is reported constantly and is the cheapest thing to catch. "If the PR is huge because it has stuff that is out of scope, I usually ask for the items outside of the scope to be removed." "They realise they need a new library, so they add the library upgrade in the same PR." The Cursor thread's insight is the mechanic: review against the original spec, in fresh context, because "an agent that already wrote the code has rationalized its choices internally".

Recommendation: make claims-and-evidence bidirectional. Every hunk maps to a requirement (from ticket or spec) *and* to a test delta, with an explicit unclaimed bucket for hunks that answer to neither. The unclaimed bucket is the scope-creep detector and it costs nothing extra.

### D. Safety-net weakening (fold into blast radius as a preset)

Distinct, cheap, and extremely high signal on LLM-authored diffs: changes to the things that check the changes. Test deletions and skips, new mocks on security paths, CI config edits, coverage threshold changes, lint rule disables, feature flag default flips. The AuthZ-mocked-to-make-tests-pass story is exactly this, and the audit thread reports a policy where "PR's less than 500 LOC can be merged without human review if the AI approves it". Any diff that lowers a gate should flare regardless of which lens the reviewer is in.

### E. Dependency and supply chain (preset, not a lens)

Real and recurring. [AI code suggestions sabotage software supply chain](https://www.reddit.com/r/programming/comments/1jycix4/ai_code_suggestions_sabotage_software_supply_chain/) covers slopsquatting, with the folk alternative name offered in comments: "I prefer to call it vibe-jacking". Hallucinated API surface is separately common: "adding a flag/property to a cli/API that I would love to have but simply does not exist". But existing tooling (Dependabot, lockfile review, socket-style scanners) mostly owns this. Treat manifest and lockfile changes as a blast-radius preset plus a does-this-package-exist check. Do not spend a lens slot.

### F. Performance: not a lens

Present as a review concern (N+1s, "the O(n^2) algorithm", webapp bloat) but never as an organising principle for reading a diff. Leave it to the findings queue.

---

## Vocabulary harvest

**Units of review.** "PR" is universal. "Diff" and "changed files" are the surfaces. **"Chunk" is the folk term and it is unburned**: "break it into reviewable chunks", "split into reviewable chunks of logic", "digestible". Nobody on Reddit says "hunk". Also live: "atomic commits", "vertical slice", "shallow vertical slices", "stacked PRs", "walkthrough" (the meeting you call when a PR cannot be split).

**Risk vocabulary.** "Blast radius", "load-bearing", "regression risk", "surface area". All native, all usable.

**AI-code failure modes.** "Slop" dominates and has verbed ("vibe-slopping", "slop PR", "Slop Overflow"). Then: "plausible-looking code", "looks good and plausible", "fluent", "polished", "80% correct", "hallucinated api calls", "slopsquatting", "vibe-jacking", "phantom author", "painting the target around the arrow", "content pollution", "a DDOS attack with PR's".

**The single most valuable phrase in the corpus** is about lost signal, from the review-process thread: "Now a lot of generated code has no obvious smell." The preceding line is "Before AI, this code smells weird was actually a useful signal." Restoring smell to a diff is a better product framing than making a diff smaller.

**The reviewing feeling.** "Exhausting" is the consensus adjective. Then: "burning me out", "my soul dies a little bit", "brutal", "with fear and despair", "the specific dread", "review fatigue", "cognitive budget", "taxed my attention", "asymmetric workload on the reviewer", "orbiting the decision", "review turns into theater", "I'm tired boss", "Please send help". And the loneliest line in the whole corpus, worth remembering when writing copy: "I'm the first human being to ever lay eyes on this code."

**The moral refrain**, repeated in a dozen threads in a dozen forms: "Why should I bother to read something you didn't bother to write?"

**Naming implications.** "Chunk" and "reviewable chunk" are available and already in engineers' mouths, unlike cohort, layer and stack. "Load-bearing" is a strong blast-radius word. "Orbiting the decision" is a gift for the decision lens and for landing-page copy. Avoid "slop" in product voice: the buyer is the agentic engineer, and calling their output slop insults the customer.

---

## Trust, false positives, and the existing bots

Consistent and quantified hostility to current AI reviewers, which is the market opening and also the trap.

- "80% of the comments are usually lacking context, blatantly incorrect, or insignificant nitpicks" ([What's your honest take on AI code review tools?](https://www.reddit.com/r/ExperiencedDevs/comments/1o1a601/whats_your_honest_take_on_ai_code_review_tools/)).
- "AI code review is Awful. Unnecessarily verbose. Comments when it shouldnt. Reviews stuff that is not in the PR." Same thread.
- CodeRabbit, from [GitHub AI generated PR descriptions](https://www.reddit.com/r/ExperiencedDevs/comments/1i9340j/github_ai_generated_pr_descriptions/): "10-30 comments on PRs, 100% of which are wrong", with a worked example of it flagging safe parameterised queries as SQL injection because it did not know the library.
- Graphite Reviewer, from [What's your experience with AI-based code review tools?](https://www.reddit.com/r/ExperiencedDevs/comments/1grd2d9/whats_your_experience_with_aibased_code_review/): "at least 75% of its comments are off base in some way", again from missing context.
- Copilot review: "It generates work and rarely catches something worth caring about... I would pay money to not have it shit my PRs up." Reviewers also observe Copilot is worse than pasting the same diff into Claude, attributed to "context optimizations to save on cost".
- Noise causes uninstalls: "we ironically disabled the review bot because it's so noisy".

The two survival framings engineers offer are worth adopting directly. First, the linter frame: "think of it as a static analysis tool that runs in CI", "a more robust version of rule-based linters". Second, the screening frame: a sensitive first test that produces probable issues for a human to confirm.

**Two operational findings fall out of this.**

The first is a direct hit on the v1 sequencing. The most upvoted piece of process advice on the topic: "The proper place to introduce AI feedback is before the PR goes up for review. Have the original code author review any AI suggestions and act on them." The rationale given is that forcing everyone to review both the code and the bot's comments "wastes a lot of time". The Feature Inventory currently recommends post-PR leads v1. Reddit says the opposite, and says it for a reason that is about respect for other people's attention, which is the same moral engine as "why should I read what you didn't write". Worth revisiting.

The second is the label-and-dismiss requirement. From the juniors thread: "We label comments coming from AI code review, and I find it helpful... Having them labeled helps to not spend too much time triaging." Teams that survive AI review comments have a nit policy, a provenance label and a one-click score. That validates the false-positive-budget feature as core rather than candidate.

## AI reviewing AI, and harness disagreement

Cross-model review is already established folk practice, which is good news for the multi-harness bet.

- "an LLM will absolutely rip code written by the same model to shreds if you ask it is this PR ready to be merged?" (531 points, [new project is 99% ai generated](https://www.reddit.com/r/ExperiencedDevs/comments/1v6n7d7/2yrs_at_current_company_new_project_is_99_ai/)).
- "we keep PRs small, and review them with different models" (2000-line thread).
- "I ask another model to review. Actually, four other models... reviews, tries to break, discusses and reconciles" (Cursor thread).
- [GPT-5 has been surprisingly good at reviewing Claude Code's work](https://www.reddit.com/r/ClaudeAI/comments/1mvbxaw/gpt5_has_been_surprisingly_good_at_reviewing/) is a 767-point thread built entirely on the write-with-one, review-with-another split.

Disagreement as signal has direct empirical support, and a caveat. Two colleagues ran the same model over the same code and got different findings: "So much non-determinism." That cuts both ways. Divergence is informative, but the product must distinguish divergence-because-ambiguous from divergence-because-stochastic, or the flare mechanic becomes noise with extra steps.

The circularity objection is loud and needs a pre-loaded answer: "ai reviewing ai written code seems cyclic", "Have Claude review the PR's. What could go wrong?", and the joke that lands hardest, "We have conducted an investigation on ourselves and have found that we have done nothing wrong". The human-is-the-gate framing already in the note is the right answer, but it has to be in paragraph one.

## Review on phone

**Absent.** Six targeted searches across r/ExperiencedDevs, r/programming, r/webdev and r/github returned zero substantive threads about reviewing or approving PRs from a phone. The only adjacent result is people vibe-coding from their phone, which is the opposite behaviour. There is no organic demand signal for the mobile companion in this corpus. That does not make it wrong, but it should not lead the pitch, and the paid-mobile revenue assumption has no Reddit support behind it.

## Local-first

Weak but real. "It's insane that we've normalized feeding proprietary codebases into LLMs" (big-codebase thread). A 115-comment r/ExperiencedDevs thread asks whether anyone thinks about what source code leaves the network when using coding agents. Enough to justify local-first as a stated property, not enough to make it the headline.

---

## Honest verdict

Reddit supports the lens set, but not evenly, and it reorders the priorities. Decision points and claims-and-evidence are validated hard: engineers describe the exact failures those lenses target in their own words, repeatedly, at high upvote counts, and the phrase "orbiting the decision" is a better articulation of the thesis than anything currently in the vault note. Blast radius is validated as a need with native vocabulary and a real credibility tax, so it must show cheap explainable signals rather than claim impact analysis. Chapters are validated as a *shape* of work that engineers already describe, but they are conceived by the community as the author's obligation rather than the reviewer's tool, and the honest read is that most teams squash the narrative away and then reject the PR instead of reading it. Familiarity is the weakest and is mis-specified: what has been lost is the story of how the change happened, not the ownership of the code around it, so reframe it as provenance and keep it in phase two.

The three changes I would make. First, add a **subtraction lens**, because the loudest single sentence in the corpus is about over-engineering rather than error, and no product frames review as a delete queue. Second, add a **redundancy lens** ("this already exists over there"), because it is the most-reported concrete AI defect, it is invisible in a diff by construction, and a local-first tool with the whole repo on disk is uniquely placed to compute it. Third, and most strategically: the dominant moral position on Reddit is that a large unread AI PR should be refused, not accommodated. A tool that makes 3,000-line PRs pleasant to review can be read as enabling exactly the behaviour the community wants stopped. The self-review route handoff is not a keystone feature, it is the product's alibi, and the pitch should lead with making the author do the work rather than making the reviewer heroic.
