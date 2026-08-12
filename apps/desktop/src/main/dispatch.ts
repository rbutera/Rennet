import {
  type AskAnswer,
  askReview,
  buildForgeReviewPost,
  buildHandoffBundle,
  canonicalReviewPayload,
  disclosureFor,
  type ForgePublishPort,
  type ForgeReviewTarget,
  forgeTargetKey,
  type HandoffTurnOutcome,
  mechanicalComposition,
  type ReviewService,
  resolveReviewEvent,
} from "@rennet/core";
import {
  type CommandName,
  type DetectedHarness,
  type DiscoveryResult,
  type ProcessedRepoSummary,
  type Project,
  type ProjectDetail,
  type ProjectKind,
  type ProjectProcessEvent,
  type ProjectVisibility,
  parseCommandInput,
  parseCommandOutput,
  type SetRepoVisibilityOutcome,
  type SettingsGuidance,
  type SettingsView,
} from "@rennet/protocol";
import type {
  AnchorSide,
  AnchorSpan,
  Canvas,
  CanvasAngle,
  ComposedHandoffBundle,
  DecisionsRunStatus,
  DispositionType,
  ElementDiffs,
  FlaggedReview,
  HandoffBundle,
  HandoffRunResult,
  NoiseReview,
  OpenSpecChange,
  OpenSpecCoverage,
  Patchset,
  PrBodyDraftResult,
  RefinementResult,
  Review,
  ReviewEngine,
  ReviewNarration,
  SymbolInspection,
} from "@rennet/types";
import type { OrchestratorTurnRunner } from "./orchestrator";
import { type PublishConsentAuthority, publishConsentKey } from "./publish-consent-authority";

/**
 * The command router (issue #54), extracted from the electron main so it can be
 * unit-tested without an Electron runtime. Every electron-side effect is
 * injected: the repository picker (dialog), the change watcher, the dirty flag,
 * and the harness-backed canvas builder. `index.ts` composes these; this module
 * is pure command routing over `ReviewService` + `@rennet/protocol`.
 */
export interface DispatchDeps {
  readonly service: ReviewService;
  /**
   * The live orchestrator turn runner (issue #13, wave 2): composes the wave-1 live
   * backend + the lean primer + a real `claude` turn over the in-process
   * canvasOps@2 MCP server. Held here so the orchestrator capability is part of the
   * live command-router composition; the conversational command that drives a turn
   * per user question is the DEFERRED UI loop, so no command routes to it yet.
   */
  readonly orchestratorTurn?: OrchestratorTurnRunner;
  /** Repositories the user has granted review access to (renderer-origin guard). */
  readonly allowedRoots: Set<string>;
  /** Resolve a repository to review (Electron dialog, or the test-repo env). `null` = cancelled. */
  chooseRepository(): Promise<string | null>;
  /**
   * Open a GitHub pull request into a review (the front door's second source):
   * parse the ref (`owner/repo#123` or a PR URL), fetch + diff the PR against the
   * local clone at `repoPath`, and persist a new review. Returns the created
   * review, ready for the same surface the local capture lands in. `retrospective`
   * opens it read-only (a merged/any PR reviewed after the fact): the review is
   * flagged so egress is refused and the sign affordance hidden.
   */
  openPullRequest(
    commandId: string,
    ref: string,
    repoPath: string,
    retrospective: boolean,
  ): Promise<Review>;
  /** Begin watching a captured repository root for on-disk changes. */
  startWatching(root: string): void;
  isRepositoryDirty(): boolean;
  setRepositoryDirty(dirty: boolean): void;
  /**
   * Build the live five-angle canvas set for a review (harness-backed pipeline),
   * plus the per-element real diff map (#60) delivered with it.
   */
  buildCanvases(review: Review): Promise<{
    canvases: Record<CanvasAngle, Canvas>;
    elementDiffs: ElementDiffs;
    /** The roll-up narration placed onto the canvases (issue #70), when produced. */
    narration?: ReviewNarration;
    /** How the set was produced (real-AI-default): AI review vs mechanical outline. */
    engine: ReviewEngine;
    /**
     * How the Decisions lens's producer ran (issue #137): `ok` (discerned a
     * possibly-empty set) vs `failed` (the runner did not complete). Optional so a
     * caller that does not run decisions omits it; the renderer surface that paints
     * the failed state distinctly is a follow-up.
     */
    decisionsRun?: DecisionsRunStatus;
  }>;
  /**
   * The forge egress port (issue #21). `buildReviewRequest` is pure and network-free
   * (the dry-run evidence, no credential); `publishReview` performs the real, gated
   * post. Read/egress are separate ports, so only the publish command can egress.
   */
  readonly publishPort: ForgePublishPort;
  /**
   * The main-owned PUBLISH consent authority (issue #21). Mints a single-use token
   * bound to (review, target, payload) on the user's approval act
   * (`publish.requestConsent`) and consumes it before the real egress, so a real
   * post under a consent-requiring mode cannot be forged or replayed.
   */
  readonly publishConsent: PublishConsentAuthority;
  /**
   * The write-enabled handoff turn (issue #18): brackets a coding-harness write turn
   * with workspace checkpoints and returns the turn diff. Composed by the root as
   * `runHandoffTurn` over the live Claude adapter (fully capable, Bash included) + the
   * git checkpoint store. Optional so a composition WITHOUT a coding harness still constructs — the
   * `run` command then answers an honest `unavailable` rather than throwing.
   */
  readonly runHandoffTurn?: (input: {
    repoRoot: string;
    bundle: HandoffBundle;
  }) => Promise<HandoffTurnOutcome>;
  /**
   * The handoff-bundle composer (issue #72, Model Council M24): the light-tier
   * authoring step that orders + merges + narrates the mechanical bundle. Composed by
   * the root as `createLiveComposeBundle` (council-routed). Optional so a composition
   * WITHOUT it still constructs — the dispatch then returns the mechanical floor
   * (`composed:false`) rather than throwing, so the command is always answerable.
   */
  readonly composeBundle?: (input: {
    bundle: HandoffBundle;
    repoRoot: string;
  }) => Promise<ComposedHandoffBundle>;
  /**
   * The front door (issue #29): the persisted projects list and the read-only
   * discovery + harness-detection that feed the add-a-project flow. `add` takes the
   * confirmed discovery + toggle choices and MAIN derives the stored shape.
   */
  readonly projects: {
    list(): Project[];
    add(input: { discovery: DiscoveryResult; includedRepos: string[]; primaryBranch: string }): {
      project: Project;
      projects: Project[];
    };
  };
  /**
   * Process a freshly-added project (issue #29, wireframe #2): build the
   * ProjectSnapshot / repo-map for every included repo — the initial context
   * dump. `emit` receives the LIVE narration events as the real generator stages
   * advance (bracketed per repo by `repo-start`/`repo-done`, a soft `repo-error`
   * on failure); the promise resolves with the final per-repo summary once every
   * repo has built. Pure over git: no gate, no model spend.
   */
  processProject(
    input: { projectId: string },
    emit: (event: ProjectProcessEvent) => void,
  ): Promise<{ repos: ProcessedRepoSummary[] }>;
  /** Read-only discovery over an already-granted path → editable defaults. */
  discoverProject(input: { path: string; kind: ProjectKind }): Promise<DiscoveryResult>;
  /** The harnesses found on the machine, for the ambient first-run detection line. */
  detectHarnesses(): Promise<DetectedHarness[]>;
  /**
   * The project-detail substrate (issue #37): the raw local work + pull requests +
   * viewer the unified smart list folds into rows. Read-only. A fixture stands behind
   * this until the live git/GitHub loop lands.
   */
  projectDetail(projectId: string): Promise<ProjectDetail>;
  /**
   * Clean up a merged PR's local worktree/branch (the read-only row's action). A
   * destructive local act; the host handler is a documented stub this wave.
   */
  cleanupWorktree(input: { projectId: string; worktreeId: string }): Promise<{ ok: boolean }>;
  /**
   * The Flagged lens's input (issue #138): the automated review layer's findings for
   * a review. The LIVE finding-generation runner (#32) is wired behind this — it
   * decomposes the review's active patchset and runs a real model turn over the diff,
   * so this DOES spend a budgeted model invocation. Dispatch resolves the addressed
   * review (freshness-checked, like `review.canvases`) and passes it in. `deepReview`
   * (issue #41) selects the dual-model path (two provider seats reconciled into
   * agreement/disagreement) — the DEFAULT (Rai's mandate, 2026-08-11). Explicit
   * `false` is the opt-DOWN to the single-Claude quick review.
   */
  flaggedReview(review: Review, deepReview: boolean): Promise<FlaggedReview>;
  /**
   * The Noise lens's input (issue #34): the low-signal churn grouped away for a
   * review, each group tagged rule vs noise job. The LIVE noise-classification runner
   * (#34) is wired behind this — it decomposes the review's active patchset and runs a
   * real model turn over the diff, so this DOES spend a budgeted model invocation.
   * Dispatch resolves the addressed review (freshness-checked, like `flagged.review`)
   * and passes it in.
   */
  noiseReview(review: Review): Promise<NoiseReview>;
  /**
   * The review.ask ports (issue #139): the two model-facing sessions a review
   * question can reach. `askOrchestrator` is the one model the reviewer converses
   * with (always asked); `askCodex` is the second opinion (asked ONLY in "both"
   * mode). Dispatch calls the core `askReview` router over these — the router owns
   * the orchestrator-once / both-adds-codex / never-synthesize law, so the invariant
   * holds on the real command path, not only in an isolated unit test.
   *
   * Both ports take the ALREADY-RESOLVED `review` (not a bare id): dispatch resolves
   * and freshness-pins the review+patchset ONCE, then hands the SAME snapshot to both
   * legs, so a "both" ask can never answer from two different patchsets (a
   * regeneration between the orchestrator and Codex legs cannot cross them).
   */
  readonly reviewAsk: {
    askOrchestrator(input: { review: Review; question: string }): Promise<AskAnswer>;
    askCodex(input: { review: Review; question: string }): Promise<AskAnswer>;
  };
  /**
   * The comment-refinement producer (issue #19): refine one raw review note into a
   * clean comment via a real, council-routed model turn. Takes the ALREADY-RESOLVED
   * review (dispatch freshness-pins it once). Optional so a composition without a
   * refiner still constructs — dispatch then answers an honest `unavailable` rather
   * than throwing, and the renderer keeps showing the raw note.
   */
  readonly refineComment?: (input: {
    review: Review;
    type: DispositionType;
    raw: string;
    lens?: string;
    path?: string;
    span?: AnchorSpan;
    side?: AnchorSide;
  }) => Promise<RefinementResult>;
  /**
   * The PR-body drafting producer (issue #74, M26): draft a PR title + body from the
   * reviewed changeset via a real, council-routed model turn. Takes the ALREADY-
   * RESOLVED review (dispatch freshness-pins it once) plus the drafting material the
   * renderer holds (branch shape, roll-up narration, dispositions, requirements,
   * decisions). Optional so a composition without a drafter still constructs —
   * dispatch then answers an honest `unavailable`, and the renderer keeps the
   * deterministic composed body. Drafting produces text into a preview; it NEVER
   * posts, pushes, or egresses (R33).
   */
  readonly draftPrBody?: (input: {
    review: Review;
    base: string;
    head: string;
    narration?: { oneLine: string; paragraph: string };
    dispositions: readonly { type: DispositionType; path: string; resolution: string }[];
    requirements?: readonly string[];
    decisions?: readonly string[];
  }) => Promise<PrBodyDraftResult>;
  /**
   * The symbol inspector port (Rai, wireframes #8): resolve one clicked identifier to
   * its definition + reference sites over the review's model-free symbolic surface.
   * Takes the ALREADY-RESOLVED review (dispatch freshness-pins it once). Optional so a
   * composition without a symbolic backend still constructs — dispatch then answers
   * with an honest `unavailable` for both sections rather than throwing.
   */
  readonly symbolLookup?: (input: { review: Review; name: string }) => Promise<SymbolInspection>;
  /**
   * The Spec angle's live OpenSpec change (wireframes #9): parse-on-open of the
   * change the reviewed patchset selected, read from the review's checked-out root.
   * Deterministic and model-free — no gate, no spend. `null` when the patchset
   * touches no `openspec/changes/<name>/`; unwired ⇒ also `null` (the Spec angle
   * shows its honest empty state rather than a fixture).
   */
  readonly openSpecChange?: (review: Review) => Promise<OpenSpecChange | null>;
  /**
   * The Spec view's requirement→hunk coverage (wireframes #9 / R53): the produced
   * hunk↔requirement mapping over the review's OpenSpec change. Spends a budgeted
   * model turn, so it takes the ALREADY-RESOLVED review. `null` when the review
   * touches no change; unwired ⇒ also `null` (the Spec view then renders no coverage
   * chips — an uncomputed mapping never masquerades as a real zero).
   */
  readonly openSpecCoverage?: (review: Review) => Promise<OpenSpecCoverage | null>;
  /**
   * Open a review file (repo-relative, optionally at a line) in the reviewer's
   * editor — the inspector's "open in editor" jump (Rai, wireframes #8). Takes the
   * ALREADY-RESOLVED review (its root is the resolution base + traversal boundary).
   * Optional; absent ⇒ dispatch answers `ok:false` rather than throwing.
   */
  readonly openInEditor?: (input: {
    review: Review;
    path: string;
    line?: number;
  }) => Promise<{ ok: boolean }>;
  /**
   * The settings surface (wireframe #15): the config ladder over the real stores.
   * `get` resolves the global appearance layer + every project's repo-scope config
   * with provenance; `guidance` reads one project's `.rennet/conventions.json`;
   * `setAppearance` writes the personal, app-side scheme (no repo write);
   * `setRepoVisibility` runs the real map-visibility switch (a repo `.gitignore`
   * write). Optional: absent ⇒ the settings commands are simply unavailable.
   */
  readonly settings?: {
    get(): Promise<SettingsView>;
    guidance(projectId: string, repoPath: string): Promise<SettingsGuidance>;
    setAppearance(scheme: SettingsView["scheme"]): SettingsView["scheme"];
    setRepoVisibility(input: {
      projectId: string;
      repoPath: string;
      visibility: ProjectVisibility;
    }): Promise<SetRepoVisibilityOutcome>;
  };
}

/** Lift the wire target shape into the core `ForgeReviewTarget` nouns. */
function toForgeReviewTarget(target: {
  repo: { forge: string; owner: string; name: string };
  number: number;
  forgeRef: string;
  headOid: string;
}): ForgeReviewTarget {
  return {
    ref: { repo: target.repo, number: target.number },
    forgeRef: target.forgeRef,
    headOid: target.headOid,
  };
}

/**
 * Per-invocation context the transport supplies. `emitProgress` is the push sink
 * a long-running command (today `project.process`) streams live narration to; the
 * transport binds it to the renderer's `onProgress` channel. Absent for every
 * request/response command, and for callers (tests) with no push channel.
 */
export interface DispatchContext {
  emitProgress?(event: ProjectProcessEvent): void;
}

export function createDispatch(
  deps: DispatchDeps,
): (name: CommandName, rawInput: unknown, ctx?: DispatchContext) => Promise<unknown> {
  const { service, allowedRoots } = deps;

  // In-flight REAL posts, keyed by the deterministic idempotency marker (issue #21
  // double-sign race). Two concurrent real posts of the same (review, target, payload)
  // share a marker, so the second is refused while the first is still landing — the
  // main-owned half of the double-sign guard (the renderer disables the sign control
  // while a publish is pending; this closes the window between two near-simultaneous
  // completed signs before either mutation returns). A dropped-outcome retry is a
  // SEQUENTIAL call (the first has left the set), so the adapter's query-before-post
  // idempotency still yields exactly one review.
  const realPostInFlight = new Set<string>();

  function assertAllowedRepository(repositoryPath: string): void {
    if (!allowedRoots.has(repositoryPath)) throw new Error("Repository access was not granted");
  }

  /**
   * The egress target-binding gate (issue #21, most-permissive-fault): a real post is
   * legitimate ONLY against the review's OWN pull request. `requestConsent` and the
   * real `publish.review` both call this so a token can neither be MINTED nor CONSUMED
   * for a local capture (no `postTarget`) or a mismatched target — even by a
   * hand-crafted call. A single fault (a renderer bug, a replayed/forged target) cannot
   * clear it: the review's stored `postTarget` is the authority, not the caller's input.
   * Mirrors the retrospective structural gate exactly.
   */
  function assertTargetIsReviewOwn(review: Review, target: ForgeReviewTarget): void {
    if (!review.postTarget) {
      throw new Error(
        "Publish refused: this review has no pull request to post to (a local capture cannot be posted).",
      );
    }
    if (forgeTargetKey(toForgeReviewTarget(review.postTarget)) !== forgeTargetKey(target)) {
      throw new Error("Publish refused: the target does not match this review's pull request.");
    }
  }

  /** The latest review, asserted to be the one addressed (freshness/canvases path). */
  function requireLatestReview(reviewId: string): Review {
    const current = service.bootstrap();
    if (!current || current.id !== reviewId) throw new Error("Review not found");
    return current;
  }

  /** The review's active patchset (the handoff bundle's baseline). */
  function activePatchsetOf(review: Review): Patchset {
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    if (!patchset) throw new Error("The active patchset is missing");
    return patchset;
  }

  return async function dispatch(
    name: CommandName,
    rawInput: unknown,
    ctx?: DispatchContext,
  ): Promise<unknown> {
    switch (name) {
      case "app.bootstrap": {
        parseCommandInput(name, rawInput);
        const review = service.bootstrap();
        if (review) {
          allowedRoots.add(review.repositoryRoot);
          deps.startWatching(review.repositoryRoot);
        }
        return parseCommandOutput(name, { review });
      }
      case "repository.choose": {
        parseCommandInput(name, rawInput);
        const path = await deps.chooseRepository();
        if (path) allowedRoots.add(path);
        return parseCommandOutput(name, { path });
      }
      case "review.capture": {
        const input = parseCommandInput(name, rawInput);
        assertAllowedRepository(input.repoPath);
        const review = await service.capture(input.commandId, input.repoPath, input.reviewId);
        allowedRoots.add(review.repositoryRoot);
        deps.setRepositoryDirty(false);
        deps.startWatching(review.repositoryRoot);
        return parseCommandOutput(name, { review });
      }
      case "review.openPr": {
        // The GitHub PR front door. `repoPath` is the local clone the renderer just
        // picked (so it is already in allowedRoots); the diff is taken locally
        // against the PR's pinned OIDs. A PR review is a snapshot, so it is NOT
        // wired into the working-tree freshness watcher (the renderer gates that off
        // by patchset source) — nothing to watch, nothing to invalidate here.
        const input = parseCommandInput(name, rawInput);
        assertAllowedRepository(input.repoPath);
        const review = await deps.openPullRequest(
          input.commandId,
          input.ref,
          input.repoPath,
          input.retrospective ?? false,
        );
        allowedRoots.add(review.repositoryRoot);
        return parseCommandOutput(name, { review });
      }
      case "review.setDisposition": {
        const input = parseCommandInput(name, rawInput);
        const review = service.setDisposition(
          input.commandId,
          input.reviewId,
          input.patchsetId,
          input.path,
          input.disposition,
          input.body,
        );
        return parseCommandOutput(name, { review });
      }
      case "review.checkFreshness": {
        const input = parseCommandInput(name, rawInput);
        assertAllowedRepository(input.repoPath);
        const current = requireLatestReview(input.reviewId);
        if (!deps.isRepositoryDirty()) return parseCommandOutput(name, { review: current });
        const review = await service.checkFreshness(
          input.commandId,
          input.reviewId,
          input.repoPath,
        );
        deps.setRepositoryDirty(false);
        return parseCommandOutput(name, { review });
      }
      case "review.regenerate": {
        const input = parseCommandInput(name, rawInput);
        assertAllowedRepository(input.repoPath);
        const review = await service.regenerate(input.commandId, input.reviewId, input.repoPath);
        deps.setRepositoryDirty(false);
        return parseCommandOutput(name, { review });
      }
      case "publish.requestConsent": {
        // The renderer REQUESTS approval to POST to GitHub; MAIN mints the token. It
        // is bound to (review, target, payload) via `publishConsentKey`, so the token
        // authorises exactly one payload onto exactly one PR (coordinates + node id +
        // head) — the renderer must present the SAME target + payload at egress or the
        // token cannot consume.
        const input = parseCommandInput(name, rawInput);
        // Refuse to mint a token for a stale or unknown review id; only the current
        // review can be published from this session.
        const review = requireLatestReview(input.reviewId);
        const target = toForgeReviewTarget(input.target);
        // Bind the mint to the review's OWN pull request (issue #21): a local capture
        // (no postTarget) or a mismatched target cannot even obtain a token, so the
        // real-post path below can never receive one for the wrong PR.
        assertTargetIsReviewOwn(review, target);
        // Bind the resolved VERDICT into the token too, so an APPROVE/REQUEST_CHANGES
        // cannot be swapped in after approval (the verdict is the one outbound field
        // the payload bytes do not capture).
        const key = publishConsentKey(review.id, target, input.payload, input.verdict);
        return parseCommandOutput(name, { authorization: deps.publishConsent.grant(key) });
      }
      case "publish.review": {
        // The FIRST real egress: a decomposed review leaving the machine onto a PR AS
        // THE USER. Every dangerous part is gated here; the pipeline has no other path
        // to egress (this command is reachable only from the trusted renderer origin).
        const input = parseCommandInput(name, rawInput);

        // (0) The RETROSPECTIVE gate (Rule 75, most-permissive-fault): a review opened
        // read-only over an already-merged/any PR must NEVER egress. We resolve the
        // addressed review from the persisted store (the latest, same authority the
        // consent-minting and canvases paths use) and refuse the WHOLE command — dry
        // run included — before any request is built. This is the structural half: the
        // renderer also hides the sign affordance, but even a hand-crafted call cannot
        // post from a retrospective review, in ANY permission mode, because this runs
        // ahead of the mode/consent branch entirely. A single fault (forged mode,
        // replayed token, renderer bug) cannot clear it — it is not on that circuit.
        const addressed = requireLatestReview(input.reviewId);
        if (addressed.retrospective) {
          throw new Error(
            "Publish refused: this is a retrospective review — it is read-only and nothing can be posted.",
          );
        }

        const target = toForgeReviewTarget(input.target);

        // (1) Egress-side "what you see is what leaves" (R33), the MAIN analogue of
        // the #106 UI gate: the canonical bytes re-derived from `comments` must equal
        // the signed `payload` EXACTLY (===, never prefix/substring). A disagreement
        // fails CLOSED. This runs on dry-run TOO, so a corrupt payload surfaces as a
        // refusal rather than a plausible-looking request.
        if (canonicalReviewPayload(input.comments) !== input.payload) {
          throw new Error("Publish refused: the review payload does not match its content");
        }
        // (2) An empty review is not a valid egress — refuse rather than post nothing.
        if (input.comments.length === 0) {
          throw new Error("Publish refused: the review has no content");
        }

        // (3) Assemble the forge-neutral post (event COMMENT — no APPROVE shape; every
        // no-line fold ledgered, never a silent drop).
        const post = buildForgeReviewPost(input.comments, {
          reviewId: input.reviewId,
          target,
          payload: input.payload,
          capabilities: deps.publishPort.capabilities,
          // Derive-first, overridable: an explicit verdict wins; else it derives from
          // the dispositions. `undefined` simply defers to the derived verdict.
          ...(input.verdict ? { verdict: input.verdict } : {}),
        });

        if (input.dryRun === false) {
          // (4) REAL egress. Posting a review to GitHub is an EXTERNAL act — a review
          // leaving the machine AS THE USER — so unlike running a model (which just
          // runs), a real send ALWAYS requires an explicit user confirmation.
          //
          // (4a) TARGET-BINDING gate (most-permissive-fault): the post must target the
          // review's OWN pull request. A local capture (no postTarget) or a mismatched
          // target is refused BEFORE the token is even looked at, so a token can never
          // authorise a post to an arbitrary PR — it runs on the same authority
          // (`addressed.postTarget`) the retrospective gate does.
          assertTargetIsReviewOwn(addressed, target);
          // (4b) The single-use CONSENT token MAIN minted for THIS (review, target,
          // payload, VERDICT) via `publish.requestConsent`, verified + CONSUMED here.
          // Absent / forged / replayed / target-payload-or-verdict-mismatched ⇒ refused,
          // and NOTHING leaves. The verdict is resolved the SAME way it is for the post
          // (`resolveReviewEvent`), so the token authorises exactly the event that ships.
          const resolvedVerdict = resolveReviewEvent(input.comments, input.verdict);
          const key = publishConsentKey(input.reviewId, target, input.payload, resolvedVerdict);
          const authorization = input.authorization;
          if (
            typeof authorization !== "string" ||
            !deps.publishConsent.consume(key, authorization)
          ) {
            throw new Error("Publish refused: not authorized to post — confirm the send first");
          }
          // (4c) Single-flight by marker (double-sign race): refuse a concurrent real
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
        // No mode/consent check — nothing leaves — and the descriptor carries no token.
        return parseCommandOutput(name, {
          dryRun: true,
          request: deps.publishPort.buildReviewRequest(post),
          marker: post.marker,
          ledger: post.ledger,
          outcome: null,
        });
      }
      case "review.canvases": {
        const input = parseCommandInput(name, rawInput);
        assertAllowedRepository(input.repoPath);
        const review = requireLatestReview(input.reviewId);
        // Running the review harness (the model spend) is Rennet's entire job — it
        // just runs. No permission mode, no consent token: opening Canvases composes
        // the model turn directly.
        const { canvases, elementDiffs, narration, engine, decisionsRun } =
          await deps.buildCanvases(review);
        return parseCommandOutput(name, {
          canvases,
          elementDiffs,
          ...(narration ? { narration } : {}),
          engine,
          // The Decisions runner's status (issue #137/#160): carried so the renderer
          // can paint a FAILED decisions pass distinctly from "ran, found nothing".
          // Absent ⇒ the UI defaults to `ok` (the pre-#160 shape).
          ...(decisionsRun ? { decisionsRun } : {}),
        });
      }
      // ── The front door: projects + discovery (issue #29) ──────────────────────
      case "harness.detect": {
        // The ambient detection line. Read-only, no repository, no index touch.
        parseCommandInput(name, rawInput);
        return parseCommandOutput(name, { detected: await deps.detectHarnesses() });
      }
      case "projects.list": {
        parseCommandInput(name, rawInput);
        const projects = deps.projects.list();
        // Re-grant every persisted project's open target so a project row opened
        // after a relaunch reaches `review.capture` (the user added these paths).
        for (const project of projects) allowedRoots.add(project.openPath);
        return parseCommandOutput(name, { projects });
      }
      case "project.discover": {
        // Read-only discovery over the path the user just chose (`repository.choose`
        // granted it). The allowlist is the read-only discovery gate: only a chosen
        // path is scanned, never an arbitrary renderer-supplied one.
        const input = parseCommandInput(name, rawInput);
        assertAllowedRepository(input.path);
        const discovery = await deps.discoverProject({ path: input.path, kind: input.kind });
        return parseCommandOutput(name, { discovery });
      }
      case "projects.add": {
        // Confirm. MAIN derives the stored shape from the discovery + the toggle
        // choices, then grants the new open target so the row is immediately openable.
        const input = parseCommandInput(name, rawInput);
        const { project, projects } = deps.projects.add({
          discovery: input.discovery,
          includedRepos: [...input.includedRepos],
          primaryBranch: input.primaryBranch,
        });
        allowedRoots.add(project.openPath);
        return parseCommandOutput(name, { project, projects });
      }
      case "project.process": {
        // The initial context dump: build each included repo's ProjectSnapshot,
        // streaming the real generator stages as live narration. The host owns the
        // generator + store; dispatch owns the terminal `done` event and the
        // resolved value, so both always agree. Soft per-repo failures are carried
        // in the summaries (never a throw), so one bad repo never aborts the rest.
        const input = parseCommandInput(name, rawInput);
        const emit = ctx?.emitProgress ?? (() => undefined);
        const { repos } = await deps.processProject({ projectId: input.projectId }, emit);
        emit({ kind: "done", repos });
        return parseCommandOutput(name, { repos });
      }
      // ── Project detail: the unified smart list (issue #37) ────────────────────
      case "project.detail": {
        // Read-only substrate for a project the user has added. No repository
        // capture, no model spend: real local work (git) + live GitHub OPEN PRs +
        // viewer, which the renderer folds into one list. A missing GitHub token
        // degrades to the local-only half, never a failed fetch shown as zero PRs.
        const input = parseCommandInput(name, rawInput);
        return parseCommandOutput(name, await deps.projectDetail(input.projectId));
      }
      case "project.cleanupWorktree": {
        // The merged-PR read-only row's clean-up. A destructive local act, so it is a
        // command rather than a renderer effect; the host handler runs a real, NON-
        // forcing `git worktree remove` (a dirty worktree is refused, never swept).
        const input = parseCommandInput(name, rawInput);
        const result = await deps.cleanupWorktree({
          projectId: input.projectId,
          worktreeId: input.worktreeId,
        });
        return parseCommandOutput(name, result);
      }
      // ── The Flagged lens (issue #138) ─────────────────────────────────────────
      case "flagged.review": {
        // The LIVE automated review layer (#32): the finding-generation runner turns
        // the review's diff into real findings. It spends a budgeted model invocation,
        // so — as with `review.canvases` — we resolve the addressed review (a stale or
        // unknown id is refused) and hand the runner the review, never a bare id.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        // Dual-model is the DEFAULT (Rai's mandate, 2026-08-11): an omitted flag runs
        // BOTH provider seats. Only an explicit `false` opts down to single-Claude.
        const flagged = await deps.flaggedReview(review, input.deepReview ?? true);
        // Stamp the patchset this result was computed against (#160/P0-2) so the renderer
        // can bind it to the canvases beside it and discard a regenerate-stale result.
        return parseCommandOutput(
          name,
          flagged.status === "ok" ? { ...flagged, patchsetId: review.activePatchsetId } : flagged,
        );
      }
      // ── Ask the AI a question about the review (issue #139) ────────────────────
      case "review.ask": {
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
        const review = requireLatestReview(input.reviewId);
        const mode = input.mode ?? "orchestrator";
        const result = await askReview(mode, input.question, {
          askOrchestrator: (question) => deps.reviewAsk.askOrchestrator({ review, question }),
          askCodex: (question) => deps.reviewAsk.askCodex({ review, question }),
        });
        return parseCommandOutput(name, result);
      }
      // ── Refine a rough note into a clean comment (issue #19) ───────────────────
      case "review.refine": {
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
        const review = requireLatestReview(input.reviewId);
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
      }
      // ── The review→agent handoff loop (issue #18, Contracts §2.1) ──────────────
      case "review.handoff.prepare": {
        // Compose the bundle from the addressed dispositions + the active patchset and
        // return it with a disclosure the UI shows. Pure — no session, no spend.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        const bundle = buildHandoffBundle({
          reviewId: review.id,
          patchset: activePatchsetOf(review),
          dispositions: input.dispositions,
        });
        return parseCommandOutput(name, {
          bundle,
          disclosure: disclosureFor(bundle, "claude-code"),
        });
      }
      case "review.handoff.run": {
        // The write-enabled turn. Clicking run IS the human act — no consent gate (Rule
        // Zero). Rebuild the bundle from the dispositions + the active patchset, run the
        // fully-capable write session (Bash included, Rai's call), and capture the delta.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        assertAllowedRepository(review.repositoryRoot);
        const priorActive = activePatchsetOf(review);
        const bundle = buildHandoffBundle({
          reviewId: review.id,
          patchset: priorActive,
          dispositions: input.dispositions,
        });
        if (!deps.runHandoffTurn) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: "no coding harness is available to run the handoff",
          });
        }
        const turn = await deps.runHandoffTurn({ repoRoot: review.repositoryRoot, bundle });
        if (turn.status === "failed") {
          // Surface the files the agent changed before erroring (Codex F4) — the working
          // tree was modified even though the turn failed; hiding it defeats totality.
          deps.setRepositoryDirty(turn.filesTouched.length > 0);
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
        const updated = await service.capture(input.commandId, review.repositoryRoot, review.id);
        deps.setRepositoryDirty(false);
        // R28 immutability: the pre-handoff patchset must survive byte-identical. Its
        // id is content-addressed over (repository, files, bytes), so the SAME id still
        // present proves the content was never rewritten.
        const preserved = updated.patchsets.find((candidate) => candidate.id === priorActive.id);
        if (!preserved) {
          throw new Error(
            "Handoff violated patchset immutability: the prior patchset was rewritten",
          );
        }
        const result: HandoffRunResult = {
          review: updated,
          turnDiff: turn.turnDiff,
          filesTouched: [...turn.filesTouched],
          carriedForward: updated.dispositions.length,
          orphaned: updated.orphaned?.length ?? 0,
        };
        return parseCommandOutput(name, { status: "ran", result });
      }
      // ── Draft the PR title + body (issue #74, M26) ─────────────────────────────
      case "review.draftPrBody": {
        // The own-branch destination's PR-submission preview (#22) needs a title +
        // body. Resolve the CURRENT review ONCE (a stale/unknown id is refused), then
        // run the council-routed drafting turn over the reviewed changeset the renderer
        // handed in. ⚠️ EGRESS: the drafting material IS sent to the harness (the same
        // per-turn egress every lens makes) — but the RESULT posts NOTHING. It is a
        // draft into a preview; creating the PR is the separate hold-to-sign act (#21).
        // With no drafter wired, answer an honest `unavailable` rather than throwing —
        // the renderer keeps the deterministic composed body.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        if (!deps.draftPrBody) {
          return parseCommandOutput(name, {
            status: "unavailable",
            reason: "PR-body drafting is not available in this build",
          });
        }
        return parseCommandOutput(
          name,
          await deps.draftPrBody({
            review,
            base: input.base,
            head: input.head,
            dispositions: input.dispositions,
            ...(input.narration === undefined ? {} : { narration: input.narration }),
            ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
            ...(input.decisions === undefined ? {} : { decisions: input.decisions }),
          }),
        );
      }
      // ── Compose the handoff bundle (issue #72, Model Council M24) ───────────────
      case "review.handoff.compose": {
        // The light-tier authoring step over the mechanical bundle: build the
        // deterministic bundle from the addressed dispositions, then let the composer
        // order + merge + narrate it. The core composer owns the safety law (partition
        // validation, verbatim-body reconstruction, fail-closed to the mechanical
        // floor), so a failed/absent composer yields `composed:false` — a real,
        // complete bundle — never a throw and never a lossy authoring.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        const mechanical = buildHandoffBundle({
          reviewId: review.id,
          patchset: activePatchsetOf(review),
          dispositions: input.dispositions,
        });
        const bundle = deps.composeBundle
          ? await deps.composeBundle({ bundle: mechanical, repoRoot: review.repositoryRoot })
          : mechanicalComposition(mechanical);
        return parseCommandOutput(name, { bundle });
      }
      // ── The Noise lens (issue #34) ────────────────────────────────────────────
      case "noise.review": {
        // The LIVE noise-classification runner (#34): the noise-generation runner turns
        // the review's diff into real grouped churn. It spends a budgeted model
        // invocation, so — as with `flagged.review` — we resolve the addressed review
        // (a stale or unknown id is refused) and hand the runner the review, never a
        // bare id.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        return parseCommandOutput(name, await deps.noiseReview(review));
      }
      // ── The symbol inspector (wireframes #8) ───────────────────────────────────
      case "review.symbolLookup": {
        // Resolve the addressed review ONCE (a stale/unknown id is refused), then read
        // both symbolic ops for the clicked name. No model spend — deterministic index
        // reads. With no symbolic backend wired, answer honestly `unavailable` for
        // both sections rather than throwing (the UI degrades to a clear message).
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
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
      }
      // ── The Spec angle's live OpenSpec change (wireframes #9) ──────────────────
      case "openspec.change": {
        // Parse-on-open of the change the reviewed patchset selected. Deterministic —
        // no model spend. Resolve the addressed review (a stale/unknown id is refused),
        // then read + parse. No reader wired, or no change in the patchset ⇒ `null`,
        // and the Spec angle shows its honest empty state.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        return parseCommandOutput(
          name,
          deps.openSpecChange ? await deps.openSpecChange(review) : null,
        );
      }
      // ── The Spec view's requirement→hunk coverage (wireframes #9 / R53) ────────
      case "openspec.coverage": {
        // The produced hunk↔requirement mapping over the review's change. Spends a
        // budgeted model turn, so — like flagged.review — we resolve the addressed
        // review (a stale/unknown id is refused) and hand the runner the review.
        // Unwired ⇒ `null` (the Spec view renders no coverage chips), never a fixture.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        return parseCommandOutput(
          name,
          deps.openSpecCoverage ? await deps.openSpecCoverage(review) : null,
        );
      }
      // ── Open a review file in the editor (wireframes #8) ───────────────────────
      case "review.openInEditor": {
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        if (!deps.openInEditor) return parseCommandOutput(name, { ok: false });
        return parseCommandOutput(
          name,
          await deps.openInEditor({ review, path: input.path, line: input.line }),
        );
      }
      // ── Canvas user ops (issue #54 wires #10's command surface into dispatch) ──
      case "canvas.disposition": {
        // The sovereign L2 write maps directly onto the review's disposition path
        // (#49 item 1/2 — the protocol input already uses `path`/`disposition`).
        // A span/side (issue #78) makes it span-grained (the Spec view's per-node
        // review); absent, it stays path-grained exactly as before.
        const input = parseCommandInput(name, rawInput);
        const review = service.setDisposition(
          input.commandId,
          input.reviewId,
          input.patchsetId,
          input.path,
          input.disposition,
          input.body,
          input.span,
          input.side,
        );
        return parseCommandOutput(name, { review });
      }
      case "canvas.adjudicateProposal": {
        // L3 proposal resolution ack. Accepting a disposition proposal issues its
        // L2 write as a separate `canvas.disposition` from the renderer (accepting
        // is a user act); there is no durable L3 canvas-op store in this slice (#13).
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        return parseCommandOutput(name, { review });
      }
      case "canvas.setCohortExpansion":
      case "canvas.select":
      case "canvas.pinAnnotation":
      case "canvas.clearAnnotation": {
        // L3 / view ops with no durable store in this slice (#13). Validate the
        // input and acknowledge; the renderer holds the ephemeral view state.
        parseCommandInput(name, rawInput);
        return parseCommandOutput(name, { ok: true });
      }
      // ── Settings: the config ladder (wireframe #15) ───────────────────────────
      case "settings.get": {
        // Read-only: the global appearance layer + every project's resolved repo
        // config with provenance. Absent settings dep ⇒ builtin-only view (no
        // global override, no projects), never a throw.
        parseCommandInput(name, rawInput);
        if (!deps.settings) {
          return parseCommandOutput(name, {
            scheme: "system",
            schemeProvenance: {
              layer: "builtin",
              contributions: [{ layer: "builtin", value: "system", effective: true }],
            },
            appearanceMalformed: false,
            projects: [],
          });
        }
        return parseCommandOutput(name, await deps.settings.get());
      }
      case "settings.guidance": {
        // Read-only: one repo's `.rennet/conventions.json` house rules, shown
        // read-through. Absent dep ⇒ the honest empty catalogue.
        const input = parseCommandInput(name, rawInput);
        if (!deps.settings) {
          return parseCommandOutput(name, { rules: [], reason: "absent", dropped: 0 });
        }
        return parseCommandOutput(
          name,
          await deps.settings.guidance(input.projectId, input.repoPath),
        );
      }
      case "settings.setAppearance": {
        // Personal, app-side: writes only `~/.rennet/config.json`. No repo write.
        // The dep REFUSES (throws) when the config is malformed; that error
        // propagates to the renderer rather than overwriting unparseable bytes.
        const input = parseCommandInput(name, rawInput);
        if (!deps.settings) {
          return parseCommandOutput(name, {
            scheme: input.scheme,
            schemeProvenance: {
              layer: "global",
              contributions: [
                { layer: "builtin", value: "system", effective: false },
                { layer: "global", value: input.scheme, effective: true },
              ],
            },
          });
        }
        const scheme = deps.settings.setAppearance(input.scheme);
        // Re-resolve so the surface renders the resolver's own provenance answer.
        return parseCommandOutput(name, {
          scheme,
          schemeProvenance: (await deps.settings.get()).schemeProvenance,
        });
      }
      case "settings.setRepoVisibility": {
        // Genuinely consumed: runs the real visibility switch (a repo `.gitignore`
        // write, exclusion state only) and records `visibility` in the repo's
        // config. A `status` other than `applied` means NOTHING was written (an
        // unresolved checkout or a refused-because-malformed config). Absent dep ⇒
        // a typed `unresolved` no-op, mirroring `openInEditor`.
        const input = parseCommandInput(name, rawInput);
        if (!deps.settings) {
          return parseCommandOutput(name, {
            status: "unresolved",
            visibility: input.visibility,
            changed: false,
            gitignorePath: "",
          });
        }
        const result = await deps.settings.setRepoVisibility({
          projectId: input.projectId,
          repoPath: input.repoPath,
          visibility: input.visibility,
        });
        return parseCommandOutput(name, result);
      }
      default: {
        // Exhaustiveness guard: every CommandName is routed above, so `name` is
        // `never` here. If a future command is added to the protocol without a
        // route, this fails at compile time rather than silently returning
        // `undefined` to the renderer.
        const unreachable: never = name;
        throw new Error(`Unhandled command: ${String(unreachable)}`);
      }
    }
  };
}
