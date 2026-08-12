import type { Disposition, Patchset } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildDeltaAccount, changedPathsBetween } from "./delta-account";

// A span-grained ask on `path`, or path-grained when `span` is omitted.
function ask(
  path: string,
  body: string,
  span?: { startLine: number; endLine: number },
): Disposition {
  return {
    anchor: {
      path,
      contentDigest: `digest-${path}`,
      ...(span ? { span, side: "additions" as const, spanDigest: `span-${path}` } : {}),
    },
    type: "request-change",
    body,
  };
}

function file(path: string, patch: string) {
  return { path, status: "modified" as const, additions: 1, deletions: 0, binary: false, patch };
}

function patchset(id: string, files: ReturnType<typeof file>[]): Patchset {
  return {
    id,
    createdAt: "2026-08-12T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid: "base",
      headOid: "head",
    },
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 1,
    truncated: false,
  };
}

describe("buildDeltaAccount — the deterministic delta re-review account (#73)", () => {
  // The acceptance fixture: 3 asks where the returned patchset addresses 2, ignores 1,
  // and adds 1 unrequested change. The account must state all four facts.
  const asks = [
    ask("a.ts", "Rename the export"),
    ask("b.ts", "Guard the null case"),
    ask("c.ts", "Drop the dead branch"),
  ];

  it("states all four facts: 2 addressed, 1 untouched, 1 beyond-asks", () => {
    const account = buildDeltaAccount({
      asks,
      // Only c.ts's ask survived byte-identical (the agent ignored it); a.ts and b.ts
      // changed, so they are NOT carried.
      carried: [asks[2] as Disposition],
      // The agent changed a.ts and b.ts (addressed) and ALSO d.ts (nobody asked).
      changedPaths: ["a.ts", "b.ts", "d.ts"],
    });

    const status = (path: string) => account.asks.find((entry) => entry.path === path)?.status;
    expect(status("a.ts")).toBe("addressed");
    expect(status("b.ts")).toBe("addressed");
    expect(status("c.ts")).toBe("untouched");
    // The scope-creep the reviewer must see: a change nobody asked for.
    expect(account.beyondAsks).toEqual(["d.ts"]);
  });

  it("RED-PROOF: an unrequested change is flagged beyond-asks (reverting detection reddens)", () => {
    // If beyond-asks detection is reverted (e.g. `beyondAsks = []`), d.ts is not flagged
    // and this assertion reddens — the named guard for the scope-creep detector.
    const account = buildDeltaAccount({
      asks,
      carried: [asks[2] as Disposition],
      changedPaths: ["a.ts", "b.ts", "d.ts"],
    });
    expect(account.beyondAsks).toContain("d.ts");
  });

  it("classifies partially-addressed: the flagged span carried but the file changed elsewhere", () => {
    const spanAsk = ask("e.ts", "Fix the loop bound", { startLine: 10, endLine: 12 });
    const account = buildDeltaAccount({
      asks: [spanAsk],
      carried: [spanAsk], // the flagged span survived byte-identical…
      changedPaths: ["e.ts"], // …but the agent changed e.ts elsewhere.
    });
    expect(account.asks[0]?.status).toBe("partially-addressed");
  });

  it("classifies untouched: carried and the file was not changed at all", () => {
    const account = buildDeltaAccount({
      asks: [asks[0] as Disposition],
      carried: [asks[0] as Disposition],
      changedPaths: [],
    });
    expect(account.asks[0]?.status).toBe("untouched");
  });

  it("RENAME-CARRY is NOT a lie: a span carried onto a renamed path is untouched, not addressed", () => {
    // The bug both reviewers caught: the carry re-anchors a span-grained disposition
    // onto the NEW path across a rename (preserving spanDigest), so a path-keyed match
    // failed and reported the untouched concern as "addressed" + flagged the new path
    // as scope-creep. Match by rename-surviving identity (spanDigest) instead.
    const askOnOld = ask("old.ts", "Guard this loop", { startLine: 2, endLine: 3 });
    // What `carrySpanMoveOntoRename` returns: same spanDigest, re-anchored to new.ts.
    const carriedOnNew: Disposition = {
      ...askOnOld,
      anchor: { ...askOnOld.anchor, path: "new.ts", contentDigest: "digest-new.ts" },
    };
    const account = buildDeltaAccount({
      asks: [askOnOld],
      carried: [carriedOnNew],
      changedPaths: ["old.ts", "new.ts"], // old vanished, new appeared (the rename)
      renames: [{ from: "old.ts", to: "new.ts" }],
    });
    // The concern is UNTOUCHED (the flagged code survived byte-identically) — never
    // "addressed".
    expect(account.asks[0]?.status).toBe("untouched");
    // It is reported/anchored at its CURRENT location, not the stale old path.
    expect(account.asks[0]?.path).toBe("new.ts");
    // The renamed file is the ask's own relocated content — NOT scope-creep.
    expect(account.beyondAsks).toEqual([]);
  });

  it("is MODEL-FREE: the account is a pure function of the carry + changed paths (no model input)", () => {
    // The signature admits no model/seat/budget dependency — the guarantee is that the
    // full account computes with nothing but the shipped carry data. Running it twice on
    // the same inputs yields byte-identical output (deterministic).
    const inputs = {
      asks,
      carried: [asks[2] as Disposition],
      changedPaths: ["a.ts", "b.ts", "d.ts"],
    };
    expect(JSON.stringify(buildDeltaAccount(inputs))).toBe(
      JSON.stringify(buildDeltaAccount(inputs)),
    );
  });

  it("keeps the partition TOTAL: every changed path is exactly one of asked or beyond", () => {
    const account = buildDeltaAccount({
      asks,
      carried: [asks[2] as Disposition],
      changedPaths: ["a.ts", "b.ts", "d.ts"],
    });
    const askedChanged = ["a.ts", "b.ts"]; // c.ts was asked but did not change
    for (const path of ["a.ts", "b.ts", "d.ts"]) {
      const asked = askedChanged.includes(path);
      const beyond = account.beyondAsks.includes(path);
      expect(asked).not.toBe(beyond); // exactly one bucket, never both, never neither
    }
  });

  it("carries a summary excerpt of each ask body for the 'what moved' line", () => {
    const account = buildDeltaAccount({ asks, carried: asks, changedPaths: [] });
    expect(account.asks.map((entry) => entry.summary)).toEqual([
      "Rename the export",
      "Guard the null case",
      "Drop the dead branch",
    ]);
  });
});

describe("changedPathsBetween — the deterministic changed-path signal", () => {
  it("detects a modified file, a new file, and a removed file", () => {
    const prior = patchset("p1", [
      file("a.ts", "@@ -1 +1 @@\n-old"),
      file("gone.ts", "@@ +1 @@\n+x"),
    ]);
    const successor = patchset("p2", [
      file("a.ts", "@@ -1 +1 @@\n-new"), // modified: different patch body
      file("added.ts", "@@ +1 @@\n+y"), // new file
    ]);
    // a.ts changed, added.ts is new, gone.ts vanished — all three surface, sorted.
    expect(changedPathsBetween(prior, successor)).toEqual(["a.ts", "added.ts", "gone.ts"]);
  });

  it("ignores a byte-identical file (same patch body ⇒ not changed)", () => {
    const prior = patchset("p1", [file("a.ts", "@@ -1 +1 @@\n-same")]);
    const successor = patchset("p2", [file("a.ts", "@@ -1 +1 @@\n-same")]);
    expect(changedPathsBetween(prior, successor)).toEqual([]);
  });
});
