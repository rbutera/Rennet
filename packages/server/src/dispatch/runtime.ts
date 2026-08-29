import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { AskLogStore } from "@rennet/adapters";
import {
  type AskAnswer,
  canonicalReviewPayload,
  emptyAskProjection,
  type ForgePrSubmission,
  type ForgePrSubmissionOutcome,
  type ForgePublishPort,
  type ForgeReviewTarget,
  forgeTargetKey,
  type HandoffTurnOutcome,
  type ReviewService,
  reviewBodyNotesFromProjection,
  reviewCommentsFromProjection,
} from "@rennet/core";
import type {
  AnchorSide,
  AnchorSpan,
  AskProjection,
  ComposedHandoffBundle,
  DeltaDigestResult,
  DispositionType,
  FlaggedReview,
  HandoffBundle,
  LensAbsenceReason,
  LensBoard,
  LensKind,
  NoiseReview,
  OpenSpecChange,
  OpenSpecCoverage,
  Patchset,
  PrBodyDraftResult,
  RefinementResult,
  Review,
  RoundEvent,
  RoundRecord,
  SessionTranscriptRow,
  SidebarSession,
  SuccessorAccount,
  SymbolInspection,
} from "@rennet/protocol";
import {
  type ConversationAnchorWire,
  type DetectedForge,
  type DetectedHarness,
  type DiscoveryResult,
  type FsListDirResult,
  type GitHubAuthStatus,
  type GitHubConnectPoll,
  type KnowledgeDispositionResult,
  type PairedDevice,
  type PersistedThreadMessageWire,
  type ProcessedRepoSummary,
  type Project,
  type ProjectContextAskResult,
  type ProjectContextMapResult,
  type ProjectDetail,
  type ProjectDetailProgressEvent,
  type ProjectKind,
  type ProjectProcessEvent,
  type ProjectProgressEvent,
  type PrWorktreeSetup,
  type PullRequestState,
  type ReattachResult,
  type ReviewAskStreamEvent,
  sha256Hex,
} from "@rennet/protocol";
import { deepLinkFor, type RaisedAttention } from "../attention-planner";
import {
  createReviewIntelligenceSessions,
  type ReviewIntelligenceSession,
} from "../review-intelligence-session";
import type { SettingsComposition } from "../settings";

/**
 * The command router (issue #54), extracted from the electron main so it can be
 * unit-tested without an Electron runtime. Every electron-side effect is
 * injected: the repository picker (dialog), the change watcher, the dirty flag,
 * and the harness-backed canvas builder. `index.ts` composes these; this module
 * is pure command routing over `ReviewService` + `@rennet/protocol`.
 */
/** The pairing surface the router calls for the four `pairing.*` commands (issue #380). */
export interface PairingCommands {
  mint(): { code: string; expiresAt: string };
  exchange(code: string, deviceName: string): { deviceToken: string; deviceId: string };
  listDevices(): PairedDevice[];
  revokeDevice(deviceId: string): PairedDevice[];
}

export interface DispatchDeps {
  readonly service: ReviewService;
  /** Device pairing (mint code / exchange for token / list / revoke). Server-side secret store. */
  readonly pairing: PairingCommands;
  /**
   * Push-token registry for `device.registerPush` (issue #383 M1). Present only when the
   * daemon wired the attention system; a connection's authenticated `ctx.deviceId` keys the
   * token. Absent ⇒ the command is unreachable (the daemon never advertised `attention`, so
   * a compliant client never calls it) and the handler rejects it.
   */
  readonly pushTokens?: {
    set(
      deviceId: string,
      token: string,
      platform: "ios" | "android",
      disabledFamilies?: readonly string[],
    ): void;
    delete(deviceId: string): void;
  };
  /**
   * Attention acknowledgment for `attention.acknowledge` (issue #383 M1). Clears matching
   * attention on the daemon and broadcasts the clear to every client; returns the count. Absent
   * ⇒ attention is off and the handler returns `{ cleared: 0 }`.
   */
  readonly acknowledgeAttention?: (selector: { reviewId?: string; attentionId?: string }) => number;
  /**
   * Raise an attention event (issue #383 M1) — the planner decides live-vs-push per client.
   * Fire-and-forget; absent ⇒ attention is off. Wired to the review-finished source (capture /
   * openPr / regenerate) this pass; the other five families raise from their own sources as
   * they are wired (see the attention-notifications spec and the mobile plan).
   */
  readonly raiseAttention?: (event: RaisedAttention) => string | undefined;
  /**
   * The in-flight-review registry (#383 batch): a review-scoped turn marks its review running
   * for the duration, so the projection can report `attention.running` truthfully. Absent ⇒ no
   * running tracking (running reads false).
   */
  readonly inFlightReviews?: { enter(reviewId: string): void; leave(reviewId: string): void };
  /**
   * Fired after a review OPENS (`review.capture` / `review.openPr` return their
   * review) — the real review-open choke point (#461, B7). The composition root
   * kicks related-context retrieval here, fire-and-forget: the hook is sync-void
   * and must never throw; a review never blocks on it.
   */
  readonly onReviewOpened?: (review: Review) => void;
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
    repoPath: string | undefined,
    retrospective: boolean,
  ): Promise<Review>;
  /**
   * Capture a review of a BRANCH (#587) — the New Chat row click's engine. Resolves
   * `head` and `git merge-base base head`, then takes the `base...head` range through the
   * SAME `captureRangePatchset` the PR source uses, with `source: "local-branch"`. No
   * checkout switch; the working tree is never touched, so the review is a snapshot like
   * a PR's — and `local-branch` is what keeps the renderer's freshness/Regenerate path,
   * which keys on the working-tree `local`, from overwriting the reviewed range.
   * A branch with no unique commits yields an EMPTY patchset — an honestly empty review,
   * never a failed click. Absent ⇒ `review.capture` with a `branch` is refused honestly.
   */
  captureBranch?(commandId: string, repoPath: string, head: string, base: string): Promise<Review>;
  /**
   * The reviewed PR's worktree + setup status (historical-PR review), `null` when
   * the review has none (a working-tree capture, or checkout failed). Read-only.
   */
  prWorktree(reviewId: string): Promise<{
    path: string;
    setup: PrWorktreeSetup;
    logTail: string;
  } | null>;
  /** Begin watching a captured repository root for on-disk changes. */
  startWatching(root: string): void;
  /**
   * Whether a persisted review's recorded repository root still exists on disk
   * (issue #324). The one fact only main can cheaply provide for load/bootstrap, so
   * the renderer shows honest missing-context status and skips freshness. Injectable
   * for tests; defaults to `node:fs` existsSync.
   */
  repositoryExists?(root: string): boolean;
  isRepositoryDirty(): boolean;
  setRepositoryDirty(dirty: boolean): void;
  /**
   * The forge egress port (issue #21). `buildReviewRequest` is pure and network-free
   * (the dry-run evidence, no credential); `publishReview` performs the real, gated
   * post. Read/egress are separate ports, so only the publish command can egress.
   */
  readonly publishPort: ForgePublishPort;
  /**
   * The own-branch PR submission action (issue #257 / #107): push the review's own
   * branch and open a real pull request. Composed by the root over the host git push
   * (`git push origin <headRef>`) + the GitHub create-PR adapter, with the repo's
   * GitHub identity resolved from its remotes. Optional so a composition WITHOUT it
   * (no coding harness / no auth) answers an honest failure rather than throwing.
   * There is NO consent token: pushing your own branch is not publishing, and the
   * sign-click is the whole authorization.
   */
  readonly submitPullRequest?: (input: {
    repoRoot: string;
    /** The head branch ref to push and open the PR against (#107). */
    headRef: string;
    submission: ForgePrSubmission;
  }) => Promise<ForgePrSubmissionOutcome>;
  /**
   * The write-enabled handoff turn (issue #18): brackets a coding-harness write turn
   * with workspace checkpoints and returns the turn diff. Composed by the root as
   * `runHandoffTurn` over the live Claude adapter (fully capable, Bash included) + the
   * git checkpoint store. Optional so a composition WITHOUT a coding harness still constructs — the
   * `run` command then answers an honest `unavailable` rather than throwing.
   */
  readonly runHandoffTurn?: (input: {
    repoRoot: string;
    /** The composed bundle's ordered, verbatim work-order prompt (issue #72). */
    prompt: string;
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
    remove(input: { projectId: string }): { projects: Project[] };
    /** Rename a project's display name (C12 cluster 7, bound in C18). An emptied name
     *  restores the `org/repo` fallback (R67); `null` means the id is not stored. */
    rename(input: { projectId: string; name: string }): {
      project: Project | null;
      projects: Project[];
    };
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
  /**
   * The ungated filesystem browser (Rule Zero: this is the browser, not a gated
   * reader). Empty/omitted path ⇒ the daemon's home dir.
   */
  listDir(input: { path?: string }): Promise<FsListDirResult>;
  /** The harnesses found on the machine, for the ambient first-run detection line. */
  detectHarnesses(): Promise<DetectedHarness[]>;
  /** The forge (source-control) CLIs found on this host, for `forge.detect` → the
   *  Environments surface's `sourceControlByHost` (C17). Singleton registry — `gh` only. */
  detectForges(): Promise<DetectedForge[]>;
  /**
   * The GitHub account port (v4.2: OAuth device flow, no gh CLI). Status for the
   * settings rows and the first-run card; the one-time device-flow connect
   * (start/poll/cancel); the pasted-token side door; disconnect. The token itself
   * never crosses this boundary outward.
   */
  github: {
    status(): Promise<GitHubAuthStatus>;
    connectStart(): Promise<{ userCode: string; verificationUri: string }>;
    connectPoll(): Promise<GitHubConnectPoll>;
    connectCancel(): Promise<void>;
    setToken(token: string): Promise<GitHubAuthStatus>;
    disconnect(): Promise<void>;
  };
  /**
   * The project-detail substrate (issue #37): the raw local work + pull requests +
   * viewer the unified smart list folds into rows. Read-only. A fixture stands behind
   * this until the live git/GitHub loop lands.
   */
  projectDetail(
    projectId: string,
    prStates?: readonly PullRequestState[],
    localOnly?: boolean,
    /** Per-repo PR-fetch narration, streamed under the input's `commandId`. */
    emit?: (event: ProjectDetailProgressEvent) => void,
  ): Promise<ProjectDetail>;
  /**
   * Clean up a merged PR's local worktree/branch (the read-only row's action). A
   * destructive local act; the host handler is a documented stub this wave.
   */
  cleanupWorktree(input: { projectId: string; worktreeId: string }): Promise<{ ok: boolean }>;
  /**
   * The Context Map surface's read (change add-context-map-view): the persisted Repo
   * Map — deterministic ProjectMap + local knowledge set — from the on-disk project
   * store. Pure read: no rebuild, no model spend; absent/stale gates to typed absent.
   */
  projectContextMap(projectId: string): Promise<ProjectContextMapResult>;
  /**
   * Project-scoped context ask (change add-context-map-view): the same engine
   * `context.ask` runs for a review, keyed at the project's persisted tip. Model
   * spend through the user's own harness; unanswered/failed are first-class.
   */
  projectContextAsk(input: {
    projectId: string;
    question: string;
    scope?: string;
  }): Promise<ProjectContextAskResult>;
  /**
   * Human disposition of a knowledge statement (the R54 "a human confirms it"
   * surface): flip status by id, persist the set. Never edits the claim.
   */
  knowledgeDisposition(input: {
    projectId: string;
    statementId: string;
    disposition: "confirmed" | "rejected";
  }): Promise<KnowledgeDispositionResult>;
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
  flaggedReview(
    review: Review,
    deepReview: boolean,
    session: ReviewIntelligenceSession,
  ): Promise<FlaggedReviewRun>;
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
    askOrchestrator(input: {
      review: Review;
      question: string;
      /** Token-stream sink (#251): each orchestrator token as it arrives, when the ask
       *  is a streamed one. Absent for a one-shot #139 ask. */
      onDelta?: (text: string) => void;
      selection?: { anchor: string; excerpt?: string };
      onFocus?: (anchor: string) => void;
      /** Cancels the turn (#251 criterion 4): the LiveTurnRegistry's controller for this
       *  turn, threaded to the claude SDK so `before-quit` reaps it. Absent → an
       *  uncancellable turn (fully back-compat: no registry wired). */
      abortController?: AbortController;
    }): Promise<AskAnswer>;
    askCodex(input: {
      review: Review;
      question: string;
      /** Cancels the codex exec (#251 criterion 4): the SAME controller the orchestrator
       *  leg gets, so one quit-abort cancels BOTH legs of a "both" ask. */
      abortController?: AbortController;
    }): Promise<AskAnswer>;
  };
  /**
   * The live-turn registry (issue #251, criterion 4 — scoped reaping on quit). Optional
   * so a composition with no registry still constructs — dispatch then runs the ask with
   * NO abort seam (fully back-compat: the #139/#251 ports are called with exactly their
   * existing inputs, no controller threaded). When present, each `review.ask` turn
   * REGISTERS its AbortController when it starts and SETTLES it when it finishes (whether
   * it completed, errored, or was aborted), so `before-quit` can abort the ones still in
   * flight. The registered controller is threaded into BOTH model legs.
   */
  readonly liveTurns?: {
    /** `reviewId` (#382 M2) indexes the turn so `review.interrupt` can abort it by review; `stream`
     *  marks a live streaming turn so `review.reattach` resumes its real in-flight body (finding 5). */
    register(
      turnId: string,
      reviewId?: string,
      stream?: { threadId: string; channel: "orchestrator" | "codex" },
    ): AbortController;
    settle(turnId: string): void;
    /** Grow a live turn's coalesced body as deltas stream (the reattach cursor, #382 M2 finding 5). */
    appendDelta(turnId: string, delta: string): void;
    /** The coalesced body streamed so far — the truthful partial persisted on interrupt (finding 6). */
    bodyOf(turnId: string): string;
    /** Abort every in-flight turn on a review (the client "Stop", #382 M2); returns the count. */
    abortReview(reviewId: string): number;
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
   * The delta re-review digest producer (issue #73 / M25): rephrase a successor
   * review's deterministic `successorAccount` into a one/two-sentence TL;DR shown ON TOP
   * of the facts. Optional so a composition without it (no coding harness) answers an
   * honest `unavailable` and the panel simply shows no headline. Built from ONLY the
   * account, it can add no fact the facts don't carry; it posts NOTHING and gates
   * nothing.
   */
  readonly draftDeltaDigest?: (input: {
    review: Review;
    account: SuccessorAccount;
  }) => Promise<DeltaDigestResult>;
  /**
   * Reload the persisted conversation threads for a review, plus any turn still
   * streaming in a surviving main process (issue #251). Optional so a composition with
   * no thread store still constructs — dispatch then answers the TRUTHFUL empty result
   * (there are genuinely zero persisted threads and zero tracked in-flight turns, NOT a
   * fabricated set). This is the seam the `ThreadStore` + `LiveTurnRegistry` plug into.
   */
  readonly reattachThreads?: (input: { reviewId: string }) => Promise<ReattachResult>;
  /**
   * Persist a conversation turn as it streams (issue #251), so a turn interrupted by a
   * process death recovers as `interrupted` on re-attach. Optional so a composition with
   * no thread store still constructs (no persistence, streaming still works). `upsertThread`
   * records identity; `putMessage` appends the "you" question + a `streaming` placeholder,
   * then REPLACES the placeholder with the durable answer on completion.
   */
  readonly threadPersistence?: {
    upsertThread(input: {
      reviewId: string;
      threadId: string;
      anchor: ConversationAnchorWire;
      harnessVersionAtCreation?: string;
    }): void;
    putMessage(input: {
      reviewId: string;
      threadId: string;
      message: PersistedThreadMessageWire;
    }): void;
  };
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
  readonly settings?: SettingsComposition;
  /**
   * The durable ask-log store (B11 cluster 2, Q15) — the file-backed per-session
   * event log the `ask.*` handlers are the SOLE writers of. `readProjection` folds
   * the log to the living-draft projection; `append` adds one event. Required: the
   * durable-asks write path is the whole point of the exit, so a composition without
   * it would be a silently non-durable review, not a degraded-but-honest one.
   */
  readonly askLog: AskLogStore;
  /**
   * Push the current ask projection to live clients after an append (R19). The root
   * binds it to the WS fan-out (`broadcastAskProjection`); absent ⇒ no live push (a
   * reconnecting client still reads the durable projection via `ask.read`).
   */
  readonly broadcastAskProjection?: (sessionId: string, projection: AskProjection) => void;
  /**
   * Dispatch a round's composed work-order to the rounds runtime (B11 cluster 4): run the
   * review's dispatched asks as ONE coding-agent turn, serialized per session (one round in
   * flight). Composed by the root over `createRoundsRuntime`. A failure-isolated post-commit
   * kick (the knowledge-swarm / project-scout precedent): the round runs BEHIND the command,
   * this never throws into the command path, and `round.dispatch` returns the composed
   * work-order whether or not the turn later succeeds. Optional so a composition WITHOUT a
   * rounds runtime still constructs — the command then composes + returns the work-order and
   * simply runs no round, rather than throwing.
   */
  readonly dispatchRound?: (input: {
    review: Review;
    workOrder: ComposedHandoffBundle;
  }) => Promise<void>;
  /**
   * The rounds-ledger read for `session.rounds`: the `RoundRecord[]` the live rounds runtime
   * recorded for this review's session, resolved read-only (the READ side of `dispatchRound`'s
   * mint — `resolveRoundSessionId`). Absent ⇒ no rounds runtime wired, so the read answers an
   * honest empty ledger. A session with no dispatched round is honestly empty: BOTH `runRound`
   * and `dispatchRound` record a `RoundRecord` (`runtime/rounds.ts`), the dispatch one carrying
   * `ROUND_NO_REGEN` for the generation fields it did not mint.
   */
  readonly roundRecordsForReview?: (reviewId: string) => readonly RoundRecord[];
  /**
   * The live round-progress catch-up read for `session.roundEvents` (C15 3.1): the ordered
   * `RoundEvent` log this review's round has emitted so far, from the `RoundProgressHub`.
   * The client folds it through the same reducer the push channel feeds, so a cold mount or
   * a mid-round reconnect sees the round it is actually in. Absent ⇒ no hub wired, so the
   * read answers an honest empty log (the run machine's absent state).
   */
  readonly roundEventsForReview?: (reviewId: string) => readonly RoundEvent[];
  /**
   * The display-transcript read for `session.transcript` (issue-set B): the projected coding-turn
   * rows the turn loop captured and persisted for this review's session, resolved read-only via
   * the same `resolveRoundSessionId` the rounds read uses. Rows are stored RAW — R19 scrubs them
   * at the wire, for a projected connection only. Absent ⇒ no transcript store wired; a session with no captured turns yet
   * returns `[]` (honest-empty — the capability is present, no fabricated content). The harness
   * CLI stays the canonical conversation owner; this is an additive display read-model.
   */
  readonly transcriptRowsForReview?: (reviewId: string) => readonly SessionTranscriptRow[];
  /**
   * The sidebar's sessions (C03 cluster 2, bound in C18) — the durable session store's
   * rows and their persisted writes. Absent ⇒ no session store wired, so `session.list`
   * answers an honest empty sidebar and each write reports that it found no session
   * (`null`), never a fabricated row or a silently swallowed edit.
   */
  readonly sessions?: {
    list(): readonly SidebarSession[];
    /**
     * The New Chat front door (C21, #587): start a session on a target — capture what
     * changed, mint, claim, and attach the review — as ONE host-owned act.
     *
     * It is one act because the client cannot make it one. The renderer can issue mint,
     * then capture, then attach, but it cannot make that sequence atomic: a capture that
     * rejects after the mint leaves a claim standing over a review-less session, and the
     * claim hides the row that would retry it. So the ORDER here is capture FIRST, mint
     * second — a rejected capture has claimed nothing and the row stays clickable.
     *
     * The client also cannot resolve WHICH repo a row belongs to. `Project.openPath` is
     * "the repo, or the FIRST included repo" (`wire.ts`), while the row list spans every
     * included repo, so a workspace's second repo captured against its first — silently,
     * under the right label. The row knows its `owner/name` and R19 keeps host paths off
     * the wire, so the identity travels and the HOST resolves it to a root.
     *
     * `target` absent mints a no-target session over the project's own checkout (claims
     * nothing, so the Current Checkout row never leaves the list); present mints or
     * REATTACHES to the session already claiming that branch/PR.
     */
    start(input: {
      projectId: string;
      commandId: string;
      target?: { branch: string; prNumber?: number; repository?: string };
    }): Promise<{ session: SidebarSession; reattached: boolean }>;
    rename(sessionId: string, title: string): SidebarSession | undefined;
    setPinned(sessionId: string, pinned: boolean): SidebarSession | undefined;
    setArchived(sessionId: string, archived: boolean): SidebarSession | undefined;
  };
  /**
   * The lens-board read for `board.read` (C05 cluster 8, bound in C18): the PERSISTED board
   * for one `(review, generation, lens)` triple, projected from the whiteboard event log the
   * lens pipeline wrote plus its board-meta record. `undefined` is the honest MISSING answer —
   * that lens drafted no board that generation. Absent seam ⇒ no boards runtime wired, so every
   * pair reads missing; a board is never fabricated to fill the gap.
   */
  readonly lensBoardForReview?: (
    reviewId: string,
    generation: string,
    lens: LensKind,
  ) => Promise<LensBoard | undefined>;
  /** A durable successful absence for the same board identity, when no board exists. */
  readonly lensAbsenceForReview?: (
    reviewId: string,
    generation: string,
    lens: LensKind,
  ) => Promise<LensAbsenceReason | undefined>;
  /**
   * The living-draft span-rework producer (B11 cluster 5): a ONE-SHOT model turn that
   * reworks one staged ask's body per the reviewer's instruction — a FRESH turn, never
   * the resident cursor. Takes the ALREADY-RESOLVED review (dispatch freshness-pins it
   * once) plus the ask's disposition type, the selected span, and the instruction. The
   * root composes it over the live refine harness. Optional so a composition without a
   * rework seat still constructs — `review.reviseSpan` then answers an honest
   * `unavailable`. The turn produces revised text into the ask log; it posts NOTHING.
   */
  readonly reworkSpan?: (input: {
    review: Review;
    type: DispositionType;
    span: string;
    instruction: string;
    path?: string;
  }) => Promise<RefinementResult>;
}

/**
 * Per-invocation context the transport supplies. `emitProgress` is the push sink
 * a long-running command (today `project.process`) streams live narration to; the
 * transport binds it to the renderer's `onProgress` channel. Absent for every
 * request/response command, and for callers (tests) with no push channel.
 */
export interface DispatchContext {
  emitProgress?(event: ProjectProgressEvent): void;
  /**
   * Stable identity for the renderer receiving progress. A remount replaces that
   * renderer's sink instead of adding a second sender for the same live run.
   */
  progressRecipientId?: string | number;
  /**
   * The push sink for a conversation's token STREAM (issue #251) — the transport binds
   * it to the renderer's `onAskStream` channel, keyed by `reviewId`. Absent for a bridge
   * with no push channel (a #139 one-shot ask resolves its final value with no stream).
   */
  emitAskStream?(event: ReviewAskStreamEvent): void;
  /**
   * The authenticated device id for a projected (token-bearing) connection (issue #383 M1).
   * `device.registerPush` keys its push token by it; absent for loopback/pairing-only
   * connections (which cannot register a push token).
   */
  deviceId?: string;
}

/** One command handler: the re-seated body of a former `switch` arm, keyed by command id. */
export type CommandHandler = (rawInput: unknown, ctx?: DispatchContext) => Promise<unknown>;

interface LiveProjectRun {
  projectId: string;
  events: ProjectProcessEvent[];
  recipients: Map<unknown, (event: ProjectProcessEvent) => void>;
  result: Promise<{ repos: ProcessedRepoSummary[] }>;
}

export interface FlaggedReviewRun {
  /** Verified rows ready for immediate delivery. */
  readonly review: FlaggedReview;
  /** Optional post-hoc adjudication and/or verify-ui enrichment. Never awaited by `flagged.review`. */
  readonly adjudication: Promise<FlaggedReview> | null;
}

export type LiveFlaggedAdjudication =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly review: FlaggedReview }
  | { readonly status: "failed"; readonly reason: string };

/** Lift the wire target shape into the core `ForgeReviewTarget` nouns. */
export function toForgeReviewTarget(target: {
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
 * The compose integrity binding (#382 M2 finding 2). A deterministic id over (reviewId, active
 * patchset, mode, canonical payload, verdict) — the payload already canonicalises the
 * comments/submission, so binding those is enough to pin the artifact to one review AT one
 * revision. `publish.compose` returns it; the post commands recompute it from the CURRENT review
 * and refuse a mismatch, so a cross-review, stale-revision, or verdict-swapped artifact cannot
 * post. Pure integrity (recomputable, not a secret): it catches accidental drift and confusion,
 * not adversarial forgery — Rennet is single-user.
 */
export function publishCompositionId(fields: {
  reviewId: string;
  patchsetId: string;
  mode: "review" | "pr";
  payload: string;
  /**
   * The resolved review VERDICT for `mode: "review"` — the one outbound field the payload bytes
   * do not capture, so it rides in the binding: a post whose verdict differs from the previewed
   * one fails the freshness check. A `"pr"` submission has no verdict (`undefined`).
   */
  verdict?: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      fields.reviewId,
      fields.patchsetId,
      fields.mode,
      fields.payload,
      fields.verdict ?? null,
    ]),
  );
}

/**
 * Refuse a post whose compose binding no longer matches the current review (#382 M2 finding 2).
 * A no-op when `compositionId` is absent (the desktop composes locally and posts without one —
 * additive/back-compat). For a team-PR "review" the expected binding is recomputed from the CURRENT
 * durable ask projection (B11 cluster 3 — the same source `publish.compose` draws from, so the
 * mirror holds), so an ask/line-comment edit that landed between preview and post is caught
 * (stale). For a "pr" submission the payload is model-drafted (not re-derivable), so the binding is
 * recomputed over the posted payload + current patchset — catching a cross-review post or an advanced
 * patchset; the existing byte-exact `canonicalPrSubmissionPayload` check already pins the payload.
 *
 * `verdict` is the caller's RESOLVED post verdict (review mode only). It is the one outbound field
 * the payload bytes do not capture, so it rides in the recomputed binding: posting a verdict other
 * than the previewed one lands on a different id and is refused as stale. That is the whole
 * preview-equals-post guarantee for the event — no token, no dialog, no second confirmation.
 */
export function assertCompositionFresh(
  review: Review,
  mode: "review" | "pr",
  payload: string,
  compositionId: string | undefined,
  reviewProjection?: AskProjection,
  verdict?: string,
): void {
  if (compositionId === undefined) return;
  const proj = reviewProjection ?? emptyAskProjection();
  const boundPayload =
    mode === "review"
      ? // BOTH strata (B11 finding 2): the bound payload folds in body notes too, so a
        // prose ask edited between preview and post is caught as stale like a line comment.
        canonicalReviewPayload(
          reviewCommentsFromProjection(proj),
          reviewBodyNotesFromProjection(proj),
        )
      : payload;
  const expected = publishCompositionId({
    reviewId: review.id,
    patchsetId: review.activePatchsetId,
    mode,
    payload: boundPayload,
    ...(verdict === undefined ? {} : { verdict }),
  });
  if (compositionId !== expected) {
    throw new Error(
      mode === "review"
        ? "Publish refused: this preview is stale or from another review — recompose before posting."
        : "Submit refused: this preview is stale or from another review — recompose before submitting.",
    );
  }
}

/**
 * The per-invocation shared state + helper closures every command handler closes over.
 * Built once per `createDispatch` call; each per-family handler module destructures the
 * members it needs, so the re-seated switch-arm bodies reference the same bare names they
 * always did (`service`, `requireReviewById`, `assertAllowedRepository`, …).
 */
export function createDispatchRuntime(deps: DispatchDeps) {
  const { service, allowedRoots } = deps;
  const intelligenceSessions = createReviewIntelligenceSessions();

  /**
   * Raise a "review finished" attention (issue #383 M1) after a pipeline run produces a
   * review. The push carries the repo name and deep-links to that review's digest; the real
   * finding counts render on the digest screen the tap lands on (the pipeline does not expose
   * counts cheaply here, so the body names the repo rather than fabricating a count — honest
   * substance, never a placeholder number).
   */
  const raiseReviewFinished = (review: Review): void => {
    deps.raiseAttention?.({
      family: "review-finished",
      reviewId: review.id,
      deepLink: deepLinkFor("review-finished", { reviewId: review.id }),
      title: "Review finished",
      body: `${basename(review.repositoryRoot)} is ready to read`,
    });
  };

  /**
   * Raise "handoff run completed" (issue #382 M2, family goes live) when `review.handoff.run`
   * resolves its outcome — with the delta summary as substance (files touched, dispositions
   * carried forward, occurrences orphaned for re-review). Deep-links to the review's handoff
   * landing; clears on view (opening the landing) per the taxonomy.
   */
  const raiseHandoffCompleted = (review: Review, summary: string): void => {
    deps.raiseAttention?.({
      family: "handoff-completed",
      reviewId: review.id,
      deepLink: deepLinkFor("handoff-completed", { reviewId: review.id }),
      title: "Handoff finished",
      body: summary,
    });
  };

  /**
   * Raise "publish-ready" (issue #382 M2, family goes live) when a composed draft first awaits
   * the user's post — the own-branch PR draft becoming ready (`review.draftPrBody` → drafted) is
   * that dispatch point. Destination + title are the substance; it deep-links to the publish
   * preview and clears on the post happening OR on viewing the preview (clear-on-view). Raising
   * reads only readiness state — no consent internals, no egress, nothing secret (design risk).
   */
  const raisePublishReady = (review: Review, destination: string, title: string): void => {
    deps.raiseAttention?.({
      family: "publish-ready",
      reviewId: review.id,
      deepLink: deepLinkFor("publish-ready", { reviewId: review.id }),
      title: "Ready to post",
      body: `${title} → ${destination}`,
    });
  };

  /** Clear a review's publish-ready attention when a post lands (from any client). Best-effort. */
  const clearPublishReady = (reviewId: string): void => {
    deps.acknowledgeAttention?.({ attentionId: `publish-ready:${reviewId}` });
  };

  // In-flight REAL posts, keyed by the deterministic idempotency marker (issue #21
  // double-sign race). Two concurrent real posts of the same (review, target, payload)
  // share a marker, so the second is refused while the first is still landing — the
  // main-owned half of the double-sign guard (the renderer disables the sign control
  // while a publish is pending; this closes the window between two near-simultaneous
  // completed signs before either mutation returns). A dropped-outcome retry is a
  // SEQUENTIAL call (the first has left the set), so the adapter's query-before-post
  // idempotency still yields exactly one review.
  const realPostInFlight = new Set<string>();
  const liveProjectRuns = new Map<string, LiveProjectRun>();
  const liveFlaggedAdjudications = new Map<string, LiveFlaggedAdjudication>();
  const progressReplayLimit = 256;

  const flaggedAdjudicationKey = (input: {
    reviewId: string;
    patchsetId: string;
    deepReview: boolean;
  }): string => JSON.stringify([input.reviewId, input.patchsetId, input.deepReview]);

  function attachProjectProgress(run: LiveProjectRun, ctx?: DispatchContext): void {
    const sink = ctx?.emitProgress;
    if (!sink) return;
    const recipient = ctx.progressRecipientId ?? sink;
    run.recipients.set(recipient, sink);
    for (const event of run.events) sink(event);
  }

  function assertAllowedRepository(repositoryPath: string): void {
    if (!allowedRoots.has(repositoryPath)) throw new Error("Repository access was not granted");
  }

  function assertReviewRepository(review: Review, repositoryPath: string): void {
    if (repositoryPath !== review.repositoryRoot) {
      throw new Error("Repository path does not match this review");
    }
    assertAllowedRepository(review.repositoryRoot);
  }

  /**
   * The egress target-binding gate (issue #21, most-permissive-fault): a real post is
   * legitimate ONLY against the review's OWN pull request. The real `publish.review`
   * calls this before any egress, so a post to a local capture (no `postTarget`) or to
   * a mismatched target is refused — even by a hand-crafted call. A single fault (a
   * renderer bug, a forged target) cannot clear it: the review's stored `postTarget`
   * is the authority, not the caller's input.
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

  const repositoryExists = deps.repositoryExists ?? existsSync;

  /**
   * Resolve a review by id from the store (issue #324). Replaces the old
   * latest-pin (`requireLatestReview`): every id-addressed command now resolves the
   * exact review it names, so a reopened OLDER review works everywhere — the pin
   * was a one-review-era convenience, never a safety property (repo-touching
   * commands still pass `assertAllowedRepository`, publish still binds to the
   * review's own `postTarget`). A pure read: it appends nothing.
   */
  function requireReviewById(reviewId: string): Review {
    const review = service.reviewById(reviewId);
    if (!review) throw new Error("Review not found");
    return review;
  }

  /** The review's active patchset (the handoff bundle's baseline). */
  function activePatchsetOf(review: Review): Patchset {
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    if (!patchset) throw new Error("The active patchset is missing");
    return patchset;
  }

  return {
    deps,
    service,
    allowedRoots,
    intelligenceSessions,
    realPostInFlight,
    liveProjectRuns,
    liveFlaggedAdjudications,
    progressReplayLimit,
    raiseReviewFinished,
    raiseHandoffCompleted,
    raisePublishReady,
    clearPublishReady,
    flaggedAdjudicationKey,
    attachProjectProgress,
    assertAllowedRepository,
    assertReviewRepository,
    assertTargetIsReviewOwn,
    repositoryExists,
    requireReviewById,
    activePatchsetOf,
  };
}

export type DispatchRuntime = ReturnType<typeof createDispatchRuntime>;
