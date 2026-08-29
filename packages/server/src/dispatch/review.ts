import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  askReview,
  buildHandoffBundle,
  disclosureFor,
  isRepoRelativePath,
  mechanicalComposition,
  verifyComposedBundle,
} from "@rennet/core";
import {
  type HandoffAskTrace,
  type HandoffRunResult,
  parseCommandInput,
  parseCommandOutput,
} from "@rennet/protocol";
import { deepLinkFor } from "../attention-planner";
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
      return parseCommandOutput(name, { review });
    },
    "review.uiEvidence": async (rawInput) => {
      const name = "review.uiEvidence" as const;
      // The verify-ui evidence backend is gone with the Board rebuild (B2); no
      // screenshots are captured today, so the strip shows its missing-evidence note.
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, { status: "not-found" });
    },
    "review.ask": async (rawInput, ctx) => {
      const name = "review.ask" as const;
      // The reviewer's question. The core `askReview` router owns the whole law:
      // the orchestrator is asked exactly once (every mode); Codex is asked ONLY in
      // "both" mode; and the two answers come back side by side, NEVER merged. We
      // run it here — not a bespoke branch — so "orchestrator mode never touches
      // Codex, and no synthesis is ever produced" holds on the real command path.
      // `mode` is defaulted to "orchestrator" by the schema, so an omitted mode
      // never fires a second model.
      const input = parseCommandInput(name, rawInput);
      // Resolve the CURRENT review ONCE (a stale/unknown id is refused) and hand the
      // SAME snapshot to both legs below, so a "both" ask can never cross two
      // patchsets. Asking a model is Rennet's whole job — it just runs against the
      // current review; there is no permission gate and no consent token, and a
      // question always answers against the latest code rather than ever refusing.
      const review = requireReviewById(input.reviewId);
      // Shade-answer binding (#382 M2 finding 3): a chip answer from the notification carries
      // the ask's attention id. Atomically CONSUME it (acknowledge) BEFORE running the turn, so
      // exactly one answer lands: a duplicate tap finds the item already consumed and is refused
      // truthfully; a forged/stale id matches no active item and is refused too. This runs
      // before the first await, so two concurrent taps cannot both consume. Only enforced when
      // attention is wired (a build without it has no shade-answer path to dedup).
      if (input.attentionId !== undefined && deps.acknowledgeAttention) {
        const consumed = deps.acknowledgeAttention({ attentionId: input.attentionId });
        if (consumed === 0) {
          throw new Error("This ask was already answered.");
        }
      }
      const mode = input.mode ?? "orchestrator";
      // #251 streaming: with a thread + turn AND a push channel, stream the
      // orchestrator's tokens live and emit a terminal event per channel. Absent →
      // a #139 one-shot ask, no stream (fully back-compat). The router's law is
      // untouched — streaming changes the TRANSPORT, not which models are asked.
      const stream =
        input.threadId && input.turnId && ctx?.emitAskStream
          ? { threadId: input.threadId, turnId: input.turnId, emit: ctx.emitAskStream }
          : undefined;
      const onOrchestratorDelta = stream
        ? (delta: string) => {
            // Grow the registry's live body (#382 M2 finding 5) so a mid-turn reattach
            // resumes the real cursor, then echo the delta on the stream.
            deps.liveTurns?.appendDelta(stream.turnId, delta);
            stream.emit({
              kind: "ask-delta",
              threadId: stream.threadId,
              turnId: stream.turnId,
              channel: "orchestrator",
              delta,
            });
          }
        : undefined;
      const onOrchestratorFocus = ctx?.emitAskStream
        ? (anchor: string) =>
            ctx.emitAskStream?.({
              kind: "ask-focus",
              anchor,
              ...(input.threadId ? { threadId: input.threadId } : {}),
              ...(input.turnId ? { turnId: input.turnId } : {}),
            })
        : undefined;
      // #251 persistence: BEFORE the turn runs, record the thread, the reviewer's
      // question, and a `streaming` placeholder for the orchestrator answer. If the
      // process dies here, the placeholder is already on disk and re-attach recovers
      // it as `interrupted` — never a silent loss, never a fabricated completion. The
      // placeholder id is REPLACED by the durable answer on completion below.
      const persist =
        stream && deps.threadPersistence && input.anchor
          ? {
              store: deps.threadPersistence,
              reviewId: input.reviewId,
              threadId: stream.threadId,
              orchestratorId: `${stream.turnId}::orchestrator`,
              codexId: `${stream.turnId}::codex`,
            }
          : undefined;
      if (persist && input.anchor) {
        persist.store.upsertThread({
          reviewId: persist.reviewId,
          threadId: persist.threadId,
          anchor: input.anchor,
        });
        if (input.turnBody) {
          persist.store.putMessage({
            reviewId: persist.reviewId,
            threadId: persist.threadId,
            message: { id: `${stream?.turnId}::you`, author: "you", body: input.turnBody },
          });
        }
        persist.store.putMessage({
          reviewId: persist.reviewId,
          threadId: persist.threadId,
          message: {
            id: persist.orchestratorId,
            author: "harness",
            body: "",
            status: "streaming",
          },
        });
      }
      // #251 criterion 4 (scoped reaping): register this turn's AbortController so
      // `before-quit` can reap it. The turn ENTERS the registry here and LEAVES in the
      // finally below — whether it completed, errored, or was aborted — so a registry
      // that only ever grew (the leak) is impossible. The controller is threaded into
      // BOTH legs (claude via the SDK, codex via execa's cancelSignal), so one
      // quit-abort cancels both. A one-shot ask with no turnId still registers under a
      // fresh key, so it too is reaped. No registry wired ⇒ no controller ⇒ back-compat.
      const turnKey = stream?.turnId ?? randomUUID();
      // Index the turn by reviewId so a client "Stop" (`review.interrupt`, #382 M2) can
      // abort THIS review's in-flight turn — the same signal `before-quit` fires, scoped.
      // A streaming turn also registers its live descriptor so `review.reattach` resumes its
      // real in-flight body (#382 M2 finding 5) instead of recovering it as interrupted.
      const liveTurn = deps.liveTurns?.register(
        turnKey,
        input.reviewId,
        stream ? { threadId: stream.threadId, channel: "orchestrator" } : undefined,
      );
      // Attention (#383 batch, families ask-pending + turn-failed). Only a STREAMING ask —
      // a tracked, backgroundable turn (threadId+turnId) — raises attention; a one-shot #139
      // ask is a synchronous foreground call the caller is already waiting on. Raise
      // "ask pending" while the turn runs; clear it when it settles; raise "turn failed" if it
      // errored or was interrupted. review-finished + these two are the families live in M1.
      const askPendingId = stream
        ? deps.raiseAttention?.({
            family: "ask-pending",
            reviewId: input.reviewId,
            deepLink: deepLinkFor("ask-pending", { reviewId: input.reviewId }),
            title: "Ask pending",
            body: `${basename(review.repositoryRoot)} has a question in flight`,
          })
        : undefined;
      const clearAskPending = (): void => {
        if (askPendingId) deps.acknowledgeAttention?.({ attentionId: askPendingId });
      };
      const raiseTurnFailed = (why: string): void => {
        if (!stream) return;
        deps.raiseAttention?.({
          family: "turn-failed",
          reviewId: input.reviewId,
          deepLink: deepLinkFor("turn-failed", { reviewId: input.reviewId }),
          title: "Turn interrupted",
          body: why,
        });
      };
      // Emit the terminal `ask-interrupted` on the stream once, when the turn was aborted
      // (the client "Stop", or a quit reap) — so every watcher renders the interrupted
      // outcome truthfully rather than a turn that just stops streaming. Guarded to fire
      // at most once and only for a tracked, streaming turn.
      let interruptEmitted = false;
      const emitInterrupted = (why: string): void => {
        if (!stream || interruptEmitted) return;
        interruptEmitted = true;
        stream.emit({
          kind: "ask-interrupted",
          threadId: stream.threadId,
          turnId: stream.turnId,
          channel: "orchestrator",
          reason: why,
        });
      };
      // Persist the interrupted turn's replacement (#382 M2 finding 6): overwrite the
      // `streaming` placeholder (same id) with an explicit `interrupted` message carrying the
      // partial body that streamed, so a store reload reads it back as interrupted directly.
      // Idempotent (once per turn) so the success and catch abort branches never double-write.
      let interruptPersisted = false;
      const persistInterrupted = (p: NonNullable<typeof persist>): void => {
        if (interruptPersisted) return;
        interruptPersisted = true;
        p.store.putMessage({
          reviewId: p.reviewId,
          threadId: p.threadId,
          message: {
            id: p.orchestratorId,
            author: "harness",
            body: deps.liveTurns?.bodyOf(turnKey) ?? "",
            status: "interrupted",
          },
        });
      };
      try {
        const result = await askReview(mode, input.question, {
          askOrchestrator: (question) =>
            deps.reviewAsk.askOrchestrator({
              review,
              question,
              ...(onOrchestratorDelta ? { onDelta: onOrchestratorDelta } : {}),
              ...(onOrchestratorFocus ? { onFocus: onOrchestratorFocus } : {}),
              ...(input.selection ? { selection: input.selection } : {}),
              ...(liveTurn ? { abortController: liveTurn } : {}),
            }),
          askCodex: (question) =>
            deps.reviewAsk.askCodex({
              review,
              question,
              ...(liveTurn ? { abortController: liveTurn } : {}),
            }),
        });
        // Terminal events: the orchestrator's tokens already streamed via onDelta;
        // codex is one-shot (no token stream) so its whole answer lands as its
        // completion. Both carry the SAME final answer the invoke returns — the stream
        // is a live echo, never a second source of truth.
        //
        // EXACTLY ONE terminal event (#382 M2 finding 6): if this turn's controller was
        // aborted (a leg that SWALLOWED its abort and returned reaches here), skip
        // `ask-complete` entirely — the single terminal is the `ask-interrupted` emitted
        // below. Emitting complete THEN interrupted would give every watcher two terminals
        // and let a killed turn flash a "completed" answer first.
        if (stream && !liveTurn?.signal.aborted) {
          stream.emit({
            kind: "ask-complete",
            threadId: stream.threadId,
            turnId: stream.turnId,
            channel: "orchestrator",
            model: result.primary.model,
            finalBody: result.primary.answer,
          });
          if (result.secondOpinion) {
            stream.emit({
              kind: "ask-complete",
              threadId: stream.threadId,
              turnId: stream.turnId,
              channel: "codex",
              model: result.secondOpinion.model,
              finalBody: result.secondOpinion.answer,
            });
          }
        }
        // #251 persistence: the turn completed — REPLACE the streaming placeholder with
        // the durable orchestrator answer (same id) and append the codex answer when the
        // ask was "both". Only completed messages persist a body; the placeholder never
        // held the coalesced deltas.
        //
        // ⭐ THE ABORT GUARD (criterion 4, honest-state doctrine). If this turn's
        // controller was aborted, its `streaming` placeholder MUST stay on disk so the
        // next reattach recovers it as `interrupted` (criterion 3) — never as a durable
        // completion. Two ways an abort arrives here, and the guard covers BOTH: usually
        // the aborted leg THROWS and skips this block entirely; but a leg that SWALLOWS
        // its abort and returns a (failure/empty/partial) answer — e.g. the codex port
        // catches execa's cancel and returns text — would otherwise reach here and
        // overwrite the placeholder with a durable answer for a turn that was killed.
        // Checking `signal.aborted` is the direct truthful signal, not a guess about
        // library throw-vs-resolve behaviour. No registry wired ⇒ `liveTurn` undefined
        // ⇒ the guard is inert (back-compat).
        if (persist && !liveTurn?.signal.aborted) {
          persist.store.putMessage({
            reviewId: persist.reviewId,
            threadId: persist.threadId,
            message: {
              id: persist.orchestratorId,
              author: "harness",
              model: result.primary.model,
              body: result.primary.answer,
            },
          });
          if (result.secondOpinion) {
            persist.store.putMessage({
              reviewId: persist.reviewId,
              threadId: persist.threadId,
              message: {
                id: persist.codexId,
                author: "harness",
                model: result.secondOpinion.model,
                body: result.secondOpinion.answer,
              },
            });
          }
        } else if (persist) {
          // The turn was aborted (a swallowed abort that returned). REPLACE the streaming
          // placeholder with an explicit `interrupted` message carrying the partial body that
          // actually streamed (#382 M2 finding 6) — so it survives a store reload as
          // interrupted directly, not only via the crash-recovery transform.
          persistInterrupted(persist);
        }
        // The ask settled. An interrupted turn (its controller was aborted but the leg
        // swallowed the abort and returned) is a truthful "turn failed"; otherwise the ask
        // is simply no longer pending. Either way, ask-pending clears.
        clearAskPending();
        if (liveTurn?.signal.aborted) {
          // The leg swallowed its abort and returned — still an interrupted turn. Emit the
          // stream terminal AND raise turn-failed so watchers and the needs-you badge agree.
          emitInterrupted("The turn was interrupted before it finished.");
          raiseTurnFailed("The turn was interrupted before it finished.");
        }
        return parseCommandOutput(name, result);
      } catch (error) {
        // The turn threw (a real failure, or a quit/Stop abort rejecting the in-flight turn):
        // clear the pending flag, tell the stream the truthful outcome, and raise turn-failed,
        // then rethrow. An abort reads as "interrupted"; any other throw as a genuine failure.
        clearAskPending();
        const why = error instanceof Error ? error.message : "The turn failed.";
        if (liveTurn?.signal.aborted) {
          // The aborted leg threw. Persist the interrupted replacement (#382 M2 finding 6)
          // and emit the single terminal, so the turn survives reload as interrupted.
          if (persist) persistInterrupted(persist);
          emitInterrupted("The turn was interrupted before it finished.");
          raiseTurnFailed("The turn was interrupted before it finished.");
        } else {
          raiseTurnFailed(why);
        }
        throw error;
      } finally {
        // The turn settled — completed, errored, or aborted-on-quit — so it leaves the
        // registry. Running in `finally` is what makes the "leaves when it settles"
        // guarantee hold on the throwing paths too (a quit-abort rejects the in-flight
        // turn); settling only on success would leak the aborted turn's controller.
        if (liveTurn) deps.liveTurns?.settle(turnKey);
      }
    },
    "review.reattach": async (rawInput) => {
      const name = "review.reattach" as const;
      // Reload the conversation threads persisted for this review and any turn still
      // streaming in a surviving main process. Resolve the review ONCE (a stale/unknown
      // id is refused, exactly like ask). With no thread store wired yet, the honest
      // answer is genuinely empty — zero persisted threads, zero tracked in-flight
      // turns — NOT a fabricated set; this is the seam persistence (§3/§5) plugs into.
      const input = parseCommandInput(name, rawInput);
      requireReviewById(input.reviewId);
      if (!deps.reattachThreads) {
        return parseCommandOutput(name, { threads: [], inFlight: [] });
      }
      return parseCommandOutput(name, await deps.reattachThreads({ reviewId: input.reviewId }));
    },
    "review.interrupt": async (rawInput) => {
      const name = "review.interrupt" as const;
      // The client "Stop" (wireframe 22). Resolve the review ONCE (a stale/unknown id is
      // refused, exactly like ask/reattach), then abort its in-flight turn(s) via the live-
      // turn registry — the same AbortController `before-quit` fires, scoped to this review.
      // The aborted turn's own handler emits `ask-interrupted`, clears ask-pending, and
      // raises turn-failed (it observes `signal.aborted`); this command only requests the
      // stop and reports how many turns it signalled. Idempotent: nothing in flight ⇒ 0.
      const input = parseCommandInput(name, rawInput);
      requireReviewById(input.reviewId);
      const interrupted = deps.liveTurns?.abortReview(input.reviewId) ?? 0;
      return parseCommandOutput(name, { interrupted });
    },
    "review.refine": async (rawInput) => {
      const name = "review.refine" as const;
      // Rai's headline feature. Resolve the CURRENT review ONCE (a stale/unknown id
      // is refused), then run the council-routed refine turn over the raw note +
      // its anchored code. Refining is a model turn — Rennet's whole job — so it
      // just runs; there is no permission gate and no consent token. ⚠️ EGRESS: the
      // raw note plus the anchored diff context IS sent to the harness (codex/claude)
      // — the same per-turn egress every review lens makes; it is NOT "nothing
      // leaves the machine". What is gated is the PUBLISH: the refined body only
      // reaches GitHub later, through the same hold-to-sign path as any comment.
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
      if (
        bundle.reviewId !== review.id ||
        bundle.patchsetId !== priorActive.id ||
        !verifyComposedBundle(bundle)
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
      const turn = await deps.runHandoffTurn({
        repoRoot: review.repositoryRoot,
        prompt: bundle.prompt,
      });
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
      const mechanical = buildHandoffBundle({
        reviewId: review.id,
        patchset: activePatchsetOf(review),
        dispositions: input.dispositions,
      });
      const bundle = deps.composeBundle
        ? await deps.composeBundle({ bundle: mechanical, repoRoot: review.repositoryRoot })
        : mechanicalComposition(mechanical);
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
