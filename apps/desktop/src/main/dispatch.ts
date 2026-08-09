import {
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
  type PermissionMode,
  type Project,
  type ProjectKind,
  parseCommandInput,
  parseCommandOutput,
  requiresConsent,
  resolvePermissionMode,
} from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  ElementDiffs,
  Review,
  ReviewEngine,
  ReviewNarration,
} from "@rennet/types";
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
  /** Repositories the user has granted review access to (renderer-origin guard). */
  readonly allowedRoots: Set<string>;
  /** Resolve a repository to review (Electron dialog, or the test-repo env). `null` = cancelled. */
  chooseRepository(): Promise<string | null>;
  /**
   * Open a GitHub pull request into a review (the front door's second source):
   * parse the ref (`owner/repo#123` or a PR URL), fetch + diff the PR against the
   * local clone at `repoPath`, and persist a new review. Returns the created
   * review, ready for the same surface the local capture lands in.
   */
  openPullRequest(commandId: string, ref: string, repoPath: string): Promise<Review>;
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
  }>;
  /**
   * The workspace permission-mode store (issue #103). Reads the persisted
   * workspace default; writes it. The renderer layers a per-run override over
   * the value this returns.
   */
  readonly settings: {
    permissionMode(): PermissionMode;
    setPermissionMode(mode: PermissionMode): void;
  };
  /**
   * The main-owned harness-run consent authority (bead workspace-fyvxb). MAIN
   * mints a single-use, review-bound authorization on the user's approval act
   * (`harness.requestConsent`) and consumes it before the harness runs, instead
   * of trusting a renderer-supplied replayable boolean.
   */
  readonly consent: {
    grant(reviewId: string): string;
    consume(reviewId: string, authorization: string): boolean;
  };
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
  /** Read-only discovery over an already-granted path → editable defaults. */
  discoverProject(input: { path: string; kind: ProjectKind }): Promise<DiscoveryResult>;
  /** The harnesses found on the machine, for the ambient first-run detection line. */
  detectHarnesses(): Promise<DetectedHarness[]>;
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

export function createDispatch(
  deps: DispatchDeps,
): (name: CommandName, rawInput: unknown) => Promise<unknown> {
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

  return async function dispatch(name: CommandName, rawInput: unknown): Promise<unknown> {
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
        const review = await deps.openPullRequest(input.commandId, input.ref, input.repoPath);
        allowedRoots.add(review.repositoryRoot);
        return parseCommandOutput(name, { review });
      }
      case "settings.permissionMode": {
        parseCommandInput(name, rawInput);
        return parseCommandOutput(name, { mode: deps.settings.permissionMode() });
      }
      case "settings.setPermissionMode": {
        const input = parseCommandInput(name, rawInput);
        deps.settings.setPermissionMode(input.mode);
        return parseCommandOutput(name, { mode: deps.settings.permissionMode() });
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
      case "harness.requestConsent": {
        // The renderer REQUESTS approval for this review's harness run (bead
        // workspace-fyvxb). MAIN is the sole issuer: it binds a fresh single-use
        // token to the CURRENT review and returns it. Requiring the latest review
        // keeps a token from being minted for a stale/unknown id. Minting is
        // independent of the mode (harmless under auto/bypass, where the token is
        // never checked); the enforcement lives at consume time below.
        const input = parseCommandInput(name, rawInput);
        const review = requireLatestReview(input.reviewId);
        return parseCommandOutput(name, { authorization: deps.consent.grant(review.id) });
      }
      case "publish.requestConsent": {
        // The renderer REQUESTS approval to POST to GitHub; MAIN mints the token. It
        // is bound to (review, target, payload) via `publishConsentKey`, so the token
        // authorises exactly one payload onto exactly one PR (coordinates + node id +
        // head) — the renderer must present the SAME target + payload at egress or the
        // token cannot consume.
        const input = parseCommandInput(name, rawInput);
        // Parity with `harness.requestConsent`: refuse to mint a token for a stale or
        // unknown review id; only the current review can be published from this session.
        const review = requireLatestReview(input.reviewId);
        const key = publishConsentKey(review.id, toForgeReviewTarget(input.target), input.payload);
        return parseCommandOutput(name, { authorization: deps.publishConsent.grant(key) });
      }
      case "publish.review": {
        // The FIRST real egress: a decomposed review leaving the machine onto a PR AS
        // THE USER. Every dangerous part is gated here; the pipeline has no other path
        // to egress (this command is reachable only from the trusted renderer origin).
        const input = parseCommandInput(name, rawInput);
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
          // (4) REAL egress. Two independent guards on this vital circuit (Rule 75:
          // no single fault clears it):
          //   a. the effective MODE resolved from the persisted WORKSPACE store (the
          //      j98dt authority — a renderer-supplied mode is NOT trusted;
          //      corrupt/unknown still ASKS);
          //   b. under a mode that ASKS (manual), a single-use CONSENT token that MAIN
          //      minted for THIS (review, target, payload) — verified + CONSUMED here.
          //      Absent / forged / replayed / target-or-payload-mismatched ⇒ refused,
          //      and NOTHING leaves.
          const effectiveMode = resolvePermissionMode({
            workspace: deps.settings.permissionMode(),
          });
          if (requiresConsent(effectiveMode, "publish.egress")) {
            const key = publishConsentKey(input.reviewId, target, input.payload);
            const authorization = input.authorization;
            if (
              typeof authorization !== "string" ||
              !deps.publishConsent.consume(key, authorization)
            ) {
              throw new Error(
                "Publish refused: not authorized to post under the current permission mode",
              );
            }
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
        // #58/#103 harness-run gate, enforced at the MAIN boundary. Two
        // independent guards on the vital model-spend circuit (Rule 75: no single
        // fault clears it):
        //   1. The effective MODE is resolved from the persisted WORKSPACE store
        //      (the j98dt authority — a renderer-supplied mode is NOT trusted;
        //      corrupt/unknown still ASKS). Unchanged here.
        //   2. Under a mode that ASKS (manual), the per-run CONSENT is no longer a
        //      renderer-supplied boolean (forgeable + replayable). MAIN requires a
        //      single-use token that IT minted for THIS review (bead
        //      workspace-fyvxb), verifies + CONSUMES it here, and only then runs
        //      the harness. Absent / forged / already-consumed ⇒ refused, and the
        //      model turn never composes. `consume` is called ONLY when the mode
        //      asks, so an auto/bypass run neither needs nor spends a token.
        const effectiveMode = resolvePermissionMode({ workspace: deps.settings.permissionMode() });
        if (requiresConsent(effectiveMode, "harness.run")) {
          const authorization = input.authorization;
          if (
            typeof authorization !== "string" ||
            !deps.consent.consume(review.id, authorization)
          ) {
            throw new Error("The harness run was not authorized under the current permission mode");
          }
        }
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
      // ── Canvas user ops (issue #54 wires #10's command surface into dispatch) ──
      case "canvas.disposition": {
        // The sovereign L2 write maps directly onto the review's disposition path
        // (#49 item 1/2 — the protocol input already uses `path`/`disposition`).
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
