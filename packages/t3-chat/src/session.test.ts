import { describe, expect, it } from "vitest";
import {
  resolvePinnedThreadView,
  SIDECAR_CONNECTION_ID,
  type SidecarSession,
  sidecarRegistration,
  sidecarSessionPath,
  sidecarThreadPath,
  sidecarWsBaseUrl,
} from "./session";

const session = {
  origin: "http://127.0.0.1:43117",
  wsUrl: "ws://127.0.0.1:43117/ws",
  accessToken: "bearer-1",
  environmentId: "env-1",
  thread: { status: "bound", threadId: "thread-1", threadUrl: "http://x/env-1/thread-1" },
} as const;

describe("the sidecar session as a T3 environment registration", () => {
  it("registers a bearer environment at the brokered origin under one stable connection id", () => {
    const registration = sidecarRegistration(session);
    expect(registration._tag).toBe("BearerConnectionRegistration");
    expect(registration.target.environmentId).toBe("env-1");
    expect(registration.target.connectionId).toBe(SIDECAR_CONNECTION_ID);
    expect(registration.profile.httpBaseUrl).toBe("http://127.0.0.1:43117");
    // T3's resolver appends `/ws` and the ticket; a base that already carries the path
    // would double it.
    expect(registration.profile.wsBaseUrl).toBe("ws://127.0.0.1:43117");
    expect(registration.credential.token).toBe("bearer-1");
  });

  it("strips the path from the websocket URL and keeps the scheme", () => {
    expect(sidecarWsBaseUrl({ wsUrl: "wss://host.example:8443/ws" })).toBe(
      "wss://host.example:8443",
    );
  });

  it("routes to the bound thread, and home only when the daemon said it could not bind one", () => {
    expect(sidecarSessionPath(session)).toBe("/env-1/thread-1");
    expect(
      sidecarSessionPath({
        ...session,
        thread: { status: "unavailable", reason: "the workspace no longer exists" },
      }),
    ).toBe("/");
    // No review was named, so no thread was asked for. Also home.
    const noReview: SidecarSession = {
      origin: session.origin,
      wsUrl: session.wsUrl,
      accessToken: session.accessToken,
      environmentId: session.environmentId,
    };
    expect(sidecarSessionPath(noReview)).toBe("/");
  });

  // T3ThreadView (t3-lens-threads 3.3) builds its initial route with `sidecarThreadPath`,
  // from a lane's thread ref rather than the session's. A seat thread id is the daemon's
  // to choose, so the two ids must stay two route segments however they are spelled.
  it("routes to a lens seat's thread, keeping an awkward id inside one route segment", () => {
    expect(sidecarThreadPath({ environmentId: "env-1", threadId: "seat/design gen-2" })).toBe(
      "/env-1/seat%2Fdesign%20gen-2",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #872: the state the mount's thread route rests in.
//
// THE FIXTURES BELOW ARE WRITTEN FROM WHAT THE DAEMON PUBLISHES, not from what the route
// expects. The one that matters is the third: bootstrap COMPLETE, no shell, no detail,
// nothing deleted — a thread the daemon created seconds ago that the environment snapshot
// has not caught up with. That is the exact shape the old route treated as "this thread
// does not exist, go home", and going home was one-way (`FollowPath` re-asserts only when
// the path changes), so the dock rested on "Opening this review's thread" for the life of
// the session. A fixture that only ever held a settled thread would have passed then too.
//
// WHAT THESE CANNOT CATCH: they are a decision, not a router. Nothing here proves the route
// component calls this function, nor that `FollowPath` still points at the same path — the
// wiring lives in `native-chat.tsx`, which imports the vendored web app through the `~/`
// alias only the desktop Vite configs define, so it cannot be imported here.
// ─────────────────────────────────────────────────────────────────────────────

const arrived = {
  bootstrapComplete: true,
  detailExists: true,
  draftExists: false,
  shellExists: true,
  deleted: false,
};

describe("the pinned thread's view never says go home", () => {
  it("shows the chat once the thread's detail is here", () => {
    expect(resolvePinnedThreadView(arrived)).toBe("chat");
  });

  it("shows the chat off the shell alone, before the detail lands", () => {
    expect(resolvePinnedThreadView({ ...arrived, detailExists: false })).toBe("chat");
  });

  it("waits — it does not bounce — for a thread the snapshot has not delivered yet", () => {
    // The daemon made this thread and handed the dock its id; the environment snapshot
    // simply predates it. Every input says "absent" and the answer is still a wait.
    expect(
      resolvePinnedThreadView({
        bootstrapComplete: true,
        detailExists: false,
        draftExists: false,
        shellExists: false,
        deleted: false,
      }),
    ).toBe("syncing");
  });

  it("says the thread is gone only when the sidecar positively says deleted", () => {
    expect(resolvePinnedThreadView({ ...arrived, detailExists: false, deleted: true })).toBe(
      "gone",
    );
    // Deleted is a POSITIVE contradiction; before the snapshot arrives there is no
    // contradiction to read, so the same flag is still a wait.
    expect(
      resolvePinnedThreadView({
        bootstrapComplete: false,
        detailExists: false,
        draftExists: false,
        shellExists: false,
        deleted: true,
      }),
    ).toBe("syncing");
  });

  it("never answers with a state that leaves the pinned thread", () => {
    // Every combination of the five inputs, exhaustively: no input pattern produces an
    // answer outside these three. The old route had a fourth ("go to the thread list")
    // and that is the one this pins out of existence, rather than pinning one path.
    const flags = [false, true];
    const answers = new Set<string>();
    for (const bootstrapComplete of flags)
      for (const detailExists of flags)
        for (const draftExists of flags)
          for (const shellExists of flags)
            for (const deleted of flags)
              answers.add(
                resolvePinnedThreadView({
                  bootstrapComplete,
                  detailExists,
                  draftExists,
                  shellExists,
                  deleted,
                }),
              );
    expect([...answers].sort()).toEqual(["chat", "gone", "syncing"]);
  });
});
