import {
  ROUND_EVIDENCE_MANIFEST_MAX_BYTES,
  ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES,
  type RoundEvidenceUnit,
  serializeRoundEvidenceManifest,
  utf8ByteLength,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildRoundEvidenceManifest,
  measureRoundEvidenceManifest,
  verifyRoundEvidencePartition,
} from "./round-evidence-manifest";

const TEXT_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,2 +1,2 @@",
  "-old first line",
  "-old second line",
  "+new first line",
  "+new second line",
].join("\n");

const MIXED_DIFF = [
  "diff --git a/zeta/logo.png b/zeta/logo.png",
  "index 1111111..2222222 100644",
  "Binary files a/zeta/logo.png and b/zeta/logo.png differ",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 100%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "diff --git a/scripts/run.sh b/scripts/run.sh",
  "old mode 100644",
  "new mode 100755",
  "--- a/scripts/run.sh",
  "+++ b/scripts/run.sh",
  "@@ -1,1 +1,1 @@",
  "-echo old",
  "+echo new",
].join("\n");

describe("buildRoundEvidenceManifest", () => {
  it("represents every non-text change with its own variant and no invented line anchor", () => {
    const manifest = buildRoundEvidenceManifest(MIXED_DIFF);

    expect(manifest.map((unit) => [unit.kind, unit.path])).toEqual([
      ["rename", "new/name.ts"],
      ["mode-change", "scripts/run.sh"],
      ["text-hunk", "scripts/run.sh"],
      ["binary", "zeta/logo.png"],
    ]);
    // The anchor exists ONLY on the variant that has real lines. A rename, a mode
    // change, and a binary file each carry none — the union cannot express one.
    expect(manifest.filter((unit) => "anchor" in unit)).toHaveLength(1);
    expect(manifest.find((unit) => unit.kind === "text-hunk")?.anchor).toEqual({
      side: "head",
      path: "scripts/run.sh",
      line: 1,
    });
  });

  it("keeps a rename that also changed text lossless across both variants", () => {
    const manifest = buildRoundEvidenceManifest(
      [
        "diff --git a/old/name.ts b/new/name.ts",
        "similarity index 80%",
        "rename from old/name.ts",
        "rename to new/name.ts",
        "--- a/old/name.ts",
        "+++ b/new/name.ts",
        "@@ -1,3 +1,2 @@",
        " kept",
        "-was here",
        "-and here",
      ].join("\n"),
    );

    expect(manifest.map((unit) => unit.kind)).toEqual(["rename", "text-hunk"]);
    const hunk = manifest[1];
    expect(hunk?.kind === "text-hunk" ? hunk.previousPath : undefined).toBe("old/name.ts");
    // A hunk that only deletes anchors on the BASE side, which on a rename is the
    // SOURCE path — not the unit's head path.
    expect(hunk?.kind === "text-hunk" ? hunk.anchor : undefined).toEqual({
      side: "base",
      path: "old/name.ts",
      line: 2,
    });
  });

  it("orders by path then position, independent of the diff's own file order", () => {
    const forward = buildRoundEvidenceManifest(
      [
        "diff --git a/b.ts b/b.ts",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +1,1 @@",
        "-b old",
        "+b new",
        "@@ -20,1 +20,1 @@",
        "-b twenty old",
        "+b twenty new",
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -5,1 +5,1 @@",
        "-a old",
        "+a new",
      ].join("\n"),
    );

    expect(
      forward.map((unit) => [unit.path, unit.kind === "text-hunk" ? unit.anchor.line : 0]),
    ).toEqual([
      ["a.ts", 5],
      ["b.ts", 1],
      ["b.ts", 20],
    ]);
  });

  it("derives ids from content, so a rebuild is identical and an unrelated FILE does not renumber", () => {
    const first = buildRoundEvidenceManifest(TEXT_DIFF);
    const rebuilt = buildRoundEvidenceManifest(TEXT_DIFF);
    expect(rebuilt.map((unit) => unit.id)).toEqual(first.map((unit) => unit.id));

    const withNeighbour = buildRoundEvidenceManifest(
      [
        "diff --git a/aaa.ts b/aaa.ts",
        "--- a/aaa.ts",
        "+++ b/aaa.ts",
        "@@ -1,1 +1,1 @@",
        "-unrelated old",
        "+unrelated new",
        TEXT_DIFF,
      ].join("\n"),
    );
    // An ordinal id would have shifted every surviving unit by one.
    expect(withNeighbour.map((unit) => unit.id)).toContain(first[0]?.id);
  });

  it("re-keys a hunk when an unrelated edit ABOVE it in the same file shifts its @@ header", () => {
    // The honest edge of the stability claim, asserted rather than left to the reader:
    // a text hunk's identity includes its `@@` header, so a same-file edit above it
    // changes the id even though the hunk's own body is byte-identical. Dropping the
    // header would fix this and collide two identical hunks in one file instead —
    // strictly worse, since ids must be unique within a manifest first.
    const body = ["-old second line", "+new second line"];
    const at = (start: number): string =>
      [
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        `@@ -${start},1 +${start},1 @@`,
        ...body,
      ].join("\n");

    const before = buildRoundEvidenceManifest(at(10));
    const after = buildRoundEvidenceManifest(at(14));
    expect(before[0]?.kind).toBe("text-hunk");
    expect(before[0]?.kind === "text-hunk" && before[0].text.endsWith(body.join("\n"))).toBe(true);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });
});

describe("measureRoundEvidenceManifest", () => {
  /** A manifest whose serialization measures exactly `bytes`, padded with a multibyte
   *  character so the boundary is a real UTF-8 boundary and not a lucky ASCII one. */
  const manifestOfBytes = (bytes: number): RoundEvidenceUnit[] => {
    const unit = (text: string): RoundEvidenceUnit => ({
      kind: "text-hunk",
      id: "ev-0000000000000000",
      path: "a.ts",
      text,
      anchor: { side: "head", path: "a.ts", line: 1 },
    });
    const base = utf8ByteLength(serializeRoundEvidenceManifest([unit("")]));
    // "é" is two UTF-8 bytes and one UTF-16 code unit: padding with it proves the
    // budget counts bytes, not `string.length`.
    const remainder = bytes - base;
    return [unit("é".repeat(Math.floor(remainder / 2)) + (remainder % 2 === 0 ? "" : "x"))];
  };

  it("sends a manifest that measures exactly the limit, multibyte boundary included", () => {
    const units = manifestOfBytes(ROUND_EVIDENCE_MANIFEST_MAX_BYTES);
    const json = serializeRoundEvidenceManifest(units);
    expect(utf8ByteLength(json)).toBe(ROUND_EVIDENCE_MANIFEST_MAX_BYTES);
    expect(json.length).toBeLessThan(ROUND_EVIDENCE_MANIFEST_MAX_BYTES);

    const measured = measureRoundEvidenceManifest(units);
    expect(measured).toEqual({
      ok: true,
      json,
      bytes: ROUND_EVIDENCE_MANIFEST_MAX_BYTES,
    });
  });

  it("fails typed one byte over the limit and never truncates to fit", () => {
    const units = manifestOfBytes(ROUND_EVIDENCE_MANIFEST_MAX_BYTES + 1);
    expect(utf8ByteLength(serializeRoundEvidenceManifest(units))).toBe(
      ROUND_EVIDENCE_MANIFEST_MAX_BYTES + 1,
    );

    const measured = measureRoundEvidenceManifest(units);
    expect(measured.ok).toBe(false);
    expect(measured.ok ? "" : measured.reason).toContain(
      `over the ${ROUND_EVIDENCE_MANIFEST_MAX_BYTES}-byte limit`,
    );
  });

  it("fails typed on a duplicate id rather than letting the partition merge two units", () => {
    // A forced collision: two DIFFERENT units carrying one id, which is what a 16-hex
    // sha256 collision would produce. Left alone, the partition addresses units by id
    // through Sets — one placement would satisfy both and the report would call itself
    // exhaustive while a unit went unclassified.
    const collided: RoundEvidenceUnit[] = [
      { kind: "rename", id: "ev-cccccccccccccccc", path: "a.ts", previousPath: "old-a.ts" },
      { kind: "rename", id: "ev-cccccccccccccccc", path: "b.ts", previousPath: "old-b.ts" },
    ];
    const measured = measureRoundEvidenceManifest(collided);
    expect(measured.ok).toBe(false);
    expect(measured.ok ? "" : measured.reason).toContain("repeats evidence id ev-cccccccccccccccc");

    // And on the recovery path, which never measures: the partition itself refuses.
    expect(() =>
      verifyRoundEvidencePartition(
        [{ bucket: "ask-one", evidenceIds: ["ev-cccccccccccccccc"] }],
        collided,
      ),
    ).toThrow(/repeats evidence id ev-cccccccccccccccc/);
  });

  it("fails typed over the entry limit", () => {
    const units: RoundEvidenceUnit[] = Array.from(
      { length: ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES + 1 },
      (_unused, index) => ({
        kind: "rename",
        id: `ev-${index}`,
        path: `new-${index}.ts`,
        previousPath: `old-${index}.ts`,
      }),
    );
    const measured = measureRoundEvidenceManifest(units);
    expect(measured.ok).toBe(false);
    expect(measured.ok ? "" : measured.reason).toContain(
      `over the ${ROUND_EVIDENCE_MANIFEST_MAX_ENTRIES}-entry limit`,
    );
  });
});

describe("verifyRoundEvidencePartition", () => {
  const manifest = buildRoundEvidenceManifest(MIXED_DIFF);
  const ids = manifest.map((unit) => unit.id);

  it("accepts a partition that places every id exactly once", () => {
    expect(() =>
      verifyRoundEvidencePartition(
        [
          { bucket: "ask-one", evidenceIds: ids.slice(0, 2) },
          { bucket: "beyond", evidenceIds: ids.slice(2) },
        ],
        manifest,
      ),
    ).not.toThrow();
  });

  it("rejects an unknown id", () => {
    expect(() =>
      verifyRoundEvidencePartition([{ bucket: "ask-one", evidenceIds: ["ev-nope"] }], manifest),
    ).toThrow(/unknown evidence id ev-nope/);
  });

  it("rejects the same id in two buckets", () => {
    expect(() =>
      verifyRoundEvidencePartition(
        [
          { bucket: "ask-one", evidenceIds: ids },
          { bucket: "beyond", evidenceIds: [ids[0] as string] },
        ],
        manifest,
      ),
    ).toThrow(/more than one bucket/);
  });

  it("rejects an omitted id", () => {
    expect(() =>
      verifyRoundEvidencePartition([{ bucket: "ask-one", evidenceIds: ids.slice(1) }], manifest),
    ).toThrow(new RegExp(`leaves evidence unplaced: ${ids[0]}`));
  });
});
