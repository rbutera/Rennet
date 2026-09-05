// The regression net for the BATCHED blob read (`git cat-file --batch`), which
// replaced a `git cat-file blob` process per file in the snapshot build.
//
// The property that matters is not "the batch works" — it is that the batch returns
// BYTE-FOR-BYTE what the per-file read returned, because a snapshot's shards are
// content-addressed and its manifest fingerprint is a hash over them. A single
// wrong byte in a single blob moves a digest, and a digest is what the whole
// invalidation story stands on.
//
// So every case here is checked against `readBlobText` — the unbatched reader, still
// live for the one-off reads — over the same OID. The fixture carries the content
// that breaks a naive implementation:
//
//   * multibyte UTF-8, where the byte length git declares ≠ the character length;
//   * bytes that are not valid UTF-8 at all, which must land on the SAME replacement
//     characters the per-file read produced;
//   * a blob whose own text spells a plausible `--batch` record header, which is why
//     the parser advances by the declared byte length and never scans for one;
//   * an empty blob, a blob with no trailing newline, and CRLF;
//   * enough blobs, with the bounds turned down, to span several batch calls.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit, type GitExec } from "./git-range-diff";
import { listTree, readBlobText, readBlobTexts } from "./project-snapshot-source";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** The 40-hex-looking header a blob might contain, to bait a header-scanning parser. */
const FAKE_HEADER = `${"a".repeat(40)} blob 5\nHELLO\n`;

const CONTENT: readonly (readonly [string, Buffer])[] = [
  ["plain.ts", Buffer.from("export const a = 1;\n", "utf8")],
  ["empty.ts", Buffer.alloc(0)],
  ["no-trailing-newline.ts", Buffer.from("export const b = 2;", "utf8")],
  ["crlf.ts", Buffer.from("export const c = 3;\r\nexport const d = 4;\r\n", "utf8")],
  ["multibyte.ts", Buffer.from("// 日本語 🧀 café — ünïcödé\nexport const e = 5;\n", "utf8")],
  // Not valid UTF-8: a lone continuation byte, a bare 0xFF, and a truncated
  // three-byte sequence. `git cat-file blob` hands these to a UTF-8 decoder and gets
  // replacement characters; the batch must land on exactly the same string.
  [
    "invalid-utf8.ts",
    Buffer.concat([
      Buffer.from("const x = '", "utf8"),
      Buffer.from([0x80, 0xff, 0xe2, 0x28, 0xa1, 0xfe]),
      Buffer.from("';\n", "utf8"),
    ]),
  ],
  ["header-lookalike.ts", Buffer.from(`// ${FAKE_HEADER}export const f = 6;\n`, "utf8")],
  // A NUL and a lone CR inside otherwise ordinary source.
  ["control-bytes.ts", Buffer.concat([Buffer.from("const y = 7;\0\rconst z = 8;\n", "utf8")])],
];

function fixtureRepo(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-batch-blobs-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  for (const [path, bytes] of CONTENT) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, bytes);
  }
  // Twelve more ordinary files, so the turned-down bounds below span several calls.
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(root, `filler-${index}.ts`), `export const filler${index} = ${index};\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return { root };
}

describe("readBlobTexts — the batched blob read", () => {
  it("returns byte-for-byte what the per-file read returns, for every blob in the tree", async () => {
    const { root } = fixtureRepo();
    const files = await listTree(root, git(root, "rev-parse", "HEAD"));
    expect(files.length).toBe(CONTENT.length + 12);

    const batched = await readBlobTexts(root, files);
    // Every file, not a sample: the naive failures desynchronise the stream, so a
    // wrong byte in one record corrupts the NEXT one, and only a full sweep sees it.
    for (const file of files) {
      const single = await readBlobText(root, file.blobOid);
      expect(batched.get(file.blobOid), file.path).toBe(single);
    }
    // And the interesting ones really are interesting: assert the fixture kept its
    // shape rather than trusting the round trip alone. A fixture that silently
    // normalised to plain ASCII would make every comparison above pass vacuously.
    const byPath = new Map(files.map((file) => [file.path, file] as const));
    const oidOf = (path: string): string => {
      const entry = byPath.get(path);
      if (!entry) throw new Error(`fixture lost ${path}`);
      return entry.blobOid;
    };
    expect(batched.get(oidOf("empty.ts"))).toBe("");
    expect(batched.get(oidOf("no-trailing-newline.ts"))?.endsWith("2;")).toBe(true);
    expect(batched.get(oidOf("crlf.ts"))).toContain("\r\n");
    expect(batched.get(oidOf("multibyte.ts"))).toContain("🧀");
    expect(batched.get(oidOf("header-lookalike.ts"))).toContain(FAKE_HEADER);
    // The invalid bytes decoded to replacement characters, which is what makes it a
    // real test of the latin1 → slice → UTF-8 round trip rather than an ASCII one.
    expect(batched.get(oidOf("invalid-utf8.ts"))).toContain("�");
    // A multibyte blob's git-declared size is BYTES, and it is bigger than the
    // string's length — the exact mismatch a character-offset parser gets wrong.
    const multibyte = byPath.get("multibyte.ts");
    expect(multibyte?.size).toBeGreaterThan(batched.get(oidOf("multibyte.ts"))?.length ?? 0);
  });

  it("spans several `cat-file --batch` calls and still returns every blob", async () => {
    const { root } = fixtureRepo();
    const files = await listTree(root, git(root, "rev-parse", "HEAD"));

    // Bounds turned right down so the same fixture needs many calls instead of one,
    // and a counting runner so "several calls" is asserted rather than assumed.
    let calls = 0;
    const wrapped: GitExec = async (cwd, args, options) => {
      if (args[0] === "cat-file" && args[1] === "--batch") calls += 1;
      return execaGit(cwd, args, options);
    };

    const byCount = await readBlobTexts(root, files, wrapped, { countBudget: 3 });
    expect(calls).toBeGreaterThan(1);
    expect(byCount.size).toBe(files.length);

    calls = 0;
    const byBytes = await readBlobTexts(root, files, wrapped, { byteBudget: 40 });
    expect(calls).toBeGreaterThan(1);
    expect(byBytes.size).toBe(files.length);

    // Chunking is a batching bound, never a filter: both agree with the unchunked read.
    const whole = await readBlobTexts(root, files);
    for (const file of files) {
      expect(byCount.get(file.blobOid), file.path).toBe(whole.get(file.blobOid));
      expect(byBytes.get(file.blobOid), file.path).toBe(whole.get(file.blobOid));
    }
  });

  it("carries a blob larger than the byte budget in a chunk of its own", async () => {
    const { root } = fixtureRepo();
    const big = "x".repeat(4096);
    writeFileSync(join(root, "big.ts"), `export const big = "${big}";\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "big");
    const files = await listTree(root, git(root, "rev-parse", "HEAD"));
    const bigEntry = files.find((file) => file.path === "big.ts");
    expect(bigEntry?.size).toBeGreaterThan(64);

    // A budget far below the big blob's size. The bound must not refuse it.
    const texts = await readBlobTexts(root, files, undefined, { byteBudget: 64 });
    expect(texts.size).toBe(files.length);
    expect(texts.get(bigEntry?.blobOid ?? "")).toBe(
      await readBlobText(root, bigEntry?.blobOid ?? ""),
    );
  });
});
