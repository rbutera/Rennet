import type { NoveltyResult } from "@rennet/core";
import { advanceNoveltyLifecycle, type NoveltyLifecycleState } from "@rennet/core";

interface RegisteredLifecycle {
  state: NoveltyLifecycleState;
  readonly refresh: () => Promise<NoveltyResult>;
}

/** In-memory lifecycle state for live reviews, advanced by the baseline watcher. */
export class NoveltyLifecycleRegistry {
  private readonly byRepo = new Map<string, Map<string, RegisteredLifecycle>>();

  register(
    repoKey: string,
    reviewId: string,
    state: NoveltyLifecycleState,
    refresh: () => Promise<NoveltyResult>,
  ): void {
    const reviews = this.byRepo.get(repoKey) ?? new Map<string, RegisteredLifecycle>();
    reviews.set(reviewId, { state, refresh });
    this.byRepo.set(repoKey, reviews);
  }

  get(repoKey: string, reviewId: string): NoveltyLifecycleState | undefined {
    return this.byRepo.get(repoKey)?.get(reviewId)?.state;
  }

  async advanceRepo(repoKey: string): Promise<void> {
    const reviews = this.byRepo.get(repoKey);
    if (!reviews) return;
    for (const registration of reviews.values()) {
      const classified = await registration.refresh();
      if (!classified.ok) continue;
      registration.state = advanceNoveltyLifecycle(registration.state, classified.ledger).next;
    }
  }
}
