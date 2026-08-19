// Per-review ask drafts (issue #382 M2, task 2.1). The free-text direction the reviewer is
// composing on the ask/turn screen persists per review across navigation, so leaving and coming
// back does not lose a half-typed answer. Drafts are not secrets (they are the reviewer's own
// words to their own daemon) so async storage is the right home; the backend is INJECTED, so the
// logic unit-tests with a stub and this file imports no native module (real wiring: stores/native.ts).

import type { AsyncStorageBackend } from "./replica-store";

const keyFor = (reviewId: string): string => `rennet.askdraft.${reviewId}`;

export class AskDraftStore {
  constructor(private readonly backend: AsyncStorageBackend) {}

  /** Load the persisted direction draft for a review, or "" if none. */
  async load(reviewId: string): Promise<string> {
    return (await this.backend.getItem(keyFor(reviewId))) ?? "";
  }

  /** Save (or, on empty, clear) the direction draft for a review. */
  async save(reviewId: string, direction: string): Promise<void> {
    // An empty draft is cleared rather than stored, so a sent/abandoned answer leaves no ghost.
    await this.backend.setItem(keyFor(reviewId), direction);
  }
}
