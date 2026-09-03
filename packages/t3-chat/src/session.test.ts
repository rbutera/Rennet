import { describe, expect, it } from "vitest";
import {
  SIDECAR_CONNECTION_ID,
  sidecarRegistration,
  sidecarThreadPath,
  sidecarWsBaseUrl,
} from "./session";

const session = {
  origin: "http://127.0.0.1:43117",
  wsUrl: "ws://127.0.0.1:43117/ws",
  accessToken: "bearer-1",
  environmentId: "env-1",
  threadId: "thread-1",
};

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

  it("routes to the bound thread, or home while the daemon has not bound one", () => {
    expect(sidecarThreadPath(session)).toBe("/env-1/thread-1");
    expect(sidecarThreadPath({ environmentId: "env-1" })).toBe("/");
  });

  // T3ThreadView (t3-lens-threads 3.3) builds its initial route with the same function,
  // from a lane's thread ref rather than the session's. A seat thread id is the daemon's
  // to choose, so the two ids must stay two route segments however they are spelled.
  it("routes to a lens seat's thread, keeping an awkward id inside one route segment", () => {
    expect(sidecarThreadPath({ environmentId: "env-1", threadId: "seat/design gen-2" })).toBe(
      "/env-1/seat%2Fdesign%20gen-2",
    );
  });
});
