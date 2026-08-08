---
categories:
  - research
tags:
  - code-reviews
  - competitive-analysis
created: 2026-08-04
---

# Code Review Tools Market

Competitive research for [[Code Review Harness App]]. Field as of 2026-08-04.

Three things you need to read before anything else, because two of them change the brief.

1. **[[References/Hunk|Hunk]] is not a native macOS GUI app. It is a terminal UI.** MIT licensed, free, by Modem, ~8,000 GitHub stars, built on OpenTUI. "Rebuild Hunk as a desktop app" is a real and unclaimed idea, but it is a bigger jump than a port: nothing about Hunk's positioning, pricing, or audience carries over. Hunk is a free CLI tool with celebrity endorsements. You would be building a product.
2. **[[References/CodeRabbit|CodeRabbit]] shipped your core differentiator in May 2026.** It is called Change Stack, it uses the exact word "cohorts", and it does dependency-ordered layers, range summaries, and auto-generated Mermaid diagrams. It is a web interface layered on GitHub and it is in the Pro+ tier. Cohorting is no longer whitespace. What is still whitespace is doing it locally.
3. **At least three people have already shipped a native desktop large-PR review app.** [[References/Scrutiny|Scrutiny]] (macOS, explicitly "code review for large PRs"), [[References/Critiq|Critiq]] (macOS/Windows/Linux, $29 one-time, BYOK AI), and [[References/Remiss|Remiss]] (macOS, Rust/GPUI, read-only, has a "Guided Review" feature). None of them are big. All of them are close enough that the naming and positioning space is more crowded than it looks from the outside.

None of this kills the idea. It does mean the pitch cannot be "nobody does this". It has to be "everyone does a piece of this and nobody has put the pieces in the right box".

---

## The field, sorted by what they actually are

There are five real categories, and they get confused constantly because everyone calls themselves "AI code review".

| Category | Who | Where the code goes | What they sell |
|---|---|---|---|
| Cloud review bots | CodeRabbit, [[References/Greptile\|Greptile]], [[References/cubic\|cubic]], [[References/Baz\|Baz]], [[References/Qodo\|Qodo]], [[References/Sourcery\|Sourcery]], Copilot | Their cloud (or your VPC at enterprise tier) | Fewer bugs reaching production |
| Review workflow platforms | [[References/Graphite\|Graphite]], cubic, Reviewable | Their cloud | Merge velocity, smaller PRs |
| Native review clients | Scrutiny, Critiq, Remiss, [[References/GitMac\|GitMac]] | Your machine | Reading code properly |
| Terminal review tools | Hunk, delta, difftastic, lumen | Your machine | Diffs that do not hurt |
| Old guard | [[References/Gerrit\|Gerrit]], [[References/Review Board\|Review Board]], Reviewable | Self-hosted | Governance and audit |

Your product sits at the intersection of rows 1 and 3, which is a real gap. Nobody is in both.

---

## Cloud review bots

### CodeRabbit

The market leader on standalone paid seats, roughly 140,000 of them, installed on 2M+ repos. Free forever for public repos. Pro at $24/dev/month annual, Pro+ at $48. Enterprise adds self-hosting. GitHub, GitLab, Bitbucket, Azure DevOps.

**Large PRs:** this is now their headline story and it is good. Change Stack, launched 2026-05-13, takes a PR and reorganizes it from a flat alphabetical file list into a small number of independent **cohorts** (unrelated slices of work in the same diff), each broken into ordered **layers** (schema before business logic before call sites before UI before tests). Every layer anchors to specific line ranges with its own plain-language summary. Diagrams generate inline only where a visual earns its place. There is a Code Peek symbol lookup, a semantic diff view that collapses moved code and token-level edits, semantic search across block summaries, severity filters, and a chat agent that already has the PR loaded. Reviews post back to GitHub natively. They also ship a **walkthrough** comment with a 1-to-5 "review effort" score and grouped changed-files summaries.

They are explicit about why: AI-authored PRs are bigger, and layering more bot comments on a noisy thread makes it worse. Their own blog says the current generation of tools "backfires" by adding cognitive load. That is your argument, published by the incumbent, four months ago.

They also have a **free CLI** (`cr`) that reviews local git changes, 3 reviews/hour on free tier, $0.25 per file over limit. So "review locally" is partially covered too, though it is still their cloud doing the thinking and it still needs an account.

**Brand:** whimsical animal, cartoon rabbit, friendly-but-competent. Tone is confident and technical in blog posts, cute in the product. They have effectively claimed the words "cohort", "layer", and "walkthrough".

### Greptile

$30/seat/month with 50 credits, $1 per extra review. No free tier for private repos. GitHub only. Positions on **codebase-aware** review: full repo graph, not just the diff. Free for OSS with MIT/Apache licences, discounts for pre-Series A.

**The interesting bit for you:** Greptile self-hosts in your own infrastructure, air-gapped, Docker Compose or Kubernetes, **and supports bring-your-own LLM provider** (OpenAI, Anthropic, Bedrock, Azure, Vertex). This is the closest existing answer to the procurement problem, and it is an enterprise-licence conversation, which is to say it is still procurement, just a different one.

**Large PRs:** no cohorting story. Deeper context, not better structure. Explicitly slower than diff-only tools.

**Brand:** "grep" plus "reptile". Lowercase, technical, slightly ugly on purpose. Tagline "Merge 4X Faster, Catch 3X More". Very SaaS-metrics.

### cubic (formerly mrge)

YC X25, rebranded from `mrge.io` to `cubic.dev`. Both domains still resolve to the same product; the GitHub org is still `mrge-io`. Worth noting as a cautionary tale about naming: they burned a launch on one name and moved.

Free tier with 20 to 40 reviews/month, Team $30/dev/month annual with a 40k reviewed-lines allowance, Pro $79, Enterprise custom with BYO API keys. Free for public repos. Claims #1 on independent benchmarks (61.8% on one they cite, against Cursor Bugbot and Claude Code).

The original mrge pitch was "Cursor for code review" and the architecture is genuinely different: it clones your repo into an ephemeral sandbox with an LSP server, and the AI navigates using go-to-definition and find-references like a human would, then tears the sandbox down. **They shipped a desktop app** alongside the GitHub App. They also do intelligent file ordering, a unified PR inbox, stacked PRs, and keyboard shortcuts. Cloud-only was a deliberate choice they defended on HN: no local GPU setup, one review per PR for the whole team.

The HN thread contains the single most useful sentence in this whole research pass, from a prospective enterprise buyer: *"For me, taking the workflow out of GitHub is a deal breaker."* Their answer was that everything syncs back to GitHub and using their platform is optional. Note that answer. You will need the same one.

**Brand:** `mrge` was vowel-dropped, lowercase, meme-adjacent. `cubic` is abstract, lowercase, geometric. Both are in the crowded "short abstract lowercase" bucket.

### Baz

$30/active dev/month plus usage-based "Engineering Work Credits" at $0.01/credit. Enterprise adds VPC deployment. Positions as "The Engineering Review Platform", deliberately wider than code: spec review, security review, production signals, merge readiness. Fixer sessions cost $1 to $4.30 each. On AWS Marketplace, which is a procurement dodge worth noting.

**Brand:** three-letter abstract, no referent, no story. The kind of name a domain tool generates. Their positioning is expanding away from code review, which suggests they found code review alone too crowded.

### Qodo (formerly CodiumAI)

~750K registered users, $40-60M estimated ARR. Free tier 30 PR reviews/month, Teams $30/user/month, Enterprise from $45. GitHub, GitLab, Bitbucket, Azure DevOps. Open-source core (PR-Agent). Multi-agent review architecture, best-in-class **test generation** tied to review, ticket validation against Jira, air-gapped deployment for defence/finance/healthcare.

**Relevant to you:** Qodo is the tool that actually solved procurement for regulated orgs, and it did it with on-prem plus SOC2 plus a legal team, not by going local. That is the expensive path.

**Brand:** rebranded away from "CodiumAI" (too close to Codeium, too AI-suffixed). "Qodo" is a coined Latin-ish word. Rebrand suggests the AI-suffix naming era is over.

### Sourcery

Cheapest credible option, $10-12/user/month Pro, $24 Team. Python-first, deep refactoring rules, 200K+ developers, real-time IDE feedback. Diff-focused, not codebase-aware. Its differentiator is **adaptive learning**: dismiss a comment type and it stops flagging that pattern.

**Brand:** magic/craft metaphor, one of the few with warmth in the name.

### GitHub Copilot code review

GA March 2026. Bundled: free tier gets 50 reviews/month, Pro $10, Business $19, Enterprise $39. Roughly 2.4M bundled seats. Agentic tool-calling, reads source files, runs CodeQL and ESLint.

**This is the real competitive threat to any paid tool, and it is also your best argument.** Zero procurement for orgs already on Copilot. It cannot approve or block, only comments. Quality lags on complex multi-file PRs. No self-hosted option, all processing on Microsoft cloud.

If the enterprise client already has Copilot, "we need another review tool" is a hard sell. "I have a thing on my laptop that makes reviewing your 3,000-line PR bearable" is not a sell at all, which is the point.

---

## Review workflow platforms

### Graphite

The most relevant non-AI competitor because it answers the same question with a different verb. Graphite's answer to the large PR is: **do not have one**. Break the work into a chain of small dependent PRs (stacked diffs), review and merge them in order, with a stack-aware merge queue handling the rebases. Hobby free, Starter $20/user/month, Team $40. $52M Series B. GitHub only. The AI reviewer was called Diamond and has been folded into "Graphite Agent", so that name is now dead.

They also shipped **Code Tours**, reviewing changes across multiple PRs in one unified view, which is cohorting arriving from the other direction.

**The strategic point:** Graphite owns "stacked". Do not use that word. Their weakness is that stacking is a team-wide behaviour change, and behaviour change is exactly what you cannot get at a client org. Your pitch is the mirror image: their fix requires the author to change; yours requires nothing of anyone but the reviewer. That is a genuinely strong contrast and it is worth building copy around.

**Brand:** material-noun, abstract, professional, blue. Very well executed. Sets the bar for what a serious dev tool brand looks like in this category.

### Reviewable

The old smart one. GitHub review overlay, ~$10/user/month, free for public repos. Its features are still the best articulation of what reviewers actually need: **comments persist across rebases and force-pushes**, per-file review state so you can mark a file reviewed independently, and a built-in blocking vs non-blocking comment distinction. Inspired by Google's internal tool.

Worth studying closely. Nobody has beaten Reviewable's review-state model, they just beat its interface and its era.

---

## Native desktop review clients (the actual competitors)

This is the row nobody talks about and it is where you would be landing.

### Scrutiny (scrutiny.review)

By Five Rivers Development. Native macOS. Tagline: **"GitHub's UI wasn't built for 50-file PRs. Scrutiny was."** Positioning line: "A native macOS app for reviewing large GitHub pull requests with full repo context, LSP intelligence, and a workflow that actually scales."

Features: every file opens fully expanded (attacks GitHub's "Large diffs are not rendered by default" directly), browse the whole repo alongside the diff, full LSP for 12+ languages, a self-building **TODO list per PR** that persists across sessions and tracks files reviewed plus outstanding comments plus your own notes, and a review queue with per-repo filter rules.

This is the closest thing to your product that already exists. It has no LLM cohorting story, no mobile, and no visible pricing or traction, but the headline is your headline.

### Critiq (getcritiq.dev)

Native, macOS/Windows/Linux, built by one developer. **$29 one-time, currently $19.** "Review Code Like You Read Code." Full Git client (commit graph, staging, conflict resolution) with review-first framing. LSP-aware every diff. GitHub/GitLab/Bitbucket/Azure OAuth plus self-hosted Gitea and Forgejo. Comments sync back to GitHub.

**AI stance is exactly the one I flagged in question 3 of the branding questions, and it is well executed:** "AI as Your Spotter, Not Your Replacement." Three verbs: Explain, Triage, Suggest. Triage auto-ranks files by risk so you start where it matters. **Bring your own key** (Claude, ChatGPT, Gemini, Copilot, Ollama, LM Studio, Bedrock, Azure). "No Critiq backend. No telemetry. No per-request fees." Works fully offline apart from AI.

Also worth noting the founder's copy, which is a masterclass in indie-tool tone: "I built Critiq for myself. I review code in it every single day, and I'll keep building it whether one person buys it or a thousand do. The $29 is so I get a small thank-you when it helps someone else, not to fund a roadmap or a runway."

Critiq has taken the local-first, BYOK, human-stays-the-gate position almost exactly. What it has not taken is **large-PR digestibility**. Its AI is per-file triage, not structural decomposition. That is the remaining gap and it is narrow.

### Remiss (github.com/rikuws/remiss)

Native macOS, Rust and GPUI, MIT, early alpha, one contributor, 32 releases since April 2026. **Read-only by design**, which is a sharp product decision: not an editor, not a merge tool, not a chat box. "The center of the app is the review workspace, not a browser tab or a prompt box."

It has **Review Briefs** and **Guided Review routes**, which is cohorting under a different name, generated by an LLM, off by default, provider-dependent. Uses forks of difftastic and sem for structural diffs. PR data comes through `gh` CLI. AI runs Codex in a read-only sandbox with no network.

Very close to your architecture instincts. Also currently at 0 stars, so this is a signal about how hard distribution is, not about how crowded the idea space is.

### GitMac

Native SwiftUI macOS git client with AI, pitched on "significantly faster than Electron-based alternatives". Not review-focused, but note the positioning: **native versus Electron is being used as a selling point right now**, by more than one product. If you ship Electron you should expect that attack and have an answer.

---

## Terminal tools

### Hunk

Reviewed above. To fill in what it lacks, because that is the part of the brief that matters:

- **No GitHub PR integration at all.** It reviews your working tree, a commit, two files, or a piped patch. It cannot open a PR, post a comment, or submit a review. Everything in the product is local-changeset-shaped, not PR-shaped.
- **No cohorting, no grouping, no ordering.** The changeset reads top to bottom in sidebar order. That is the whole navigation model.
- **Agent comments are one-way.** Open issue #115: you can read agent annotations but you cannot reply and route it back. Multiple users in that thread are asking for exactly the loop you are describing (review the diff, leave inline comments, hand the batch back to the agent). That is an unmet demand signal from Hunk's own users.
- **Performance falls over on large input.** Open issue #247: pager mode buffers the entire stream before rendering anything, peak memory is roughly 2x input, and `git log -p` on a monorepo takes 45 seconds versus 1.8 seconds for nvim. Users are turning it off for `git log`. For a product whose credibility rests on handling big things, that is instructive.
- Node 18+, npm/Homebrew/Nix, extensions in TypeScript, Jujutsu and Sapling as first-class citizens.

What it has that is worth stealing: the theme gallery, the extension API, the split/stack/auto responsive layout, and the endorsement strategy (Mitchell Hashimoto and DHH quotes above the fold).

**Brand:** `hunk` is a git noun repurposed. Lowercase, one syllable, technical insider vocabulary. Very good name. Note that Modem also owns the aesthetic territory of "beautiful terminal", and their diff renderer comes from **Pierre**, which is worth watching separately (there is already a Swift package, PierreDiffsSwift, wrapping Pierre diffs for macOS apps via WKWebView; that is a shortcut if you want their rendering quality without building it).

---

## Old guard

**Gerrit.** Free, self-hosted, Git-only, Google's. The change-based model (each commit is an atomic reviewable Change, with patch sets and +2 voting) is genuinely better than PRs for large-scale review, and everyone agrees it costs 2 to 4 weeks of training to adopt. Scales to Android: 2TB repos, 20,000 pushes/day. Nobody under 50 engineers should use it. Its enduring lesson: **the unit of review matters more than the UI**, and Gerrit chose a better unit and still lost on ergonomics.

**Review Board.** MIT, 2006, still maintained, ~1,700 stars in 20 years. Reviews PDFs, Office docs, images and mockups as first-class objects. Supports Perforce, ClearCase, CVS, which is why it survives in enterprises. Stacked changes added 2024. Feels like a mature Django app because it is one.

**Reviewable.** Covered above under workflow platforms; it is the old guard that aged best.

The old guard's collective lesson for you: every one of them solved review-state persistence and blocking-vs-nonblocking properly, and every one of them lost to a worse tool with better distribution. Distribution beats correctness. Interoperating with GitHub PRs is therefore not a nice-to-have, it is the entire survival strategy.

---

## Naming and brand landscape

### Territories already taken

| Territory | Occupied by | Verdict |
|---|---|---|
| Animal / whimsy | CodeRabbit, Greptile | Full. CodeRabbit owns the friendly-bot slot. |
| Short abstract lowercase | cubic, Baz, mrge, hunk, Fork, Tower | Extremely crowded. Nearly impossible to differentiate. |
| Material / substance nouns | Graphite, Diamond (dead), Sublime | Taken by the best-branded player. |
| Latin/coined | Qodo, Sourcery, Critiq | Live but workable. |
| Descriptive compound | Reviewable, Review Board, CodeRabbit | Dated, but legible. |
| "AI" in the name | Codium**AI**, Bito**AI**, CodeAnt**AI** | Actively being abandoned. Qodo and cubic both renamed away from it. Do not go here. |
| Misspelled/vowel-dropped | mrge, Critiq, Qodo | Renamed away from in one case. Reads as 2021. |

### Vocabulary already claimed

- **cohort** and **layer**: CodeRabbit, since May 2026. Both burned. This is the biggest single finding in this section, because "cohort" is the word currently in your working brief.
- **stack** and **stacked**: Graphite, GitButler, Change Stack. Triple-claimed. Unusable.
- **walkthrough**: CodeRabbit.
- **tour**: Graphite (Code Tours).
- **brief**, **guided review**: Remiss.
- **triage**, **spotter**: Critiq.
- **hunk**: Modem.
- **change**: Gerrit, deeply.

Still open and worth considering: **chapters**, **reading**, **passes**, **rounds**, **the gate**, **legible**, **digestible**, **whole**.

### Tone territories

Everyone in the cloud tier writes in metrics ("4X faster", "3X more bugs", "28% faster merges", "<5% negative comment rate"). Everyone in the native tier writes in first-person craft ("I built this for myself", "review code like you read code"). There is nobody writing about **the reviewer's experience of being overwhelmed**. The closest is CodeRabbit's blog, which names cognitive load but then sells a platform. Emotional territory around reviewer fatigue is genuinely unoccupied.

Visually: purple and dark gradients are the AI-dev-tool uniform. Graphite is the best-executed brand in the space and is essentially monochrome plus one accent. The native tools all default to terminal-adjacent dark themes. A light, calm, generous-whitespace, document-like review surface would be visually differentiating on its own, and it would also be an argument: this is a reading tool, not a cockpit.

---

## Synthesis: where the whitespace actually is

**Not whitespace any more:**

- Cohorting and dependency-ordered walkthroughs. CodeRabbit shipped it, named it, and documented it thoroughly. You are now a fast follower on the mechanic.
- Native desktop review clients. Three exist.
- BYOK local AI review. Critiq does it, Greptile self-hosted does it, cubic Enterprise does it.
- LSP-in-the-diff. Scrutiny, Critiq, and cubic's sandbox all do it. It is table stakes now, not a differentiator.
- AI-as-assistant-not-replacement framing. Critiq has it word for word.

**Genuinely open:**

1. **Cohorting that runs entirely on the reviewer's machine with the reviewer's own harness.** This is the single defensible claim. CodeRabbit's Change Stack is the best implementation of the mechanic and it is cloud SaaS behind a $48/seat Pro+ tier. Nobody has built the offline, no-account, no-procurement version. That is the sentence the whole product hangs on.
2. **Review state as a first-class local artifact.** Reviewable proved reviewers desperately want per-file review state that survives force-pushes. Scrutiny is rebuilding it as a TODO list. Nobody has combined persistent review state **with** cohorting, so that "I finished cohort 2 of 5" survives a rebase and a night's sleep. For an ADHD reviewer specifically this is the killer feature, and it happens to also be the universal one.
3. **The reviewer-side loop back to the agent.** Hunk's issue #115 has multiple users begging for it: read the diff, leave inline comments anywhere, hand the batch to the agent, get answers back in thread. Hunk has not shipped it. CodeRabbit has chat but it is their agent on their infrastructure. This is an obvious, requested, unbuilt feature and it is the natural thing a harness-powered app does well.
4. **Emotional positioning around reviewer overwhelm.** Every competitor sells to the buyer (velocity, bugs caught, merge time). Nobody sells to the person who has to read the thing. That audience is unserved in copy even where it is served in product.
5. **Mobile.** Genuinely nobody. CodeRabbit's Change Stack has a mobile drawer for one dialog. That is the entire mobile story of the category.

**Crowded to the point of being a mistake:**

- Anything that leads with accuracy, benchmarks, bug-catch rate, or "#1 on independent benchmarks". Four vendors are fighting over that claim and you cannot win it with someone else's model and someone else's keys.
- Anything that leads with "AI code review". You would be the tenth result.
- Anything that requires the author or the team to change behaviour. Graphite has spent $52M teaching people to stack and enterprise adoption is still the hard part.

---

## Positioning recommendation

If I had to write the one-liner today, before Rai answers the branding questions, it would be shaped like this:

> Large pull requests, broken into things you can actually finish. On your machine, with your keys, no account and nothing to procure.

The load-bearing parts, in order: **finishable** (the emotional promise, unclaimed), **on your machine** (the structural moat, and the procurement answer), **nothing to procure** (the specific enterprise unlock).

What I would deliberately not say: AI, cohorts, layers, stacks, faster, or any percentage.

The hardest question the positioning has to survive is the one that HN commenter asked cubic: *taking the workflow out of GitHub is a dealbreaker*. The answer has to be in the first paragraph of anything you write, not the FAQ.

---

## Sources

- [hunk.dev](https://hunk.dev/), [modem-dev/hunk](https://github.com/modem-dev/hunk), issues [#115](https://github.com/modem-dev/hunk/issues/115) and [#247](https://github.com/modem-dev/hunk/issues/247)
- [CodeRabbit Change Stack docs](https://docs.coderabbit.ai/pr-reviews/change-stack), [Change Stack launch post](https://www.coderabbit.ai/blog/introducing-change-stack-the-first-ai-native-code-review-interface), [explainable review post](https://www.coderabbit.ai/blog/coderabbit-review-reads-a-pr-how-author-would-explain-it), [pricing](https://www.coderabbit.ai/pricing), [CLI](https://www.coderabbit.ai/cli)
- [Graphite](https://graphite.com/), [Greptile pricing](https://www.greptile.com/pricing) and [self-host docs](https://www.greptile.com/docs/security/selfhost)
- [cubic pricing](https://www.cubic.dev/pricing-plans), [mrge Launch HN](https://news.ycombinator.com/item?id=43692476)
- [Baz pricing](https://baz.ai/pricing)
- [Scrutiny](https://scrutiny.review/), [Critiq](https://getcritiq.dev/), [Remiss](https://github.com/rikuws/remiss), [GitMac](https://gitmac.app/)
- [GitButler](https://github.com/gitbutlerapp/gitbutler), [PierreDiffsSwift](https://github.com/jamesrochabrun/PierreDiffsSwift)
- [Morph: 6 AI review tools tested](https://www.morphllm.com/github-ai-code-review), [AI code review market share 2026](https://www.ideaplan.io/blog/ai-code-review-tools-market-share-2026), [Review Board retrospective](https://unsubbed.co/tools/review-board/)
