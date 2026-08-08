import { describe, expect, it } from "vitest";
import type { DispositionBatch } from "./authoring";
import {
  type CollationDraft,
  collationItems,
  collationPayload,
  draftFromBatch,
  effectiveBody,
  ingestWrites,
  mergeItems,
  moveItem,
  retypeItem,
  rewordItem,
  splitItem,
  withdrawItem,
  withdrawPath,
} from "./collation";
import type { DispositionWrite } from "./logic";

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
