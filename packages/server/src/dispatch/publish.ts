import {
  buildForgeReviewPost,
  canonicalPrSubmissionPayload,
  canonicalReviewPayload,
  forgeReviewPostDescriptor,
  isRepoRelativePath,
  resolveComposedReviewEvent,
  reviewBodyNotesFromProjection,
  reviewCommentsFromProjection,
  reviewOpenerSourceId,
} from "@rennet/core";
import {
  type AskProjection,
  currentGenerationId,
  LENS_KINDS,
  parseCommandInput,
  parseCommandOutput,
  type Review,
  sameForgeRepository,
} from "@rennet/protocol";
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
    assertAllowedRepository,
    activePatchsetOf,
    realPostInFlight,
    clearPublishReady,
    raisePublishReady,
  } = rt;
  const reviewCompositionEvidence = async (review: Review, projection: AskProjection) => {
    const activePatchset = activePatchsetOf(review);
    const comments = reviewCommentsFromProjection(projection, activePatchset);
    const bodyNotes = reviewBodyNotesFromProjection(projection, activePatchset);
    const verdict = resolveComposedReviewEvent(
      [...comments, ...bodyNotes],
      projection.verdictOverride ?? undefined,
    );
    const generation = currentGenerationId(
      deps.roundRecordsForReview?.(review.id) ?? [],
      review.activePatchsetId,
    );
    const boardEvidence = deps.compositionBoardsForReview
      ? await deps.compositionBoardsForReview(review.id, generation)
      : {
          status: "settled" as const,
          boards: deps.lensBoardForReview
            ? (
                await Promise.all(
                  LENS_KINDS.map((lens) => deps.lensBoardForReview?.(review.id, generation, lens)),
                )
              ).filter((board) => board !== undefined)
            : [],
        };
    if (boardEvidence.status !== "settled") {
      return {
        status: "unavailable" as const,
        reason:
          boardEvidence.status === "drafting"
            ? "The current review boards are still drafting."
            : boardEvidence.reason,
        ...(boardEvidence.status === "drafting" ? { retryable: true as const } : {}),
      };
    }
    const boards = boardEvidence.boards;
    const draft = {
      verdict,
      boards,
      projection,
      changedPaths: activePatchset.files.map((file) => file.path),
    };
    return {
      status: "ready" as const,
      comments,
      bodyNotes,
      verdict,
      draft,
      sourceId: reviewOpenerSourceId(review.id, review.activePatchsetId, draft),
    };
  };
  return {
    "publish.review": async (rawInput) => {
      const name = "publish.review" as const;
      // The first real egress: a decomposed review leaving the machine onto a PR as
      // the user. The pipeline has no other post path.
      const input = parseCommandInput(name, rawInput);

      // A retrospective review describes an already-finished PR, so it has no valid
      // post operation. Resolve that fact from the persisted review, not the client.
      const addressed = requireReviewById(input.reviewId);
      if (addressed.retrospective) {
        throw new Error(
          "Publish refused: this is a retrospective review — it is read-only and nothing can be posted.",
        );
      }
      if (!addressed.postTarget) {
        throw new Error(
          "Publish refused: this review has no pull request to post to (a local capture cannot be posted).",
        );
      }
      if (addressed.postTarget.viewerDidAuthor) {
        throw new Error(
          "Publish refused: this is your existing pull request; continue its review rounds instead.",
        );
      }
      const publishPort = deps.publishPortFor(addressed.postTarget.repo, addressed.repositoryRoot);
      if (publishPort === undefined) {
        throw new Error(
          `Publish refused: no review publisher is registered for forge "${addressed.postTarget.repo.forge}".`,
        );
      }
      const projection = deps.askLog.readProjection(addressed.id);
      const evidence = await reviewCompositionEvidence(addressed, projection);
      if (evidence.status === "unavailable") {
        throw new Error(`Publish refused: ${evidence.reason}`);
      }

      // Board recovery/reads above can await model and disk work. Re-read the two mutable
      // authorities after that await so an ask/verdict edit or regenerate that landed while it
      // was held cannot pass against the earlier snapshot and post obsolete reviewer intent.
      const current = requireReviewById(input.reviewId);
      if (
        current.retrospective ||
        !current.postTarget ||
        current.postTarget.viewerDidAuthor ||
        JSON.stringify(current.postTarget) !== JSON.stringify(addressed.postTarget)
      ) {
        throw new Error(
          "Publish refused: this review's pull-request destination changed while the preview was checked.",
        );
      }
      const currentProjection = deps.askLog.readProjection(current.id);
      const currentPatchset = activePatchsetOf(current);
      const currentComments = reviewCommentsFromProjection(currentProjection, currentPatchset);
      const currentBodyNotes = reviewBodyNotesFromProjection(currentProjection, currentPatchset);
      const currentVerdict = resolveComposedReviewEvent(
        [...currentComments, ...currentBodyNotes],
        currentProjection.verdictOverride ?? undefined,
      );
      const currentDraft = {
        verdict: currentVerdict,
        boards: evidence.draft.boards,
        projection: currentProjection,
        changedPaths: currentPatchset.files.map((file) => file.path),
      };
      const currentSourceId = reviewOpenerSourceId(
        current.id,
        current.activePatchsetId,
        currentDraft,
      );
      const target = toForgeReviewTarget(current.postTarget);

      // (1) Egress-side "what you see is what leaves" (R33): the canonical bytes re-derived
      // from the artifact must equal the signed `payload` EXACTLY (===, never
      // prefix/substring). This runs on dry-run TOO, so a corrupt payload surfaces as a
      // refusal rather than a plausible-looking request.
      // The canonical bytes fold in the authored opener plus BOTH comment strata, so a pathless
      // ask or opener mutation is part of the round-trip, not a silent post-time rewrite.
      if (canonicalReviewPayload(input.artifact) !== input.payload) {
        throw new Error("Publish refused: the review payload does not match its content");
      }

      // Compose-binding integrity (#382 M2 finding 2): a daemon-composed artifact carries its
      // binding; recompute it from the CURRENT review and refuse a stale/cross-review post
      // (dry-run included, so the fault surfaces as a refusal rather than a plausible request).
      // The VERDICT is folded in, so "what you previewed is what posts" covers the event too —
      // an APPROVE cannot be swapped onto a preview the reviewer read as a COMMENT.
      assertCompositionFresh(current, input.payload, input.compositionId, {
        mode: "review",
        reviewProjection: currentProjection,
        verdict: input.post.event,
        opener: input.artifact.opener,
        openerSourceId: currentSourceId,
      });

      // (2) Rebuild the forge-neutral post and compare the exact signed descriptor before any
      // egress. Approve with zero asks is valid because the required grounded opener is content.
      const post = buildForgeReviewPost(input.artifact, {
        reviewId: input.reviewId,
        target,
        payload: input.payload,
        capabilities: publishPort.capabilities,
        verdict: input.post.event,
      });
      if (JSON.stringify(forgeReviewPostDescriptor(post)) !== JSON.stringify(input.post)) {
        throw new Error("Publish refused: the signed review post does not match its content");
      }

      if (input.dryRun === false) {
        // (3) REAL egress. The user's click on Post IS the authorization — there is no
        // token, no dialog, nothing to clear (Rule Zero, #435). What survives here are
        // the correctness checks, all of which run before anything leaves.
        //
        // (3a) Single-flight by marker (double-sign race): refuse a concurrent real
        // post of the same content while the first is still in flight, so two
        // near-simultaneous signs cannot both pass the adapter's query-before-post
        // check and double-post. A sequential retry (first already resolved) is not
        // in the set and relies on the adapter's marker idempotency instead.
        const durableReceipt = deps.publishReceipts.read(input.reviewId, post.marker);
        if (durableReceipt.status === "malformed") {
          throw new Error(`Publish receipt could not be read: ${durableReceipt.reason}`);
        }
        if (durableReceipt.status === "stored") {
          clearPublishReady(input.reviewId);
          return parseCommandOutput(name, {
            dryRun: false,
            request: publishPort.buildReviewRequest(post),
            marker: post.marker,
            ledger: post.ledger,
            outcome: {
              reviewRef: durableReceipt.value.reviewRef,
              url: durableReceipt.value.url,
              reused: true,
            },
          });
        }
        if (realPostInFlight.has(post.marker)) {
          throw new Error("Publish refused: a publish for this review is already in progress.");
        }
        realPostInFlight.add(post.marker);
        try {
          const outcome = await publishPort.publishReview(post);
          const persisted = deps.publishReceipts.save({
            reviewId: input.reviewId,
            marker: post.marker,
            verdict: post.event,
            lineCommentCount: post.threads.length,
            reviewRef: outcome.reviewRef,
            url: outcome.url,
          });
          if (persisted.status !== "stored") {
            throw new Error(
              persisted.status === "malformed"
                ? `Publish receipt could not be saved: ${persisted.reason}`
                : "Publish receipt could not be saved.",
            );
          }
          // The post landed — clear any publish-ready attention on this review everywhere
          // (#382 M2). The taxonomy clears publish-ready on the post happening, from any client.
          clearPublishReady(input.reviewId);
          return parseCommandOutput(name, {
            dryRun: false,
            request: publishPort.buildReviewRequest(post),
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
        request: publishPort.buildReviewRequest(post),
        marker: post.marker,
        ledger: post.ledger,
        outcome: null,
      });
    },
    "publish.receipt": async (rawInput) => {
      const name = "publish.receipt" as const;
      const input = parseCommandInput(name, rawInput);
      requireReviewById(input.reviewId);
      const stored = deps.publishReceipts.read(input.reviewId, input.marker);
      if (stored.status === "malformed") {
        throw new Error(`Publish receipt could not be read: ${stored.reason}`);
      }
      return parseCommandOutput(
        name,
        stored.status === "missing"
          ? { status: "missing" }
          : {
              status: "posted",
              receipt: {
                marker: stored.value.marker,
                verdict: stored.value.verdict,
                lineCommentCount: stored.value.lineCommentCount,
                reviewRef: stored.value.reviewRef,
                url: stored.value.url,
              },
            },
      );
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
      if (review.postTarget) {
        throw new Error(
          "Submit refused: this review already has a pull request; use its review or round flow instead.",
        );
      }

      const projection = deps.askLog.readProjection(review.id);
      const remainingAskCount = Object.keys(projection.stagedAsks).length;
      if (remainingAskCount > 0) {
        throw new Error(
          `Submit refused: ${remainingAskCount} staged ${
            remainingAskCount === 1 ? "ask remains" : "asks remain"
          }; finish the review round before opening the pull request.`,
        );
      }

      // (1) "What you see is what leaves" (R33): the canonical bytes re-derived from
      // `submission` must equal the signed `payload` EXACTLY. A disagreement fails
      // CLOSED, so the PR that opens is exactly the one the paper previewed.
      if (canonicalPrSubmissionPayload(input.submission) !== input.payload) {
        throw new Error("Submit refused: the PR submission payload does not match its content");
      }
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

      // (3) Resolve the effective push URL again immediately before mutation. The exact
      // provider-qualified target must still be the one the preview named; then the SAME
      // resolved object drives both the named-remote push and provider submission.
      if (!deps.resolvePullRequestDestination || !deps.submitPullRequest) {
        throw new Error(
          "Submit refused: no forge PR submission is available (authentication or the coding harness is not configured).",
        );
      }
      const destination = await deps.resolvePullRequestDestination(patchset.repository.root);
      if (destination === null) {
        throw new Error(
          "Submit refused: no supported forge destination is configured for this repository.",
        );
      }
      // Destination discovery can await git. Re-read the mutable review authorities after it
      // returns so an ask, recapture, or PR association that landed in flight cannot reach push
      // under the older ready snapshot.
      const current = requireReviewById(input.reviewId);
      if (
        current.retrospective ||
        current.postTarget !== undefined ||
        current.activePatchsetId !== review.activePatchsetId
      ) {
        throw new Error(
          "Submit refused: the review changed while its forge destination was being checked — recompose before submitting.",
        );
      }
      const currentProjection = deps.askLog.readProjection(current.id);
      const currentAskCount = Object.keys(currentProjection.stagedAsks).length;
      if (currentAskCount > 0) {
        throw new Error(
          `Submit refused: ${currentAskCount} staged ${
            currentAskCount === 1 ? "ask remains" : "asks remain"
          }; finish the review round before opening the pull request.`,
        );
      }
      if (
        input.target !== undefined &&
        !sameForgeRepository(destination.target.repo, input.target.repo)
      ) {
        throw new Error(
          "Submit refused: the forge destination changed after this preview was composed — recompose before submitting.",
        );
      }
      // Compose-binding integrity (#382 M2 finding 2): the provider-qualified repository is
      // part of the signed preview, alongside the payload and current patchset. A protocol-v2
      // client may omit the new field; in that case the freshly resolved target must reproduce
      // the target-bound digest, so remote drift still refuses before push.
      assertCompositionFresh(current, input.payload, input.compositionId, {
        mode: "pr",
        target: input.target ?? destination.target,
      });
      const outcome = await deps.submitPullRequest({
        repoRoot: patchset.repository.root,
        headRef,
        submission: input.submission,
        destination,
      });
      // The PR opened (or was reused) — clear any publish-ready attention on this review
      // everywhere (#382 M2), the same clear-on-post the review egress does.
      clearPublishReady(current.id);
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
        if (review.postTarget.viewerDidAuthor) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: "This is your existing pull request; continue its review rounds instead.",
          });
        }
        const publishPort = deps.publishPortFor(review.postTarget.repo, review.repositoryRoot);
        if (publishPort === undefined) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: `No review publisher is registered for forge "${review.postTarget.repo.forge}".`,
          });
        }
        // Compose the DEFAULT (unedited) comments from the durable ask projection — the phone
        // does not edit (publish decision 4), so the default IS the product. The payload and
        // verdict are core's, so publish.review re-verifies these very bytes (single-source).
        const evidence = await reviewCompositionEvidence(review, projection);
        if (evidence.status === "unavailable") {
          return parseCommandOutput(name, evidence);
        }
        const { comments, bodyNotes, verdict } = evidence;
        // The BODY stratum (B11 finding 2): pathless/prose asks that have no diff line travel in
        // the review body rather than vanishing. `reviewCommentsFromProjection` +
        // `reviewBodyNotesFromProjection` PARTITION the staged asks, so each appears exactly once.
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
        // Derive-first, overridable: the projection's explicit `verdictOverride` WINS; a null
        // override defers to the verdict derived from the WHOLE outbound set (comments + body
        // notes), so a prose request-change escalates the verdict too (R33).
        const target = review.postTarget;
        const destination = `${target.repo.owner}/${target.repo.name}#${target.number}`;
        if (!deps.draftReviewOpener) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: "Review opener drafting is not available on this daemon.",
          });
        }
        const opener = await deps.draftReviewOpener({
          review,
          draft: evidence.draft,
        });
        if (opener.status !== "drafted") {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: `Review opener drafting ${opener.status}: ${opener.reason}`,
            ...(opener.status === "failed" && opener.retryable === true ? { retryable: true } : {}),
          });
        }
        const current = requireReviewById(review.id);
        const currentProjection = deps.askLog.readProjection(review.id);
        const currentPatchset = activePatchsetOf(current);
        const currentComments = reviewCommentsFromProjection(currentProjection, currentPatchset);
        const currentBodyNotes = reviewBodyNotesFromProjection(currentProjection, currentPatchset);
        const currentVerdict = resolveComposedReviewEvent(
          [...currentComments, ...currentBodyNotes],
          currentProjection.verdictOverride ?? undefined,
        );
        const currentDraft = {
          verdict: currentVerdict,
          boards: evidence.draft.boards,
          projection: currentProjection,
          changedPaths: currentPatchset.files.map((file) => file.path),
        };
        const currentSourceId = reviewOpenerSourceId(
          current.id,
          current.activePatchsetId,
          currentDraft,
        );
        if (
          current.retrospective ||
          currentSourceId !== evidence.sourceId ||
          JSON.stringify(current.postTarget) !== JSON.stringify(review.postTarget)
        ) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: "The review changed while its outbound preview was composing.",
            retryable: true,
          });
        }
        const artifact = { opener: opener.opener, comments, bodyNotes };
        const payload = canonicalReviewPayload(artifact);
        const builtPost = buildForgeReviewPost(artifact, {
          reviewId: review.id,
          target: toForgeReviewTarget(target),
          payload,
          capabilities: publishPort.capabilities,
          verdict,
        });
        const post = forgeReviewPostDescriptor(builtPost);
        const compositionId = publishCompositionId({
          reviewId: review.id,
          patchsetId: review.activePatchsetId,
          mode: "review",
          payload,
          // The previewed VERDICT rides in the binding: `publish.review` recomputes it from the
          // verdict it is about to post, so posting a different event than the one previewed is
          // refused as stale. This is the whole preview-equals-post guarantee for the event.
          verdict: post.event,
          openerSourceId: evidence.sourceId,
        });
        // A composed draft is now ready to post (#382 M2, both modes): raise publish-ready so
        // an away client learns it and deep-links to the preview. Idempotent by derived id.
        raisePublishReady(review, destination, destination);
        return parseCommandOutput(name, {
          status: "review",
          artifact,
          post,
          ledger: builtPost.ledger,
          payload,
          destination,
          title: destination,
          compositionId,
          marker: builtPost.marker,
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
      const remainingAskCount = Object.keys(projection.stagedAsks).length;
      if (remainingAskCount > 0) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: `${remainingAskCount} staged ${
            remainingAskCount === 1 ? "ask remains" : "asks remain"
          }; finish the review round before opening the pull request.`,
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
      if (!deps.resolvePullRequestDestination) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "Pull-request destination discovery is not available on this daemon.",
        });
      }
      const resolvedDestination = await deps.resolvePullRequestDestination(
        patchset.repository.root,
      );
      if (resolvedDestination === null) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason:
            "No supported forge destination is configured for this repository, so there is nowhere to open a pull request.",
        });
      }
      // Draft the PR body (daemon-composed) when a drafter is wired; else a deterministic
      // title/body. Either way the payload is derived from the SAME submission returned, so
      // publish.submitPr round-trips it exactly (self-consistent, R33-honest).
      // PR readiness is server-owned above: a submission exists only after the durable staged-ask
      // set drains. The drafter therefore receives no unresolved dispositions; composing them
      // into a ready PR would let mobile (or a desktop still hydrating) skip the round contract.
      // `draftPrBody` produces text into a preview; it posts nothing (R33).
      const drafted = deps.draftPrBody
        ? await deps.draftPrBody({
            review,
            base,
            head: headRef,
            dispositions: [],
          })
        : undefined;
      const reviewAtDestinationCheck = requireReviewById(review.id);
      const currentPatchset = activePatchsetOf(reviewAtDestinationCheck);
      const currentDestination = await deps.resolvePullRequestDestination(
        currentPatchset.repository.root,
      );
      // Both drafting and destination discovery can await. Finalize readiness from a fresh
      // review and ask projection after the last await, immediately before raising attention.
      const current = requireReviewById(review.id);
      if (
        current.retrospective ||
        current.postTarget !== undefined ||
        current.activePatchsetId !== review.activePatchsetId
      ) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "The review changed while its pull-request preview was composing.",
          retryable: true,
        });
      }
      const currentAskCount = Object.keys(deps.askLog.readProjection(current.id).stagedAsks).length;
      if (currentAskCount > 0) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: `${currentAskCount} staged ${
            currentAskCount === 1 ? "ask remains" : "asks remain"
          }; finish the review round before opening the pull request.`,
        });
      }
      if (
        currentDestination === null ||
        !sameForgeRepository(currentDestination.target.repo, resolvedDestination.target.repo)
      ) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "The forge destination changed while its pull-request preview was composing.",
          retryable: true,
        });
      }
      const title = drafted?.status === "drafted" ? drafted.title : headRef;
      const body = drafted?.status === "drafted" ? drafted.body : "";
      const submission = { title, body, base, head: headRef, draft: true };
      const payload = canonicalPrSubmissionPayload(submission);
      const target = resolvedDestination.target;
      const destination = `${target.repo.forge}:${target.repo.owner}/${target.repo.name} · ${headRef} → ${base}`;
      const compositionId = publishCompositionId({
        reviewId: review.id,
        patchsetId: review.activePatchsetId,
        mode: "pr",
        payload,
        target,
      });
      // A composed own-branch draft is now ready to post (#382 M2, both modes): raise
      // publish-ready. Idempotent by derived id with the review.draftPrBody raise.
      raisePublishReady(current, destination, title);
      return parseCommandOutput(name, {
        status: "pr",
        submission,
        target,
        payload,
        destination,
        title,
        compositionId,
      });
    },
  } satisfies Record<string, CommandHandler>;
}
