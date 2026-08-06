import { createHash } from "node:crypto";
import type { Patchset, Review } from "@rennet/types";
import { v7 as uuidv7 } from "uuid";

export type ReviewEvent =
  | { type: "ReviewCreated"; version: 1; reviewId: string; patchset: Patchset }
  | { type: "PatchsetActivated"; version: 1; reviewId: string; patchset: Patchset }
  | {
      type: "FileReadSet";
      version: 1;
      reviewId: string;
      patchsetId: string;
      path: string;
      read: boolean;
    }
  | { type: "ReviewInvalidated"; version: 1; reviewId: string; candidate: Patchset };

export interface PatchsetCapturePort {
  capture(repositoryPath: string): Promise<Patchset>;
}

export interface ReviewStorePort {
  latestReview(): Review | null;
  receipt(commandId: string, digest: string): Review | null;
  commit(commandId: string, digest: string, events: ReviewEvent[], result: Review): Review;
}

function exhaustive(value: never): never {
  throw new Error(`Unknown review event: ${JSON.stringify(value)}`);
}

export function foldReview(current: Review | null, event: ReviewEvent): Review {
  switch (event.type) {
    case "ReviewCreated":
      return {
        id: event.reviewId,
        repositoryRoot: event.patchset.repository.root,
        patchsets: [event.patchset],
        activePatchsetId: event.patchset.id,
        readPaths: [],
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
        readPaths: [],
        status: "current",
      };
    }
    case "FileReadSet": {
      if (
        !current ||
        current.id !== event.reviewId ||
        current.activePatchsetId !== event.patchsetId
      ) {
        throw new Error("Read state must target the active patchset");
      }
      const readPaths = new Set(current.readPaths);
      if (event.read) readPaths.add(event.path);
      else readPaths.delete(event.path);
      return { ...current, readPaths: [...readPaths].sort() };
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
    const current = this.store.latestReview();
    const event: ReviewEvent =
      current && current.id === reviewId
        ? { type: "PatchsetActivated", version: 1, reviewId: current.id, patchset }
        : { type: "ReviewCreated", version: 1, reviewId: uuidv7(), patchset };
    const review = foldReview(current && event.type !== "ReviewCreated" ? current : null, event);
    return this.store.commit(commandId, digest, [event], review);
  }

  setFileRead(
    commandId: string,
    reviewId: string,
    patchsetId: string,
    path: string,
    read: boolean,
  ): Review {
    const digest = payloadDigest({ reviewId, patchsetId, path, read });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const current = this.requireReview(reviewId);
    const event: ReviewEvent = {
      type: "FileReadSet",
      version: 1,
      reviewId,
      patchsetId,
      path,
      read,
    };
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
    const review = this.store.latestReview();
    if (!review || review.id !== reviewId) throw new Error("Review not found");
    return review;
  }
}
