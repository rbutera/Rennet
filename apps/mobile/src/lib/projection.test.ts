import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  latestPatchsetTime,
  type ProjectedReviewLike,
  repoReferenceLabel,
  toReviewSummary,
} from "./projection";

// The R19 public-contract fixtures are the checked-in JSON Schemas the app builds against
// (packages/protocol/public-schema/*). Reading them here proves the app consumes the same
// contract the daemon projects — and that a host-absolute path structurally cannot appear.
function fixture(name: string): Record<string, unknown> {
  const url = new URL(`../../../../packages/protocol/public-schema/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("projection contract — the app consumes only the projected fixtures (task 5.5)", () => {
  it("a repo reference names repoKey/displayName/relativePath and forbids any host path", () => {
    const schema = fixture("repo-reference");
    expect(schema.additionalProperties).toBe(false);
    const keys = Object.keys(schema.properties as Record<string, unknown>).sort();
    // Exactly the projected fields — no `path`, no host root, nothing absolute can be added.
    expect(keys).toEqual(["displayName", "relativePath", "repoKey"]);
    expect(schema.required).toEqual(expect.arrayContaining(["repoKey", "displayName"]));
  });

  it("a projected review names its repository by the projected reference (object, not a host string)", () => {
    const schema = fixture("projected-review");
    const props = schema.properties as Record<string, { type?: string; properties?: object }>;
    expect(props.repositoryRoot?.type).toBe("object");
    const repoKeys = Object.keys(props.repositoryRoot?.properties ?? {}).sort();
    expect(repoKeys).toEqual(["displayName", "relativePath", "repoKey"]);
  });

  it("the projected review carries an additive OPTIONAL attention summary (#383)", () => {
    const schema = fixture("projected-review");
    const props = schema.properties as Record<string, { type?: string; properties?: object }>;
    const attention = props.attention as
      | { type?: string; properties?: Record<string, { type?: string }> }
      | undefined;
    expect(attention?.type).toBe("object");
    expect(Object.keys(attention?.properties ?? {}).sort()).toEqual(["needsYou", "running"]);
    // Additive ⇒ absent means "daemon predates attention": it must NOT be a required property.
    expect((schema.required as string[]) ?? []).not.toContain("attention");
  });

  const sample: ProjectedReviewLike = {
    id: "rev-1",
    repositoryRoot: { repoKey: "k", displayName: "acme", relativePath: "packages/api" },
    patchsets: [
      { id: "ps-1", createdAt: "2026-08-10T00:00:00.000Z" },
      { id: "ps-2", createdAt: "2026-08-17T00:00:00.000Z" },
    ],
    activePatchsetId: "ps-2",
    status: "current",
  };

  it("adapters read only projected fields — never a host-absolute path", () => {
    const label = repoReferenceLabel(sample.repositoryRoot);
    for (const value of [label.displayName, label.relativePath]) {
      expect(value).not.toMatch(/^\//); // no leading-slash absolute path
      expect(value).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\/); // no host home / Windows root
    }
    expect(label).toEqual({ displayName: "acme", relativePath: "packages/api" });
  });

  it("latestPatchsetTime picks the newest patchset", () => {
    expect(latestPatchsetTime(sample)).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
  });

  it("toReviewSummary derives running/needs-you/stale from projected + attention state", () => {
    const running = toReviewSummary(
      { ...sample, pendingPatchsetId: "ps-3" },
      { daemonId: "d1", reachable: true, attentionReviewIds: new Set() },
    );
    expect(running.running).toBe(true);
    expect(running.needsYou).toBe(false);

    const needsYou = toReviewSummary(sample, {
      daemonId: "d1",
      reachable: false,
      attentionReviewIds: new Set(["rev-1"]),
    });
    expect(needsYou.needsYou).toBe(true);
    // Unreachable ⇒ stale (paints from the replica).
    expect(needsYou.stale).toBe(true);
    expect(needsYou.reachable).toBe(false);
  });

  it("the daemon's attention summary is authoritative on a cold open (#383)", () => {
    // Attention-capable daemon reports a mid-turn ask that no push has delivered and the
    // flagged queue does not yet know: the projected `attention.needsYou` must pin the row.
    const coldOpen = toReviewSummary(
      { ...sample, attention: { needsYou: true, running: false } },
      { daemonId: "d1", reachable: true, attentionReviewIds: new Set() },
    );
    expect(coldOpen.needsYou).toBe(true);

    // `running` from the summary holds even without a pendingPatchsetId on the row.
    const runningFromSummary = toReviewSummary(
      { ...sample, attention: { needsYou: false, running: true } },
      { daemonId: "d1", reachable: true, attentionReviewIds: new Set() },
    );
    expect(runningFromSummary.running).toBe(true);

    // Authoritative, NOT OR-ed: a summary needsYou:false wins even if a stale flagged-queue entry
    // still names the review — the daemon cleared it, so the row must not re-assert needs-you.
    const clearedByDaemon = toReviewSummary(
      { ...sample, attention: { needsYou: false, running: false } },
      { daemonId: "d1", reachable: true, attentionReviewIds: new Set(["rev-1"]) },
    );
    expect(clearedByDaemon.needsYou).toBe(false);

    // Absent summary (pre-attention daemon) ⇒ fall back to the flagged-queue derivation.
    const legacy = toReviewSummary(sample, {
      daemonId: "d1",
      reachable: true,
      attentionReviewIds: new Set(["rev-1"]),
    });
    expect(legacy.needsYou).toBe(true);
  });
});
