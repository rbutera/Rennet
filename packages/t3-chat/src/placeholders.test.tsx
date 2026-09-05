import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConnectionsNotice,
  ThreadGoneNotice,
  ThreadSyncingNotice,
  ThreadUnavailableNotice,
} from "./placeholders";

// ─────────────────────────────────────────────────────────────────────────────
// The words a reviewer reads in the chat dock when the router is not on a live thread.
//
// These are RENDERED, not read out of the source file, because the defect has twice been a
// rendered sentence. #849 replaced "No thread is bound to this review yet." — a dead end —
// with a sentence about a thread on its way. #872 is the correction to THAT: the mount had
// a way to reach the home route with nothing coming (the thread route redirected here off
// a snapshot lag, one-way), and the promise stayed on screen for the whole session.
//
// So the rule these assertions hold is no longer "always phrase it as a wait". #849's rule
// produced #872's bug. The rule is that a reviewer can tell WHICH state they are in, and
// that a settled absence is allowed to say so — with the daemon's reason attached, which is
// the part a reworded sentence could never have supplied.
//
// WHAT THIS CANNOT CATCH: nothing here stops someone writing a new sentence in the wrong
// register, and nothing here proves which route renders which component — that mapping is
// in `native-chat.tsx`, which imports the vendored web app through the `~/` alias that only
// the desktop Vite configs define, so it is not importable in this package's tests.
// ─────────────────────────────────────────────────────────────────────────────

describe("chat placeholders: each one says which state it is, and does not overclaim", () => {
  it("states the absence flatly, and promises nothing, when no thread is coming", () => {
    const html = renderToStaticMarkup(<ThreadUnavailableNotice />);
    expect(html).toContain("This review has no thread, and none is being opened.");
    // The sentence #849 wrote, which #872 found could stay on screen for ten minutes.
    expect(html).not.toContain("Opening this review");
    expect(html).not.toContain("as soon as");
    // The slot the dock's stylesheet and any later reader address it by.
    expect(html).toContain('data-slot="t3-native-home"');
  });

  it("carries the daemon's own reason when it has one, and no dangling clause when it does not", () => {
    const withReason = renderToStaticMarkup(
      <ThreadUnavailableNotice reason="The workspace this session is bound to no longer exists: /gone" />,
    );
    expect(withReason).toContain(
      "Rennet could not open one: The workspace this session is bound to no longer exists: /gone",
    );
    expect(renderToStaticMarkup(<ThreadUnavailableNotice />)).not.toContain(
      "Rennet could not open one",
    );
  });

  it("keeps a settled absence and a live wait as different sentences", () => {
    const unavailable = renderToStaticMarkup(<ThreadUnavailableNotice />);
    const gone = renderToStaticMarkup(<ThreadGoneNotice />);
    const syncing = renderToStaticMarkup(<ThreadSyncingNotice />);
    const connections = renderToStaticMarkup(<ConnectionsNotice />);
    // Four states, four sentences: a reviewer who sees one must be able to tell which.
    expect(new Set([unavailable, gone, syncing, connections]).size).toBe(4);
    // The two that are settled name an ending; the one that is a wait names the wait.
    expect(gone).toContain("no longer in the T3 Code sidecar");
    expect(gone).toContain("Nothing is being written to it");
    expect(syncing).toContain("Connecting to the T3 Code sidecar");
    expect(connections).toContain("managed by the Rennet daemon");
  });

  it("never tells a reviewer something is on its way in a state where nothing is", () => {
    for (const html of [
      renderToStaticMarkup(<ThreadUnavailableNotice reason="boom" />),
      renderToStaticMarkup(<ThreadGoneNotice />),
    ]) {
      expect(html).not.toMatch(/appears here|on its way|opening|shortly|as soon as/i);
    }
  });
});
