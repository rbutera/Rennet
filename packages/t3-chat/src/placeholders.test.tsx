import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionsNotice, ThreadOpeningNotice, ThreadSyncingNotice } from "./placeholders";

// ─────────────────────────────────────────────────────────────────────────────
// The words a reviewer reads in the chat dock while the thread is on its way (#849).
//
// These are RENDERED, not read out of the source file, because the defect was a rendered
// sentence: the dock showed "No thread is bound to this review yet." over a review whose
// thread was simply not made yet, and that reads as a dead end. The assertion below is on
// the markup React actually produces for the route component `native-chat.tsx` mounts.
//
// WHAT THIS CANNOT CATCH, and it is the same shape as the sentence it replaced: nothing
// here stops someone writing a NEW flat statement of absence in different words. "There is
// no thread here." would pass every assertion below except the literal-text one, and if
// the literal text were updated alongside it, it would pass all of them. An assertion can
// hold a specific sentence; it cannot hold a register. Only a reader can.
//
// It also cannot catch a route that stops rendering these at all — the mapping from route
// to component lives in `native-chat.tsx`, which imports the vendored web app through the
// `~/` alias that only the desktop Vite configs define, so it is not importable here.
// ─────────────────────────────────────────────────────────────────────────────

describe("chat placeholders: every one of them is a wait, not an absence", () => {
  it("tells the reviewer the thread is being opened and that it will appear", () => {
    const html = renderToStaticMarkup(<ThreadOpeningNotice />);
    expect(html).toContain(
      "Opening this review&#x27;s thread. It appears here as soon as the T3 Code sidecar has it.",
    );
    // The slot the dock's stylesheet and any later reader address it by.
    expect(html).toContain('data-slot="t3-native-home"');
  });

  it("never states a bare absence in the place a thread is expected", () => {
    const html = renderToStaticMarkup(<ThreadOpeningNotice />);
    // The exact sentence #849 was filed about, and the two words that carried its lie.
    expect(html).not.toContain("No thread is bound");
    expect(html.toLowerCase()).not.toMatch(/\bno thread\b/);
  });

  it("keeps the syncing and connections notices distinct from the opening one", () => {
    const opening = renderToStaticMarkup(<ThreadOpeningNotice />);
    const syncing = renderToStaticMarkup(<ThreadSyncingNotice />);
    const connections = renderToStaticMarkup(<ConnectionsNotice />);
    // Three states, three sentences: a reviewer who sees one must be able to tell which.
    expect(new Set([opening, syncing, connections]).size).toBe(3);
    expect(syncing).toContain("Connecting to the T3 Code sidecar");
    expect(connections).toContain("managed by the Rennet daemon");
  });
});
