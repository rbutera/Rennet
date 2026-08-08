import { randomUUID } from "node:crypto";

/**
 * The main-owned harness-run consent authority (bead workspace-fyvxb).
 *
 * The #58/#103 harness-run gate (bead workspace-j98dt) resolves the effective
 * permission MODE from the persisted workspace store — the load-bearing fix, and
 * unchanged here. What this module upgrades is the per-run CONSENT signal.
 *
 * Before fyvxb the signal was a renderer-supplied `consent: boolean` on the
 * `review.canvases` command: an adversarial or informed caller could simply send
 * `consent: true` (forgeable), and the same `true` worked on every run
 * (replayable). This authority makes MAIN the sole ISSUER and CONSUMER of the
 * consent signal:
 *
 *   - `grant(reviewId)` mints a fresh, unguessable nonce BOUND to that review and
 *     records it. The renderer calls this on the user's approval act (via the
 *     `harness.requestConsent` command) and receives the token; it never
 *     fabricates one.
 *   - `consume(reviewId, authorization)` verifies the token matches the stored
 *     nonce for THAT review AND has not been used, then DELETES it (single-use)
 *     and returns `true`. A missing / wrong / already-consumed token returns
 *     `false` and consumes nothing.
 *
 * So a legitimate run authorizes exactly once; a replay of the same token fails;
 * a token minted for review A cannot authorize review B; and a caller cannot
 * assert consent it never obtained from MAIN. This is defense-in-depth for the
 * vital model-spend circuit and, imminently, #21's outbound GitHub egress.
 */
export interface HarnessConsentAuthority {
  /**
   * Mint and record a fresh single-use authorization bound to `reviewId`. A new
   * grant SUPERSEDES any prior un-consumed grant for the same review (the latest
   * user approval wins; the stale token can no longer be consumed).
   */
  grant(reviewId: string): string;
  /**
   * Verify `authorization` matches the stored, un-consumed nonce for `reviewId`
   * and, if so, CONSUME it (single-use) and return `true`. Any mismatch — no
   * grant, wrong token, already consumed — returns `false` and consumes nothing,
   * so a forged attempt cannot burn a legitimately-issued token.
   */
  consume(reviewId: string, authorization: string): boolean;
}

/**
 * The in-memory implementation. Consent is per-process and intentionally NOT
 * persisted: a fresh app run must re-ask, never inherit a stale authorization
 * across restarts (that would be a replay across sessions).
 */
export function createHarnessConsentAuthority(): HarnessConsentAuthority {
  const pending = new Map<string, string>();
  return {
    grant(reviewId: string): string {
      const nonce = randomUUID();
      pending.set(reviewId, nonce);
      return nonce;
    },
    consume(reviewId: string, authorization: string): boolean {
      const expected = pending.get(reviewId);
      // Reject before consuming: an absent grant, or a token that does not match
      // the one MAIN issued for THIS review, authorizes nothing and leaves any
      // legitimate pending token intact.
      if (expected === undefined || expected !== authorization) return false;
      // Single-use: the correct token is spent on first use, so a replay of the
      // same (reviewId, authorization) finds nothing here and returns false.
      pending.delete(reviewId);
      return true;
    },
  };
}
