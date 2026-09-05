// @vitest-environment happy-dom
import type { PatchFile, Review, SidebarSession } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { SeatTranscriptDrawer } from "../board/seat-transcript-drawer";
import { BridgeProvider } from "../data";
import { CodeDestinationProvider, useOpenCapturedPath } from "../review/code-destination";
import { memoryHistory } from "../routes/history";
import { AppLayout } from "../routes/layout";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { T3ChatDock } from "./t3-chat-dock";
import { T3ChatSlotProvider } from "./t3-chat-slot";

// ─────────────────────────────────────────────────────────────────────────────
// A file reference clicked in the T3 chat opens RENNET's Diff view.
//
// The seam is `useOpenCapturedPath`, handed to the mount as `onOpenFile` by `T3ChatDock`.
// Its RETURN VALUE is the whole design: Rennet takes the click only for a path the review
// actually captured, and answers `false` otherwise so the mount can leave T3's own file
// viewer alone. A callback that always claimed the click would silently swallow every
// reference to a file outside the patchset — the reader clicks, nothing moves, nothing
// explains why.
//
// So the fixture carries BOTH kinds of path. Against a single captured-file fixture, a
// hook that returned `true` unconditionally passes every assertion below.
//
// WHAT THIS CANNOT CATCH: it exercises the Rennet half only. That T3 routes its file
// clicks through `useRightPanelStore.openFile` — the action `packages/t3-chat`'s
// `RouteFileOpens` replaces — is a fact about the vendored app. Nothing here mounts
// ChatView, so nothing here proves the click ever arrives; only driving the app does.
//
// POSITIVE CONTROLS RUN, 2026-09-04 (each applied alone, this file run, then reverted):
//   1. `useOpenCapturedPath`'s `capturedPaths` guard dropped so it always returns true
//        → 3 failed: both tests in the first block and the dock's session opener. Worth
//          noting WHY the captured-path test fell too, since a guard that is too loose
//          "should" only break the uncaptured case: with the guard gone the hook answers
//          true before `review.load` has resolved, `openPath`'s own slug/review guard
//          then no-ops, and the URL never changes. The looser hook is not merely
//          over-permissive, it is wrong earlier.
//   2. `onOpenFile={openFileInDiff}` removed from the dock's `slot.session`
//        → 1 failed: "gives the session mount a working opener", and only that one — the
//          lens-transcript test stayed green, which is the evidence that the two mounts
//          are wired independently and each needs its own assertion.
// ─────────────────────────────────────────────────────────────────────────────

const CAPTURED = "src/auth.ts";
const UNCAPTURED = "src/never-captured.ts";

function changedFile(path: string): PatchFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `diff --git a/${path} b/${path}`,
  };
}

const REVIEW: Review = {
  id: "review-1",
  repositoryRoot: "/repo",
  activePatchsetId: "patchset-1",
  patchsets: [
    {
      id: "patchset-1",
      createdAt: "2026-09-04T00:00:00.000Z",
      repository: {
        id: "repo-1",
        root: "/repo",
        commonDir: "/repo/.git",
        baseRef: "main",
        baseOid: "base",
        headOid: "head",
      },
      files: [changedFile(CAPTURED)],
    },
  ],
} as unknown as Review;

const SESSION = {
  id: "session-1",
  projectId: "project-1",
  title: "feat/links",
  target: "your-branch",
  createdAt: 0,
  reviewId: REVIEW.id,
} as unknown as SidebarSession;

/** Surfaces the hook's callback so a test can call it directly, as the dock does. */
function Probe({ onReady }: { readonly onReady: (open: (path: string) => boolean) => void }) {
  const open = useOpenCapturedPath();
  onReady(open);
  return null;
}

function mountProbe() {
  let open: ((path: string) => boolean) | null = null;
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({ sessions: [SESSION] }),
    "review.load": () => ({ review: REVIEW, repositoryPresent: true }),
  });
  const history = memoryHistory("/s/session-1?lens=sequence");
  mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <AppLayout>
          <Probe
            onReady={(fn) => {
              open = fn;
            }}
          />
        </AppLayout>
      </Router>
    </BridgeProvider>,
  );
  return { history, get: () => open };
}

/** The hook is inert until `review.load` has answered, so wait for it to accept a path. */
async function readyProbe() {
  const probe = mountProbe();
  await waitFor(() => {
    const open = probe.get();
    expect(open).not.toBeNull();
    expect(open?.(CAPTURED)).toBe(true);
  });
  return probe;
}

describe("a file reference in the chat opens Rennet's Diff view", () => {
  it("a captured path lands on the Diff view, addressed at that file, keeping the query", async () => {
    const { history, get } = await readyProbe();
    const url = history.history.at(-1) ?? "";
    expect(url).toContain("view=diff");
    expect(url).toContain(`file=${encodeURIComponent(CAPTURED)}`);
    // The rest of the session query survives — opening a file is not a reset.
    expect(url).toContain("lens=sequence");

    // And it is a REPLACE, not a push: a file link is a move within the review, so it must
    // not stack history entries the back button then has to walk out of one by one.
    const depth = history.history.length;
    (get() as (path: string) => boolean)(CAPTURED);
    expect(history.history.length).toBe(depth);
  });

  it("an uncaptured path is refused, and says so instead of navigating nowhere", async () => {
    const { history, get } = await readyProbe();
    const open = get() as (path: string) => boolean;
    const before = history.history.at(-1);

    // The CONTRAST is the assertion: same probe, same review, one path in the patchset and
    // one not. Without the second path, a hook that always returned true would pass above.
    expect(open(UNCAPTURED)).toBe(false);
    expect(history.history.at(-1)).toBe(before);
  });
});

describe("the dock hands that callback to whatever the host mounted", () => {
  /**
   * A stand-in for `@rennet/t3-chat`'s components — app-ui may not import the real ones.
   *
   * BOTH MOUNTS, together: the dock (the session's thread, always) and the board region's
   * seat-transcript drawer (a seat's thread, when one is open). They are two mounts of the
   * same slot since #823, and the point of mounting both here is that the file-link opener
   * has to reach BOTH — a seat's transcript is where a reviewer reads what the seat read.
   */
  function mountDock(seat: { environmentId: string; threadId: string } | null) {
    const seen: { session?: unknown; thread?: unknown } = {};
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "session.list": () => ({ sessions: [SESSION] }),
      "review.load": () => ({ review: REVIEW, repositoryPresent: true }),
      "chat.t3Session": () => ({
        origin: "http://127.0.0.1:1",
        wsUrl: "ws://127.0.0.1:1",
        accessToken: "t",
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    });
    useRennetStore.setState((s) => ({
      ui: {
        ...s.ui,
        chatOpen: true,
        seatTranscript:
          seat === null
            ? null
            : { reviewId: REVIEW.id, lens: "sequence" as const, seat: "sequence", thread: seat },
      },
    }));
    const history = memoryHistory("/s/session-1");
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          {/* In production `AppLayout` supplies this provider AND mounts the dock inside
              it. Mounted here explicitly so the dock is tested in the context it really
              runs in — without it the hook is inert and every opener answers `false`,
              which is exactly what the first run of these two tests reported. */}
          <CodeDestinationProvider>
            <T3ChatSlotProvider
              session={(props) => {
                seen.session = props.onOpenFile;
                return <div data-testid="mock-session" />;
              }}
              thread={(props) => {
                seen.thread = props.onOpenFile;
                return <div data-testid="mock-thread" />;
              }}
            >
              <T3ChatDock />
              <SeatTranscriptDrawer reviewId={REVIEW.id} />
            </T3ChatSlotProvider>
          </CodeDestinationProvider>
        </Router>
      </BridgeProvider>,
    );
    return seen;
  }

  it("gives the session mount a working opener", async () => {
    const seen = mountDock(null);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="mock-session"]')).toBeTruthy(),
    );
    // Not merely "a function was passed" — the function must be the one that navigates,
    // which is checked by CALLING it. A `() => false` stub would satisfy a typeof check.
    expect(typeof seen.session).toBe("function");
    expect((seen.session as (p: string) => boolean)(CAPTURED)).toBe(true);
    expect((seen.session as (p: string) => boolean)(UNCAPTURED)).toBe(false);
  });

  it("gives a seat transcript the same opener, so a seat's file links land in Diff too", async () => {
    const seen = mountDock({ environmentId: "env-1", threadId: "thread-lens" });
    await waitFor(() => expect(document.querySelector('[data-testid="mock-thread"]')).toBeTruthy());
    expect(typeof seen.thread).toBe("function");
    expect((seen.thread as (p: string) => boolean)(CAPTURED)).toBe(true);
    // The thread view is the DRAWER's, not the dock's — the dock still holds the session's
    // own thread beside it (#823). Asserting both mounts here is what keeps this test from
    // passing over a build that put the transcript back in the dock.
    expect(document.querySelector('[data-testid="mock-session"]')).toBeTruthy();
    expect(
      document
        .querySelector('[data-kind="seat-transcript-drawer"]')
        ?.querySelector('[data-testid="mock-thread"]'),
    ).toBeTruthy();
  });
});
