import { basename } from "node:path";
import {
  buildForgeReviewPost,
  canonicalPrSubmissionPayload,
  canonicalReviewPayload,
  isRepoRelativePath,
  resolveReviewEvent,
  reviewBodyNotesFromProjection,
  reviewCommentsFromProjection,
} from "@rennet/core";
import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import {
  assertCompositionFresh,
  type CommandHandler,
  type DispatchRuntime,
  publishCompositionId,
  toForgeReviewTarget,
} from "./runtime";

export function publishHandlers(rt: DispatchRuntime) {
  const {
    deps,
    requireReviewById,
    assertTargetIsReviewOwn,
    assertAllowedRepository,
    activePatchsetOf,
    realPostInFlight,
    clearPublishReady,
    raisePublishReady,
  } = rt;
  return {
    "publish.review": async (rawInput) => {
      const name = "publish.review" as const;
      // The FIRST real egress: a decomposed review leaving the machine onto a PR AS
      // THE USER. Every dangerous part is gated here; the pipeline has no other path
      // to egress (this command is reachable only from the trusted renderer origin).
      const input = parseCommandInput(name, rawInput);
      // The body stratum defaults to none (B11 finding 2) — a client that sends only line
      // comments is unchanged. Localised so the checks + post-build read one non-optional value.
      const bodyNotes = input.bodyNotes ?? [];

      // (0) The RETROSPECTIVE gate (Rule 75, most-permissive-fault): a review opened
      // read-only over an already-merged/any PR must NEVER egress. We resolve the
      // addressed review from the persisted store (the latest, same authority the
      // consent-minting and canvases paths use) and refuse the WHOLE command — dry
      // run included — before any request is built. This is the structural half: the
      // renderer also hides the sign affordance, but even a hand-crafted call cannot
      // post from a retrospective review, in ANY permission mode, because this runs
      // ahead of the mode/consent branch entirely. A single fault (forged mode,
      // replayed token, renderer bug) cannot clear it — it is not on that circuit.
      const addressed = requireReviewById(input.reviewId);
      if (addressed.retrospective) {
        throw new Error(
          "Publish refused: this is a retrospective review — it is read-only and nothing can be posted.",
        );
      }
      // The verdict that will actually ship, resolved the SAME way the post builds it below
      // (`buildForgeReviewPost` → `resolveReviewEvent`): an explicit verdict wins, else it
      // derives from the outbound set. It rides into the compose binding, so a verdict swapped
      // in between preview and post is caught as stale.
      const resolvedVerdict = resolveReviewEvent([...input.comments, ...bodyNotes], input.verdict);
      // Compose-binding integrity (#382 M2 finding 2): a daemon-composed artifact carries its
      // binding; recompute it from the CURRENT review and refuse a stale/cross-review post
      // (dry-run included, so the fault surfaces as a refusal rather than a plausible request).
      // The VERDICT is folded in, so "what you previewed is what posts" covers the event too —
      // an APPROVE cannot be swapped onto a preview the reviewer read as a COMMENT.
      assertCompositionFresh(
        addressed,
        "review",
        input.payload,
        input.compositionId,
        deps.askLog.readProjection(addressed.id),
        resolvedVerdict,
      );

      const target = toForgeReviewTarget(input.target);

      // (1) Egress-side "what you see is what leaves" (R33), the MAIN analogue of
      // the #106 UI gate: the canonical bytes re-derived from `comments` must equal
      // the signed `payload` EXACTLY (===, never prefix/substring). A disagreement
      // fails CLOSED. This runs on dry-run TOO, so a corrupt payload surfaces as a
      // refusal rather than a plausible-looking request.
      // The canonical bytes fold in BOTH strata — line comments AND body notes (B11 finding
      // 2) — so a pathless ask is part of the round-trip, not a silent drop.
      if (canonicalReviewPayload(input.comments, bodyNotes) !== input.payload) {
        throw new Error("Publish refused: the review payload does not match its content");
      }
      // (2) An empty review is not a valid egress — refuse rather than post nothing. Empty
      // means NEITHER a line comment NOR a body note (a body-only review still posts).
      if (input.comments.length === 0 && bodyNotes.length === 0) {
        throw new Error("Publish refused: the review has no content");
      }

      // (3) Assemble the forge-neutral post (event COMMENT — no APPROVE shape; every
      // no-line fold + body note ledgered, never a silent drop).
      const post = buildForgeReviewPost(input.comments, {
        reviewId: input.reviewId,
        target,
        payload: input.payload,
        capabilities: deps.publishPort.capabilities,
        bodyNotes,
        // Derive-first, overridable: an explicit verdict wins; else it derives from
        // the dispositions. `undefined` simply defers to the derived verdict.
        ...(input.verdict ? { verdict: input.verdict } : {}),
      });

      if (input.dryRun === false) {
        // (4) REAL egress. The user's click on Post IS the authorization — there is no
        // token, no dialog, nothing to clear (Rule Zero, #435). What survives here are
        // the correctness checks, all of which run before anything leaves.
        //
        // (4a) TARGET-BINDING gate (most-permissive-fault): the post must target the
        // review's OWN pull request. A local capture (no postTarget) or a mismatched
        // target is refused, so a post can never land on an arbitrary PR — it runs on
        // the same authority (`addressed.postTarget`) the retrospective gate does.
        assertTargetIsReviewOwn(addressed, target);
        // (4b) Single-flight by marker (double-sign race): refuse a concurrent real
        // post of the same content while the first is still in flight, so two
        // near-simultaneous signs cannot both pass the adapter's query-before-post
        // check and double-post. A sequential retry (first already resolved) is not
        // in the set and relies on the adapter's marker idempotency instead.
        if (realPostInFlight.has(post.marker)) {
          throw new Error("Publish refused: a publish for this review is already in progress.");
        }
        realPostInFlight.add(post.marker);
        try {
          const outcome = await deps.publishPort.publishReview(post);
          // The post landed — clear any publish-ready attention on this review everywhere
          // (#382 M2). The taxonomy clears publish-ready on the post happening, from any client.
          clearPublishReady(input.reviewId);
          return parseCommandOutput(name, {
            dryRun: false,
            request: deps.publishPort.buildReviewRequest(post),
            marker: post.marker,
            ledger: post.ledger,
            outcome,
          });
        } finally {
          realPostInFlight.delete(post.marker);
        }
      }

      // Dry-run (the default): construct + return the EXACT request, post NOTHING.
      return parseCommandOutput(name, {
        dryRun: true,
        request: deps.publishPort.buildReviewRequest(post),
        marker: post.marker,
        ledger: post.ledger,
        outcome: null,
      });
    },
    "publish.submitPr": async (rawInput) => {
      const name = "publish.submitPr" as const;
      // The own-branch submission (issue #257 / #107): push the review's own branch
      // and open a real PR. The sign-click is the whole authorization — pushing your
      // own branch is not publishing (AGENTS.md).
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      assertAllowedRepository(review.repositoryRoot);

      // (0) A retrospective review is read-only over a merged/any PR — there is no
      // own branch to submit. Refuse the whole command, matching the review egress.
      if (review.retrospective) {
        throw new Error(
          "Submit refused: this is a retrospective review — it is read-only and has no branch to open a PR from.",
        );
      }

      // (1) "What you see is what leaves" (R33): the canonical bytes re-derived from
      // `submission` must equal the signed `payload` EXACTLY. A disagreement fails
      // CLOSED, so the PR that opens is exactly the one the paper previewed.
      if (canonicalPrSubmissionPayload(input.submission) !== input.payload) {
        throw new Error("Submit refused: the PR submission payload does not match its content");
      }
      // Compose-binding integrity (#382 M2 finding 2): a daemon-composed submission carries its
      // binding; recompute it over the posted payload + current patchset and refuse a
      // cross-review or advanced-patchset (stale) submission before pushing anything.
      assertCompositionFresh(review, "pr", input.payload, input.compositionId);

      // (2) The head must be a real BRANCH ref (#107) — a detached HEAD has no branch
      // to open a PR from. MAIN is authoritative on the branch to push: the persisted
      // provenance's `headRef`, which must match the previewed `submission.head`
      // (else the paper showed a head that is not the review's own branch — a lie).
      const patchset = activePatchsetOf(review);
      const headRef = patchset.repository.headRef;
      if (headRef === undefined) {
        throw new Error(
          "Submit refused: HEAD is detached — there is no branch to push and open a pull request from.",
        );
      }
      if (input.submission.head !== headRef) {
        throw new Error("Submit refused: the PR head does not match the review's own branch.");
      }

      // (3) Push the branch + open the PR. Absent action ⇒ an honest failure, never a
      // fabricated success (no coding harness / no auth composed it).
      if (!deps.submitPullRequest) {
        throw new Error(
          "Submit refused: no GitHub PR submission is available (authentication or the coding harness is not configured).",
        );
      }
      const outcome = await deps.submitPullRequest({
        repoRoot: patchset.repository.root,
        headRef,
        submission: input.submission,
      });
      // The PR opened (or was reused) — clear any publish-ready attention on this review
      // everywhere (#382 M2), the same clear-on-post the review egress does.
      clearPublishReady(review.id);
      return parseCommandOutput(name, outcome);
    },
    "publish.compose": async (rawInput) => {
      const name = "publish.compose" as const;
      // A projected client (the phone) cannot compose the byte-exact payload — the DOM ui
      // layer owns the editable collation model and the mobile boundary forbids importing it.
      // So the DAEMON composes it (core is node-free and in-boundary here) and the phone POSTS
      // exactly these bytes. `mode` selects the loop; a mode that does not fit the review is
      // honestly `unavailable`. Finding C ruling (a): BOTH loops end on the phone.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      if (review.retrospective) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "This is a retrospective review — it is read-only and posts nothing.",
        });
      }

      // The durable ask projection is the living-draft authority (B11 cluster 3): both exit
      // modes source their outbound composition from it, keyed by the review's id (the ask
      // log's session id — the contract the client honours when it calls `ask.*`). It
      // supersedes `review.dispositions` as the compose source; the post commands re-derive
      // the same bytes off the same projection, so the round-trip stays single-source.
      const projection = deps.askLog.readProjection(review.id);

      if (input.mode === "review") {
        // A team-PR review posts a review event to a real PR. Only a review with a postTarget
        // can post one; a branch-only capture has no PR to comment on (it opens a PR instead).
        if (!review.postTarget) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason:
              "This review has no pull request to post to — open one from the own-branch flow instead.",
          });
        }
        // Compose the DEFAULT (unedited) comments from the durable ask projection — the phone
        // does not edit (publish decision 4), so the default IS the product. The payload and
        // verdict are core's, so publish.review re-verifies these very bytes (single-source).
        const comments = reviewCommentsFromProjection(projection);
        // The BODY stratum (B11 finding 2): pathless/prose asks that have no diff line travel in
        // the review body rather than vanishing. `reviewCommentsFromProjection` +
        // `reviewBodyNotesFromProjection` PARTITION the staged asks, so each appears exactly once.
        const bodyNotes = reviewBodyNotesFromProjection(projection);
        // Path safety at compose (#382 M2 finding 8): refuse to compose an outbound review whose
        // comments carry an absolute or traversing path — such a path would post outside the
        // repo (or is corruption). Ingestion (`canvas.disposition`) already rejects them; this is
        // the defence-in-depth at the egress boundary.
        const badPath = comments.find((c) => !isRepoRelativePath(c.path));
        if (badPath) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: `A review comment has an unsafe path (${badPath.path}); it cannot be posted.`,
          });
        }
        const payload = canonicalReviewPayload(comments, bodyNotes);
        // Derive-first, overridable: the projection's explicit `verdictOverride` WINS; a null
        // override defers to the verdict derived from the WHOLE outbound set (comments + body
        // notes), so a prose request-change escalates the verdict too (R33).
        const verdict = resolveReviewEvent(
          [...comments, ...bodyNotes],
          projection.verdictOverride ?? undefined,
        );
        const target = review.postTarget;
        const destination = `${target.repo.owner}/${target.repo.name}#${target.number}`;
        const compositionId = publishCompositionId({
          reviewId: review.id,
          patchsetId: review.activePatchsetId,
          mode: "review",
          payload,
          // The previewed VERDICT rides in the binding: `publish.review` recomputes it from the
          // verdict it is about to post, so posting a different event than the one previewed is
          // refused as stale. This is the whole preview-equals-post guarantee for the event.
          verdict,
        });
        // A composed draft is now ready to post (#382 M2, both modes): raise publish-ready so
        // an away client learns it and deep-links to the preview. Idempotent by derived id.
        raisePublishReady(review, destination, destination);
        return parseCommandOutput(name, {
          status: "review",
          comments,
          bodyNotes,
          payload,
          verdict,
          destination,
          title: destination,
          compositionId,
        });
      }

      // input.mode === "pr": the own-branch submission. A team-PR review posts a review, not a
      // new PR; refuse "pr" there so the caller uses "review".
      if (review.postTarget) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason:
            'This is a team-PR review — post it as a review (mode "review"), not a new pull request.',
        });
      }
      const patchset = activePatchsetOf(review);
      const headRef = patchset.repository.headRef;
      if (headRef === undefined) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "HEAD is detached — there is no branch to open a pull request from.",
        });
      }
      const base = patchset.repository.baseRef;
      // Draft the PR body (daemon-composed) when a drafter is wired; else a deterministic
      // title/body. Either way the payload is derived from the SAME submission returned, so
      // publish.submitPr round-trips it exactly (self-consistent, R33-honest).
      // Feed the durable ask set into the PR-body drafter as its dispositions (B11 cluster 3):
      // each staged ask is a `{ type, path, resolution }` drafting fact (the `:line` suffix
      // trimmed to the bare path — drafting material for the model prompt, never egress). The
      // verdict override is a GitHub review event and has no PR-body sink, so it does not ride
      // here. `draftPrBody` produces text into a preview; it posts nothing (R33).
      const drafted = deps.draftPrBody
        ? await deps.draftPrBody({
            review,
            base,
            head: headRef,
            dispositions: Object.values(projection.stagedAsks).map((ask) => ({
              type: ask.type,
              path: ask.anchor.replace(/:\d+$/, ""),
              resolution: ask.body,
            })),
          })
        : undefined;
      const title = drafted?.status === "drafted" ? drafted.title : headRef;
      const body = drafted?.status === "drafted" ? drafted.body : "";
      const submission = { title, body, base, head: headRef, draft: true };
      const payload = canonicalPrSubmissionPayload(submission);
      const destination = `${basename(review.repositoryRoot)}:${headRef} → ${base}`;
      const compositionId = publishCompositionId({
        reviewId: review.id,
        patchsetId: review.activePatchsetId,
        mode: "pr",
        payload,
      });
      // A composed own-branch draft is now ready to post (#382 M2, both modes): raise
      // publish-ready. Idempotent by derived id with the review.draftPrBody raise.
      raisePublishReady(review, destination, title);
      return parseCommandOutput(name, {
        status: "pr",
        submission,
        payload,
        destination,
        title,
        compositionId,
      });
    },
  } satisfies Record<string, CommandHandler>;
}
