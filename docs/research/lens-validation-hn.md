---
categories:
  - research
tags:
  - code-reviews
  - lens-validation
created: 2026-08-04
---

# Lens Validation: Hacker News

Validation pass on the five-lens hypothesis for [[Code Review Harness App]], sourced entirely from Hacker News discourse 2024-2026. Threads read: Ask HN "How to deal with long vibe-coded PRs?" (349 comments), "The Theatre of Pull Requests and Code Review" (416), "There is an AI code review bubble" (249), Launch HN mrge.io/cubic (108), Show HN Stage (111), "How we made our AI code review bot stop leaving nitpicky comments" (169), "Ask HN: Is anyone else sick of AI splattered code" (84), Show HN heatmap diff viewer (68), Show HN AISlop (65), Show HN adamsreview (54), Show HN Haystack (59), Stacked PRs on GitHub (295), Copilot review billing (207), plus targeted comment searches.

All quotes verbatim, attributed by HN username, linked to the thread.

---

## Headline finding before the lenses

**The chapters lens has a live, funded, open-source competitor that already occupies the local half of the wedge.**

Stage (YC Spring 2026, [Show HN April 2026, 130 points](https://news.ycombinator.com/item?id=47796818)) pitches, in their own words, grouping changes into "small logical chapters" that "get ordered in the way that makes most sense to read", with "specific things to double check" per chapter, and "Once you review all the chapters, you're done reviewing the PR". That is the chapters lens plus the coverage-completion semantics, shipped.

Worse for the moat: Stage also ships `stage-cli`, MIT licensed, 258 stars, npm `stagereview`, which runs `/stage-chapters` inside your AI agent, ingests GitHub PRs via `--pr <n>` using `gh`, and states "Everything happens on your machine." It even implements the residue guarantee from our feature inventory: ignored files "still appear in the 'Other changes' chapter so nothing is silently hidden."

One caveat on a claim circulating: a July 2026 HN post titled "Show HN: Stage is sunsetting their product, what now?" ([48996894](https://news.ycombinator.com/item?id=48996894)) was posted by othmanosx, the founder of a rival tool (Pyor), got 2 points and no comments. Stage's own site, blog, and npm package are live as of this research. Treat the sunset claim as competitor marketing, not fact.

What Stage does NOT have, per the discourse and their own materials: multiple concurrent lenses, decision extraction, blast radius, claims-and-evidence, harness choice, persistent state across force-push, or mobile. The lens *set* is still open ground. The chapters lens alone is not.

---

## Per-lens verdicts

### 1. CHAPTERS (dependency-ordered reading sequence) — VALIDATED, contested

The demand is real and repeatedly expressed, and it is the one lens with commercial proof.

**For:**
- ryanjso, on Stage: "a lot of PRs I review should really be like 5 prs" ([47796818](https://news.ycombinator.com/item?id=47796818))
- irrationalfab, on Haystack: "Non-trivial PRs need two passes: first grok the entrypoints and touched files" ([45201703](https://news.ycombinator.com/item?id=45201703))
- bilalq, on cubic's launch, praised the "grouping of file changes by concept"; C-Pec called "the logical grouping of diffs" "super thoughtful" ([43692476](https://news.ycombinator.com/item?id=43692476))
- Reviewers already hand-roll it. phyzome: "My solution is to organize my PRs as a sequence of commits that explain what they do" ([45201703](https://news.ycombinator.com/item?id=45201703))
- Stacked PRs landing on GitHub in July 2026 drew 778 points and 295 comments. 8260337551: "I plan on having my agents use this heavily so I can review PRs in bite-sized chunks" ([49112232](https://news.ycombinator.com/item?id=49112232))
- Demand for manual correction of the grouping surfaced immediately. sebakubisz asked Stage whether reviewers can adjust chapter splits they disagree with. This validates drag-hunks-between-groups as table stakes, not a nice-to-have.

**Against, and this is the single most durable objection on HN:**
- tasuki, to Stage: "Isn't that what commits are for?" ([47796818](https://news.ycombinator.com/item?id=47796818))
- keybored, same thread: "not so dainty and weak that it cannot write a commit message"
- Stage's founder answered "it's difficult to create well-mannered commits as you code" and got pushback.

The counter-argument is available and also on HN, from the 416-comment Theatre thread: herval says "nobody reads intermediate commit messages one by one on a PR, period", and mvdtnz says "I never, ever inspect the commits tab in a PR" ([45371283](https://news.ycombinator.com/item?id=45371283)). So the objection is real but not consensus. It must be answered in the first paragraph of any launch copy, exactly like the GitHub-workflow objection.

**Second objection, sharper: HN does not want generated prose.**
- dawnerd: "If I'm reviewing AI code, I don't want AI summaries" ([47796818](https://news.ycombinator.com/item?id=47796818))
- akshaysg: "I have no patience to read AI-generated content" ([45201703](https://news.ycombinator.com/item?id=45201703))
- hexaga warned Stage that AI narratives get contaminated with spin
- Pyor's whole counter-positioning against Stage: adding AI narrative "just makes the review slower"
- ramoz, on a guided-review Show HN, wants tools that "point you to what you need to focus on and skim the noise" rather than more to read ([48797645](https://news.ycombinator.com/item?id=48797645))

**Design consequence:** chapters must be *ordering and boundaries*, not paragraphs. Prose is optional, collapsed by default, and never sits between the reader and the diff.

### 2. DECISION POINTS — VALIDATED, strongest wish-level evidence, hardest mechanic

This is the lens HN asks for by name without having a tool for it.

**For:**
- kaishin, in the AI-code-review-bubble thread, describing what he actually wants: "a review wizard agent, something that identifies the pieces I should look at" ([46766961](https://news.ycombinator.com/item?id=46766961))
- ramoz: "point you to what you need to focus on and skim the noise" ([48797645](https://news.ycombinator.com/item?id=48797645))
- avikalp, whose whole post is that AI review tools solve the wrong problem: "the job of a better code-review interface would be to provide a higher level of abstraction" ([43219455](https://news.ycombinator.com/item?id=43219455))
- The failure mode our queue replaces is named directly. ekjhgkejhgk: "Huge CRs get little comments" ([45744209](https://news.ycombinator.com/item?id=45744209))
- minasmorath, on AI review noise: "actual issues with a PR go completely unnoticed" ([42451968](https://news.ycombinator.com/item?id=42451968))
- smallpipe, same thread, on the cost of the current model: "spending time making the AI happy"
- colechristensen argued for having AI rank findings by severity so a human scans a prioritized list in seconds ([46766961](https://news.ycombinator.com/item?id=46766961))
- eqvinox, on cubic's launch, is the numeric case: "of the 11 issues it flagged, only 1 was appropriate", and it "didn't flag the one SNAFU that really broke things" ([43692476](https://news.ycombinator.com/item?id=43692476))

**Against, and this is a genuine threat to the mechanic:**
- iLoveOncall, on nitpick classification: "the same comment can be a nitpick on one CR but crucial on another", and "clustering them is destined to result in false-positives and false-negatives" ([42451968](https://news.ycombinator.com/item?id=42451968)). If severity is context-dependent, so is decision-worthiness.
- avikalp: if the output cannot be verified trivially, "you are just changing the nature of the job" ([43219455](https://news.ycombinator.com/item?id=43219455))
- layer8, on AI review generally: "They flag potential issues, but you still have to check all of them" ([43219455](https://news.ycombinator.com/item?id=43219455))

**Design consequence:** "6 decisions, not 47 comments" only wins if each of the 6 arrives with everything needed to discharge it in place. A decision that costs a context switch to verify is a comment with better marketing. This is the lens where the false-positive budget mechanics matter most, and where a wrong-sized queue destroys trust fastest.

### 3. BLAST RADIUS — VALIDATED, and the vocabulary is already native to HN

Rare win: the name is not ours to coin, it is already how HN talks about risk, including in review contexts.

**Vocabulary evidence (all HN comments 2024-2026):**
- kerim-ca describes changes "characterised by a 'high blast radius' and 'Gen-AI assisted changes'" ([47319816](https://news.ycombinator.com/item?id=47319816))
- alepar, on reviewers of agent output: "they can't really tell what the blast radius will be" ([49130999](https://news.ycombinator.com/item?id=49130999))
- K0balt: "naive review of the plan vs the specification vs the blast radius" ([49161712](https://news.ycombinator.com/item?id=49161712))
- konovalov-nk has already sketched the tool: "git diff | blast-radius -> which specs/ACs are affected" ([47811201](https://news.ycombinator.com/item?id=47811201))
- bnchrch, describing an actual gate: "If it's low complexity / blast radius it gets auto merged" ([48048810](https://news.ycombinator.com/item?id=48048810))

**For, from the heatmap diff viewer Show HN (265 points):**
- austinwang115: "now the heatmap guides my eyes so I know where to look" ([45760321](https://news.ycombinator.com/item?id=45760321))
- cdiamand: "help bring a reviewer's eyes to high risk areas"
- jtwaleson asked for exactly our obligations mechanic: "a checkbox at a certain threshold, so reviewers explicitly answer concerns"
- mock-possum, on AI review usefully flagging security surfaces, valued being told a change "ties into infrastructure" so they could tag the infra team ([48276152](https://news.ycombinator.com/item?id=48276152))
- MistSeeker ([46365862](https://news.ycombinator.com/item?id=46365862)) is a whole Show HN whose pitch is "a map of what is safe to change in large codebases", deterministic, local, no LLM. The concept has independent product validation.

**Against, and two of these are serious:**
- cerved: "Regressions are probably less likely in 'hotspots' where people would be careful anyway" ([45760321](https://news.ycombinator.com/item?id=45760321)). If heat correlates with attention already paid, the overlay may point at the safest code in the diff. Fan-in is not the same as danger.
- MattyRad, on the same tool: "At no threshold does it highlight deleted code". Deletions carry high blast radius and most heat models miss them entirely.
- nzach: "I probably wouldn't be able to trust it enough to make it useful"

**Design consequence:** blast radius must be built from irreversibility and contract surface (schema, auth, public API, deletions, migrations), not from churn or fan-in heat. The heat-map framing is the trap, not the insight.

### 4. CLAIMS AND EVIDENCE — VALIDATED, most distinctive, least occupied

Highest signal-to-noise of the five. HN articulates this pain precisely and no launched tool in the threads addresses it.

**For:**
- smsm42, the cleanest statement of the problem anywhere in the corpus: "If you don't review them, you don't have tests." and "You have a pile of code that looks like tests." ([45744209](https://news.ycombinator.com/item?id=45744209))
- clbrmbr, on what LLM PRs look like: "Really well-written PR messages and clean code that doesn't do the right thing" ([46292682](https://news.ycombinator.com/item?id=46292682))
- m463: "Code that looks good is not the same as code that is good" ([45278819](https://news.ycombinator.com/item?id=45278819))
- tadfisher: "The tools are prone to rewrite or even delete the tests" ([46656759](https://news.ycombinator.com/item?id=46656759))
- lmeyerov, on multi-agent review, describes exactly this lens as the thing that worked: it "finds when implementation, tests, docs are out of sync" ([48090276](https://news.ycombinator.com/item?id=48090276))
- magmostafa uses test-first as a comprehension check on the model ([46292682](https://news.ycombinator.com/item?id=46292682))
- hexaga's warning to Stage about narrative contamination is the same insight from the other side: the claim is the least trustworthy artefact in the changeset.

**Against:** almost nothing. The only real risk is mechanical, not conceptual: mapping behavioural claims to test deltas is hard where coverage is integration-level, and the lens degrades to noise in repos with weak test culture.

**Design consequence:** lead with this one. It is the lens that most directly names the LLM tell, it has the best quotes, and nobody in the corpus has shipped it.

### 5. FAMILIARITY (blame-derived) — PARTIALLY SUPPORTED, and correctly deferred

Weakest of the five, and one quote actively undermines the premise.

**For:**
- cordialpanda, describing real practice: "code from new devs should require more scrutiny" ([11709544](https://news.ycombinator.com/item?id=11709544))
- skydhash, on stacked PRs, on routing by expertise: "one change may require review from an external team" ([49112232](https://news.ycombinator.com/item?id=49112232))
- missinglugnut, on what AI cannot do: "I need someone who deeply understands the threading model" ([46292682](https://news.ycombinator.com/item?id=46292682))
- rock3m frames review as "code co-ownership and keeping all the people on the same page" ([15571243](https://news.ycombinator.com/item?id=15571243))

**Against:**
- roughly, on AI-authored codebases: "Every line may as well have been written by a different person" ([45278819](https://news.ycombinator.com/item?id=45278819))
- nharada: you are forced to "review everything through the lens that it may be human created" ([45278819](https://news.ycombinator.com/item?id=45278819))

Blame is a decaying signal in exactly the codebases this product targets. If most lines were written by an agent under three different humans' prompts, the blame gradient measures who ran the agent, not who understands the code.

**Recommendation:** keep it deferred, and when it comes back, recast it as **expertise routing** (who should look at this hunk, derived from review history and subsystem, not authorship) rather than familiarity. Same UI slot, defensible signal.

---

## Missing lens candidates

Ranked by how often HN raises them unprompted.

**A. Context reach: the unchanged code you must read to judge the change. STRONGEST CANDIDATE.**
This is the most repeated structural gap in the corpus and none of our five lenses covers it.
- nonethewiser, on the heatmap tool: "A large portion of lines I'm considering aren't part of the diff", and it "happens almost every PR" ([45760321](https://news.ycombinator.com/item?id=45760321))
- embedding-shape's top criticism of Stage: "it's missing almost the most important thing; the context of the change itself" ([47796818](https://news.ycombinator.com/item?id=47796818))
- DTrejo, on Haystack, asking for the mechanic directly: "step through the code execution paths that have been modified" ([45201703](https://news.ycombinator.com/item?id=45201703))

Blast radius points at risky *changed* code. Nothing points at the *unchanged* code the change implicates. This is a sequence-or-overlay lens and it may be more valuable than familiarity ever was.

**B. Defensive scaffolding and slop: the LLM signature. STRONG CANDIDATE, distinct from mechanical collapse.**
Most-named AI failure mode in the corpus, all from the AISlop Show HN ([48322956](https://news.ycombinator.com/item?id=48322956)) and the AI-splatter thread:
- macNchz: "enterprise factoryfactoryabstraction stuff, excessively long names"; "Comments that add no context or simply restate the field name"; "Meta references to previous code versions, to tasks or todos, or to instructions"; "Overly backwards-compatible"
- cityofdelusion: "the guard code drives me crazy"
- vunderba: "redundant safeguards", "null coalescing operators and defensive fallbacks"
- Heavykenny: "duplicated functions doing same thing, dead or redundant codes"
- ryandrake: Claude leaves "unused functions when iterating"

Note this is the *inverse* of mechanical collapse. Mechanical changes are bulk and obviously safe to skim. Slop scaffolding looks like meaningful work and is not. Collapsing it under "mechanical" would be wrong; it needs its own treatment, probably as a queue lens sibling to decision points.

**C. Convention and architecture drift. STRONG CANDIDATE, but it is the commodity.**
- macNchz: "Changes that deviate from existing patterns and architecture already in the code" ([48322956](https://news.ycombinator.com/item?id=48322956))
- moomin, on multi-agent review: "need to check against internal coding standards" ([48090276](https://news.ycombinator.com/item?id=48090276))

This is precisely what cubic and CodeRabbit sell (cubic's headline feature is learning from senior engineers' historical PR comments). High demand, low differentiation. Our per-repo convention-docs-as-harness-context feature already covers it. Do not make it a lens; make it a blast-radius and decision-points input.

**D. Harness disagreement. ALREADY IN THE INVENTORY AS Q12, AND HN ASKS FOR IT UNPROMPTED.**
- justanotheratom, on cubic's launch: "Maybe there can be multiple AI models review the PR at the same time" ([43692476](https://news.ycombinator.com/item?id=43692476))
- embedding-shape: "using two models... easily beats one model and one review" ([48406358](https://news.ycombinator.com/item?id=48406358))
- eranation uses Opus for editing and a different model for peer review because of "different training sets" ([48406358](https://news.ycombinator.com/item?id=48406358))

Settle Q12 as a visible feature. It is demanded, it is BYOK-native, and cloud competitors cannot match it on cost.

**E. Dependency and supply chain. WEAK. Fold into blast radius.**
Present but thin in review discourse: kangabru on reviewing packages before installing including "recent code ownership changes"; a Show HN for hallucinated-package detection with 2 points ([46478932](https://news.ycombinator.com/item?id=46478932)). Not enough recurrence to justify a lens slot.

**F. Performance. DO NOT BUILD.**
Effectively absent from HN code review discourse in this period. Targeted searches returned nothing.

---

## Vocabulary harvest

**Units of review (what HN calls the thing):**
`chapter` (burned, Stage owns it), `cohort` / `layer` / `stack` (burned, CodeRabbit), `chunk` ("bite-sized chunks", 8260337551), `changeset` (wengo314: "split it into reasonable chain of changesets" — note HN uses this publicly, which softens the internal-only rule), `hunk`, `hotspot`, `pass` ("two passes", irrationalfab), `stacked PR`, `the pieces I should look at` (kaishin).

**AI-code failure modes:**
`slop`, `AI slop`, `vibe-coded`, `AI splattered`, `guard code`, `defensive fallbacks`, `redundant safeguards`, `factoryfactoryabstraction`, `meta references`, `dead-end variables`, `a pile of code that looks like tests`, `hallucinated package`, `slopsquatting`, `code that looks good`, `underspecification`, `scope explosion` (azurewraith), `nondeterministic`.

**The reviewing feeling (candidate emotional positioning):**
`drowning` (Stage's own copy, and jaapz on "immense amount of strain"), `draining` (account42), `rubber-stamping` (stackskipton: "Most of human review I see of AI code is rubber stamping"), `review theater` (eranation, and the 416-comment "Theatre of Pull Requests"), `not instantly LGTM` (austinwang115), `time drain` (jonchurch_), `disrespectful` (ericmcer: "Asking me to review a shitty PR that you don't understand is just disrespectful"), `onslaught`, `backlog`, `fatigue`.

**Risk language:** `blast radius` (native, confirmed), `hotspot`, `high risk areas`, `what is safe to change`, `criticality`.

**Verbs HN uses approvingly about tools it likes.** These are the phrases to steal for copy:
- "guides my eyes so I know where to look" (austinwang115)
- "identifies the pieces I should look at" (kaishin)
- "point you to what you need to focus on and skim the noise" (ramoz)

All three are attention-routing verbs. None is a summarization verb. That is the positioning instruction.

---

## Launch-thread reception patterns

Drawn from Launch HN mrge.io/cubic (108 comments), Show HN Stage (111), Show HN Haystack (59), Show HN heatmap (68), Show HN adamsreview (54), Show HN Open Code Review (73).

**1. Workflow-out-of-GitHub is the number one objection, verbatim as expected.**
- dyeje: "taking the workflow out of GitHub is a deal breaker", and "I'm trying to speed things along, not upend my whole team's workflow" ([43692476](https://news.ycombinator.com/item?id=43692476))

**2. Local-first and BYOK are actively demanded, repeatedly, by name.**
- thuanao, in the cubic launch thread: "I'd like to run it locally" and "I don't want feedback after I open a PR". That single comment validates both local-first AND the pre-PR self-review mode.
- lukeasrodgers: "most teams should not be paying SaaS fees for AI code review" ([48406358](https://news.ycombinator.com/item?id=48406358))
- upmostly's Mira pitch, praised in the tooling Ask HN, leads on "self-hosted, bring-your-own-model, nothing leaves your infra" ([48587808](https://news.ycombinator.com/item?id=48587808))
- jFriedensreich to Stage: "i would rather spend a week vibe copying this than onboarding a tool" ([47796818](https://news.ycombinator.com/item?id=47796818))

**3. Security scope and permissions are a launch-killer for cloud review tools. This is the procurement thesis, confirmed.**
- gslepak, on cubic's GitHub app: it "represents a backdoor into every project that signs up for it"
- rsavage: a bot "able to deploy any code changes to production is a no go"
- benjbrooks: "def need soc2 to justify it to our security folks"
- Corroborating market signal: the CodeRabbit RCE writeup hit 687 points and 227 comments ([44953032](https://news.ycombinator.com/item?id=44953032)). A local-first tool holding no repo credentials sidesteps this entire objection class.

**4. Praise clusters on structure and attention, not on bug-finding accuracy.**
Every launch thread praised grouping, ordering, stacking, and visual routing. Nobody praised catch rate. eqvinox's "1 of 11 was appropriate" is the representative accuracy datapoint.

**5. Backlash against AI-generated narrative is loud and consistent.** See the chapters section. Any generated prose must be dismissible.

**6. The standing dismissal you must answer: "why not just prompt the model yourself".**
- roncesvalles: "It's very unlikely that any of these tools are getting better results" than prompting a model directly ([46766961](https://news.ycombinator.com/item?id=46766961))
- guelo: "All those llm wrapper companies make no sense"

Note carefully: BYOK plus local *strengthens* this objection rather than deflecting it, because the user already has the harness. The only answer is that the product is the interface and the state model, not the inference. Every piece of copy has to earn that.

**7. Pricing opacity is instantly punished.** high_priest to Stage: "No pricing page, you've lost my interest."

**8. Human-gate positioning is well received but is now table stakes.** Stage led with "Putting humans back in control", cubic with human-friendly workflow, Critiq with "AI as Your Spotter". Three tools, same claim. It buys entry, not differentiation.

---

## Notable quotes worth reusing

- breppp, the single best statement of the core problem: "There's an asymmetry between time to generate crap code and time to review it" ([45278819](https://news.ycombinator.com/item?id=45278819))
- smsm42: "You have a pile of code that looks like tests" ([45744209](https://news.ycombinator.com/item?id=45744209))
- jcranmer: "AI makes mistakes in very different ways from the way humans make mistakes" ([45278819](https://news.ycombinator.com/item?id=45278819))
- lm28469: "Why would I bother reviewing code you didn't write and most likely didn't read?" ([45744209](https://news.ycombinator.com/item?id=45744209))
- shortcord, which is an argument FOR the self-review route handoff keystone: "Tools like this can never replace the quality of the narrative" that the author can produce ([45201703](https://news.ycombinator.com/item?id=45201703))
- trjordan: "The point of a PR is to share knowledge and to catch structural gaps" ([46766961](https://news.ycombinator.com/item?id=46766961))
- CharlieDigital, describing the self-review handoff as existing manual practice: "Ask the submitter to review and leave their comments first" ([45744209](https://news.ycombinator.com/item?id=45744209))
- h1fra, the tone to avoid at all costs: "one more ai code review please, I promise it will fix everything this time" ([46766961](https://news.ycombinator.com/item?id=46766961))

---

## Verdict

HN discourse supports the lens set, but not evenly, and not in the order the current inventory implies. Claims-and-evidence is the strongest and most defensible lens by a wide margin: HN names the pain precisely ("a pile of code that looks like tests", "clean code that doesn't do the right thing"), nothing shipped addresses it, and it has no meaningful opposition in 2,000-plus comments. Blast radius is validated with the bonus that HN already speaks the phrase natively, though the evidence says build it from irreversibility and contract surface rather than churn heat, because at least one commenter argues heat anti-correlates with defects and another caught a heat tool ignoring deletions entirely. Decision points is the most-wished-for and least-solved, but it carries the corpus's sharpest objection: severity is context-dependent, so a decision that costs a verification round-trip is just a comment with better marketing. Chapters is validated commercially and rejected philosophically in the same breath, and it is the lens whose ground is already occupied by a YC-funded competitor shipping an MIT-licensed local CLI with GitHub PR ingestion and a residue guarantee. Familiarity is the weakest: blame is a decaying signal in exactly the AI-authored codebases we are targeting, and it should come back as expertise routing or not at all. I would make three changes. First, drop familiarity from the designed-for-later slot and put **context reach** there instead, the unchanged code a change implicates, which is the most repeated structural complaint in the corpus and which none of our five lenses touches. Second, split **defensive scaffolding and slop** out of the mechanical-collapse fold and give it a queue lens of its own, because it is the single most-named LLM failure mode on HN and it is the one thing that looks like work and is not. Third, promote harness disagreement from open question to shipped feature, because HN asked for it unprompted in a competitor's own launch thread and it is the one mechanic a cloud vendor cannot economically copy.
