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
});
