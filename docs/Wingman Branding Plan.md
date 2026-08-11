---
tags: [rennet, branding, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

> 📜 **Historical evidence, not current authority.** Superseded wherever it conflicts with **RULE ZERO** (`CLAUDE.md`): no consent gates, no gates, no robustness for robustness' sake. Read for rationale and provenance only.

# Rennet Branding Plan

> [!IMPORTANT] Current implementation authority, 2026-08-05
> The name is settled: **Rennet**. Digestif and Wingman material below is naming history only. Current product copy follows [[Rennet Contracts and Rulings]] and [[Rennet Architecture Contracts]]: six angles (Spec, Sequence, Decisions, Claims and Evidence, Blast Radius, Noise), no Subtraction angle, no route handoff, and author-side review first. Privacy copy must say **“no Rennet backend”** and disclose that selected local harnesses/providers may receive code and context; never claim universally that nothing leaves the machine.
> The private personal source repository `github.com/rbutera/rennet` now exists by Rai's explicit decision. Historical “do not create the repo” rows below are superseded. Public organisation, npm, domain, social, and release registrations remain RAI-ONLY.

The execution plan for the brand, the launch surface, and the namespace, for [[Code Review Harness App]]. Discovery, positioning and naming history live in [[Code Review App Branding Questions]]; the visual system lives in [[Code Review App Design Directions]].

Rennet is the final name. The Digestif sections remain as a record of the naming process and must not drive implementation, copy, packages, or registration.

**The private personal source repository is the sole completed namespace action.** Nothing has been purchased or made public; every remaining acquisition item is RAI-ONLY.

## Where the name actually stands

The `.com` condition Rai set ("if the .com is available cheap I'll go with Rennet") **failed**. Verified 2026-08-04: `rennet.com` is registered since 2000-10-31 through Gabia Inc. (Korean registrar), live site, `clientTransferProhibited`, expiry 2026-10-31.

What survived: `rennet.dev`, `rennet.app`, `rennet.sh`, `getrennet.com`, `rennet.review` are all unregistered.

The honest read on the failed condition: **the `.com` was never load-bearing for this product.** Distribution is an open-source repo plus a desktop app plus a paid mobile companion. That routes through GitHub, npm, Homebrew, and the App Store, not through a bare `.com`. The one asset that genuinely matters more than `.com` here is `.app`, because the paid mobile companion is a ratified part of the product, and `rennet.app` is free while `digestif.app` is gone (registered 2026-01-12, so recently, by someone else). That inversion is the whole argument: Rennet loses the `.com` race that does not matter and wins the `.app` race that does.

Three outcomes are possible from Rai's pending answer, and this plan works for all three. Decision mechanics in the last section.

---

## 1. Identity package

### 1a. Rennet (primary)

**The story, in the one sentence it gets.** Rennet is the enzyme that turns one undifferentiated white liquid into curds and whey. It adds nothing. It separates what is already there into a part you can handle and a part you can pour off.

**Wordmark direction.** The mood board masthead is the right starting point and needs two corrections.

Current treatment (`assets/screens.css` line 54): `font: 650 1rem/1 var(--sans); letter-spacing: .005em` in `--mark-ink`, paired with the glyph in `assets/app.js` (a disc split down its vertical axis: left half filled solid, right half an open stroke arc).

- **Keep the glyph. It is the strongest asset in the whole mood board and it is doing real work.** Solid half is the curd, open half is the whey. It is separation stated as a shape, with no cheese, no bottle, no drop, and no illustration. It also survives shrinkage: at 16px it still reads as "something has been divided", which is more than most dev-tool marks manage.
- **Correction one: the split should read as a cut, not as a fill.** Widen the gap between the two halves to a hairline of ground so the eye reads two objects rather than one half-shaded circle. At icon sizes a shaded circle reads as a progress meter, which is the wrong idea entirely.
- **Correction two: the two halves should carry the system's own materials, not one ink.** Solid half in `--mark-ink` (bone, the opaque thing), open arc in `--private` backlight blue with the system's single inner glow. That makes the mark a restatement of the product's central doctrine: the solid part is what leaves the machine, the lit part is what stays on your Mac. Nobody has to be told this for it to work.
- **Wordmark type.** Sans, weight 650, near-neutral tracking, sentence case `Rennet`. Do not letterspace it wider, do not set it lowercase, do not set it in the serif. **The serif is reserved for paper**, which under the ratified doctrine means the publish sheet and the signature line only. A serif wordmark would spend the scarcest thing in the system on a logo.
- **Lockups.** Three, and only three. Horizontal (glyph + word, 9px gap, the mood board's `.wm`) for the app sidebar and the site masthead. Glyph-only for the icon, the favicon, and the menu bar. Stacked (glyph over word) exists for the App Store card and nowhere else.
- **What is banned.** No cheese. No milk drop. No curd texture. No wheel, wedge, or dairy anything. The referent is a mechanism, not a food. If a reviewer's first read is "cheese", the mark has failed, and the glyph as drawn does not read that way, which is why it must not be helped along.

**Tagline options.** Derived from Positioning V3, ranked. The headline is settled and does not change: *You stopped writing the code. You still have to answer for it.* These are the short line that sits under or beside the wordmark.

1. **"A review harness."** Flat, three words, claims the category Rai ratified claiming. Strongest, precisely because it refuses to sell.
2. **"It separates. You decide."** Name-native without explaining the name. Four words, both halves of the trust model.
3. **"Everything that isn't reading, removed."** The anti-Change-Stack line compressed.
4. **"For pull requests too big to hold in your head."** The most legible to a cold reader; the least distinctive.
5. **"Your harnesses. Your keys. Your call."** The proof block as a tagline. Use on the download page, not the masthead.

Avoid: anything with a number, anything with "faster", anything with "AI".

**Store and README one-liner** (one sentence, this is the string that gets copied everywhere: GitHub description, Homebrew caveat, App Store subtitle, HN title tail):

> Rennet is a local code review harness: it separates a pull request too big to read into chunks you can finish, and leaves every judgement call to you.

App Store subtitle needs 30 characters: **"Review harness. Your call."** (26)

**App icon concept** (described, not rendered; consistent with Glass doctrine):

Squircle, macOS 26 icon geometry. Ground is the aurora at its darkest and quietest: teal falling to near-black at the corners, amber only as a suggestion at one edge, heavily blurred, no visible banding, no detail competing with the mark. The wallpaper policy already says the aurora is the identity, and this is where it earns that.

Centred on it, at roughly 58% of the safe area, the split disc. The solid half is opaque bone (`#EDEFF2`), the only fully opaque object in the icon, sitting slightly proud with a soft contact shadow so it reads as a physical thing resting on glass. The open half is a stroke arc in backlight blue with the system's only inner glow, and it is genuinely translucent: the aurora passes through where it is not. Between them a hairline of pure ground, so the split is a cut.

The whole icon is the doctrine in one image: one solid object, one lit translucent object, an aurora behind both, and nothing else. It should be legible at 16px (a divided circle), recognisable at 32px (solid half, lit half), and only at 512px reveal that the arc is glowing rather than filled.

Explicitly not: a bottle, a glass, a drop, a magnifier, a checkmark, a gavel, a pen, a document, an eye, a robot, a sparkle, a gradient-purple anything.

**Voice guide** (see 1c, shared).

### 1b. Digestif (contingency)

**The story.** A digestif is what you take after a meal that was too large, specifically so you can process it. The pun is the product thesis with no strain in it, which is why it survived four naming rounds.

**Wordmark direction.** Mood board treatment (`screens.css` line 52): serif, weight 600, tracking -0.015em, lowercase `digestif` with the `i` tittle set in `--mark-accent` amber; under the Glass direction it flips to sans 700 at -0.02em (line 55). Glyph in `app.js`: a stroked circle with an amber horizontal across the lower third, reading as a vessel with a liquid level.

Three notes, honestly:

- **The Glass flip to sans is correct and should become the only treatment.** The serif lockup belongs to the superseded Reading Room. Keeping both is how a system starts drifting.
- **The amber tittle is the best idea in the Digestif mark and it should survive.** It is the one place a single functional hue appears in the identity, it is a small joke told quietly, and it does not require a cartoon anything, which was the stated condition for the liqueur register not collapsing into CodeRabbit's rabbit.
- **The glyph is the weak part and it is weak specifically at icon size.** A circle with a horizontal line through it, shrunk to 16px, is a generic half-full indicator; in an app grid it is indistinguishable from a dozen progress and battery marks. It also spends amber, which the ratified system reserves for blast radius, on the logo. Fix: drop the glyph entirely and let the wordmark with the amber tittle be the whole mark, with a lettermark `d` in the same treatment for the icon. That is a real cost relative to Rennet, whose glyph is asymmetric and therefore survives shrinkage.

**Tagline options.** Same list as Rennet, minus the name-native option, plus one:

1. **"A review harness."**
2. **"Everything that isn't reading, removed."**
3. **"After the meal, before the signature."** Name-native, and it links the two halves of the positioning (digestion and accountability) in one line. Slightly precious; use once, on the site, never in the app.

**Store and README one-liner:**

> Digestif is a local code review harness: it breaks a pull request too big to read into chunks you can finish, and leaves every judgement call to you.

App Store subtitle: **"Review harness. Your call."** (unchanged)

**App icon concept.** Same aurora ground and same materiality rules. Centre a lowercase `d` set in the display sans at 700, cut as an opaque bone letterform, with the counter (the enclosed bowl of the `d`) left open to the aurora so light passes through it, and a single amber point where the tittle would be if the letter had one, floating just off the ascender. Solid letterform, lit counter, one amber point. Same doctrine, less distinctive mark, and it will be mistaken for a generic `d` app more often than the split disc will be mistaken for anything.

**Vocabulary trap to hold** (from the diligence, worth restating because it will come up in week one): the culinary word for publish is *serve*. Do not use it. "Serve" is already overloaded in software and the signature gesture has to sound like commitment, not hospitality. Publish stays plain.

### 1c. Voice guide (shared, name-independent)

**The register:** playful-precise. Git vernacular. First person singular when the product speaks about itself is banned; the product does not have a personality, it has a manner. Short declaratives. Specific numbers only when they are counts of real things on screen ("6 decisions", "3 of 11 chunks"), never as claims.

**Ratified product vocabulary, protect it:** angles, chunks, decisions, publish, review harness, spec, blast radius, noise, the sequence, claims and evidence, harness.

**Burned, never use:** cohort, layer, stack, lens, chapter (all lost to competitors, see the market note), slop (it insults the buyer's own output), copilot, agentic (internal only, has a shelf life).

**AI-smell words, banned outright:** leverage, seamless, robust, powerful, revolutionize, unlock, elevate, supercharge, effortlessly, delve, landscape, realm, tapestry, testament, "it's not just X, it's Y", "in today's fast-paced", "empowers you to". No em dashes, ever; commas, colons and semicolons instead. No rule-of-three lists as a rhetorical tic. No "we're excited to announce".

**Category-poisoned phrases, banned:** "AI code review", "AI-powered", "10x", any percentage improvement, "catches bugs before they reach production", "your AI teammate", "second pair of eyes" (Critiq and Callout both already say it, and it contradicts the inversion stance by casting the tool as the reviewer).

**What the product never claims:** that it found the bug, that it reviewed anything, that it is confident, that it approved. It proposes structure, it surfaces disagreement, it holds state. The reviewer reviews.

**Three sentences that show the register working:**

- "Three harnesses read this. Two agreed. The third is here, and it is substantive, not stochastic."
- "Eleven chunks. You have read four. Nothing publishes until you say so."
- "This deletes a test. Nothing else in the change covers what it covered."

**Three that would fail it:**

- "I've analysed your PR and found 47 issues!" (personality, exclamation, findings-as-product)
- "Rennet's powerful AI engine seamlessly surfaces critical insights." (every banned word at once)
- "Your review is 73% complete." (pace data is private and never gamified; this also breaks a ratified decision)

---

## 2. Launch surface

### The domain decision

**Primary: `rennet.dev`** (or `digestif.dev`, both verified available). Reasons: it is the audience's TLD, it costs $5-9 first year and $10-13 renewal at a sane registrar, and owning it unlocks a Bluesky handle (`@rennet.dev`) for free without touching the squatted `rennet.bsky.social`.

**`rennet.app` is acquired at the same time and pointed at the same site** until the mobile companion exists, at which point it becomes the companion's own page and the App Store link target. This is not defensive registration, it is the paid product's future address, and it is the asset Digestif does not have.

Digestif contingency domains, verified by RDAP today with controls run both directions: `digestif.dev` AVAILABLE, `digestif.sh` AVAILABLE, `digestif.review` AVAILABLE, `digestif.app` REGISTERED (2026-01-12), `getdigestif.com` REGISTERED (2024-03-19), `digestif.com` REGISTERED (2003-09-18). So under the contingency the plan is `digestif.dev` for the site and **no home for the mobile companion**, which either forces a sub-path (`digestif.dev/mobile`) or a different second domain. Flagging that as a real, not cosmetic, cost of the fallback.

### Stack recommendation

**No new framework.** The rule is that the site should be buildable by whoever just finished a UI session on the app, using the same tools, with no context switch.

- **Authoring:** hand-written HTML, exactly as the mood board is. The mood board already proves this works and it produced seven screens in one pass.
- **Styling:** import `assets/tokens.css` from the app repo directly. The site and the product then cannot drift, because there is one token file and both consume it. This is the single most valuable decision in this section: every dev-tool site in the world eventually stops matching its app, and this makes that structurally impossible rather than a discipline problem.
- **Build:** Vite + TypeScript, same as the desktop renderer per [[References/Desktop and Mobile Stack 2026]]. For a one-pager it is doing almost nothing, which is correct. `vite build` emits static files.
- **JS on the page: as close to zero as it goes.** A scheme toggle and nothing else. No analytics, no fonts fetched, no third-party anything. Privacy copy says there is no Rennet backend and explains that review data goes only to the harness/provider the user selects.
- **Host:** Cloudflare Pages (free, custom domain, no build-minute anxiety) or GitHub Pages if the repo is already there. Either is fine; do not spend a decision on it.
- **Escape hatch, named now so it is not improvised later:** if docs grow past roughly five pages, move to Astro, which keeps the hand-authored HTML and adds routing and content collections without adopting a component framework for a static site. Not on day one.

### Sections, in order

1. **Masthead.** Wordmark, the category line ("A review harness"), and one link: the repo. No nav bar on a one-pager.
2. **The exposure thesis.** The ratified headline, then the three blocks from Positioning V3 verbatim (stakes, what it is, proof). This is above the fold and it is words, not a screenshot, because the first thing to establish is that someone understood the problem.
3. **One screenshot, full bleed.** The review surface on Glass dark (`moodboard/review.html`). Glass photographs better than paper did, which is a real reason it won.
4. **The category paragraph.** *"A coding harness points a model at your codebase so it can write. A review harness points models at a change so you can read. The harness does the structural work. You do the deciding."* This teaches the term Rai chose to claim, and it has to appear before the feature list or the feature list reads as a bag of things.
5. **The six angles.** One block each: Spec, Sequence, Decisions, Claims and Evidence, Blast Radius, Noise. Propose-deletion findings demonstrate where Subtraction's useful content went without reviving a seventh angle.
6. **The publish ceremony.** Two variants: local self-review previews a PR title/body without pushing; remote PR review previews the exact review/comments and degradation ledger. Every GitHub mutation remains an explicit action.
7. **BYOK and zero-config.** The proof block. "Install it, sign in with GitHub, done. It drives the coding harnesses already on your machine." Then, smaller, the power path: your keys, your endpoints, your agent config. Include the harness list as plain text, not logos.
8. **Diff chat and disagreement.** `chat.html`. This is where the "AI reviewing AI is circular" objection gets answered by a screenshot rather than an argument.
9. **The three objections, answered in the open.** Not a FAQ accordion, three short headed paragraphs. (a) "Taking the workflow out of GitHub is a deal breaker": reviews land as normal GitHub reviews, comments, threads, approvals. (b) "AI reviewing AI is circular": the models are instruments, their disagreement is the signal, the human is the gate. (c) "Just prompt the model yourself": the product is the interface and the state model, not the inference; BYOK makes that objection stronger, so it gets answered rather than dodged.
10. **What it is not.** Short, plain list. Not a bot. Not a cloud service. No account with anyone but GitHub. No telemetry. Does not comment on your behalf. This section will get screenshotted and posted, which is the point.
11. **Footer.** Repo, licence, a name explanation in one sentence (the referent, told once), and nothing else.

### The honest pre-launch version

Until dogfood-v1 clears, the site is a **status page, not a marketing page**, and it is waitlist-free by instruction and by taste.

- No email capture. No "join the beta". No form of any kind. There is nothing to sign up for and pretending otherwise is the exact register the audience punishes.
- Sections 1, 2, 4, and 10 only, plus one screenshot. Everything else is held back, because showing a feature list for software nobody can run is how a project acquires a credibility debt it then has to pay off.
- **One dated line of honesty, prominently:** *"Not released. Dogfooded daily since [date] on real pull requests. The repo goes public when it stops being embarrassing."* A date that moves is worth more than a promise that does not.
- **A build log, not a blog.** A plain reverse-chronological list of dated one-liners on the same page, with an Atom feed. It costs nothing to maintain if it is genuinely one line, it is the only pre-launch content the audience respects, and it doubles as the raw material for the launch post.
- The repo link appears the moment the repo is public, and that is the only call to action the page ever has.

---

## 3. Namespace checklist

All checks below were run read-only on 2026-08-04, no accounts created and nothing registered. Method and calibration are stated because an unverified "available" is worse than no check: **npm** via `registry.npmjs.org` (404 = free), **PyPI** via `pypi.org/pypi/<n>/json`, **crates.io** via its v1 API, **GitHub** via `api.github.com/users/<n>` (404 = free), **Homebrew** via `formulae.brew.sh` API, **Bluesky** via `resolveHandle` (calibrated: `bsky.app` resolved, a nonsense handle returned 400), **X** via public profile URL (calibrated: `x.com/jack` 200, a nonsense handle 404), **domains** via RDAP with both a known-registered and a known-unregistered control.

### Results

| Namespace | Rennet | Digestif | Note |
|---|---|---|---|
| `.dev` domain | free (given, fresh today) | **free** (RDAP 404) | Primary site |
| `.app` domain | free (given) | **taken**, registered 2026-01-12 | Mobile companion address |
| `.com` domain | **taken**, reg 2000-10-31, Gabia, exp 2026-10-31 | **taken**, reg 2003-09-18 | The failed condition |
| `.sh` domain | free (given) | **free** (RDAP 404) | Optional, CLI vanity |
| `.review` domain | free (given) | **free** (RDAP 404) | Optional, on-the-nose |
| `get<name>.com` | free (given) | **taken**, reg 2024-03-19 | Fallback `.com` route |
| npm package | **free** (404) | **taken** (200, SHA2 hash pkg) | Digestif must scope |
| npm scope `@<name>` | probe 404, **not conclusive** | probe 404, **not conclusive** | npmjs blocks org lookups; hand-check |
| GitHub handle | **taken**: user `Rennet`, 1 repo, created 2016, profile touched 2026-07-15 | **taken**: user `digestif`, 1 repo, created 2016, dormant since 2020 | Both squats; see below |
| GitHub alternates | `rennet-dev`, `rennet-app`, `rennethq`, `userennet`, `rennet-labs` all **free** | not swept (contingency) | Recommend `rennet-dev` |
| PyPI | **free** (404) | **free** (404) | Not relevant unless a Python SDK ships |
| crates.io | **free** (404) | **free** (404) | Relevant if any core lands in Rust |
| Homebrew formula | **free** | **free** | Distribution path for the CLI |
| Homebrew cask | **free** | **free** | Distribution path for the desktop app |
| Bluesky `<n>.bsky.social` | **taken** (real DID) | **taken** (real DID) | Irrelevant: own the domain, use `@rennet.dev` |
| X handle `<n>` | **taken** | **taken** | `@rennetdev`, `@rennetapp`, `@userennet`, `@rennet_dev` all free (404); `@rennethq` taken |
| Apple App Store name | **not checkable read-only** | **not checkable read-only** | Requires App Store Connect; RAI-ONLY |
| `.dev` premium tier | **not checkable read-only** | **not checkable read-only** | JS-rendered at registrars; hand-check |

Two honest reads on that table:

- **The GitHub `Rennet` account is a squat, but it is not a dead squat.** `updated_at` is 2026-07-15, which means the profile was touched three weeks ago (a follow or a profile edit will do it). One public repo, created 2016, bio "I am from Estonia." GitHub does not release usernames on request except on a trademark claim, and there is no mark here. So the plan is `rennet-dev` as the org and `github.com/rennet-dev/rennet` as the repo, which reads correctly and costs nothing. Do not build any plan around acquiring `github.com/rennet`.
- **The npm scope is the one gap this method cannot close.** `registry.npmjs.org/@rennet%2fcli` returning 404 proves only that no package exists at that path; it does not prove the org name is claimable. npmjs.com returns 403 to programmatic requests. This needs two minutes signed in to npm, by hand.

### Registration checklist, priority order

Cost estimates are first-year at a sane registrar (Porkbun, Cloudflare, Dynadot, Spaceship; **avoid Namecheap**, whose `.dev` renewal is an outlier at $20.98). Renewals in brackets. All items are **RAI-ONLY**.

| # | Item | Est. cost | Priority | Depends on | Note |
|---|---|---|---|---|---|
| 1 | `rennet.dev` | $5-9 [$10-13/yr] | P0 | name answer | Check premium tier at the registrar search box first; do not assume |
| 2 | GitHub org `rennet-dev` | free | P0 | name answer | Becomes the repo URL and the canonical identity; claim before the domain propagates |
| 3 | npm scope `@rennet` | free | P0 | name answer | Hand-check availability while signed in; unscoped `rennet` is also free, claim both |
| 4 | `rennet.app` | $12-15 [$12-15/yr] | P1 | name answer | The paid mobile companion's address; the asset Digestif does not have |
| 5 | X handle `@rennetdev` | free | P1 | name answer | `@rennet` is taken; do not chase it |
| 6 | Bluesky handle `@rennet.dev` | free | P1 | item 1 | Set via domain verification; sidesteps the taken `.bsky.social` |
| 7 | `getrennet.com` | $10-13 [$10-15/yr] | P2 | name answer | Only if a `.com` presence is wanted at all; redirect to `.dev` |
| 8 | `rennet.sh` | ~$30-40 [~$35-45/yr] | P3 | — | Skip unless a `curl \| sh` install line is genuinely planned. Verify price; `.sh` is not cheap |
| 9 | `rennet.review` | ~$5-15 [~$20-30/yr] | P3 | — | On-the-nose, low value, renewal-heavy. Probably skip |
| 10 | Apple Developer Program | £79/$99 per year | P2 | dogfood-v1 | Needed for macOS notarization **and** the mobile companion. Do not buy before there is something to notarize |
| 11 | App Store app name reservation | included in 10 | P2 | item 10 | Only checkable and claimable inside App Store Connect |
| 12 | Homebrew tap or formula | free | P3 | public repo | `rennet` free as both formula and cask |
| 13 | crates.io / PyPI placeholders | free | P4 | — | Only if those ecosystems are actually entered. Squatting your own name in ecosystems you do not ship to is noise |

Realistic day-one spend if Rennet wins: **items 1-6, roughly $20-25 total.** Everything else waits for a reason.

### Calendar watch: `rennet.com`, 2026-10-31

`rennet.com` expires 2026-10-31. This is a **watch item, not an opportunity**, and it should be filed that way so it does not generate false hope in three months.

- **Expiry is a renewal date, not a drop date.** A 26-year-old domain with a live site and `clientTransferProhibited` set is overwhelmingly likely to auto-renew. If it did lapse, the actual availability date is roughly 75 days later (auto-renew grace of ~30-45 days, then a 30-day redemption period at a several-hundred-dollar redemption fee, then a ~5-day pending-delete window), so the realistic date to look at is **mid-January 2027**, not 31 October.
- **Backorder option, if wanted:** DropCatch, SnapNames, or NameJet, typically $59-79 charged only on a successful catch, with an auction if more than one party backorders. Placing a backorder costs nothing up front at most of them.
- **The honest recommendation: do not act on this.** Set a single reminder for 2027-01-15 to re-run the RDAP check. If the product is real by then, a `.com` is a nice-to-have that can be bought or brokered from a position of strength; if it is not real by then, the domain was never the problem. Building the launch around a domain that is 95% likely to renew is exactly the kind of dependency that stalls a project on nothing.

---

## 4. OSS launch motions

### The gate, first

Rai ratified **dogfood daily-driver first**. That is the gate and it should be written down in a form that can actually fail:

> **dogfood-v1 is cleared when Rai has reviewed every PR he touched, his own and other people's, in the app rather than in GitHub's UI, for four consecutive working weeks, without falling back.** Falling back once is data, not failure; falling back on the same class of problem twice is a bug that blocks the gate.

Nothing in this section fires before that. The reason is not modesty, it is that the entire positioning is "I use this every day and here is what I learned", and that sentence cannot be faked by a person who will be answering questions in a thread for eight hours.

### Where a tool like this launches

**Show HN.** The primary channel and the only one that matters on day one. This exact audience launched Stage, cubic, Critiq, Scrutiny and Remiss, and every one of those threads is in the market research already, which means the objections are known in advance rather than discovered live.

- Timing: Tuesday to Thursday, 09:00-11:00 US Eastern, which is 14:00-16:00 BST. Not Monday, not Friday, not a US holiday week.
- Title form: `Show HN: Rennet – a local review harness for PRs too big to read`. No exclamation, no "AI", no version number.
- Hard requirement: it must be runnable by a reader that day. Show HN with a waitlist gets flagged and deserves to.
- Be in the thread all day. First-hour response latency is the single biggest lever on a Show HN outcome.
- **Pre-write three answers, verbatim, before posting:** the GitHub-workflow objection, the AI-reviewing-AI objection, and "just prompt the model yourself". These will be the top three comments in some order. Writing them at 15:40 under pressure is how a good launch becomes a defensive one.
- Expect and welcome the Hunk comparison. The settled framing is available and it is generous: Hunk is a great pager, this is not a pager. Never comparative, never a feature table.

**lobste.rs.** Same morning, different register. Invite-only, so this needs an existing account; the audience punishes marketing prose harder than HN does. Post the **repo**, not the landing page, tagged `show`. One paragraph of plain description in the text field. Do not cross-post the HN copy; it will read as syndicated.

**Reddit, 48 hours later and only if HN went well.** r/programming is hostile to self-promotion and has a specific hazard here that the lens-validation research already found: **the dominant moral position on that side of the internet is that a large unread AI PR should be refused, not accommodated.** A tool that makes 3,000-line PRs pleasant reads to that crowd as enabling the behaviour they want stopped.

The answer is the ratified sequencing, and it must be the first sentence of any Reddit post: **the author does the work.** Author-side review is the alibi. Lead with "this makes you review your own agent's output before you inflict it on anyone", never with "this makes reviewing 3,000 lines pleasant". Better targets than r/programming: **r/ExperiencedDevs** (the actual buyer, and the source of the best framings in the research), r/devtools, r/LocalLLaMA (the BYOK and local-harness story lands there without translation).

**X dev community.** Not a launch channel, a continuous one. Glass photographs well and the publish ceremony is the most postable moment in the product. Build-in-public from the dogfood period onward, one screenshot at a time, no thread-bait formatting, no "🧵". The account exists to have a link in the HN profile and to catch the traffic HN sends, not to generate demand on its own.

**Not launching on:** Product Hunt (wrong audience, wrong register, and it will make the HN crowd trust it less), any newsletter sponsorship, any "AI tools" directory.

### The launch post's first sentence

**Rennet:**

> Rennet is a code review harness that runs on your machine: it takes a change too big to hold in your head, separates it into chunks you can actually finish, and leaves every judgement call to you.

**Rennet, author-side-first variant** (recommended, because it matches the ratified wedge and pre-empts the enabling objection):

> I built Rennet because I kept opening pull requests my agent wrote and could not honestly say I had read them.

**Digestif:**

> Digestif is a code review harness that runs on your machine: it takes a change too big to hold in your head, breaks it into chunks you can actually finish, and leaves every judgement call to you.

**Digestif, author-side-first variant:**

> I built Digestif because I kept opening pull requests my agent wrote and could not honestly say I had read them.

The second form is better in both cases and the reason is worth stating: on HN a confession outperforms a claim, and this one happens to be true, which is the only reason it is usable.

### Sequence

1. dogfood-v1 clears (four weeks, no fallback).
2. Repo goes public. Landing page flips from status page to full page in the same commit.
3. Build log gets a final entry that is the story, not a changelog line.
4. Show HN + lobste.rs, same morning, HN first by an hour.
5. X thread same day, pointing at the HN thread rather than the site.
6. Reddit at +48h, author-side framing, r/ExperiencedDevs before r/programming.
7. Nothing else for a month. Ship what the thread asked for.

---

## 5. Naming record and decision mechanics

Whichever way Rai's answer goes, here is what changes and what does not. This exists so the answer is cheap to act on rather than a project of its own.

### Outcome A: Rennet on `rennet.dev` (recommended)

The `.com` condition failed but the condition was measuring the wrong asset. `.app` is the one that matters for this product shape and Rennet has it.

| Artefact | Change |
|---|---|
| Domain | Register `rennet.dev` + `rennet.app` |
| Repo | `github.com/rennet-dev/rennet` (org `rennet-dev`; `rennet` user handle is a live squat) |
| npm | `rennet` unscoped + `@rennet` scope |
| Bundle identifier | `dev.rennet.app` (reverse DNS off a domain actually owned) |
| CLI binary | `rennet` |
| Mood board | Flip `?name=` default from `digestif` to `rennet` in `index.html` (line 152) and `app.js` (line 10, 13); then **remove the toggle entirely**, because a shipped identity with an A/B switch in it is not a shipped identity |
| Wordmark tokens | Apply the two glyph corrections from section 1a; delete the Digestif glyph and `.wm-digestif` rules from `app.js` and `screens.css` |
| Historical filenames | Rename remaining Wingman-prefixed files in one link-safe pass only when historical evidence names no longer need stability |
| Beads | Retitle open beads from "Wingman" to "Rennet" in the same pass |

### Outcome B: Digestif (historical, closed)

| Artefact | Change |
|---|---|
| Domain | Register `digestif.dev`. **`digestif.app` is gone**, so decide the mobile companion's address now, not later: `digestif.dev/mobile` or a second domain |
| Repo | `github.com/digestif-dev/digestif` or similar; `digestif` user handle is a 2016 squat |
| npm | `@digestif` scope only; unscoped `digestif` is a live SHA2 hash package |
| Bundle identifier | `dev.digestif.app` |
| Wordmark | Adopt the Glass sans treatment as the only one, keep the amber tittle, **drop the circle glyph** and use a `d` lettermark for the icon |
| Everything else | As Outcome A, name substituted |

Plus two things to accept knowingly: a live USPTO Class 5 mark proceeding to registration (different class, non-zero adjacency if the product ever markets on anything health-shaped), and an alcohol referent in a working life embedded at an airline.

### Outcome C: reopen (historical, closed)

Cheaper than it looks, and worth saying so, because the fear of a reopen is usually what makes people settle badly.

**Historical estimate only:** the Glass system, tokens, positioning frame, voice guide, launch plan, site structure, and namespace method survived. The old seven-screen/five-angle claim did not: the prototype and angle copy require the Rennet six-angle refresh.

**What a fifth round should be told, given four rounds of evidence:** the artefact register failed (round 1), the relationship register failed (round 2), the act register failed (round 3), and the digestion register produced two finalists that both survived diligence (round 4). So the register is not the problem any more. The remaining constraint is that plain single-word English is exhausted at `.dev`, which means anything clean is a compound or an unusual word. A fifth round should therefore search compounds inside the digestion and separation register, not a new register, and it should be time-boxed to one pass.

**And the thing worth saying plainly:** Rennet passed a real diligence gate that Digestif did not, and the `.com` it failed to get is the asset that matters least for an open-source desktop app with a paid mobile companion. Reopening because a condition was written against the wrong asset is a worse reason than any of the four rounds produced.

---

## Open questions / refinement hooks

1. **Does the tagline sit under the wordmark or replace it in the masthead?** "A review harness" is strongest as the only line, which argues for wordmark and tagline never appearing together outside the site header.
2. **Does the split-disc glyph hold at 16px once the gap is a real cut?** Needs one render at 16, 32, 64, 512 before it is committed. This is the only thing in section 1a that could fail on contact.
3. **Does the amber tittle survive the ratified "functional colour only" rule?** In Digestif it spends the blast-radius hue on a logo. Defensible (a logo is not a UI surface) but it should be a decision, not a drift.
4. **Should the landing page import tokens from the app repo, or vendor a snapshot?** Live import prevents drift but couples the site build to the app repo. A submodule or a copied file with a CI check are both fine; pick one before the second page exists.
5. **Does the build log start now or at dogfood-v1?** Now is more honest and produces launch material; now also creates a public artefact for a product with no name yet.
6. **Where does the name explanation live?** Once, in the footer, is the plan. The alternative is an About page nobody reads. The referent should never appear in the app itself.
7. **Is there a CLI at all in v1?** Items 8 and 12 in the checklist (`.sh`, Homebrew formula) only make sense if there is. The product shape is a desktop app; a CLI may be a later extension surface (Q15, still open).
8. **Bright-room scheme on the site:** does the landing page follow system appearance, or is it dark-only for the identity? The product has not decided this either (open item in [[Code Review App Design Directions]]); the site should not decide it first.

## Bead candidates

Registration items are **RAI-ONLY**: they involve spending money and creating accounts, and are Rai's own actions.

| Title | Description | Priority | Depends on |
|---|---|---|---|
| **RAI-ONLY: register `rennet.dev` + `rennet.app`** | Check the premium tier at Porkbun or Cloudflare's search box first (RDAP does not expose it), then register both. Avoid Namecheap. Est. $20 total first year. | P0 | Rai's name answer |
| **RAI-ONLY: claim GitHub org `rennet-dev`** | `github.com/rennet` is a live squat (1 repo, profile touched 2026-07-15). `rennet-dev` is free and reads correctly against the domain. Claim before announcing anything. | P0 | Rai's name answer |
| **RAI-ONLY: claim npm `rennet` + `@rennet` scope** | Unscoped `rennet` verified free via registry API. The org scope could not be verified programmatically (npmjs 403s); check it by hand while signed in and claim both. | P0 | Rai's name answer |
| **RAI-ONLY: claim `@rennetdev` on X and `@rennet.dev` on Bluesky** | `@rennet` taken on both platforms. `@rennetdev` free on X (verified with a calibrated 404 control). Bluesky handle comes free with the domain via DNS verification. | P1 | domain registered |
| Apply the two wordmark corrections to the mood board glyph | In `prototypes/moodboard/assets/app.js`: widen the split to a hairline cut, recolour the open arc to `--private` with the system inner glow. Render at 16/32/64/512 to confirm it survives. | P1 | Rai's name answer |
| Flip the mood board name default and remove the toggle | `index.html` line 152 and `app.js` lines 10/13. Then delete the losing name's glyph and `.wm-*` rules. A shipped identity should not carry an A/B switch. | P1 | Rai's name answer |
| Build the pre-launch status page | Sections 1, 2, 4, 10 plus one screenshot and a dated build log with an Atom feed. Vite + TS + hand HTML, importing the app's `tokens.css`. Deploy to Cloudflare Pages. No email capture, no form. | P1 | domain registered |
| Write the three objection answers, verbatim | GitHub-workflow, AI-reviewing-AI, just-prompt-it-yourself. Needed for both the landing page section 9 and the Show HN thread. Writing them cold beats writing them at 15:40 on launch day. | P2 | — |
| Define and instrument the dogfood-v1 gate | Four consecutive working weeks reviewing every PR in the app rather than GitHub's UI, with fallbacks logged by class. The gate must be able to fail or it is not a gate. | P1 | app runnable |
| Historical-name cleanup, single commit | Rename remaining Wingman-prefixed docs and work items with a repository-wide link sweep. Do it once, at the end. | P3 | name locked and stable |
| **RAI-ONLY: calendar reminder 2027-01-15, re-check `rennet.com`** | Expiry is 2026-10-31 but that is a renewal date; realistic availability, if it ever lapses, is ~mid-January 2027 after grace, redemption and pending-delete. Backorder via DropCatch or NameJet is $59-79 on catch only. Recommendation: watch, do not plan around it. | P3 | — |
| **RAI-ONLY: Apple Developer Program enrolment** | £79/$99 per year, needed for macOS notarization and the paid mobile companion, and the only way to check App Store name availability. Do not enrol before there is something to notarize. | P2 | dogfood-v1 |
