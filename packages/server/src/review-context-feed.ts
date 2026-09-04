import type { ContextManifest, ContextSendRecord } from "@rennet/protocol";

export interface ReviewContextFeedDeps {
  ensure(): Promise<{ readonly manifest: ContextManifest; readonly text: string } | undefined>;
  append(records: readonly ContextSendRecord[]): void;
  readonly onError?: (error: unknown) => void;
}

export interface ReviewContextFeed {
  readonly assembledContext?: string;
  readonly onSend: (record: ContextSendRecord) => void;
  complete(): ContextManifest | undefined;
}

export async function runWithReviewContextFeed<T>(
  feed: ReviewContextFeed,
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly contextManifest?: ContextManifest }> {
  let result!: T;
  let contextManifest: ContextManifest | undefined;
  try {
    result = await run();
  } finally {
    contextManifest = feed.complete();
  }
  return { result, ...(contextManifest ? { contextManifest } : {}) };
}

export async function createReviewContextFeed(
  deps: ReviewContextFeedDeps,
): Promise<ReviewContextFeed> {
  let ensured: Awaited<ReturnType<ReviewContextFeedDeps["ensure"]>>;
  try {
    ensured = await deps.ensure();
  } catch (error) {
    deps.onError?.(error);
  }

  const sends: ContextSendRecord[] = [];
  let completed = false;
  let completedManifest: ContextManifest | undefined;

  return {
    ...(ensured ? { assembledContext: ensured.text } : {}),
    onSend(record) {
      sends.push(record);
    },
    complete() {
      if (completed) return completedManifest;
      completed = true;
      if (!ensured) return undefined;

      completedManifest = {
        ...ensured.manifest,
        ...(sends.length === 0 ? {} : { sends: [...(ensured.manifest.sends ?? []), ...sends] }),
      };
      try {
        deps.append(sends);
      } catch (error) {
        deps.onError?.(error);
      }
      return completedManifest;
    },
  };
}
