import { z } from "zod";
import { anchorSideSchema, anchorSpanSchema, codeRefSchema } from "../delta/citations";
import { MAX_UI_EVIDENCE_DATA_URL_LENGTH } from "../domain";
import {
  AskEventBodySchema,
  AskProjectionSchema,
  attentionFamilySchema,
  QuoteThreadSchema,
  RoundRecordSchema,
  SessionTranscriptSchema,
  StagedAskSchema,
  VerdictOverrideSchema,
} from "../session";
import {
  appearanceSchemeSchema,
  askModeSchema,
  askReviewResultSchema,
  coachMarksSchema,
  composedHandoffBundleSchema,
  conversationAnchorSchema,
  daemonHostStatusSchema,
  deltaDigestResultSchema,
  detectedForgeSchema,
  detectedHarnessSchema,
  discoveryResultSchema,
  dispositionTypeSchema,
  flaggedReviewSchema,
  forgeRequestSchema,
  forgeReviewEventSchema,
  fsListDirResultSchema,
  gitHubAuthStatusSchema,
  gitHubConnectPollSchema,
  handoffBundleSchema,
  handoffDisclosureSchema,
  handoffDispositionSchema,
  handoffRunOutputSchema,
  harnessHostDetectionSchema,
  knowledgeDispositionResultSchema,
  noiseReviewSchema,
  openSpecChangeSchema,
  openSpecCoverageSchema,
  pairedDeviceSchema,
  prBodyDraftResultSchema,
  processedRepoSummarySchema,
  projectContextAskResultSchema,
  projectContextMapResultSchema,
  projectDetailSchema,
  projectKindSchema,
  projectSchema,
  projectVisibilitySchema,
  prSubmissionSchema,
  prWorktreeSetupSchema,
  publishDegradationSchema,
  publishOutcomeSchema,
  publishTargetSchema,
  pullRequestStateSchema,
  reattachResultSchema,
  refinementResultSchema,
  resolvedProvenanceSchema,
  reviewBodyNoteSchema,
  reviewCommentSchema,
  reviewSchema,
  setRepoVisibilityOutcomeSchema,
  settingsGuidanceSchema,
  settingsRepoValueKeySchema,
  settingsRepoWriteOutcomeSchema,
  settingsViewSchema,
  sourceSchema,
  symbolInspectionSchema,
} from "../wire";

const commandIdSchema = z.uuid();
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
  // ── Publish consent request, main-issued (issue #21) ───────────────────────
  // Posting to GitHub is an EXTERNAL act, so it stays explicitly confirmed (running
  // a model, by contrast, just runs). The renderer REQUESTS approval to POST a
  // review; MAIN is the sole issuer of the authorization, and the token is bound to
  // the exact TARGET (PR + head) AND the exact PAYLOAD bytes.
  // A token minted to post payload P to PR#5@head-A cannot authorise a different
  // payload, a different PR, or a different head. Single-use, consumed at egress.
  "publish.requestConsent": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      target: publishTargetSchema,
      /** The canonical payload bytes the token authorises (bound by digest). */
      payload: z.string(),
      /**
       * The resolved review VERDICT/event the token authorises. Bound alongside the
       * payload because it is the one outbound field the payload bytes do not capture
       * (`buildForgeReviewPost` renders the GraphQL post as a pure function of review +
       * target + payload + verdict) — so an APPROVE/REQUEST_CHANGES cannot be swapped in
       * after the human approved a COMMENT. The renderer sends the same value here and
       * at `publish.review`.
       */
      verdict: forgeReviewEventSchema,
      /**
       * The compose integrity binding (#382 M2 finding 2), when the artifact was daemon-composed
       * (the phone flow). Optional/additive: the desktop composes locally and omits it. When
       * present, the daemon recomputes it from the CURRENT review and refuses a stale/cross-review
       * mint before a token is issued.
       */
      compositionId: z.string().min(1).optional(),
    }),
    output: z.object({
      /** The opaque, single-use authorization bound to (review, target, payload, verdict). */
      authorization: z.string().min(1),
    }),
  },
  // ── Publish a review to GitHub (issue #21) — the FIRST real egress ──────────
  // The pipeline NEVER autonomously posts to a real repo: egress exists ONLY behind
  // this command, from the trusted renderer origin, and every real send is gated.
  //   • `dryRun` defaults to TRUE (wrong-side-safe, Rule 75): an omitted flag NEVER
  //     posts. The renderer's real-post path must EXPLICITLY send `dryRun: false`.
  //   • MAIN re-derives the canonical payload from `comments` and refuses on any
  //     disagreement with `payload` (byte-exact), and refuses an ill-formed target —
  //     both on dry-run and real, so the dry-run surfaces integrity faults too.
  //   • A real send ALWAYS requires the single-use token from `publish.requestConsent`,
  //     bound to THIS review, target, and payload; absent / forged / replayed ⇒
  //     refused, nothing leaves. Posting to GitHub is an external act — it stays
  //     explicitly confirmed — unlike running a model, which just runs. Dry-run needs
  //     no token (it posts nothing).
  //   • The review event is always a neutral COMMENT — the outbound request has no
  //     shape for APPROVE (R33/#80).
  "publish.review": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      target: publishTargetSchema,
      /** The canonical review content (mirrors the ui `ReviewComment` preview). */
      comments: z.array(reviewCommentSchema),
      /**
       * The review-BODY notes — pathless/prose asks woven into the review body (B11 finding
       * 2). Optional/additive: absent ⇒ `[]`, so a client that only sends line comments is
       * unchanged. The canonical payload folds these in, so they round-trip like `comments`.
       */
      bodyNotes: z.array(reviewBodyNoteSchema).optional().default([]),
      /** The canonical payload bytes the sheet previewed + signed (round-trip check). */
      payload: z.string(),
      /**
       * The review verdict. Optional: absent ⇒ derived from the dispositions (any
       * requested change ⇒ REQUEST_CHANGES; else approvals ⇒ APPROVE; else COMMENT).
       * When set, this explicit verdict WINS ("derive first, overridable"). A sign-time
       * verdict picker feeds this; until then it simply stays unset.
       */
      verdict: forgeReviewEventSchema.optional(),
      /** The single-use consent token from `publish.requestConsent` (real send only). */
      authorization: z.string().min(1).optional(),
      /** The compose integrity binding (#382 M2 finding 2), when daemon-composed (the phone flow).
       *  Optional/additive; when present the daemon recomputes it and refuses a stale/cross-review
       *  post (dry-run included) before building the request. */
      compositionId: z.string().min(1).optional(),
      /** Default TRUE: an omitted flag never posts. Real egress must opt in with false. */
      dryRun: z.boolean().optional().default(true),
    }),
    output: z.object({
      /** Echoes the resolved dry-run flag (true ⇒ nothing left the machine). */
      dryRun: z.boolean(),
      /** The exact GitHub request that was (dry-run) or would be constructed + sent. */
      request: forgeRequestSchema,
      /** The deterministic idempotency marker embedded in the review body. */
      marker: z.string(),
      /** Every flattening applied, surfaced for the sheet's ledger (never silent). */
      ledger: z.array(publishDegradationSchema),
      /** The real-post outcome, or `null` on a dry-run (nothing posted). */
      outcome: publishOutcomeSchema.nullable(),
    }),
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
      /** The PR to open — title/body (with the human's edits)/base/head/draft. */
      submission: prSubmissionSchema,
      /** The canonical `pr-submission` bytes the sheet previewed + signed (round-trip check). */
      payload: z.string(),
      /** The compose integrity binding (#382 M2 finding 2), when daemon-composed (the phone flow).
       *  Optional/additive; when present the daemon recomputes it and refuses a stale (advanced
       *  patchset) or cross-review submission before pushing. */
      compositionId: z.string().min(1).optional(),
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
  //  • "review" — a team-PR review to post. Composes the default (unedited) comments
  //    from the review's dispositions + the derived verdict; the phone previews them and
  //    posts via `publish.review`, which re-verifies these very bytes.
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
        /** The composed team-PR comments the phone previews AND posts verbatim via `publish.review`. */
        comments: z.array(reviewCommentSchema),
        /** The composed review-BODY notes (pathless/prose asks) the phone previews AND posts
         *  verbatim (B11 finding 2). Folded into the canonical `payload`, so nothing vanishes.
         *  Additive/optional so a pre-finding-2 consumer (or a partial mock) still validates; the
         *  daemon always sends it (`[]` when there are none). */
        bodyNotes: z.array(reviewBodyNoteSchema).optional(),
        /** The canonical bytes, derived from `comments` + `bodyNotes` — `publish.review` verifies. */
        payload: z.string(),
        /** The derived review verdict (the GitHub review event the post will carry). */
        verdict: forgeReviewEventSchema,
        /** A human destination line for the preview (e.g. `owner/name#7`). */
        destination: z.string(),
        /** A short headline for the preview (the repo/PR the review posts to). */
        title: z.string(),
        /**
         * Integrity binding (#382 M2 finding 2): a deterministic id over (reviewId, active
         * patchset, mode, target, canonical payload). The phone carries it to `publish.review`,
         * which recomputes it from the CURRENT review and refuses a cross-review or stale-revision
         * post — pure integrity, no ceremony. A pre-M2 daemon omits it (the post skips the check).
         */
        compositionId: z.string().min(1),
      }),
      z.object({
        status: z.literal("pr"),
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
      z.object({ status: z.literal("unavailable"), reason: z.string() }),
    ]),
  },
  // ── The front door: projects + discovery (issue #29 / #37) ─────────────────
  // The empty projects list IS first run; the add-a-project flow that lives there
  // forever is the whole onboarding. Discovery reads the pointed-at path read-only
  // and never mutates the index or calls a model before harness disclosure.
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
  // the rows into `sourceControlByHost`. Singleton registry today — GitHub / `gh` only.
  "forge.detect": {
    input: z.object({}),
    output: z.object({ detected: z.array(detectedForgeSchema) }),
  },
  // Rule a forge CLI in or out ON ONE HOST (amendment A) — the served write behind the Source
  // Control row's toggle, mirroring harness.setEnabled exactly and persisted on the same
  // per-host daemon-settings entry, so the decision survives reload. Read back through
  // `harness.hosts`'s `disabledForges`. It installs nothing and hides nothing: the row stays,
  // with its toggle off.
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
    output: z.object({ hosts: z.array(daemonHostStatusSchema) }),
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
  // ── The GitHub account (v4.2: device flow, no gh CLI) ──────────────────────
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
    // the shape; dispatch binds it in B4/B10 — the wire answers
    // unknown-command until then (proposal reconciliation 8).
    input: codeRefSchema,
    output: z.object({
      /** The cited span's lines, in order, from the captured patch text. */
      lines: z.array(z.string()),
      /** A few lines either side of the span, for orientation. */
      contextBefore: z.array(z.string()),
      contextAfter: z.array(z.string()),
    }),
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
  "projects.remove": {
    // Forget a project from the front-door list. Does NOT delete the repo on disk —
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
    output: z.object({ repos: z.array(processedRepoSummarySchema) }),
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
  // ── The Context Map surface (change add-context-map-view) ──────────────────
  // Pure read of the persisted Repo Map: no rebuild, no model spend. An absent
  // or gate-failing snapshot is a typed absent, never a fabricated map.
  "project.contextMap": {
    input: z.object({ projectId: z.string().min(1) }),
    output: projectContextMapResultSchema,
  },
  // Project-scoped orchestrator ask over the persisted snapshot + knowledge set.
  // Model spend through the user's own harness; unanswered and failed are
  // first-class honest results, never a clean answer without evidence.
  "project.contextAsk": {
    input: z.object({
      projectId: z.string().min(1),
      question: z.string().min(1),
      /** Restrict consulted context to a scope name or repo-relative subtree. */
      scope: z.string().optional(),
    }),
    output: projectContextAskResultSchema,
  },
  // Human disposition of a knowledge statement (the R54 "a human confirms it"
  // surface): flips status by id and persists the set. Disposition never edits
  // the claim, so the content-hash id stays stable.
  "project.knowledgeDisposition": {
    input: z.object({
      projectId: z.string().min(1),
      statementId: z.string().min(1),
      disposition: z.enum(["confirmed", "rejected"]),
    }),
    output: knowledgeDispositionResultSchema,
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
  // ── Ask the AI a question about the review (issue #139) ────────────────────
  // The reviewer's question goes to the ORCHESTRATOR by default; `mode: "both"`
  // ADDITIONALLY asks Codex, and the two labelled answers come back side by side.
  //   • `mode` defaults to "orchestrator" (wrong-side-safe): an omitted mode NEVER
  //     fires a second model behind the reviewer's back.
  //   • The output carries at most `primary` (always the orchestrator) + an optional
  //     `secondOpinion` (Codex, only in "both") — there is NO merged-answer field, so
  //     "no synthesis, ever" is a property of the schema, not just the router.
  // The routing law — orchestrator once, both adds Codex, never a synthesis — lives
  // in `@rennet/core`'s `askReview`. The ports are LIVE (a real orchestrator turn +
  // an optional `codex exec`); asking a model is Rennet's whole job, so it just runs
  // — no permission check, no consent token. Dispatch resolves the current review
  // ONCE and hands the SAME snapshot to both legs, so a "both" ask can never cross
  // two patchsets.
  "review.ask": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** Default "orchestrator": an omitted mode never fires a second model. */
      mode: askModeSchema.default("orchestrator"),
      /** The reviewer's question about the review. */
      question: z.string().min(1),
      // #251: when these are present, main persists the thread and streams the turn
      // under these ids (delta/complete/interrupted over `onAskStream`). ABSENT = a
      // one-shot #139 ask with no persistence and no stream — fully back-compatible.
      threadId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
      anchor: conversationAnchorSchema.optional(),
      selection: z
        .object({
          anchor: z.string().min(1),
          excerpt: z.string().optional(),
        })
        .optional(),
      // The reviewer's RAW question for this turn (not the folded transcript), persisted
      // as the "you" message so a re-attached thread shows what was asked. #251.
      turnBody: z.string().optional(),
      /**
       * The attention item this answer resolves (#382 M2 finding 3, shade answering). Carried ONLY
       * by a shade answer: the ask push carries its attention id, the chip-tap invokes `review.ask`
       * with it, and the daemon consumes that attention atomically BEFORE running the turn — so a
       * duplicate tap (the item already consumed) is refused truthfully as "already answered", and a
       * forged/stale id (no such active item) is refused too. Absent for an in-app answer (which
       * interrupts + asks) and for a pre-M2 client. Additive.
       */
      attentionId: z.string().min(1).optional(),
    }),
    output: askReviewResultSchema,
  },
  // ── review.reattach: reload persisted threads + learn what is still streaming (#251)
  // Called on review load / after a renderer reload. Returns every persisted thread for
  // the review (identity + content + harness version) AND the turns still in flight in a
  // surviving main process (so the renderer resumes their coalesced bodies). A turn left
  // `streaming` by a KILLED main is not "in flight": the store reads it back as
  // `interrupted`, so it returns inside a thread's messages, never in `inFlight`.
  "review.reattach": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: reattachResultSchema,
  },
  // ── review.interrupt: stop a review's in-flight turn (issue #382 M2) ──────────
  // The mobile "Stop" (wireframe 22) and any client's turn interrupt. Aborts the
  // review's currently-streaming turn(s) via the live-turn registry — the same abort
  // signal `before-quit` fires, but scoped to ONE review and client-triggered. The
  // aborted turn emits `ask-interrupted` on its stream (so every watcher renders the
  // interrupted outcome truthfully), its ask-pending attention clears, and turn-failed
  // raises with the truthful "interrupted" cause. Additive and idempotent: interrupting
  // a review with nothing in flight returns `interrupted: 0` (a no-op, never an error) —
  // a double-tap Stop is safe. No new egress, no gate: stopping your own turn just runs.
  "review.interrupt": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: z.object({
      /** How many in-flight turns were signalled to stop (0 ⇒ nothing was running). */
      interrupted: z.number().int().nonnegative(),
    }),
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
  // ── The Spec view's requirement→hunk coverage (wireframes #9 / R53) ──────────
  // The produced hunk↔requirement mapping over the review's OpenSpec change: a model
  // turn grounds each requirement to the offered hunks that implement it plus a test
  // count, budget-gated. `status: "failed"` (no model / budget refused / turn failed)
  // OR `null` (no change in the review) ⇒ the Spec view renders NO coverage chips —
  // an uncomputed mapping never masquerades as a real zero.
  "openspec.coverage": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: openSpecCoverageSchema.nullable(),
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
  // Handlers + create-server wiring land in B11 cluster 2; these are the shapes.
  "ask.stage": {
    input: z.object({ sessionId: z.string().min(1), ask: StagedAskSchema }),
    output: z.object({ receipt: AskEventBodySchema }),
  },
  "ask.unstage": {
    input: z.object({ sessionId: z.string().min(1), id: z.string().min(1) }),
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
    output: z.object({ workOrder: composedHandoffBundleSchema, dispatched: z.boolean() }),
  },
  // ── Session reads (B9/B10-deferred client seam) ─────────────────────────────
  // The two client-facing SESSION READs B9 (the runtime) and B11 (the round WRITE)
  // deferred. `session.transcript` is the chat dock's read (C07): the header trail +
  // the historical transcript rows + the harness context figure. Honest-absent today —
  // the harness owns the coding transcript (#466 res. 3), so Rennet has no server-side
  // coding turns to return; `rows` is empty and `contextWindow` absent until a harness-
  // transcript read port lands (a future capability, not a projection). The live ask
  // threads arrive separately via `review.reattach`, already wired. `session.rounds` is
  // the rounds ledger read (C09 cluster 8): the session's `RoundRecord[]`, projected from
  // the live rounds runtime. Empty until a round RECORDS (`runRound`); the dispatch WRITE
  // (B11) runs the workers but the record wiring is a separate deferred piece.
  "session.transcript": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: SessionTranscriptSchema,
  },
  "session.rounds": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: z.object({ records: z.array(RoundRecordSchema) }),
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
 * exhaustiveness guard would force a HOST handler for it — that is client execution,
 * deferred to C11. The `session.*` READS now exist (host-locus) but stay UNEXPOSED to the
 * agent — they are client-surface reads, not app tools. None invented. */
const AGENT_EXPOSED = new Set<string>([
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
 * derived rather than hand-repeated per row; `exposure.agent` is the only per-row
 * datum (the v1 inventory above).
 */
export const commands = Object.fromEntries(
  Object.entries(definitions).map(([id, def]) => [
    id,
    {
      args: def.input,
      output: def.output,
      label: id,
      exposure: { ui: true, commandMenu: false, agent: AGENT_EXPOSED.has(id) },
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
