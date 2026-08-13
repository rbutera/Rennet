---
categories:
  - projects
tags:
  - code-reviews
  - branding
created: 2026-08-04
---

> 📜 **Historical evidence, not current authority.** Superseded wherever it conflicts with **RULE ZERO** (`CLAUDE.md`): no consent gates, no gates, no robustness for robustness' sake. Read for rationale and provenance only.

# Code Review App: Branding Questions

Discovery questions for [[Code Review Harness App]]. These are the things I need answers to before I can name it, write a one-liner, or pick a visual territory. Answer them roughly, in your own words. Wrong-but-decisive beats vague-but-safe: I can pull a fuzzy answer into shape, I can't do anything with "both, depends".

Related: [[Perceptual Harness - making the human the gate]], [[References/Code Review Tools Market]].

---

## 1. Who is the first user you actually picture, and are they buying or smuggling?

There are two very different opening moves. One is the individual senior engineer at a locked-down enterprise (you, at a locked-down enterprise client) who installs it on their own machine, uses their own keys, and never asks anyone's permission. The other is the indie dev or small startup team that wants a nicer review surface and could plausibly pay a card-swipe price. The brand for "smuggled past procurement" is quiet, credible, tool-shaped, almost boring: it must not look like something IT should ask about. The brand for "indie darling" can be loud, opinionated, meme-able.

**Why it matters:** this single choice sets the tone floor and ceiling for everything else. A smuggled tool that looks like a startup product gets flagged; an indie product that looks like enterprise middleware gets ignored on Hacker News.

**Directions:** "enterprise engineer who can't buy anything" / "indie dev who buys their own tools" / "both, but the enterprise engineer is the hero in all the copy".

---

## 2. Is the enemy the PR, the tool, or the fatigue?

Every good positioning has a villain. Candidates here: the 4,000-line AI-generated PR itself; GitHub's review UI (slow, flat, no sense of structure); the cloud review bots that spam comments and get muted; or the reviewer's own exhaustion and the guilt of rubber-stamping. Each villain implies a different personality. Anti-GitHub is combative and gets attention. Anti-fatigue is empathetic and gets loyalty. Anti-bot-spam is the most defensible technically, because it maps directly to the human-stays-the-gate trust model.

**Why it matters:** the villain determines the headline. "Your PRs got 10x bigger. Your review time didn't." is a different company from "Stop rubber-stamping."

---

## 3. How close do you want to stand to the word "AI"?

Right now the category is saturated: [[References/CodeRabbit|CodeRabbit]], [[References/Greptile|Greptile]], [[References/cubic|cubic]], [[References/Baz|Baz]] all lead with AI review. Three viable stances. **Lean in:** "AI code review that runs on your machine", instantly legible, instantly commoditised. **Distance:** never say AI in the headline, sell it as a review tool that happens to be smart, the way [[References/Sublime Merge|Sublime Merge]] sells speed. **Invert:** make the human-in-the-loop the headline and use AI as the supporting mechanic, which is the only one of the three that nobody currently owns well.

**Why it matters:** "AI code review" as a search term is a bloodbath and the tools in it are all cloud SaaS. Distancing is the cheapest way to look different, but costs you the obvious search intent.

**Directions:** lean in / distance / invert ("the reviewer is the model that matters").

---

## 4. Does "local" mean privacy, or does it mean control?

Local-first sells two completely different stories. Privacy: your code never leaves your machine, no vendor sees your repo, no data processing agreement needed. Control: your keys, your model, your harness, your latency, no rate limits, no per-seat tax, works offline on a plane. Privacy is the procurement-killer argument and it is what makes the enterprise engineer's manager say yes. Control is the argument that makes an engineer feel like an owner rather than a tenant, and it ages better as models commoditise.

**Why it matters:** privacy-led branding is defensive and slightly paranoid in tone (dark, locked, "your code stays yours"). Control-led is craftsman-ish and confident (instrument, workbench, your rig). You cannot lead with both.

---

## 5. What is the emotional state you want a burnt-out reviewer to reach 90 seconds after opening a monstrous PR?

Be specific about the feeling, not the feature. Candidates: **relief** ("oh thank god, it's already been sorted into six things I can actually hold in my head"); **command** ("I can see the whole shape of this and I decide where to look"); **calm** ("no red badges, no 47 bot comments, one thing at a time"); **momentum** ("three down, three to go, I'll be finished before lunch"). Relief and calm imply a soft, quiet, generous-whitespace product. Command implies a cockpit or a map. Momentum implies progress mechanics, coverage bars, a finish line.

**Why it matters:** this is the thing the whole product is actually selling, and it drives visual density more than any other answer. It also tells me whether the name should be warm or precise.

---

## 6. What is the unit of review you want people to say out loud?

The core mechanic needs a noun that becomes vocabulary. Right now the working word is "cohort", which is technically accurate and emotionally dead: it sounds like epidemiology or an ed-tech onboarding wave. Alternatives with different flavours: **chapters** (narrative, sequential, implies a reading order and an ending), **passes** (implies you go through the whole thing multiple times, which may be the wrong mental model), **threads** (overloaded), **slices**, **units**, **stacks** (already owned by [[References/Graphite|Graphite]]), **beats**, **rooms**. If the noun is good, people say "let me go through the chapters" and the product name follows it naturally.

**Why it matters:** the mechanic-noun is often a better name source than brainstorming names directly. Whatever wins should probably show up in the product name or the tagline.

**Update after market research:** "cohort" and "layer" are both burned. CodeRabbit shipped Change Stack in May 2026 using exactly those two words for exactly this mechanic. "Stack" is triple-claimed (Graphite, GitButler, Change Stack). See [[References/Code Review Tools Market]]. This question is now more urgent, not less.

---

## 7. Where do you sit on the joke-name to serious-name axis, and what actually makes you cringe?

Dev tool naming has clear camps. Animal/whimsy: CodeRabbit, [[References/Greptile|Greptile]], [[References/mrge|mrge]]. Abstract short words: [[References/Baz|Baz]], [[References/cubic|cubic]], [[References/Hunk|Hunk]], Fork, Tower. Latin/mythology: Sourcery, [[References/Qodo|Qodo]]. Compound-descriptive: Reviewable, Review Board. Given you named your Claude instance Florence after Florence Nightingale, I suspect you like names with a referent and a bit of story behind them, and that you'd hate anything that sounds like it was generated by a domain-availability tool. But I want that confirmed, plus the actual constraints: does it need a clean `.com` or is `.dev`/`.app` fine? Does it need to be a typeable CLI command? Does it need to survive being said out loud in a stand-up at an airline?

**Why it matters:** naming constraints kill more good names than taste does, and I'd rather know the domain and CLI requirements before generating 60 candidates.

**Directions:** give me three existing product names you'd be proud to have made, and three that make you wince.

---

## 8. Is this a product, a project, or a portfolio piece, and when does that change?

Three futures with three different brands. **Personal tool:** it needs no brand at all, just a name you like typing. **Open source with a paid tier:** the brand has to carry a community, a GitHub README that converts, a contribution story, and probably a slightly humbler tone. **Commercial product:** it needs a price, a pitch, a landing page, and a story about why local-first is a business rather than a philosophy. There is also a fourth: **credibility artifact**, a thing that exists to demonstrate to clients and prospective employers that you build serious software, in which case the brand is partly your brand.

**Why it matters:** it decides whether I optimise the name for trademark defensibility, for GitHub-star charisma, or purely for your own enjoyment. Also decides whether we need to worry about the crowded `.com` landscape at all.

---

## 9. What is the honest relationship to [[References/Hunk|Hunk]] and the other tools, and are you willing to say it publicly?

You've described part of this as rebuilding Hunk as a desktop app with large-PR digestibility on top. There is a real positioning choice in how open you are about that. **Explicit heir:** "Hunk's review experience, plus the thing that actually breaks: giant PRs", which is honest, gets you their audience, and risks looking derivative. **Silent divergence:** never mention them, position purely on large-PR digestibility. **Category redefinition:** claim a new category name entirely (the "review harness", the "reading tool for code") so comparison is awkward by construction.

**Why it matters:** comparison-based positioning is fast and cheap but permanently anchors you as the alternative to something else. Category creation is slow, expensive, and the only route to owning a word.

---

## 10. What does the mobile companion do, and does its name have to work on a home screen?

A mobile companion is a strong signal about what you think review is. If mobile is for triage and approval (skim the summary, approve the trivial ones, flag the rest), the brand is about keeping things moving and unblocking teammates. If mobile is for reading (actually going through the chapters on a train), it is a genuinely radical claim that review can be reading rather than typing, and that is a much more interesting story. Also practical: a home screen icon and a 12-character app name are hard constraints that kill a lot of otherwise fine names.

**Why it matters:** "review your PRs on your phone" is either a gimmick or the most memorable thing about the product, depending entirely on which of those two it is. And if there's an icon, I need to know the visual territory now, not after the name is locked.

---

## Bonus, answer only if you have a view

- Is there a colour you'd refuse? (Purple is the AI-dev-tool default and is currently unusable without looking like everyone else.)
- Does the app have a voice in-product, that is, does the LLM narration read as a person, a system, or nothing at all?
- Is there any word you want to own outright? (Digestible, readable, chapters, gate, pass, whole.)

---

## Answers

### Q1: First user, buying or smuggling? (Rai, 2026-08-04)

**Buying.** Someone like Rai: not a vibe coder, an **agentic engineer** who no longer writes code by hand and struggles to grok huge PR reviews. A PR review tool that **respects your time and your expertise**. It doesn't abstract away the code, it removes the effort. **Surfaces the right decisions to you.**

(Coordinator note: this answer leaks into Q3 and Q5. "Respects your expertise" and "surfaces the right decisions" is the inversion stance on AI, and the emotional target reads closer to command than relief. Treat as signal, confirm before locking.)

### Architecture direction given alongside (positioning-relevant)

BYO API keys, BYO endpoints, BYO agent configuration. Multi-harness by design: headless Claude and/or codex-app-server and/or oh-my-pi, so the product benefits from multiple LLMs rather than marrying one. "Your keys" is plural: your harnesses. Should also integrate with Rai's existing review tooling.

### Q13: Whose PRs? (Rai, 2026-08-04)

**Both.** Own agent's output pre-PR and teammates' PRs post-PR. The full loop: accepts competing with [[References/Hunk|Hunk]] pre-commit while building the PR side Hunk doesn't have.

### Signals given alongside (Rai, 2026-08-04)

- **"Review harness" is a term he'd use** ("nice term, yeah for sure"). Pre-seeds Q9 toward category redefinition and feeds naming.
- **Zero-config onboarding North Star:** install, log in with GitHub, all PRs available, and the harnesses already on the machine (Claude Code, oh-my-pi, codex) work with zero config. Setup effort is part of the "removes everything that isn't reading" promise.

### Rapid-fire answers (Rai, 2026-08-04)

- **Q2 (villain): A and B together.** The ceremony AND the signature. Friction is the proof point, exposure is the feeling.
- **Q3 (AI stance): A, invert.** You are the intelligence, models are instruments, disagreement is where you look.
- **Q4 (local means): A, effortless.** Uses the harness already on the laptop and the GitHub login you already have.
- **Q5 (feeling): C.** "I never want to review a PR without this again", or even better, "I never want to SUBMIT a PR for review without this again", plus "this is so much easier to understand!" Indispensability in both directions, and comprehension as the felt benefit. Note: the submit version means the author side carries emotional weight too.
- **Q6 (noun): C, multiple lenses.** The PR should be broken down by 4 or 5 LENSES, of which natural progression / layering is one (the chapters), decision points another, and a few more TBD. Not one decomposition: several concurrent views of the same changeset.
- **Q7 (naming): A**, referent + story (Florence-style). Constraints: must not collide with anything in this space; domain with a decent TLD available for under $15/year.
- **Q8 (distribution): open source core AND desktop app; PAID mobile companion app.**
- **Q9 (category): A, claim it.** This is a review harness and the copy teaches what one is.
- **Q10 (mobile): both, as a remote control.** Desktop generates the analysis/breakdowns; mobile presents them mobile-first and proxies LLM chat through the desktop app. Also stated as important features: **LLM chat to ask questions about the diff**, and **switching which harness you ask**.

Still open: Q11 (pricing shape, partially implied by Q8), Q12 (disagreement as visible feature), Q14 (agentic engineer in copy), Q15 (extension boundary), Q16 (state handoff gesture).

---

## Positioning Draft v2

Refined against the Q1 answer and the multi-harness architecture direction. Not naming yet: Q6 (the unit-of-review noun) and Q7 (taste and constraints) are still open and both feed the name directly.

### What changed

**The tone ceiling is off.** v1 assumed the smuggling case and pinned the register low: quiet, tool-shaped, must not look like something IT should ask about. "Buying" removes that constraint. This can be a confident product with a real landing page and an opinion.

But confident is not loud. The buyer here is an early-adopter engineer who reads Hacker News and has an active allergy to marketing. The register that works on this person is [[References/Critiq|Critiq]]'s and [[References/Hunk|Hunk]]'s: technically specific, first person, zero metrics theatre. The moment you write "4X faster" you have lost them. Confidence in this segment looks like precision, not volume.

**No-procurement survives, with a different job.** It stops being a smuggling tactic and becomes a purchase property: one person can buy this without a security review, a DPA, or a vendor onboarding form. That is a real and well-understood dev tool motion, and Critiq is already running it at $29 one-time. Keep the property, change the sentence it lives in. It is no longer "sneak it past them", it is "nothing to ask anyone for".

**"Your keys" is now plural and that is a bigger deal than it looks.** Multi-harness (headless Claude and/or codex-app-server and/or oh-my-pi) is not just a portability hedge. Nobody in the market has it. Critiq is BYOK but one provider at a time. Greptile self-hosted is BYO LLM but one configuration. Every cloud tool is single-vendor by construction because the vendor is the product. See the disagreement idea below, which is where this stops being an architecture note and becomes positioning.

### Is anyone speaking to the agentic engineer?

No. Checked against the full market note.

The *condition* is universally acknowledged. [[References/CodeRabbit|CodeRabbit]], [[References/cubic|cubic]], Hunk and [[References/Graphite|Graphite]] all open with some version of "AI made PRs bigger". The *person* is named by nobody.

Closest is Hunk: "review-first terminal diff viewer for agent-authored changesets", "Terminal diffs for humans & agents", and a testimonial reading "Hunk changed the way I write and review code with my agent". Hunk is talking to this person. But it addresses them mid-loop, supervising their own agent in their own working tree, before anything becomes a commit. It is a self-review tool.

CodeRabbit acknowledges the condition and then addresses the tech lead who owns merge velocity, not the engineer doing the reading.

So "agentic engineer" as a named professional identity is genuinely fresh vocabulary. Two cautions before it goes in the copy:

1. **"Agentic" may not age well.** It is 2026 jargon. It could read like "web 2.0 developer" in three years. The identity is durable; the adjective might not be. Worth having a plain-English fallback for the same person: someone who no longer writes most of their code by hand and now spends their day judging code they did not type.
2. **Naming your audience is a commitment.** It flatters the people inside it and locks out everyone else. That is usually correct for a first product and it is a real decision, not a default.

### The three sentences, pressure-tested

His words are close to finished copy. Two of the three halves are load-bearing. Two wobble.

**"Respects your time and your expertise."**

*Expertise* is the whole sentence. It is the sharpest thing in the answer and it is a direct attack on the category's failure mode: bots that explain things you already know, flag nits you already decided about, and treat a principal engineer like a first-week hire. Nobody else says this. Keep it.

*Time* is filler. Every tool in the market claims to save time and four of them claim it in percentages. Cut it or subordinate it.

**"It doesn't abstract away the code, it removes the effort."**

First half: excellent, and more strategically useful than it appears. It is a precise attack on CodeRabbit's Change Stack, which replaces the diff with a guided narrative of summaries and generated diagrams. The implicit promise of that product is that you read the walkthrough instead of the code. Yours is that you still read the code, you just get to read it in a sane order with the right things next to it. That is a genuine, defensible, one-sentence difference from the market leader. Build on it.

Second half: this is where it wobbles, and it wobbles against your own trust model. If the human is the gate, the human has to do real work. You cannot both promise "no effort" and "you are still the one deciding". A burnt-out reviewer who reads "removes the effort" and then opens a 3,000-line PR that still requires two hours of judgement will feel lied to.

What is actually removed is not effort, it is **overhead**: reconstructing the author's order, holding review state across interruptions, hunting for the definition of the thing you are looking at, deciding where to look next. The effort of judgement stays, on purpose, because that is the part you are paid for.

Candidate rewrites, in ascending sharpness:

- "It doesn't abstract away the code. It removes everything that isn't the code."
- "It doesn't do the reading for you. It removes everything that isn't reading."
- "It doesn't abstract away the code, it removes the overhead. The judgement is still yours, because that's the part worth your time."

The second one is the tightest and it recovers "your time" from the first sentence by putting it somewhere it earns its place.

**"Surfaces the right decisions to you."**

Strong, and the noun is doing quiet, important work. The market's vocabulary for the output of review is **findings**, **comments**, **issues**, **severity buckets**, **nitpicks**. All of those are things a bot produces and hands you. **Decisions** is a thing only you can make. The word carries the entire inversion stance by itself, without ever saying "human in the loop".

Flagging hard for Q6: **"decisions" may be the unit-of-review noun, or at least the output noun.** "Here are 47 comments" is what every competitor says. "Here are 6 decisions" is a different product. It is unclaimed in this market and it is the first candidate that has come out of the discovery rather than out of a thesaurus. Do not lock it yet, but bring it to Q6.

### The disagreement idea

Worth raising now because it changes what the product is, not just what it says.

If the app runs multiple harnesses, they will not agree. Right now that reads like a technical problem to reconcile. It might be the feature.

Two models reading the same hunk and reaching the same conclusion is low information. Two models disagreeing is a flare: this is ambiguous, subtle, or genuinely load-bearing, and a human needs to look. That is a mechanically honest way to "surface the right decisions" which does not require trusting any single model's judgement, and it gets better as you add harnesses rather than worse.

It also resolves the tension in the trust model cleanly. The LLMs are not deciding and not being trusted. They are being used as independent instruments whose disagreement is the signal. Consensus gets collapsed and moved out of your way. Conflict gets escalated to you.

Nobody in the market can copy this, because every one of them is a single-vendor cloud product where multi-model would mean paying two vendors for one review. You are not paying for inference, so you can.

This is the strongest thing to come out of today's answer. Treat it as a product question first (does it actually work in practice) and a positioning question second.

### Draft one-liner v2

v1 was: *"Large pull requests, broken into things you can actually finish. On your machine, with your keys, no account and nothing to procure."*

That was written for the smuggler. It leads with the procurement dodge, which is now a supporting property rather than the headline, and "things you can actually finish" is a relief promise when the answer points at command.

v2, primary:

> **You stopped writing the code. You still have to answer for it.**
> A review tool for engineers who ship more than they can read. It doesn't abstract away the code, it removes everything that isn't the code, and surfaces the decisions that are actually yours to make. Your harnesses, your keys, your machine.

Alternate, colder and more product-shaped:

> **Review at the size agents write.**
> Large PRs, reorganised into the order they were actually built, with the overhead stripped out and the real decisions surfaced. Runs on your machine, against your own harnesses and keys. No account, no vendor, nothing to procure.

Alternate, sharpest and riskiest, leaning fully on the accountability frame:

> **You are still the one who signs it.**

What is load-bearing in all three, in order:

1. **Accountability.** "You still have to answer for it" and "decisions that are actually yours" is the emotional core and it is completely unoccupied. Everyone else sells to the buyer on velocity and bug counts. Nobody speaks to the engineer who has to put their name on something they did not write and cannot fully hold in their head. That is the actual feeling and it is not fatigue, it is exposure.
2. **"Removes everything that isn't the code."** The anti-Change-Stack line. Your one-sentence difference from the market leader.
3. **"Decisions that are yours."** The inversion stance, carried by a noun instead of a claim.
4. **Plural keys and harnesses.** The moat and, if the disagreement idea holds, the mechanism.

Still deliberately absent: AI, cohorts, layers, stacks, faster, and every percentage.

### Confidence check on the leaked answers

Treating these as signal, not locked, as instructed.

- **Q3 (relationship to "AI")** now looks close to settled on **invert**. "Respects your expertise" and "surfaces the right decisions" only make sense in a frame where the human is the intelligence and the models are instruments. The disagreement idea, if it survives, makes inversion the honest description of the architecture rather than a marketing posture. I would still ask Q3 explicitly, because there is a version of this that leans in loudly on "multi-model" as a spec-sheet feature, and that is a different brand.
- **Q5 (emotional target)** reads **command**, not relief. "Surfaces the right decisions to you" is a cockpit sentence: I can see the whole shape of this and I decide where to look. But the accountability frame above is not command, it is something adjacent and better: **standing behind it**. Worth putting that third option in front of him when Q5 comes round, because it changes the visual direction. Command implies a cockpit or a map. Standing behind it implies a document you can sign.

### New questions this answer raises

- **Q11. Pricing shape.** You are not paying for inference, so you do not need recurring revenue to cover it. That makes a one-time or perpetual-with-updates licence coherent in a way it is not for any competitor, and it lands well with a buyer already paying for Claude Max and Codex who will resent a third subscription. Critiq is at $29 one-time. Is this a $49 to $99 perpetual tool, a subscription, or free-with-a-paid-tier? This is a positioning decision, not a finance one: perpetual says "tool", subscription says "service".
- **Q12. Is the disagreement between harnesses a visible feature?** Product question first. If two harnesses disagreeing is the surfacing mechanism, that is the spine of both the product and the pitch. If it is noise in practice, the multi-harness story stays a portability hedge and the positioning has to lean harder on structure.
- **Q13. Whose PRs is he reviewing?** His own agent's output before it becomes a PR, teammates' PRs, or both? This decides whether you collide with Hunk or complement it. Hunk owns the pre-commit self-review moment. If you are post-PR only, you are adjacent and can even be friendly to it. If you want both, you are competing with a free MIT tool with 8,000 stars on its home turf, and the mobile companion suddenly makes much more sense on the post-PR side only.
- **Q14. Does "agentic engineer" go in the copy, or stay internal?** It is fresh and it is unclaimed. It is also jargon with a shelf life, and it excludes the senior engineer who still writes code by hand but is drowning in reviews of code that was not written by hand. That second person may be the bigger market.
- **Q15. What does "integrates with Rai's existing review tooling" mean for the product boundary?** He mentioned it alongside the architecture. If the app has to interoperate with a personal skill and script stack, that is either a power-user extension story (Hunk has a TypeScript extension API and it is one of its better ideas) or it is a scope leak. Worth deciding early, because "extensible" is a brand position as much as an architecture one.

### Q13 Consequences

Q13 came back **both**. Three things follow.

**1. The honest line on [[References/Hunk|Hunk]]**

> Hunk made local diffs pleasant to read. This makes large changesets possible to decide on, wherever they come from.

The collision is real but narrower than it looked, and it is narrow in your favour. Hunk's weakness is documented in its own issue tracker and it is **scale**: pager mode buffers the entire stream before rendering, peak memory runs about twice the input, and `git log -p` on a monorepo takes 45 seconds against 1.8 for nvim (issue #247). Users are turning it off for large input. Hunk is excellent at small-to-medium changesets and degrades exactly where your entire thesis begins.

Add the second documented gap: agent comments are one-way, and Hunk's own users are in issue #115 asking for the loop you are building (comment anywhere, hand the batch back, get answers in thread). Unbuilt for five months.

So the defensible framing is not "better Hunk". It is that Hunk is a **viewer** and this is a **review system**. A viewer renders a changeset. A review system decomposes it, remembers where you got to, and produces an outcome someone else is waiting on. Hunk does not do decomposition, persistent review state, PR interop, or mobile, and none of those are oversights, they are just not what a pager is.

Do not say any of this publicly in comparative form. Hunk is MIT, free, well-liked, and endorsed by Hashimoto and DHH. Attacking it reads as punching at someone's free gift to the commons. Note also that Hunk's diff renderer comes from Pierre, which you can license the same way (PierreDiffsSwift already wraps it for macOS), so on pure rendering quality you can be peers rather than challengers. The relationship to state publicly, if asked, is that Hunk is a great pager and this is not a pager.

**2. Both strengthens the accountability frame. Materially.**

The frame was already the strongest thing in v2. "Both" makes it symmetrical, and symmetry is what turns a good line into a spine:

- **The code you are about to ask someone to sign off.** Your agent wrote it, your name goes on the PR.
- **The code you are being asked to sign off.** Someone else's agent wrote it, your approval goes on the record.

Same act, both directions, same day, over and over. That is a real description of the agentic engineer's week and no competitor covers both halves. Hunk has the first. CodeRabbit, Scrutiny, Critiq and Remiss have the second. Nobody has the loop.

It also kills the strongest objection to a post-PR-only product. If you shipped only the review side, this user would run Hunk for half their day and you for the other half, with two sets of keybindings, two review-state models, and two harness configurations. Whichever tool is weaker on any given day loses the habit. Owning both means one tool, one muscle memory, one place your state lives. Consolidation is a genuine argument and it only exists because the answer was both.

The dilution risk is real but it is a **sequencing** risk, not a positioning one. Two entry points, two state models, two auth paths, and a much larger v1. Positioning stays unified by the accountability frame and by the changeset abstraction underneath. Ship order is a separate conversation and should not be allowed to reopen this one.

**3. The best feature idea in the discovery so far falls out of this**

If both modes share a review-state model, the review you did of your own changeset **before** opening the PR can become the guided route you hand your reviewer. The decisions you already made, the order you found, the things you checked, all travel with the PR.

That is a compounding property inside a local-first tool, which is supposed to be impossible. It is also the most honest possible answer to "why is this PR 3,000 lines": because the author already did the work of making it readable, and here is the route. Flag for the product conversation, it may be more important than anything in this note.

**4. Vocabulary: changeset stays internal, PR stays in the copy**

The architecture principle (the unit of input is a changeset, a PR is one source of changesets) is load-bearing and correct. It is what makes both modes one product instead of two features. Keep it as the internal noun and let it drive the data model.

Do not put it in the copy.

- "Changeset" is Mercurial, Sapling and Perforce vocabulary. To a GitHub-native buyer it reads as slightly foreign and slightly cold.
- Hunk already uses it ("agent-authored changesets"). It is their register and it carries terminal-tool connotations you do not want.
- "PR" is the word the buyer uses, thinks in, and searches for. A headline gets five seconds.

Express the generality as a phrase instead of a term: **"before you open the PR, and after someone else opens theirs."** Same claim, plain English, and it does the both-modes work in one line.

**Effect on one-liner v2:** the headline survives untouched and gets stronger, because it never said PR in the first place.

> **You stopped writing the code. You still have to answer for it.**
> A review tool for engineers who ship more than they can read. Before you open the PR, and after someone else opens theirs. It doesn't do the reading for you, it removes everything that isn't reading, and surfaces the decisions that are actually yours to make. Your harnesses, your keys, your machine.

The alternate **"You are still the one who signs it"** improves the most. With both modes in scope it now carries two true readings at once: you sign your own work, and you sign off theirs. That is the kind of double meaning you cannot manufacture, and it is worth protecting when Q6 and Q7 come round.

**One new question.** Does review state cross the pre-PR to post-PR boundary automatically, or is publishing your self-review an explicit act? Automatic is magic and slightly alarming. Explicit is a deliberate moment that could become the product's signature gesture. This is a product decision with real brand consequences, and it is worth asking before naming rather than after.

---

## Rapid-Fire Options (Q2 to Q10)

Two real directions per question. Answer "2A, 3B, 4C: ..." and use C freely.

**Q2. The villain the brand fights**
A: The ceremony. Everything sitting between opening a PR and actually understanding it: the setup, the config, the tab-switching, the scrolling, the rebuilding of an order the author never gave you.
B: The signature. The moment you approve something you do not fully understand, and the quiet dread of owning it afterwards.

**Q3. Distance from the AI category**
A: Invert. You are the intelligence, the models are instruments, and where they disagree is where you look. The words "AI code review" never appear.
B: Lean in, but on plurality. "Runs on every model you already pay for, at once." Own multi-model as the one spec-sheet claim a single-vendor cloud tool structurally cannot match.

**Q4. What local first actually means**
A: Effortless. It uses the harness already on your laptop and the GitHub login you already have. Nothing to configure, nothing to procure, nothing to explain to anybody.
B: Yours. Your keys, your models, your machine, no vendor sitting between you and your code. Ownership, not convenience.

**Q5. The feeling ninety seconds in**
A: Standing behind it. You think "I can put my name on this", and the whole surface feels like a document you would sign.
B: Command. You think "I can see the whole shape of this and I decide where to look first". A map, not a document.

**Q6. The unit of review noun**
A: Decisions. The PR resolves into a handful of calls only you can make. Six decisions, not forty-seven comments.
B: Chapters. The PR resolves into an ordered reading with a beginning and an end, and you finish it the way you finish a chapter.

**Q7. Naming taste and hard constraints**
A: A name with a referent and a story behind it, the way Florence is named after Nightingale. You explain it once and never again.
B: A plain word taken straight from the act of reviewing, said flat and unglamorous, the way Hunk and Fork are. No story, just the right word.

**Q8. Product, open source, or portfolio**
A: A paid product at a one-time price, sold to individuals who buy their own tools. No seats, no subscription, no sales call, because you are not paying for inference.
B: Open source core with a paid desktop app on top. The engine earns trust and stars in public; the app you actually live in is what you pay for.

**Q9. Category stance and Hunk relationship**
A: Claim the category. This is a **review harness**, a new kind of tool, and the copy teaches people what one is. Comparison to anything else becomes awkward by construction.
B: Use "review harness" as plain description, not a banner. Lead with the exposure and the accountability, and let the term do quiet work further down where the people who get it will get it.

**Q10. What the mobile companion does**
A: Reading. You genuinely work through the PR on a train and arrive having done it, which would be the most memorable claim in the product.
B: The gate. Triage the queue, approve the trivial, flag what needs a desk, unblock people from anywhere. The real reading stays on the laptop.

---

## Positioning V3

All ten answered. This is the reconciliation.

### Reconciling the two villains

My v2 worry was that picking ceremony (2A) and effortlessness (4A) would demote accountability to supporting material. It does not, because the two operate at different layers and one explains the other.

**Exposure is the stake. Ceremony is what you kill. Effortlessness is the proof you killed it.**

The reason friction is intolerable here is not that it is annoying. It is that it is expensive. Every minute spent reconstructing the author's order, re-finding your place, hunting a definition, or configuring a tool is a minute of attention taken from the one thing you will actually be held to, which is the judgement. Ceremony is not a nuisance, it is a tax levied on the only part that matters.

That gives a clean hierarchy for the copy. Lead on what is at risk. Attack the ceremony. Let the zero-config onboarding be the evidence, because a tool that demands setup before it will help you read is committing the exact crime it claims to fix.

### The felt benefit is comprehension, and the outcome is indispensability

Q5 came back as neither relief nor command. Two separate things:

- **"This is so much easier to understand"** is the felt benefit in the moment. Comprehension, not calm and not control.
- **"I never want to review a PR without this again"** is the outcome. Indispensability is the success metric, and it is a different brief from making someone feel a particular way in ninety seconds. Indispensability comes from three things: it is genuinely better, your state lives here, and going back is visibly worse. State-lives-here is the moat, and it is the one a competitor cannot copy quickly.

### The author side is the wedge

The most consequential half of the Q5 answer is the second one: *"even better, I never want to SUBMIT a PR for review without this again."*

That reorders the go-to-market. The reviewer side gets used when somebody asks you to review something. The author side gets used **every single time you ship**. Frequency is what builds a habit, and habit is what makes a tool indispensable. The author side is also where the compounding feature from the Q13 work lives: the self-review you did before opening the PR becomes the route you hand your reviewer.

So the honest sequencing is that the author mode is the wedge and the reviewer mode is the payoff. That does not change the positioning, which stays symmetrical, but it should change what gets built first and which screenshot goes at the top of the page.

### "Lenses" is burned, and worse than burned

Checked. The word is thoroughly claimed in this exact space:

- **Mantish** (mantish.dev) leads with the literal line *"One change, three lenses"*, structure, diagram and semantic views over a diff.
- **diffelens** is an AI PR review orchestrator with configurable lenses that runs **Claude Code, Codex CLI and Gemini CLI per lens**. That is the multi-harness idea already shipped.
- **Caliper** (getcaliper.dev) ships "Focused Review Lenses" as domain-expert passes.
- **Storybloq/lenses** is a multi-lens review MCP server with 8 parallel reviewers.
- **diffgazer** has five review lenses. **adamsreview** has seven, with a Codex ensemble mode.

Two conclusions, and they point in opposite directions.

**The word is dead.** Do not use it in the product or the copy. It now reads as a 2026 commodity feature.

**The idea is not, because everyone means something different by it.** Every tool above uses "lens" to mean a *reviewer persona*: a security pass, a performance pass, a correctness pass. Different **questions** asked of one diff. Rai's answer means a *decomposition of the changeset*: narrative progression, decision points, and three or four more. Different **shapes** the same diff can be poured into. Nobody is doing that, and the distinction is sharp enough to survive contact with a competitor.

It also thins the multi-harness moat I claimed in v2. diffelens already runs three harnesses. What it does not have is a desktop app, review state, PR interop, mobile, or decomposition. The moat is the combination, not the harness plurality on its own.

Two candidate replacement words, to settle alongside the name rather than before it:

- **Readings.** Textual-scholarship vocabulary, matches the naming territory, and "four readings of this change" is plain English.
- **Projections.** Cartographic. The same terrain, several projections, each one true and each one distorting differently, and you pick the one that serves the question. It is the more honest metaphor because it admits no single view is complete, which is the inversion stance in a noun.

### The category paragraph

Q9 was a claim, so the copy has to teach the term. This is the paragraph that does it:

> A coding harness points a model at your codebase so it can write. A review harness points models at a change so you can read. The harness does the structural work. You do the deciding.

### One-liner v3

**Headline**

> You stopped writing the code. You still have to answer for it.

**What it is**

> A review harness. It takes a change too big to hold in your head, gives you several honest ways to read it, keeps your place between sessions, and surfaces the calls only you can make. Before you send a PR, and after somebody sends you one.

**Proof**

> Install it, sign in with GitHub, done. It drives the coding harnesses already on your machine. Nothing to configure, nothing to procure, no account anywhere except yours.

Three blocks doing three jobs: stakes, product, evidence. The proof block is where effortlessness lives, and it is deliberately last, because it is the argument that makes the first two credible rather than the reason anyone shows up.

Still absent on purpose: AI, lenses, cohorts, layers, stacks, faster, and every percentage.

---

## Naming Round 1

Pattern: referent with a real story, Florence-after-Nightingale. Constraints applied: no collision in the dev or code-review space, CLI-typeable, survives being said out loud in a stand-up, twelve characters or fewer for a home screen, and a domain under $15/year, which in practice means `.dev` or `.com`.

Availability was checked by RDAP lookup on 2026-08-04, not by guessing. `AVAILABLE` means the registry returned a 404. This is a strong signal but not a purchase guarantee, and premium-tier pricing is not visible through RDAP, so treat any single name as "verify at the registrar before committing". Nothing was registered or purchased.

### Longlist

**Optics: making the invisible visible, several views of one thing**
Fresnel (the lighthouse lens that carried light over the horizon) · Alhazen (Book of Optics, invented systematic verification) · Hartmann (lenslet array sampling one wavefront; the disagreement between samples reveals the distortion) · Schlieren (imaging that renders invisible density gradients visible) · Ronchi (grating test that exposes flaws in a mirror surface) · Foucault (knife-edge test for the same) · Amici, Porro, Nicol (prisms) · Snellen (the eye chart: can you actually read this) · Ishihara (plates where the pattern is invisible without the right vision) · Abbe (the resolution limit) · Dollond (achromatic lens, removes colour fringing) · Reticle (the crosshair that tells the eye where to look) · Vernier and Nonius (precision by comparing two scales against each other) · Parallax (depth from two viewpoints) · Moire (the interference pattern that exposes misalignment) · Collimator · Camera Lucida

**Textual scholarship: guided reading, layered commentary, verified copies**
Hexapla (Origen's six parallel columns of one text) · Rashi (the commentary layer that made the Talmud navigable) · Tosafot (the second layer, which argues with the first) · Colophon (the maker's mark at the end of a book) · Scholia · Glossa · Accursius (wrote the Glossa Ordinaria, the standard apparatus that made Roman law readable for centuries) · Marginalia · Incipit · Rubric and Rubricator (the red guides added so a reader could navigate) · Quire (the gathering of leaves, also called a signature) · Recension (a revision built by comparing sources) · Collation (comparing witnesses, which is diffing) · Stemma and Lachmann (reconstructing the family tree of variants) · Variorum (the edition carrying all the variant readings) · Apparatus · Exemplar (the master copy every copy is checked against) · Catchword (the word at the foot of a page that lets the binder verify the order) · Capitula and Kephalaia (the chapter list added so long texts could be navigated) · Pericope (a passage marked out to be read as one unit) · Diorthotes (the scriptorium's professional corrector) · Alcuin (whose scriptorium introduced word spacing and punctuation) · Cassiodorus · Isidore · Jerome · Eusebius (invented the canon tables, cross-referencing four parallel accounts) · Imposition (arranging pages so they read in the right order once folded) · Aldus · Verso · Lector

**Cartography: making terrain legible**
Minard · Ortelius (bound many maps into the first atlas) · Beck (the tube map: legibility through abstraction) · Playfair (invented the bar chart) · Bertin (the theory of visual variables) · Cairn (route markers built by everyone who passed) · Contour · Astrolabe (layered plates, many views of one sky) · Sextant · Pharos · Mercator · Graticule · Chorography · Waywiser

**Certification and safety: standing behind it**
Plimsoll (the load line) · Loadline · Freeboard · Assay (the test before the hallmark) · Touchstone (the stone that reveals the purity of gold) · Signet · Imprimatur · Proofmark and Proofhouse (where a thing is tested and stamped before sale) · Roebling · Vitruvius · Keystone

### Cut, with reasons

**Hard collision in the dev space, do not use:** Ortelius (an active CD Foundation project at ortelius.io doing software supply chain intelligence) · Alhazen (a Chan Zuckerberg Initiative AI agent, plus alhazen-py, plus a Claude Code fork) · Prism, Codex, Keystone, Aldus, Waypoint (all long gone).

**Domain gone on both `.dev` and `.com`:** Plimsoll, Hexapla, Colophon, Minard, Stemma, Astrolabe, Bertin, Scholia, Incipit, Glossa, Cairn, Assay, Fresnel, Hartmann, Quire, Playfair, Marginalia, Reticle, Graticule, Vernier, Nonius, Parallax, Exemplar, Moire, Proofmark, Proofhouse, Waywiser, Catena, Lachmann, Variorum, Freeboard, Ronchi, Vitruvius, Roebling, Lector, Isidore, Jerome, Bede, Erasmus, Michelson, Tycho.

**Cut on ergonomics:** Accursius (says "accursed" out loud, which is fatal) · Schlieren, Ishihara, Lippershey (spelling) · Foucault (philosopher baggage) · Imprimatur, Cassiodorus, Chorography (length) · Touchstone (generic business English) · Beck, Contour, Mercator (too common to own).

### Shortlist

All confirmed available on `.dev` by RDAP on 2026-08-04. Confidence is about brand risk, not registry state.

| Name | Chars | The story in one line | Risk | Confidence |
|---|---|---|---|---|
| **Alcuin** | 6 | His scriptorium put spaces between words and made silent reading possible | Alcuin Software, a French HR and education SaaS, holds alcuin.com. Different sector, no dev-tool overlap | High |
| **Catchword** | 9 | The word at the foot of a page that lets the binder verify the order before sewing | Also colloquially means "buzzword", a second meaning that fights the brand slightly | High |
| **Loadline** | 8 | The mark on a hull that says whether it is safe to sail, before it sails | Descriptive compound rather than a proper name, so weaker on the Florence pattern. "Load" is overloaded in software | High |
| **Capitula** | 8 | The chapter list added to a manuscript so a reader could find their way | Sits one phoneme from "capitulate", which is a bad association for a tool about standing behind things | Medium |
| **Pericope** | 8 | A passage marked out to be read as a single unit | Nobody can pronounce it on sight, which fails the stand-up test | Medium |
| **Diorthotes** | 10 | The scriptorium's professional corrector, who checked every copy against the exemplar | The literal ancient job title for code reviewer, and almost unsayable | Medium |
| **Rubricator** | 10 | The scribe who added the red marks that told a reader where to look | Ten characters and slightly clinical | Medium |
| **Eusebius** | 8 | Invented the canon tables, letting a reader see four parallel accounts side by side | Strong religious-historical association that may not be wanted | Medium |
| **Recension** | 9 | A text rebuilt by comparing every surviving witness | A common noun rather than a referent, so there is no story to tell once | Medium |
| **Kephalaia** | 9 | The chapter divisions added to ancient manuscripts | Spelling and pronunciation both hard | Low |
| **Snellen** | 7 | The eye chart: can you actually read this | Optometry association is strong and slightly comic | Low |
| **Rashi** | 5 | The commentary layer printed around the text that made the Talmud navigable | Naming a commercial dev tool after a revered religious figure carries real appropriation risk. Flagged deliberately rather than quietly dropped | Low |

### Top three, with the story

**1. Alcuin**

Alcuin of York ran Charlemagne's palace school and its scriptorium. Under him the Carolingian scribes standardised a new hand and did something that sounds trivial and was not: they put spaces between words, added punctuation, and separated capitals from lowercase. Before that, Latin ran as an unbroken stream of capitals, and reading meant sounding it out aloud until it resolved into sense. Alcuin's reforms are the reason silent reading is possible. He did not change a word of any text. He changed how it sat on the page, and every reader since has been faster for it.

That is the product in one paragraph, and it is the best available match for the Florence pattern: a real person, one sentence, explained once and never again.

Category copy underneath: *Alcuin is a review harness. A coding harness points a model at your codebase so it can write. A review harness points models at a change so you can read. It does the structural work. You do the deciding.*

**2. Catchword**

In a hand-bound book, the printer sets at the foot of every page the first word of the page that follows. It is called a catchword. The reader never notices it and it is not for them. It is for the binder: when the sheets are gathered and folded, he runs his eye down the pile and knows at once whether everything is in the right order, while it is still cheap to fix.

That is what the tool does with a large change. It works out what follows what, and shows you the whole thing is in an order that makes sense before you commit to it. It is also plain English, which makes it the easiest of the three to say, type and remember.

Category copy underneath: *Catchword is a review harness: it drives the coding harnesses already on your machine to lay a change out in an order a person can actually read, then gets out of the way so you can decide.*

**3. Loadline**

Samuel Plimsoll spent the 1870s fighting shipowners who overloaded rotting ships, over-insured them, and sent them out knowing the crew would probably drown. He won, and the result is the load line: the mark painted on every hull showing how deep it may legally sit in the water. Anybody standing on the dock can read the mark and know whether the thing is safe to sail, before it sails.

For a product about pull requests that have been loaded past what any human can carry, that is almost too neat. It is also, unusually, a story about a man who refused to let people sign off on things they knew were unsafe, which is the accountability frame in its purest form.

Category copy underneath: *Loadline is a review harness. It reads the change before you do, shows you how much is really in there and where the weight sits, and leaves the call to you.*

Weakest of the three on the Florence pattern, because the name is descriptive and the referent has to be told rather than looked up. Strongest of the three on the exposure frame.

### Open before locking a name

- Whether the decomposition word is **readings** or **projections**, since it will appear beside the name constantly.
- Whether "agentic engineer" survives into the copy (Q14, still unanswered).
- Registrar check on the finalist for premium pricing, plus GitHub org and npm availability, none of which RDAP shows.

### Handle check on the top three (2026-08-04)

| Name | `.dev` domain | GitHub org | npm package |
|---|---|---|---|
| Alcuin | free | **taken** | free |
| Catchword | free | free | free |
| Loadline | free | **taken** | free |

`catchword` is the only one of the three where the domain, the GitHub organisation and the npm name are all unclaimed. Given Q8 puts an open source core at the centre of distribution, an unavailable GitHub org is a real cost rather than a cosmetic one.

---

## Naming Round 2

Round 1 (Catchword, Alcuin, Loadline) did not sing. Wingman was set as a placeholder. This round takes Wingman as a taste signal and works out what it is actually asking for.

### Verdict on Wingman: dead, and comprehensively

| Asset | Status |
|---|---|
| wingman.dev | taken |
| wingman.com | taken |
| wingman.app | taken |
| GitHub org `wingman` | taken |
| npm `wingman` | taken |

Product collisions, all live:

- **Wingman** (YC S18), sales conversation intelligence, acquired by Clari in 2022 and now shipping as **Clari Copilot**. The original owner of the name in software.
- **thewingman.io**, a real-time AI sales coach.
- **rethem.ai Wingman**, live in-call sales prompts.
- **Fayrix Wingman AI**, a generative assistant whose own marketing lists code review as a use case.
- **wingman.pm**, AI product intelligence for builders, strapline *"You Fly the Product. We Cover Your Six."* That is the closest one: adjacent developer and product tooling, same aviation framing, already deployed.

There is nothing to salvage. The name is taken at every asset and the aviation-companion metaphor is crowded, which is what happens to a territory after Copilot.

### What Wingman is actually telling us

The useful part is not the word, it is the diagnosis of why round 1 failed.

Decompose the payload: you are not alone; they watch the part you cannot see; they never fly your plane; they share the consequence; and the register is informal and slightly cool rather than learned.

**Round 1 named the artefact. Wingman names the relationship.** Catchword, Alcuin and Loadline are all names for a clever object or a dead scholar. Not one of them says "somebody is here with you and they are on the hook too". That is the whole miss, and it is a bigger miss than any individual word choice.

So the brief for round 2: keep the relationship, change the vehicle, because aviation is spoken for.

The best remaining vehicle is **rally**. A rally co-driver reads the road aloud before the driver can see it, corner by corner, from notes written on a reconnaissance run. The driver commits at speed on somebody else's description of a bend they cannot yet see, and if the notes are wrong they go off together. That is closer to the product than a wingman is, because the co-driver's actual job is reading ahead out loud, and the notes are a decomposition of terrain into a sequence you can act on. Which is angles and chunks, in a car.

Second vehicle: **golf**. The caddie walks the course, gives you the yardage and the line, hands you the club, and never takes the shot. You sign your own scorecard. That is the exposure frame with no metaphorical strain at all.

### Shortlist with availability

All checked by RDAP, GitHub API and the npm registry on 2026-08-04. Nothing registered or purchased. Note that GitHub handles for ordinary English words are almost universally squatted by dormant accounts, so the table distinguishes a dormant squat (workable, use a scoped org) from an active project (fatal).

| Name | `.dev` | GitHub | npm | Verdict |
|---|---|---|---|---|
| **Pacenote** | free | dormant org, 0 repos, 2023 | free | One adjacent collision: a GitHub repo `PaceNote` doing AI software-delivery orchestration for VS Code and Copilot. Obscure personal project, not a product. Manageable |
| **Yardage** | free | dormant org, 1 repo, 2021 | free | No dev-space collision found. Clean |
| **Codriver** | free | dormant user, 1 repo, 2013 | free | No product collision found, but see the "Co-" problem below |
| Pacenotes | free | dormant org | free | Plural variant of the above |
| Firstread | free | dormant org, 0 repos, 2022 | free | Generic, and a vibe-coded FirstRead news product exists |
| Readfirst | free | not checked | not checked | Plainer inversion of the same idea |
| Secondpair | free | **free** | taken | "A second pair of eyes." Contradicts the inversion stance by casting the tool as the reviewer |
| Undersign | free | taken | taken | Plain accountability, weak assets |
| Sidecarman | free | **free** | free | Only true clean sweep in the round, and clunky to say |
| Readahead | free | taken | taken | Nice double meaning with the computing term, weak assets |
| ~~Talkdown~~ | free | dormant | free | **Cut.** talkdown.cc is a live voice-notes product and `Koranir/talkdown` is a Codex-powered editor |
| ~~Freshpair~~ | free | free | free | **Cut.** Freshpair.com is a well-known underwear retailer. Assets are perfect, association is fatal |

Also swept and gone on `.dev`: belay, onbelay, caddie, cornerman, coxswain, backstop, lookout, crowsnest, roadbook, understudy, spotter, navigator, recce, wingtip, vouch, surety, warrant, attest, endorse, countersign, signoff, holdfast, vouchsafe, standby, marshal, lintel, joist, spine, bearing, sightline, eyeline, legible, proofread, lookahead, runthrough.

The plain single-word English space is effectively exhausted at `.dev`. Everything clean from here is either a compound or an unusual word.

### Top three, with the story

**1. Pacenote**

On a rally stage the driver cannot see the corner coming. The co-driver can, because they walked the road beforehand and wrote it down: the severity of the bend, which way it goes, what is over the crest, where it tightens. They read it aloud, one note at a time, a few seconds ahead of the car. The driver commits at speed to a description of a road they have not seen yet. If the note is wrong they both go off.

That is the product. Somebody goes over the ground first, breaks it into a sequence you can act on, and reads it to you just before you need it. You still drive. You still own the result.

It also gives you the vocabulary for free: a pace note is short, it arrives in order, it is about what is coming rather than what happened, and nobody has ever wanted a pace note to be eloquent. That is the anti-AI-prose position the validation research demanded, baked into the name.

Category copy underneath: *Pacenote is a review harness. It reads the change before you do, breaks it into what is actually coming, and calls it out one piece at a time. You still make every call.*

**2. Yardage**

A caddie walks the course before you play it. On the tee they tell you the number: distance to the pin, what the wind is doing, where the trouble is, which club. They will tell you the line. They will not take the shot, and at the end of the round you sign your own scorecard, and if the number on it is wrong that is on you, not them.

The whole accountability frame is already inside the sport. Golf is one of the few games where the player is the referee and signing an incorrect card disqualifies you. A tool named after the caddie's number is a tool that says: here is everything you need to make the call, and the call is yours.

Cleanest assets in the round. The risk is register, since golf carries connotations that may not fit the audience, and "yardage" is slightly inert as a noun.

Category copy underneath: *Yardage is a review harness. It walks the change first and gives you the numbers that matter, so the only thing left is the decision.*

**3. Codriver**

The same rally story as Pacenote, told through the person instead of the artefact, which is the more direct answer to the Wingman signal since the taste lesson was to name the relationship.

The problem is the prefix. Post-Copilot, "Co-" reads as a Copilot derivative at a glance, and this product's entire positioning is an inversion of the copilot idea rather than a version of it. Naming it Codriver invites exactly the comparison the positioning is trying to refuse. Strong story, clean assets, wrong first syllable.

Included because the story is right and Rai may weigh the prefix problem differently, but Pacenote gets the same world without the baggage.

### Open

- Whether the register should be sport at all. Rally and golf are both warmer than round 1, but they are still metaphors. There is an unexplored plainer option: name it after the act, not the helper.
- If Pacenote wins, the `PaceNote` GitHub repo should be looked at directly before committing, to confirm it is dormant rather than early.
- Registrar check on the finalist for premium `.dev` pricing, which RDAP does not expose.

---

## Naming Round 3

Round 1 named the artefact. Round 2 named the relationship. Neither sang. Round 3 names the act.

Reading the three rounds as a trajectory: what keeps failing is indirection. A scriptorium object and a rally co-driver are both things you have to travel through to reach the product. The act is the product, with no vehicle in between.

### On the e-signature collision field

Swept it first, because it eats the obvious half of the territory. Every plain "sign" word is gone at `.dev`: signoff, endorse, attest, vouch, warrant, surety, countersign, signhere. Undersign survives on `.dev` but its GitHub and npm are both taken. DocuSign, SignWell, HelloSign, SignNow and Dropbox Sign own the space above them.

There is a clean route through it, and it comes from noticing what those companies are trying to sound like. They all want to sound frictionless and modern, so they have collectively abandoned the actual legal register of signing. Nobody in that field is going to name a product after the phrase that appears immediately above the signature line on a deed. That leaves archaic-legal phrasing wide open, and it happens to suit a product whose whole claim is that the human, not the machine, is the one who commits.

### Shortlist with availability

RDAP, GitHub API and npm registry, all checked 2026-08-04. Nothing registered. Dormant GitHub squats are distinguished from active projects.

| Name | `.dev` | GitHub | npm | Honest read |
|---|---|---|---|---|
| **Hereunto** | free | **free** | **free** | Best assets in the round (`.app` free too). The word immediately before a signature. Genuinely good |
| **Holdsup** | free | **free** | **free** | "Does it hold up." Plain, confident, no metaphor. Good, not great |
| **Yourcall** | free | dormant org, 0 repos, 2024 | free | Says the positioning in two words. Best fit, weakest differentiation |
| Thesayso | free | **free** | **free** | Clean sweep, but "the" prefix fights the CLI and the register is too casual |
| Poreover | free | **free** | **free** | Clean sweep, and it names the labour the product removes. Cut on meaning, not assets |
| Sethand | free | dormant user, 0 repos | free | From "set my hand". Opaque without the legal gloss |
| Nameonit | free | dormant user, 1 repo | free | Clear, accountable, parses slightly juvenile |
| Buckstop | free | dormant user, 0 repos | free | Right idiom, jokey delivery, money connotation |
| Weighin | free | dormant org, 1 repo | free | Generic, and the boxing sense pulls the wrong way |
| Holdwater | free | dormant user, 2 repos | free | Same family as Holdsup, more plumbing |
| Standbehind | free | dormant user, 0 repos | free | Literal to the point of flat, and eleven characters |
| Thenod | free | dormant user, 2 repos | free | Too slight to carry a product |
| Avouch | free | dormant user, 0 repos | **taken** | Reads as a typo of "vouch" |
| Myhand / Setmyhand | free | dormant | taken / free | Weaker versions of Sethand |
| Duecare, Behindit, Hereunto variants | free | mixed | mixed | Filler, listed for completeness |

Swept and gone at `.dev`: signoff, endorse, attest, vouch, warrant, surety, countersign, sayso, callit, myword, onceover, wetink, answerable, reckoning, goodfaith, vetted, greenlit, ownit, redpen, bluepencil, byhand, goahead.

`byhand` deserves a mention as the one that got away. "By hand" means done by a human rather than a machine, which is the entire thesis, and both `.dev` and `.com` are taken.

Collision sweep on the three leaders found nothing named Hereunto, Holdsup or Yourcall in the developer or AI tooling space. One caveat on Yourcall: the review space already contains **Callout** (an AI code review MCP that describes itself as "the second pair of eyes") and **Callstack.ai** (code reviewer). Yourcall would be moving into a street where two call-family review tools already live.

### Top three, with the story

**1. Hereunto**

"In witness whereof I have hereunto set my hand."

That is the phrase, and it is the only place the word still lives. Hereunto means "to this thing", and its entire surviving use in English is the sentence you write immediately before you put your name on a document and become answerable for it. It is not a word for a signature. It is the word for the moment before the signature, when the thing is read and understood and not yet signed.

Which is the product. Everything this tool does happens in that gap. It does not sign for you and it does not write the code. It works in the space between finishing the reading and putting your name to it, and the whole design goal is to make that gap survivable.

It also walks straight past the e-signature field, because the entire DocuSign generation is trying to sound modern and frictionless and would never reach for a word that sounds like a deed. And it is a legal referent for someone who came to software through law, which is the Florence pattern working properly: personal, real, explained once.

Assets are the strongest in three rounds: `.dev` free, `.app` free, GitHub organisation free, npm free.

The honest risk: nobody knows the word on sight. It passes "explained once and never again" and fails "instantly graspable", and those are different tests. Eight characters, types cleanly, says cleanly (here-UN-too).

Category copy underneath: *Hereunto is a review harness. It does the structural work on a change too big to hold in your head, and stops exactly where your judgement starts. You stopped writing the code. You still have to answer for it.*

**2. Holdsup**

"Does it hold up?"

That is the question a reviewer is actually asking, in the words they actually use, and it is the only question the product exists to answer. No metaphor, no vehicle, no referent to explain. The change either holds up under someone looking at it properly or it does not, and the tool's job is to make looking at it properly possible.

It is also quietly the accountability frame, because "holds up" is what you are implicitly claiming when you approve something. You are not saying it is perfect. You are saying you looked, and it holds.

Clean sweep on `.dev`, GitHub and npm.

The honest risk: this is the safe one rather than the exciting one. "Hold up" also means "stop" and "rob", and set in lowercase as a single token `holdsup` reads a little awkwardly, better as HoldsUp. It is good. It is not the one anyone will remember in a year.

Category copy underneath: *HoldsUp is a review harness. It breaks a change into what you can actually read, shows you where the weight sits, and leaves you to decide whether it holds.*

**3. Yourcall**

"Your call."

Two words that contain the entire positioning. The models did the structural work, the angles are laid out, the decisions are queued, and the last thing the product says before it gets out of the way is: your call. It puts the user in the sentence without any of the cringe that usually comes with first-person or imperative naming, because it is a thing people already say to each other and always in exactly this situation, when someone competent hands the judgement back to the person who owns it.

The honest risk, and it is bigger than it first looks. The "Your-" prefix is a slightly dated pattern. The `.com` is gone and the GitHub organisation is squatted, so it is the weakest asset position of the three. And it moves into a neighbourhood that already has Callout and Callstack.ai doing code review, which blunts the differentiation of the one thing it does best, which is sounding distinct.

Category copy underneath: *Yourcall is a review harness. It reads the change first, lays out what is actually being decided, and then does the only honourable thing a tool can do at that point.*

### Honest summary

Only three of these are worth Rai's time, and one of them is clearly ahead. **Hereunto** is the only candidate in three rounds where the word, the assets, the personal referent and the positioning all point the same way, and its single weakness (unfamiliarity) is the one weakness a good story fixes. **Holdsup** is the safe pick and would embarrass nobody. **Yourcall** is the one that reads best on a landing page and worst on a trademark search.

Everything else in the table is available rather than good, and the distinction matters more than the length of the list.

### Open

- If Hereunto wins: check `hereunto.app` as the primary rather than `.dev`, since the app is the product and `.app` is free.
- Trademark search on the finalist, which none of this covers.
- Whether the word being unfamiliar is a feature (nobody else has it, it forces the story) or a tax (every conversation starts with a spelling).

---

## Naming Round 4 (Rai's register)

### The taste data, verbatim

> "Pace note is the wrong vibe. Here are the names I was running through in my head: Wingman (like a copilot), diffmonkey or just monkey (monkeys swing from branches), or Committed / Commitment (git commits and a commitment to code quality) or something that relates to the fact this makes diffs more digestible (Enzyme, or something like Limoncello or an actual digestif)."

Reading the model off that list: playful, warm, punny, dev-vernacular, and every single candidate encodes a real product truth. Branches, commits, digestion, companionship. The pun is load-bearing in all four. Rounds 1 to 3 were all wrong in the same direction, which is that they were serious. [[References/Hereunto|Hereunto]] stays on the table as the serious-register comparison, but it is answering a question he was not asking.

Note the market finding still stands as information: animal and whimsy naming is crowded, [[References/CodeRabbit|CodeRabbit]] and [[References/Greptile|Greptile]] are already there. Taste overrides territory avoidance. The job is to find something clean inside his register, not to talk him out of it.

### His own list, verified

| Name | `.dev` | Other assets | Verdict |
|---|---|---|---|
| **Wingman** | taken | .com, .app, GitHub, npm all taken | Dead, see round 2. Five live products including Clari Copilot and wingman.pm |
| **Diffmonkey** | **free** | **.app free, GitHub free, npm free** | **Clean sweep.** Only one in four rounds. `.com` taken |
| Monkey | taken | n/a | Dead. Chaos Monkey, SurveyMonkey, MonkeyType, monkey-patching. The word is load-bearing in dev vocabulary already, for other things |
| Committed | taken | committedapp.com is a live habit tracker | Dead, and worse, ungoogleable. "Committed" as a search term returns the entire English language |
| Commitment | **free** | GitHub dormant, npm taken | Available and still ungoogleable. Same problem, one syllable longer |
| **Enzyme** | taken | n/a | **Fatally dead.** `enzymejs/enzyme` (originally airbnb/enzyme) is the React testing library every JS developer of a certain vintage used. Unmaintained since roughly 2022, no React 18 adapter, and Airbnb publicly wrote up migrating 3,500 test files off it. Being unmaintained makes it worse, not better: the name is permanently associated and permanently associated with something that died |
| Limoncello | **free** | GitHub dormant (2 repos, 2014), npm free | Live option. `.com` taken |
| Amaro | taken | n/a | Dead. `nodejs/amaro` is the official Node.js TypeScript type-stripping wrapper, on npm as `amaro`. As central a collision as it gets |
| Fernet | taken | n/a | Dead. Fernet is the symmetric encryption spec used across Python and OpenStack tooling |
| Digestif | **free** | GitHub dormant (1 repo, 2016), npm taken | Live option, and the strongest thing on his list. `.com` taken |

Three of his eight are fatally collided with well-known developer infrastructure (Enzyme, Amaro, Fernet), which is what happens when you reach for pharmacology and Italian liqueurs in a field that has already reached for both.

### Generated in his register, verified

RDAP, GitHub API and npm, all checked 2026-08-04. Dormant squat versus active project distinguished. Nothing registered.

**Digestion shelf**

| Name | `.dev` | GitHub | npm | Note |
|---|---|---|---|---|
| **Rennet** | free | dormant, 1 repo | **free** | The enzyme that separates milk into curds and whey |
| Trypsin | free | rate-limited | **free** | Protein-splitting enzyme |
| Protease | free | rate-limited | taken | Same family |
| Pepsin | free | **active user, 65 repos** | taken | Avoid |
| Digest, Morsel, Bitesize, Bitters | taken | | | The obvious ones are gone |

**Digestif shelf**

| Name | `.dev` | GitHub | npm | Note |
|---|---|---|---|---|
| **Nocino** | free | dormant org, 0 repos | **free** | Green walnut digestif |
| **Genepy** | free | dormant, 1 repo | **free** | Alpine herbal digestif |
| Chartreuse | free | rate-limited | **free** | Made by monks who have kept the recipe for four centuries. Also a colour |
| Averna | free | org, 3 repos, 2022 | free | Sicilian amaro, GitHub org looks semi-active |
| Cynar | free | active user, 21 repos | free | Artichoke amaro |
| Braulio | free | active user, 11 repos | free | Alpine amaro, and a common given name |
| Unicum | free | dormant | taken | Hungarian bitter |
| Branca | taken | | | Fernet-Branca |

**Branch-swinging shelf**

Mostly a graveyard. Gibbon, Siamang, Langur, Tamarin, Sifaka and Colobus are all taken at `.dev`. **Marmoset** is dead on collision: Marmoset Toolbag is major 3D art software. **Lemur** is dead on collision: `Netflix/lemur` is a well-known certificate manager. **Brachiate** (the actual verb for swinging arm over arm through branches) is free at `.dev` with a dormant GitHub and free npm, but it is nine characters and nobody can spell it.

**Git-pun shelf**

Bisect, Squash, Amend and Rebased are all taken at `.dev`. **Diffgest** is free at `.dev` with free npm, and the pun could not be more load-bearing, but see the honest note below.

### Shortlist

| Name | `.dev` | GitHub | npm | Pun load |
|---|---|---|---|---|
| **Digestif** | free | dormant | taken (scope it) | Maximum. The pun is the product thesis |
| **Diffmonkey** | free | **free** | **free** | High, and fighting itself. See cringe check |
| **Rennet** | free | dormant | free | High. Separation into components |
| Limoncello | free | dormant | free | Medium. Digestif category, no mechanic |
| Nocino | free | dormant org | free | Medium. Same |
| Genepy | free | dormant | free | Medium. Same |
| Chartreuse | free | unverified | free | Medium, plus a good monastery story |
| Diffgest | free | unverified | free | Maximum, and ugly in the mouth |
| Trypsin | free | unverified | free | Medium. Splits proteins |
| Commitment | free | dormant | taken | High meaning, zero searchability |
| Brachiate | free | dormant | free | High, unspellable |
| Averna | free | semi-active org | free | Medium |

### Top three

**1. Digestif**

The pun is not decoration, it is the thesis restated. A digestif is the thing you take after a meal that was too large, specifically to make it possible to process. The product exists because pull requests got too large to process. There is no strain in the metaphor at all, which is rare, and it is the only candidate across four rounds where the name and the one-line product description are the same sentence.

It also solves the register problem that broke the first three rounds. A digestif is not a cartoon animal and not a Latin manuscript term. It is what adults have after dinner. Warm, a bit indulgent, faintly witty, and completely unembarrassing. That is the exact spot between Wingman and Hereunto.

Bonus: the category gives you the whole product vocabulary for free without any of it being burned. A small measure. Something bitter that does you good. The thing you have after, not during.

Assets: `.dev` free, GitHub handle a dormant one-repo account from 2016, npm taken so the package would need a scope. `.com` is gone.

**2. Diffmonkey**

His own, and the only clean sweep in four rounds of searching: `.dev`, `.app`, GitHub organisation and npm package all free. That is worth a lot and it should be said first.

The pun works on two levels. Monkeys move through branches rather than around them, fast and confidently, because they can see the route. That is git branches and it is a competence claim. And "diff" is sitting right there in the name doing the literal work.

**3. Rennet**

Rennet is the enzyme that turns one undifferentiated white liquid into curds and whey. It does not add anything. It separates what is already there into parts you can actually handle. That is the decomposition mechanic described exactly, and it is Rai's own Enzyme instinct routed around the Airbnb collision.

Six characters, types cleanly, says cleanly, `.dev` free, dormant GitHub, npm free. It is the sharpest mechanic pun in the round.

The honest weakness: rennet is obscure, so the pun only lands after explanation, and it is faintly unappetising in a way Digestif is not. Cheese-making is a less charming referent than an after-dinner drink.

### Cringe check, honestly

**Will it survive an the enterprise client stand-up?**

Digestif: yes. It sounds like a product. Nobody will ask a follow-up question, and if they do, the answer is one sentence and it makes the product obvious.

Diffmonkey: yes, but with a cost. It will get a small laugh every time, and small laughs are a tax on being taken seriously in a room full of airline stakeholders.

Rennet: yes, with a puzzled pause and a spelling.

**Does a liqueur register survive next to "you are still the one who signs it"?**

Real answer: yes for Digestif, and the tension is productive rather than damaging, but only under one condition.

The reason it works is that a digestif is not a joke. It is the ritual at the end of a serious meal, and the register it carries is civilised and adult, not wacky. Compare CodeRabbit, whose cartoon rabbit genuinely does undercut its enterprise claims and forces the blog to work twice as hard to sound credible. A light name over serious machinery is a well-established and effective shape in this industry. The condition is that the visual identity has to be restrained: amber, glass, a thin line, no cartoon bottle and no illustrated barman. Get that wrong and it becomes the rabbit.

**Diffmonkey is the one with a real problem, and it is not the one you would expect.**

The problem is not that it is silly. It is that "code monkey" is the term used to belittle developers, meaning an interchangeable typist who does not think. In dev-tool naming, "monkey" almost always signals dumb automation: Chaos Monkey, Greasemonkey, monkey-patching. Every existing use of the word in this industry means "unthinking".

This product's stated positioning is that it respects your time and your expertise, and that you are the intelligence while the models are instruments. Diffmonkey names the tool after the industry's word for a developer who is not respected and is not thinking. That is a name at war with its own positioning, and it would be at war with it on every page of the website.

Assets are excellent. The pun is fine. The connotation is the opposite of the brand. Worth saying plainly because it is his own candidate and the collision is invisible until you look for it.

### Where this leaves it

Digestif is the recommendation. It is in his register, the pun carries the entire product thesis without strain, it dodges the crowded animal territory while staying playful, and it is the only name in four rounds that survives both a stand-up and a positioning page.

Hereunto remains the serious-register alternative and the two are genuinely different products in feel. Digestif says the large thing can be made pleasant. Hereunto says you are on the hook. The validation research argues the author-side wedge and the moral refrain both point at the second one, which is worth weighing before choosing on charm.

---

## Finalist Diligence

Digestif and Rennet, checked 2026-08-04. Research only, nothing registered. **Not legal advice.** The trademark work below is a public-record sweep, not a clearance search, and a real filing decision needs an attorney.

### 1. Domains and pricing

| Asset | Digestif | Rennet |
|---|---|---|
| `.dev` | **available** | **available** |
| `.app` | **taken** | **available** |
| `.com` | taken | taken |

**`.app` is the one that matters more than it looks.** The ratified product shape has a paid mobile companion. `digestif.app` is gone and `rennet.app` is free. That is a material difference, not a nice-to-have.

**Standard `.dev` pricing**, verified across registrar comparison data: first year runs $4.99 to $8.72 (Sav, Spaceship, alldomains, Porkbun, Dynadot all under $9), renewals $10.18 to $12.87 (Cloudflare $12.20, Spaceship $12.62, Porkbun $12.87). Namecheap is an outlier at $20.98 renewal, so avoid. Comfortably inside the under-$15 constraint at a sensible registrar.

**Premium pricing risk: not verifiable programmatically, assessed low for both.** Google Registry sets premium tiers per domain and exposes them only through a registrar's own availability check, which is JavaScript-rendered and could not be fetched here. `.dev` premiums run as high as $154,000 a year, and they recur, so this is worth two minutes at a registrar search box before committing. Reasoned assessment: premium tiers on `.dev` skew hard toward short and tech-relevant strings (`api`, `cloud`, `app`, three-letter names). Neither `digestif` nor `rennet` is a tech term and both are six to eight characters, so both are unlikely to be tiered. **Verify at Porkbun or Cloudflare before registering. Do not assume.**

### 2. Trademark sweep

**Digestif: one live mark, wrong class, worth knowing about.**

- **DIGESTIF**, Aperitif Health LLC, USPTO serial 99411310. Filed September 2025, status **NOTICE OF ALLOWANCE ISSUED** as of April 2026, which means it cleared opposition and is proceeding to registration. Class 005: vitamin supplements, nutritional supplements, dietary supplements, electrolyte replacement solutions.
- DIGESTIF, serial 78481039, Class 005 food supplement. Cancelled 2012.
- DIGESTIF, serial 85511903, Whole Foods Market IP. Class 041 entertainment. Dead.
- DIGESTIF RENNIE, Bayer Consumer Care, Canada, Class 005. Cancelled.

No live Class 9 or Class 42 mark found, which are the software and SaaS classes. The live mark is a supplements brand in a different class and a different trade channel, which is normally fine. Two caveats worth stating: a live mark in any class is a live mark, and "Aperitif Health" operating in wellness means there is a non-zero adjacency if the product ever markets on anything health-shaped. Low risk, not zero.

**Rennet: nothing found, in any class.**

No RENNET word mark surfaced in any jurisdiction searched. The word appears in trademark filings only inside goods descriptions, listed alongside whey and yoghurt as a food ingredient, which is exactly what you want to see. It is treated as generic in its home domain and unclaimed everywhere else. Cleaner than Digestif on this axis by a clear margin.

### 3. Collision recheck

**Digestif has an npm collision, and it is the semantically awkward kind.** The `digestif` package is taken, and it is "Cross-Platform SHA2 hash digests", v0.1.9, last published April 2022. Small and abandoned, but note what it means: in software, "digest" already means a cryptographic hash. That is a different meaning of the same word inside the same industry, and it sits directly on the package name. A scoped package works around the registry problem but not the semantic one.

Also found: a Russian restaurant app called "рестобар DIGESTIF" on Android (Food and Drink, nine downloads). Negligible.

**Rennet is clean.** npm `rennet` returns 404, confirmed twice. GitHub handle is a dormant personal account with one repo from 2016. No developer, AI or software product named Rennet surfaced. No app store conflict found.

npm organisation scopes (`@digestif`, `@rennet`) could not be verified: npmjs.com returns 403 to programmatic requests. Check by hand.

### 4. Vocabulary dividend

Ratified vocabulary to protect: **angles**, **chunks**, **decisions**, **publish**.

**Digestif**

- **Chunks: reinforced for free.** "Chunk" is already a digestion word. The name makes the ratified term feel inevitable rather than chosen, at zero cost. This is the single best thing about it.
- **Angles, decisions: neutral.** Optical and judgement words, no clash with the culinary frame, no help either. They just sit there, which is fine.
- **Publish: neutral, with a trap.** The culinary word is "serve", and it will be tempting. Resist it. "Serve" is already overloaded in software, and the signature gesture needs to sound like an act of commitment rather than hospitality. Keep publish plain.
- **The thesis sentence writes itself:** the product's own promise is "makes large PRs digestible", so the name and the pitch are the same word. Nothing else tested comes close on this.
- **The real cost, and it is not twee-ness: a digestif is unambiguously alcoholic.** That carries an implicit drinking-culture association for a global developer audience, some of whom do not drink and some of whom come from cultures where it is prohibited. It is also an odd fit for a consultant embedded at an airline, where alcohol is a live operational and safety subject rather than a neutral one. Not disqualifying. Worth saying out loud rather than discovering it in a room.

**Rennet**

- **Chunks: reinforced, and arguably better.** Rennet makes curds. Curds are chunks. The name does not just permit the ratified word, it produces it as a physical fact.
- **Curds and whey is the best image in either candidate.** Rennet separates one undifferentiated mass into the part that matters and the part that does not. That is the subtraction lens and the false-positive budget in a single picture, and both are core to the ratified lens set.
- **"Set" maps onto the ratified state model.** Curd sets. The mid-review model that got ratified is snapshot plus settled versus live. The metaphor and the state machine are already using the same verb, which is a genuine and unforced dividend.
- **Angles, decisions, publish: neutral.** No clash anywhere.
- **The real cost: cheese, and specifically "cheesy".** Rennet evokes cheesemaking, and "cheesy" is a pejorative in English that maps unfortunately onto code quality. "Rennet says this bit is cheesy" is a joke that will get made, probably in the first week. It is a smaller problem than the alcohol association, but it is more frequent.

### Verdicts

**Rennet: CLEAR.** `.dev` and `.app` both available, npm free, GitHub a dormant squat, no trademark in any class anywhere, no product collision found, and the vocabulary dividend is stronger than expected once curds and whey and the setting metaphor are on the table. The only cost is charm, and the only recurring joke is "cheesy".

**Digestif: CAUTION.** Nothing here blocks it, but four things stack up and the fourth is the one nobody was counting. `.app` is gone and the mobile companion is a paid app. A live Class 5 mark is proceeding to registration. The npm name is taken by a package whose meaning of "digest" is the cryptographic one, inside the same industry. And a digestif is an alcoholic drink, which is a live association in an aviation context specifically.

**This inverts the round 4 recommendation, and it should.** Round 4 ranked on story and register, where Digestif is clearly better. Diligence ranks on assets, encumbrance and downstream cost, where Rennet wins on every line. The choice is now an honest trade rather than a preference: Digestif has the better sentence, Rennet has the better position.

### Before either gets registered

- Registrar search for premium tier on the chosen `.dev`, by hand, at Porkbun or Cloudflare.
- npm organisation scope check by hand, since the registry blocks automated lookups.
- Proper trademark clearance by an attorney if this ever becomes commercial, particularly for Digestif given the live Class 5 mark.
