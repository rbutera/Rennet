import { describe, expect, it } from "vitest";
import { extractRefs, fetchGithubIssue, fetchPrView, type GhRunner } from "./related-context";

describe("extractRefs", () => {
  it("extracts every GitHub ref form with per-source provenance", () => {
    const refs = extractRefs({
      branchName: "fix/489-board-rebuild",
      commitMessages: ["feat: land the store (#455)", "see rbutera/whiteboard#12"],
      prTitle: "B07 related context",
      prBody: "Closes #461. Context at https://github.com/rbutera/rennet/issues/476.",
    });
    expect(refs).toEqual([
      {
        kind: "github",
        number: 455,
        provenance: { source: "commit-message", match: "#455" },
      },
      {
        kind: "github",
        repo: { owner: "rbutera", name: "whiteboard" },
        number: 12,
        provenance: { source: "commit-message", match: "rbutera/whiteboard#12" },
      },
      {
        kind: "github",
        repo: { owner: "rbutera", name: "rennet" },
        number: 476,
        provenance: {
          source: "pr-body",
          match: "github.com/rbutera/rennet/issues/476",
        },
      },
      {
        kind: "github",
        number: 461,
        provenance: { source: "pr-body", match: "#461" },
      },
    ]);
  });

  it("dedups repeats keeping first-seen provenance", () => {
    const refs = extractRefs({
      branchName: "feat/123-thing",
      commitMessages: ["fix #123", "more on #123"],
      prBody: "wraps up #123",
    });
    const github = refs.filter((r) => r.kind === "github");
    expect(github).toHaveLength(1);
    expect(github[0]?.provenance).toEqual({ source: "commit-message", match: "#123" });
  });

  it("types tracker keys by configured prefix", () => {
    const refs = extractRefs(
      { prBody: "Fixes PROJ-42 and ENG-7." },
      { jiraPrefixes: ["proj"], linearPrefixes: ["ENG"] },
    );
    expect(refs).toEqual([
      expect.objectContaining({ kind: "tracker-key", key: "PROJ-42", tracker: "jira" }),
      expect.objectContaining({ kind: "tracker-key", key: "ENG-7", tracker: "linear" }),
    ]);
  });

  it("believes an unconfigured prefix only when it repeats", () => {
    const refs = extractRefs({
      commitMessages: ["touch UTF-8 handling", "ACME-1 groundwork"],
      prBody: "finishes ACME-2",
    });
    expect(refs).toEqual([
      expect.objectContaining({ key: "ACME-1", tracker: "unknown" }),
      expect.objectContaining({ key: "ACME-2", tracker: "unknown" }),
    ]);
    expect(refs.some((r) => r.kind === "tracker-key" && r.prefix === "UTF")).toBe(false);
  });

  it("yields nothing from empty input", () => {
    expect(extractRefs({})).toEqual([]);
  });
});

const canned =
  (responses: Record<string, string | Error>): GhRunner =>
  (args) => {
    const key = args.join(" ");
    const hit = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
    if (!hit) throw new Error(`unexpected gh call: ${key}`);
    const [, value] = hit;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };

describe("fetchGithubIssue", () => {
  const repo = { owner: "rbutera", name: "rennet" };

  it("returns the issue with its comment thread", async () => {
    const gh = canned({
      "api repos/rbutera/rennet/issues/461/comments": JSON.stringify([
        { body: "first" },
        { body: null },
      ]),
      "api repos/rbutera/rennet/issues/461": JSON.stringify({
        title: "Related context",
        state: "open",
        body: "the decision",
        html_url: "https://github.com/rbutera/rennet/issues/461",
      }),
    });
    const result = await fetchGithubIssue(gh, repo, 461);
    expect(result).toEqual({
      ok: true,
      value: {
        repo,
        number: 461,
        title: "Related context",
        state: "open",
        body: "the decision",
        comments: ["first", ""],
        url: "https://github.com/rbutera/rennet/issues/461",
      },
    });
  });

  it("maps a 404 to a typed not-found", async () => {
    const gh = canned({ api: new Error("HTTP 404: Not Found (repos/x/y/issues/9)") });
    const result = await fetchGithubIssue(gh, repo, 9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not-found");
  });

  it("maps a timeout to a typed unreachable", async () => {
    const timeout = Object.assign(new Error("Command timed out"), { timedOut: true });
    const gh = canned({ api: timeout });
    const result = await fetchGithubIssue(gh, repo, 9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unreachable");
  });

  it("maps garbage JSON to a typed invalid, never a throw", async () => {
    const gh = canned({ api: "<!doctype html>" });
    const result = await fetchGithubIssue(gh, repo, 9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid");
  });
});

describe("fetchPrView", () => {
  it("returns title, body, and comment bodies", async () => {
    const gh = canned({
      "pr view 512": JSON.stringify({
        number: 512,
        title: "B04 boards runtime",
        body: "the runtime",
        comments: [{ body: "lgtm" }],
      }),
    });
    const result = await fetchPrView(gh, 512);
    expect(result).toEqual({
      ok: true,
      value: { number: 512, title: "B04 boards runtime", body: "the runtime", comments: ["lgtm"] },
    });
  });

  it("propagates failure as a typed result", async () => {
    const gh = canned({ "pr view": new Error("no pull requests found") });
    const result = await fetchPrView(gh, 99);
    expect(result.ok).toBe(false);
  });
});
