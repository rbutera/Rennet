import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiffFiles, SqliteReviewStore } from "@rennet/adapters";
import {
  buildHunkIndex,
  type PatchsetCapturePort,
  ReviewService,
  resolveCitation,
} from "@rennet/core";
import { type CodeRef, DIFF_TRUNCATION_MARKER, type Patchset } from "@rennet/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { changedRegions } from "../runtime/round-collation";
import { createDispatch, type DispatchDeps } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// `patchset.readSpan`, through the REAL dispatch router, the REAL ReviewService and the
// REAL SqliteReviewStore. B3 registered the row contract-only and B4/B10 never bound it,
// so this command threw for every citation in the shipped app; nothing caught it because
// every existing test of the seam answered from a `MemoryBridge` stub, which returns where
// the daemon throws.
//
// The diff under test is produced by REAL `git diff`, not hand-written, and parsed by the
// production parser (`parseUnifiedDiffFiles`). A hand-shaped patch would let a fixture
// quietly agree with the implementation about hunk headers, rename records, `\ No newline`
// markers and the GAP between hunks — and the gap is the whole point of the honest-absence
// case below.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real git repository with a real staged change, returning its real `git diff` text. */
function realDiff(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-readspan-"));
  temporaries.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/cheese.ts"), `${BASE.join("\n")}\n`);
  writeFileSync(join(root, "src/old-name.ts"), "export const rennet = 1;\n");
  // A REAL rename: ten lines kept, one changed, so `git diff -M` records `rename from/to`
  // (the one-line `old-name`/`new-name` pair above is too dissimilar and is a delete + add).
  writeFileSync(join(root, "src/before.ts"), `${BASE.slice(0, 10).join("\n")}\n`);
  writeFileSync(join(root, "src/gone.ts"), "export const removedEntirely = true;\n");
  writeFileSync(join(root, "assets.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");

  // Two edits far enough apart that git emits TWO hunks with an uncaptured gap between
  // them — the region a citation can legitimately point at and the capture cannot answer.
  const edited = [...BASE];
  edited[4] = "const line5 = 500; // changed";
  edited[34] = "const line35 = 3500; // changed";
  writeFileSync(join(root, "src/cheese.ts"), `${edited.join("\n")}\n`);
  writeFileSync(join(root, "src/new-name.ts"), "export const rennet = 2;\n");
  rmSync(join(root, "src/old-name.ts"));
  const renamed = BASE.slice(0, 10);
  renamed[4] = "const line5 = 5; // moved";
  writeFileSync(join(root, "src/after.ts"), `${renamed.join("\n")}\n`);
  rmSync(join(root, "src/before.ts"));
  writeFileSync(
    join(root, "src/added.ts"),
    "export function brandNew(): number {\n  return 7;\n}\n",
  );
  rmSync(join(root, "src/gone.ts"));
  writeFileSync(join(root, "assets.bin"), Buffer.from([9, 9, 9, 9, 9, 9]));
  git(root, "add", "-A");
  return git(root, "diff", "--cached", "-M", "--no-color");
}

const temporaries: string[] = [];

afterAll(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

const rawDiff = realDiff();
const files = parseUnifiedDiffFiles(rawDiff);

const PATCHSET_ID = "ps-real-1";
const patchset: Patchset = {
  id: PATCHSET_ID,
  createdAt: "2026-08-29T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/vanished/repo",
    commonDir: "/vanished/repo/.git",
    baseRef: "main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files,
  rawDiff,
  byteLength: Buffer.byteLength(rawDiff),
  truncated: false,
};

/** The real router over the real service over the real SQLite store. */
async function realDispatch(): Promise<
  (name: "patchset.readSpan", input: CodeRef) => Promise<unknown>
> {
  const store = new SqliteReviewStore(":memory:");
  const capture: PatchsetCapturePort = {
    capture: () => Promise.reject(new Error("capture is not used here")),
  };
  const service = new ReviewService(capture, store);
  await service.createReviewFromPatchset("cmd-1", patchset);
  const dispatch = createDispatch({
    service,
    allowedRoots: new Set<string>(),
  } as unknown as DispatchDeps);
  return (name, input) => dispatch(name, input);
}

function ref(overrides: Partial<CodeRef> = {}): CodeRef {
  return {
    patchsetId: PATCHSET_ID,
    path: "src/cheese.ts",
    side: "head",
    startLine: 5,
    endLine: 5,
    ...overrides,
  };
}

type Span = { lines: string[]; contextBefore: string[]; contextAfter: string[] };

describe("patchset.readSpan — served from the captured patchset, over real dispatch", () => {
  it("returns the cited head lines, with orientation context either side", async () => {
    const dispatch = await realDispatch();
    const span = (await dispatch("patchset.readSpan", ref())) as Span;

    // The exact post-image text at file line 5, from the capture. Not "some lines".
    expect(span.lines).toEqual(["const line5 = 500; // changed"]);
    // Context is the lines that really precede/follow it in the new file.
    expect(span.contextBefore).toEqual([
      "const line2 = 2;",
      "const line3 = 3;",
      "const line4 = 4;",
    ]);
    expect(span.contextAfter).toEqual(["const line6 = 6;", "const line7 = 7;", "const line8 = 8;"]);
  });

  it("reads the BASE side as the pre-image — the line as it was, not as it is", async () => {
    const dispatch = await realDispatch();
    const span = (await dispatch("patchset.readSpan", ref({ side: "base" }))) as Span;
    expect(span.lines).toEqual(["const line5 = 5;"]);
  });

  it("serves a multi-line span in order", async () => {
    const dispatch = await realDispatch();
    const span = (await dispatch("patchset.readSpan", ref({ startLine: 34, endLine: 36 }))) as Span;
    expect(span.lines).toEqual([
      "const line34 = 34;",
      "const line35 = 3500; // changed",
      "const line36 = 36;",
    ]);
  });

  it("truncates context at the edge of the captured hunk rather than jumping the gap", async () => {
    // Line 32 is the first line of the second hunk; there is NOTHING captured before it
    // (lines 9–31 fall in the gap between the two hunks). Context must stop, not reach
    // across into hunk one — the client numbers the block from
    // `startLine - contextBefore.length`, so a jumped line would render misnumbered.
    const dispatch = await realDispatch();
    const span = (await dispatch("patchset.readSpan", ref({ startLine: 32, endLine: 32 }))) as Span;
    expect(span.lines).toEqual(["const line32 = 32;"]);
    expect(span.contextBefore).toEqual([]);
  });

  it("says WHICH absence it hit for a span the diff never captured", async () => {
    // The honest, common case: an unchanged region of a changed file. A patchset carries
    // only its hunks, so this line genuinely is not in the store — and the message says so
    // in those words, because `CitationBlock` renders it verbatim to the reviewer.
    const dispatch = await realDispatch();
    await expect(
      dispatch("patchset.readSpan", ref({ startLine: 20, endLine: 20 })),
    ).rejects.toThrow(
      /src\/cheese\.ts line 20 \(head\) is outside the diff this patchset captured/,
    );

    // Both branches of the phrasing, because `test/memory-bridge.ts` documents the
    // difference between them as its reason for NOT copying the daemon's wording. A
    // singular span reads "line 20"; a range names the whole span AND the first line that
    // failed, so a reviewer citing 18–24 learns which end of it fell outside the capture.
    await expect(
      dispatch("patchset.readSpan", ref({ startLine: 18, endLine: 24 })),
    ).rejects.toThrow(
      "src/cheese.ts lines 18–24 (head) is outside the diff this patchset captured — line 18 was never part of it.",
    );
  });

  it("distinguishes an uncaptured file, a binary file, and an unknown patchset", async () => {
    const dispatch = await realDispatch();
    await expect(
      dispatch("patchset.readSpan", ref({ path: "src/never-touched.ts" })),
    ).rejects.toThrow("src/never-touched.ts is not one of the files this patchset captured.");
    await expect(dispatch("patchset.readSpan", ref({ path: "assets.bin" }))).rejects.toThrow(
      /assets\.bin is binary/,
    );
    await expect(dispatch("patchset.readSpan", ref({ patchsetId: "ps-nope" }))).rejects.toThrow(
      /patchset ps-nope, which is not in this Rennet's store/,
    );
  });

  it("says a side does not EXIST, rather than blaming the span, for an add or a delete", async () => {
    // An added file has no pre-image and a deleted file has no post-image. The per-line
    // message ("outside the diff this patchset captured") would be literally true for
    // every line and would read as "cite a different line" — when no line can ever work.
    // Guard the fixture first: git must have recorded these as add/delete, not paired
    // them into a rename, or the test would pass for the wrong reason.
    expect(files.find((file) => file.path === "src/added.ts")?.status).toBe("added");
    expect(files.find((file) => file.path === "src/gone.ts")?.status).toBe("deleted");

    const dispatch = await realDispatch();
    await expect(
      dispatch(
        "patchset.readSpan",
        ref({ path: "src/added.ts", side: "base", startLine: 1, endLine: 1 }),
      ),
    ).rejects.toThrow("src/added.ts was added in this patchset — it has no base side to cite.");
    await expect(
      dispatch(
        "patchset.readSpan",
        ref({ path: "src/gone.ts", side: "head", startLine: 1, endLine: 1 }),
      ),
    ).rejects.toThrow("src/gone.ts was deleted in this patchset — it has no head side to cite.");

    // The side that DOES exist still reads normally — the guard refuses a missing image,
    // not the file.
    const added = (await dispatch(
      "patchset.readSpan",
      ref({ path: "src/added.ts", side: "head", startLine: 2, endLine: 2 }),
    )) as Span;
    expect(added.lines).toEqual(["  return 7;"]);
  });

  it("resolves an added file by its path and a deleted file's base side by its old path", async () => {
    const dispatch = await realDispatch();
    const byNewPath = (await dispatch(
      "patchset.readSpan",
      ref({ path: "src/new-name.ts", startLine: 1, endLine: 1 }),
    )) as Span;
    expect(byNewPath.lines).toEqual(["export const rennet = 2;"]);
    // A base-side citation into a rename legitimately names the OLD path.
    const byOldPath = (await dispatch(
      "patchset.readSpan",
      ref({ path: "src/old-name.ts", side: "base", startLine: 1, endLine: 1 }),
    )) as Span;
    expect(byOldPath.lines).toEqual(["export const rennet = 1;"]);
  });

  it("resolves the citation with the repository gone — the capture is the source", async () => {
    // `repository.root` above is `/vanished/repo`, which does not exist. A review whose
    // repository has been deleted (`review.load`'s `repositoryPresent: false`) still reads
    // every citation, because the span comes from the stored patch text and nothing else.
    const dispatch = await realDispatch();
    const span = (await dispatch("patchset.readSpan", ref())) as Span;
    expect(span.lines).toEqual(["const line5 = 500; // changed"]);
  });

  it("finds the patchset by id alone, with no review id in the input", async () => {
    // A board `code_ref` carries `patchset_id` and no review id, so the lookup must be keyed
    // on the patchset. Proven against the REAL SQLite store's json_extract query: a second
    // review is persisted after the first, and the OLDER patchset still resolves to its own
    // content rather than the newest capture's.
    const store = new SqliteReviewStore(":memory:");
    const service = new ReviewService(
      { capture: () => Promise.reject(new Error("unused")) },
      store,
    );
    await service.createReviewFromPatchset("cmd-1", patchset);
    await service.createReviewFromPatchset("cmd-2", {
      ...patchset,
      id: "ps-real-2",
      files: files.map((file) =>
        file.path === "src/cheese.ts" ? { ...file, patch: file.patch.replace("500", "999") } : file,
      ),
    });
    const dispatch = createDispatch({
      service,
      allowedRoots: new Set<string>(),
    } as unknown as DispatchDeps);

    expect(((await dispatch("patchset.readSpan", ref())) as Span).lines).toEqual([
      "const line5 = 500; // changed",
    ]);
    expect(
      ((await dispatch("patchset.readSpan", ref({ patchsetId: "ps-real-2" }))) as Span).lines,
    ).toEqual(["const line5 = 999; // changed"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lint and the reader share ONE readability predicate (`resolveCitation` over
// `changedRegions`): a citation lint accepts is one this reader can open, and one it
// cannot open is one lint sent back to the seat. Before this, lint accepted any overlap
// while the reader demanded every line, so a citation one line past a hunk, or spanning
// the gap between two, passed lint and failed when the reviewer clicked it. Each case
// below asserts the two verdicts AGREE and asserts what the verdict is, over the real diff.
// ─────────────────────────────────────────────────────────────────────────────

describe("patchset.readSpan agrees with lint's predicate, line for line", () => {
  const fileFor = (path: string) =>
    files.find((file) => file.path === path || file.previousPath === path);
  const lintSays = (citation: CodeRef): boolean => {
    const file = fileFor(citation.path);
    if (file === undefined) return false;
    const span = {
      path: citation.path,
      side: citation.side,
      start: citation.startLine,
      end: citation.endLine,
    };
    return (
      resolveCitation(span, changedRegions(buildHunkIndex({ files: [file] }), [file])) !== undefined
    );
  };
  const readerSays = async (
    dispatch: Awaited<ReturnType<typeof realDispatch>>,
    citation: CodeRef,
  ): Promise<boolean> => {
    try {
      await dispatch("patchset.readSpan", citation);
      return true;
    } catch {
      return false;
    }
  };

  // `git diff` with its default three lines of context: the edit at line 5 yields a hunk
  // over 2..8 and the edit at line 35 one over 32..38, with 9..31 never captured.
  const cases: readonly [string, Partial<CodeRef>, boolean][] = [
    ["the exact first line of a hunk", { startLine: 2, endLine: 2 }, true],
    ["the exact last line of a hunk", { startLine: 8, endLine: 8 }, true],
    ["one line past the hunk's end", { startLine: 8, endLine: 9 }, false],
    ["one line before the hunk's start", { startLine: 1, endLine: 2 }, false],
    ["a span across the gap between two hunks", { startLine: 8, endLine: 32 }, false],
    [
      "the base side of a deleted file",
      { path: "src/gone.ts", side: "base", startLine: 1, endLine: 1 },
      true,
    ],
    [
      "the head side of a deleted file",
      { path: "src/gone.ts", side: "head", startLine: 1, endLine: 1 },
      false,
    ],
    [
      "a rename's base side under its NEW name",
      { path: "src/after.ts", side: "base", startLine: 5, endLine: 5 },
      true,
    ],
    [
      "a rename's base side under its OLD name",
      { path: "src/before.ts", side: "base", startLine: 5, endLine: 5 },
      true,
    ],
    [
      "a rename's head side under its OLD name",
      { path: "src/before.ts", side: "head", startLine: 5, endLine: 5 },
      false,
    ],
  ];

  it("the fixture really carries a rename, so the rename rows above test one", () => {
    expect(fileFor("src/after.ts")).toMatchObject({
      status: "renamed",
      previousPath: "src/before.ts",
    });
  });

  it.each(cases)("%s", async (_label, overrides, readable) => {
    const dispatch = await realDispatch();
    const citation = ref(overrides);
    expect(lintSays(citation)).toBe(readable);
    expect(await readerSays(dispatch, citation)).toBe(readable);
  });

  // ── The lossy tail: lint ACCEPTS it, so the card must open it ──────────────
  //
  // A truncated capture's tail region is open-ended on purpose — the daemon will not call a
  // seat's citation "outside the change" over lines it chose not to keep — so lint accepts a
  // citation past the cut. The reader used to throw for exactly that citation, which put a
  // refusal on the card over a citation the board had accepted. The reviewed bytes are still
  // addressable: the patchset records the tree they were captured from.
  async function lossyDispatch(extra: Record<string, unknown> = {}) {
    const store = new SqliteReviewStore(":memory:");
    const service = new ReviewService(
      { capture: () => Promise.reject(new Error("unused")) },
      store,
    );
    const truncated = files.map((file) =>
      file.path === "src/cheese.ts"
        ? { ...file, patch: `${file.patch}\n${DIFF_TRUNCATION_MARKER}` }
        : file,
    );
    await service.createReviewFromPatchset("cmd-1", {
      ...patchset,
      id: "ps-lossy",
      files: truncated,
    });
    const file = truncated.find((f) => f.path === "src/cheese.ts") as (typeof files)[number];
    const dispatch = createDispatch({
      service,
      allowedRoots: new Set<string>(),
      ...extra,
    } as unknown as DispatchDeps);
    return { dispatch, file };
  }

  const LOSSY_CITATION = ref({ patchsetId: "ps-lossy", startLine: 39, endLine: 40 });

  it("lint accepts a citation past the truncation — the premise of the two tests below", async () => {
    const { file } = await lossyDispatch();
    expect(
      resolveCitation(
        { path: LOSSY_CITATION.path, side: "head", start: 39, end: 40 },
        changedRegions(buildHunkIndex({ files: [file] }), [file]),
      ),
    ).toBeDefined();
  });

  it("opens a lossy-tail citation from the reviewed tree the patchset recorded", async () => {
    // The immutable object the capture came from — the patchset's own recorded root and
    // head oid — never the working tree. The reader asks for exactly that triple.
    const asked: { root: string; oid: string; path: string }[] = [];
    const { dispatch } = await lossyDispatch({
      readBlobAtOid: async (input: { root: string; oid: string; path: string }) => {
        asked.push(input);
        return `${BASE.join("\n")}\n`;
      },
    });
    const span = (await dispatch("patchset.readSpan", LOSSY_CITATION)) as Span & {
      caption?: string;
    };
    expect(span.lines).toEqual(["const line39 = 39;", "const line40 = 40;"]);
    expect(span.contextBefore).toEqual([
      "const line36 = 36;",
      "const line37 = 37;",
      "const line38 = 38;",
    ]);
    expect(span.caption).toBeUndefined();
    expect(asked).toEqual([{ root: "/vanished/repo", oid: "1".repeat(40), path: "src/cheese.ts" }]);
  });

  it("captions the truncation, and never throws, when the tree cannot be read either", async () => {
    // No reader wired (a composition without one) and a reader that fails are the same fact
    // to the reviewer: the citation is sound and the bytes were cut. It RESOLVES — a
    // refusal here reads as "your citation is wrong", which it is not.
    const readers: Record<string, unknown>[] = [
      {},
      { readBlobAtOid: async () => null },
      {
        readBlobAtOid: async () => {
          throw new Error("repository is gone");
        },
      },
      // A tree shorter than the citation cannot serve it either, and must not answer with a
      // silently short block: line 40 is absent from these two lines.
      { readBlobAtOid: async () => "one\ntwo\n" },
    ];
    for (const reader of readers) {
      const { dispatch } = await lossyDispatch(reader);
      const span = (await dispatch("patchset.readSpan", LOSSY_CITATION)) as Span & {
        caption?: string;
      };
      expect(span.lines).toEqual([]);
      expect(span.caption).toMatch(
        /Rennet truncated this file's diff before src\/cheese\.ts lines 39–40 \(head\)/,
      );
    }
  });
});
