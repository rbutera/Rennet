import { basename } from "node:path";
import {
  buildHandoffBundle,
  disclosureFor,
  isRepoRelativePath,
  mechanicalComposition,
  sessionContextRelativeDir,
  verifyComposedBundle,
  workOrderContextFile,
} from "@rennet/core";
import {
  type HandoffAskTrace,
  type HandoffRunResult,
  parseCommandInput,
  parseCommandOutput,
  type Review,
} from "@rennet/protocol";
import { writeSessionContext } from "../context-files";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function reviewHandlers(rt: DispatchRuntime) {
  const {
    service,
    deps,
    allowedRoots,
    repositoryExists,
    assertAllowedRepository,
    assertReviewRepository,
    requireReviewById,
    activePatchsetOf,
    raiseReviewFinished,
    raiseHandoffCompleted,
    raisePublishReady,
  } = rt;
  /**
   * The ONE key a review's context files live under (review finding 1): the session id the
   * archive purge is called with, resolved by the composition root. The handoff prompt
   * NAMES this directory and the work-order write below FILLS it, so both ends and the
   * purge agree by construction. Absent dep ⇒ the review id keys all three consistently.
   */
  const contextSessionIdFor = (review: Review): string =>
    deps.reviewContextSessionId?.(review) ?? review.id;
  const contextDirFor = (review: Review): string =>
    sessionContextRelativeDir(contextSessionIdFor(review));
  return {
    "review.capture": async (rawInput) => {
      const name = "review.capture" as const;
      const input = parseCommandInput(name, rawInput);
      assertAllowedRepository(input.repoPath);
      // Cleared BEFORE the capture, never after — the rule `checkFreshness` follows below.
      // On a RE-capture the root is already watched and settled, so an edit landing while
      // the capture runs is not in the new patchset; clearing afterwards would discard the
      // watcher's report of it and pin a review that was already behind.
      deps.setRepositoryDirty(false);
      const review = await service.capture(input.commandId, input.repoPath, input.reviewId);
      allowedRoots.add(review.repositoryRoot);
      deps.startWatching(review.repositoryRoot);
      raiseReviewFinished(review);
      deps.onReviewOpened?.(review);
      return parseCommandOutput(name, { review });
    },
    "review.openPr": async (rawInput) => {
      const name = "review.openPr" as const;
      // The GitHub PR front door. `repoPath`, when present, is the local clone the
      // renderer just picked (so it is already in allowedRoots); omitted — or not
      // actually a clone of the PR's repo — MAIN resolves a managed blobless clone
      // (clone-on-demand, #225) and the resolved root joins allowedRoots below.
      // The diff is taken locally against the PR's pinned OIDs. A PR review is a
      // snapshot, so it is NOT wired into the working-tree freshness watcher (the
      // renderer gates that off by patchset source) — nothing to watch here.
      const input = parseCommandInput(name, rawInput);
      if (input.repoPath !== undefined) assertAllowedRepository(input.repoPath);
      const review = await deps.openPullRequest(
        input.commandId,
        input.ref,
        input.repoPath,
        input.retrospective ?? false,
      );
      allowedRoots.add(review.repositoryRoot);
      raiseReviewFinished(review);
      deps.onReviewOpened?.(review);
      return parseCommandOutput(name, { review });
    },
    "review.load": async (rawInput) => {
      const name = "review.load" as const;
      // Reopen any persisted review by id (issue #324) — a PURE READ. Resolve by
      // id (plain "Review not found" otherwise); the review renders exactly as
      // persisted. `repositoryPresent` is the one fact the renderer needs to show
      // honest missing-context status and skip the freshness watcher. Only when
      // the root still exists do we grant + watch it (watching a missing path is
      // noise; an absent root also stays out of allowedRoots, so nothing
      // repo-touching can run against a path that isn't there — honesty about
      // capability, not a gate: the persisted review always returns).
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      const repositoryPresent = repositoryExists(review.repositoryRoot);
      if (repositoryPresent) {
        allowedRoots.add(review.repositoryRoot);
        deps.startWatching(review.repositoryRoot);
      }
      return parseCommandOutput(name, { review, repositoryPresent });
    },
    "review.prWorktree": async (rawInput) => {
      const name = "review.prWorktree" as const;
      // The reviewed PR's worktree + setup status (historical-PR review). A pure
      // read over MAIN's own worktree index and status files; `null` for a review
      // with no worktree.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { worktree: await deps.prWorktree(input.reviewId) });
    },
    "review.setDisposition": async (rawInput) => {
      const name = "review.setDisposition" as const;
      const input = parseCommandInput(name, rawInput);
      // Path safety at ingestion (#382 M2 finding 8): refuse an absolute or traversing path.
      if (!isRepoRelativePath(input.path)) {
        throw new Error(`Disposition refused: unsafe path (${input.path})`);
      }
      const review = service.setDisposition(
        input.commandId,
        input.reviewId,
        input.patchsetId,
        input.path,
        input.disposition,
        input.body,
      );
      return parseCommandOutput(name, { review });
    },
    "review.checkFreshness": async (rawInput) => {
      const name = "review.checkFreshness" as const;
      const input = parseCommandInput(name, rawInput);
      const current = requireReviewById(input.reviewId);
      assertReviewRepository(current, input.repoPath);
      if (!deps.isRepositoryDirty()) return parseCommandOutput(name, { review: current });
      // Clear BEFORE the diff, never after. A save landing while the diff runs may or
      // may not be in it, and clearing afterwards discards the watcher's report of it —
      // the same lost-save defect as #601 with a narrower window. Cleared first, that
      // save re-marks the tree dirty and the next ask picks it up.
      deps.setRepositoryDirty(false);
      const review = await service.checkFreshness(input.commandId, input.reviewId, input.repoPath);
      return parseCommandOutput(name, { review });
    },
    "review.regenerate": async (rawInput) => {
      const name = "review.regenerate" as const;
      const input = parseCommandInput(name, rawInput);
      assertAllowedRepository(input.repoPath);
      // Cleared before the recapture for the same reason as `checkFreshness` above: an
      // edit made while the review regenerates is NOT in the new patchset, so it must
      // survive as dirty rather than being cleared away by the regeneration that missed it.
      deps.setRepositoryDirty(false);
      const review = await service.regenerate(input.commandId, input.reviewId, input.repoPath);
      raiseReviewFinished(review);
      deps.onReviewOpened?.(review);
      return parseCommandOutput(name, { review });
    },
    "review.uiEvidence": async (rawInput) => {
      const name = "review.uiEvidence" as const;
      // The verify-ui evidence backend is gone with the Board rebuild (B2); no
      // screenshots are captured today, so the strip shows its missing-evidence note.
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { status: "not-found" });
    },
    "review.refine": async (rawInput) => {
      const name = "review.refine" as const;
      // Rai's headline feature. Resolve the CURRENT review ONCE (a stale/unknown id
      // is refused), then run the council-routed refine turn over the raw note +
      // its anchored code. Refining is a model turn — Rennet's whole job — so it
      // just runs; there is no permission gate and no consent token. ⚠️ EGRESS: the
      // raw note plus the anchored diff context IS sent to the harness (codex/claude)
      // — the same per-turn egress every review lens makes; it is NOT "nothing
      // leaves the machine". Publication is separate: the refined body reaches GitHub only
      // when the reviewer later clicks Post on the composed review.
      // With no refiner wired, answer an honest `unavailable` rather than throwing.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      if (!deps.refineComment) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "refinement is not available in this build",
        });
      }
      return parseCommandOutput(
        name,
        await deps.refineComment({
          review,
          type: input.type,
          raw: input.raw,
          ...(input.lens === undefined ? {} : { lens: input.lens }),
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.span === undefined ? {} : { span: input.span }),
          ...(input.side === undefined ? {} : { side: input.side }),
        }),
      );
    },
    "review.handoff.prepare": async (rawInput) => {
      const name = "review.handoff.prepare" as const;
      // Compose the bundle from the addressed dispositions + the active patchset and
      // return it with a disclosure the UI shows. Pure — no session, no spend.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      const bundle = buildHandoffBundle({
        reviewId: review.id,
        contextDir: contextDirFor(review),
        patchset: activePatchsetOf(review),
        dispositions: input.dispositions,
      });
      return parseCommandOutput(name, {
        bundle,
        disclosure: disclosureFor(bundle, "claude-code"),
      });
    },
    "review.handoff.run": async (rawInput) => {
      const name = "review.handoff.run" as const;
      // The write-enabled turn. Clicking run IS the human act — no consent gate (Rule
      // Zero). Run the COMPOSED bundle (issue #72) — the exact one `review.handoff.compose`
      // produced — NOT a mechanical re-derivation from the dispositions. The write session
      // is fully capable (Bash included, Rai's call); it executes the composed, ordered,
      // verbatim work order, and we capture the delta after.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      assertAllowedRepository(review.repositoryRoot);
      const priorActive = activePatchsetOf(review);
      const bundle = input.bundle;
      // The compose→run digest binding (issue #72): the run executes the bundle that
      // was composed, provably. `verifyComposedBundle` recomputes the digest + prompt
      // from the tasks, so a bundle whose prompt or a body was swapped after composition
      // is refused rather than run; and the bundle must have been composed against THIS
      // review's currently-active patchset, or it is stale (re-compose, never run-anyway).
      // Integrity, not a gate — the mechanical floor (`composed:false`) verifies and runs
      // exactly like a `composed:true` bundle; this refuses only an order nobody composed.
      const contextSessionId = contextSessionIdFor(review);
      if (
        bundle.reviewId !== review.id ||
        bundle.patchsetId !== priorActive.id ||
        !verifyComposedBundle(bundle, sessionContextRelativeDir(contextSessionId))
      ) {
        return parseCommandOutput(name, {
          status: "refused",
          reason:
            "the composed bundle does not match this review's active patchset or its own digest — re-compose before running",
        });
      }
      if (!deps.runHandoffTurn) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "no coding harness is available to run the handoff",
        });
      }
      // The work order goes to disk BEFORE the turn (session-context-files): the verified
      // bundle's prompt names `<contextDir>/work-order.md` relative to the turn's cwd, and
      // this is what puts the ordered, grouped, verbatim asks and their diff fences there.
      // Written after verification, from the SAME `tasks` the digest binds, so the file
      // cannot carry an order nobody composed — and under the SAME session id the prompt
      // was verified against, which is the id the archive purges (review finding 1).
      //
      // Under the session's BOUND workspace (session-bound-workspace), because that is the
      // turn's cwd and the prompt's path is relative to it. Written under the repository
      // while the turn runs in a worktree, it names a file that is not there.
      //
      // The purge is held for the whole turn, not just the write: an archive landing while
      // the agent is reading the work order would otherwise delete it mid-turn (review
      // finding 2). The lease is released when the turn settles, and the last release
      // performs a purge the archive deferred.
      writeSessionContext(
        deps.boundWorkspaceForReview?.(review.id)?.root ?? review.repositoryRoot,
        contextSessionId,
        [workOrderContextFile(bundle.tasks)],
      );
      const releaseContext = deps.holdSessionContext?.(contextSessionId);
      const turn = await deps
        .runHandoffTurn({
          repoRoot: review.repositoryRoot,
          prompt: bundle.prompt,
          reviewId: review.id,
        })
        .finally(() => releaseContext?.());
      if (turn.status === "failed") {
        // Surface the files the agent changed before erroring (Codex F4) — the working
        // tree was modified even though the turn failed; hiding it defeats totality.
        // Only ever SETS. An empty `filesTouched` is the harness's account of a turn that
        // failed, which is exactly when it is least trustworthy; clearing on it would let
        // that account overwrite what the watcher saw for itself.
        if (turn.filesTouched.length > 0) deps.setRepositoryDirty(true);
        return parseCommandOutput(name, {
          status: "failed",
          reason: turn.reason,
          filesTouched: [...turn.filesTouched],
        });
      }
      // Capture the agent's result as a NEW patchset — the delta re-review. The
      // PatchsetActivated fold runs the DETERMINISTIC lineage carry
      // (`carryDispositionsByLineage`): a byte-identical occurrence at the same path
      // carries, a byte-verified git rename carries re-anchored. Only a VANISHED or
      // DELETED occurrence orphans (surfaced for re-review, never dropped); one whose
      // same-path code merely CHANGED, or cannot be verified, reopens and enters
      // NEITHER count (see #266 — that reopened case is currently unsurfaced). The
      // fuzzy occurrence matcher deliberately does NOT drive this carry (issue #254 / #16).
      //
      // Hand the verified bundle's ask trace to the capture (issue #73 wave 3): the
      // traceMap + task titles MATERIALISED per ask, so the successor's successor account
      // attributes each ask to the composed task that ran it. A SMALL projection —
      // ask id + anchor identity + task index + preview title, NO prompts/bodies/contexts
      // — so nothing an agent executes enters the event log.
      const handoffTrace: HandoffAskTrace[] = bundle.tasks.flatMap((task) =>
        task.asks.map((ask) => {
          const taskIndex = bundle.traceMap[ask.id] as number;
          return {
            id: ask.id,
            path: ask.path,
            ...(ask.span !== undefined ? { span: ask.span } : {}),
            ...(ask.side !== undefined ? { side: ask.side } : {}),
            type: ask.type,
            taskIndex,
            taskTitle: bundle.tasks[taskIndex]?.title ?? "",
          };
        }),
      );
      // Cleared before the recapture, same rule as `review.capture` and `checkFreshness`:
      // the coding agent's own writes land during this capture, and a clear afterwards
      // would swallow whatever arrived after the diff was taken.
      deps.setRepositoryDirty(false);
      const updated = await service.capture(
        input.commandId,
        review.repositoryRoot,
        review.id,
        handoffTrace,
      );
      // R28 immutability: the pre-handoff patchset must survive byte-identical. Its
      // id is content-addressed over (repository, files, bytes), so the SAME id still
      // present proves the content was never rewritten.
      const preserved = updated.patchsets.find((candidate) => candidate.id === priorActive.id);
      if (!preserved) {
        throw new Error("Handoff violated patchset immutability: the prior patchset was rewritten");
      }
      const result: HandoffRunResult = {
        review: updated,
        turnDiff: turn.turnDiff,
        filesTouched: [...turn.filesTouched],
        carriedForward: updated.dispositions.length,
        orphaned: updated.orphaned?.length ?? 0,
      };
      // The handoff-completed family goes live (#382 M2): raise with the delta summary as
      // substance so a backgrounded phone learns the write turn landed and what it changed.
      const orphanNote = result.orphaned > 0 ? `, ${result.orphaned} to re-review` : "";
      raiseHandoffCompleted(
        updated,
        `${basename(updated.repositoryRoot)} · ${result.filesTouched.length} files changed, ${result.carriedForward} carried${orphanNote}`,
      );
      return parseCommandOutput(name, { status: "ran", result });
    },
    "review.draftPrBody": async (rawInput) => {
      const name = "review.draftPrBody" as const;
      // The own-branch destination's PR-submission preview (#22) needs a title +
      // body. Resolve the CURRENT review ONCE (a stale/unknown id is refused), then
      // run the council-routed drafting turn over the reviewed changeset the renderer
      // handed in. ⚠️ EGRESS: the drafting material IS sent to the harness (the same
      // per-turn egress every lens makes) — but the RESULT posts NOTHING. It is a
      // draft into a preview; creating the PR is the separate hold-to-sign act (#21).
      // With no drafter wired, answer an honest `unavailable` rather than throwing —
      // the renderer keeps the deterministic composed body.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      if (!deps.draftPrBody) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "PR-body drafting is not available in this build",
        });
      }
      const drafted = await deps.draftPrBody({
        review,
        base: input.base,
        head: input.head,
        dispositions: input.dispositions,
        ...(input.narration === undefined ? {} : { narration: input.narration }),
        ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
        ...(input.decisions === undefined ? {} : { decisions: input.decisions }),
      });
      // The composed own-branch draft is now ready (#382 M2): raise publish-ready with the
      // destination + drafted title as substance, so a phone that is away learns a draft is
      // waiting to post and deep-links to the preview. Only on a real draft — an
      // unavailable/failed turn composes nothing to wait on.
      if (drafted.status === "drafted") {
        raisePublishReady(
          review,
          `${basename(review.repositoryRoot)}:${input.head}`,
          drafted.title,
        );
      }
      return parseCommandOutput(name, drafted);
    },
    "review.deltaDigest": async (rawInput) => {
      const name = "review.deltaDigest" as const;
      // Rephrase the successor review's DETERMINISTIC successor account into a one-glance
      // TL;DR. Resolve the CURRENT review ONCE (stale/unknown id refused), read its
      // OWN `successorAccount` (absent ⇒ honest `unavailable` — a first capture carries
      // no account), and run the council-routed light turn. ⚠️ EGRESS: the account's
      // paths/statuses ARE sent to the harness (a per-turn egress) — but ONLY the
      // account, never diff or repo content, so the digest can add no fact the facts
      // don't carry. The RESULT posts NOTHING. With no producer wired, or on any
      // failed/absent turn, the renderer shows the facts with no headline.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      const account = review.successorAccount;
      if (account === undefined) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "this review carries no successor account to summarise",
        });
      }
      if (!deps.draftDeltaDigest) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: "delta-digest summarising is not available in this build",
        });
      }
      return parseCommandOutput(name, await deps.draftDeltaDigest({ review, account }));
    },
    "review.handoff.compose": async (rawInput) => {
      const name = "review.handoff.compose" as const;
      // The light-tier authoring step over the mechanical bundle: build the
      // deterministic bundle from the addressed dispositions, then let the composer
      // order + merge + narrate it. The core composer owns the safety law (partition
      // validation, verbatim-body reconstruction, fail-closed to the mechanical
      // floor), so a failed/absent composer yields `composed:false` — a real,
      // complete bundle — never a throw and never a lossy authoring.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      const contextDir = contextDirFor(review);
      const mechanical = buildHandoffBundle({
        reviewId: review.id,
        contextDir,
        patchset: activePatchsetOf(review),
        dispositions: input.dispositions,
      });
      const bundle = deps.composeBundle
        ? await deps.composeBundle({ bundle: mechanical, review, contextDir })
        : mechanicalComposition(mechanical, contextDir);
      return parseCommandOutput(name, { bundle });
    },
    "review.symbolLookup": async (rawInput) => {
      const name = "review.symbolLookup" as const;
      // Resolve the addressed review ONCE (a stale/unknown id is refused), then read
      // both symbolic ops for the clicked name. No model spend — deterministic index
      // reads. With no symbolic backend wired, answer honestly `unavailable` for
      // both sections rather than throwing (the UI degrades to a clear message).
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      if (!deps.symbolLookup) {
        return parseCommandOutput(name, {
          name: input.name,
          definition: {
            status: "unavailable",
            reason: "the symbolic index is not available for this review",
          },
          references: {
            status: "unavailable",
            reason: "the symbolic index is not available for this review",
          },
        });
      }
      return parseCommandOutput(name, await deps.symbolLookup({ review, name: input.name }));
    },
    "review.openInEditor": async (rawInput) => {
      const name = "review.openInEditor" as const;
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      if (!deps.openInEditor) return parseCommandOutput(name, { ok: false });
      return parseCommandOutput(
        name,
        await deps.openInEditor({ review, path: input.path, line: input.line }),
      );
    },
  } satisfies Record<string, CommandHandler>;
}
