import { z } from "zod";
import { benchmarkRunSchema } from "../benchmarks";
import { LensBoardSchema, LensKindSchema } from "../board/lens-board";
import { FindingRefSchema } from "../board/schema";
import { anchorSideSchema, anchorSpanSchema, codeRefSchema } from "../delta/citations";
import { MAX_UI_EVIDENCE_DATA_URL_LENGTH } from "../domain";
import { forgeRepoIdentitySchema, forgeRepositoryMatchesLegacy } from "../forge";
import {
  AskEventBodySchema,
  AskProjectionSchema,
  attentionFamilySchema,
  LensAbsenceReasonSchema,
  LensDraftSnapshotSchema,
  LensFailureAccountSchema,
  QuoteThreadSchema,
  RoundEventSchema,
  RoundLedgerRecordSchema,
  RoundOperationProgressSnapshotSchema,
  SessionTranscriptSchema,
  StagedAskSchema,
  VerdictOverrideSchema,
} from "../session";
import { sha256Hex } from "../sha256";
import {
  appearanceSchemeSchema,
  coachMarksSchema,
  composedHandoffBundleSchema,
  councilPickSchema,
  daemonHostStatusSchema,
  deltaDigestResultSchema,
  detectedForgeSchema,
  detectedHarnessSchema,
  discoveryResultSchema,
  dispositionTypeSchema,
  flaggedReviewSchema,
  forgeHostDetectionSchema,
  forgeRequestSchema,
  forgeReviewPostDescriptorSchema,
  fsListDirResultSchema,
  gitHubAuthStatusSchema,
  gitHubConnectPollSchema,
  handoffBundleSchema,
  handoffDisclosureSchema,
  handoffDispositionSchema,
  handoffRunOutputSchema,
  harnessHostDetectionSchema,
  noiseReviewSchema,
  openSpecChangeSchema,
  pairedDeviceSchema,
  prBodyDraftResultSchema,
  processedRepoSummarySchema,
  projectDetailSchema,
  projectKindSchema,
  projectProcessRunSchema,
  projectSchema,
  projectVisibilitySchema,
  prSubmissionSchema,
  prWorktreeSetupSchema,
  publishDegradationSchema,
  publishOutcomeSchema,
  pullRequestStateSchema,
  refinementResultSchema,
  resolvedProvenanceSchema,
  reviewArtifactSchema,
  reviewRoleMappingSchema,
  reviewRoleScenarioSchema,
  reviewSchema,
  setRepoVisibilityOutcomeSchema,
  settingsGuidanceSchema,
  settingsProjectValueKeySchema,
  settingsProjectWriteOutcomeSchema,
  settingsRepoValueKeySchema,
  settingsRepoWriteOutcomeSchema,
  settingsViewSchema,
  sidebarSessionSchema,
  sourceSchema,
  symbolInspectionSchema,
  t3SessionSchema,
  t3SidecarStatusSchema,
  themePackSchema,
} from "../wire";

const commandIdSchema = z.uuid();
const forgePrSubmissionTargetSchema = z.object({
  repo: forgeRepoIdentitySchema,
});

/**
 * The ONE way a client mints a `commandId`.
 *
 * `commandIdSchema` is `z.uuid()`, so anything else the daemon simply refuses — and it
 * refuses it AFTER the client has already rendered as if the command were on its way.
 * That is not hypothetical: `load-${slug}` and `reattach-${reviewId}` shipped a dead
 * `/s/:slug` and a permanently empty chat dock, and `apps/mobile` shipped a
 * `cmd-${Date.now()}-${random}` fallback for the same reason. A per-caller id recipe is
 * a per-caller chance to invent one the wire rejects, so the recipe lives here, next to
 * the schema that judges it.
 *
 * No fallback. A runtime without `crypto.randomUUID` throws here, loudly, at the call —
 * which is strictly better than minting a plausible-looking id the daemon discards in
 * silence. (React Native has no `crypto`; `apps/mobile/src/polyfills.ts` installs a real
 * v4 shim at entry, so the API is present before any command is sent.)
 */
export function newCommandId(): string {
  return crypto.randomUUID();
}

/**
 * A STABLE, wire-valid `commandId` derived from an arbitrary key.
 *
 * For reads whose id must be the same every time: the cache key of a read includes its
 * whole input, so a freshly minted id per render would remint the entry each render, and
 * two surfaces reading the same thing would fetch it twice. Deriving from a SHA-256 of the
 * key gives both properties with no state at all — no module-level map to mutate during
 * render, nothing to grow without bound, and the same id in both readers by construction.
 * The RFC 4122 version (4) and variant bits are stamped so `z.uuid()` accepts it.
 */
export function commandIdFor(key: string): string {
  const hex = sha256Hex(key);
  const version = `4${hex.slice(13, 16)}`;
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const definitions = {
  "app.bootstrap": {
    input: z.object({}),
    output: z.object({ review: reviewSchema.nullable(), repositoryPresent: z.boolean() }),
  },
  "repository.choose": {
    // `path` is an optional, append-only input (#379): a detached daemon cannot open a
    // native directory picker, so a windowed client obtains the path from its own host
    // dialog and forwards it here. Absent → the server falls back to RENNET_TEST_REPO or
    // its injected chooser. Optional keeps every pre-#379 caller (which sent `{}`) valid.
    input: z.object({ path: z.string().optional() }),
    output: z.object({ path: z.string().nullable() }),
  },
  "review.capture": {
    input: z.object({
      commandId: commandIdSchema,
      repoPath: z.string().min(1),
      reviewId: z.string().optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── The GitHub PR front door (User Journey stage 2, second v1 source) ───────
  // Point Rennet at a pull request (`owner/repo#123` or a GitHub PR URL) and land
  // in the review surface with the PR's diff loaded. `repoPath` is the local clone
  // the user picked: the diff is taken locally against the PR's pinned OIDs
  // (full-fidelity, force-push-proof). One engine, two sources — this produces the
  // same immutable patchset + review the local capture does.
  "review.openPr": {
    input: z.object({
      commandId: commandIdSchema,
      /** The PR reference: `owner/repo#123` or a `https://github.com/.../pull/N` URL. */
      ref: z.string().min(1),
      /**
       * The local clone of the PR's repository. OPTIONAL since clone-on-demand
       * (#225): omitted — or pointing at a directory that is not a clone of the
       * PR's repo — MAIN resolves a managed blobless clone under its own data dir,
       * creating it on first use. Supplying a matching clone still wins (the
       * project row's own path, or an explicit directory pick).
       */
      repoPath: z.string().min(1).optional(),
      /**
       * Open the PR RETROSPECTIVELY (read-only): the review is for READING an
       * already-merged (or any) PR, never for posting back. When true, the created
       * review is flagged `retrospective`, MAIN refuses egress on `publish.review`,
       * and the renderer hides the sign/publish affordance. Omitted/false ⇒ the
       * existing live open-PR review, unchanged. A merged PR works either way — the
       * diff is the git range base..head from history, with no "PR must be open"
       * assumption — but retrospective is the honest mode for one already landed.
       */
      retrospective: z.boolean().optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── review.load: reopen any persisted review by id (issue #324) ────────────
  // A PURE READ. Returns the review exactly as folded from its persisted events —
  // no event is appended, and the id need not be the globally-latest review. The
  // one extra fact main provides is `repositoryPresent`: whether the review's
  // recorded repository root still exists on disk, so the renderer can show honest
  // missing-context status and skip the working-tree freshness watcher. The
  // existing freshness/delta machinery decides staleness AFTER the load; nothing
  // here blocks the load (Rule Zero — reading the user's own local state).
  "review.load": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema, repositoryPresent: z.boolean() }),
  },
  // ── The reviewed PR's worktree (historical-PR review) ──────────────────────
  // Every PR review opened from a clone gets a detached worktree at the reviewed
  // head OID (retrospective included — an executable past), with the repo's
  // `.rennet/setup` commands run automatically after checkout. This read returns
  // where it is and how setup went; `null` for a review with no worktree (a
  // working-tree capture, or the checkout failed). Read-only, no gate; lifecycle
  // management beyond successor replacement is #423.
  "review.prWorktree": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: z.object({
      worktree: z
        .object({
          path: z.string().min(1),
          setup: prWorktreeSetupSchema,
          /** The tail of `.rennet/setup.log` — honest visibility into what setup did. */
          logTail: z.string(),
        })
        .nullable(),
    }),
  },
  "review.setDisposition": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      patchsetId: z.string().min(1),
      path: z.string(),
      /** A disposition type sets/replaces the disposition; `null` clears it. */
      disposition: dispositionTypeSchema.nullable(),
      body: z.string(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.checkFreshness": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.regenerate": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── Publish a review to GitHub (issue #21) — the FIRST real egress ──────────
  // The pipeline never autonomously posts to a real repo: this command is the one
  // direct egress path, invoked by the reviewer's Post action.
  //   • `dryRun` defaults to TRUE: an omitted flag never
  //     posts. The renderer's real-post path must EXPLICITLY send `dryRun: false`.
  //   • MAIN re-derives the canonical payload from `artifact` and refuses on any
  //     disagreement with `payload` (byte-exact), and rebuilds the exact `post` —
  //     both on dry-run and real, so the dry-run surfaces integrity faults too.
  //   • The user's click on Post IS the authorization — there is no token and no
  //     confirmation step (Rule Zero, #435). What a real send still must satisfy: the
  //     review's persisted pull request as the target, and a `compositionId` that still
  //     matches the CURRENT review and the event in the exact post descriptor being
  //     posted — so the review that leaves is byte-for-byte, event-for-event the one
  //     that was previewed.
  //   • The event exists once, inside `post`; there is no second verdict field that
  //     can disagree with what the reviewer previewed.
  "publish.review": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The complete signed review artifact, including its byte-preserved opener. */
      artifact: reviewArtifactSchema,
      /** The exact preview descriptor; the daemon rebuilds and compares it before egress. */
      post: forgeReviewPostDescriptorSchema,
      /** The canonical payload bytes the sheet previewed + signed (round-trip check). */
      payload: z.string(),
      /** The compose integrity binding over current evidence, artifact, post, and target. */
      compositionId: z.string().min(1),
      /** Default TRUE: an omitted flag never posts. Real egress must opt in with false. */
      dryRun: z.boolean().optional().default(true),
    }),
    output: z.object({
      /** Echoes the resolved dry-run flag (true ⇒ nothing left the machine). */
      dryRun: z.boolean(),
      /** The exact ordered forge mutations that were (dry-run) or would be sent. */
      request: forgeRequestSchema,
      /** The deterministic idempotency marker embedded in the review body. */
      marker: z.string(),
      /** Every flattening applied, surfaced for the sheet's ledger (never silent). */
      ledger: z.array(publishDegradationSchema),
      /** The real-post outcome, or `null` on a dry-run (nothing posted). */
      outcome: publishOutcomeSchema.nullable(),
    }),
  },
  "publish.receipt": {
    input: z.object({
      reviewId: z.string().min(1),
      marker: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("missing") }),
      z.object({
        status: z.literal("posted"),
        receipt: z.object({
          marker: z.string().regex(/^[0-9a-f]{64}$/),
          verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
          lineCommentCount: z.number().int().nonnegative(),
          reviewRef: z.string().min(1),
          url: z.url(),
        }),
      }),
    ]),
  },
  // ── Submit an own-branch PR (issue #257 / #107) — push + open the PR ─────────
  // The action the product is named for: on a single human sign-click, push the
  // review's OWN branch and open a real pull request with the drafted title/body.
  // This is a different verb on the same GitHub egress the other-pr post travels —
  // NOT a second submission path. There is no consent token here: pushing your own
  // branch is not publishing (AGENTS.md), and the sign-click is the whole
  // authorization — the review is the human's, over their signature.
  //   • MAIN re-derives the canonical `pr-submission` bytes from `submission` and
  //     refuses on any disagreement with `payload` (byte-exact) — the same "what you
  //     see is what leaves" honesty (R33) the review egress holds, so the previewed
  //     PR is exactly the one that opens.
  //   • A retrospective review (read-only over a merged/any PR) is refused: there is
  //     no own branch to submit.
  //   • Idempotent by head branch: an open PR from the same head is reused, so a
  //     retry (or a double sign) yields exactly one PR.
  "publish.submitPr": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /**
       * The provider-qualified repository the reviewer saw in the composed preview.
       * COMPAT(protocol v2): optional while independently updated clients may omit the new
       * field. A current daemon recovers it from the live destination and verifies the
       * target-bound composition id. Remove when MIN_COMPATIBLE_PROTOCOL_VERSION is at least 3.
       */
      target: forgePrSubmissionTargetSchema.optional(),
      /** The PR to open — title/body (with the human's edits)/base/head/draft. */
      submission: prSubmissionSchema,
      /** The canonical `pr-submission` bytes the sheet previewed + signed (round-trip check). */
      payload: z.string(),
      /** The compose integrity binding (#382 M2 finding 2). Protocol v2 requires every caller to
       *  return the daemon's composition, so a stale/cross-review submission cannot bypass the
       *  signed-preview contract. */
      compositionId: z.string().min(1),
    }),
    output: z.object({
      /** The created (or reused) pull request's web URL. */
      url: z.string(),
      /** The pull request number. */
      number: z.number().int(),
      /** True when an open PR from this head already existed and was reused (idempotent). */
      reused: z.boolean(),
    }),
  },
  // ── publish.compose: the daemon composes the outbound artifact (issue #382 M2) ─
  // A projected client (the phone) cannot compose the byte-exact outbound payload —
  // the DOM `ui` layer owns the editable collation model and the mobile boundary
  // forbids importing it (and `layer:ui` may not import `layer:core`, so it cannot
  // be shimmed there either). So the DAEMON composes it — `layer:server` imports
  // `@rennet/core`'s node-free `reviewCommentsFromDispositions`/`canonicalReviewPayload`
  // /`canonicalPrSubmissionPayload` — and the phone POSTS exactly what it returns: the
  // preview and the post use the SAME bytes, single-source and R33-honest (Finding C
  // ruling (a): BOTH loops end on the phone).
  //
  // `mode` selects which loop:
  //  • "review" — a team-PR review to post. Composes the complete artifact and exact
  //    post descriptor; the phone previews them and `publish.review` rebuilds both.
  //  • "pr" — the OWN-BRANCH PR submission (title/body/base/head + canonical payload);
  //    the phone posts via `publish.submitPr`, which round-trips the payload exactly.
  // A mode that does not fit the review (a "pr" compose of a team-PR review, a "review"
  // compose of a branch-only review, a retrospective, or a detached HEAD) returns
  // `unavailable` with a truthful reason. Reads only readiness state — no consent
  // internals, no egress, nothing secret. COMPAT: a pre-M2 daemon does not implement
  // this command; the phone's publish surface says the daemon needs updating (truthful,
  // like Stop) rather than pretending it can post.
  "publish.compose": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** Which loop to compose: a team-PR "review" to post, or an own-branch "pr" to open. */
      mode: z.enum(["review", "pr"]),
    }),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("review"),
        /** The complete review artifact whose exact bytes the reviewer signs. */
        artifact: reviewArtifactSchema,
        /** The exact body, event, and threads that the forge request will carry. */
        post: forgeReviewPostDescriptorSchema,
        /** Flattening/accounting stays a provenance sidecar, outside the post descriptor. */
        ledger: z.array(publishDegradationSchema),
        /** The canonical bytes derived from `artifact`; `publish.review` verifies them. */
        payload: z.string(),
        /** A human destination line for the preview (e.g. `owner/name#7`). */
        destination: z.string(),
        /** A short headline for the preview (the repo/PR the review posts to). */
        title: z.string(),
        /**
         * Integrity binding over the review, active patchset, exact payload, event, and opener
         * evidence. The phone returns it to `publish.review`, which verifies both the inbound
         * bytes and the current persisted evidence before posting.
         */
        compositionId: z.string().min(1),
        /** Current daemons expose the operation marker so clients can hydrate its durable receipt. */
        marker: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
      z.object({
        status: z.literal("pr"),
        /**
         * The provider-qualified repository `publish.submitPr` must resolve again before push.
         * COMPAT(protocol v2): optional so a current client can still consume an older daemon;
         * current daemons always return it. Remove when MIN_COMPATIBLE_PROTOCOL_VERSION is 3.
         */
        target: forgePrSubmissionTargetSchema.optional(),
        /** The composed own-branch submission the phone posts verbatim via `publish.submitPr`. */
        submission: prSubmissionSchema,
        /** The canonical bytes, derived from `submission` — the round-trip `publish.submitPr` verifies. */
        payload: z.string(),
        /** A human destination line for the preview (e.g. `atlas:feat/x → main`). */
        destination: z.string(),
        /** The PR title, surfaced as the preview's headline. */
        title: z.string(),
        /** Integrity binding (#382 M2 finding 2), recomputed + validated by `publish.submitPr`. */
        compositionId: z.string().min(1),
      }),
      z.object({
        status: z.literal("unavailable"),
        reason: z.string(),
        /** True when the same composition should be retried in place as evidence settles. */
        retryable: z.boolean().optional(),
      }),
    ]),
  },
  // ── Project setup and discovery (issue #29 / #37) ───────────────────────────
  // The first-run welcome and the ordinary Add Project entry share these commands.
  // Discovery reads the pointed-at path read-only and never mutates the index or
  // calls a model before the user confirms the project draft.
  "harness.detect": {
    // The ambient detection line: which harnesses were found (felt, not ceremonial).
    input: z.object({}),
    output: z.object({ detected: z.array(detectedHarnessSchema) }),
  },
  // Per-host harness detection (C17 cluster 3, #485). SERVER-side fan-out: the daemon this is
  // dispatched to asks EVERY host the settings surface enumerates — itself directly, a WSL
  // distro through `wsl.exe`, a paired remote device not at all (it dials US; there is no
  // outbound connection to dial back). Each entry carries `asked`, so a host that could not be
  // interrogated reads honestly absent rather than inheriting the local machine's agents.
  "harness.hosts": {
    input: z.object({}),
    output: z.object({ hosts: z.array(harnessHostDetectionSchema) }),
  },
  // Rule an agent in or out of reviews ON ONE HOST (C17 cluster 3.2) — the served store behind
  // the per-host enable toggle, persisted in daemon-settings so the decision survives reload.
  // Scoped to the host: ruling Codex out here leaves it running on a WSL distro. It never
  // installs, uninstalls or hides anything — the row stays, with its toggle off.
  "harness.setEnabled": {
    input: z.object({
      source: sourceSchema,
      harnessId: z.string().min(1),
      enabled: z.boolean(),
    }),
    // The host's ruled-out ids after the write — the stored decision, read back verbatim.
    output: z.object({ disabled: z.array(z.string()) }),
  },
  // Forge (source-control) CLI detection, mirroring harness.detect (C17, #484 seam / #483
  // "gh rides again"). Runs on the daemon it is dispatched to = that host; the client folds
  // the GitHub / `gh` and GitLab.com / `glab` rows into `sourceControlByHost`.
  "forge.detect": {
    input: z.object({}),
    output: z.object({ detected: z.array(detectedForgeSchema) }),
  },
  // Per-host forge detection (C17 amendment B), the exact mirror of `harness.hosts`: the daemon
  // this is dispatched to walks the SAME host enumeration and runs forge discovery through each
  // host's OWN deps — itself directly, a WSL distro through `wsl.exe`, a paired remote device not
  // at all. Each entry carries `asked`, so a host that cannot be interrogated reads honestly
  // absent rather than inheriting this machine's forge state. `forge.detect` stays for the
  // single-host read; this is what the settings surface's Source Control sections are keyed by.
  "forge.hosts": {
    input: z.object({}),
    output: z.object({ hosts: z.array(forgeHostDetectionSchema) }),
  },
  // Rule a forge CLI in or out ON ONE HOST (amendment A) — the served write behind operational
  // Source Control toggles, mirroring harness.setEnabled exactly and persisted on the same
  // per-host daemon-settings entry. The current surface exposes it for GitHub; health-only
  // GitLab has no toggle until merge-request operations exist for that ruling to control.
  "forge.setEnabled": {
    input: z.object({
      source: sourceSchema,
      forgeId: z.string().min(1),
      enabled: z.boolean(),
    }),
    /** The host's ruled-out forge ids after the write — the stored decision, verbatim. */
    output: z.object({ disabled: z.array(z.string()) }),
  },
  // Per-host daemon status (C17, #485): the daemon this is dispatched to reports, for EVERY
  // host the settings surface enumerates, whether that host's daemon answered, its running
  // version, the version it was last seen running, and whether an update is available. A host
  // that does not answer carries `reachable: false` with NO version — never a guessed one.
  "daemon.status": {
    input: z.object({}),
    output: z.object({
      hosts: z.array(daemonHostStatusSchema),
      /** The owned T3 Code sidecar's state; absent when this daemon composed none. */
      t3Sidecar: t3SidecarStatusSchema.optional(),
    }),
  },
  // Broker T3 Code sidecar access to a client (t3code-sidecar-chat, 2.4). The daemon starts
  // the sidecar on first ask and hands back the origin, WS URL and bearer; the client never
  // reads the credential file. Loopback clients only — never remote-exposed.
  "chat.t3Session": {
    /** With a review id, the daemon also binds (creates or resumes) that review's T3 thread,
     *  rooted in the review's repository checkout. */
    input: z.object({ reviewId: z.string().min(1).optional() }),
    output: t3SessionSchema,
  },
  // Start a turn on the review's bound T3 thread with text the client composed
  // (t3-lens-threads 4.2). The one writer besides the thread's own composer: an anchored ask
  // ("ask about this span") sends its question plus the cited excerpt here and then opens the
  // chat slot, where the answer streams in T3's own view. The daemon binds the thread exactly
  // as `chat.t3Session` does — on the review's REPOSITORY ROOT, never a project id.
  "chat.t3Send": {
    input: z.object({
      reviewId: z.string().min(1),
      /** The turn's prompt. Bounded by the caller; the daemon sends it verbatim. */
      text: z.string().min(1).max(8_000),
    }),
    output: z.object({ threadId: z.string().min(1) }),
  },
  // Re-attempt the handshake to ONE host's daemon (C17 cluster 5, #533) — the operation behind
  // the host card's Reconnect button. The same per-host handshake `daemon.status` polls, run on
  // demand for one host and reporting WHY it failed: `local` re-reads the claim file, a WSL
  // distro is re-entered over `wsl.exe` and its published port health-checked, a paired remote
  // device cannot be dialled back at all and says so. The outcome is that host's real status —
  // a failed reconnect stays `reachable: false` and carries the failure line, never a green card.
  "daemon.reconnect": {
    input: z.object({ source: sourceSchema }),
    output: z.object({
      /** That host's status AFTER the attempt — the same shape `daemon.status` returns. */
      status: daemonHostStatusSchema,
      /** Why the handshake failed, when it did. Absent on success. Never a generic filler. */
      error: z.string().optional(),
    }),
  },
  // UPDATE one host's daemon (C17 cluster 6, #534) — the operation behind the host card's
  // Update Daemon button, which shows only when `daemon.status` reported a real
  // `updateAvailable`. The only host kind with an update mechanism today is `wsl:<distro>`:
  // the current server bundle is delivered into the distro and the old daemon restarted on it.
  // A host with no mechanism (this machine's daemon ships with the app; a paired device
  // updates itself) says so in `error` and changes nothing — never a dead "Updating…".
  "daemon.update": {
    input: z.object({ source: sourceSchema }),
    output: z.object({
      /** That host's status AFTER the attempt — the same shape `daemon.status` returns. */
      status: daemonHostStatusSchema,
      /** Why the update failed, when it did. Absent on success. Never a generic filler. */
      error: z.string().optional(),
    }),
  },
  // ── The GitHub account (v4.2: gh primary, Rennet fallback) ─────────────────
  // Connect is SKIPPABLE everywhere it appears (working-tree review needs no
  // GitHub); these commands exist so the first-run card and the settings rows can
  // show honest state and run the one-time sign-in. The token never crosses this
  // boundary in either direction — except the one deliberate paste (setToken).
  "github.status": {
    input: z.object({}),
    output: z.object({ status: gitHubAuthStatusSchema }),
  },
  "github.connectStart": {
    // Mint the device code. Starting again replaces any in-flight flow.
    input: z.object({}),
    output: z.object({
      userCode: z.string().min(1),
      verificationUri: z.string().min(1),
    }),
  },
  "github.connectPoll": {
    // The renderer polls until connected/failed; the host owns GitHub's poll pace.
    input: z.object({}),
    output: z.object({ poll: gitHubConnectPollSchema }),
  },
  "github.connectCancel": {
    input: z.object({}),
    output: z.object({}),
  },
  "github.setToken": {
    // The side door: paste a PAT. Validated BEFORE storing — a bad paste returns
    // its failure status and persists nothing.
    input: z.object({ token: z.string().min(1) }),
    output: z.object({ status: gitHubAuthStatusSchema }),
  },
  "github.disconnect": {
    // Remove only the Rennet-managed fallback. A `gh` credential belongs to the
    // user-installed CLI and is disconnected with `gh auth logout`.
    input: z.object({}),
    output: z.object({}),
  },
  "projects.list": {
    // The populated state: the projects the user has added.
    input: z.object({}),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  "project.discover": {
    // Step 2 substrate: read-only discovery over the chosen path (already granted
    // via `repository.choose`) → editable defaults for the worktree-config screen.
    input: z.object({
      commandId: commandIdSchema,
      path: z.string().min(1),
      kind: projectKindSchema,
      /** The daemon to discover on. Defaults to `local` for pre-existing callers. */
      source: sourceSchema.default("local"),
    }),
    output: z.object({ discovery: discoveryResultSchema }),
  },
  "fs.listDir": {
    // Read-only directory listing on the ATTACHED source's own daemon (local, in-distro
    // WSL, or a paired remote). Deliberately ungated: this is the browser, not a grant —
    // an empty `path` answers from the daemon's home dir; any absolute path is listable.
    input: z.object({ path: z.string().optional() }),
    output: z.object({ result: fsListDirResultSchema }),
  },
  "patchset.readSpan": {
    // Read a cited span from the CAPTURED patchset — never a working tree
    // (client asset risk 2, #489). Registered in B3 so Track C freezes against
    // the shape (proposal reconciliation 8); B4 and B10 both left it unbound, and
    // `dispatch/patchset.ts` binds it now. The reader serves the span from the
    // patchset's own patch text, so a citation resolves with the repository gone —
    // and a span outside the captured diff is refused BY NAME, never faked.
    input: codeRefSchema,
    output: z.object({
      /** The cited span's lines, in order, from the captured patch text. */
      lines: z.array(z.string()),
      /** A few lines either side of the span, for orientation. */
      contextBefore: z.array(z.string()),
      contextAfter: z.array(z.string()),
      /**
       * An honest sentence about what the reader could NOT serve, shown in place of the
       * code. Present only when the capture was truncated across the cited span and the
       * reviewed tree could not be read either — a citation the board's own lint ACCEPTS
       * (a truncated file's tail region is open-ended on purpose), so refusing it would
       * make a valid citation read as a bad one. Absent on every served span.
       */
      caption: z.string().optional(),
    }),
  },
  "board.read": {
    // The lens-board read (C05 cluster 8, registered in C18). `LensBoardSchema` froze
    // in B3 with the command left to "B4/B10's business"; this is it. Serves the
    // PERSISTED board for one `(reviewId, generation, lens)` triple, projected from the
    // whiteboard event log the lens pipeline wrote (`runLensBoard` → `whiteboard.apply`)
    // plus the board-meta record that carries its document opening. `board: null` is
    // the honest MISSING answer — that lens drafted no board that generation — and is
    // never a fabricated or partially-invented board.
    input: z.object({
      reviewId: z.string().min(1),
      generation: z.string().min(1),
      lens: LensKindSchema,
    }),
    output: z.object({
      board: LensBoardSchema.nullable(),
      /** Present only when the generation durably settled this lens without a board. */
      absence: LensAbsenceReasonSchema.optional(),
      /** Present only when the latest drafting attempt failed this lens. The message does
       * NOT imply terminal: `failureAccount` carries the classification when the failing
       * path named one, and its absence means the classification is unknown — never
       * that the lens is beyond another attempt. */
      failure: z.string().min(1).optional(),
      /** The typed account for `failure` (#549), when the attempt that failed recorded one. */
      failureAccount: LensFailureAccountSchema.optional(),
    }),
  },
  "board.draft": {
    // The DRAFTING board read (`lens-board-tools` D11, task 4.1) — the catch-up half of
    // the element stream. `board.read` above serves the board the pipeline PERSISTED at
    // settle; this serves the one a seat is writing right now, so a surface that mounts
    // after the first elements have landed starts from what is on the board instead of
    // from a hole it can never fill. `revision` is the frame the snapshot is current
    // with, so folding the live `lensDraft` frames resumes exactly there.
    //
    // `draft: null` is the honest MISSING answer: no lane of that generation is open for
    // that lens, either because it has not started or because its board has settled and
    // been evicted. A settled board is `board.read`'s to serve, and a fabricated drafting
    // snapshot over one would be the same board twice with two different revisions.
    input: z.object({
      reviewId: z.string().min(1),
      generation: z.string().min(1),
      lens: LensKindSchema,
    }),
    output: z.object({ draft: LensDraftSnapshotSchema.nullable() }),
  },
  "projects.add": {
    // Confirm: persist the project from the discovery + the user's toggle choices.
    // MAIN derives the stored shape (name, counts, open target) so the renderer
    // cannot desync it; the confirmed primary branch rides through.
    input: z.object({
      commandId: commandIdSchema,
      discovery: discoveryResultSchema,
      /** The repo names the user kept enabled (a subset of `discovery.repos`). */
      includedRepos: z.array(z.string().min(1)),
      /** The confirmed, possibly edited primary branch. */
      primaryBranch: z.string().min(1),
      // The daemon this project lives on rides in ON THE DISCOVERY (`discovery.source`,
      // stamped by the `project.discover` handler) — the single authoritative field. A
      // redundant top-level `source` was dropped: it was never read, and a caller could
      // silently disagree with `discovery.source` (persisting the wrong daemon).
    }),
    output: z.object({ project: projectSchema, projects: z.array(projectSchema) }),
  },
  "project.rename": {
    // Rename a project's display name (C12 cluster 7, bound in C18) — the sidebar row
    // and the Settings identity field are two callers of this one write. An EMPTIED
    // name is not an error and is not stored empty: the host restores the `org/repo`
    // fallback derived from the project's own path (R67), so the row reads its identity
    // again rather than an unnamed blank. Returns the renamed project and the fresh list.
    input: z.object({ projectId: z.string().min(1), name: z.string() }),
    output: z.object({ project: projectSchema.nullable(), projects: z.array(projectSchema) }),
  },
  "projects.remove": {
    // Forget a project from Rennet's project list. Does NOT delete the repo on disk —
    // the working tree is untouched; only Rennet's record of it is dropped, so
    // re-adding the same path restores it. Returns the surviving list.
    input: z.object({ commandId: commandIdSchema, projectId: z.string().min(1) }),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  "project.process": {
    // The initial context dump: build the ProjectSnapshot / repo-map for every
    // included repo of a freshly-added project. LIVE narration is pushed over the
    // `onProgress` channel keyed by `commandId` as the real generator stages
    // advance; this command RESOLVES with the final per-repo summary once every
    // repo has built (or failed softly). Pure over git — no gate, no model spend.
    input: z.object({
      commandId: commandIdSchema,
      projectId: z.string().min(1),
    }),
    output: z.object({
      repos: z.array(processedRepoSummarySchema),
      /**
       * The durable scout → map → knowledge run. Optional only for compatibility
       * with older daemons; current servers always return it.
       */
      run: projectProcessRunSchema.optional(),
    }),
  },
  // ── Project detail: the unified smart list (issue #37) ─────────────────────
  // The raw substrate a project row opens into: local work + pull requests +
  // viewer, which the renderer folds into one deduped, sorted, filterable list.
  // Read-only; a fixture stands behind it until the live git/GitHub loop lands.
  "project.detail": {
    input: z.object({
      projectId: z.string().min(1),
      /**
       * Which PR states to fetch (historical-PR review). Omitted ⇒ `["open"]`, the
       * original live surface. `["merged"]` / `["closed"]` page recent-first through
       * history under the same bounded-pages ceiling — `truncated` stays honest, so
       * a deep history renders as an explicit partial list, never a complete-looking
       * one. Local work is unaffected by this filter.
       */
      prStates: z.array(pullRequestStateSchema).nonempty().optional(),
      /**
       * The instant first paint (local-first render): when `true`, MAIN returns
       * the LOCAL half from git alone and skips every GitHub auth + PR fetch — so
       * the surface never blocks on a slow (or, on a dead token, failing) network
       * round-trip before showing the work that is already on disk. `prs` comes
       * back empty and `authUnavailable` is absent (not an assertion that GitHub is
       * fine — just "we did not look"). The renderer fires this first, paints it,
       * then fires the full detail to fold PRs in. Omitted/false ⇒ the full detail.
       */
      localOnly: z.boolean().optional(),
      /**
       * Correlates this fetch with an `onProjectDetailProgress` subscription: when
       * present, MAIN streams per-repo PR-fetch progress under this id (the slow,
       * opaque phase), so the renderer can narrate exactly which repo it is on and
       * show an honest determinate fraction. Omitted ⇒ no live narration, only the
       * final resolved detail (the `localOnly` first paint never needs one).
       */
      commandId: commandIdSchema.optional(),
    }),
    output: projectDetailSchema,
  },
  // Merged PR → auto read-only, with a "clean up" that deletes the local worktree
  // / branch left behind. A destructive local act, so it is a command (not a
  // renderer-side effect); the host handler is a documented STUB this wave
  // (acknowledges the request; real worktree deletion is a follow-up), so nothing
  // is deleted from disk yet while the surface behaves correctly.
  "project.cleanupWorktree": {
    input: z.object({
      commandId: commandIdSchema,
      projectId: z.string().min(1),
      /**
       * The stable worktree identifier to remove (`LocalWork.id`). Targeting the
       * worktree identity — not a bare branch name — keeps clean-up unambiguous across
       * a workspace's repos and across a reused branch name.
       */
      worktreeId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // ── The Flagged lens (issue #138) ──────────────────────────────────────────
  // Everything the automated review layer raised for a review — model-council
  // findings + dual-review agreement/disagreement — read-only. A fixture stands
  // behind the real boundary until the finding-generation runner + aggregation
  // land (deferred; they sequence with #32/#41). No model spend here.
  "flagged.review": {
    // `deepReview` (issue #41) selects the dual-model path: two provider seats run
    // the finding lens independently and their findings are reconciled into
    // agreement/disagreement. This is the DEFAULT (Rai's mandate, 2026-08-11) — an
    // OMITTED flag runs dual (dispatch defaults it to true), and only an explicit
    // `false` opts down to the single-Claude quick review. Hypothesis-first is ALWAYS
    // on; dual-model + per-finding verification (#179) are the default deep behaviour.
    input: z.object({ reviewId: z.string().min(1), deepReview: z.boolean().optional() }),
    output: flaggedReviewSchema,
  },
  // Adjudication and verify-ui share one late, informational enrichment channel
  // (#41/#183). The initial `flagged.review` response never waits for it and says
  // when late work was scheduled; the renderer reads this patchset+mode-keyed state
  // afterward and updates already-visible rows/status when the independent turns
  // finish. A hung turn leaves this `pending` without holding row delivery open.
  "flagged.adjudication": {
    input: z.object({
      reviewId: z.string().min(1),
      patchsetId: z.string().min(1),
      deepReview: z.boolean(),
    }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("pending") }),
      z.object({ status: z.literal("complete"), review: flaggedReviewSchema }),
      z.object({ status: z.literal("absent") }),
      z.object({ status: z.literal("failed"), reason: z.string().min(1) }),
    ]),
  },
  // ── verify-ui evidence read (issue #183) ───────────────────────────────────
  // A PURE READ: return one screenshot the verify-ui pass captured for a review,
  // base64 data-URL encoded, so the Flagged lens strip can render it as a thumbnail
  // without the bytes ever riding the review snapshot or the flagged payload. `path`
  // is the review-relative reference from a `UiScreenshot`; resolution is CONFINED
  // to the review's evidence directory — a path that escapes it, or a file that no
  // longer resolves, returns `not-found` (that is correctness of the read, not a
  // consent gate: the strip then shows a plain missing-evidence note). No spend, no
  // model turn, no egress.
  "review.uiEvidence": {
    input: z.object({
      reviewId: z.string().min(1),
      path: z.string().min(1),
    }),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ok"),
        dataUrl: z.string().min(1).max(MAX_UI_EVIDENCE_DATA_URL_LENGTH),
      }),
      z.object({ status: z.literal("oversized") }),
      z.object({ status: z.literal("not-found") }),
    ]),
  },
  // ── review.refine: refine one rough note into a clean comment (issue #19) ────
  // Rai's headline feature. A real model turn cleans the user's raw note into a
  // well-phrased comment in their own first-person voice; the renderer adopts it
  // as the item's `refined` body (which `effectiveBody` prefers through to the
  // published payload) ONLY when the user keeps it. `itemId` identifies the
  // collation item the renderer round-trips the result onto; `raw` is the note
  // (verbatim, never mutated by the turn); `type`/`lens`/`path` are the context
  // (Q5) that disambiguates a terse note. The result is honest end to end — a
  // failed/unavailable turn returns that state, never the raw dressed as refined.
  "review.refine": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The collation item the refined body rounds back onto. */
      itemId: z.string().min(1),
      /** The disposition type — a request-change reads differently than a question. */
      type: dispositionTypeSchema,
      /** The user's raw note, refined VERBATIM (the turn reads it, never rewrites it here). */
      raw: z.string().min(1),
      /** Q5: the lens the user was on when they wrote it (disambiguates a terse note). */
      lens: z.string().optional(),
      /** The anchor path the note is attached to. */
      path: z.string().optional(),
      /**
       * The span-grained anchor (#78), all-or-none with `side`. Present ⇒ the note
       * anchors at a line span; the producer grounds against THAT hunk rather than a
       * truncation from the file's start. Absent ⇒ a path-grained note (the diff lenses).
       */
      span: anchorSpanSchema.optional(),
      side: anchorSideSchema.optional(),
    }),
    output: refinementResultSchema,
  },
  // ── review.draftPrBody: draft the PR title + body (issue #74, M26) ───────────
  // The own-branch destination's paper (#22) previews a PR submission; M26 drafts
  // its title + body from the reviewed changeset so it opens with an honest account
  // rather than a diffstat. The renderer already holds the drafting material (it
  // rendered the lenses), so it hands it in: the branch shape, the roll-up
  // narration if one was produced, the staged dispositions' resolutions, the spec
  // angle's requirements, and the decisions surfaced. `reviewId` freshness-pins the
  // review (a stale/unknown id is refused). The result is human-editable and posts
  // NOTHING — drafting produces text into a preview; creating the PR is a separate
  // explicit act (#21), and Rennet never pushes source (R33).
  "review.draftPrBody": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The base branch the PR would target. */
      base: z.string().min(1),
      /** The head branch/ref the PR submits. */
      head: z.string().min(1),
      /** The roll-up narration (M22), when one was produced — the changeset's own voice. */
      narration: z.object({ oneLine: z.string(), paragraph: z.string() }).optional(),
      /** The staged dispositions' resolutions — what the reviewer asked for and approved. */
      dispositions: z.array(
        z.object({
          type: dispositionTypeSchema,
          path: z.string(),
          resolution: z.string(),
        }),
      ),
      /** The spec angle's requirements — what the change was meant to satisfy. */
      requirements: z.array(z.string()).optional(),
      /** The decisions the review surfaced — the WHY behind the change. */
      decisions: z.array(z.string()).optional(),
    }),
    output: prBodyDraftResultSchema,
  },
  // ── review.deltaDigest: the light-tier prose over the successor account (#73/M25) ─
  // The renderer holds the successor review's `successorAccount` (it rendered the facts);
  // it asks MAIN to rephrase it into a one-glance TL;DR. `reviewId` freshness-pins the
  // review (a stale/unknown id is refused); MAIN reads that review's own successorAccount
  // (absent ⇒ an honest `unavailable`). The digest is built from ONLY the account, so
  // it can add no fact the facts don't carry; it posts NOTHING and gates nothing.
  "review.deltaDigest": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: deltaDigestResultSchema,
  },
  // ── The Noise lens (issue #34) ─────────────────────────────────────────────
  // The low-signal churn the changeset touches, grouped away and tagged with how
  // each group was judged (mechanical rule vs LLM noise job) — read-only, no model
  // spend. A fixture stands behind the real boundary until the live noise-
  // classification runner lands (deferred). Nothing is silently hidden: the lens
  // renders every group inspectable and pull-back-able.
  "noise.review": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: noiseReviewSchema,
  },
  // ── The symbol inspector (issue: wireframes #8) ────────────────────────────
  // Resolve one clicked identifier to its definition + reference sites from the
  // review's model-free symbolic surface (context.symbol / context.references).
  // Read-only, deterministic, no model spend. Dispatch resolves the current review
  // ONCE and reads both from the same snapshot.
  "review.symbolLookup": {
    input: z.object({ reviewId: z.string().min(1), name: z.string().min(1) }),
    output: symbolInspectionSchema,
  },
  // ── The Spec angle's live OpenSpec change (wireframes #9) ───────────────────
  // Parse-on-open of the change the reviewed patchset selected. Deterministic and
  // model-free — no gate, no spend. `null` when the review touches no
  // `openspec/changes/<name>/` (the Spec angle then shows its honest empty state).
  "openspec.change": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: openSpecChangeSchema.nullable(),
  },
  // ── Open a review file in the reviewer's editor (wireframes #8) ────────────
  // The inspector's "open in editor" jump: open a repo-relative file (optionally at
  // a line) via the OS. `ok:false` when it could not be opened (no path escape, an
  // unavailable review, or the OS refusing the file). A best-effort side effect.
  "review.openInEditor": {
    input: z.object({
      reviewId: z.string().min(1),
      path: z.string().min(1),
      line: z.number().int().positive().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // ── Settings: read the config ladder (wireframe #15) ───────────────────────
  // The whole settings surface: the global appearance layer + every project's
  // resolved repo-scope config, each carrying its provenance. Read-only; no model
  // spend. Fail-safe — a corrupt global config or an unreadable project config
  // resolves to defaults, never a throw.
  "settings.get": {
    input: z.object({}),
    output: settingsViewSchema,
  },
  // ── Settings: the per-repo guidance catalogue for one repo (wireframe #15) ───
  // The `<repoPath>/.rennet/conventions.json` house rules the review runners read
  // before every review, shown read-through. `repoPath` is the row's canonical git
  // top level (validated against the project's included repos in MAIN). Absent/
  // unreadable/empty degrade to an honest empty catalogue with a typed reason —
  // never a throw, never a fabricated rule.
  "settings.guidance": {
    input: z.object({ projectId: z.string().min(1), repoPath: z.string().min(1) }),
    output: settingsGuidanceSchema,
  },
  // ── Settings: set the global appearance scheme (wireframe #15) ─────────────
  // A personal, app-side preference the renderer consumes as `data-scheme`.
  // Side-effect-free — writes only `~/.rennet/config.json`, never a repo.
  "settings.setAppearance": {
    // `scheme: null` RESETS the global appearance to the builtin (`system`) — clears
    // the `~/.rennet/config.json` entry so the value falls back down the ladder. A
    // plain write, no ceremony (Rule Zero). Refused (throws) when the config is
    // malformed, like every other write. The output `scheme` is always the resolved
    // concrete value (builtin after a reset).
    input: z.object({ scheme: appearanceSchemeSchema.nullable() }),
    output: z.object({
      scheme: appearanceSchemeSchema,
      schemeProvenance: resolvedProvenanceSchema,
    }),
  },
  "settings.setThemePack": {
    input: z.object({ themePack: themePackSchema }),
    output: z.object({ themePack: themePackSchema }),
  },
  "settings.completeWelcome": {
    input: z.object({}),
    output: z.object({ completedAt: z.iso.datetime() }),
  },
  // ── Settings: replay the first-run welcome ────────────────────────────────
  // The counterpart `completeWelcome` never had. Without it the welcome is
  // permanently unreachable after setup — first-run eligibility elects the wizard
  // only for a client with NO projects, so clearing the completion stamp alone
  // would be a no-op on every machine that has one. So the write ADDS
  // `replayRequestedAt` to the slice and the startup gate honors that request
  // regardless of project count. An existing `completedAt` is PRESERVED, because an
  // older v1 build still requires it (see `welcomeStateSchema`). Finishing the
  // wizard writes `{ completedAt }` back OVER the slice, which clears the request.
  // A plain write, one click, no confirmation (Rule Zero) — refused (throws) only
  // when client settings are malformed, exactly as `completeWelcome`.
  "settings.resetWelcome": {
    input: z.object({}),
    output: z.object({ replayRequestedAt: z.iso.datetime() }),
  },
  "settings.setLastProject": {
    input: z.object({ source: sourceSchema, projectId: z.string().min(1) }),
    output: z.object({ source: sourceSchema, projectId: z.string().min(1) }),
  },
  // ── Settings: set (or reset) a command's keybinding override (#44) ─────────
  // A personal, app-side preference — writes only `~/.rennet/config.json`, never a
  // repo. Mirrors `setAppearance`: a plain write, first click, no confirmation, and
  // REFUSED (throws) when the config is malformed so an edit never overwrites
  // unparseable bytes. `keybinding`: a string SETS the override, `null` UNBINDS
  // (explicit), omitted RESETS (deletes the entry, back to the catalogue default). A
  // conflicting chord is accepted and persisted — the collision is disclosed in the
  // UI, never blocked (Rule Zero). Output returns the whole stored map after the write.
  "settings.setKeybinding": {
    input: z.object({
      id: z.string().min(1),
      keybinding: z.string().min(1).nullable().optional(),
    }),
    output: z.object({ keybindings: z.record(z.string(), z.string().nullable()) }),
  },
  // ── Settings: persist the onboarding coach-mark state (C13 · #487) ─────────
  // A personal, app-side write — client settings only, never a repo. Mirrors
  // `setKeybinding`: a plain write, first click, no confirmation (Rule Zero), and
  // REFUSED (throws) when client-settings.json is malformed so an edit never
  // overwrites unparseable bytes (Rule 75). Input is the whole slice the coach store
  // holds (`seen` + `skipAll`); output echoes the stored slice after the write, so a
  // reload reads back exactly what skip/dismiss/replay persisted.
  "settings.setCoachmarks": {
    input: coachMarksSchema,
    output: coachMarksSchema,
  },
  // ── Settings: turn benchmark recording on or off (#731, D8) ────────────────
  // Observability configuration, not a consent gate: while ON (the default) the
  // measured pipelines archive the per-stage timings they already record; while OFF
  // nothing new is written and the pipelines behave identically. A personal,
  // app-side write — client settings only, never a repo — refused (throws) on a
  // malformed file exactly as `setCoachmarks`. Output echoes the resolved state.
  "settings.setBenchmarkRecording": {
    input: z.object({ enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean() }),
  },
  // ── Benchmarks: the recorded runs behind the Settings panel (#731) ─────────
  // Read-only over the durable archive, newest first. `limit` caps what crosses the
  // wire, because the panel's responsiveness on a long history is a property of how
  // much it is handed, not only of how it renders. Each run carries its own stage
  // records; the run-level mode is DERIVED from them by every reader
  // (`deriveBenchmarkMode`), never stored, so no two surfaces can label one run
  // differently. Fail-safe: an absent or unreadable archive reads as no runs.
  //
  // `total` and `skipped` exist because a CAP IS A LOSS AND SO IS DAMAGE, and neither
  // announces itself: a list that came back with 200 rows when the archive holds 900
  // looks exactly like an archive holding 200. The panel states both, so history the
  // reviewer cannot see is history the reviewer is TOLD about.
  "benchmarks.list": {
    input: z.object({ limit: z.number().int().positive().max(2000).optional() }),
    output: z.object({
      runs: z.array(benchmarkRunSchema),
      /** How many distinct runs the archive holds, before the limit. */
      total: z.number().int().nonnegative(),
      /** Interior archive lines that could not be read, in the store's own words. A torn
       *  FINAL line — what a crash mid-append leaves — is not reported here. */
      skipped: z.array(z.string()),
    }),
  },
  // ── Settings: set (or reset) a review role's model assignment (C16 · #485) ──
  // The Environments → Review mappings dialog's cell edit. A personal, app-side
  // WRITE — writes only `~/.rennet/client-settings.json`'s `routing.task` slice,
  // never a repo. Mirrors `setKeybinding`/`setCoachmarks`: a plain write, first
  // click, no confirmation (Rule Zero), REFUSED (throws) when the config is
  // malformed so an edit never overwrites unparseable bytes (Rule 75). Model +
  // effort only — harness always derives from the resolved model's provider (#89),
  // so there is no harness field. `assignment: null` RESETS the cell to the
  // council-table default (clears the `routing.task` entry). Output echoes the
  // re-resolved mappings so the surface adopts them optimistically (the READ
  // itself rides `settings.get` — no separate read command).
  "settings.setRoleAssignment": {
    input: z.object({
      roleId: z.string().min(1),
      scenario: reviewRoleScenarioSchema,
      assignment: councilPickSchema.nullable(),
    }),
    output: z.object({ reviewRoles: z.array(reviewRoleMappingSchema) }),
  },
  // ── Settings: set a repo's repo-scope map visibility (wireframe #15) ───────
  // Genuinely consumed: runs the real visibility switch, which writes the repo's
  // Rennet-owned `.rennet/.gitignore` (exclusion state only — never stages,
  // un-stages, or commits) and records `visibility` in the repo's config. This is a
  // repo write, so the outcome carries `status`/`changed`/`gitignorePath`: a
  // `status` other than `applied` means NOTHING was written (an unresolved checkout
  // or a refused-because-malformed config), and the renderer must not adopt it as
  // done. `repoPath` addresses the row (validated against the project in MAIN).
  "settings.setRepoVisibility": {
    input: z.object({
      commandId: commandIdSchema,
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      visibility: projectVisibilitySchema,
    }),
    output: setRepoVisibilityOutcomeSchema,
  },
  // ── Settings: reset a repo-scoped value to inheritance (issue #28) ──────────
  // Clear the repo-layer entry for `key` so the value falls back down the ladder.
  // For visibility this ALSO re-applies the gitignore switch toward the newly
  // effective value (a reset that changed the effective value without applying it
  // would be a lie in the UI). A plain config write, no ceremony (Rule Zero);
  // refused when the config is malformed (Rule 75). `repoPath` addresses the row.
  "settings.resetRepoValue": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      key: settingsRepoValueKeySchema,
    }),
    output: settingsRepoWriteOutcomeSchema,
  },
  // ── Settings: pin a repo-scoped value at the repo layer (issue #28) ─────────
  // Write the CURRENT effective value explicitly at the repo layer, so a change in
  // a lower layer no longer moves it. Defined as set-to-current-effective, so it
  // reuses the same write path as the explicit controls — no new validation. The
  // only pinnable key is `visibility`; execution locus is a detected fact, not a
  // ladder value (#476). Refused when malformed (Rule 75). `repoPath` addresses the row.
  "settings.pinRepoValue": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      key: settingsRepoValueKeySchema,
    }),
    output: settingsRepoWriteOutcomeSchema,
  },
  // ── Settings: write one per-project preference (C18 group A) ───────────────
  // The Projects surface's own edits — glyph, worktree location + naming, and the
  // per-project issue-tracker override — written on the REPO rung (the project's own
  // `config.json`, the same rung `visibility` uses), so a project's answer beats the
  // host's global one and two projects on one machine can point at two trackers. The
  // tracker keys are the ones that reach RETRIEVAL: `resolveTrackerConfig` folds this
  // rung over the global answer, so a project pointed at its own JIRA is queried there.
  // `value: null` RESETS (drops the repo entry so the value falls back down the
  // ladder). A plain write, first click, no confirmation (Rule Zero); a malformed repo
  // config REFUSES it (`status: "malformed"` — nothing written), exactly as the other
  // repo-scoped writes. `applied` carries the freshly re-resolved row.
  "settings.setProjectValue": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      key: settingsProjectValueKeySchema,
      value: z.string().nullable(),
    }),
    output: settingsProjectWriteOutcomeSchema,
  },
  // ── Settings: write a repo's guidance catalogue (C18 group A) ──────────────
  // The WRITE beside `settings.guidance`'s read: the Guidance section's rules, saved
  // to that repo's `.rennet/conventions.json` — the same file the lens runners read
  // before every review. Statement + severity is all the surface authors; an edited
  // rule KEEPS the rationale and anti-pattern already on disk, and a newly authored
  // one takes its own statement as its reason (the reader requires one, #180). The
  // output is the catalogue read BACK off the file, so the surface renders what was
  // stored, never the request echoed. `status: "unresolved"` ⇒ the project/checkout
  // could not be resolved and NOTHING was written.
  "settings.setGuidance": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      rules: z.array(
        z.object({
          /** The rule's stable id where it has one — an edit addresses the rule by
           *  identity, so retyping the statement keeps its rationale and anti-pattern. */
          id: z.string().min(1).optional(),
          rule: z.string().min(1),
          severity: z.enum(["high", "medium", "low"]),
        }),
      ),
    }),
    output: z.object({
      status: z.enum(["applied", "unresolved"]),
      guidance: settingsGuidanceSchema,
    }),
  },
  // ── The review→agent handoff loop (issue #18, Contracts §2.1 destination B) ──
  // Batch the reviewer's open request-change/comment dispositions into a task bundle,
  // hand it to a coding harness in a WRITE-enabled session, capture the result as a
  // NEW immutable patchset, and re-review only the delta. Two steps, no gates: a
  // button that runs the agent IS the human act (Rule Zero — no consent ceremony).
  //   • `prepare` composes the bundle and returns it + a disclosure to display. Pure.
  //   • `run` rebuilds the bundle from the dispositions against the current active
  //     patchset, runs the write turn, and captures the delta.
  "review.handoff.prepare": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The addressed dispositions in effective (refined-if-kept, else raw) form. */
      dispositions: z.array(handoffDispositionSchema),
    }),
    output: z.object({ bundle: handoffBundleSchema, disclosure: handoffDisclosureSchema }),
  },
  "review.handoff.run": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /**
       * The COMPOSED bundle to run (issue #72) — the exact one `review.handoff.compose`
       * produced, NOT a re-derivation from dispositions. The run executes this bundle's
       * ordered, verbatim `prompt`, bound by its `digest`: the handler recomputes the
       * digest + prompt from the tasks and refuses a bundle that no longer matches
       * (`verifyComposedBundle`), so the write session provably runs what was composed.
       * A `composed:false` mechanical floor is a legitimate thing to run — but only when
       * it IS the composed bundle, never as a silent stand-in for a lost `composed:true`.
       */
      bundle: composedHandoffBundleSchema,
    }),
    output: handoffRunOutputSchema,
  },
  // ── Compose the handoff bundle (issue #72, Model Council M24) ───────────────
  // The light-tier authoring step over the mechanical bundle: order the asks for
  // execution sense, merge overlapping asks, write a connective narrative — WITHOUT
  // altering what was asked (the model returns only a partition of ask ids; the
  // bodies are reconstructed verbatim). ⚠️ ORDERING CONTRACT for a future wiring:
  // compose ONCE, then run THE composed bundle — the exact one this command returns.
  // The ordering matters because the bundle the run turn executes must correspond to
  // the bundle that was composed; nothing is withheld from anyone. Recomposing between
  // compose and run, or letting a `composed:false` mechanical fallback stand in after
  // the composed bundle was prepared, makes the write session execute different work
  // than was composed. So: compose, then run that same bundle. This command only
  // produces the composed bundle; it does NOT itself spend beyond the one light-tier
  // compose turn, and posts nothing.
  "review.handoff.compose": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The addressed dispositions in effective (refined-if-kept, else raw) form. */
      dispositions: z.array(handoffDispositionSchema),
    }),
    output: z.object({ bundle: composedHandoffBundleSchema }),
  },
  // ── Device pairing (issue #380) — connection bootstrap, not ceremony ───────
  // `mint` returns a short-lived single-use code the desktop shows as text (and QR
  // when a renderer supports it); a token-less non-loopback connection exchanges a
  // valid code for a long-lived device token, then just works — no per-action
  // ceremony ever (Rule Zero). `mint`/`listDevices`/`revokeDevice` are private
  // contract (loopback or an already-paired device); `exchange` is the ONE command a
  // token-less projected connection may invoke. Revocation is deleting the row.
  "pairing.mint": {
    input: z.object({}),
    output: z.object({ code: z.string().min(1), expiresAt: z.iso.datetime() }),
  },
  "pairing.exchange": {
    input: z.object({ code: z.string().min(1), deviceName: z.string().min(1) }),
    output: z.object({ deviceToken: z.string().min(1), deviceId: z.string().min(1) }),
  },
  "pairing.listDevices": {
    input: z.object({}),
    output: z.object({ devices: z.array(pairedDeviceSchema) }),
  },
  "pairing.revokeDevice": {
    input: z.object({ deviceId: z.string().min(1) }),
    output: z.object({ devices: z.array(pairedDeviceSchema) }),
  },
  // ── Push registration (issue #383 M1) — token-bearing connections only ──────
  // A paired device registers the platform push token the daemon posts attention
  // pushes to (the ideation notification taxonomy). Additive and COMPAT-tagged: it is
  // reachable only on a projected (token-bearing) connection while the daemon advertises
  // the `attention` feature; an M0-era daemon never advertises it, so a phone never calls
  // it. `remove: true` clears the token (the phone lost push permission); otherwise the
  // token is set/replaced for THIS connection's authenticated device. Revoking a device's
  // pairing deletes its push token too, so a revoked device is silently un-pushable.
  "device.registerPush": {
    input: z
      .object({
        /** The Expo/native push token, or omitted with `remove: true` to clear it. */
        pushToken: z.string().min(1).optional(),
        /** The device platform, for the push service's routing. */
        platform: z.enum(["ios", "android"]),
        /** Clear the registered token instead of setting one (permission revoked on the phone). */
        remove: z.boolean().optional(),
        /**
         * COMPAT (attention, additive, #383 batch): attention families this device has muted in
         * its notification settings — the daemon suppresses PUSHES for them to this device. A
         * high-priority family (ask/review-finished/turn-failed) always reaches every client per
         * spec, so muting one affects only the normal families. Absent ⇒ nothing muted.
         */
        disabledFamilies: z.array(attentionFamilySchema).optional(),
      })
      // Token XOR remove: a set carries a token and no `remove`; a clear sets `remove` and no token.
      // Neither (a no-op) and both (contradictory) are rejected at the boundary.
      .refine((i) => (i.remove === true) !== (i.pushToken !== undefined), {
        message:
          "device.registerPush: provide a pushToken to set, or remove:true to clear — not both",
      }),
    output: z.object({ registered: z.boolean() }),
  },
  // ── Attention acknowledgment (issue #383 M1) — clear on view ────────────────
  // A client calls this when it lands on an attention surface (the pushed review's
  // digest, the ask, the error). The daemon clears the matching attention item(s) and
  // broadcasts the clear to every authorized socket, so a handled item stops demanding
  // attention everywhere at once (attention-notifications: "handled once, quiet
  // everywhere"). Additive and COMPAT-gated on the `attention` feature. Clearing by
  // `reviewId` clears every item on that review; `attentionId` clears exactly one.
  "attention.acknowledge": {
    input: z
      .object({
        reviewId: z.string().min(1).optional(),
        attentionId: z.string().min(1).optional(),
      })
      // A selector is required — an empty acknowledge would clear nothing (or, worse, invite a
      // "clear all" reading). At least one of reviewId / attentionId must be present.
      .refine((i) => i.reviewId !== undefined || i.attentionId !== undefined, {
        message: "attention.acknowledge: provide a reviewId or an attentionId to clear",
      }),
    output: z.object({ cleared: z.number().int().nonnegative() }),
  },
  // ── Durable asks (B11 cluster 1, Q15) — the ONE write path ──────────────────
  // Every reviewer interaction on an open review (stage/withdraw an ask, edit its
  // body, retire/restore, open/reply/close a quote thread, set a per-line comment,
  // override the verdict) is a command here that APPENDS one event to the session's
  // ask log; the projection is `foldAsks(log)`, never a second stored copy. Each
  // write returns a RECEIPT — the inverse event body — so a client implements undo
  // by feeding the receipt straight back through `ask.apply`. `ask.read` is the
  // projection read a reconnecting client rehydrates from; nothing is client-derived.
  // The handlers (`server/src/dispatch/ask.ts`) and the create-server wiring landed
  // in B11 cluster 2; these are their shapes.
  "ask.stage": {
    input: z.object({ sessionId: z.string().min(1), ask: StagedAskSchema }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.unstage": {
    input: z.object({ sessionId: z.string().min(1), id: z.string().min(1) }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.dismissFinding": {
    input: z.object({ sessionId: z.string().min(1), finding: FindingRefSchema }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.restoreFinding": {
    input: z.object({ sessionId: z.string().min(1), finding: FindingRefSchema }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.edit": {
    input: z.object({ sessionId: z.string().min(1), id: z.string().min(1), body: z.string() }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.retire": {
    input: z.object({
      sessionId: z.string().min(1),
      id: z.string().min(1),
      reason: z.string(),
    }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.restore": {
    input: z.object({ sessionId: z.string().min(1), id: z.string().min(1) }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.quoteOpen": {
    input: z.object({
      sessionId: z.string().min(1),
      threadId: z.string().min(1),
      thread: QuoteThreadSchema,
    }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  // A reply is append-shaped at the command (author + text); the handler reads the
  // thread's current messages, appends, and records the resulting list on the event.
  "ask.quoteReply": {
    input: z.object({
      sessionId: z.string().min(1),
      threadId: z.string().min(1),
      author: z.enum(["user", "orchestrator"]),
      text: z.string(),
    }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.quoteClose": {
    input: z.object({ sessionId: z.string().min(1), threadId: z.string().min(1) }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  // One command, nullable verdict: a value emits `verdict-override-set`, null emits
  // `verdict-override-clear` (mirrors the client's single `setVerdictOverride`).
  "ask.setVerdictOverride": {
    input: z.object({
      sessionId: z.string().min(1),
      verdict: VerdictOverrideSchema.nullable(),
    }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.setLineComment": {
    input: z.object({
      sessionId: z.string().min(1),
      path: z.string().min(1),
      line: z.number().int().min(1),
      body: z.string(),
    }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.clearLineComment": {
    input: z.object({
      sessionId: z.string().min(1),
      path: z.string().min(1),
      line: z.number().int().min(1),
    }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  // The projection read — the session-open / reconnect rehydrate.
  "ask.read": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({ projection: AskProjectionSchema }),
  },
  // ── The round exit (B11 cluster 4, #458 R29–R36) ────────────────────────────
  // Dispatch a round: fold the review's durable ask projection (the ask-log
  // session id IS the review id) into ONE work-order via `composeHandoffBundle`
  // and hand it to the rounds runtime, serialized per session and idempotent (a
  // re-dispatch of the same asks coalesces onto the in-flight round, never a
  // second run). `dispatched:false` with an empty work-order when the review has
  // no addressed asks — an honest "nothing to dispatch", never a fabricated run.
  "round.dispatch": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: z.object({
      workOrder: composedHandoffBundleSchema,
      dispatched: z.boolean(),
      acceptedOperation: RoundOperationProgressSnapshotSchema.optional(),
    }),
  },
  // Retry a retained failed round from the checkpoint named by its durable failure
  // receipt. The operation identity and every completed effect receipt stay unchanged;
  // `retry` tells the client whether the resumed work is still the coding round or only
  // the post-landing board regeneration tail.
  "round.retry": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: z.object({
      retry: z.enum(["round", "regeneration"]),
      acceptedOperation: RoundOperationProgressSnapshotSchema,
    }),
  },
  // ── Session reads (the client seam B9 and B11 opened) ───────────────────────
  // Both are SERVED. `session.transcript` is the chat dock's read (C07): the header
  // trail + the transcript rows + the harness context figure. The harness CLI remains
  // the canonical conversation owner (#466 res. 3), but the session turn loop captures
  // the harness events it already sees and persists them verbatim, so `rows`
  // carries real coding turns for a session that has run one and is honestly `[]` for a
  // session that has not. `contextWindow` stays absent — no read port reports it. The
  // conversation itself lives in the session's T3 thread. `session.rounds` is
  // the rounds ledger read (C09 cluster 8): the session's `RoundRecord[]`, projected from
  // the live rounds runtime. Both `runRound` and the round DISPATCH record a
  // `RoundRecord`, so the ledger fills from the first dispatched round onward.
  "session.transcript": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: SessionTranscriptSchema,
  },
  "session.rounds": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: z.object({ records: z.array(RoundLedgerRecordSchema) }),
  },
  // The live round-progress READ (C15 3.1) — the ordered `RoundEvent` log for the
  // review's round so far. The push channel (`onRoundProgress`) carries each event as it
  // happens; this read is what a COLD mount (a deep-link into `/s/:slug/run`, or a
  // reconnect mid-round) folds to catch up, so a client that joins late sees the round it
  // is actually in rather than an honest-absent lie. Empty until a round dispatches.
  "session.roundEvents": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: z.object({ events: z.array(RoundEventSchema) }),
  },
  // ── The sidebar's sessions (C03 cluster 2, bound in C18) ────────────────────
  // The sidebar showed an honest EMPTY session state because protocol carried no
  // `session.list`. These four are that projection and its writes, served from the
  // durable session store: every row is a fact of a persisted `SessionModel`, and
  // every write persists so a rename, a pin, or an archive survives reload. Archive
  // carries the boolean rather than minting a fourth command — restore IS un-archive.
  "session.list": {
    input: z.object({}),
    output: z.object({ sessions: z.array(sidebarSessionSchema) }),
  },
  // ── Session minting: the New Chat front door (C21, C12 cluster 7) ───────────
  // "Start a review" is the product's front door and it had NO server path: C12 built the
  // target picker behind a `session.*` gate that B9 later cleared, and nothing came back —
  // a row click selected and did nothing. This is that path. One act (#466 res. 11): mint
  // a durable session AND claim the target, so the row disappears from New Chat while the
  // claim holds and archive is the only release.
  //
  // `branch` absent ⇒ a NO-TARGET mint (the "Current Checkout · talk about the project"
  // row): a fresh session with no claim, which claims nothing and hides nothing. `branch`
  // present ⇒ mint-or-REATTACH: a second click on an already-claimed target returns the
  // session that owns it (`reattached: true`), never a second session for one target.
  // `session: null` is the honest no-store answer — nothing was minted — matching the
  // language the sibling writes already speak.
  "session.mint": {
    input: z
      .object({
        projectId: z.string().min(1),
        /**
         * The id for the background capture this mint starts (#587/#668). The session is
         * returned immediately; capture and first-generation drafting report through its
         * durable preparation state.
         */
        commandId: commandIdSchema,
        /** The claimed branch. Absent mints a no-target session (claims nothing). */
        branch: z.string().min(1).optional(),
        /** The claimed branch's PR number, when the row was a pull request. */
        prNumber: z.number().int().positive().optional(),
        /**
         * The row's `owner/name` repository identity (#580). A workspace project holds several
         * repos, so a branch NAME is unique only within one of them — without this, two repos
         * that both have `main` collapse into one session and a row click opens the other repo's
         * chat. This is an identity, not a host path, so it crosses the wire (R19 untouched).
         * Absent ⇒ no repository named, and the mint behaves exactly as it did before.
         */
        repository: z.string().min(1).optional(),
        /** Provider-qualified repository identity from the selected row. Optional for legacy
         * clients and rows without a forge remote. */
        forgeRepository: forgeRepoIdentitySchema.optional(),
        /**
         * The refused review session whose target claim this mint replaces. The host persists
         * the fresh claimant before archiving this session, so an interruption cannot hide the
         * only review. Absent keeps ordinary mint-or-reattach behavior unchanged.
         */
        replacesSessionId: z.string().min(1).optional(),
      })
      .refine((input) => forgeRepositoryMatchesLegacy(input.repository, input.forgeRepository), {
        path: ["forgeRepository"],
        message: "forgeRepository must name the same owner/name as repository",
      })
      .refine((input) => input.replacesSessionId === undefined || input.branch !== undefined, {
        path: ["branch"],
        message: "a replacement session must name the target branch",
      }),
    output: z.object({
      session: sidebarSessionSchema.nullable(),
      /** True when an existing live claim owned the target and this reattached to it. */
      reattached: z.boolean(),
    }),
  },
  "session.cancelPreparation": {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({ session: sidebarSessionSchema.nullable() }),
  },
  "session.retryPreparation": {
    input: z.object({ sessionId: z.string().min(1), commandId: commandIdSchema }),
    output: z.object({ session: sidebarSessionSchema.nullable() }),
  },
  "session.rename": {
    // An emptied title is not stored empty: it CLEARS the reviewer's title, so the row
    // falls back to the claimed branch (the same restore-the-default rule as a project).
    input: z.object({ sessionId: z.string().min(1), title: z.string() }),
    output: z.object({ session: sidebarSessionSchema.nullable() }),
  },
  "session.setPinned": {
    input: z.object({ sessionId: z.string().min(1), pinned: z.boolean() }),
    output: z.object({ session: sidebarSessionSchema.nullable() }),
  },
  "session.archive": {
    // `archived: false` is RESTORE — un-archiving returns the session to the sidebar.
    input: z.object({ sessionId: z.string().min(1), archived: z.boolean() }),
    output: z.object({ session: sidebarSessionSchema.nullable() }),
  },
  // ── Living-draft span rework (B11 cluster 5) ────────────────────────────────
  // The backend for the client's gated `reviseDraftSpan` seam (C9 binds the seam;
  // this is its host command). A one-shot worker (a FRESH model turn, never the
  // resident cursor) reworks one staged ask's body per the reviewer's instruction,
  // serialized PER DOCUMENT (one rework in flight per review). The write routes
  // through the durable ask log — the sole ask writer (cluster 2's `ask.edit`
  // event) — so it survives reload; `receipt` reverses it (receipt-is-undo). The
  // reworked span RE-ANCHORS across the regenerated body by quote match via the
  // lineage matcher (`carriedAnchor`), fail-closed: null when the span did not
  // survive regeneration byte-identically (an ambiguous carry reopens, never lies).
  // `reworked` posts NOTHING — it stages a revised ask, exactly like a hand edit.
  "review.reviseSpan": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The staged ask whose body a span belongs to (the client rendered it). */
      askId: z.string().min(1),
      /** The reviewer's selected span — the quoted text the rework re-anchors. */
      span: z.string().min(1),
      /** What to do to the span (e.g. "make this more concise"). */
      instruction: z.string().min(1),
    }),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("reworked"),
        /** The reworked span's new home in the regenerated body, or null (fail-closed). */
        carriedAnchor: z.string().nullable(),
        /** The regenerated ask body now staged (the `ask.edit` that landed). */
        reworkedBody: z.string(),
        /** The inverse event — feed it back to undo the rework (receipt-is-undo). */
        receipt: AskEventBodySchema,
      }),
      z.object({ status: z.literal("no-change"), reason: z.string() }),
      z.object({ status: z.literal("unavailable"), reason: z.string() }),
    ]),
  },
} as const;

/** The #465 v1 agent inventory — the only rows the orchestrator's app tools expose
 * today, mapped by inspection of the resolution's list against the commands that
 * actually exist. `projects.add` needs a DiscoveryResult it cannot fabricate, so its
 * two prerequisites are exposed with it: `repository.choose` (grant/obtain the path)
 * and `project.discover` (read-only discovery → the DiscoveryResult). Without them
 * the add-project tool was uncompletable. `navigate` (#480) stays UNEXPOSED and
 * unregistered: it is a client-locus command, and the dispatch table's compile-time
 * exhaustiveness guard would force a HOST handler for it — that is client execution.
 * C11 landed the command menu without it and no command by that name exists. The
 * `session.*` READS exist (host-locus) but stay UNEXPOSED to the agent — they are
 * client-surface reads, not app tools. None invented. */
const AGENT_EXPOSED = new Set<string>([
  "ask.stage",
  "repository.choose",
  "project.discover",
  "projects.add",
  "projects.list",
  "review.openPr",
  "review.capture",
  "settings.get",
  "settings.setAppearance",
  "settings.setKeybinding",
  "settings.setRepoVisibility",
  "settings.resetRepoValue",
  "settings.pinRepoValue",
]);

/**
 * The ⌘K command-menu inventory (#477, C11 exposure pass) — decided PER ROW by walking
 * all 107 commands, never derived from a blanket rule. The full row-by-row table with a
 * rationale for every command lives in
 * `docs/developing/reference/command-menu-exposure.md`.
 *
 * The menu invokes a row with NO input and DISCARDS its output (`useInvoke`, C11
 * cluster 6): `exposure.commandMenu` is a boolean with no input channel and the menu
 * has no result surface. So a row earns `true` only when all four hold:
 *
 * 1. Its input schema is satisfied by `{}` — nothing required the menu cannot supply
 *    (19 of 105 pass; the rest need a review/session/project/span id or a host path).
 * 2. It is an ACTION, not a read the UI already drives for itself (`settings.get`,
 *    `session.list`, `board.read`, `harness.hosts`, `daemon.status`, … all stay false:
 *    running them from the menu changes nothing a reader would see).
 * 3. Its output is not the point — a row whose result must be DISPLAYED
 *    (`github.connectStart`'s device code, `pairing.mint`'s code) would be run and
 *    thrown away.
 * 4. It means something outside the surface that owns it — `github.connectCancel`
 *    only makes sense mid-device-flow, while `github.disconnect` only makes sense
 *    when Settings has established that the live source is Rennet's fallback.
 *
 * That leaves no rows today. Under-exposure is honest; an entry that appears to run and
 * visibly does nothing is a broken row. Widening this set means giving the menu a way to
 * supply context and show a result — new UI, deliberately not built here.
 */
const MENU_EXPOSED = new Set<string>();

/** Where a command executes: the host daemon, or a connected client (#465). Every
 * row today is host-locus; client-locus rows arrive with their commands. */
export type CommandLocus = "host" | "client";

export interface CommandExposure {
  /** Rendered in app UI surfaces (sidebar and friends). */
  readonly ui: boolean;
  /** Listed in the ⌘K command menu (#477). */
  readonly commandMenu: boolean;
  /** Handed to the orchestrator as an app_* tool (#465 v1 inventory). */
  readonly agent: boolean;
}

/** One registry row per command. #465: tool name = command id = menu label, so
 * `label` is initialized to the id — a display rename is a one-field edit. */
export type CommandRegistry = {
  readonly [K in keyof typeof definitions]: {
    readonly args: (typeof definitions)[K]["input"];
    readonly output: (typeof definitions)[K]["output"];
    readonly label: string;
    readonly exposure: CommandExposure;
    readonly locus: CommandLocus;
  };
};

/**
 * The #465 command registry — ONE table, keyed by stable command id. The sidebar,
 * the ⌘K command menu, and the orchestrator's app tools are three readers of this
 * table; none carries its own list. Labels and loci are uniform today, so they are
 * derived rather than hand-repeated per row; `exposure.agent` and `exposure.commandMenu`
 * are the per-row data (the two inventories above, each decided command by command).
 */
export const commands = Object.fromEntries(
  Object.entries(definitions).map(([id, def]) => [
    id,
    {
      args: def.input,
      output: def.output,
      label: id,
      exposure: { ui: true, commandMenu: MENU_EXPOSED.has(id), agent: AGENT_EXPOSED.has(id) },
      locus: "host",
    },
  ]),
) as CommandRegistry;

export type CommandName = keyof CommandRegistry;
export type CommandInput<K extends CommandName> = z.input<CommandRegistry[K]["args"]>;
export type CommandOutput<K extends CommandName> = z.output<CommandRegistry[K]["output"]>;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commands, value);
}

export function parseCommandInput<K extends CommandName>(name: K, input: unknown): CommandInput<K> {
  return commands[name].args.parse(input) as CommandInput<K>;
}

export function parseCommandOutput<K extends CommandName>(
  name: K,
  output: unknown,
): CommandOutput<K> {
  return commands[name].output.parse(output) as CommandOutput<K>;
}
