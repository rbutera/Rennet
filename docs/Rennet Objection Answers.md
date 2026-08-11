---
tags: [rennet, branding, launch]
categories: [reference]
status: active
created: 2026-08-11
updated: 2026-08-11
related: ["[[Rennet Product and Vision]]", "[[Wingman Branding Plan]]"]
---

# Rennet Objection Answers

The three objections, answered cold. These will be the top three comments on the Show HN thread in some order, and they are section 9 of the full landing page (Branding Plan §2, §9). Written now, deliberately, not at 15:40 on launch day under pressure. Voice: plain, technical, no marketing. Grounded in [[Rennet Product and Vision]] §1 to §4.

Positioning is settled and does not change here: lead with the confession (you cannot honestly say you read the PRs your agents open), never with "makes 3,000-line PRs pleasant."

---

## "Taking review out of GitHub is a dealbreaker"

It does not take review out of GitHub. When you review someone else's PR, your dispositions publish as one normal GitHub review: the same comments, the same threads, the same approve or request-changes, landing on the PR where your team already reads them. Nothing moves to a separate system your teammates have to log into. Rennet is where you do the reading and the deciding; GitHub is still where the review lands.

The only thing that changes is the surface you read on before you sign. GitHub's diff view hands you a flat list of changed files in path order. Rennet groups the change into cohorts you can understand as one thing, orders them so you can follow the change from base principles up, and surfaces the decisions the author or their agent made so you can answer for them. Then it posts a plain GitHub review. Your teammates never have to know you used it.

## "AI reviewing AI is circular"

The models do not review. You review. The models are instruments: they read the change, propose structure, and surface disagreement. None of that is a verdict, and the product never claims it found a bug, reviewed anything, or approved a line.

The circular version of this is one model rubber-stamping another model's output, and that is the exact thing Rennet refuses to do. It runs more than one harness over the same change and shows you where they disagree, because the disagreement is the signal worth your attention. Two instruments concurring is weak evidence; two instruments splitting is a call that lands on your desk. And the human is the gate structurally, not by policy: no comment posts, no approval lands, nothing another person sees, without an explicit act of yours. Take the models away entirely and the reading order, the cohorts, and the decision log still stand on their own. The inference is an input to your judgement, never a replacement for it.

## "Just prompt the model yourself"

You can, and if that worked you would already be doing it. The inference is the cheap part. What you cannot prompt your way to is the state: which of eleven chunks you have actually read, which decisions you have answered for, what is still unlooked-at, and a finished review you can hand to GitHub or back to a coding agent as one batched act. That state is the interface and the data model, and that is the product.

Rennet is bring-your-own-key. It drives the harnesses already installed on your machine, on your own account, at no per-token markup, so this objection cuts the other way: the honest version is "just do the bookkeeping yourself too," and the bookkeeping is the work. A prompt gives you a wall of text you scroll once and lose. Rennet gives you read state that survives a force-push, decisions rolled up so not one of them is hidden, and a signed verdict you previewed line for line before it left your machine.
