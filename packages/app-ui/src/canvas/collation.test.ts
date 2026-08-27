import { describe, expect, it } from "vitest";
import {
  type CollationDraft,
  type CollationItem,
  clearRefined,
  collationItems,
  collationPayload,
  type DispositionBatch,
  type DispositionWrite,
  draftFromBatch,
  effectiveBody,
  ingestWrites,
  itemRefineSignature,
  mergeItems,
  moveItem,
  retypeItem,
  rewordItem,
  setRefined,
  splitItem,
  withdrawItem,
  withdrawPath,
} from "./collation";

const batch: DispositionBatch = [
  { path: "src/beta.ts", type: "request-change", raw: "rename x" },
  { path: "src/alpha.ts", type: "approve", raw: "" },
];

describe("draftFromBatch — lift the staged batch into an ordered, id-keyed draft", () => {
  it("orders path-sorted initially, with id == path (continuous with the staged view)", () => {
    const draft = draftFromBatch(batch);
    // Path-sorted: alpha before beta, regardless of batch order. If the sort were
    // dropped, this reads ["src/beta.ts", "src/alpha.ts"] → red.
    expect(draft.map((item) => item.path)).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(draft.map((item) => item.id)).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(draft[1]?.raw).toBe("rename x");
  });
});

describe("effectiveBody — refined once present, else raw (the §2.5 seam)", () => {
  it("prefers refined over raw", () => {
    // If effectiveBody returned raw unconditionally, this returns "messy" → red.
    expect(
      effectiveBody({ id: "a", path: "a", type: "comment", raw: "messy", refined: "clean" }),
    ).toBe("clean");
    expect(effectiveBody({ id: "a", path: "a", type: "comment", raw: "messy" })).toBe("messy");
  });
});

describe("ingestWrites — dispose == staged (upsert by path, order preserved)", () => {
  it("appends a new path and replaces an existing one in place", () => {
    const draft = draftFromBatch(batch);
    const writes: DispositionWrite[] = [
      { path: "src/alpha.ts", type: "request-change", body: "actually change it" },
      { path: "src/gamma.ts", type: "comment", body: "new" },
    ];
    const next = ingestWrites(draft, writes);
    // alpha replaced in place (position 0 kept), gamma appended at the end. If
    // ingest re-sorted or appended the replacement instead of updating in place,
    // the order/type below goes red.
    expect(next.map((item) => item.path)).toEqual(["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]);
    expect(next[0]?.type).toBe("request-change");
    expect(next[0]?.raw).toBe("actually change it");
    expect(next[0]?.id).toBe("src/alpha.ts");
  });

  it("updates the FIRST item on a path when a split has left two (does not collapse the split)", () => {
    const split = splitItem(draftFromBatch(batch), "src/alpha.ts");
    const next = ingestWrites(split, [{ path: "src/alpha.ts", type: "question", body: "q" }]);
    // Two items still share the path (the split survived); only the first updated.
    // If ingest collapsed by path, the split sibling vanishes → length red.
    expect(next.filter((item) => item.path === "src/alpha.ts")).toHaveLength(2);
    expect(next.find((item) => item.path === "src/alpha.ts")?.type).toBe("question");
  });

  it("invalidates a stale refined form when a re-ingest changes the body (#19 seam)", () => {
    // The item already carries a refined form (as #19 will set). Re-ingesting a
    // write over its path with a NEW body must drop the stale refinement, or
    // effectiveBody keeps serving the old refined text over the fresh raw.
    const draft: CollationDraft = [
      { id: "src/a.ts", path: "src/a.ts", type: "comment", raw: "old raw", refined: "old refined" },
    ];
    const next = ingestWrites(draft, [{ path: "src/a.ts", type: "comment", body: "new raw" }]);
    const item = next[0];
    if (!item) throw new Error("ingested item missing");
    expect(item.raw).toBe("new raw");
    // If refined survived, this stays "old refined" → the stale-refinement bug → red.
    expect(item.refined).toBeUndefined();
    expect(effectiveBody(item)).toBe("new raw");
  });

  it("keeps a still-valid refined form when a re-ingest does not change the body", () => {
    // Re-anchoring/retyping the SAME body must not needlessly drop the refinement
    // (no over-invalidation): the refined form is still a refinement of that body.
    const draft: CollationDraft = [
      { id: "src/a.ts", path: "src/a.ts", type: "comment", raw: "same", refined: "clean" },
    ];
    const next = ingestWrites(draft, [{ path: "src/a.ts", type: "question", body: "same" }]);
    expect(next[0]?.type).toBe("question");
    expect(next[0]?.refined).toBe("clean");
  });
});

describe("rewordItem / retypeItem — edit by stable id, never touching order", () => {
  it("rewords the targeted item only", () => {
    const draft = draftFromBatch(batch);
    const next = rewordItem(draft, "src/beta.ts", "reworded");
    expect(next.find((item) => item.id === "src/beta.ts")?.raw).toBe("reworded");
    // Untargeted item unchanged. If reword mutated all items, this goes red.
    expect(next.find((item) => item.id === "src/alpha.ts")?.raw).toBe("");
  });

  it("retypes the targeted item only", () => {
    const next = retypeItem(draftFromBatch(batch), "src/alpha.ts", "question");
    expect(next.find((item) => item.id === "src/alpha.ts")?.type).toBe("question");
    expect(next.find((item) => item.id === "src/beta.ts")?.type).toBe("request-change");
  });

  it("invalidates a stale refined form when the raw body is reworded (#19 seam)", () => {
    // A reworded item that already had a refined form must drop it — otherwise
    // effectiveBody keeps showing/publishing the stale refined text and the
    // textarea input snaps back over what the user typed (the #101 review catch).
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "messy", refined: "clean" },
    ];
    const next = rewordItem(draft, "a", "reworded");
    const item = next[0];
    if (!item) throw new Error("reworded item missing");
    expect(item.raw).toBe("reworded");
    // If reword preserved refined, effectiveBody stays "clean" → stale bug → red.
    expect(item.refined).toBeUndefined();
    expect(effectiveBody(item)).toBe("reworded");
  });

  it("keeps a still-valid refined form when the reword does not change the body", () => {
    // No body change ⇒ no invalidation: the refinement is still valid, so a reword
    // to identical text must not needlessly drop it (over-invalidation guard).
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "same", refined: "clean" },
    ];
    const next = rewordItem(draft, "a", "same");
    expect(next[0]?.refined).toBe("clean");
  });

  it("invalidates a stale refined form when the TYPE changes (#19 — type is refiner input)", () => {
    // The disposition type is part of the refiner's prompt, so a refinement made for
    // a `question` must not survive a retype to `request-change` — it would post
    // wording generated for a question as a requested change (the Codex P0). Same
    // invalidation law as a reword. If retype preserved refined, this reddens.
    const draft: CollationDraft = [
      {
        id: "a",
        path: "src/a.ts",
        type: "question",
        raw: "why this?",
        refined: "Why was this chosen?",
      },
    ];
    const next = retypeItem(draft, "a", "request-change");
    expect(next[0]?.type).toBe("request-change");
    expect(next[0]?.refined).toBeUndefined();
  });

  it("keeps a still-valid refined form when the retype does not change the type", () => {
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "note", refined: "clean" },
    ];
    expect(retypeItem(draft, "a", "comment")[0]?.refined).toBe("clean");
  });
});

describe("itemRefineSignature — binds a refinement to its full input (#19)", () => {
  const base: CollationItem = {
    id: "a",
    path: "src/a.ts",
    type: "comment",
    raw: "note",
    span: { startLine: 3 },
    side: "additions",
  };

  it("changes when the raw body changes", () => {
    expect(itemRefineSignature({ ...base, raw: "different" })).not.toBe(itemRefineSignature(base));
  });

  it("changes when the TYPE changes (the Codex P0: type is refiner input)", () => {
    // A signature ignoring type would let a refinement made for a question survive a
    // retype to request-change — the exact stale-verdict bug. This reddens without type.
    expect(itemRefineSignature({ ...base, type: "request-change" })).not.toBe(
      itemRefineSignature(base),
    );
  });

  it("changes when the anchor (path / span / side) changes", () => {
    expect(itemRefineSignature({ ...base, path: "src/b.ts" })).not.toBe(itemRefineSignature(base));
    expect(itemRefineSignature({ ...base, span: { startLine: 9 } })).not.toBe(
      itemRefineSignature(base),
    );
    expect(itemRefineSignature({ ...base, side: "deletions" })).not.toBe(itemRefineSignature(base));
  });

  it("is stable when only order-neutral, non-input fields differ (refined / staged)", () => {
    // A refinement landing or a lane toggle must NOT read as a stale input change.
    expect(itemRefineSignature({ ...base, refined: "clean", staged: true })).toBe(
      itemRefineSignature(base),
    );
  });
});

describe("setRefined / clearRefined — adopt and undo a refinement (#19)", () => {
  const base: CollationDraft = [
    { id: "a", path: "src/a.ts", type: "comment", raw: "messy note" },
    { id: "b", path: "src/b.ts", type: "comment", raw: "other" },
  ];

  it("setRefined adopts the refined form; effectiveBody then prefers it", () => {
    const next = setRefined(base, "a", "clean comment");
    expect(next.find((item) => item.id === "a")?.refined).toBe("clean comment");
    const target = next.find((item) => item.id === "a");
    if (!target) throw new Error("item missing");
    expect(effectiveBody(target)).toBe("clean comment");
    // Untargeted item unchanged — a setter wired to the wrong id reddens this.
    expect(next.find((item) => item.id === "b")?.refined).toBeUndefined();
  });

  it("setRefined ignores a blank refinement (never posts a blank over the raw)", () => {
    expect(setRefined(base, "a", "   ")).toEqual(base);
  });

  it("setRefined is a no-op for an unknown id", () => {
    expect(setRefined(base, "zzz", "x")).toEqual(base);
  });

  it("clearRefined drops a landed refinement, returning the raw as the effective body", () => {
    const refined = setRefined(base, "a", "clean comment");
    const cleared = clearRefined(refined, "a");
    const target = cleared.find((item) => item.id === "a");
    if (!target) throw new Error("item missing");
    expect(target.refined).toBeUndefined();
    // The undo returns to the sovereign raw — the "keep my original" guarantee.
    expect(effectiveBody(target)).toBe("messy note");
  });
});

describe("moveItem — reorder is a real output-order edit", () => {
  it("moves an item down and up, and is a no-op at the boundary", () => {
    const draft = draftFromBatch(batch); // [alpha, beta]
    const down = moveItem(draft, "src/alpha.ts", "down");
    // alpha and beta swapped. If move returned the draft unchanged, this is red.
    expect(down.map((item) => item.id)).toEqual(["src/beta.ts", "src/alpha.ts"]);
    const up = moveItem(down, "src/alpha.ts", "up");
    expect(up.map((item) => item.id)).toEqual(["src/alpha.ts", "src/beta.ts"]);
    // Top item cannot move up — no-op (not a crash, not a wrap-around to the end).
    expect(moveItem(draft, "src/alpha.ts", "up").map((item) => item.id)).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ]);
  });

  it("moves exactly one adjacent position on a three-item draft (not to the boundary)", () => {
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "a" },
      { id: "b", path: "src/b.ts", type: "comment", raw: "b" },
      { id: "c", path: "src/c.ts", type: "comment", raw: "c" },
    ];
    // Move the FIRST item down by one: [a,b,c] → [b,a,c]. A "shove to the end" bug
    // would give [b,c,a] → red. This is the discrimination a two-item draft cannot make.
    expect(moveItem(draft, "a", "down").map((item) => item.id)).toEqual(["b", "a", "c"]);
    // Move the LAST item up by one: [a,b,c] → [a,c,b]. A "shove to the top" bug → red.
    expect(moveItem(draft, "c", "up").map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("changes the outbound payload — order is semantic", () => {
    const draft = draftFromBatch(batch);
    const reordered = moveItem(draft, "src/alpha.ts", "down");
    // The whole point of reorder: the bytes that leave differ. If collationPayload
    // path-sorted (like the #17 batchPayload), these would be equal → red.
    expect(collationPayload(reordered)).not.toBe(collationPayload(draft));
    expect(collationItems(reordered).map((item) => item.path)).toEqual([
      "src/beta.ts",
      "src/alpha.ts",
    ]);
  });
});

describe("mergeItems — two dispositions collapse into one", () => {
  it("joins bodies into the target, drops the source, keeps the target's position/id", () => {
    const draft = draftFromBatch(batch); // [alpha "", beta "rename x"]
    const worded = rewordItem(draft, "src/alpha.ts", "first note");
    const merged = mergeItems(worded, "src/alpha.ts", "src/beta.ts");
    // One item remains (beta removed). If merge kept both, length is 2 → red.
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("src/alpha.ts");
    // Both bodies joined, target first, blank halves dropped.
    expect(merged[0]?.raw).toBe("first note\nrename x");
    // The result keeps the TARGET's type by design (here alpha's "approve"), even
    // though the source was "request-change". This locks that documented behaviour;
    // whether an unlike-type merge should be restricted or surfaced is a design
    // question tracked in a follow-up bead, not a silent side effect.
    expect(merged[0]?.type).toBe("approve");
  });

  it("folds the SOVEREIGN RAW bodies, never the refined form — both originals survive (#19)", () => {
    // Two refined items merged. If merge folded effectiveBody (the refined form),
    // the raw would become "clean A\nclean B" and NEITHER original would be
    // recoverable — the data-loss bug. Folding raw preserves what the user wrote.
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "messy A", refined: "clean A" },
      { id: "b", path: "src/b.ts", type: "comment", raw: "messy B", refined: "clean B" },
    ];
    const merged = mergeItems(draft, "a", "b");
    expect(merged).toHaveLength(1);
    // The sovereign originals, both present. A fold of `effectiveBody` reddens this.
    expect(merged[0]?.raw).toBe("messy A\nmessy B");
    // The stale per-item proposals are cleared; the merged note re-refines from raw.
    expect(merged[0]?.refined).toBeUndefined();
    // effectiveBody now returns the merged raw — clearRefined has the originals to keep.
    if (merged[0]) expect(effectiveBody(merged[0])).toBe("messy A\nmessy B");
  });

  it("is a no-op merging an item into itself or with an unknown id", () => {
    const draft = draftFromBatch(batch);
    expect(mergeItems(draft, "src/alpha.ts", "src/alpha.ts")).toHaveLength(2);
    expect(mergeItems(draft, "src/alpha.ts", "nope")).toHaveLength(2);
  });
});

describe("splitItem — one disposition becomes two, sharing a path", () => {
  it("inserts an empty sibling immediately after, sharing path + type, with a fresh id", () => {
    const draft = draftFromBatch(batch); // [alpha, beta]
    const split = splitItem(draft, "src/beta.ts");
    // A sibling was inserted right after beta (not at the end). If split appended,
    // the index assertion below reddens.
    expect(split).toHaveLength(3);
    expect(split[2]?.path).toBe("src/beta.ts");
    expect(split[2]?.id).not.toBe("src/beta.ts"); // fresh, distinct id
    expect(split[2]?.type).toBe("request-change"); // inherits type
    expect(split[2]?.raw).toBe(""); // blank half, no content duplicated
    // Original untouched — its body is not duplicated into the sibling.
    expect(split[1]?.raw).toBe("rename x");
  });

  it("mints collision-free ids across repeated splits", () => {
    const once = splitItem(draftFromBatch(batch), "src/alpha.ts");
    const twice = splitItem(once, "src/alpha.ts");
    const ids = twice.map((item) => item.id);
    // All ids unique. A fixed sibling id would collide on the second split → red.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("withdrawItem / withdrawPath — unstage with zero residue", () => {
  it("withdrawItem removes exactly the one item by id", () => {
    const split = splitItem(draftFromBatch(batch), "src/alpha.ts");
    const siblingId = split[1]?.id;
    if (!siblingId) throw new Error("split sibling missing");
    const next = withdrawItem(split, siblingId);
    expect(next.some((item) => item.id === siblingId)).toBe(false);
    // The other alpha item on the same path survives — withdraw is by id, not path.
    expect(next.filter((item) => item.path === "src/alpha.ts")).toHaveLength(1);
  });

  it("withdrawPath removes every item on a path (mark-unread)", () => {
    const split = splitItem(draftFromBatch(batch), "src/alpha.ts");
    const next = withdrawPath(split, "src/alpha.ts");
    expect(next.some((item) => item.path === "src/alpha.ts")).toBe(false);
    expect(next).toHaveLength(1); // only beta remains
  });
});

describe("collationItems / collationPayload — preview bytes == outbound bytes, in draft order", () => {
  it("emits the effective body (refined preferred) in draft order", () => {
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "raw-a", refined: "clean-a" },
      { id: "b", path: "src/b.ts", type: "approve", raw: "" },
    ];
    const items = collationItems(draft);
    expect(items[0]?.body).toBe("clean-a"); // refined preferred
    // Payload is the items serialised in order — the paper signs exactly this.
    expect(collationPayload(draft)).toBe(JSON.stringify(items));
  });
});
