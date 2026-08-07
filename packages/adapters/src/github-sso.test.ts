import { describe, expect, it } from "vitest";
import { parseGitHubSso } from "./github-sso";

describe("parseGitHubSso", () => {
  it("reports none when the header is absent", () => {
    expect(parseGitHubSso(null)).toEqual({ kind: "none" });
    expect(parseGitHubSso(undefined)).toEqual({ kind: "none" });
    expect(parseGitHubSso("")).toEqual({ kind: "none" });
  });

  it("parses a required directive with organizations and the authorization url", () => {
    const value =
      "required; organizations=ORG_1,ORG_2; url=https://github.com/orgs/acme/sso?authorization_request=abc";
    expect(parseGitHubSso(value)).toEqual({
      kind: "required",
      organizations: ["ORG_1", "ORG_2"],
      authorizationUrl: "https://github.com/orgs/acme/sso?authorization_request=abc",
    });
  });

  it("parses partial-results as a FIRST-CLASS state naming the orgs (never an empty list)", () => {
    const value =
      "partial-results; organizations=ORG_9,ORG_10; url=https://github.com/orgs/acme/sso?authorization_request=zzz";
    const state = parseGitHubSso(value);
    expect(state.kind).toBe("partial-results");
    // The banner needs the org ids and the authorization URL.
    if (state.kind !== "partial-results") throw new Error("unreachable");
    expect(state.organizations).toEqual(["ORG_9", "ORG_10"]);
    expect(state.authorizationUrl).toBe(
      "https://github.com/orgs/acme/sso?authorization_request=zzz",
    );
  });

  it("tolerates missing url and whitespace, and an unknown directive is none", () => {
    expect(parseGitHubSso("partial-results; organizations=ORG_1")).toEqual({
      kind: "partial-results",
      organizations: ["ORG_1"],
      authorizationUrl: null,
    });
    expect(parseGitHubSso("  required ; organizations = A , B ")).toEqual({
      kind: "required",
      organizations: ["A", "B"],
      authorizationUrl: null,
    });
    expect(parseGitHubSso("something-else; organizations=X")).toEqual({ kind: "none" });
  });
});
