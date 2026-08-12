import type { NoveltyResult } from "@rennet/core";
import { advanceNoveltyLifecycle, type NoveltyLifecycleState } from "@rennet/core";

interface RegisteredLifecycle {
  state: NoveltyLifecycleState;
  lastAdvance?: ReturnType<typeof advanceNoveltyLifecycle>;
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

  getLastAdvance(
    repoKey: string,
    reviewId: string,
  ): ReturnType<typeof advanceNoveltyLifecycle> | undefined {
    return this.byRepo.get(repoKey)?.get(reviewId)?.lastAdvance;
  }

  async advanceRepo(repoKey: string): Promise<void> {
    const reviews = this.byRepo.get(repoKey);
    if (!reviews) return;
    for (const registration of reviews.values()) {
      const classified = await registration.refresh();
      if (!classified.ok) continue;
      const advance = advanceNoveltyLifecycle(registration.state, classified.ledger);
      registration.lastAdvance = advance;
      registration.state = advance.next;
    }
  }
}
