import { createHash } from "node:crypto";
import type {
  Disposition,
  DispositionAnchor,
  DispositionType,
  PatchFile,
  Patchset,
  Review,
} from "@rennet/types";
import { v7 as uuidv7 } from "uuid";

export * from "./angle-generation";
export * from "./canvas";
export * from "./canvas-change-feed";
export * from "./canvas-ops";
export * from "./decomposition";
export * from "./forge-port";
export * from "./harness";
export * from "./harness-run-turn";
export * from "./ordering-pass";
export * from "./pipeline";
export * from "./route-plan";

export type ReviewEvent =
  | { type: "ReviewCreated"; version: 1; reviewId: string; patchset: Patchset }
  | { type: "PatchsetActivated"; version: 1; reviewId: string; patchset: Patchset }
  | {
      type: "DispositionSet";
      version: 1;
      reviewId: string;
      patchsetId: string;
      disposition: Disposition;
    }
  | {
      type: "DispositionCleared";
      version: 1;
      reviewId: string;
      patchsetId: string;
      path: string;
    }
  | { type: "ReviewInvalidated"; version: 1; reviewId: string; candidate: Patchset };

export interface PatchsetCapturePort {
  capture(repositoryPath: string): Promise<Patchset>;
}

export interface ReviewStorePort {
  /**
   * The most recent review. Scoped to a single repository when a root is given
   * (create-vs-activate for a capture), or globally for bootstrap restore.
   */
  latestReview(repositoryRoot?: string): Review | null;
  /** A specific review by id, independent of which repository is most recent. */
  reviewById(reviewId: string): Review | null;
  receipt(commandId: string, digest: string): Review | null;
  commit(commandId: string, digest: string, events: ReviewEvent[], result: Review): Review;
}

function exhaustive(value: never): never {
  throw new Error(`Unknown review event: ${JSON.stringify(value)}`);
}

/**
 * The exact-match content key for a changed file: a hash of its patch text.
 * Two anchors are "the same file, unchanged" iff their `path` and this digest
 * both match. This is the sole matcher for slice 1 (no fuzzy lineage).
 */
export function fileContentDigest(file: PatchFile): string {
  return createHash("sha256").update(file.patch).digest("hex");
}

/**
 * Carry dispositions across a re-capture, CONSERVATIVELY. A disposition
 * survives only where the new patchset still has a file at the same path whose
 * patch content is byte-identical. Any change, rename, or removal fails closed
 * (the disposition is dropped, so the reviewer must re-read). No fuzzy matching.
 */
function carryDispositions(previous: Disposition[], next: Patchset): Disposition[] {
  const digestByPath = new Map<string, string>();
  for (const file of next.files) digestByPath.set(file.path, fileContentDigest(file));
  return previous.filter((disposition) => {
    const nextDigest = digestByPath.get(disposition.anchor.path);
    return nextDigest !== undefined && nextDigest === disposition.anchor.contentDigest;
  });
}

function requireActivePatchset(
  current: Review | null,
  event: { reviewId: string; patchsetId: string },
): Review {
  if (!current || current.id !== event.reviewId || current.activePatchsetId !== event.patchsetId) {
    throw new Error("A disposition must target the active patchset");
  }
  return current;
}

export function foldReview(current: Review | null, event: ReviewEvent): Review {
  switch (event.type) {
    case "ReviewCreated":
      return {
        id: event.reviewId,
        repositoryRoot: event.patchset.repository.root,
        patchsets: [event.patchset],
        activePatchsetId: event.patchset.id,
        dispositions: [],
        status: "current",
      };
    case "PatchsetActivated": {
      if (!current || current.id !== event.reviewId) {
        throw new Error("Cannot activate a patchset for an unknown review");
      }
      const patchsets = current.patchsets.some((patchset) => patchset.id === event.patchset.id)
        ? current.patchsets
        : [...current.patchsets, event.patchset];
      return {
        ...current,
        patchsets,
        activePatchsetId: event.patchset.id,
        pendingPatchsetId: undefined,
        // Conservative carry: keep dispositions only on byte-identical anchors,
        // never a blanket wipe.
        dispositions: carryDispositions(current.dispositions, event.patchset),
        status: "current",
      };
    }
    case "DispositionSet": {
      const review = requireActivePatchset(current, event);
      const dispositions = review.dispositions.filter(
        (existing) => existing.anchor.path !== event.disposition.anchor.path,
      );
      dispositions.push(event.disposition);
      dispositions.sort((left, right) => left.anchor.path.localeCompare(right.anchor.path));
      return { ...review, dispositions };
    }
    case "DispositionCleared": {
      const review = requireActivePatchset(current, event);
      return {
        ...review,
        dispositions: review.dispositions.filter((existing) => existing.anchor.path !== event.path),
      };
    }
    case "ReviewInvalidated": {
      if (!current || current.id !== event.reviewId) {
        throw new Error("Cannot invalidate an unknown review");
      }
      const patchsets = current.patchsets.some((patchset) => patchset.id === event.candidate.id)
        ? current.patchsets
        : [...current.patchsets, event.candidate];
      return {
        ...current,
        patchsets,
        pendingPatchsetId: event.candidate.id,
        status: "invalid",
      };
    }
    default:
      return exhaustive(event);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(stable(payload)).digest("hex");
}

export class ReviewService {
  constructor(
    private readonly capturePort: PatchsetCapturePort,
    private readonly store: ReviewStorePort,
  ) {}

  bootstrap(): Review | null {
    return this.store.latestReview();
  }

  async capture(commandId: string, repositoryPath: string, reviewId?: string): Promise<Review> {
    const digest = payloadDigest({ repositoryPath, reviewId });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;

    const patchset = await this.capturePort.capture(repositoryPath);
    const current = this.store.latestReview(repositoryPath);
    const event: ReviewEvent =
      current && current.id === reviewId
        ? { type: "PatchsetActivated", version: 1, reviewId: current.id, patchset }
        : { type: "ReviewCreated", version: 1, reviewId: uuidv7(), patchset };
    const review = foldReview(current && event.type !== "ReviewCreated" ? current : null, event);
    return this.store.commit(commandId, digest, [event], review);
  }

  /**
   * Record or clear a disposition against a file in the active patchset.
   * A `disposition` type sets/replaces it; `null` clears it (the "mark unread"
   * path). Setting resolves the anchor's content digest from the active
   * patchset so the disposition can be carried across a later re-capture.
   */
  setDisposition(
    commandId: string,
    reviewId: string,
    patchsetId: string,
    path: string,
    disposition: DispositionType | null,
    body: string,
  ): Review {
    const digest = payloadDigest({ reviewId, patchsetId, path, disposition, body });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const current = this.requireReview(reviewId);
    let event: ReviewEvent;
    if (disposition === null) {
      event = { type: "DispositionCleared", version: 1, reviewId, patchsetId, path };
    } else {
      const active = current.patchsets.find((patchset) => patchset.id === current.activePatchsetId);
      const file = active?.files.find((candidate) => candidate.path === path);
      if (!file) {
        throw new Error("Cannot set a disposition on a path outside the active patchset");
      }
      const anchor: DispositionAnchor = { path, contentDigest: fileContentDigest(file) };
      event = {
        type: "DispositionSet",
        version: 1,
        reviewId,
        patchsetId,
        disposition: { anchor, type: disposition, body },
      };
    }
    return this.store.commit(commandId, digest, [event], foldReview(current, event));
  }

  async checkFreshness(
    commandId: string,
    reviewId: string,
    repositoryPath: string,
  ): Promise<Review> {
    const digest = payloadDigest({ reviewId, repositoryPath });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const current = this.requireReview(reviewId);
    const candidate = await this.capturePort.capture(repositoryPath);
    if (candidate.id === current.activePatchsetId || candidate.id === current.pendingPatchsetId) {
      return this.store.commit(commandId, digest, [], current);
    }
    const event: ReviewEvent = {
      type: "ReviewInvalidated",
      version: 1,
      reviewId,
      candidate,
    };
    return this.store.commit(commandId, digest, [event], foldReview(current, event));
  }

  async regenerate(commandId: string, reviewId: string, repositoryPath: string): Promise<Review> {
    return this.capture(commandId, repositoryPath, reviewId);
  }

  private requireReview(reviewId: string): Review {
    const review = this.store.reviewById(reviewId);
    if (!review || review.id !== reviewId) throw new Error("Review not found");
    return review;
  }
}
