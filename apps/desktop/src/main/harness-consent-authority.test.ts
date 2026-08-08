import { describe, expect, it } from "vitest";
import { createHarnessConsentAuthority } from "./harness-consent-authority";

describe("HarnessConsentAuthority (bead workspace-fyvxb)", () => {
  it("grants an unguessable token that consumes exactly once (single-use)", () => {
    const authority = createHarnessConsentAuthority();
    const token = authority.grant("review-1");

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    // First consume succeeds…
    expect(authority.consume("review-1", token)).toBe(true);
    // …and the token is spent: a replay of the same (review, token) fails.
    expect(authority.consume("review-1", token)).toBe(false);
  });

  it("rejects a forged token (one it never minted) without consuming the real one", () => {
    const authority = createHarnessConsentAuthority();
    const real = authority.grant("review-1");

    // A caller-fabricated token authorizes nothing…
    expect(authority.consume("review-1", "forged")).toBe(false);
    // …and does NOT burn the legitimately-issued token, which still works once.
    expect(authority.consume("review-1", real)).toBe(true);
  });

  it("is review-BOUND: a token minted for one review does not authorize another", () => {
    const authority = createHarnessConsentAuthority();
    const tokenA = authority.grant("review-A");

    // Wrong review id → rejected, and review-A's token remains unspent.
    expect(authority.consume("review-B", tokenA)).toBe(false);
    expect(authority.consume("review-A", tokenA)).toBe(true);
  });

  it("rejects a consume when no grant exists for the review", () => {
    const authority = createHarnessConsentAuthority();
    expect(authority.consume("never-granted", "anything")).toBe(false);
  });

  it("mints distinct tokens across grants and reviews", () => {
    const authority = createHarnessConsentAuthority();
    const a1 = authority.grant("review-1");
    const a2 = authority.grant("review-2");
    // A re-grant supersedes the prior token for the SAME review.
    const a1b = authority.grant("review-1");

    expect(new Set([a1, a2, a1b]).size).toBe(3);
    // The superseded token no longer authorizes; the fresh one does.
    expect(authority.consume("review-1", a1)).toBe(false);
    expect(authority.consume("review-1", a1b)).toBe(true);
  });
});
