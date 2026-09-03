import {
  createInvocationBudget,
  type HarnessTurnResult,
  inlineContextViolation,
} from "@rennet/core";
import { DOSSIER_BODY_MAX_CHARS, serializeDossier } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  DOSSIER_TOTAL_MAX_CHARS,
  extractRefs,
  fetchGithubIssue,
  fetchPrView,
  type GhRunner,
  type JsonFetcher,
  retrieveRelatedContext,
} from "./related-context";

/** The stand-in for the dossier store's `saveCandidates`: it returns the path the seat reads. */
const CANDIDATES_PATH = "/home/rai/.rennet/projects/rennet/dossier/pr-1@ps_1/candidates.json";
const CANDIDATES_AT = (): string => CANDIDATES_PATH;

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

  it("believes an unconfigured low-signal prefix only when it repeats", () => {
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

  it("believes a single unconfigured key from a high-signal source", () => {
    const fromBranch = extractRefs({ branchName: "PROJ-42-fix-the-thing" });
    expect(fromBranch).toEqual([
      expect.objectContaining({
        kind: "tracker-key",
        key: "PROJ-42",
        tracker: "unknown",
        provenance: expect.objectContaining({ source: "branch-name" }),
      }),
    ]);
    const fromTitle = extractRefs({ prTitle: "ENG-7: ship the seam" });
    expect(fromTitle).toEqual([
      expect.objectContaining({ kind: "tracker-key", key: "ENG-7", tracker: "unknown" }),
    ]);
    // The same single key in low-signal prose stays unbelieved.
    expect(extractRefs({ prBody: "maybe PROJ-42 related" })).toEqual([]);
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

describe("retrieveRelatedContext", () => {
  const repo = { owner: "rbutera", name: "rennet" };
  const now = () => new Date("2026-08-27T12:00:00.000Z");

  const issue = (number: number, body: string, comments: string[] = []) => ({
    [`api repos/rbutera/rennet/issues/${number}/comments`]: JSON.stringify(
      comments.map((c) => ({ body: c })),
    ),
    [`api repos/rbutera/rennet/issues/${number}`]: JSON.stringify({
      title: `Issue ${number}`,
      state: "open",
      body,
      html_url: `https://github.com/rbutera/rennet/issues/${number}`,
    }),
  });

  it("fetches refs + one hop, reports failures typed, stamps provenance and fetched-at", async () => {
    const gh = canned({
      ...issue(7, "root issue; see #8 for the follow-up"),
      ...issue(8, "hop target"),
      "api repos/rbutera/rennet/issues/9/comments": new Error("HTTP 404: Not Found"),
      "api repos/rbutera/rennet/issues/9": new Error("HTTP 404: Not Found"),
    });
    const result = await retrieveRelatedContext(
      { prBody: "Fixes #7 and #9. Keys PROJ-1 and PROJ-2 pending." },
      { gh, repo, now },
    );

    const ids = result.items.map((item) => item.id).sort();
    expect(ids).toEqual(["github:rbutera/rennet#7", "github:rbutera/rennet#8"]);
    for (const item of result.items) {
      expect(item.provenance.length).toBeGreaterThan(0);
      expect(item.fetchedAt).toBe("2026-08-27T12:00:00.000Z");
      expect(item.body.length).toBeLessThanOrEqual(DOSSIER_BODY_MAX_CHARS);
    }
    const hop = result.items.find((item) => item.id === "github:rbutera/rennet#8");
    expect(hop?.provenance).toBe("link-hop");

    expect(result.failures).toEqual([
      {
        id: "github:rbutera/rennet#9",
        error: "not-found",
        detail: expect.stringContaining("404"),
      },
    ]);
    // Unconfigured (repeated, so believed) tracker prefix → typed fact, no guess.
    expect(result.missingConfig.map((fact) => [fact.prefix, fact.missing])).toEqual([
      ["PROJ", "tracker-kind"],
      ["PROJ", "tracker-kind"],
    ]);
    expect(result.enrichment.status).toBe("skipped");
    expect(result.raw.map((payload) => payload.id).sort()).toEqual(ids);
  });

  it("drops whole items, last-fetched first, when the dossier-wide bound overflows", async () => {
    // Four issues near the per-item cap: total serialized size blows the
    // aggregate bound, so the LAST-fetched items drop whole, each recorded.
    const big = "x".repeat(DOSSIER_BODY_MAX_CHARS - 100);
    const gh = canned({
      ...issue(1, big),
      ...issue(2, big),
      ...issue(3, big),
      ...issue(4, big),
    });
    const result = await retrieveRelatedContext(
      { prBody: "See #1 then #2 then #3 then #4" },
      { gh, repo, now },
    );
    const serialized = serializeDossier(result.items);
    expect(serialized.length).toBeLessThanOrEqual(DOSSIER_TOTAL_MAX_CHARS);
    expect(result.omitted.length).toBeGreaterThan(0);
    expect(result.omitted[0]).toEqual({ id: "github:rbutera/rennet#4", reason: "total-bound" });
    // The kept set is the fetch-order prefix.
    expect(result.items.map((item) => item.id)).toEqual(
      ["github:rbutera/rennet#1", "github:rbutera/rennet#2", "github:rbutera/rennet#3"].slice(
        0,
        result.items.length,
      ),
    );
  });

  it("truncates an over-bound body at the fetch edge and records it in provenance", async () => {
    const gh = canned(issue(7, "x".repeat(DOSSIER_BODY_MAX_CHARS + 500)));
    const result = await retrieveRelatedContext({ prBody: "See #7" }, { gh, repo, now });
    const item = result.items[0];
    expect(item?.body.length).toBe(DOSSIER_BODY_MAX_CHARS);
    expect(item?.provenance).toContain("truncated at fetch edge");
  });

  it("fetches a configured JIRA key via the REST seam without storing the token", async () => {
    process.env.B07_TEST_JIRA_TOKEN = "secret";
    try {
      const calls: string[] = [];
      const fetchJson: JsonFetcher = async (url, init) => {
        calls.push(url);
        expect(init.headers.Authorization).toBe("Bearer secret");
        return {
          fields: { summary: "Do the thing", status: { name: "In Progress" }, description: "body" },
        };
      };
      const result = await retrieveRelatedContext(
        { prBody: "ABC-12 covers this", branchName: "abc-12-fix" },
        {
          gh: canned({}),
          repo,
          now,
          fetchJson,
          trackerConfig: {
            jira: {
              baseUrl: "https://jira.example",
              tokenEnvVar: "B07_TEST_JIRA_TOKEN",
              projectPrefixes: ["ABC"],
            },
          },
        },
      );
      expect(calls).toEqual([
        "https://jira.example/rest/api/2/issue/ABC-12?fields=summary,status,description",
      ]);
      expect(result.items).toEqual([
        expect.objectContaining({ id: "jira:ABC-12", tracker: "jira", state: "In Progress" }),
      ]);
      expect(result.missingConfig).toEqual([]);
    } finally {
      delete process.env.B07_TEST_JIRA_TOKEN;
    }
  });

  it("reports a configured tracker with no token value as a missing-config fact", async () => {
    delete process.env.B07_TEST_JIRA_TOKEN;
    const result = await retrieveRelatedContext(
      { prBody: "ABC-12 covers this", branchName: "abc-12-fix" },
      {
        gh: canned({}),
        repo,
        now,
        trackerConfig: {
          jira: {
            baseUrl: "https://jira.example",
            tokenEnvVar: "B07_TEST_JIRA_TOKEN",
            projectPrefixes: ["ABC"],
          },
        },
      },
    );
    expect(result.items).toEqual([]);
    expect(result.missingConfig).toEqual([
      expect.objectContaining({ tracker: "jira", missing: "token-env-value" }),
    ]);
  });

  it("routes Linear refs in a Linear-only configuration", async () => {
    process.env.B07_TEST_LINEAR_TOKEN = "lin-secret";
    try {
      const fetchJson: JsonFetcher = async (_url, init) => {
        expect(init.method).toBe("POST");
        const key = (JSON.parse(init.body ?? "{}") as { variables?: { id?: string } }).variables
          ?.id;
        return {
          data: {
            issue: {
              title: `Linear ${key}`,
              description: "desc",
              url: `https://linear.app/acme/issue/${key}`,
              state: { name: "Todo" },
            },
          },
        };
      };
      const result = await retrieveRelatedContext(
        { prBody: "ENG-7 covers this", branchName: "eng-7-fix" },
        {
          gh: canned({}),
          repo,
          now,
          fetchJson,
          trackerConfig: {
            linear: {
              baseUrl: "https://api.linear.app/graphql",
              tokenEnvVar: "B07_TEST_LINEAR_TOKEN",
              projectPrefixes: ["ENG"],
            },
          },
        },
      );
      expect(result.items).toEqual([
        expect.objectContaining({ id: "linear:ENG-7", tracker: "linear" }),
      ]);
      expect(result.missingConfig).toEqual([]);
    } finally {
      delete process.env.B07_TEST_LINEAR_TOKEN;
    }
  });

  it("routes mixed JIRA + Linear keys each to their own configured endpoint", async () => {
    process.env.B07_TEST_JIRA_TOKEN = "j";
    process.env.B07_TEST_LINEAR_TOKEN = "l";
    try {
      const calls: string[] = [];
      const fetchJson: JsonFetcher = async (url, init) => {
        calls.push(`${init.method} ${url}`);
        if (init.method === "GET") {
          return { fields: { summary: "jira item", status: { name: "Open" }, description: "" } };
        }
        return {
          data: { issue: { title: "linear item", description: "", state: { name: "Todo" } } },
        };
      };
      const result = await retrieveRelatedContext(
        { prBody: "PROJ-1 plus ENG-2" },
        {
          gh: canned({}),
          repo,
          now,
          fetchJson,
          trackerConfig: {
            jira: {
              baseUrl: "https://jira.example",
              tokenEnvVar: "B07_TEST_JIRA_TOKEN",
              projectPrefixes: ["PROJ"],
            },
            linear: {
              baseUrl: "https://api.linear.app/graphql",
              tokenEnvVar: "B07_TEST_LINEAR_TOKEN",
              projectPrefixes: ["ENG"],
            },
          },
        },
      );
      expect(result.items.map((item) => item.id).sort()).toEqual(["jira:PROJ-1", "linear:ENG-2"]);
      expect(calls.sort()).toEqual([
        "GET https://jira.example/rest/api/2/issue/PROJ-1?fields=summary,status,description",
        "POST https://api.linear.app/graphql",
      ]);
    } finally {
      delete process.env.B07_TEST_JIRA_TOKEN;
      delete process.env.B07_TEST_LINEAR_TOKEN;
    }
  });

  it("follows one hop out of tracker payloads, not just GitHub bodies", async () => {
    process.env.B07_TEST_JIRA_TOKEN = "j";
    process.env.B07_TEST_LINEAR_TOKEN = "l";
    try {
      const fetchJson: JsonFetcher = async (url, init) => {
        if (init.method === "GET") {
          // The JIRA description names a GitHub issue AND a configured Linear key.
          const description = url.includes("PROJ-1")
            ? "see rbutera/rennet#7 and ENG-9 for the rest"
            : "";
          return { fields: { summary: "jira item", status: { name: "Open" }, description } };
        }
        return {
          data: { issue: { title: "linear item", description: "no more links", state: {} } },
        };
      };
      const gh = canned({
        "api repos/rbutera/rennet/issues/7/comments": JSON.stringify([]),
        "api repos/rbutera/rennet/issues/7": JSON.stringify({
          title: "Hop target",
          state: "open",
          body: "PROJ-99 would be a second hop", // must NOT be followed (one hop total)
          html_url: "https://github.com/rbutera/rennet/issues/7",
        }),
      });
      const result = await retrieveRelatedContext(
        { prBody: "PROJ-1 covers this" },
        {
          gh,
          repo: { owner: "rbutera", name: "rennet" },
          now,
          fetchJson,
          trackerConfig: {
            jira: {
              baseUrl: "https://jira.example",
              tokenEnvVar: "B07_TEST_JIRA_TOKEN",
              projectPrefixes: ["PROJ"],
            },
            linear: {
              baseUrl: "https://api.linear.app/graphql",
              tokenEnvVar: "B07_TEST_LINEAR_TOKEN",
              projectPrefixes: ["ENG"],
            },
          },
        },
      );
      expect(result.items.map((item) => item.id).sort()).toEqual([
        "github:rbutera/rennet#7",
        "jira:PROJ-1",
        "linear:ENG-9",
      ]);
      // PROJ-99 sat inside a hop-fetched body: one hop total, never followed.
      expect(result.items.some((item) => item.id.includes("PROJ-99"))).toBe(false);
    } finally {
      delete process.env.B07_TEST_JIRA_TOKEN;
      delete process.env.B07_TEST_LINEAR_TOKEN;
    }
  });

  it("applies enrichment trims, meters an exhausted budget as overage, never refuses", async () => {
    const gh = canned({ ...issue(7, "keep me"), ...issue(8, "drop me") });
    const budget = createInvocationBudget(0); // exhausted from the start
    const runTurn = async (): Promise<HarnessTurnResult> => ({
      status: "emitted",
      body: {
        items: [
          { id: "github:rbutera/rennet#7", keep: true, acceptanceCriteria: "must round-trip" },
          { id: "github:rbutera/rennet#8", keep: false },
        ],
      },
    });
    const result = await retrieveRelatedContext(
      { prBody: "See #7 and #8" },
      { gh, repo, now, runTurn, budget, writeCandidates: CANDIDATES_AT },
    );
    expect(result.enrichment).toEqual({ status: "ran", budgetGranted: false, overage: true });
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "github:rbutera/rennet#7",
        acceptanceCriteria: "must round-trip",
      }),
    ]);
  });

  it("keeps the deterministic dossier when the enrichment turn fails", async () => {
    const gh = canned(issue(7, "still here"));
    const runTurn = async (): Promise<HarnessTurnResult> => ({
      status: "failed",
      message: "seat unavailable",
    });
    const result = await retrieveRelatedContext(
      { prBody: "See #7" },
      { gh, repo, now, runTurn, writeCandidates: CANDIDATES_AT },
    );
    expect(result.enrichment).toEqual({
      status: "failed",
      reason: "seat unavailable",
      budgetGranted: true,
      overage: false,
    });
    expect(result.items.map((item) => item.id)).toEqual(["github:rbutera/rennet#7"]);
  });

  // ── session-context-files 3.8: the enrichment prompt names the dossier, never carries it ──

  it("names the candidates file and its item count, and carries no dossier JSON", async () => {
    // A body big enough that inlining it would be unmistakable in the prompt.
    const marker = "ACCEPTANCE-CRITERION-SENTINEL";
    const gh = canned({
      ...issue(7, `${marker} ${"filler ".repeat(400)}`),
      ...issue(8, `${marker} ${"filler ".repeat(400)}`),
    });
    let prompt = "";
    const runTurn = async (sent: string): Promise<HarnessTurnResult> => {
      prompt = sent;
      return { status: "emitted", body: { items: [] } };
    };
    const written: string[] = [];
    await retrieveRelatedContext(
      { prBody: "See #7 and #8" },
      {
        gh,
        repo,
        now,
        runTurn,
        writeCandidates: (items) => {
          written.push(...items.map((item) => item.id));
          return CANDIDATES_PATH;
        },
      },
    );

    // The path is named, the count is stated, and the two item bodies stayed on disk.
    expect(prompt).toContain(CANDIDATES_PATH);
    expect(prompt).toContain("2 items");
    expect(prompt).not.toContain(marker);
    expect(written.sort()).toEqual(["github:rbutera/rennet#7", "github:rbutera/rennet#8"]);
    // The mechanical reading of "never inline context": no JSON literal over 2 KB.
    expect(inlineContextViolation(prompt)).toBeUndefined();
    // A bound, not a vibe. The pre-change prompt on this fixture was over 4 KB.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(600);
  });

  it("skips the enrichment turn when no candidates path was written (the control)", async () => {
    // The CONTROL for the assertions above, executed rather than described: with the
    // write skipped there is no path to name, and the seat is not called at all —
    // so the prompt assertions cannot be passing on a prompt nobody sends.
    const gh = canned(issue(7, "keep me"));
    let called = 0;
    const runTurn = async (): Promise<HarnessTurnResult> => {
      called += 1;
      return { status: "emitted", body: { items: [] } };
    };
    const result = await retrieveRelatedContext({ prBody: "See #7" }, { gh, repo, now, runTurn });
    expect(result.enrichment).toEqual({
      status: "skipped",
      reason: "no candidate dossier path",
    });
    expect(called).toBe(0);
    // The deterministic dossier is untouched: a skipped trim is not a lost item.
    expect(result.items.map((item) => item.id)).toEqual(["github:rbutera/rennet#7"]);
  });
});
