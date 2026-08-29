import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiffFiles, SqliteReviewStore } from "@rennet/adapters";
import { type PatchsetCapturePort, ReviewService } from "@rennet/core";
import type { CodeRef, Patchset } from "@rennet/protocol";
import { afterAll, describe, expect, it } from "vitest";
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

  it("resolves a renamed file from EITHER of its two paths", async () => {
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
