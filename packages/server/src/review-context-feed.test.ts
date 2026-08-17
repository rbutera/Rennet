import type { ContextManifest, ContextSendRecord } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { createReviewContextFeed, runWithReviewContextFeed } from "./review-context-feed";

const manifest: ContextManifest = {
  repoRecordId: "repo",
  projectSnapshotId: "snapshot",
  compositionDigest: "composition",
  freshness: { status: "current", staleMembers: [] },
  assembledPromptDigest: "digest",
  totalBytes: 7,
  exhaustive: false,
  documents: [],
  members: [],
  unmanagedSources: ["ambient"],
};

const send: ContextSendRecord = {
  seat: "decomposition",
  harness: "claude-code",
  channel: "prompt",
  attempt: 0,
  promptBytes: 123,
  promptDigest: "prompt-digest",
  contextIncluded: true,
  contextDigest: "digest",
  sentAt: "2026-08-15T00:00:00.000Z",
};

describe("createReviewContextFeed — desktop run transcript", () => {
  it("ensures once, exposes the verified text, and appends all sends once at completion", async () => {
    const ensure = vi.fn().mockResolvedValue({ manifest, text: "context" });
    const append = vi.fn();
    const feed = await createReviewContextFeed({ ensure, append });

    feed.onSend(send);
    feed.onSend({ ...send, seat: "ordering", harness: "codex" });
    const completed = feed.complete();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(feed.assembledContext).toBe("context");
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith([send, { ...send, seat: "ordering", harness: "codex" }]);
    expect(completed?.sends).toEqual([send, { ...send, seat: "ordering", harness: "codex" }]);
  });

  it("degrades an empty or failed capture to an unfed run without throwing", async () => {
    const captureErrors: unknown[] = [];
    const missing = await createReviewContextFeed({
      ensure: () => Promise.resolve(undefined),
      append: vi.fn(),
    });
    const failed = await createReviewContextFeed({
      ensure: () => Promise.reject(new Error("capture failed")),
      append: vi.fn(),
      onError: (error) => captureErrors.push(error),
    });

    expect(missing.assembledContext).toBeUndefined();
    expect(failed.assembledContext).toBeUndefined();
    expect(() => missing.complete()).not.toThrow();
    expect(() => failed.complete()).not.toThrow();
    expect(captureErrors).toHaveLength(1);
  });

  it("reports append failure without changing the completed in-memory transcript", async () => {
    const errors: unknown[] = [];
    const feed = await createReviewContextFeed({
      ensure: () => Promise.resolve({ manifest, text: "context" }),
      append: () => {
        throw new Error("disk full");
      },
      onError: (error) => errors.push(error),
    });
    const completed = await runWithReviewContextFeed(feed, async () => {
      feed.onSend(send);
      return "review result";
    });

    expect(completed.result).toBe("review result");
    expect(completed.contextManifest?.sends).toEqual([send]);
    expect(errors).toHaveLength(1);
  });

  it("persists finding sends when flagged-review verification throws later", async () => {
    const append = vi.fn();
    const feed = await createReviewContextFeed({
      ensure: () => Promise.resolve({ manifest, text: "context" }),
      append,
    });

    await expect(
      runWithReviewContextFeed(feed, async () => {
        feed.onSend({ ...send, seat: "finding" });
        throw new Error("verification createSession failed");
      }),
    ).rejects.toThrow("verification createSession failed");

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith([{ ...send, seat: "finding" }]);
  });
});
