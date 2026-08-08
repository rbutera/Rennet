import type { ReviewService } from "@rennet/core";
import {
  type CommandName,
  type PermissionMode,
  parseCommandInput,
  parseCommandOutput,
  requiresConsent,
  resolvePermissionMode,
} from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  ElementDiffs,
  NarrativeProgressEvent,
  Review,
  ReviewNarration,
} from "@rennet/types";

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
  /** Begin watching a captured repository root for on-disk changes. */
  startWatching(root: string): void;
  isRepositoryDirty(): boolean;
  setRepositoryDirty(dirty: boolean): void;
  /**
   * Build the live five-angle canvas set for a review (harness-backed pipeline),
   * plus the per-element real diff map (#60) delivered with it.
   */
  buildCanvases(
    review: Review,
    onProgress?: (event: NarrativeProgressEvent) => void,
  ): Promise<{
    canvases: Record<CanvasAngle, Canvas>;
    elementDiffs: ElementDiffs;
    /** The roll-up narration placed onto the canvases (issue #70), when produced. */
    narration?: ReviewNarration;
    /** The deterministic, resumable live-narrative summary (issue #71). */
    progress?: NarrativeProgressEvent[];
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
}

export function createDispatch(
  deps: DispatchDeps,
): (
  name: CommandName,
  rawInput: unknown,
  onProgress?: (event: NarrativeProgressEvent) => void,
) => Promise<unknown> {
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
    onProgress?: (event: NarrativeProgressEvent) => void,
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
        const { canvases, elementDiffs, narration, progress } = await deps.buildCanvases(
          review,
          onProgress,
        );
        return parseCommandOutput(name, {
          canvases,
          elementDiffs,
          ...(narration ? { narration } : {}),
          ...(progress ? { progress } : {}),
        });
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
