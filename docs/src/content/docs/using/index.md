---
title: Using Rennet
description: Guides and concepts for people who use Rennet to understand and sign code reviews.
---

Rennet helps you turn a large local change or GitHub pull request into a review
you can understand and stand behind. Start with the short tour, then follow the
path that matches the change in front of you.

## Start here

- [Getting started](/using/guide/getting-started/) — the shortest useful tour.
- [Reviewing a GitHub PR](/using/guide/reviewing-a-github-pr/) — the live team-review path end to end.
- [User journey](/using/guide/user-journey/) — the full intended road from project to signed paper.

## Understand the product

- [Product and vision](/using/concepts/product-and-vision/) — why Rennet exists and how the two review modes fit together.
- [Common questions](/using/concepts/common-questions/) — GitHub, model judgment, credentials, local-first behavior, and the own-branch loop.

```mermaid
flowchart LR
  yours[Your branch] --> review[One Rennet review engine]
  team[Team pull request] --> review
  review --> paper[Your signed paper]
  paper --> github[GitHub review]
  paper --> agent[Coding-agent handoff]
```

Both routes are live end to end. Team work becomes a signed GitHub review. Your
own branch becomes a write-enabled coding-agent handoff, a successor delta
review, and a signed push-plus-PR submission.
