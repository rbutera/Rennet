import {
  type AskAnswer,
  askReview,
  buildForgeReviewPost,
  canonicalReviewPayload,
  type ForgePublishPort,
  type ForgeReviewTarget,
  type ReviewService,
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
  parseCommandInput,
  parseCommandOutput,
} from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  DecisionsRunStatus,
  ElementDiffs,
  FlaggedReview,
  NoiseReview,
  Review,
  ReviewEngine,
  ReviewNarration,
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
   * (issue #41) opts into the dual-model path (two provider seats reconciled into
   * agreement/disagreement); omitted/false is the single-seat quick review.
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

  function assertAllowedRepository(repositoryPath: string): void {
    if (!allowedRoots.has(repositoryPath)) throw new Error("Repository access was not granted");
  }

  /** The latest review, asserted to be the one addressed (freshness/canvases path). */
  function requireLatestReview(reviewId: string): Review {
    const current = service.bootstrap();
    if (!current || current.id !== reviewId) throw new Error("Review not found");
    return current;
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
        const key = publishConsentKey(review.id, toForgeReviewTarget(input.target), input.payload);
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
          // runs), a real send ALWAYS requires an explicit user confirmation. MAIN
          // requires the single-use CONSENT token it minted for THIS (review, target,
          // payload) via `publish.requestConsent`, verified + CONSUMED here. Absent /
          // forged / replayed / target-or-payload-mismatched ⇒ refused, and NOTHING
          // leaves. This is the machine's most dangerous action; the confirmation is
          // unconditional, never governed by a permission mode.
          const key = publishConsentKey(input.reviewId, target, input.payload);
          const authorization = input.authorization;
          if (
            typeof authorization !== "string" ||
            !deps.publishConsent.consume(key, authorization)
          ) {
            throw new Error("Publish refused: not authorized to post — confirm the send first");
          }
          const outcome = await deps.publishPort.publishReview(post);
          return parseCommandOutput(name, {
            dryRun: false,
            request: deps.publishPort.buildReviewRequest(post),
            marker: post.marker,
            ledger: post.ledger,
            outcome,
          });
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
        const { canvases, elementDiffs, narration, engine } = await deps.buildCanvases(review);
        return parseCommandOutput(name, {
          canvases,
          elementDiffs,
          ...(narration ? { narration } : {}),
          engine,
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
        return parseCommandOutput(
          name,
          await deps.flaggedReview(review, input.deepReview ?? false),
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
