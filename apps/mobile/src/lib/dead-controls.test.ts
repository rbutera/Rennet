// Absent-not-disabled, enforced on the two mobile screens that broke it. A capability that does
// not exist is ABSENT — not greyed out with a tooltip, and never a control that accepts a tap and
// then admits, one screen later, that there was nothing behind it.
//
// These are SOURCE assertions, not rendered ones: `apps/mobile` has no React Native renderer under
// vitest (no react-test-renderer, no react-native-web) and adding one to pin two screens is not a
// trade worth making. So each fact below is a control-flow fact readable from the file itself, and
// each is written so that drift REDDENS rather than passing vacuously — the anti-vacuity pins are
// called out where they appear. What they cannot see: what the screens actually paint. The user-
// visible strings for the Open button are asserted in `kickoff.test.ts` through the reducer state
// the screen renders.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const reviewDir = join(appDir, "daemon", "[daemonId]", "review", "[reviewId]");
const read = (path: string): string => readFileSync(path, "utf8");

/**
 * A route screen whose entire body admits the capability is missing. Both `canvas.tsx` and
 * `finding.tsx` are placeholders while the Board rebuild (B2, #489, Q10) has not reached mobile,
 * and saying so on those screens is honest — the defect was ever ROUTING to them from a card that
 * promised "every cohort, finding, and hunk in reading order".
 */
const admitsUnavailable = (source: string): boolean => /temporarily unavailable/i.test(source);

describe("review digest offers no dead controls (absent-not-disabled)", () => {
  const digest = read(join(reviewDir, "digest.tsx"));
  const pushed = [...digest.matchAll(/router\.push\(`\$\{base\}\/([a-z]+)`\)/g)].map(
    (m) => m[1] as string,
  );

  it("routes only where the card's promise is kept", () => {
    // Anti-vacuity: if the push shape ever changes, `pushed` silently empties and the loop below
    // asserts nothing. Pin the exact set so that drift — or a re-added card — fails here first.
    // `turn` left the set with the orchestrator chat (t3-lens-threads 4.2): the screen it
    // pushed to is deleted, so a card pointing at it would be the deadest control of all.
    expect([...pushed].sort()).toEqual(["publish"]);

    for (const route of pushed) {
      const target = read(join(reviewDir, `${route}.tsx`));
      expect(
        admitsUnavailable(target),
        `the digest pushes a card to ${route}.tsx, which says the capability is unavailable — ` +
          "remove the card or state it on the card itself; do not disable it",
      ).toBe(false);
    }
  });

  it("states the missing conversation on the digest rather than routing to a dead screen", () => {
    // The Act card pointed at `turn.tsx`, which is deleted (t3-lens-threads 4.2). Removing it
    // without saying why would leave a user hunting for the ask they were pushed about, so
    // the digest names the T3 thread and where to open it. LOAD-BEARING: re-adding the card
    // reddens the route assertion above, and dropping this sentence reddens here.
    expect(digest).toMatch(/T3 Code thread/i);
    expect(digest).toMatch(/on the desktop/i);
  });

  it("says on the digest itself that reading is not on mobile yet", () => {
    // The controls are absent; the FACT is not. A user who finds no way to read the review must be
    // told why on the screen where they looked, not by tapping into a dead end to find out.
    expect(digest).toMatch(/board is being rebuilt/i);
  });

  it("keeps the placeholder screens honest about themselves", () => {
    // Positive control for `admitsUnavailable`: it must actually match the placeholders, otherwise
    // the loop above would pass no matter where a card pointed.
    expect(admitsUnavailable(read(join(reviewDir, "canvas.tsx")))).toBe(true);
    expect(admitsUnavailable(read(join(reviewDir, "finding.tsx")))).toBe(true);
  });
});

describe("kickoff Open cannot be a silent no-op (absent-not-disabled)", () => {
  const kickoff = read(join(appDir, "kickoff.tsx"));

  it("routes the press through the total plan, with no second source of truth", () => {
    expect(kickoff).toMatch(/planOpenPr\(/);
    // `planOpenPr` is total: every input is an `open` or a stated reason. The screen must not
    // import the partial pieces it is built from, because that is exactly how the bug was written
    // — `parsePrRef` returning null, and the handler treating null as "return".
    expect(kickoff).not.toMatch(/\bparsePrRef\b/);
    expect(kickoff).not.toMatch(/\bmatchProjectRepoKey\b/);
  });
});

describe("publish preview does not strand a transient board-drafting result", () => {
  const publish = read(join(reviewDir, "publish.tsx"));

  it("routes retries, projection refresh, and route cancellation through the tested controller", () => {
    expect(publish).toContain("createComposeRefreshController");
    expect(publish).toContain("supervisor.onAskProjection(reviewId");
    expect(publish).toContain("controller.refresh()");
    expect(publish).toContain("controller.stop()");
    expect(publish.match(/\.invoke\("publish\.compose"/g)).toHaveLength(1);
  });

  it("carries the composed provider and returned number into the change-request receipt", () => {
    expect(publish).toContain("changeRequestCopy(composed.target?.repo.forge)");
    expect(publish).toContain("request: { forge: c.target?.repo.forge, number: outcome.number }");
    expect(publish).toMatch(/`\$\{receipt\.opened\} · \$\{receipt\.sigil\}\$\{receipt\.number\}`/);
  });
});
