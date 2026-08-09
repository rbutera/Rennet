import { describe, expect, it } from "vitest";
import { parseGitHubPrRef } from "./github-pr-ref";

describe("parseGitHubPrRef", () => {
  it("parses the owner/repo#number shorthand", () => {
    expect(parseGitHubPrRef("rbutera/rennet#42")).toEqual({
      repo: { forge: "github", owner: "rbutera", name: "rennet" },
      number: 42,
    });
  });

  it("tolerates whitespace around the # and trims", () => {
    expect(parseGitHubPrRef("  rbutera/rennet # 7 ")).toEqual({
      repo: { forge: "github", owner: "rbutera", name: "rennet" },
      number: 7,
    });
  });

  it("parses a full GitHub PR URL and ignores trailing path + query", () => {
    expect(parseGitHubPrRef("https://github.com/rbutera/rennet/pull/129/files?w=1")).toEqual({
      repo: { forge: "github", owner: "rbutera", name: "rennet" },
      number: 129,
    });
  });

  it("strips a .git suffix from the repo name", () => {
    expect(parseGitHubPrRef("acme/widget.git#3")?.repo.name).toBe("widget");
  });

  it("rejects non-github hosts, junk, and non-positive numbers", () => {
    expect(parseGitHubPrRef("https://gitlab.com/a/b/pull/1")).toBeNull();
    expect(parseGitHubPrRef("not a ref")).toBeNull();
    expect(parseGitHubPrRef("owner/repo#0")).toBeNull();
    expect(parseGitHubPrRef("owner/repo#-1")).toBeNull();
    expect(parseGitHubPrRef("")).toBeNull();
  });
});
