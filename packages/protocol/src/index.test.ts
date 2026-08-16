import { describe, expect, it } from "vitest";
import {
  commandDefinitions,
  deltaAccountSchema,
  dispositionSchema,
  isCommandName,
  parseCommandInput,
} from "./index";

describe("command protocol", () => {
  it("rejects malformed command payloads", () => {
    expect(() =>
      parseCommandInput("review.capture", { commandId: "not-a-uuid", repoPath: "" }),
    ).toThrow();
  });

  it("accepts a valid capture command", () => {
    expect(
      parseCommandInput("review.capture", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        repoPath: "/repo",
      }),
    ).toEqual({
      commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
      repoPath: "/repo",
    });
  });

  it("accepts a disposition command with a null (clear) disposition", () => {
    expect(
      parseCommandInput("review.setDisposition", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        reviewId: "review",
        patchsetId: "patch",
        path: "a.ts",
        disposition: null,
        body: "",
      }).disposition,
    ).toBeNull();
  });

  it("rejects an unknown disposition type", () => {
    expect(() =>
      parseCommandInput("review.setDisposition", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        reviewId: "review",
        patchsetId: "patch",
        path: "a.ts",
        disposition: "merge",
        body: "",
      }),
    ).toThrow();
  });
});

describe("review.load — reopen a persisted review by id (#324)", () => {
  it("is a known command taking { commandId, reviewId }", () => {
    expect(isCommandName("review.load")).toBe(true);
    const parsed = parseCommandInput("review.load", {
      commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
      reviewId: "review-7",
    });
    expect(parsed).toEqual({
      commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
      reviewId: "review-7",
    });
  });

  it("rejects an empty reviewId", () => {
    expect(() =>
      parseCommandInput("review.load", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        reviewId: "",
      }),
    ).toThrow();
  });

  it("outputs { review, repositoryPresent }", () => {
    const output = commandDefinitions["review.load"].output;
    // repositoryPresent is required, boolean; review is the review schema.
    expect(output.safeParse({ review: null, repositoryPresent: true }).success).toBe(false);
    // A minimal valid review shape is exercised elsewhere; here we prove the boolean is required.
    expect(
      output.safeParse({
        review: {
          id: "r",
          repository: {
            id: "repo",
            root: "/repo",
            commonDir: "/repo/.git",
            baseRef: "main",
            baseOid: "b",
            headOid: "h",
          },
          patchsets: [],
          activePatchsetId: "",
          status: "active",
          dispositions: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe("span-grained disposition anchor schema (issue #78)", () => {
  const base = { type: "comment", body: "" } as const;

  it("accepts a path-grained anchor", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: { path: "a.ts", contentDigest: "d" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full span anchor", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: {
        path: "a.ts",
        contentDigest: "d",
        span: { startLine: 3, endLine: 5 },
        side: "additions",
        spanDigest: "sd",
      },
    });
    expect(result.success).toBe(true);
  });

  // Reddening: drop the all-or-none refine → this partial-anchor test reddens.
  it("rejects a partial span anchor (span without side/spanDigest)", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: { path: "a.ts", contentDigest: "d", span: { startLine: 3 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a span with endLine < startLine", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: {
        path: "a.ts",
        contentDigest: "d",
        span: { startLine: 5, endLine: 3 },
        side: "context",
        spanDigest: "sd",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("ordering is agent-owned: no user-approval command exists (issue #9)", () => {
  it("has no command that approves an ordering (structural, not a prompt)", () => {
    // The user does NOT approve the comprehension ordering (Q2, 2026-08-06).
    // "The human does not approve ordering" is a property of the wiring: the
    // command registry simply contains no such operation.
    expect(isCommandName("ordering.approve")).toBe(false);
    const orderingApproval = Object.keys(commandDefinitions).filter(
      (name) => /order/i.test(name) && /(approve|accept|confirm|dispose)/i.test(name),
    );
    expect(orderingApproval).toEqual([]);
  });
});

describe("delta account schema — hunk grain + handoff attribution round-trip (#73 wave 3)", () => {
  it("round-trips beyondAskHunks and per-ask handoffTask through the IPC schema", () => {
    const account = {
      asks: [
        {
          path: "a.ts",
          span: { startLine: 10, endLine: 11 },
          side: "additions" as const,
          type: "request-change" as const,
          summary: "Fix the loop bound",
          status: "partially-addressed" as const,
          handoffTask: { index: 2, title: "Tighten the parser" },
        },
      ],
      beyondAsks: ["d.ts"],
      beyondAskHunks: [
        {
          path: "a.ts",
          span: { startLine: 40, endLine: 41 },
          bucket: "asked-file" as const,
          excerpt: "+d",
        },
        {
          path: "d.ts",
          span: { startLine: 3 },
          side: "deletions" as const,
          bucket: "unasked-file" as const,
          excerpt: "-gone",
        },
      ],
    };
    const parsed = deltaAccountSchema.parse(account);
    expect(parsed).toEqual(account);
  });

  it("still parses a LEGACY account with no hunk-grain fields (additive-optional)", () => {
    const legacy = {
      asks: [{ path: "a.ts", type: "comment" as const, summary: "", status: "untouched" as const }],
      beyondAsks: ["d.ts"],
    };
    const parsed = deltaAccountSchema.parse(legacy);
    expect(parsed.beyondAskHunks).toBeUndefined();
    expect(parsed.asks[0]?.handoffTask).toBeUndefined();
  });
});
