import { DIFF_TRUNCATION_MARKER, type Disposition, type Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildDeltaAccount, changedPathsBetween, newHunksBetween } from "./delta-account";

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

function file(path: string, patch: string, previousPath?: string) {
  return {
    path,
    status: previousPath === undefined ? ("modified" as const) : ("renamed" as const),
    additions: 1,
    deletions: 0,
    binary: false,
    patch,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
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

// ── Hunk-grain beyond-asks (#73 delta re-review, wave 3) ─────────────────────
// The case PATH grain structurally cannot see: an unrequested hunk INSIDE an asked
// file. Path grain reports the file "partially addressed" (an ask covers it), so the
// extra change vanishes. Hunk grain must surface it in the asked-file bucket.
describe("buildDeltaAccount — hunk-grain beyond-asks (#73 wave 3)", () => {
  // a.ts: the asked span (lines 10–11) carries byte-identically, AND the agent adds a
  // second, non-overlapping hunk (lines 40–41) no ask targets.
  const priorA = patchset("p1", [file("a.ts", "@@ -10,2 +10,2 @@\n-a\n+b")]);
  const successorA = patchset("p2", [
    file("a.ts", "@@ -10,2 +10,2 @@\n-a\n+b\n@@ -40,2 +40,2 @@\n-c\n+d"),
  ]);
  const askA = ask("a.ts", "Fix the loop bound", { startLine: 10, endLine: 11 });

  it("surfaces an unrequested hunk inside an asked file (the case path grain misses)", () => {
    const account = buildDeltaAccount({
      asks: [askA],
      carried: [askA], // the flagged span survived byte-identical…
      changedPaths: ["a.ts"], // …but the agent changed a.ts elsewhere.
      prior: priorA,
      successor: successorA,
    });
    // Path grain alone: a.ts is "partially addressed" and NOTHING beyond (an ask
    // covers the file) — the extra hunk is invisible.
    expect(account.asks[0]?.status).toBe("partially-addressed");
    expect(account.beyondAsks).toEqual([]);
    // Hunk grain: the second hunk surfaces in the asked-file bucket with its range.
    expect(account.beyondAskHunks).toBeDefined();
    const hunk = account.beyondAskHunks?.find((entry) => entry.path === "a.ts");
    expect(hunk?.bucket).toBe("asked-file");
    expect(hunk?.span.startLine).toBe(40);
  });
});

describe("newHunksBetween — content-identity new-hunk detection (#73 wave 3)", () => {
  it("pure line-number DRIFT yields no new hunk (identical changed lines, shifted lines)", () => {
    // Same edit (-a/+b), different header line numbers (the base moved down by 20).
    const prior = patchset("p1", [file("a.ts", "@@ -10,2 +10,2 @@\n-a\n+b")]);
    const successor = patchset("p2", [file("a.ts", "@@ -30,2 +30,2 @@\n-a\n+b")]);
    expect(newHunksBetween(prior, successor)).toEqual([]);
  });

  it("finds a genuinely new hunk (changed-line content absent from the prior patch)", () => {
    const prior = patchset("p1", [file("a.ts", "@@ -10,2 +10,2 @@\n-a\n+b")]);
    const successor = patchset("p2", [
      file("a.ts", "@@ -10,2 +10,2 @@\n-a\n+b\n@@ -40,2 +40,2 @@\n-c\n+d"),
    ]);
    const found = newHunksBetween(prior, successor);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("a.ts");
    expect(found[0]?.hunk.newStart).toBe(40);
  });

  it("a producer-framed TRUNCATED file (marker on either side) yields NO hunk claims — path grain only", () => {
    const prior = patchset("p1", [
      file("big.ts", `@@ -1,2 +1,2 @@\n-a\n+b\n\n${DIFF_TRUNCATION_MARKER}`),
    ]);
    const successor = patchset("p2", [
      file(
        "big.ts",
        `@@ -1,2 +1,2 @@\n-a\n+B\n@@ -99,1 +99,1 @@\n+new\n\n${DIFF_TRUNCATION_MARKER}`,
      ),
    ]);
    expect(newHunksBetween(prior, successor)).toEqual([]);
  });

  it("a source line containing the literal marker still participates in hunk accounting", () => {
    const markerSource = `+export const marker = "${DIFF_TRUNCATION_MARKER}";`;
    const prior = patchset("p1", [file("marker.ts", `@@ -1,0 +1,1 @@\n${markerSource}`)]);
    const successor = patchset("p2", [
      file(
        "marker.ts",
        `@@ -1,0 +1,1 @@\n${markerSource}\n@@ -20,0 +21,1 @@\n+export const added = true;`,
      ),
    ]);

    const found = newHunksBetween(prior, successor);
    expect(found).toHaveLength(1);
    expect(found[0]?.hunk.newStart).toBe(21);
  });

  it("matches identical hunks through a chained rename's stable source", () => {
    const patch = "@@ -10,1 +10,1 @@\n-old\n+new";
    const prior = patchset("p1", [file("mid.ts", patch, "old.ts")]);
    const successor = patchset("p2", [file("new.ts", patch, "old.ts")]);

    expect(newHunksBetween(prior, successor)).toEqual([]);
  });

  it("degrades a truncated chained rename to path grain without false hunks", () => {
    const prior = patchset("p1", [
      file("mid.ts", `@@ -10,1 +10,1 @@\n-old\n+new\n\n${DIFF_TRUNCATION_MARKER}`, "old.ts"),
    ]);
    const successor = patchset("p2", [file("new.ts", "@@ -10,1 +10,1 @@\n-old\n+new", "old.ts")]);

    expect(newHunksBetween(prior, successor)).toEqual([]);
  });

  it("multiset-matches duplicate identical hunks (each prior hunk absorbs at most one)", () => {
    // Prior has ONE (-x/+y); successor has TWO. One is drift, the second is genuinely new.
    const prior = patchset("p1", [file("a.ts", "@@ -1,2 +1,2 @@\n-x\n+y")]);
    const successor = patchset("p2", [
      file("a.ts", "@@ -1,2 +1,2 @@\n-x\n+y\n@@ -50,2 +50,2 @@\n-x\n+y"),
    ]);
    expect(newHunksBetween(prior, successor)).toHaveLength(1);
  });
});

describe("buildDeltaAccount — hunk buckets and the four-fact fixture at hunk grain (#73 wave 3)", () => {
  it("does not cover a pure insertion with a deletion-side ask at the same line", () => {
    const additionsAsk = ask("a.ts", "Remove the old line", { startLine: 10, endLine: 10 });
    const deletionAsk: Disposition = {
      ...additionsAsk,
      anchor: { ...additionsAsk.anchor, side: "deletions" },
    };
    const account = buildDeltaAccount({
      asks: [deletionAsk],
      carried: [deletionAsk],
      changedPaths: ["a.ts"],
      prior: patchset("p1", [file("a.ts", "")]),
      successor: patchset("p2", [file("a.ts", "@@ -10,0 +10,1 @@\n+inserted")]),
    });

    expect(account.beyondAskHunks).toEqual([
      expect.objectContaining({ path: "a.ts", span: { startLine: 10 }, bucket: "asked-file" }),
    ]);
  });

  it("does not cover a pure deletion with an insertion-side ask at the same line", () => {
    const insertionAsk = ask("a.ts", "Insert the replacement", { startLine: 10, endLine: 10 });
    const account = buildDeltaAccount({
      asks: [insertionAsk],
      carried: [insertionAsk],
      changedPaths: ["a.ts"],
      prior: patchset("p1", [file("a.ts", "")]),
      successor: patchset("p2", [file("a.ts", "@@ -10,1 +10,0 @@\n-removed")]),
    });

    expect(account.beyondAskHunks).toEqual([
      expect.objectContaining({
        path: "a.ts",
        span: { startLine: 10 },
        side: "deletions",
        bucket: "asked-file",
      }),
    ]);
  });

  it("does not cover an adjacent non-overlapping span", () => {
    const adjacentAsk = ask("a.ts", "Change the next line", { startLine: 11, endLine: 11 });
    const account = buildDeltaAccount({
      asks: [adjacentAsk],
      carried: [adjacentAsk],
      changedPaths: ["a.ts"],
      prior: patchset("p1", [file("a.ts", "")]),
      successor: patchset("p2", [file("a.ts", "@@ -10,0 +10,1 @@\n+inserted")]),
    });

    expect(account.beyondAskHunks).toEqual([
      expect.objectContaining({ path: "a.ts", span: { startLine: 10 }, bucket: "asked-file" }),
    ]);
  });

  it("classifies an unasked-file hunk into the loud unasked-file bucket", () => {
    const askA = ask("a.ts", "Fix a", { startLine: 1, endLine: 2 });
    const prior = patchset("p1", [file("a.ts", "@@ -1,2 +1,2 @@\n-a\n+b")]);
    const successor = patchset("p2", [
      file("a.ts", "@@ -1,2 +1,2 @@\n-a\n+b"),
      file("d.ts", "@@ -5,2 +5,2 @@\n-c\n+e"), // nobody asked about d.ts
    ]);
    const account = buildDeltaAccount({
      asks: [askA],
      carried: [askA],
      changedPaths: ["d.ts"],
      prior,
      successor,
    });
    const hunk = account.beyondAskHunks?.find((entry) => entry.path === "d.ts");
    expect(hunk?.bucket).toBe("unasked-file");
    expect(hunk?.span.startLine).toBe(5);
  });

  it("the four-fact fixture at hunk grain: 2 addressed, 1 untouched, 1 unrequested hunk", () => {
    // a.ts, b.ts addressed (their asked span changed → did not carry); c.ts untouched
    // (carried, unchanged); an unrequested hunk lands in a.ts beyond the asked span.
    const askA = ask("a.ts", "Rename a", { startLine: 1, endLine: 2 });
    const askB = ask("b.ts", "Guard b", { startLine: 1, endLine: 2 });
    const askC = ask("c.ts", "Drop c", { startLine: 1, endLine: 2 });
    const prior = patchset("p1", [
      file("a.ts", "@@ -1,2 +1,2 @@\n-a\n+a1"),
      file("b.ts", "@@ -1,2 +1,2 @@\n-b\n+b1"),
      file("c.ts", "@@ -1,2 +1,2 @@\n-c\n+c1"),
    ]);
    const successor = patchset("p2", [
      // a.ts: the asked span changed (addressed) AND a second unrequested hunk at line 40.
      file("a.ts", "@@ -1,2 +1,2 @@\n-a\n+a2\n@@ -40,2 +40,2 @@\n-z\n+z2"),
      file("b.ts", "@@ -1,2 +1,2 @@\n-b\n+b2"), // addressed
      file("c.ts", "@@ -1,2 +1,2 @@\n-c\n+c1"), // untouched (identical)
    ]);
    const account = buildDeltaAccount({
      asks: [askA, askB, askC],
      carried: [askC], // only c.ts's span survived byte-identical
      changedPaths: ["a.ts", "b.ts"],
      prior,
      successor,
    });
    const status = (path: string) => account.asks.find((entry) => entry.path === path)?.status;
    expect(status("a.ts")).toBe("addressed");
    expect(status("b.ts")).toBe("addressed");
    expect(status("c.ts")).toBe("untouched");
    // The fourth fact at hunk grain: the unrequested a.ts hunk in the asked-file bucket.
    const beyond = account.beyondAskHunks ?? [];
    expect(beyond).toHaveLength(1);
    expect(beyond[0]?.path).toBe("a.ts");
    expect(beyond[0]?.bucket).toBe("asked-file");
    expect(beyond[0]?.span.startLine).toBe(40);
  });

  it("computes an EMPTY array (not absent) when patchsets are given but nothing is beyond", () => {
    const askA = ask("a.ts", "Fix a", { startLine: 1, endLine: 2 });
    const prior = patchset("p1", [file("a.ts", "@@ -1,2 +1,2 @@\n-a\n+b")]);
    const successor = patchset("p2", [file("a.ts", "@@ -1,2 +1,2 @@\n-a\n+c")]);
    const account = buildDeltaAccount({
      asks: [askA],
      carried: [],
      changedPaths: ["a.ts"],
      prior,
      successor,
    });
    expect(account.beyondAskHunks).toEqual([]); // computed, nothing beyond
  });

  it("is ABSENT (legacy path grain) when patchsets are NOT supplied", () => {
    const account = buildDeltaAccount({ asks: [], carried: [], changedPaths: [] });
    expect(account.beyondAskHunks).toBeUndefined();
  });

  it("attributes an ask to its composed task from the handoff trace (narration only)", () => {
    const askA = ask("a.ts", "Fix a", { startLine: 1, endLine: 2 });
    const account = buildDeltaAccount({
      asks: [askA],
      carried: [askA],
      changedPaths: [],
      handoff: [
        {
          id: "d0",
          path: "a.ts",
          span: { startLine: 1, endLine: 2 },
          side: "additions",
          type: "request-change",
          taskIndex: 2,
          taskTitle: "Tighten the parser",
        },
      ],
    });
    expect(account.asks[0]?.handoffTask).toEqual({ index: 2, title: "Tighten the parser" });
    expect(account.asks[0]?.status).toBe("untouched"); // attribution never alters status
  });

  it("carries NO attribution on a regenerate (no handoff trace)", () => {
    const askA = ask("a.ts", "Fix a", { startLine: 1, endLine: 2 });
    const account = buildDeltaAccount({ asks: [askA], carried: [askA], changedPaths: [] });
    expect(account.asks[0]?.handoffTask).toBeUndefined();
  });
});
