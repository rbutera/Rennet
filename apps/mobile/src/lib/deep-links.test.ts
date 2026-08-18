import { describe, expect, it } from "vitest";
import { parseDeepLink, parsePairingLink, resolvePushHref, routeHref } from "./deep-links";

describe("parsePairingLink (task 4.1)", () => {
  it("parses a pairing link's url, code, and name", () => {
    const offer = parsePairingLink(
      "rennet://pair?url=ws%3A%2F%2F100.84.12.9%3A9999&code=H7K2F9&name=home-mac",
    );
    expect(offer).toEqual({ url: "ws://100.84.12.9:9999", code: "H7K2F9", name: "home-mac" });
  });

  it("returns null for a non-pairing link or one missing url/code", () => {
    expect(parsePairingLink("https://example.com")).toBeNull();
    expect(parsePairingLink("rennet://pair?code=H7K2F9")).toBeNull();
    expect(parsePairingLink("rennet://review/r1/digest")).toBeNull();
  });

  it("defaults the name when absent", () => {
    expect(parsePairingLink("rennet://pair?url=ws://x&code=abc")?.name).toBe("daemon");
  });
});

describe("deep-link routing table (task 6.2)", () => {
  it("parses every review surface the taxonomy names", () => {
    expect(parseDeepLink("rennet://review/r1/digest")).toEqual({
      kind: "review",
      reviewId: "r1",
      surface: "digest",
    });
    expect(parseDeepLink("rennet://review/r1/ask")).toMatchObject({ surface: "ask" });
    expect(parseDeepLink("rennet://review/r1/error")).toMatchObject({ surface: "error" });
    expect(parseDeepLink("rennet://review/r1/publish")).toMatchObject({ surface: "publish" });
    expect(parseDeepLink("rennet://project/p1")).toEqual({ kind: "project", projectId: "p1" });
  });

  it("defaults an unknown/absent surface to the digest, never crashing", () => {
    expect(parseDeepLink("rennet://review/r1")).toMatchObject({ surface: "digest" });
    expect(parseDeepLink("rennet://review/r1/whatever")).toMatchObject({ surface: "digest" });
  });

  it("returns null for an unrecognised path", () => {
    expect(parseDeepLink("rennet://nonsense")).toBeNull();
    expect(parseDeepLink("https://example.com")).toBeNull();
  });

  it("builds daemon-scoped expo-router hrefs; M2 surfaces land on the digest", () => {
    expect(routeHref("d1", { kind: "review", reviewId: "r1", surface: "digest" })).toBe(
      "/daemon/d1/review/r1/digest",
    );
    expect(routeHref("d1", { kind: "review", reviewId: "r1", surface: "error" })).toBe(
      "/daemon/d1/review/r1/error",
    );
    // ask/publish are M2 screens → digest for now (review still reachable, no dead link).
    expect(routeHref("d1", { kind: "review", reviewId: "r1", surface: "ask" })).toBe(
      "/daemon/d1/review/r1/digest",
    );
    expect(routeHref("d1", { kind: "project", projectId: "p1" })).toBe("/daemon/d1/project/p1");
  });

  it("resolves a tapped push to an href via the device→daemon lookup", () => {
    const href = resolvePushHref(
      { deviceId: "dev-9", deepLink: "rennet://review/r1/digest", family: "review-finished" },
      (deviceId) => (deviceId === "dev-9" ? "daemon-A" : undefined),
    );
    expect(href).toBe("/daemon/daemon-A/review/r1/digest");
  });

  it("falls back (null) when the daemon is unknown, the link is missing, or unparseable", () => {
    const unknownDaemon = resolvePushHref(
      { deviceId: "dev-x", deepLink: "rennet://review/r1/digest" },
      () => undefined,
    );
    expect(unknownDaemon).toBeNull();
    expect(resolvePushHref({ family: "review-finished" }, () => "d")).toBeNull();
  });
});
