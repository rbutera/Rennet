import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChatFailureNotice,
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
// that a settled absence is allowed to say so without exposing internal diagnostics.
//
// WHAT THIS CANNOT CATCH: nothing here stops someone writing a new sentence in the wrong
// register, and nothing here proves which route renders which component — that mapping is
// in `native-chat.tsx`, which imports the vendored web app through the `~/` alias that only
// the desktop Vite configs define, so it is not importable in this package's tests.
// ─────────────────────────────────────────────────────────────────────────────

describe("chat placeholders: each one says which state it is, and does not overclaim", () => {
  it("does not render a route failure's engine name, path or stack", () => {
    const html = renderToStaticMarkup(
      <ChatFailureNotice
        error={new Error("T3 Code: vendor/t3code/bin.mjs")}
        reset={() => undefined}
      />,
    );
    expect(html).toContain("Try again");
    expect(html).not.toMatch(/T3 Code|vendor\/t3code|bin\.mjs/);
  });
  it("states the absence flatly, and promises nothing, when no thread is coming", () => {
    const html = renderToStaticMarkup(<ThreadUnavailableNotice />);
    expect(html).toContain("This review has no thread, and none is being opened.");
    // The sentence #849 wrote, which #872 found could stay on screen for ten minutes.
    expect(html).not.toContain("Opening this review");
    expect(html).not.toContain("as soon as");
    // The slot the dock's stylesheet and any later reader address it by.
    expect(html).toContain('data-slot="t3-native-home"');
  });

  it("keeps raw engine failures out of the rendered notice", () => {
    const withReason = renderToStaticMarkup(
      <ThreadUnavailableNotice reason="T3 Code failed at vendor/t3code/apps/server/dist/bin.mjs" />,
    );
    expect(withReason).toContain(
      "Rennet could not open chat. Try closing and opening this review again.",
    );
    expect(renderToStaticMarkup(<ThreadUnavailableNotice />)).not.toContain(
      "Rennet could not open chat",
    );
    expect(withReason).not.toMatch(/T3 Code|vendor\/t3code|bin\.mjs/);
  });

  it("keeps a settled absence and a live wait as different states", () => {
    const unavailable = renderToStaticMarkup(<ThreadUnavailableNotice />);
    const gone = renderToStaticMarkup(<ThreadGoneNotice />);
    const syncing = renderToStaticMarkup(<ThreadSyncingNotice />);
    const connections = renderToStaticMarkup(<ConnectionsNotice />);
    // Four states, four renders: a reviewer who sees one must be able to tell which.
    expect(new Set([unavailable, gone, syncing, connections]).size).toBe(4);
    // The settled ones name an ending in words; the live wait is a skeleton, and carries its
    // wait in an sr-only label rather than a sentence the reviewer has to parse.
    expect(gone).toContain("no longer available");
    expect(gone).toContain("Nothing is being written to it");
    expect(syncing).toContain('data-slot="t3-native-syncing"');
    expect(syncing).toContain("animate-pulse");
    expect(syncing).toContain('aria-label="Connecting to chat"');
    // A wait is not a settled sentence: the skeleton must not read as one.
    expect(syncing).not.toContain("no longer");
    expect(connections).toContain("managed in Rennet Settings");
  });

  it("never tells a reviewer something is on its way in a state where nothing is", () => {
    for (const html of [
      renderToStaticMarkup(<ThreadUnavailableNotice reason="boom" />),
      renderToStaticMarkup(<ThreadGoneNotice />),
    ]) {
      expect(html).not.toMatch(/appears here|on its way|shortly|as soon as/i);
    }
  });
});
