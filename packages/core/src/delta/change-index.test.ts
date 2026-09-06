import type { PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  CHANGE_INDEX_FILE,
  CHANGE_INDEX_MAX_BYTES,
  CHANGE_INDEX_TRUNCATION,
  changeIndexContextFile,
} from "./change-index";
import { buildDeltaPacket } from "./delta-packet";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function file(path: string, patch: string, overrides: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch,
    ...overrides,
  };
}

function patchset(files: readonly PatchFile[], repository: Partial<Patchset["repository"]> = {}) {
  return {
    id: "ps-1",
    createdAt: "2026-09-06T00:00:00.000Z",
    repository: {
      root: "/repo",
      baseRef: "main",
      baseOid: "b".repeat(40),
      headOid: "h".repeat(40),
      ...repository,
    },
    files: [...files],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  } as unknown as Patchset;
}

// Two hunks: five new-side lines from 4, then a PURE DELETION whose new-side span is
// zero lines at line 40 — the case a naive `start + lines - 1` renders as `40-39`.
const WIDGET = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -4,3 +4,5 @@ function widget() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  "+const d = 5;",
  " const e = 6;",
  "@@ -41,2 +40,0 @@ function gone() {",
  "-const f = 7;",
  "-const g = 8;",
].join("\n");

const README = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,1 +1,2 @@",
  " # Title",
  "+A line.",
].join("\n");

describe("changeIndexContextFile (#867)", () => {
  const packet = buildDeltaPacket(
    patchset([
      file("src/widget.ts", WIDGET),
      file("README.md", README, { additions: 1, deletions: 0 }),
      file("assets/logo.png", "", { binary: true, status: "added", additions: 0, deletions: 0 }),
      file("src/renamed.ts", "", { status: "renamed", previousPath: "src/old.ts" }),
    ]),
    [],
  );

  it("writes one row per changed file, with the hunk count and the new-side spans", () => {
    const index = changeIndexContextFile(packet);
    expect(index?.name).toBe(CHANGE_INDEX_FILE);
    const rows = (index?.body ?? "").split("\n").filter((line) => line.startsWith("- "));
    expect(rows).toEqual([
      "- `src/widget.ts` — modified, +3 -3, 2 hunks: 4-8, 40+0",
      "- `README.md` — modified, +1 -0, 1 hunk: 1-2",
      "- `assets/logo.png` — added, binary, +0 -0, no text hunks",
      "- `src/renamed.ts` (was `src/old.ts`) — renamed, +0 -0, no hunks",
    ]);
  });

  it("counts a file the capture left uncounted off its own hunk bodies, not as zero", () => {
    // `src/widget.ts` arrives with `additions: null` / `deletions: null` — the wire shape
    // allows it, and a capture that reports no counts must not read as "nothing changed".
    // Three `+` body lines and three `-` body lines across its two hunks.
    expect(packet.patchset.files[0]?.additions).toBeNull();
    const index = changeIndexContextFile(packet);
    expect(index?.body).toContain("`src/widget.ts` — modified, +3 -3");
    // …and a capture that DID report counts is carried verbatim rather than recounted.
    expect(index?.body).toContain("`README.md` — modified, +1 -0");
  });

  it("totals the whole change in one line and names the reviewed range", () => {
    const index = changeIndexContextFile(packet);
    expect(index?.body).toContain("4 files changed, +4 -3, 3 hunks.");
    expect(index?.body).toContain(`Reviewed range: ${"b".repeat(40)} (main) … ${"h".repeat(40)}.`);
  });

  it("names the pinned tree, not the head, on a working-tree capture", () => {
    const pinned = buildDeltaPacket(
      patchset([file("README.md", README)], { reviewedTreeOid: "t".repeat(40) }),
      [],
    );
    const body = changeIndexContextFile(pinned)?.body ?? "";
    expect(body).toContain(`tree ${"t".repeat(40)} (uncommitted work included)`);
    expect(body).toContain(`git show ${"t".repeat(40)}:<path>`);
    // The head oid would name a different set of bytes than the one under review.
    expect(body).not.toContain("h".repeat(40));
  });

  it("carries no hunk body and no file content — the shape only", () => {
    const body = changeIndexContextFile(packet)?.body ?? "";
    // Positive control: these ARE in the packet, so any of them creeping into the file
    // reddens this — it is the "never inline context" rule, applied to the artefact.
    expect(packet.hunks.hunks.flatMap((hunk) => hunk.body)).toContain("+const c = 4;");
    for (const sentinel of ["const c = 4;", "const b = 3;", "# Title"]) {
      expect(body, sentinel).not.toContain(sentinel);
    }
  });

  it("returns undefined for a packet with no changed file", () => {
    expect(changeIndexContextFile(buildDeltaPacket(patchset([]), []))).toBeUndefined();
  });

  it("truncates at the declared bound with a marker that accounts for the rest", () => {
    const many = buildDeltaPacket(
      patchset(
        Array.from({ length: 200 }, (_unused, i) =>
          file(`packages/pkg/src/module-${i}.ts`, README.replaceAll("README.md", `m-${i}.ts`)),
        ),
      ),
      [],
    );
    const cap = 4_096;
    const index = changeIndexContextFile(many, cap);
    const body = index?.body ?? "";
    expect(bytes(body)).toBeLessThanOrEqual(cap);
    const rows = body.split("\n").filter((line) => line.startsWith("- "));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    expect(body).toContain(`${CHANGE_INDEX_TRUNCATION}${200 - rows.length} more files`);
    // The header still tells the truth about the WHOLE change, not the listed part.
    expect(body).toContain("200 files changed,");
  });

  it("does not truncate a change that fits, and the default bound is what production uses", () => {
    // The control for the test above: the same renderer over the same rows at the real
    // bound emits every row and no marker, so the truncation above is the cap acting and
    // not something the renderer always does.
    const many = buildDeltaPacket(
      patchset(
        Array.from({ length: 200 }, (_unused, i) =>
          file(`packages/pkg/src/module-${i}.ts`, README.replaceAll("README.md", `m-${i}.ts`)),
        ),
      ),
      [],
    );
    const index = changeIndexContextFile(many);
    const rows = (index?.body ?? "").split("\n").filter((line) => line.startsWith("- "));
    expect(rows).toHaveLength(200);
    expect(index?.body).not.toContain(CHANGE_INDEX_TRUNCATION);
    expect(bytes(index?.body ?? "")).toBeLessThanOrEqual(CHANGE_INDEX_MAX_BYTES);
  });

  it("is deterministic and preserves the packet's file order", () => {
    const first = changeIndexContextFile(packet);
    const second = changeIndexContextFile(packet);
    expect(first).toEqual(second);
    const rows = (first?.body ?? "").split("\n").filter((line) => line.startsWith("- "));
    expect(rows.map((row) => row.split("`")[1])).toEqual(
      packet.patchset.files.map((entry) => entry.path),
    );
  });
});
